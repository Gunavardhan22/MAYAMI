"""Per-connection orchestration: routes audio frames to STT, hands completed interviewer
utterances to the Master Router (which picks an agent to answer), and feeds the candidate's
own speech to the Coach.

Wire protocol (client -> server):
  binary frame: 1 byte channel id (0 = interviewer/tab audio, 1 = candidate/mic)
                + 16 kHz mono int16 little-endian PCM
  text frame:   {"type": "ask", "text": "..."}   manually trigger an answer
                {"type": "stop"}                  end the session

Server -> client (JSON text frames):
  {"type": "ready"}
  {"type": "transcript_partial", "speaker": "interviewer"|"candidate", "payload": str}
  {"type": "transcript_final",   "speaker": "interviewer"|"candidate", "payload": str}
  {"type": "question", "id": int, "payload": str, "agent": "answer"|"technical"|"design"|"research"}
  {"type": "answer_chunk", "id": int, "payload": str}
  {"type": "answer_reset", "id": int, "agent": str}      clear the answer; a specialist takes over
  {"type": "status", "id": int, "payload": str}          what the agent is doing right now
  {"type": "ui", "id": int, "layout": "code"|"diagram"}  agent asks the overlay to change layout
  {"type": "code_run", "id": int, "code": str, "output": str, "ok": bool}   sandbox test run
  {"type": "sources", "id": int, "sources": [{"title": str, "url": str}]}   web search sources
  {"type": "answer_done", "id": int}
  {"type": "coach", "key": str, "level": "info"|"warn", "payload": str, "ttl_ms": int}
  {"type": "error", "payload": str}
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import deque

from fastapi import WebSocket, WebSocketDisconnect
from google import genai

from .agents import CoachAgent, HedgedGemini, MasterRouter
from .config import get_settings
from .stt import LiveTranscriber

log = logging.getLogger(__name__)

SPEAKERS = {0: "interviewer", 1: "candidate"}


class InterviewSession:
    def __init__(self, ws: WebSocket, profile_id: str, client: genai.Client, gemini: HedgedGemini) -> None:
        self.ws = ws
        self.client = client
        self.settings = get_settings()
        self.streams: dict[int, LiveTranscriber] = {}
        self.failed_channels: set[int] = set()
        self.history: deque[tuple[str, str]] = deque(maxlen=self.settings.history_turns)
        self.closed = False
        self._send_lock = asyncio.Lock()
        self.coach = CoachAgent(self.send)
        self.router = MasterRouter(gemini, self.send, self.coach, profile_id)

    async def send(self, payload: dict) -> None:
        async with self._send_lock:
            try:
                await self.ws.send_text(json.dumps(payload))
            except (WebSocketDisconnect, RuntimeError):
                pass

    async def _stream_for(self, channel: int) -> LiveTranscriber:
        stream = self.streams.get(channel)
        if stream is None:
            speaker = SPEAKERS[channel]

            async def on_transcript(text: str, final: bool) -> None:
                if speaker == "candidate":
                    self.coach.candidate_final(text) if final else self.coach.candidate_partial()
                kind = "transcript_final" if final else "transcript_partial"
                await self.send({"type": kind, "speaker": speaker, "payload": text})

            async def on_utterance(text: str) -> None:
                await self._on_utterance(speaker, text)

            stream = LiveTranscriber(self.client, on_transcript, on_utterance)
            await stream.start()
            self.streams[channel] = stream
        return stream

    async def _on_utterance(self, speaker: str, text: str) -> None:
        if self.closed:
            return
        if speaker == "interviewer":
            self.coach.interviewer_spoke()
            if len(text.split()) >= self.settings.min_question_words:
                self.router.handle(text, list(self.history))
        self.history.append((speaker, text))

    async def run(self) -> None:
        await self.send({"type": "ready"})
        self.coach.start()
        try:
            while True:
                msg = await self.ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                if (data := msg.get("bytes")) is not None:
                    if len(data) < 2 or data[0] not in SPEAKERS or data[0] in self.failed_channels:
                        continue
                    try:
                        stream = await self._stream_for(data[0])
                    except Exception as exc:
                        log.exception("Could not open STT stream for %s", SPEAKERS[data[0]])
                        if SPEAKERS[data[0]] == "interviewer":
                            await self.send({"type": "error", "payload": f"Speech-to-text unavailable: {exc}"})
                            break
                        # Losing the candidate's mic only costs coaching; keep the session.
                        self.failed_channels.add(data[0])
                        await self.send({"type": "error", "payload": "Couldn't transcribe your microphone; coaching is off."})
                        continue
                    await stream.send(data[1:])
                elif (text := msg.get("text")) is not None:
                    try:
                        cmd = json.loads(text)
                    except json.JSONDecodeError:
                        continue
                    if cmd.get("type") == "ask" and str(cmd.get("text", "")).strip():
                        self.router.handle(str(cmd["text"]).strip(), list(self.history), manual=True)
                    elif cmd.get("type") == "stop":
                        break
        except WebSocketDisconnect:
            pass
        finally:
            await self.close()

    async def close(self) -> None:
        self.closed = True
        self.router.cancel()
        self.coach.stop()
        await asyncio.gather(*(s.close() for s in self.streams.values()), return_exceptions=True)
        self.streams.clear()

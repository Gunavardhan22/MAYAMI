"""Per-connection orchestration: routes audio frames to STT, turns completed interviewer
utterances into questions, and streams grounded answers back over the client socket.

Wire protocol (client -> server):
  binary frame: 1 byte channel id (0 = interviewer/tab audio, 1 = candidate/mic) + WebM/Opus chunk
  text frame:   {"type": "ask", "text": "..."}   manually trigger an answer
                {"type": "stop"}                  end the session

Server -> client (JSON text frames):
  {"type": "ready"}
  {"type": "transcript", "speaker": "interviewer"|"candidate", "text": str, "final": bool}
  {"type": "question", "id": int, "text": str}
  {"type": "answer_delta", "id": int, "text": str}
  {"type": "answer_done", "id": int}
  {"type": "error", "message": str}
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import deque

from fastapi import WebSocket, WebSocketDisconnect

from .config import get_settings
from .llm import AnswerGenerator
from .rag import get_store
from .stt import DeepgramStream

log = logging.getLogger(__name__)

SPEAKERS = {0: "interviewer", 1: "candidate"}


class InterviewSession:
    def __init__(self, ws: WebSocket, profile_id: str, generator: AnswerGenerator) -> None:
        self.ws = ws
        self.profile_id = profile_id
        self.generator = generator
        self.settings = get_settings()
        self.streams: dict[int, DeepgramStream] = {}
        self.history: deque[tuple[str, str]] = deque(maxlen=self.settings.history_turns)
        self.answer_task: asyncio.Task | None = None
        self.question_id = 0
        self.closed = False
        self._send_lock = asyncio.Lock()

    async def send(self, payload: dict) -> None:
        async with self._send_lock:
            try:
                await self.ws.send_text(json.dumps(payload))
            except (WebSocketDisconnect, RuntimeError):
                pass

    async def _stream_for(self, channel: int) -> DeepgramStream:
        stream = self.streams.get(channel)
        if stream is None:
            speaker = SPEAKERS[channel]

            async def on_transcript(text: str, final: bool) -> None:
                await self.send({"type": "transcript", "speaker": speaker, "text": text, "final": final})

            async def on_utterance(text: str) -> None:
                await self._on_utterance(speaker, text)

            stream = DeepgramStream(on_transcript, on_utterance)
            await stream.start()
            self.streams[channel] = stream
        return stream

    async def _on_utterance(self, speaker: str, text: str) -> None:
        if self.closed:
            return
        if speaker == "interviewer" and len(text.split()) >= self.settings.min_question_words:
            self.ask(text)
        self.history.append((speaker, text))

    def ask(self, question: str) -> None:
        # A new question supersedes whatever answer is still streaming.
        if self.answer_task and not self.answer_task.done():
            self.answer_task.cancel()
        self.question_id += 1
        self.answer_task = asyncio.create_task(
            self._answer(self.question_id, question, list(self.history))
        )

    async def _answer(self, qid: int, question: str, history: list[tuple[str, str]]) -> None:
        try:
            ctx = await get_store().aretrieve(self.profile_id, question)
            head = ""
            announced = False
            async for delta in self.generator.stream_answer(question, history, ctx):
                if not announced:
                    # Hold back the first few characters so a "SKIP" (not a real question)
                    # never reaches the overlay.
                    head += delta
                    if len(head.strip()) < 4:
                        continue
                    if head.strip().upper().startswith("SKIP"):
                        return
                    await self.send({"type": "question", "id": qid, "text": question})
                    delta, announced = head, True
                await self.send({"type": "answer_delta", "id": qid, "text": delta})
            if not announced:
                if not head.strip() or head.strip().upper().startswith("SKIP"):
                    return
                await self.send({"type": "question", "id": qid, "text": question})
                await self.send({"type": "answer_delta", "id": qid, "text": head})
            await self.send({"type": "answer_done", "id": qid})
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.exception("Answer generation failed")
            await self.send({"type": "error", "message": f"Answer failed: {exc}"})

    async def run(self) -> None:
        await self.send({"type": "ready"})
        try:
            while True:
                msg = await self.ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                if (data := msg.get("bytes")) is not None:
                    if len(data) < 2 or data[0] not in SPEAKERS:
                        continue
                    try:
                        stream = await self._stream_for(data[0])
                    except Exception as exc:
                        log.exception("Could not open STT stream")
                        await self.send({"type": "error", "message": f"Speech-to-text unavailable: {exc}"})
                        break
                    await stream.send(data[1:])
                elif (text := msg.get("text")) is not None:
                    try:
                        cmd = json.loads(text)
                    except json.JSONDecodeError:
                        continue
                    if cmd.get("type") == "ask" and str(cmd.get("text", "")).strip():
                        self.ask(str(cmd["text"]).strip())
                    elif cmd.get("type") == "stop":
                        break
        except WebSocketDisconnect:
            pass
        finally:
            await self.close()

    async def close(self) -> None:
        self.closed = True
        if self.answer_task and not self.answer_task.done():
            self.answer_task.cancel()
        await asyncio.gather(*(s.close() for s in self.streams.values()), return_exceptions=True)
        self.streams.clear()

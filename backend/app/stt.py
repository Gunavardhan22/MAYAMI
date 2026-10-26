"""Streaming speech-to-text over Deepgram's live WebSocket API.

One DeepgramStream per audio channel (interviewer tab audio, candidate mic). Audio is
forwarded as-is (WebM/Opus chunks from MediaRecorder; Deepgram detects the container).
Finalized words are buffered until Deepgram signals UtteranceEnd, at which point the
whole utterance is handed to `on_utterance`.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from urllib.parse import urlencode

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed

from .config import get_settings

log = logging.getLogger(__name__)

DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen"
KEEPALIVE_SECONDS = 5

TranscriptCallback = Callable[[str, bool], Awaitable[None]]  # (text, is_final)
UtteranceCallback = Callable[[str], Awaitable[None]]


class DeepgramStream:
    def __init__(self, on_transcript: TranscriptCallback, on_utterance: UtteranceCallback) -> None:
        self._on_transcript = on_transcript
        self._on_utterance = on_utterance
        self._ws: ClientConnection | None = None
        self._tasks: list[asyncio.Task] = []
        self._finals: list[str] = []

    async def start(self) -> None:
        s = get_settings()
        if not s.deepgram_api_key:
            raise RuntimeError("DEEPGRAM_API_KEY is not configured")
        params = {
            "model": s.deepgram_model,
            "language": s.deepgram_language,
            "smart_format": "true",
            "punctuate": "true",
            "interim_results": "true",  # required for utterance_end_ms
            "utterance_end_ms": str(s.utterance_end_ms),
            "endpointing": str(s.endpointing_ms),
            "vad_events": "true",
        }
        self._ws = await connect(
            f"{DEEPGRAM_URL}?{urlencode(params)}",
            additional_headers={"Authorization": f"Token {s.deepgram_api_key}"},
            max_size=None,
        )
        self._tasks = [asyncio.create_task(self._receive()), asyncio.create_task(self._keepalive())]

    async def send(self, audio: bytes) -> None:
        if self._ws is not None:
            await self._ws.send(audio)

    async def close(self) -> None:
        if self._ws is not None:
            try:
                await self._ws.send(json.dumps({"type": "CloseStream"}))
                await asyncio.wait_for(self._tasks[0], timeout=2)
            except (ConnectionClosed, asyncio.TimeoutError):
                pass
            await self._ws.close()
        for task in self._tasks:
            task.cancel()
        await self._flush()

    async def _keepalive(self) -> None:
        assert self._ws is not None
        try:
            while True:
                await asyncio.sleep(KEEPALIVE_SECONDS)
                await self._ws.send(json.dumps({"type": "KeepAlive"}))
        except ConnectionClosed:
            pass

    async def _flush(self) -> None:
        if self._finals:
            text = " ".join(self._finals).strip()
            self._finals.clear()
            if text:
                await self._on_utterance(text)

    async def _receive(self) -> None:
        assert self._ws is not None
        try:
            async for raw in self._ws:
                msg = json.loads(raw)
                kind = msg.get("type")
                if kind == "Results":
                    alts = msg.get("channel", {}).get("alternatives") or [{}]
                    text = alts[0].get("transcript", "").strip()
                    if not text:
                        continue
                    if msg.get("is_final"):
                        self._finals.append(text)
                        await self._on_transcript(text, True)
                    else:
                        await self._on_transcript(text, False)
                elif kind == "UtteranceEnd":
                    await self._flush()
                elif kind == "Error":
                    log.error("Deepgram error: %s", msg)
        except ConnectionClosed as exc:
            log.info("Deepgram connection closed: %s", exc)
        except Exception:
            log.exception("Deepgram receive loop failed")

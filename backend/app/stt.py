"""Streaming speech-to-text over the Gemini Live API.

One LiveTranscriber per audio channel (interviewer tab audio, candidate mic). The client
sends raw 16 kHz mono int16 PCM. Gemini's voice activity detection decides when an
utterance is complete: interim transcriptions stream in while someone speaks, and a final
`input_transcription` arrives once they stop, which is handed to `on_utterance`.

Live sessions have a limited lifetime, so the transcriber reconnects transparently when
the server closes the session or sends GoAway. Audio sent while reconnecting is dropped.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

from google import genai
from google.genai import types

from .config import get_settings

log = logging.getLogger(__name__)

PCM_MIME = "audio/pcm;rate=16000"
RECONNECT_DELAY_SECONDS = 1

TranscriptCallback = Callable[[str, bool], Awaitable[None]]  # (text, is_final)
UtteranceCallback = Callable[[str], Awaitable[None]]


class LiveTranscriber:
    def __init__(
        self, client: genai.Client, on_transcript: TranscriptCallback, on_utterance: UtteranceCallback
    ) -> None:
        self._client = client
        self._on_transcript = on_transcript
        self._on_utterance = on_utterance
        self._session = None
        self._ready = asyncio.Event()
        self._closed = False
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run())
        # Wait for the first connection so setup errors (bad key, unknown model) surface here.
        ready = asyncio.create_task(self._ready.wait())
        done, _ = await asyncio.wait({self._task, ready}, return_when=asyncio.FIRST_COMPLETED)
        ready.cancel()
        if self._task in done:
            self._task.result()  # re-raise the connection error
            raise RuntimeError("Transcription session ended before it was ready")

    async def send(self, pcm: bytes) -> None:
        if self._session is None:
            return
        try:
            await self._session.send_realtime_input(audio=types.Blob(data=pcm, mime_type=PCM_MIME))
        except Exception:
            log.debug("Dropping audio while the live session reconnects", exc_info=True)

    async def close(self) -> None:
        self._closed = True
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)

    async def _run(self) -> None:
        s = get_settings()
        config = types.LiveConnectConfig(
            response_modalities=[types.Modality.TEXT],
            input_audio_transcription=types.AudioTranscriptionConfig(),
        )
        first = True
        while not self._closed:
            try:
                async with self._client.aio.live.connect(model=s.stt_model, config=config) as session:
                    self._session = session
                    self._ready.set()
                    first = False
                    await self._receive(session)
            except asyncio.CancelledError:
                raise
            except Exception:
                if first:
                    raise
                log.warning("Live transcription session failed; reconnecting", exc_info=True)
            finally:
                self._session = None
            if not self._closed:
                await asyncio.sleep(RECONNECT_DELAY_SECONDS)

    async def _receive(self, session) -> None:
        # receive() yields one model turn at a time; keep reading until the session ends.
        while not self._closed:
            got_any = False
            async for msg in session.receive():
                got_any = True
                if msg.go_away is not None:
                    log.info("Live session GoAway (time left %s); reconnecting", msg.go_away.time_left)
                    return
                content = msg.server_content
                if content is None:
                    continue
                if content.interim_input_transcription and content.interim_input_transcription.text:
                    await self._on_transcript(content.interim_input_transcription.text.strip(), False)
                if content.input_transcription and content.input_transcription.text:
                    text = content.input_transcription.text.strip()
                    if text:
                        await self._on_transcript(text, True)
                        await self._on_utterance(text)
            if not got_any:
                return  # stream closed by the server

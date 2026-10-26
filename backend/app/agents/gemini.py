"""Shared Gemini streaming for all agents.

`HedgedGemini.stream` yields `Piece`s (text, executed code, code results, search sources)
and hedges against model congestion: if the primary model hasn't produced anything within
`llm_hedge_ms` (or fails), the fallback model is asked too, and whichever starts first wins.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from google import genai
from google.genai import types

from ..config import get_settings

log = logging.getLogger(__name__)


@dataclass
class Piece:
    text: str = ""
    code: str | None = None  # code the model executed in the sandbox
    result: str | None = None  # sandbox output for the preceding code
    result_ok: bool | None = None
    sources: list[dict] = field(default_factory=list)  # [{"title", "url"}] from search grounding


def _pieces(chunk: types.GenerateContentResponse) -> list[Piece]:
    out: list[Piece] = []
    for cand in chunk.candidates or []:
        for part in (cand.content.parts if cand.content else None) or []:
            if part.thought:
                continue
            if part.executable_code and part.executable_code.code:
                out.append(Piece(code=part.executable_code.code))
            elif part.code_execution_result:
                res = part.code_execution_result
                out.append(Piece(result=res.output or "", result_ok=res.outcome == types.Outcome.OUTCOME_OK))
            elif part.text:
                out.append(Piece(text=part.text))
        meta = cand.grounding_metadata
        if meta and meta.grounding_chunks:
            sources = [
                {"title": c.web.title or c.web.uri, "url": c.web.uri}
                for c in meta.grounding_chunks
                if c.web and c.web.uri
            ]
            if sources:
                out.append(Piece(sources=sources))
    return out


def thinking_off() -> types.ThinkingConfig:
    return types.ThinkingConfig(thinking_budget=get_settings().llm_thinking_budget)


class HedgedGemini:
    def __init__(self, client: genai.Client) -> None:
        s = get_settings()
        self.client = client
        self.models = [m for m in (s.llm_model, s.llm_fallback_model) if m]
        self._hedge_seconds = s.llm_hedge_ms / 1000

    async def _open(self, model: str, contents: str, config) -> tuple[list[Piece], AsyncIterator]:
        """Start a stream and wait for its first non-empty pieces."""
        stream = await self.client.aio.models.generate_content_stream(model=model, contents=contents, config=config)
        it = aiter(stream)
        async for chunk in it:
            if pieces := _pieces(chunk):
                return pieces, it
        return [], it

    async def _race(self, contents: str, config) -> tuple[list[Piece], AsyncIterator]:
        tasks = {asyncio.create_task(self._open(self.models[0], contents, config)): self.models[0]}
        backups = self.models[1:]
        error: BaseException | None = None
        try:
            while tasks:
                timeout = self._hedge_seconds if backups else None
                done, _ = await asyncio.wait(tasks, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    model = tasks.pop(task)
                    if task.exception() is None:
                        if model != self.models[0]:
                            log.info("Answered by fallback model %s", model)
                        return task.result()
                    error = task.exception()
                    log.warning("Model %s failed: %s", model, error)
                if backups and (not done or not tasks):
                    # Primary is slow or failed: bring in the next model.
                    model = backups.pop(0)
                    tasks[asyncio.create_task(self._open(model, contents, config))] = model
            raise error or RuntimeError("No model produced an answer")
        finally:
            for task in tasks:
                task.cancel()

    async def stream(self, contents: str, config: types.GenerateContentConfig) -> AsyncIterator[Piece]:
        first, rest = await self._race(contents, config)
        for piece in first:
            yield piece
        async for chunk in rest:
            for piece in _pieces(chunk):
                yield piece

    async def json(self, contents: str, config: types.GenerateContentConfig) -> str:
        """Non-streamed call (structured output), on the primary model only."""
        resp = await self.client.aio.models.generate_content(model=self.models[0], contents=contents, config=config)
        return resp.text or ""

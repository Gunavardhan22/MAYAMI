"""Master Router: decides which agent answers each question.

For every interviewer question it runs, in parallel:
  - retrieval from the resume/JD vector store,
  - the Listener (intent, category, impatience),
  - a *speculative* general answer, buffered and not yet shown.

When the Listener's verdict arrives (or `listener_wait_ms` passes) it either releases the
buffered general answer, discards it for a specialist (technical / design / research), or
drops the question entirely (small talk). This keeps the common path as fast as a single
LLM call while still letting specialists take over. If the verdict arrives after the
general answer has started showing and calls for a specialist, the overlay is told to reset.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable

from google.genai import errors

from ..config import get_settings
from ..rag import RetrievedContext, get_store
from .answer import AnswerAgent
from .coach import CoachAgent
from .context import History
from .design import DesignAgent
from .gemini import HedgedGemini
from .listener import ListenerAgent, Verdict
from .research import ResearchAgent
from .technical import TechnicalAgent

log = logging.getLogger(__name__)

Send = Callable[[dict], Awaitable[None]]

# How long a late Listener verdict can still reroute an answer that is already showing.
LATE_VERDICT_SECONDS = 4

ROUTES = {"coding": "technical", "system_design": "design", "company": "research", "recent_tech": "research"}


def route(verdict: Verdict) -> str:
    return ROUTES.get(verdict.category, "answer")


def _friendly(exc: errors.APIError) -> str:
    if exc.code == 429:
        return "Gemini quota used up (the free tier allows 20 requests per model per day). Enable billing in Google AI Studio."
    if exc.code == 503:
        return "Gemini is overloaded right now. Ask again in a moment."
    return f"Answer failed: Gemini error {exc.code}."


def _is_skip(text: str) -> bool:
    return text.strip().upper().startswith("SKIP")


class MasterRouter:
    def __init__(self, gemini: HedgedGemini, send: Send, coach: CoachAgent, profile_id: str) -> None:
        self._send = send
        self._coach = coach
        self._profile_id = profile_id
        self._listener_wait = get_settings().listener_wait_ms / 1000
        self.listener = ListenerAgent(gemini)
        self.agents = {
            a.name: a for a in (AnswerAgent(gemini), TechnicalAgent(gemini), DesignAgent(gemini), ResearchAgent(gemini))
        }
        self._runs: dict[int, asyncio.Task] = {}
        self._qid = 0
        self._announced: set[int] = set()

    def handle(self, question: str, history: History, manual: bool = False) -> None:
        # Don't cancel the current answer yet: this utterance may turn out to be chatter
        # ("take your time"). It supersedes older answers only once it shows something.
        self._qid += 1
        qid = self._qid
        task = asyncio.create_task(self._run(qid, question, history, manual))
        self._runs[qid] = task
        task.add_done_callback(lambda _t: self._runs.pop(qid, None))

    def cancel(self) -> None:
        for task in list(self._runs.values()):
            task.cancel()

    # --- orchestration ----------------------------------------------------------------

    async def _run(self, qid: int, question: str, history: History, manual: bool) -> None:
        listen = asyncio.create_task(self.listener.classify(question, history))
        listen.add_done_callback(self._on_verdict)
        speculation: asyncio.Task | None = None
        forward: asyncio.Task | None = None
        try:
            ctx = await get_store().aretrieve(self._profile_id, question)
            queue: asyncio.Queue = asyncio.Queue()
            speculation = asyncio.create_task(
                self._buffer(self.agents["answer"].events(question, history, ctx), queue)
            )

            verdict = await self._verdict(listen, self._listener_wait)
            if verdict is not None:
                if not (verdict.needs_answer or manual):
                    return
                if (name := route(verdict)) != "answer":
                    speculation.cancel()
                    await self._specialist(qid, name, question, history, ctx)
                    return

            forward = asyncio.create_task(self._forward(qid, question, queue))
            if verdict is None:
                # Verdict is late: the general answer streams meanwhile, but a specialist
                # still takes over (even from a finished answer) if the Listener asks for one.
                late = await self._verdict(listen, LATE_VERDICT_SECONDS)
                if late is not None and late.needs_answer and (name := route(late)) != "answer":
                    forward.cancel()
                    speculation.cancel()
                    if qid in self._announced:
                        await self._send({"type": "answer_reset", "id": qid, "agent": name})
                    await self._specialist(qid, name, question, history, ctx)
                    return
            await forward
        except asyncio.CancelledError:
            raise
        except errors.APIError as exc:
            log.exception("Answering q%d failed", qid)
            await self._send({"type": "error", "payload": _friendly(exc)})
        except Exception as exc:
            log.exception("Answering q%d failed", qid)
            await self._send({"type": "error", "payload": f"Answer failed: {exc}"})
        finally:
            for task in (speculation, forward):
                if task:
                    task.cancel()
            if not listen.done():
                listen.cancel()
            self._announced.discard(qid)

    async def _verdict(self, listen: asyncio.Task, timeout: float) -> Verdict | None:
        try:
            return await asyncio.wait_for(asyncio.shield(listen), timeout) if timeout else listen.result()
        except asyncio.TimeoutError:
            return None
        except asyncio.CancelledError:
            raise
        except Exception:
            log.warning("Listener failed; using the general answer", exc_info=True)
            return None

    def _on_verdict(self, listen: asyncio.Task) -> None:
        if listen.cancelled() or listen.exception() is not None:
            return
        verdict: Verdict = listen.result()
        if verdict.impatience:
            asyncio.create_task(self._coach.interviewer_impatient(verdict.coaching_hint))

    async def _announce(self, qid: int, question: str, agent: str) -> None:
        if qid not in self._announced:
            # This question is now on screen: it supersedes every older one still running.
            for older, task in list(self._runs.items()):
                if older < qid:
                    task.cancel()
            self._announced.add(qid)
            await self._send({"type": "question", "id": qid, "payload": question, "agent": agent})

    @staticmethod
    async def _buffer(events: AsyncIterator[dict], queue: asyncio.Queue) -> None:
        try:
            async for event in events:
                await queue.put(event)
            await queue.put(None)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await queue.put(exc)

    async def _forward(self, qid: int, question: str, queue: asyncio.Queue) -> None:
        """Emit the buffered general answer, holding back the first few characters so a
        "SKIP" (not a real question) never reaches the overlay."""
        head = ""
        while (event := await queue.get()) is not None:
            if isinstance(event, Exception):
                raise event
            text = event["payload"]
            if qid not in self._announced:
                head += text
                if len(head.strip()) < 4:
                    continue
                if _is_skip(head):
                    return
                await self._announce(qid, question, "answer")
                text = head
            await self._send({"type": "answer_chunk", "id": qid, "payload": text})
        if qid not in self._announced:
            if not head.strip() or _is_skip(head):
                return
            await self._announce(qid, question, "answer")
            await self._send({"type": "answer_chunk", "id": qid, "payload": head})
        await self._send({"type": "answer_done", "id": qid})

    async def _specialist(self, qid: int, name: str, question: str, history: History, ctx: RetrievedContext) -> None:
        log.info("q%d routed to %s agent", qid, name)
        await self._announce(qid, question, name)
        async for event in self.agents[name].events(question, history, ctx):
            await self._send({**event, "id": qid})
        await self._send({"type": "answer_done", "id": qid})

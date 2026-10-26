"""Research agent: questions about the company, recent news or very recent technology.
Uses Google Search grounding; if search isn't available on the key (e.g. no quota), it
answers from model knowledge and says so."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator

from google.genai import errors, types

from ..rag import RetrievedContext
from .context import GROUNDING_RULES, History, build_user_message
from .gemini import HedgedGemini, thinking_off

log = logging.getLogger(__name__)

SYSTEM_PROMPT = f"""\
You help a job candidate during a live interview when the question needs current, external \
facts: the hiring company (news, products, strategy, financials) or a recent technology. \
The job description excerpts tell you which company and role this is.

Rules:
{GROUNDING_RULES}
- Use the search tool to check facts. Prefer the most recent reliable sources.
- Details: 2-4 bullet points the candidate can say, connecting the facts to the role or to \
their experience where it is genuine.
- If facts are uncertain or could not be checked, say so briefly rather than guessing.
- Keep it under 120 words.\
"""

NO_SEARCH_NOTE = "_Live search unavailable, so this is from model knowledge and may be out of date._\n\n"


class ResearchAgent:
    name = "research"

    def __init__(self, gemini: HedgedGemini) -> None:
        self._gemini = gemini
        base = dict(system_instruction=SYSTEM_PROMPT, max_output_tokens=1200, thinking_config=thinking_off())
        self._search = types.GenerateContentConfig(**base, tools=[types.Tool(google_search=types.GoogleSearch())])
        self._plain = types.GenerateContentConfig(**base)
        self._search_available = True

    async def events(self, question: str, history: History, ctx: RetrievedContext) -> AsyncIterator[dict]:
        message = build_user_message(question, history, ctx)
        if self._search_available:
            yield {"type": "status", "payload": "Searching the web..."}
            try:
                seen: set[str] = set()
                async for piece in self._gemini.stream(message, self._search):
                    if piece.text:
                        yield {"type": "answer_chunk", "payload": piece.text}
                    new = [s for s in piece.sources if s["url"] not in seen]
                    if new:
                        seen.update(s["url"] for s in new)
                        yield {"type": "sources", "sources": new}
                return
            except errors.APIError as exc:
                if exc.code not in (400, 403, 429):
                    raise
                log.warning("Search grounding unavailable (%s); answering without it", exc.code)
                if exc.code != 429:
                    # Not enabled for this key: stop trying this session. A 429 may only
                    # be a temporary quota limit, so search is tried again next time.
                    self._search_available = False
        yield {"type": "status", "payload": "Answering from model knowledge..."}
        yield {"type": "answer_chunk", "payload": NO_SEARCH_NOTE}
        async for piece in self._gemini.stream(message, self._plain):
            if piece.text:
                yield {"type": "answer_chunk", "payload": piece.text}

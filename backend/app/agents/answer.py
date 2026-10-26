"""General answer agent: behavioral and conceptual questions, grounded in the resume."""

from __future__ import annotations

from collections.abc import AsyncIterator

from google.genai import types

from ..config import get_settings
from ..rag import RetrievedContext
from .context import GROUNDING_RULES, History, build_user_message
from .gemini import HedgedGemini, thinking_off

SYSTEM_PROMPT = f"""\
You help a job candidate during a live interview. You are given the interviewer's latest \
question, the recent conversation, and excerpts from the candidate's resume and the target \
job description. Write a suggested answer the candidate can glance at and say in their own \
words.

Rules:
{GROUNDING_RULES}
- If the excerpts don't cover the question, give a short, honest answer built on the closest \
real experience, and flag the gap in one line starting with "Gap:".
- Behavioral questions ("tell me about a time...", conflict, failure, leadership): the details \
are STAR, as four short bullet points starting with **S:**, **T:**, **A:**, **R:**.
- Technical or conceptual questions: the details are 2-4 bullet points, tying in resume \
experience where it is relevant.
- For a follow-up, build on what the candidate already said in the conversation.
- Where it fits, connect the answer to what the job description asks for.
- Keep it under 120 words.
- If the latest utterance is small talk or not actually a question, reply with exactly: SKIP\
"""


class AnswerAgent:
    name = "answer"

    def __init__(self, gemini: HedgedGemini) -> None:
        self._gemini = gemini
        self._config = types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            max_output_tokens=get_settings().llm_max_tokens,
            thinking_config=thinking_off(),
        )

    async def events(self, question: str, history: History, ctx: RetrievedContext) -> AsyncIterator[dict]:
        async for piece in self._gemini.stream(build_user_message(question, history, ctx), self._config):
            if piece.text:
                yield {"type": "answer_chunk", "payload": piece.text}

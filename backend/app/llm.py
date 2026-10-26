"""Answer generation: builds a grounded prompt from retrieved resume/JD context and
streams Claude's response token-by-token."""

from __future__ import annotations

from collections.abc import AsyncIterator

import anthropic

from .config import get_settings
from .rag import RetrievedContext

SYSTEM_PROMPT = """\
You help a job candidate during a live interview. You are given the interviewer's latest \
question, the recent conversation, and excerpts from the candidate's resume and the target \
job description. Write a suggested answer the candidate can glance at and say in their own \
words.

Rules:
- Write in the first person, as the candidate.
- Ground every claim in the resume excerpts. Never invent employers, projects, titles, dates \
or metrics. If the excerpts don't cover the question, give a short, honest answer built on \
the closest real experience, and flag the gap in one line starting with "Gap:".
- Behavioral questions ("tell me about a time...", conflict, failure, leadership): use STAR, \
formatted as four short lines starting with **S:**, **T:**, **A:**, **R:**.
- Technical or conceptual questions: lead with a one-sentence direct answer, then 2-4 bullet \
points, tying in resume experience where it is relevant.
- Where it fits, connect the answer to what the job description asks for.
- Keep it under 120 words. It is read at a glance, so no preamble and no closing summary.
- If the latest utterance is small talk or not actually a question, reply with exactly: SKIP\
"""


def _format_context(ctx: RetrievedContext) -> str:
    parts = []
    if ctx.experiences:
        parts.append(
            "<resume_excerpts>\n"
            + "\n---\n".join(ctx.experiences)
            + "\n</resume_excerpts>"
        )
    else:
        parts.append("<resume_excerpts>(no resume uploaded)</resume_excerpts>")
    if ctx.requirements:
        parts.append(
            "<job_description_excerpts>\n"
            + "\n---\n".join(ctx.requirements)
            + "\n</job_description_excerpts>"
        )
    if ctx.matched_competencies:
        parts.append(
            "<competencies_matching_jd>"
            + ", ".join(ctx.matched_competencies)
            + "</competencies_matching_jd>"
        )
    return "\n\n".join(parts)


def build_user_message(question: str, history: list[tuple[str, str]], ctx: RetrievedContext) -> str:
    convo = "\n".join(f"{speaker}: {text}" for speaker, text in history) or "(start of interview)"
    return (
        f"{_format_context(ctx)}\n\n"
        f"<recent_conversation>\n{convo}\n</recent_conversation>\n\n"
        f"<question>{question}</question>"
    )


class AnswerGenerator:
    def __init__(self) -> None:
        s = get_settings()
        self._client = anthropic.AsyncAnthropic(api_key=s.anthropic_api_key or None)
        self._model = s.llm_model
        self._max_tokens = s.llm_max_tokens

    async def stream_answer(
        self, question: str, history: list[tuple[str, str]], ctx: RetrievedContext
    ) -> AsyncIterator[str]:
        async with self._client.messages.stream(
            model=self._model,
            max_tokens=self._max_tokens,
            # Latency matters more than depth here: no thinking, lowest effort.
            thinking={"type": "disabled"},
            output_config={"effort": "low"},
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": build_user_message(question, history, ctx)}],
        ) as stream:
            async for text in stream.text_stream:
                yield text
            final = await stream.get_final_message()
            if final.stop_reason == "refusal":
                yield "\n\n_(The model declined to answer this one.)_"

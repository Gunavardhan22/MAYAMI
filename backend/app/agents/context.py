"""Prompt context shared by the answering agents."""

from __future__ import annotations

from ..rag import RetrievedContext

History = list[tuple[str, str]]  # (speaker, text), oldest first

GROUNDING_RULES = """\
- Write in the first person, as the candidate, in words they can say out loud.
- Ground claims about the candidate in the resume excerpts. Never invent employers, \
projects, titles, dates or metrics.
- Always start with a one-sentence headline answer on its own line (no label, no \
formatting), then a blank line, then the details.
- It is read at a glance during a live conversation: no preamble, no closing summary.\
"""


def format_context(ctx: RetrievedContext) -> str:
    parts = []
    if ctx.experiences:
        parts.append("<resume_excerpts>\n" + "\n---\n".join(ctx.experiences) + "\n</resume_excerpts>")
    else:
        parts.append("<resume_excerpts>(no resume uploaded)</resume_excerpts>")
    if ctx.requirements:
        parts.append(
            "<job_description_excerpts>\n" + "\n---\n".join(ctx.requirements) + "\n</job_description_excerpts>"
        )
    if ctx.matched_competencies:
        parts.append("<competencies_matching_jd>" + ", ".join(ctx.matched_competencies) + "</competencies_matching_jd>")
    return "\n\n".join(parts)


def format_history(history: History) -> str:
    return "\n".join(f"{speaker}: {text}" for speaker, text in history) or "(start of interview)"


def build_user_message(question: str, history: History, ctx: RetrievedContext) -> str:
    return (
        f"{format_context(ctx)}\n\n"
        f"<recent_conversation>\n{format_history(history)}\n</recent_conversation>\n\n"
        f"<question>{question}</question>"
    )

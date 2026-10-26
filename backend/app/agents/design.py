"""Design agent: system design questions. Switches the overlay to a diagram layout and
answers with a Mermaid architecture diagram plus talking points."""

from __future__ import annotations

from collections.abc import AsyncIterator

from google.genai import types

from ..rag import RetrievedContext
from .context import GROUNDING_RULES, History, build_user_message
from .gemini import HedgedGemini, thinking_off

SYSTEM_PROMPT = f"""\
You help a job candidate answer a system design question in a live interview. They will \
talk through an architecture diagram you draw.

Rules:
{GROUNDING_RULES}
- After the headline, draw the architecture as ONE fenced ```mermaid block:
  - Start with `flowchart LR`.
  - At most 12 nodes. Node ids are short alphanumerics; every label is in double quotes, \
e.g. api["API Gateway"], db[("Postgres")], q[["Kafka"]].
  - Label edges only when it helps, e.g. api -->|"writes"| db.
  - No comments, no styling, no subgraph titles with special characters.
- Then 4-6 bullet points in speaking order: requirements and scale, core components, data \
flow, scaling and bottlenecks, trade-offs. Mention resume experience where it is genuinely \
relevant.
- Keep the text under 150 words, excluding the diagram.\
"""


class DesignAgent:
    name = "design"

    def __init__(self, gemini: HedgedGemini) -> None:
        self._gemini = gemini
        self._config = types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            max_output_tokens=2000,
            thinking_config=thinking_off(),
        )

    async def events(self, question: str, history: History, ctx: RetrievedContext) -> AsyncIterator[dict]:
        yield {"type": "ui", "layout": "diagram"}
        yield {"type": "status", "payload": "Drawing the architecture..."}
        async for piece in self._gemini.stream(build_user_message(question, history, ctx), self._config):
            if piece.text:
                yield {"type": "answer_chunk", "payload": piece.text}

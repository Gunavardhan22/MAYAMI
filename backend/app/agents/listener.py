"""Listener agent: classifies each completed interviewer utterance (intent, question
category, impatience) with one fast structured-output call. The router uses the verdict to
pick a specialist; the coach uses the impatience signal."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass

from google.genai import types

from .context import History, format_history
from .gemini import HedgedGemini, thinking_off

log = logging.getLogger(__name__)

INTENTS = ["new_question", "follow_up", "clarification", "small_talk", "statement", "wrap_up"]
CATEGORIES = ["behavioral", "concept", "coding", "system_design", "company", "recent_tech", "other"]

SCHEMA = {
    "type": "object",
    "properties": {
        "needs_answer": {
            "type": "boolean",
            "description": "True if the candidate should now answer something substantive.",
        },
        "intent": {"type": "string", "enum": INTENTS},
        "category": {"type": "string", "enum": CATEGORIES},
        "impatience": {
            "type": "boolean",
            "description": "Interviewer signals they want a shorter answer or to move on.",
        },
        "coaching_hint": {
            "type": "string",
            "description": "At most 8 words of delivery advice for the candidate, or empty.",
        },
    },
    "required": ["needs_answer", "intent", "category", "impatience", "coaching_hint"],
}

SYSTEM_PROMPT = """\
You monitor a live job interview from the candidate's side. Classify the interviewer's \
latest utterance, using the recent conversation for context.

- needs_answer: false for greetings, small talk, acknowledgements ("great", "makes sense"), \
logistics, or the interviewer talking about the company or role without asking anything.
- category: coding = write or debug code / an algorithm; system_design = design or scale a \
system; company = the hiring company, its products, news or competitors; recent_tech = a \
specific technology, release or event from the last couple of years; behavioral = past \
experience and soft skills; concept = explain a technical concept.
- impatience: phrases like "briefly", "in the interest of time", "let's move on", "we're \
short on time", interrupting the candidate, or repeating a question that wasn't answered.
- coaching_hint: only when there is a clear delivery issue, e.g. "Be brief, they want to \
move on" or "Answer the question directly". Otherwise empty.\
"""


@dataclass
class Verdict:
    needs_answer: bool
    intent: str
    category: str
    impatience: bool
    coaching_hint: str


class ListenerAgent:
    name = "listener"

    def __init__(self, gemini: HedgedGemini) -> None:
        self._gemini = gemini
        self._config = types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            response_mime_type="application/json",
            response_json_schema=SCHEMA,
            max_output_tokens=200,
            thinking_config=thinking_off(),
        )

    async def classify(self, utterance: str, history: History) -> Verdict:
        prompt = (
            f"<recent_conversation>\n{format_history(history)}\n</recent_conversation>\n\n"
            f"<latest_interviewer_utterance>{utterance}</latest_interviewer_utterance>"
        )
        data = json.loads(await self._gemini.json(prompt, self._config))
        verdict = Verdict(
            needs_answer=bool(data.get("needs_answer", True)),
            intent=data.get("intent", "new_question"),
            category=data.get("category", "other"),
            impatience=bool(data.get("impatience", False)),
            coaching_hint=str(data.get("coaching_hint", "")).strip(),
        )
        log.info("Listener: %s", verdict)
        return verdict

"""Technical agent: live coding questions. Writes a solution, runs it against test cases in
Gemini's code-execution sandbox (Python), fixes it until the tests pass, then presents it."""

from __future__ import annotations

from collections.abc import AsyncIterator

from google.genai import types

from ..rag import RetrievedContext
from .context import History, build_user_message
from .gemini import HedgedGemini, thinking_off

SYSTEM_PROMPT = """\
You help a job candidate answer a live coding question in an interview.

Process:
1. Write a correct, clean solution. Use Python unless the question names another language.
2. If it is Python, verify it with the code execution tool: run it on 3-5 test cases \
including edge cases. If a test fails, fix the code and run again. Do not write any prose \
before the tests pass.
3. If another language was requested, you cannot run it: reason through the edge cases \
carefully, and add a final line "Gap: not executed - verify by hand."

Then write the final response for the candidate:
- First line: a one-sentence headline naming the approach and its time/space complexity \
(no label, no formatting), then a blank line.
- 2-4 short bullet points explaining the approach in the candidate's voice.
- The final solution in one fenced code block with a language tag. No test code in it.\
"""


class TechnicalAgent:
    name = "technical"

    def __init__(self, gemini: HedgedGemini) -> None:
        self._gemini = gemini
        self._config = types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            max_output_tokens=4000,
            thinking_config=thinking_off(),
            tools=[types.Tool(code_execution=types.ToolCodeExecution())],
        )

    async def events(self, question: str, history: History, ctx: RetrievedContext) -> AsyncIterator[dict]:
        yield {"type": "ui", "layout": "code"}
        yield {"type": "status", "payload": "Writing a solution..."}
        pending_code: str | None = None
        wrote_text = False
        async for piece in self._gemini.stream(build_user_message(question, history, ctx), self._config):
            if piece.code is not None:
                if wrote_text:
                    # Prose before a test run was thinking out loud, not the final answer.
                    yield {"type": "answer_reset"}
                    wrote_text = False
                pending_code = piece.code
                yield {"type": "status", "payload": "Running tests in the sandbox..."}
            elif piece.result is not None:
                yield {"type": "code_run", "code": pending_code or "", "output": piece.result, "ok": piece.result_ok}
                yield {"type": "status", "payload": "Tests passed" if piece.result_ok else "Fixing a failing test..."}
            elif piece.text:
                wrote_text = True
                yield {"type": "answer_chunk", "payload": piece.text}

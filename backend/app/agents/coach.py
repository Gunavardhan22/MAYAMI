"""Coach agent: watches the candidate's own speech and pushes delivery alerts.

Gemini's transcription doesn't expose prosody (pitch, energy), so pace and talk time are
measured from transcription timing: an utterance starts at its first interim transcript
and ends at its final one (minus the ~1 s of trailing silence the voice detector waits for).
Alerts are rule-based so they're instant and free, and each kind has a cooldown.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from collections.abc import Awaitable, Callable

from ..config import get_settings

# Final transcripts arrive after the voice detector hears this much silence.
TRAILING_SILENCE_SECONDS = 1.0
PACE_WINDOW_SECONDS = 45
MIN_SPEECH_FOR_PACE_SECONDS = 12
# The candidate's turn counts as ongoing if they spoke this recently.
TURN_GAP_SECONDS = 8
CHECK_INTERVAL_SECONDS = 3

Emit = Callable[[dict], Awaitable[None]]


class CoachAgent:
    name = "coach"

    def __init__(self, emit: Emit) -> None:
        s = get_settings()
        self._emit = emit
        self._monologue_seconds = s.coach_monologue_seconds
        self._fast_wpm = s.coach_fast_wpm
        self._cooldown_seconds = s.coach_cooldown_seconds
        self._utterance_start: float | None = None
        self._turn_start: float | None = None
        self._last_speech = 0.0
        self._spoken: deque[tuple[float, int, float]] = deque()  # (end time, words, seconds)
        self._last_alert: dict[str, float] = {}
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._watch())

    def stop(self) -> None:
        if self._task:
            self._task.cancel()

    # --- transcript hooks -------------------------------------------------------------

    def candidate_partial(self) -> None:
        now = time.monotonic()
        if self._utterance_start is None:
            self._utterance_start = now
        if self._turn_start is None or now - self._last_speech > TURN_GAP_SECONDS:
            self._turn_start = now
        self._last_speech = now

    def candidate_final(self, text: str) -> None:
        now = time.monotonic()
        start = self._utterance_start or now
        seconds = max(0.5, now - start - TRAILING_SILENCE_SECONDS)
        self._spoken.append((now, len(text.split()), seconds))
        self._utterance_start = None
        self._last_speech = now
        if self._turn_start is None:
            self._turn_start = start

    def interviewer_spoke(self) -> None:
        # The interviewer taking a turn ends the candidate's monologue.
        self._turn_start = None

    async def interviewer_impatient(self, hint: str) -> None:
        await self._alert("impatience", "warn", hint or "They want you to wrap up. Keep it brief.")

    # --- rules ------------------------------------------------------------------------

    def words_per_minute(self, now: float) -> float | None:
        while self._spoken and now - self._spoken[0][0] > PACE_WINDOW_SECONDS:
            self._spoken.popleft()
        seconds = sum(s for _, _, s in self._spoken)
        if seconds < MIN_SPEECH_FOR_PACE_SECONDS:
            return None
        return sum(w for _, w, _ in self._spoken) / seconds * 60

    async def check(self, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        speaking = now - self._last_speech < TURN_GAP_SECONDS
        if speaking and self._turn_start is not None and now - self._turn_start > self._monologue_seconds:
            minutes = int((now - self._turn_start) // 60)
            await self._alert("monologue", "warn", f"You've talked for {minutes}+ min. Wrap up and ask them a question.")
        wpm = self.words_per_minute(now)
        if speaking and wpm is not None and wpm > self._fast_wpm:
            await self._alert("pace", "warn", f"Slow down ({wpm:.0f} words/min).")

    async def _alert(self, key: str, level: str, message: str) -> None:
        now = time.monotonic()
        if now - self._last_alert.get(key, -1e9) < self._cooldown_seconds:
            return
        self._last_alert[key] = now
        await self._emit({"type": "coach", "key": key, "level": level, "payload": message, "ttl_ms": 8000})

    async def _watch(self) -> None:
        while True:
            await asyncio.sleep(CHECK_INTERVAL_SECONDS)
            await self.check()

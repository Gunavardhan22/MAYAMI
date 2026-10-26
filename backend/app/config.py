from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # One Gemini API key covers both transcription and answer generation.
    google_api_key: str = ""
    stt_model: str = "gemini-3.5-transcribe-live"
    llm_model: str = "gemini-3-flash-preview"
    # Asked as well if the primary hasn't started answering within llm_hedge_ms (or errors).
    llm_fallback_model: str = "gemini-3.5-flash"
    llm_hedge_ms: int = 2000
    llm_max_tokens: int = 600
    # 0 disables thinking for the fastest first token.
    llm_thinking_budget: int = 0

    mayami_api_key: str = ""
    cors_origins: str = "*"

    chroma_path: str = "./data/chroma"
    resume_top_k: int = 4
    jd_top_k: int = 2

    # How long the router waits for the Listener's verdict before showing the general answer.
    listener_wait_ms: int = 1200

    # Coach alerts: continuous talking time, fast-speech threshold, and per-alert cooldown.
    coach_monologue_seconds: int = 180
    coach_fast_wpm: int = 175
    coach_cooldown_seconds: int = 60

    # Interviewer utterances shorter than this are treated as chatter, not questions.
    min_question_words: int = 4
    # Number of past transcript turns sent to the LLM for conversational context.
    history_turns: int = 6


@lru_cache
def get_settings() -> Settings:
    return Settings()

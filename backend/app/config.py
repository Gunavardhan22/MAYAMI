from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    deepgram_api_key: str = ""
    deepgram_model: str = "nova-3"
    deepgram_language: str = "en-US"
    # Silence gap (ms) after which Deepgram emits UtteranceEnd and we treat the turn as complete.
    utterance_end_ms: int = 1000
    endpointing_ms: int = 300

    anthropic_api_key: str = ""
    llm_model: str = "claude-haiku-5-5"
    llm_max_tokens: int = 600

    mayami_api_key: str = ""
    cors_origins: str = "*"

    chroma_path: str = "./data/chroma"
    resume_top_k: int = 4
    jd_top_k: int = 2

    # Interviewer utterances shorter than this are treated as chatter, not questions.
    min_question_words: int = 4
    # Number of past transcript turns sent to the LLM for conversational context.
    history_turns: int = 6


@lru_cache
def get_settings() -> Settings:
    return Settings()

"""Vector store for a candidate's resume and target job description (one Chroma
collection per profile), plus retrieval for incoming interview questions."""

from __future__ import annotations

import asyncio
import hashlib
import re
from dataclasses import dataclass

import chromadb
from chromadb.utils.embedding_functions import DefaultEmbeddingFunction

from .config import get_settings
from .parsing import BASE_SKILLS, Chunk, chunk_job_description, chunk_resume

_PROFILE_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$")


@dataclass
class RetrievedContext:
    experiences: list[str]
    requirements: list[str]
    matched_competencies: list[str]

    @property
    def empty(self) -> bool:
        return not self.experiences and not self.requirements


def _split(value: str | None) -> set[str]:
    return {s for s in (value or "").split(",") if s}


class ProfileStore:
    def __init__(self, path: str) -> None:
        self._client = chromadb.PersistentClient(path=path)
        # Same model Chroma uses by default, held here so queries can embed once.
        self._embed = DefaultEmbeddingFunction()

    @staticmethod
    def validate_profile_id(profile_id: str) -> str:
        if not _PROFILE_RE.match(profile_id):
            raise ValueError("profile_id must be 1-63 chars of letters, digits, '-' or '_'")
        return profile_id

    def _collection(self, profile_id: str):
        name = f"profile_{self.validate_profile_id(profile_id)}"
        return self._client.get_or_create_collection(
            name=name, embedding_function=self._embed, metadata={"hnsw:space": "cosine"}
        )

    def _replace(self, profile_id: str, kind: str, chunks: list[Chunk], meta: dict) -> int:
        col = self._collection(profile_id)
        col.delete(where={"kind": kind})
        if chunks:
            col.add(
                ids=[hashlib.sha1(f"{kind}:{i}:{c.text}".encode()).hexdigest() for i, c in enumerate(chunks)],
                documents=[c.text for c in chunks],
                metadatas=[{"kind": kind, "section": c.section, "skills": ",".join(c.skills)} for c in chunks],
            )
        merged = {k: v for k, v in (col.metadata or {}).items() if not k.startswith("hnsw:")}
        merged.update(meta)
        col.modify(metadata=merged)
        return len(chunks)

    def ingest_resume(self, profile_id: str, text: str) -> dict:
        chunks, lexicon = chunk_resume(text)
        skills = sorted({s for c in chunks for s in c.skills})
        count = self._replace(
            profile_id,
            "resume",
            chunks,
            {"lexicon": ",".join(sorted(lexicon - BASE_SKILLS)), "resume_skills": ",".join(skills)},
        )
        return {"chunks": count, "skills": skills}

    def ingest_job_description(self, profile_id: str, text: str) -> dict:
        col = self._collection(profile_id)
        lexicon = BASE_SKILLS | _split((col.metadata or {}).get("lexicon"))
        chunks = chunk_job_description(text, lexicon)
        skills = sorted({s for c in chunks for s in c.skills})
        count = self._replace(profile_id, "jd", chunks, {"jd_skills": ",".join(skills)})
        return {"chunks": count, "skills": skills}

    def summary(self, profile_id: str) -> dict:
        col = self._collection(profile_id)
        meta = col.metadata or {}
        resume_skills, jd_skills = _split(meta.get("resume_skills")), _split(meta.get("jd_skills"))
        return {
            "profile_id": profile_id,
            "documents": col.count(),
            "resume_skills": sorted(resume_skills),
            "jd_skills": sorted(jd_skills),
            "matched_competencies": sorted(resume_skills & jd_skills),
            "missing_competencies": sorted(jd_skills - resume_skills),
        }

    def delete(self, profile_id: str) -> None:
        self._client.delete_collection(f"profile_{self.validate_profile_id(profile_id)}")

    def warmup(self) -> None:
        """Load the embedding model now so the first question doesn't pay for it."""
        self._embed(["warmup"])

    def _query(self, col, embedding, kind: str, k: int) -> list[str]:
        available = len(col.get(where={"kind": kind}, include=[])["ids"])
        if not available:
            return []
        res = col.query(query_embeddings=embedding, n_results=min(k, available), where={"kind": kind})
        return res["documents"][0]

    def retrieve(self, profile_id: str, question: str) -> RetrievedContext:
        settings = get_settings()
        col = self._collection(profile_id)
        meta = col.metadata or {}
        embedding = self._embed([question])  # embed once, query both document kinds
        return RetrievedContext(
            experiences=self._query(col, embedding, "resume", settings.resume_top_k),
            requirements=self._query(col, embedding, "jd", settings.jd_top_k),
            matched_competencies=sorted(_split(meta.get("resume_skills")) & _split(meta.get("jd_skills"))),
        )

    async def aretrieve(self, profile_id: str, question: str) -> RetrievedContext:
        # Chroma and the local embedding model are synchronous / CPU-bound.
        return await asyncio.to_thread(self.retrieve, profile_id, question)


_store: ProfileStore | None = None


def get_store() -> ProfileStore:
    global _store
    if _store is None:
        _store = ProfileStore(get_settings().chroma_path)
    return _store

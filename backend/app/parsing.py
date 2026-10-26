"""Resume / job-description parsing: text extraction, section detection, chunking and
competency tagging.

Competency mapping is lexicon-based: a built-in list of common skills, extended with
whatever the candidate lists in their own "Skills" section. Each chunk is tagged with the
skills it mentions so retrieval results can be cross-referenced against the JD.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from pathlib import Path

from docx import Document
from pypdf import PdfReader

SECTION_ALIASES: dict[str, tuple[str, ...]] = {
    "summary": ("summary", "profile", "objective", "about me", "professional summary"),
    "experience": (
        "experience",
        "work experience",
        "professional experience",
        "employment",
        "employment history",
        "work history",
    ),
    "projects": ("projects", "personal projects", "key projects", "academic projects"),
    "skills": ("skills", "technical skills", "core competencies", "competencies", "technologies"),
    "education": ("education", "academic background", "qualifications"),
    "certifications": ("certifications", "certificates", "licenses"),
    "achievements": ("achievements", "awards", "honors", "accomplishments"),
    "publications": ("publications", "research"),
    "leadership": ("leadership", "volunteering", "extracurricular", "activities"),
}
_HEADING_LOOKUP = {alias: canon for canon, aliases in SECTION_ALIASES.items() for alias in aliases}

BASE_SKILLS = {
    # languages
    "python", "java", "javascript", "typescript", "go", "golang", "rust", "c++", "c#", "kotlin",
    "swift", "scala", "ruby", "php", "sql", "r", "bash",
    # web / backend
    "react", "next.js", "vue", "angular", "node.js", "express", "django", "flask", "fastapi",
    "spring", "spring boot", "graphql", "rest", "grpc", "websockets", "microservices",
    # data / ml
    "machine learning", "deep learning", "nlp", "computer vision", "pytorch", "tensorflow",
    "scikit-learn", "pandas", "numpy", "spark", "hadoop", "airflow", "kafka", "dbt", "etl",
    "llm", "rag", "langchain", "vector database", "data analysis", "statistics", "a/b testing",
    # infra
    "aws", "gcp", "azure", "docker", "kubernetes", "terraform", "ci/cd", "jenkins",
    "github actions", "linux", "redis", "postgresql", "mysql", "mongodb", "dynamodb",
    "elasticsearch", "nginx", "serverless", "lambda",
    # practices / soft skills
    "system design", "distributed systems", "agile", "scrum", "testing", "tdd", "security",
    "leadership", "mentoring", "communication", "stakeholder management", "project management",
    "product management", "cross-functional", "problem solving",
}

MAX_CHUNK_CHARS = 700
_BULLET_RE = re.compile(r"^\s*(?:[-*•▪◦●‣]|\d+[.)])\s+")


@dataclass
class Chunk:
    text: str
    section: str
    skills: list[str] = field(default_factory=list)


def extract_text(filename: str, data: bytes) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix == ".pdf":
        reader = PdfReader(io.BytesIO(data))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    if suffix == ".docx":
        doc = Document(io.BytesIO(data))
        return "\n".join(p.text for p in doc.paragraphs)
    if suffix in {".txt", ".md", ""}:
        return data.decode("utf-8", errors="replace")
    raise ValueError(f"Unsupported file type: {suffix} (use .pdf, .docx, .txt or .md)")


def _heading_for(line: str) -> str | None:
    cleaned = line.strip().strip(":").strip().lower()
    cleaned = re.sub(r"[^a-z &/]", "", cleaned).strip()
    if not cleaned or len(cleaned) > 40:
        return None
    return _HEADING_LOOKUP.get(cleaned)


def split_sections(text: str) -> dict[str, list[str]]:
    sections: dict[str, list[str]] = {}
    current = "summary"
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        heading = _heading_for(line)
        if heading:
            current = heading
            continue
        sections.setdefault(current, []).append(line)
    return sections


def _group_lines(lines: list[str]) -> list[str]:
    """Group lines into chunks: each bullet starts a new unit, wrapped lines are joined,
    and units are packed together up to MAX_CHUNK_CHARS."""
    units: list[str] = []
    for line in lines:
        if _BULLET_RE.match(line) or not units:
            units.append(_BULLET_RE.sub("", line))
        else:
            units[-1] = f"{units[-1]} {line}"

    chunks: list[str] = []
    buf = ""
    for unit in units:
        if buf and len(buf) + len(unit) + 1 > MAX_CHUNK_CHARS:
            chunks.append(buf)
            buf = unit
        else:
            buf = f"{buf}\n{unit}" if buf else unit
    if buf:
        chunks.append(buf)
    return chunks


def parse_skill_list(lines: list[str]) -> set[str]:
    skills: set[str] = set()
    for line in lines:
        # "Languages: Python, Go" -> drop the label
        if ":" in line:
            line = line.split(":", 1)[1]
        for item in re.split(r"[,|;•·]", line):
            item = _BULLET_RE.sub("", item).strip().lower()
            if 1 < len(item) <= 30:
                skills.add(item)
    return skills


def find_skills(text: str, lexicon: set[str]) -> list[str]:
    lowered = text.lower()
    found = []
    for skill in lexicon:
        # Word-ish boundaries that tolerate symbols like c++, node.js, ci/cd.
        if re.search(rf"(?<![a-z0-9]){re.escape(skill)}(?![a-z0-9])", lowered):
            found.append(skill)
    return sorted(found)


def chunk_resume(text: str) -> tuple[list[Chunk], set[str]]:
    """Return resume chunks tagged with skills, plus the full skill lexicon used."""
    sections = split_sections(text)
    lexicon = BASE_SKILLS | parse_skill_list(sections.get("skills", []))
    chunks = [
        Chunk(text=body, section=section, skills=find_skills(body, lexicon))
        for section, lines in sections.items()
        for body in _group_lines(lines)
    ]
    return chunks, lexicon


def chunk_job_description(text: str, lexicon: set[str]) -> list[Chunk]:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return [
        Chunk(text=body, section="job_description", skills=find_skills(body, lexicon))
        for body in _group_lines(lines)
    ]

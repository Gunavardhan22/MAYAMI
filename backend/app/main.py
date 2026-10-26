import asyncio
import hmac
import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile, WebSocket, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import APIKeyHeader
from google import genai

from .config import get_settings
from .agents import HedgedGemini
from .parsing import extract_text
from .rag import get_store
from .session import InterviewSession

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await asyncio.to_thread(get_store().warmup)
    yield


app = FastAPI(title="MAYAMI", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)
# Without a key the client is still built so /health works; calls fail until one is set.
client = genai.Client(api_key=settings.google_api_key or "unset")
gemini = HedgedGemini(client)
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)


def _token_ok(token: str | None) -> bool:
    expected = settings.mayami_api_key
    return not expected or (token is not None and hmac.compare_digest(token, expected))


def require_api_key(key: str | None = Depends(api_key_header)) -> None:
    if not _token_ok(key):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid API key")


def _profile(profile_id: str) -> str:
    try:
        return get_store().validate_profile_id(profile_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "google_configured": bool(settings.google_api_key),
        "stt_model": settings.stt_model,
        "llm_model": settings.llm_model,
    }


@app.post("/api/profiles/{profile_id}/documents", dependencies=[Depends(require_api_key)])
async def upload_documents(
    profile_id: str,
    resume: UploadFile | None = File(default=None),
    job_description: str | None = Form(default=None),
    job_description_file: UploadFile | None = File(default=None),
) -> dict:
    profile_id = _profile(profile_id)
    store = get_store()
    result: dict = {}
    try:
        # Resume first so its skills section extends the lexicon used to tag the JD.
        if resume is not None:
            text = extract_text(resume.filename or "", await resume.read())
            result["resume"] = store.ingest_resume(profile_id, text)
        if job_description_file is not None:
            job_description = extract_text(job_description_file.filename or "", await job_description_file.read())
        if job_description and job_description.strip():
            result["job_description"] = store.ingest_job_description(profile_id, job_description)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    if not result:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Provide a resume and/or a job description")
    result["profile"] = store.summary(profile_id)
    return result


@app.get("/api/profiles/{profile_id}", dependencies=[Depends(require_api_key)])
async def get_profile(profile_id: str) -> dict:
    return get_store().summary(_profile(profile_id))


@app.delete("/api/profiles/{profile_id}", dependencies=[Depends(require_api_key)], status_code=204)
async def delete_profile(profile_id: str) -> None:
    get_store().delete(_profile(profile_id))


@app.websocket("/ws")
async def interview_socket(
    ws: WebSocket,
    profile: str = Query(...),
    token: str | None = Query(default=None),
) -> None:
    # Browsers can't set headers on WebSocket handshakes, so the key travels as a query param.
    if not _token_ok(token):
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="Invalid API key")
        return
    try:
        profile = get_store().validate_profile_id(profile)
    except ValueError as exc:
        await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason=str(exc))
        return
    await ws.accept()
    await InterviewSession(ws, profile, client, gemini).run()

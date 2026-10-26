# MAYAMI
MAYAMI is a stealthy, real-time AI interview copilot that listens to your live interviews and feeds you context-aware, resume-grounded answer suggestions in under 3 seconds. It ensures you never draw a blank when the pressure is on.

## Architecture

```
 Chrome extension (MV3)                     FastAPI backend (Docker / AWS)
 ┌───────────────────────────┐   WS /ws    ┌──────────────────────────────────────────┐
 │ popup ─ tabCapture id     │  binary:    │ InterviewSession                         │
 │ offscreen: tab + mic ─────┼─ [ch][webm]─┼─► DeepgramStream (ch0 interviewer) ──┐   │
 │   MediaRecorder 250ms     │             │   DeepgramStream (ch1 candidate)     │   │
 │                           │   JSON:     │                     UtteranceEnd ◄───┘   │
 │ overlay (content script) ◄┼─ question ──┼── question ─► Chroma RAG (resume + JD)   │
 │   streaming STAR answer   │  answer_*   │              └─► Claude Haiku (stream)   │
 └───────────────────────────┘             └──────────────────────────────────────────┘
```

| Layer | Where | What it does |
|---|---|---|
| Capture | [extension/offscreen.js](extension/offscreen.js) | Captures tab audio (interviewer) and, optionally, the mic (you), encodes WebM/Opus chunks every 250 ms, and streams them over one WebSocket. Each frame is prefixed with one channel byte. |
| Orchestration | [backend/app/session.py](backend/app/session.py) | Opens one Deepgram live stream per channel, keeps a rolling transcript, and turns each completed interviewer utterance into a question. A new question cancels any answer that is still streaming. |
| STT | [backend/app/stt.py](backend/app/stt.py) | Deepgram live API (`nova-3`). Final words are buffered until Deepgram sends `UtteranceEnd` (1 s of silence by default). |
| RAG | [backend/app/rag.py](backend/app/rag.py), [backend/app/parsing.py](backend/app/parsing.py) | Resume and JD are split into sections and bullet chunks, tagged with skills, and embedded into a per-profile Chroma collection. Each question pulls the top resume and JD chunks plus the skills both share. |
| LLM | [backend/app/llm.py](backend/app/llm.py) | Streams a first-person answer from `claude-haiku-5-5` (thinking off, low effort, for speed). It uses STAR for behavioral questions and must not invent facts that aren't in the resume. |
| Overlay | [extension/content.js](extension/content.js) | A small draggable panel (in a shadow DOM) showing the live interviewer line, the question and the answer as it streams, with history and a box for typing a question by hand. |

### WebSocket protocol

`ws(s)://<host>/ws?profile=<id>&token=<MAYAMI_API_KEY>`

- Client → server: binary `[channel:1 byte][webm chunk]` (0 = interviewer, 1 = candidate); text `{"type":"ask","text":...}`, `{"type":"stop"}`
- Server → client: `ready`, `transcript {speaker,text,final}`, `question {id,text}`, `answer_delta {id,text}`, `answer_done {id}`, `error {message}`

### REST

| Method | Path | Body |
|---|---|---|
| `POST` | `/api/profiles/{id}/documents` | multipart: `resume` (pdf/docx/txt/md), `job_description` (text) or `job_description_file` |
| `GET` | `/api/profiles/{id}` | Skill summary: matched and missing competencies |
| `DELETE` | `/api/profiles/{id}` | Deletes the profile |
| `GET` | `/health` | Liveness check |

REST calls send `X-API-Key`. The WebSocket sends the key as `?token=`, because browsers can't set headers on a WebSocket handshake.

## Running locally

```bash
cp backend/.env.example backend/.env   # fill in DEEPGRAM_API_KEY, ANTHROPIC_API_KEY, MAYAMI_API_KEY
docker compose up --build              # http://localhost:8000/health
```

Without Docker:

```bash
cd backend
python -m venv .venv && . .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### Load the extension

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select `extension/`.
2. Open the extension's **Options** page. Set the server URL (`ws://localhost:8000`), the API key and a profile ID, then click **Save**.
3. Click **Grant microphone access** once. Chrome only lets the background capture use the mic after this.
4. Upload your resume, paste the job description, and click **Upload to profile**. The page then lists the skills that match the JD and the ones that are missing.
5. In the meeting tab (Meet, Zoom web, Teams web), click the MAYAMI icon and then **Start on this tab**.

## Deploying on AWS

The image is self-contained: the embedding model is baked in at build time, and Chroma data lives in `/data`.

1. Push the image to ECR: `docker build -t mayami ./backend`, then tag it and push.
2. Run it on **ECS Fargate** behind an **Application Load Balancer** (ALBs support WebSockets). Use an HTTPS listener with an ACM certificate, so the extension connects with `wss://`.
3. Raise the ALB **idle timeout** (for example to 300 s). Uvicorn already pings every 20 s.
4. Mount **EFS** at `/data` so profiles survive task restarts. Run one task, or move to a shared vector store (pgvector, OpenSearch) before you scale out.
5. Store `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY` and `MAYAMI_API_KEY` in Secrets Manager and inject them as task environment variables.

App Runner is not a good fit, because it doesn't support WebSockets.

## Configuration

All settings are environment variables. See [backend/.env.example](backend/.env.example) and [backend/app/config.py](backend/app/config.py). The ones you're most likely to change:

- `UTTERANCE_END_MS`: how much silence ends a question. Lower is faster, but long pauses can split a question in two.
- `MIN_QUESTION_WORDS`: interviewer utterances shorter than this ("okay", "great") don't trigger an answer.
- `LLM_MODEL`: defaults to `claude-haiku-5-5`.

## Note on recording

MAYAMI transcribes the other people on the call. Some jurisdictions require everyone's consent before a conversation is recorded or transcribed. Check what applies to you before you use it.

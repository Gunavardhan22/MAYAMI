# MAYAMI
MAYAMI is a stealthy, real-time AI interview copilot that listens to your live interviews and feeds you context-aware, resume-grounded answer suggestions in under 3 seconds. It ensures you never draw a blank when the pressure is on.

## Architecture

```
 Chrome extension (MV3)                     FastAPI backend (Docker / AWS)
 ┌───────────────────────────┐   WS /ws    ┌──────────────────────────────────────────┐
 │ popup ─ tabCapture id     │  binary:    │ InterviewSession                         │
 │ offscreen: tab + mic ─────┼─ [ch][pcm]──┼─► Gemini Live STT (ch0 interviewer) ─┐   │
 │   16 kHz PCM, 100 ms      │             │   Gemini Live STT (ch1 candidate)    │   │
 │                           │   JSON:     │                 final transcript ◄───┘   │
 │ overlay (content script) ◄┼─ question ──┼── question ─► Chroma RAG (resume + JD)   │
 │   streaming STAR answer   │  answer_*   │              └─► Gemini Flash (stream)   │
 └───────────────────────────┘             └──────────────────────────────────────────┘
```

| Layer | Where | What it does |
|---|---|---|
| Capture | [extension/src/offscreen/offscreen.ts](extension/src/offscreen/offscreen.ts) | Captures tab audio (interviewer) and, optionally, the mic (you), converts it to 16 kHz PCM in an AudioWorklet ([pcm-worklet.js](extension/public/pcm-worklet.js)), and streams 100 ms chunks over one WebSocket. Each frame is prefixed with one channel byte. If the socket drops, it reconnects with exponential backoff. |
| Orchestration | [backend/app/session.py](backend/app/session.py) | Opens one live transcription session per channel, keeps a rolling transcript, and turns each completed interviewer utterance into a question. A new question cancels any answer that is still streaming. |
| STT | [backend/app/stt.py](backend/app/stt.py) | Gemini Live API (`gemini-3.5-transcribe-live`). Gemini's voice detection decides when a sentence is finished, about 1.3 s after the speaker stops. Sessions reconnect automatically when Google ends them. |
| RAG | [backend/app/rag.py](backend/app/rag.py), [backend/app/parsing.py](backend/app/parsing.py) | Resume and JD are split into sections and bullet chunks, tagged with skills, and embedded into a per-profile Chroma collection. Each question pulls the top resume and JD chunks plus the skills both share. |
| LLM | [backend/app/llm.py](backend/app/llm.py) | Streams a first-person answer from Gemini Flash with thinking off. It uses STAR for behavioral questions and must not invent facts that aren't in the resume. If the main model hasn't started within 2 s or errors, a backup model is asked too, and whichever answers first wins. |
| Overlay | [extension/src/content/](extension/src/content/) | A React app (Vite + CRXJS + Tailwind) mounted in a closed Shadow DOM, only on Meet, Zoom and Teams. It has three draggable windows (react-rnd): a control bar (status, recording dot, mic toggle, End), a transcript strip that scrolls to the newest words, and a resizable answer window with Markdown, copy, history and manual questions. State lives in three Zustand stores (transcription, Q&A, system), so streamed chunks only re-render the window that shows them. |

### Agents

Each interviewer question goes to the **Master Router** ([backend/app/agents/router.py](backend/app/agents/router.py)). It runs three things in parallel: retrieval, the **Listener**, and a speculative general answer that is held back.

| Agent | Job | How |
|---|---|---|
| Listener | Classifies each utterance: intent (new question, follow-up, small talk...), category, and signs of impatience | One fast Gemini call with structured JSON output |
| Answer | Behavioral and concept questions | STAR or bullets grounded in the resume. This is the speculative draft, so the common case stays at about 3 s |
| Technical | Coding questions | Writes a solution, **runs it on test cases in Gemini's code-execution sandbox**, fixes it until the tests pass, then shows the code with a "Verified in sandbox" panel. Python only; other languages are marked "not executed" |
| Design | System design questions | Switches the overlay to a larger diagram layout and draws a **Mermaid architecture diagram** (with zoom), followed by talking points |
| Research | Company news and very recent technology | Google Search grounding, with sources listed. If search isn't available on the key, it answers from model knowledge and says so |
| Coach | Your delivery | Rule-based, using your mic transcript: "Wrap up and ask them a question" after 3 min of talking, "Slow down" above 175 words/min, and an alert when the Listener detects impatience |

If the Listener picks a specialist in time (within `LISTENER_WAIT_MS`), the draft is never shown. If its verdict arrives later, the overlay is told to reset and the specialist takes over.

Gemini's transcription doesn't expose pitch or energy, so the Coach measures pace and talk time from transcript timing.

**Quotas:** the Gemini free tier allows 20 requests per model per day, and each question uses 2-3 calls (Listener, draft, specialist). Google Search grounding isn't included at all. For real interviews, enable billing in Google AI Studio.

### WebSocket protocol

`ws(s)://<host>/ws?profile=<id>&token=<MAYAMI_API_KEY>`

- Client → server: binary `[channel:1 byte][16 kHz mono int16 PCM]` (0 = interviewer, 1 = candidate); text `{"type":"ask","text":...}`, `{"type":"stop"}`
- Server → client: `ready`, `transcript_partial` / `transcript_final {speaker,payload}`, `question {id,payload,agent}`, `answer_chunk {id,payload}`, `answer_reset {id,agent}`, `status {id,payload}`, `ui {id,layout}`, `code_run {id,code,output,ok}`, `sources {id,sources}`, `answer_done {id}`, `coach {key,level,payload,ttl_ms}`, `error {payload}`. The full list is in [backend/app/session.py](backend/app/session.py).

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
cp backend/.env.example backend/.env   # fill in GOOGLE_API_KEY (from aistudio.google.com) and MAYAMI_API_KEY
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

1. Build the extension: `cd extension && npm install && npm run build`. (`npm run dev` rebuilds on every change.)
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select `extension/dist/`.
3. Open the extension's **Options** page. Set the server URL (`ws://localhost:8000`), the API key and a profile ID, then click **Save**.
4. Click **Grant microphone access** once. Chrome only lets the background capture use the mic after this.
5. Upload your resume, paste the job description, and click **Upload to profile**. The page then lists the skills that match the JD and the ones that are missing.
6. In the meeting tab (Meet, Zoom web, Teams web), click the MAYAMI icon and then **Start on this tab**.

## Deploying on AWS

The image is self-contained: the embedding model is baked in at build time, and Chroma data lives in `/data`.

1. Push the image to ECR: `docker build -t mayami ./backend`, then tag it and push.
2. Run it on **ECS Fargate** behind an **Application Load Balancer** (ALBs support WebSockets). Use an HTTPS listener with an ACM certificate, so the extension connects with `wss://`.
3. Raise the ALB **idle timeout** (for example to 300 s). Uvicorn already pings every 20 s.
4. Mount **EFS** at `/data` so profiles survive task restarts. Run one task, or move to a shared vector store (pgvector, OpenSearch) before you scale out.
5. Store `GOOGLE_API_KEY` and `MAYAMI_API_KEY` in Secrets Manager and inject them as task environment variables.

App Runner is not a good fit, because it doesn't support WebSockets.

## Configuration

All settings are environment variables. See [backend/.env.example](backend/.env.example) and [backend/app/config.py](backend/app/config.py). The ones you're most likely to change:

- `LLM_MODEL` / `LLM_FALLBACK_MODEL`: default to `gemini-3-flash-preview` and `gemini-3.5-flash`. They were the most reliable models during testing, when Google's servers were congested.
- `LLM_HEDGE_MS`: how long to wait for the main model before also asking the backup.
- `STT_MODEL`: defaults to `gemini-3.5-transcribe-live`.
- `MIN_QUESTION_WORDS`: interviewer utterances shorter than this ("okay", "great") don't trigger an answer.

A Gemini API key works for both transcription and answers. Google Cloud Speech-to-Text is not used because it doesn't accept API keys.

## Note on recording

MAYAMI transcribes the other people on the call. Some jurisdictions require everyone's consent before a conversation is recorded or transcribed. Check what applies to you before you use it.

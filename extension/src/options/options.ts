import { DEFAULTS, httpBase, loadSettings, type Settings } from "../shared/settings";

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;

interface ProfileSummary {
  profile_id: string;
  documents: number;
  resume_skills: string[];
  matched_competencies: string[];
  missing_competencies: string[];
}

function readForm(): Settings {
  return {
    serverUrl: $("serverUrl").value.trim() || DEFAULTS.serverUrl,
    apiKey: $("apiKey").value.trim(),
    profileId: $("profileId").value.trim() || DEFAULTS.profileId,
    captureMic: $("captureMic").checked,
  };
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const s = readForm();
  const res = await fetch(`${httpBase(s.serverUrl)}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(s.apiKey ? { "X-API-Key": s.apiKey } : {}) },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.detail ?? `HTTP ${res.status}`);
  return body as T;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const chips = (items: string[], cls = "") =>
  `<div class="chips ${cls}">${items.map((s) => `<span>${escapeHtml(s)}</span>`).join("") || "<small>none</small>"}</div>`;

function renderSummary(p: ProfileSummary) {
  $("summary").innerHTML = `
    <h2>Profile "${escapeHtml(p.profile_id)}" &middot; ${p.documents} chunks indexed</h2>
    <label>Competencies matching the JD</label>${chips(p.matched_competencies, "match")}
    <label>JD asks for, not found on resume</label>${chips(p.missing_competencies, "miss")}
    <label>All resume skills</label>${chips(p.resume_skills)}`;
}

async function loadSummary() {
  try {
    renderSummary(await api<ProfileSummary>(`/api/profiles/${encodeURIComponent(readForm().profileId)}`));
  } catch {
    $("summary").innerHTML = "";
  }
}

$("save").addEventListener("click", async () => {
  await chrome.storage.sync.set(readForm());
  $("settingsMsg").textContent = "Saved.";
  loadSummary();
});

$("grantMic").addEventListener("click", async () => {
  // The offscreen document can only use the mic once the extension origin has permission,
  // and the prompt can only be shown from a visible page like this one.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    $("settingsMsg").textContent = "Microphone access granted.";
  } catch (err) {
    $("settingsMsg").textContent = `Microphone denied: ${(err as Error).message}`;
  }
});

$("upload").addEventListener("click", async () => {
  const file = $("resume").files?.[0];
  const jd = $<HTMLTextAreaElement>("jd").value.trim();
  if (!file && !jd) {
    $("uploadMsg").textContent = "Choose a resume and/or paste a job description.";
    return;
  }
  const form = new FormData();
  if (file) form.append("resume", file);
  if (jd) form.append("job_description", jd);
  $("uploadMsg").textContent = "Uploading...";
  try {
    const res = await api<{ profile: ProfileSummary }>(
      `/api/profiles/${encodeURIComponent(readForm().profileId)}/documents`,
      { method: "POST", body: form },
    );
    $("uploadMsg").textContent = "Indexed.";
    renderSummary(res.profile);
  } catch (err) {
    $("uploadMsg").textContent = `Upload failed: ${(err as Error).message}`;
  }
});

const settings = await loadSettings();
$("serverUrl").value = settings.serverUrl;
$("apiKey").value = settings.apiKey;
$("profileId").value = settings.profileId;
$("captureMic").checked = settings.captureMic;
loadSummary();

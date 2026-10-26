import { DEFAULTS, httpBase, loadSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);
const FIELDS = Object.keys(DEFAULTS);

function readForm() {
  return {
    serverUrl: $("serverUrl").value.trim() || DEFAULTS.serverUrl,
    apiKey: $("apiKey").value.trim(),
    profileId: $("profileId").value.trim() || DEFAULTS.profileId,
    captureMic: $("captureMic").checked,
  };
}

async function api(path, init = {}) {
  const s = readForm();
  const res = await fetch(`${httpBase(s.serverUrl)}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(s.apiKey ? { "X-API-Key": s.apiKey } : {}) },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.detail ?? `HTTP ${res.status}`);
  return body;
}

const chips = (items, cls = "") =>
  `<div class="chips ${cls}">${items.map((s) => `<span>${s.replace(/</g, "&lt;")}</span>`).join("") || "<small>none</small>"}</div>`;

function renderSummary(p) {
  $("summary").innerHTML = `
    <h2>Profile "${p.profile_id.replace(/</g, "&lt;")}" &middot; ${p.documents} chunks indexed</h2>
    <label>Competencies matching the JD</label>${chips(p.matched_competencies, "match")}
    <label>JD asks for, not found on resume</label>${chips(p.missing_competencies, "miss")}
    <label>All resume skills</label>${chips(p.resume_skills)}`;
}

async function loadSummary() {
  try {
    renderSummary(await api(`/api/profiles/${encodeURIComponent(readForm().profileId)}`));
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
    $("settingsMsg").textContent = `Microphone denied: ${err.message}`;
  }
});

$("upload").addEventListener("click", async () => {
  const form = new FormData();
  const file = $("resume").files[0];
  if (file) form.append("resume", file);
  if ($("jd").value.trim()) form.append("job_description", $("jd").value);
  if (!file && !$("jd").value.trim()) {
    $("uploadMsg").textContent = "Choose a resume and/or paste a job description.";
    return;
  }
  $("uploadMsg").textContent = "Uploading...";
  try {
    const res = await api(`/api/profiles/${encodeURIComponent(readForm().profileId)}/documents`, {
      method: "POST",
      body: form,
    });
    $("uploadMsg").textContent = "Indexed.";
    renderSummary(res.profile);
  } catch (err) {
    $("uploadMsg").textContent = `Upload failed: ${err.message}`;
  }
});

const settings = await loadSettings();
for (const key of FIELDS) {
  if (typeof DEFAULTS[key] === "boolean") $(key).checked = settings[key];
  else $(key).value = settings[key];
}
loadSummary();

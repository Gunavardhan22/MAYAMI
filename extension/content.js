// Overlay injected into the captured tab. Rendered inside a closed shadow root so page
// styles can't leak in. Receives server events relayed by the service worker.
(() => {
  if (window.__mayamiOverlay) {
    window.__mayamiOverlay.show();
    return;
  }

  const host = document.createElement("div");
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; top: 16px; right: 16px;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        width: 380px; max-height: 70vh; display: flex; flex-direction: column;
        font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
        color: #e8e8ea; background: rgba(20, 20, 24, 0.92);
        border: 1px solid rgba(255,255,255,0.1); border-radius: 12px;
        box-shadow: 0 8px 28px rgba(0,0,0,0.35); backdrop-filter: blur(8px); overflow: hidden;
      }
      header {
        display: flex; align-items: center; gap: 8px; padding: 8px 10px;
        cursor: move; user-select: none; border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      .title { font-weight: 600; letter-spacing: 0.04em; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #888; }
      .dot.live { background: #3ecf8e; } .dot.connecting { background: #f5a524; }
      .dot.error, .dot.closed { background: #f31260; }
      .status { color: #a1a1aa; font-size: 12px; flex: 1; }
      button {
        all: unset; cursor: pointer; color: #a1a1aa; padding: 2px 6px; border-radius: 6px;
      }
      button:hover { background: rgba(255,255,255,0.08); color: #fff; }
      button:disabled { opacity: 0.3; cursor: default; background: none; }
      .body { overflow-y: auto; padding: 10px 12px; }
      .live-line { color: #a1a1aa; font-size: 12px; min-height: 1.4em; margin-bottom: 8px; }
      .question { font-weight: 600; color: #fff; margin-bottom: 6px; }
      .answer p { margin: 0 0 6px; }
      .answer ul { margin: 0 0 6px; padding-left: 18px; }
      .answer strong { color: #7dd3fc; }
      .empty { color: #71717a; }
      .error { color: #fda4af; font-size: 12px; margin-top: 6px; }
      .nav { display: flex; align-items: center; gap: 4px; color: #71717a; font-size: 12px; }
      form { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid rgba(255,255,255,0.08); }
      input {
        all: unset; flex: 1; padding: 5px 8px; border-radius: 6px;
        background: rgba(255,255,255,0.06); color: #e8e8ea;
      }
      .collapsed .body, .collapsed form { display: none; }
    </style>
    <div class="panel">
      <header>
        <span class="dot"></span><span class="title">MAYAMI</span>
        <span class="status">idle</span>
        <span class="nav"><button data-act="prev" title="Previous">&lsaquo;</button><span class="pos"></span><button data-act="next" title="Next">&rsaquo;</button></span>
        <button data-act="min" title="Minimize">&#8211;</button>
        <button data-act="close" title="Hide">&times;</button>
      </header>
      <div class="body">
        <div class="live-line"></div>
        <div class="card"><div class="empty">Listening for the interviewer's next question...</div></div>
        <div class="error" hidden></div>
      </div>
      <form><input placeholder="Type a question to answer manually" /><button type="submit">Ask</button></form>
    </div>`;
  document.documentElement.appendChild(host);

  const $ = (sel) => root.querySelector(sel);
  const panel = $(".panel");
  const answers = []; // {id, question, text, done}
  let viewIndex = -1;
  let errorTimer = null;

  const escapeHtml = (s) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // Minimal markdown: **bold**, "- " bullets, paragraphs.
  function renderMarkdown(text) {
    const html = [];
    let list = false;
    for (const line of text.split("\n")) {
      const fmt = escapeHtml(line).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      const bullet = /^\s*[-*•]\s+(.*)$/.exec(fmt);
      if (bullet) {
        if (!list) html.push("<ul>");
        list = true;
        html.push(`<li>${bullet[1]}</li>`);
        continue;
      }
      if (list) html.push("</ul>");
      list = false;
      if (fmt.trim()) html.push(`<p>${fmt}</p>`);
    }
    if (list) html.push("</ul>");
    return html.join("");
  }

  function render() {
    const a = answers[viewIndex];
    $(".card").innerHTML = a
      ? `<div class="question">${escapeHtml(a.question)}</div><div class="answer">${renderMarkdown(a.text)}</div>`
      : `<div class="empty">Listening for the interviewer's next question...</div>`;
    $(".pos").textContent = answers.length ? `${viewIndex + 1}/${answers.length}` : "";
    $('[data-act="prev"]').disabled = viewIndex <= 0;
    $('[data-act="next"]').disabled = viewIndex >= answers.length - 1;
  }

  function showError(message) {
    const el = $(".error");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => (el.hidden = true), 8000);
  }

  function setStatus(status, detail) {
    $(".dot").className = `dot ${status}`;
    const labels = { live: "listening", connecting: "connecting...", closed: "disconnected", error: "error", stopped: "stopped" };
    $(".status").textContent = labels[status] ?? status;
    if (detail) showError(detail);
  }

  function onEvent(ev) {
    switch (ev.type) {
      case "transcript":
        if (ev.speaker === "interviewer") $(".live-line").textContent = `Interviewer: ${ev.text}`;
        break;
      case "question": {
        const followLatest = viewIndex === answers.length - 1;
        answers.push({ id: ev.id, question: ev.text, text: "", done: false });
        if (answers.length > 20) answers.shift();
        if (followLatest || viewIndex < 0) viewIndex = answers.length - 1;
        render();
        break;
      }
      case "answer_delta": {
        const a = answers.find((x) => x.id === ev.id);
        if (!a) break;
        a.text += ev.text;
        if (answers[viewIndex] === a) render();
        break;
      }
      case "answer_done": {
        const a = answers.find((x) => x.id === ev.id);
        if (a) a.done = true;
        break;
      }
      case "error":
        showError(ev.message);
        break;
    }
  }

  // Drag by header.
  let drag = null;
  $("header").addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const rect = host.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  });
  $("header").addEventListener("pointermove", (e) => {
    if (!drag) return;
    host.style.left = `${Math.max(0, e.clientX - drag.dx)}px`;
    host.style.top = `${Math.max(0, e.clientY - drag.dy)}px`;
    host.style.right = "auto";
  });
  $("header").addEventListener("pointerup", () => (drag = null));

  root.addEventListener("click", (e) => {
    const act = e.target.closest("button")?.dataset.act;
    if (act === "prev" && viewIndex > 0) viewIndex--;
    else if (act === "next" && viewIndex < answers.length - 1) viewIndex++;
    else if (act === "min") panel.classList.toggle("collapsed");
    else if (act === "close") host.style.display = "none";
    else return;
    render();
  });

  $("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("input");
    const text = input.value.trim();
    if (!text) return;
    chrome.runtime.sendMessage({ target: "background", type: "ask", text });
    input.value = "";
  });

  // Keep keystrokes in the overlay from triggering page shortcuts (e.g. mute in Meet).
  ["keydown", "keyup", "keypress"].forEach((t) => root.addEventListener(t, (e) => e.stopPropagation()));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.target !== "overlay") return;
    if (msg.type === "status") setStatus(msg.status, msg.detail);
    else if (msg.type === "event") onEvent(msg.event);
  });

  window.__mayamiOverlay = { show: () => (host.style.display = "") };
  render();
})();

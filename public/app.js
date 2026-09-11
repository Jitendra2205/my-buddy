// My Buddy frontend — vanilla JS SPA modeled on Onyx's app/admin chrome.

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const messagesEl = $("#messages");
const inputEl = $("#input");
const sendBtn = $("#send-btn");

const S = {
  config: null,
  agents: [], sessions: [], docSets: [], documents: [], actions: [],
  agentId: localStorage.getItem("agentId") || "general",
  sessionId: null,
  sources: [],
  streaming: false, deepResearch: false, speak: false,
  adminMode: false,
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}
const apiJson = (path, method, body) =>
  api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ---------------- markdown ----------------
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[(\d{1,2})\](?!\()/g, '<span class="cite" data-n="$1">$1</span>');
}
function renderMd(src) {
  const lines = esc(src).split("\n");
  let html = "", i = 0, para = [];
  const flush = () => { const h = para.length ? `<p>${inlineMd(para.join("<br>"))}</p>` : ""; para = []; return h; };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      html += flush(); const code = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++; html += `<pre><code>${code.join("\n")}</code></pre>`; continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { html += flush(); const lv = Math.min(h[1].length + 1, 5); html += `<h${lv}>${inlineMd(h[2])}</h${lv}>`; i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
      html += flush();
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      html += `<table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join("")}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      html += flush(); const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(`<li>${inlineMd(lines[i++].replace(/^\s*[-*]\s+/, ""))}</li>`);
      html += `<ul>${items.join("")}</ul>`; continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      html += flush(); const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(`<li>${inlineMd(lines[i++].replace(/^\s*\d+\.\s+/, ""))}</li>`);
      html += `<ol>${items.join("")}</ol>`; continue;
    }
    if (/^>\s?/.test(line)) {
      html += flush(); const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""));
      html += `<blockquote>${inlineMd(q.join("<br>"))}</blockquote>`; continue;
    }
    if (!line.trim()) { html += flush(); i++; continue; }
    para.push(line); i++;
  }
  return html + flush();
}

const agentOf = (id) => S.agents.find((a) => a.id === id) || S.agents[0];

// ---------------- chrome: app vs admin ----------------
function setAdminMode(on) {
  S.adminMode = on;
  $("#sidebar-app").classList.toggle("hidden", on);
  $("#sidebar-admin").classList.toggle("hidden", !on);
  $("#brand-title").textContent = on ? "Admin Panel" : "My Buddy";
}
$("#open-admin").onclick = () => { setAdminMode(true); showView("settings"); };
$("#close-admin").onclick = () => { setAdminMode(false); showView("chat"); };

function showView(name) {
  $$(".view").forEach((v) => v.classList.toggle("hidden", v.id !== `view-${name}`));
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  setSidebar(false);
  $("#agent-menu").classList.add("hidden");
  ({
    agents: renderAgentsPage, actions: renderActionsPage, connectors: renderConnectorsPage,
    docsets: renderDocSetsPage, explorer: renderExplorerPage, usage: renderUsagePage,
    settings: renderSettingsPage,
  }[name] || (() => {}))();
}
$$(".nav-btn").forEach((b) => (b.onclick = () => showView(b.dataset.view)));
$$("[data-goto]").forEach((b) => (b.onclick = () => { setAdminMode(true); showView(b.dataset.goto); }));

// ---------------- sidebar: agents / projects / recents ----------------
function renderAgentList() {
  const el = $("#agent-list");
  el.innerHTML = "";
  for (const a of S.agents.slice(0, 6)) {
    const b = document.createElement("button");
    b.className = "side-item" + (a.id === S.agentId && !S.sessionId ? " active" : "");
    b.innerHTML = `<span class="ic">${a.emoji}</span><span class="label">${esc(a.name)}</span>`;
    b.title = a.description || "";
    b.onclick = () => { selectAgent(a.id); showView("chat"); newChat(); };
    el.appendChild(b);
  }
}

function renderProjects() {
  const el = $("#project-list");
  el.innerHTML = "";
  if (!S.docSets.length) {
    el.innerHTML = '<div class="muted small" style="padding:4px 9px">No projects yet.</div>';
    return;
  }
  for (const s of S.docSets) {
    const b = document.createElement("button");
    b.className = "side-item";
    b.innerHTML = `<span class="ic">📁</span><span class="label">${esc(s.name)}</span>`;
    b.title = `${s.docCount} document(s)`;
    b.onclick = () => { showView("explorer"); setTimeout(() => { const sel = $("#explore-set"); if (sel) sel.value = s.id; }, 0); };
    el.appendChild(b);
  }
}

function timeBucket(ts) {
  const d = new Date(ts), now = new Date();
  const day = 24 * 60 * 60 * 1000;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= midnight) return "Today";
  if (ts >= midnight - day) return "Yesterday";
  if (ts >= midnight - 7 * day) return "Previous 7 days";
  if (ts >= midnight - 30 * day) return "Previous 30 days";
  return d.getFullYear() === now.getFullYear() ? d.toLocaleString(undefined, { month: "long" }) : String(d.getFullYear());
}

async function loadSessions(q = "") {
  S.sessions = await api("/api/sessions" + (q ? `?q=${encodeURIComponent(q)}` : ""));
  renderSessions();
}

function renderSessions() {
  const el = $("#session-list");
  el.innerHTML = "";
  if (!S.sessions.length) {
    el.innerHTML = '<div class="muted small" style="padding:4px 9px">No chats yet.</div>';
    return;
  }
  const pinned = S.sessions.filter((s) => s.pinned);
  const rest = S.sessions.filter((s) => !s.pinned);
  const addLabel = (t) => { const d = document.createElement("div"); d.className = "time-label"; d.textContent = t; el.appendChild(d); };

  if (pinned.length) { addLabel("Pinned"); pinned.forEach((s) => el.appendChild(sessionRow(s))); }
  let bucket = null;
  for (const s of rest) {
    const b = timeBucket(s.updatedAt);
    if (b !== bucket) { bucket = b; addLabel(b); }
    el.appendChild(sessionRow(s));
  }
}

function sessionRow(s) {
  const a = agentOf(s.agentId);
  const div = document.createElement("button");
  div.className = "side-item" + (s.id === S.sessionId ? " active" : "");
  div.innerHTML = `<span class="ic">${a ? a.emoji : "💬"}</span><span class="label">${esc(s.title)}</span>`;
  const acts = document.createElement("span");
  acts.className = "acts";
  const pin = document.createElement("button");
  pin.textContent = s.pinned ? "★" : "☆"; pin.title = s.pinned ? "Unpin" : "Pin";
  pin.onclick = async (e) => { e.stopPropagation(); await apiJson(`/api/sessions/${s.id}`, "PUT", { pinned: !s.pinned }); loadSessions($("#session-search").value); };
  const ren = document.createElement("button");
  ren.textContent = "✎"; ren.title = "Rename";
  ren.onclick = async (e) => {
    e.stopPropagation();
    const t = prompt("Rename chat", s.title);
    if (!t) return;
    await apiJson(`/api/sessions/${s.id}`, "PUT", { title: t });
    loadSessions($("#session-search").value);
  };
  const del = document.createElement("button");
  del.textContent = "✕"; del.title = "Delete";
  del.onclick = async (e) => {
    e.stopPropagation();
    await api(`/api/sessions/${s.id}`, { method: "DELETE" });
    if (S.sessionId === s.id) newChat();
    loadSessions($("#session-search").value);
  };
  acts.append(pin, ren, del);
  div.appendChild(acts);
  div.onclick = () => openSession(s.id);
  return div;
}

$("#search-toggle").onclick = () => {
  const w = $("#side-search-wrap");
  w.classList.toggle("hidden");
  if (!w.classList.contains("hidden")) $("#session-search").focus();
  else { $("#session-search").value = ""; loadSessions(); }
};
$("#session-search").oninput = (e) => loadSessions(e.target.value.trim());
$("#quick-new-agent").onclick = () => { setAdminMode(true); showView("agents"); openAgentDialog(null); };
$("#quick-new-project").onclick = () => addDocSet();

// ---------------- agent chip + menu ----------------
function selectAgent(id) {
  S.agentId = id;
  localStorage.setItem("agentId", id);
  renderAgentChip();
  renderAgentTools();
  renderAgentList();
}

function renderAgentChip() {
  const a = agentOf(S.agentId);
  $("#agent-chip").innerHTML = `<span>${a.emoji}</span><span>${esc(a.name)}</span><span class="muted">▾</span>`;
}

$("#agent-chip").onclick = (e) => {
  e.stopPropagation();
  const menu = $("#agent-menu");
  menu.innerHTML = "";
  for (const a of S.agents) {
    const b = document.createElement("button");
    b.innerHTML = `<span>${a.emoji}</span><span><strong>${esc(a.name)}</strong><span class="d">${esc(a.description || "")}</span></span>`;
    b.onclick = () => { selectAgent(a.id); menu.classList.add("hidden"); if (!S.sessionId) showEmpty(); };
    menu.appendChild(b);
  }
  const explore = document.createElement("button");
  explore.innerHTML = `<span>🤖</span><span><strong>Explore agents</strong><span class="d">Create or edit agents</span></span>`;
  explore.onclick = () => { menu.classList.add("hidden"); setAdminMode(true); showView("agents"); };
  menu.appendChild(explore);
  menu.classList.toggle("hidden");
};
document.addEventListener("click", (e) => {
  if (!e.target.closest("#agent-menu") && !e.target.closest("#agent-chip")) $("#agent-menu").classList.add("hidden");
});

function renderAgentTools() {
  const a = agentOf(S.agentId), t = a.tools || {}, on = [];
  if (t.knowledge) on.push("📚");
  if (t.webSearch) on.push("🌐");
  if (t.codeInterpreter) on.push("🐍");
  if (t.imageGen) on.push("🖼️");
  if ((a.actionIds || []).length) on.push("⚡");
  $("#agent-tools").textContent = on.join(" ");
  $("#agent-tools").title = "Enabled tools";
}

// ---------------- chat ----------------
function showEmpty() {
  const a = agentOf(S.agentId);
  messagesEl.innerHTML = `<div id="empty-state">
      <div class="empty-emoji">${a.emoji}</div>
      <h2>${esc(a.name)}</h2>
      <p class="muted">${esc(a.description || "Ask anything.")}</p>
      <div id="starters"></div>
    </div>`;
  const el = $("#starters");
  for (const s of a.starters || []) {
    const b = document.createElement("button");
    b.className = "starter"; b.textContent = s;
    b.onclick = () => { inputEl.value = s; autosize(); send(); };
    el.appendChild(b);
  }
}

function newChat() {
  S.sessionId = null; S.sources = [];
  renderSourcesPanel(); showEmpty(); renderSessions(); renderAgentList();
  inputEl.focus();
}
$("#new-chat-btn").onclick = () => { setAdminMode(false); showView("chat"); newChat(); };

function addMessage(role, text, agent) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  const who = role === "user" ? "You" : `${agent?.emoji || "🤝"} ${agent?.name || "Buddy"}`;
  div.innerHTML = `<div class="who">${esc(who)}</div><div class="bubble"></div>`;
  const bubble = div.querySelector(".bubble");
  if (role === "user") bubble.textContent = text;
  else bubble.innerHTML = renderMd(text || "");
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function addArtifactCards(container, artifacts) {
  for (const a of artifacts || []) {
    const card = document.createElement("div");
    card.className = "artifact-card";
    card.innerHTML = `<span>📄</span><span>${esc(a.name)}</span><span class="muted small">${(a.size / 1024).toFixed(1)} KB</span>
      <a class="ghost-btn" href="/api/artifacts/${a.id}" download>Download</a>`;
    container.appendChild(card);
  }
}

async function openSession(id) {
  setAdminMode(false);
  showView("chat");
  const s = await api(`/api/sessions/${id}`);
  S.sessionId = id; S.sources = [];
  selectAgent(s.agentId);
  renderSessions();
  messagesEl.innerHTML = "";
  const agent = agentOf(s.agentId);
  for (const m of s.messages) {
    const div = addMessage(m.role, m.text, agent);
    if (m.role === "assistant") {
      if (m.sources?.length) S.sources.push(...m.sources);
      addArtifactCards(div, m.artifacts);
    }
  }
  if (!s.messages.length) showEmpty();
  renderSourcesPanel();
  inputEl.focus();
}

async function ensureSession() {
  if (S.sessionId) return S.sessionId;
  const s = await apiJson("/api/sessions", "POST", { agentId: S.agentId });
  S.sessionId = s.id;
  await loadSessions($("#session-search").value);
  return s.id;
}

function renderSourcesPanel() {
  const body = $("#sources-body");
  if (!S.sources.length) {
    body.innerHTML = '<p class="muted small">Citations and generated files from this chat will appear here.</p>';
    return;
  }
  body.innerHTML = S.sources.map((s) => {
    const icon = s.kind === "web" ? "🌐" : s.kind === "action" ? "⚡" : "📄";
    const title = esc(s.title || "Source");
    const head = s.url
      ? `<a class="src-title" href="${esc(s.url)}" target="_blank" rel="noopener">${title}</a>`
      : `<span class="src-title">${title}</span>`;
    // Only show the destination separately when it adds something the title didn't.
    const label = s.url ? linkLabel(s) : "";
    const sub = label && label !== (s.title || "") ? `<div class="src-url">${esc(label)}</div>` : "";
    return `<div class="source-item" id="src-${s.n}">
      <div><span class="src-n">[${s.n}]</span>${icon} ${head}</div>
      ${sub}
      ${s.snippet && s.snippet !== s.title ? `<div class="snip">${esc(s.snippet.slice(0, 200))}</div>` : ""}
    </div>`;
  }).join("");
}

// Search grounding hands back long redirect URLs; show where the link goes,
// not the tracking string.
function linkLabel(s) {
  if (s.display) return s.display;
  try {
    const u = new URL(s.url);
    const path = u.pathname.replace(/\/$/, "");
    const label = u.hostname.replace(/^www\./, "") + path;
    return label.length > 64 ? label.slice(0, 61) + "…" : label;
  } catch {
    return s.url.length > 64 ? s.url.slice(0, 61) + "…" : s.url;
  }
}
$("#sources-toggle").onclick = () => $("#sources-panel").classList.toggle("open");
$("#sources-close").onclick = () => $("#sources-panel").classList.remove("open");
messagesEl.addEventListener("click", (e) => {
  const cite = e.target.closest(".cite");
  if (!cite) return;
  $("#sources-panel").classList.add("open");
  const el = document.getElementById(`src-${cite.dataset.n}`);
  if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.style.borderColor = "var(--border-02)"; setTimeout(() => (el.style.borderColor = ""), 1500); }
});

async function send() {
  const text = inputEl.value.trim();
  if (!text || S.streaming) return;
  S.streaming = true; sendBtn.disabled = true;
  inputEl.value = ""; autosize();
  $("#empty-state")?.remove();

  const agent = agentOf(S.agentId);
  addMessage("user", text, agent);
  const wrap = addMessage("assistant", "", agent);
  const bubble = wrap.querySelector(".bubble");
  const trace = document.createElement("div");
  trace.className = "trace";
  bubble.before(trace);

  let thinkingBox = null, acc = "", activeTrace = null;
  const phaseTraces = {};
  const addTrace = (label) => {
    const item = document.createElement("div");
    item.className = "trace-item";
    item.innerHTML = `<span class="spinner"></span><span>${esc(label)}</span>`;
    trace.appendChild(item);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return item;
  };
  const completeTrace = (item, label) => {
    if (!item) return;
    item.className = "trace-item done";
    item.innerHTML = `<span>✓</span><span>${esc(label)}</span>`;
  };

  try {
    const sessionId = await ensureSession();
    const res = await fetch(`/api/sessions/${sessionId}/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, deepResearch: S.deepResearch }),
    });
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt; try { evt = JSON.parse(line); } catch { continue; }

        if (evt.type === "thinking") {
          if (!thinkingBox) {
            thinkingBox = document.createElement("details");
            thinkingBox.className = "thinking-box";
            thinkingBox.innerHTML = `<summary>💭 Thinking…</summary><div class="think-text"></div>`;
            bubble.before(thinkingBox);
          }
          thinkingBox.querySelector(".think-text").textContent += evt.text;
        } else if (evt.type === "tool" || evt.type === "phase") {
          const label = evt.label || evt.name;
          const item = addTrace(label);
          if (evt.type === "phase" && evt.index !== undefined) phaseTraces[evt.index] = { item, label };
          else activeTrace = { item, label };
        } else if (evt.type === "tool_done") {
          if (activeTrace) { completeTrace(activeTrace.item, activeTrace.label); activeTrace = null; }
        } else if (evt.type === "phase_done") {
          const p = phaseTraces[evt.index];
          if (p) completeTrace(p.item, `${p.label} — ${evt.sourceCount} source(s)`);
        } else if (evt.type === "plan") {
          const planBox = document.createElement("div");
          planBox.className = "plan-box";
          planBox.innerHTML = `<strong>Research plan</strong><ol>${evt.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ol>`;
          trace.after(planBox);
        } else if (evt.type === "sources") {
          S.sources.push(...evt.sources); renderSourcesPanel();
        } else if (evt.type === "artifact") {
          addArtifactCards(wrap, [evt]);
        } else if (evt.type === "text") {
          acc += evt.text;
          bubble.innerHTML = renderMd(acc);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        } else if (evt.type === "replace_text") {
          // Gemini reports web grounding only once the turn ends, so the final
          // text arrives with [n] markers spliced in. Re-render over the stream.
          acc = evt.text;
          bubble.innerHTML = renderMd(acc);
        } else if (evt.type === "error") {
          bubble.innerHTML = `<div class="error-line">${esc(evt.error)}</div>`;
        } else if (evt.type === "done") {
          trace.querySelectorAll(".trace-item").forEach((t) => { if (t.querySelector(".spinner")) t.remove(); });
          if (thinkingBox) thinkingBox.querySelector("summary").textContent = "💭 Thoughts";
          if (evt.usage) {
            const u = document.createElement("div");
            u.className = "muted small"; u.style.marginTop = "8px";
            u.textContent = `${evt.usage.input.toLocaleString()} in · ${evt.usage.output.toLocaleString()} out tokens`;
            wrap.appendChild(u);
          }
          if (S.speak && acc) speak(acc);
        }
      }
    }
    await loadSessions($("#session-search").value);
  } catch (err) {
    bubble.innerHTML = `<div class="error-line">${esc(err.message)}</div>`;
    trace.querySelectorAll(".trace-item").forEach((t) => { if (t.querySelector(".spinner")) t.remove(); });
    // The server drops a session whose first message failed; resync so an
    // empty "New chat" doesn't linger in Recents.
    await loadSessions($("#session-search").value);
    if (S.sessionId && !S.sessions.some((s) => s.id === S.sessionId)) S.sessionId = null;
  }
  S.streaming = false; sendBtn.disabled = false; inputEl.focus();
}

sendBtn.onclick = send;
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
function autosize() { inputEl.style.height = "auto"; inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + "px"; }
inputEl.addEventListener("input", autosize);

// ---------------- composer chips ----------------
$("#chip-research").onclick = () => {
  S.deepResearch = !S.deepResearch;
  $("#chip-research").classList.toggle("on", S.deepResearch);
};
let recog = null;
$("#chip-voice").onclick = () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return alert("Speech recognition isn't available in this browser.");
  if (recog) { recog.stop(); recog = null; $("#chip-voice").classList.remove("on"); return; }
  recog = new SR();
  recog.continuous = true; recog.interimResults = true;
  const base = inputEl.value;
  recog.onresult = (e) => {
    let txt = "";
    for (let i = e.resultIndex; i < e.results.length; i++) txt += e.results[i][0].transcript;
    inputEl.value = (base ? base + " " : "") + txt; autosize();
  };
  recog.onend = () => { recog = null; $("#chip-voice").classList.remove("on"); };
  recog.start();
  $("#chip-voice").classList.add("on");
};
function speak(text) {
  if (!window.speechSynthesis) return;
  const plain = text.replace(/```[\s\S]*?```/g, " code block ").replace(/[#*`>|_-]/g, " ").slice(0, 4000);
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(plain));
}
$("#chip-speak").onclick = () => {
  S.speak = !S.speak;
  $("#chip-speak").classList.toggle("on", S.speak);
  if (!S.speak && window.speechSynthesis) speechSynthesis.cancel();
};

// ---------------- attach ----------------
$("#attach-btn").onclick = () => $("#file-input").click();
$("#file-input").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) return alert("File too large (max 5 MB)");
  try {
    const text = await file.text();
    const r = await fetch(`/api/documents/file?name=${encodeURIComponent(file.name)}`, {
      method: "POST", headers: { "Content-Type": "text/plain" }, body: text,
    });
    if (!r.ok) throw new Error((await r.json()).error);
    const doc = await r.json();
    $("#empty-state")?.remove();
    const note = document.createElement("div");
    note.className = "msg";
    note.innerHTML = `<div class="artifact-card">📚 <span>Indexed <strong>${esc(doc.name)}</strong> (${doc.chunkCount} chunks). Agents with Knowledge can now search it.</span></div>`;
    messagesEl.appendChild(note);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    S.documents = await api("/api/documents");
  } catch (err) { alert("Upload failed: " + err.message); }
};

// ---------------- Agents page ----------------
function renderAgentsPage() {
  const el = $("#agents-page");
  el.innerHTML = '<p class="page-intro">Agents bundle instructions, tools, and knowledge scope. Pick one in chat from the agent selector.</p>';
  for (const a of S.agents) {
    const t = a.tools || {};
    const tags = [t.knowledge && "📚 Knowledge", t.webSearch && "🌐 Web search", t.codeInterpreter && "🐍 Code interpreter", t.imageGen && "🖼️ Charts & images"].filter(Boolean);
    const sets = (a.docSetIds || []).map((id) => S.docSets.find((s) => s.id === id)?.name).filter(Boolean);
    const acts = (a.actionIds || []).map((id) => S.actions.find((x) => x.id === id)?.name).filter(Boolean);
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="card-head"><span style="font-size:1.2rem">${a.emoji}</span><strong>${esc(a.name)}</strong>
        ${a.builtin ? '<span class="tag" style="margin:0">built-in</span>' : ""}<span class="spacer"></span></div>
      <div class="meta">${esc(a.description || "")}</div>
      <div>${tags.map((x) => `<span class="tag">${x}</span>`).join("")}
        ${sets.map((s) => `<span class="tag">📁 ${esc(s)}</span>`).join("")}
        ${acts.map((s) => `<span class="tag">⚡ ${esc(s)}</span>`).join("")}</div>`;
    const head = card.querySelector(".card-head");
    const use = document.createElement("button");
    use.className = "ghost-btn"; use.textContent = "Chat";
    use.onclick = () => { selectAgent(a.id); setAdminMode(false); showView("chat"); newChat(); };
    const edit = document.createElement("button");
    edit.className = "ghost-btn"; edit.textContent = "Edit";
    edit.onclick = () => openAgentDialog(a);
    head.append(use, edit);
    if (!a.builtin) {
      const del = document.createElement("button");
      del.className = "danger-btn"; del.textContent = "Delete";
      del.onclick = async () => {
        if (!confirm(`Delete agent "${a.name}"?`)) return;
        await api(`/api/agents/${a.id}`, { method: "DELETE" });
        S.agents = await api("/api/agents");
        if (S.agentId === a.id) selectAgent(S.agents[0].id);
        renderAgentsPage(); renderAgentList();
      };
      head.appendChild(del);
    }
    el.appendChild(card);
  }
}

function openAgentDialog(agent) {
  const form = $("#agent-form");
  form.reset();
  $("#agent-form-title").textContent = agent ? `Edit ${agent.name}` : "New agent";
  form.dataset.id = agent?.id || "";
  form.emoji.value = agent?.emoji || "🧩";
  form.name.value = agent?.name || "";
  form.description.value = agent?.description || "";
  form.system.value = agent?.system || "";
  form.starters.value = (agent?.starters || []).join("\n");
  const t = agent?.tools || { knowledge: true };
  form.knowledge.checked = t.knowledge !== false;
  form.webSearch.checked = !!t.webSearch;
  form.codeInterpreter.checked = !!t.codeInterpreter;
  form.imageGen.checked = !!t.imageGen;

  const setBox = $("#agent-docsets");
  setBox.innerHTML = "<legend>Document sets (empty = all documents)</legend>";
  if (!S.docSets.length) setBox.innerHTML += '<div class="muted small">No document sets yet.</div>';
  for (const s of S.docSets) {
    const l = document.createElement("label");
    l.className = "check";
    l.innerHTML = `<input type="checkbox" value="${s.id}" ${(agent?.docSetIds || []).includes(s.id) ? "checked" : ""}/> ${esc(s.name)}`;
    setBox.appendChild(l);
  }
  const actBox = $("#agent-actions");
  actBox.innerHTML = "<legend>Actions</legend>";
  if (!S.actions.length) actBox.innerHTML += '<div class="muted small">No actions defined yet.</div>';
  for (const a of S.actions) {
    const l = document.createElement("label");
    l.className = "check";
    l.innerHTML = `<input type="checkbox" value="${a.id}" ${(agent?.actionIds || []).includes(a.id) ? "checked" : ""}/> ${esc(a.name)}`;
    actBox.appendChild(l);
  }
  $("#agent-dialog").showModal();
}
$("#add-agent").onclick = () => openAgentDialog(null);
$("#agent-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value === "cancel") return;
  const form = e.target;
  const body = {
    emoji: form.emoji.value, name: form.name.value,
    description: form.description.value, system: form.system.value,
    starters: form.starters.value.split("\n").map((s) => s.trim()).filter(Boolean),
    tools: {
      knowledge: form.knowledge.checked, webSearch: form.webSearch.checked,
      codeInterpreter: form.codeInterpreter.checked, imageGen: form.imageGen.checked,
    },
    docSetIds: [...$("#agent-docsets").querySelectorAll("input:checked")].map((i) => i.value),
    actionIds: [...$("#agent-actions").querySelectorAll("input:checked")].map((i) => i.value),
  };
  const id = form.dataset.id;
  if (id) await apiJson(`/api/agents/${id}`, "PUT", body);
  else await apiJson("/api/agents", "POST", body);
  S.agents = await api("/api/agents");
  renderAgentsPage(); renderAgentList(); renderAgentChip(); renderAgentTools();
});

// ---------------- Actions page ----------------
function renderActionsPage() {
  const el = $("#actions-page");
  el.innerHTML = '<p class="page-intro">Actions give agents a callable HTTP API — the equivalent of Onyx\'s OpenAPI &amp; MCP actions. Enable one on an agent from the Agents page.</p>';
  if (!S.actions.length) {
    el.innerHTML += '<div class="empty-note">No actions yet. Create one to let an agent call an external API.</div>';
    return;
  }
  for (const a of S.actions) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="card-head"><strong>⚡ ${esc(a.name)}</strong><span class="tag" style="margin:0">${a.method}</span><span class="spacer"></span></div>
      <div class="meta">${esc(a.description || "")}</div><div class="meta"><code>${esc(a.url)}</code></div>`;
    const del = document.createElement("button");
    del.className = "danger-btn"; del.textContent = "Delete";
    del.onclick = async () => {
      if (!confirm(`Delete action "${a.name}"?`)) return;
      await api(`/api/actions/${a.id}`, { method: "DELETE" });
      S.actions = await api("/api/actions"); S.agents = await api("/api/agents");
      renderActionsPage();
    };
    card.querySelector(".card-head").appendChild(del);
    el.appendChild(card);
  }
}
$("#add-action").onclick = () => $("#action-dialog").showModal();
$("#action-form").addEventListener("submit", async (e) => {
  if (e.submitter?.value === "cancel") return;
  const f = e.target;
  let headers = {};
  try { headers = f.headers.value.trim() ? JSON.parse(f.headers.value) : {}; } catch { return alert("Headers must be valid JSON"); }
  try { JSON.parse(f.inputSchema.value); } catch { return alert("Input schema must be valid JSON"); }
  try {
    await apiJson("/api/actions", "POST", {
      name: f.name.value.trim(), description: f.description.value,
      method: f.method.value, url: f.url.value.trim(), headers, inputSchema: f.inputSchema.value,
    });
    S.actions = await api("/api/actions");
    renderActionsPage(); f.reset();
  } catch (err) { alert(err.message); }
});

// ---------------- Connectors ----------------
function renderConnectorsPage() {
  const el = $("#connectors-page");
  const opts = ['<option value="">— no project —</option>', ...S.docSets.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`)].join("");
  el.innerHTML = `
    <p class="page-intro">Connectors pull content into your local knowledge index. Agents with the Knowledge tool search it with BM25 retrieval and cite what they use.</p>
    <h3 class="section-title">Add a connector</h3>
    <div class="card"><strong>🌐 Web page</strong><div class="meta">Fetch a URL and index its readable text.</div>
      <div class="form-row" style="margin-top:10px">
        <input class="grow" id="web-url" placeholder="https://example.com/article" />
        <select id="web-set">${opts}</select>
        <button class="primary-btn" id="web-add">Index page</button>
      </div></div>
    <div class="card"><strong>📄 File upload</strong><div class="meta">Text formats: txt, md, csv, json, code.</div>
      <div class="form-row" style="margin-top:10px">
        <input type="file" id="conn-file" accept=".txt,.md,.csv,.json,.js,.ts,.py,.html,.css,.log,.xml,.yaml,.yml,.tsv" />
        <select id="file-set">${opts}</select>
      </div></div>
    <div class="card"><strong>📝 Paste text</strong>
      <div class="form-row" style="margin-top:10px">
        <input class="grow" id="paste-name" placeholder="Title" /><select id="paste-set">${opts}</select>
      </div>
      <textarea id="paste-text" rows="4" style="width:100%;border:1px solid var(--border-01);border-radius:var(--r-08);padding:9px;background:var(--bg);color:var(--text-05)" placeholder="Paste notes here…"></textarea>
      <div class="form-row" style="margin-top:8px"><button class="primary-btn" id="paste-add">Index text</button></div></div>
    <h3 class="section-title">Indexed documents (${S.documents.length})</h3>
    <div id="doc-list"></div>`;

  $("#web-add").onclick = async () => {
    const url = $("#web-url").value.trim();
    if (!url) return;
    const btn = $("#web-add"); btn.disabled = true; btn.textContent = "Fetching…";
    try {
      const doc = await apiJson("/api/documents/web", "POST", { url, docSetId: $("#web-set").value || null });
      S.documents = await api("/api/documents");
      S.docSets = await api("/api/docsets");
      renderConnectorsPage(); renderProjects();
      alert(`Indexed "${doc.name}" (${doc.chunkCount} chunks)`);
    } catch (err) { alert(err.message); const b = $("#web-add"); if (b) { b.disabled = false; b.textContent = "Index page"; } }
  };
  $("#conn-file").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const setId = $("#file-set").value;
      const r = await fetch(`/api/documents/file?name=${encodeURIComponent(file.name)}${setId ? `&docSetId=${setId}` : ""}`, {
        method: "POST", headers: { "Content-Type": "text/plain" }, body: text,
      });
      if (!r.ok) throw new Error((await r.json()).error);
      S.documents = await api("/api/documents"); S.docSets = await api("/api/docsets");
      renderConnectorsPage(); renderProjects();
    } catch (err) { alert(err.message); }
  };
  $("#paste-add").onclick = async () => {
    const text = $("#paste-text").value.trim();
    if (!text) return;
    try {
      await apiJson("/api/documents/text", "POST", {
        name: $("#paste-name").value.trim() || "Pasted note", text, docSetId: $("#paste-set").value || null,
      });
      S.documents = await api("/api/documents"); S.docSets = await api("/api/docsets");
      renderConnectorsPage(); renderProjects();
    } catch (err) { alert(err.message); }
  };

  const list = $("#doc-list");
  if (!S.documents.length) {
    list.innerHTML = '<div class="empty-note">Nothing indexed yet. Add a web page, upload a file, or paste text above.</div>';
    return;
  }
  for (const d of S.documents) {
    const card = document.createElement("div");
    card.className = "card";
    const sets = (d.docSetIds || []).map((id) => S.docSets.find((s) => s.id === id)?.name).filter(Boolean);
    card.innerHTML = `<div class="card-head"><strong>${d.source === "web" ? "🌐" : "📄"} ${esc(d.name)}</strong><span class="spacer"></span></div>
      <div class="meta">${d.chunkCount} chunks · ${(d.charCount / 1000).toFixed(1)}k chars · ${new Date(d.createdAt).toLocaleDateString()}
      ${d.url ? ` · <a href="${esc(d.url)}" target="_blank" rel="noopener">source</a>` : ""}</div>
      <div>${sets.map((s) => `<span class="tag">📁 ${esc(s)}</span>`).join("")}</div>`;
    const del = document.createElement("button");
    del.className = "danger-btn"; del.textContent = "Delete";
    del.onclick = async () => {
      await api(`/api/documents/${d.id}`, { method: "DELETE" });
      S.documents = await api("/api/documents"); S.docSets = await api("/api/docsets");
      renderConnectorsPage(); renderProjects();
    };
    card.querySelector(".card-head").appendChild(del);
    list.appendChild(card);
  }
}

// ---------------- Document sets / Projects ----------------
async function addDocSet() {
  const name = prompt("Project / document set name");
  if (!name) return;
  await apiJson("/api/docsets", "POST", { name });
  S.docSets = await api("/api/docsets");
  renderProjects();
  if (!$("#view-docsets").classList.contains("hidden")) renderDocSetsPage();
}
$("#add-docset").onclick = addDocSet;

function renderDocSetsPage() {
  const el = $("#docsets-page");
  el.innerHTML = '<p class="page-intro">Group documents into sets (shown as Projects in the sidebar), then scope an agent to specific sets so it only searches what\'s relevant.</p>';
  if (!S.docSets.length) el.innerHTML += '<div class="empty-note">No document sets yet.</div>';
  for (const s of S.docSets) {
    const docs = S.documents.filter((d) => (d.docSetIds || []).includes(s.id));
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="card-head"><strong>📁 ${esc(s.name)}</strong><span class="tag" style="margin:0">${docs.length} document(s)</span><span class="spacer"></span></div>
      <div class="meta">${esc(s.description || "")}</div>
      <div>${docs.map((d) => `<span class="tag">${esc(d.name)}</span>`).join("")}</div>`;
    const del = document.createElement("button");
    del.className = "danger-btn"; del.textContent = "Delete";
    del.onclick = async () => {
      if (!confirm(`Delete "${s.name}"? Documents are kept.`)) return;
      await api(`/api/docsets/${s.id}`, { method: "DELETE" });
      S.docSets = await api("/api/docsets"); S.documents = await api("/api/documents");
      renderDocSetsPage(); renderProjects();
    };
    card.querySelector(".card-head").appendChild(del);
    el.appendChild(card);
  }
}

// ---------------- Explorer ----------------
function renderExplorerPage() {
  const el = $("#explorer-page");
  el.innerHTML = `<p class="page-intro">Query the retrieval index directly — the same BM25 search your agents use.</p>
    <div class="form-row">
      <input class="grow" id="explore-q" placeholder="Search your documents…" />
      <select id="explore-set"><option value="">All projects</option>${S.docSets.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select>
      <button class="primary-btn" id="explore-go">Search</button>
    </div><div id="explore-results"></div>`;
  const run = async () => {
    const q = $("#explore-q").value.trim();
    if (!q) return;
    const setId = $("#explore-set").value;
    const results = await api(`/api/search?q=${encodeURIComponent(q)}${setId ? `&docSetId=${setId}` : ""}`);
    const out = $("#explore-results");
    out.innerHTML = results.length
      ? results.map((r) => `<div class="card"><div class="card-head"><strong>${r.source === "web" ? "🌐" : "📄"} ${esc(r.docName)}</strong>
          <span class="tag" style="margin:0">score ${r.score}</span></div>
          <div class="meta" style="white-space:pre-wrap">${esc(r.text.slice(0, 600))}${r.text.length > 600 ? "…" : ""}</div></div>`).join("")
      : '<div class="empty-note">No matches.</div>';
  };
  $("#explore-go").onclick = run;
  $("#explore-q").addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
}

// ---------------- Usage ----------------
async function renderUsagePage() {
  const el = $("#usage-page");
  const u = await api("/api/usage");
  const max = Math.max(1, ...u.byDay.map((d) => d.input + d.output));
  el.innerHTML = `
    <p class="page-intro">Token consumption across all agents and sessions in the last 30 days.</p>
    <div class="stat-grid">
      <div class="stat"><div class="n">${u.totals.calls}</div><div class="l">Model calls</div></div>
      <div class="stat"><div class="n">${u.totals.input.toLocaleString()}</div><div class="l">Input tokens</div></div>
      <div class="stat"><div class="n">${u.totals.output.toLocaleString()}</div><div class="l">Output tokens</div></div>
      <div class="stat"><div class="n">$${u.totals.estimatedCost.toFixed(2)}</div><div class="l">Est. cost (list price)</div></div>
    </div>
    <h3 class="section-title">Daily tokens</h3>
    ${u.byDay.length ? u.byDay.map((d) => `<div class="bar-row"><span class="d">${d.date}</span>
        <span class="bar" style="width:${Math.round(((d.input + d.output) / max) * 220)}px"></span>
        <span class="muted">${(d.input + d.output).toLocaleString()}</span></div>`).join("")
      : '<div class="empty-note">No usage recorded yet.</div>'}`;
}

// ---------------- Settings ----------------
async function renderSettingsPage() {
  const el = $("#settings-page");
  const s = S.config.settings;
  const list = S.config.providers || [];
  const active = list.find((p) => p.id === s.provider) || list[0] || {};
  const configured = list.filter((p) => p.hasKey);

  const toggle = (key, label, desc) => `
    <div class="setting-row"><div><div class="label">${label}</div><div class="desc">${desc}</div></div>
      <button class="switch ${s[key] ? "on" : ""}" data-key="${key}"></button></div>`;

  const providerRow = list
    .map((p) => `<option value="${p.id}" ${s.provider === p.id ? "selected" : ""}>${esc(p.label)}${p.hasKey ? "" : " (no key)"}</option>`)
    .join("");

  const keyStatus = list
    .map((p) => `<code>${p.keyName}</code> ${p.hasKey ? "✓ configured" : "— not set"}`)
    .join(" · ");

  el.innerHTML = `
    <p class="page-intro">Global model and tool configuration. Per-agent tool switches live on each agent.</p>

    <h3 class="section-title">Model</h3>
    <div class="setting-row"><div><div class="label">Provider</div><div class="desc">Which API answers your messages. A provider needs its key in <code>.env</code> before it can be selected.</div></div>
      <select id="set-provider">${providerRow}</select></div>
    <div class="setting-row"><div><div class="label">Model</div><div class="desc">Fetched live from ${esc(active.label || "the provider")}. Each provider remembers its own choice.</div></div>
      <select id="set-model"><option>${esc(s.model || "")}</option></select></div>
    <div class="setting-row"><div><div class="label">Effort</div><div class="desc">How hard the model works before answering. Higher costs more and takes longer.</div></div>
      <select id="set-effort">${["low", "medium", "high", "xhigh", "max"].map((m) => `<option ${s.effort === m ? "selected" : ""}>${m}</option>`).join("")}</select></div>
    ${toggle("thinking", "Extended thinking", "Let the model reason before answering.")}
    ${toggle("showThinking", "Show thinking", "Display a summary of the model's reasoning in chat.")}

    <h3 class="section-title">Tools</h3>
    ${toggle("webSearchEnabled", "Web search", "Allow agents to search the web and cite pages.")}
    ${toggle("codeInterpreterEnabled", "Code interpreter", "Run Python in a sandbox for real computation.")}
    ${toggle("imageGenEnabled", "Charts & images", "Generate downloadable charts and images via code execution.")}
    ${toggle("knowledgeEnabled", "Knowledge retrieval", "Search your indexed documents with citations.")}
    ${toggle("voiceEnabled", "Voice", "Dictation and read-aloud in the composer.")}

    <h3 class="section-title">System</h3>
    <div class="setting-row"><div><div class="label">Storage</div><div class="desc">Everything lives in plain JSON under <code>data/</code>. No database, no cloud sync.</div></div></div>
    <div class="setting-row"><div><div class="label">API keys</div><div class="desc">${keyStatus}<br />Keys are read from <code>.env</code> on the server and never sent to the browser.</div></div>
      <span class="tag">${configured.length} configured</span></div>`;

  el.querySelectorAll(".switch").forEach((btn) => {
    btn.onclick = async () => {
      const key = btn.dataset.key, next = !S.config.settings[key];
      S.config.settings[key] = next;
      btn.classList.toggle("on", next);
      await apiJson("/api/settings", "PUT", { [key]: next });
    };
  });

  $("#set-provider").onchange = async (e) => {
    S.config.settings = await apiJson("/api/settings", "PUT", { provider: e.target.value });
    await refreshConfig();
    renderSettingsPage();
  };
  $("#set-effort").onchange = async (e) => {
    S.config.settings.effort = e.target.value;
    await apiJson("/api/settings", "PUT", { effort: e.target.value });
  };

  // The catalogue moves faster than any list we could hard-code, so ask the
  // provider what it actually offers.
  const sel = $("#set-model");
  sel.onchange = async (e) => {
    S.config.settings.model = e.target.value;
    await apiJson("/api/settings", "PUT", { model: e.target.value });
    renderProviderBadge();
  };
  try {
    const { models } = await api(`/api/models?provider=${encodeURIComponent(s.provider)}`);
    const options = models.includes(s.model) ? models : [s.model, ...models];
    sel.innerHTML = options
      .map((m) => `<option ${m === s.model ? "selected" : ""}>${esc(m)}</option>`)
      .join("");
  } catch {
    // Keep the single current-model option already rendered.
  }
}

// Small "who is answering" indicator in the sidebar foot.
function renderProviderBadge() {
  const el = $("#provider-badge");
  if (!el) return;
  const a = S.config.active || {};
  const ready = Boolean(a.ready);
  el.classList.toggle("off", !ready);
  el.querySelector(".pname").textContent = ready ? a.label : "No provider";
  el.querySelector(".pmodel").textContent = ready ? a.model : "";
  el.title = ready ? `${a.label} · ${a.model}` : "Add an API key to .env and restart";
}

async function refreshConfig() {
  S.config = await api("/api/config");
  renderProviderBadge();
  return S.config;
}

// ---------------- theme + mobile ----------------
const scrim = $("#sidebar-scrim");
function setSidebar(open) {
  $("#sidebar").classList.toggle("open", open);
  scrim.classList.toggle("open", open);
}
$("#menu-btn").onclick = () => setSidebar(!$("#sidebar").classList.contains("open"));
scrim.onclick = () => setSidebar(false);

const themeBtn = $("#theme-toggle");
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  themeBtn.textContent = t === "dark" ? "☀️" : "🌙";
  themeBtn.title = t === "dark" ? "Switch to light" : "Switch to dark";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "dark" ? "#0e1014" : "#ffffff");
  localStorage.setItem("theme", t);
}
// Dark is the house style; light is an explicit opt-in that we remember.
applyTheme(localStorage.getItem("theme") || "dark");
themeBtn.onclick = () => applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");

// ---------------- init ----------------
(async function init() {
  const [config, agents, docSets, documents, actions] = await Promise.all([
    api("/api/config"), api("/api/agents"), api("/api/docsets"),
    api("/api/documents"), api("/api/actions"),
  ]);
  Object.assign(S, { config, agents, docSets, documents, actions });
  if (!agents.some((a) => a.id === S.agentId)) S.agentId = agents[0].id;
  if (!config.hasKey) $("#key-banner").classList.remove("hidden");
  renderProviderBadge();
  renderAgentChip(); renderAgentTools(); renderAgentList(); renderProjects();
  await loadSessions();
  setAdminMode(false);
  showView("chat");
  showEmpty();
  inputEl.focus();
})();

// The family assistant: a chat with Claude for people who have an access code.
// Messages (and any photos or PDFs attached to them) go to the assistant
// server in ../assistant/, which holds the API key and streams Claude's reply.
// The conversation is kept in this browser only.

import { decodeToBitmap } from "./images.js";

// Address of the assistant server (the Cloudflare Worker in assistant/)
const API_URL = location.hostname === "localhost" ? "http://127.0.0.1:8787" : "";

const MAX_FILES = 5;
const MAX_PDF = 15e6;
const MAX_IMAGE_SIDE = 1568; // larger photos are scaled down by the API anyway

const SUGGESTIONS = [
  ["📄 Explain a letter or bill", "Can you explain this to me in simple words? What do I need to do?", true],
  ["✉️ Write an email for me", "Please help me write an email. Here's what I want to say: "],
  ["⚠️ Is this a scam?", "I got this message. Is it a scam? ", true],
  ["📱 Help with my phone", "How do I "],
];

// ------------------------------------------------------------ storage ---

const store = {
  get(k) { try { return localStorage.getItem(`assistant.${k}`); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`assistant.${k}`, v); } catch { /* private mode or full */ } },
  del(k) { try { localStorage.removeItem(`assistant.${k}`); } catch { /* ignore */ } },
};

// ------------------------------------------------------------ helpers ---

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

const toBase64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

// A small, safe Markdown renderer: everything is escaped first, then only our
// own tags are added back.
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
}
function markdown(src) {
  const lines = src.replace(/\r/g, "").split("\n");
  let html = "";
  let list = null; // "ul" | "ol"
  let para = [];
  const flushPara = () => { if (para.length) html += `<p>${para.map(inline).join("<br>")}</p>`; para = []; };
  const closeList = () => { if (list) html += `</${list}>`; list = null; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara(); closeList();
      const code = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      html += `<pre><code>${esc(code.join("\n"))}</code></pre>`;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara(); closeList();
      const rows = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(lines[i]);
      i--;
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      html += `<div class="table-wrap"><table>${body.map((r, k) =>
        `<tr>${cells(r).map((c) => (k === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join("")}</tr>`).join("")}</table></div>`;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const number = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (heading) { flushPara(); closeList(); html += `<h3>${inline(heading[2])}</h3>`; }
    else if (bullet || number) {
      flushPara();
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) { closeList(); html += kind === "ol" && number[1] !== "1" ? `<ol start="${Number(number[1])}">` : `<${kind}>`; list = kind; }
      html += `<li>${inline(bullet ? bullet[1] : number[2])}</li>`;
    } else if (!line.trim()) { flushPara(); closeList(); }
    else if (/^-{3,}$/.test(line.trim())) { flushPara(); closeList(); html += "<hr>"; }
    else { closeList(); para.push(line); }
  }
  flushPara(); closeList();
  return html;
}

// --------------------------------------------------------------- state ---

const app = document.getElementById("app");
const topActions = document.getElementById("top-actions");
let code = store.get("code");
let name = store.get("name") || "";
let messages = loadChat(); // { role, text, files: [{ name, kind }], blocks?: [...] }
let pending = []; // attachments for the next message: { name, kind, block, thumb? }
let busy = null; // AbortController while a reply is streaming

function loadChat() {
  try { return JSON.parse(store.get("chat") || "[]"); } catch { return []; }
}
function saveChat() {
  // attachments are too big to keep; their names stay so the chat still reads right
  store.set("chat", JSON.stringify(messages.map(({ role, text, files }) => ({ role, text, files }))));
}

// The conversation in the form the server takes. Attachments from earlier in
// this visit are sent again so Claude can keep answering about them.
function apiMessages() {
  return messages.map((m) => {
    if (m.role === "assistant") return { role: "assistant", content: m.text || "(no answer)" };
    const note = m.files?.length && !m.blocks ? `\n\n(Earlier I attached: ${m.files.map((f) => f.name).join(", ")}. It's no longer available.)` : "";
    const text = (m.text || "Please look at this.") + note;
    return m.blocks?.length
      ? { role: "user", content: [...m.blocks, { type: "text", text }] }
      : { role: "user", content: text };
  });
}

async function call(path, body, signal) {
  const res = await fetch(API_URL + path, {
    method: "POST",
    headers: { "Authorization": `Bearer ${code}`, "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    signal,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const err = new Error(j.error || `The assistant isn't reachable right now (error ${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// ---------------------------------------------------------------- views ---

function render() {
  if (!API_URL) {
    topActions.hidden = true;
    app.replaceChildren(h("section", { class: "login" },
      h("h1", {}, "Assistant"),
      h("p", { class: "notice" }, "The assistant isn't switched on yet.")));
    return;
  }
  if (!code) return renderLogin();
  topActions.hidden = false;
  renderChat();
}

function renderLogin(error) {
  topActions.hidden = true;
  const input = h("input", { type: "password", id: "code", autocomplete: "current-password", placeholder: "Access code",
    "aria-label": "Access code", autocapitalize: "off", spellcheck: "false" });
  const remember = h("input", { type: "checkbox", checked: true });
  const msg = h("p", { class: "status error", role: "alert", hidden: !error }, error || "");
  const btn = h("button", { type: "submit", class: "btn primary" }, "Continue");
  const form = h("form", { class: "login", onsubmit: async (e) => {
    e.preventDefault();
    const tryCode = input.value.trim();
    if (!tryCode) return;
    btn.disabled = true;
    msg.hidden = true;
    try {
      code = tryCode;
      const r = await (await call("/check")).json();
      name = r.name;
      if (remember.checked) { store.set("code", code); store.set("name", name); }
      render();
    } catch (err) {
      code = null;
      msg.textContent = err.status === 401 ? "That access code isn't right. Check it and try again." : err.message;
      msg.hidden = false;
      btn.disabled = false;
      input.select();
    }
  } },
  h("h1", {}, "Assistant"),
  h("p", { class: "lede" }, "Ask Claude anything: explain a letter, write an email, check if a message is a scam. Only family members with an access code can use it."),
  input,
  h("label", { class: "check" }, remember, " Remember me on this device"),
  btn, msg);
  app.replaceChildren(form);
  input.focus();
}

let chatEls = null;

function renderChat() {
  const list = h("div", { class: "chat-list", "aria-live": "polite" });
  const input = h("textarea", { class: "chat-input", rows: "1", placeholder: "Type your question…", "aria-label": "Your message",
    oninput: () => autosize(input), onkeydown: (e) => {
      // Enter sends on computers; on phones Enter makes a new line and the button sends
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && matchMedia("(hover: hover)").matches) { e.preventDefault(); send(); }
    } });
  const fileInput = h("input", { type: "file", multiple: true, hidden: true, accept: "image/*,.heic,.heif,application/pdf",
    onchange: () => { addFiles([...fileInput.files]); fileInput.value = ""; } });
  const attachBtn = h("button", { type: "button", class: "icon-btn attach", title: "Attach a photo or PDF", "aria-label": "Attach a photo or PDF",
    onclick: () => fileInput.click() }, "📎");
  const sendBtn = h("button", { type: "button", class: "btn primary send", onclick: () => (busy ? busy.abort() : send()) }, "Send");
  const chips = h("div", { class: "chips" });
  const composer = h("div", { class: "composer" }, chips, h("div", { class: "composer-row" }, attachBtn, input, sendBtn), fileInput,
    h("p", { class: "hint privacy" }, "What you send goes to Claude (Anthropic) to answer it. Avoid passwords and card numbers."));
  app.replaceChildren(h("section", { class: "chat" }, list, composer));
  chatEls = { list, input, sendBtn, chips, attachBtn, fileInput };
  drawMessages();
  drawChips();
  // dropping or pasting files works too
  composer.addEventListener("dragover", (e) => e.preventDefault());
  composer.addEventListener("drop", (e) => { e.preventDefault(); addFiles([...e.dataTransfer.files]); });
  input.addEventListener("paste", (e) => { const f = [...e.clipboardData.files]; if (f.length) { e.preventDefault(); addFiles(f); } });
}

function autosize(t) {
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, 220)}px`;
}

function drawMessages() {
  const { list } = chatEls;
  list.replaceChildren();
  if (!messages.length) {
    list.append(h("div", { class: "welcome" },
      h("h1", {}, name ? `Hi ${name}, how can I help?` : "How can I help?"),
      h("div", { class: "suggestions" }, SUGGESTIONS.map(([label, text, attach]) =>
        h("button", { type: "button", class: "suggestion", onclick: () => {
          chatEls.input.value = text;
          autosize(chatEls.input);
          chatEls.input.focus();
          if (attach) chatEls.fileInput.click();
        } }, label)))));
    return;
  }
  for (const m of messages) list.append(messageEl(m));
  scrollDown();
}

function messageEl(m) {
  const body = h("div", { class: "bubble-body" });
  if (m.role === "assistant") body.innerHTML = markdown(m.text || "");
  else body.textContent = m.text;
  const files = m.files?.length ? h("div", { class: "bubble-files" }, m.files.map((f) =>
    h("span", { class: "file-chip" }, f.kind === "pdf" ? "📄 " : "🖼 ", f.name))) : null;
  const tools = m.role === "assistant" && m.text && !m.streaming ? h("div", { class: "bubble-tools" },
    h("button", { type: "button", class: "btn small ghost", onclick: async (e) => {
      try { await navigator.clipboard.writeText(m.text); e.target.textContent = "Copied ✓"; } catch { e.target.textContent = "Couldn't copy"; }
      setTimeout(() => (e.target.textContent = "Copy"), 2000);
    } }, "Copy")) : null;
  const el = h("div", { class: `bubble ${m.role}${m.error ? " error" : ""}` }, files, body, tools);
  m.el = el;
  m.bodyEl = body;
  return el;
}

function scrollDown() {
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
}

function drawChips() {
  const { chips } = chatEls;
  chips.replaceChildren(...pending.map((p, i) => h("span", { class: "file-chip removable" },
    p.thumb ? h("img", { src: p.thumb, alt: "" }) : "📄 ", p.name,
    h("button", { type: "button", "aria-label": `Remove ${p.name}`, onclick: () => { pending.splice(i, 1); drawChips(); } }, "✕"))));
  chips.hidden = !pending.length;
}

async function addFiles(files) {
  for (const f of files) {
    if (pending.length >= MAX_FILES) { flash(`You can attach up to ${MAX_FILES} files at a time.`); break; }
    try {
      if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
        if (f.size > MAX_PDF) throw new Error(`${f.name} is too large (over 15 MB). Try the Compress tool first.`);
        const data = toBase64(new Uint8Array(await f.arrayBuffer()));
        pending.push({ name: f.name, kind: "pdf", block: { type: "document", source: { type: "base64", media_type: "application/pdf", data } } });
      } else {
        const bmp = await decodeToBitmap(f);
        const s = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(bmp.width * s));
        c.height = Math.max(1, Math.round(bmp.height * s));
        const g = c.getContext("2d");
        g.fillStyle = "#fff";
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(bmp, 0, 0, c.width, c.height);
        bmp.close?.();
        const url = c.toDataURL("image/jpeg", 0.85);
        pending.push({ name: f.name || "photo.jpg", kind: "image", thumb: url,
          block: { type: "image", source: { type: "base64", media_type: "image/jpeg", data: url.split(",")[1] } } });
      }
    } catch (e) {
      flash(e.message || `Couldn't read ${f.name}.`);
    }
    drawChips();
  }
}

function flash(text) {
  const n = h("p", { class: "status error toast", role: "alert" }, text);
  document.body.append(n);
  setTimeout(() => n.remove(), 4000);
}

// ----------------------------------------------------------------- chat ---

async function send() {
  const { input, sendBtn, attachBtn } = chatEls;
  const text = input.value.trim();
  if ((!text && !pending.length) || busy) return;
  const attached = pending;
  const user = { role: "user", text, files: attached.map(({ name: n, kind }) => ({ name: n, kind })),
    blocks: attached.map((p) => p.block) };
  const reply = { role: "assistant", text: "", streaming: true };
  messages.push(user, reply);
  pending = [];
  input.value = "";
  autosize(input);
  drawChips();
  drawMessages();
  reply.bodyEl.innerHTML = '<span class="typing" aria-label="Thinking"><i></i><i></i><i></i></span>';

  busy = new AbortController();
  sendBtn.textContent = "Stop";
  attachBtn.disabled = true;
  let failed = null;
  try {
    const res = await call("/chat", { messages: apiMessages().slice(0, -1) }, busy.signal);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    let raf = 0;
    const paint = () => { raf = 0; reply.bodyEl.innerHTML = markdown(reply.text); scrollDown(); };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!line.startsWith("data: ")) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.text) { reply.text += ev.text; raf ||= requestAnimationFrame(paint); }
        else if (ev.status && !reply.text) reply.bodyEl.textContent = ev.status;
        else if (ev.error) failed = ev.error;
      }
    }
    if (!reply.text && !failed) failed = "No answer came back. Try again.";
  } catch (e) {
    if (e.name === "AbortError") { if (!reply.text) failed = "Stopped."; }
    else if (e.status === 401) { signOut("That access code no longer works. Enter it again."); return; }
    else failed = e.message === "Failed to fetch" ? "Can't reach the assistant. Check your internet connection." : e.message;
  } finally {
    busy = null;
    sendBtn.textContent = "Send";
    attachBtn.disabled = false;
  }
  reply.streaming = false;
  if (failed && !reply.text) {
    // put the question back so it can be sent again
    messages.splice(-2, 2);
    input.value = text;
    autosize(input);
    pending = attached;
    drawChips();
    drawMessages();
    flash(failed);
    return;
  }
  if (failed) reply.text += `\n\n*(${failed})*`;
  saveChat();
  const old = reply.el;
  old.replaceWith(messageEl(reply));
}

function newChat() {
  if (busy) busy.abort();
  messages = [];
  pending = [];
  store.del("chat");
  render();
}

function signOut(message) {
  if (busy) busy.abort();
  code = null;
  name = "";
  messages = [];
  pending = [];
  for (const k of ["code", "name", "chat"]) store.del(k);
  renderLogin(message);
}

document.getElementById("new-chat").addEventListener("click", newChat);
document.getElementById("sign-out").addEventListener("click", () => signOut());
render();

// PDF Tools: everything runs in this browser tab. Files are read into memory,
// processed by qpdf / pdf.js (WebAssembly), and handed back as downloads.
// The page's Content-Security-Policy forbids connections to any other site.

import { imagesToPdf } from "./images-to-pdf.js";
import { convertImage, OUTPUT_TYPES } from "./images.js";
import { makeZip } from "./zip.js";
import { fillSignView, disposeFillSign } from "./fill-sign.js";

// ------------------------------------------------------------- helpers ---

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v; // only ever used with our own static SVG
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

function fmtSize(n) {
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)} KB`;
  // two decimals below 10 MB so "1.99 MB" never reads as "2.0 MB" next to a limit
  return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)} MB`;
}

const stem = (name) => name.replace(/\.[^.]+$/, "");
const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

// Page ranges like "1-3, 5, 8-end". Returns [[from, to], ...] (1-based, inclusive).
function parseRanges(text, nPages) {
  const parts = text.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new Error("Enter at least one page or range, like 1-3, 5");
  const num = (s, fallback) => {
    s = s.trim().toLowerCase();
    if (!s) return fallback;
    if (s === "end" || s === "last") return nPages;
    if (!/^\d+$/.test(s)) throw new Error(`"${s}" isn't a page number`);
    const n = parseInt(s, 10);
    if (n < 1 || n > nPages) throw new Error(`Page ${n} doesn't exist (this PDF has ${nPages} pages)`);
    return n;
  };
  return parts.map((p) => {
    const m = p.split(/\s*[-–]\s*/);
    if (m.length > 2) throw new Error(`"${p}" isn't a valid range`);
    if (m.length === 1) { const n = num(m[0]); return [n, n]; }
    return [num(m[0], 1), num(m[1], nPages)];
  });
}

const rangeLabel = ([a, b]) => (a === b ? `${a}` : `${a}-${b}`);
const qpdfRange = ([a, b]) => (a === b ? `${a}` : `${a}-${b}`); // qpdf accepts reversed ranges too

// ------------------------------------------------------- background jobs ---

// Each job gets a brand-new worker that is destroyed when it finishes.
function job(msg, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker("worker.js");
    w.onmessage = ({ data }) => {
      if (data.type === "progress") return onProgress?.(data.text, data.frac);
      w.terminate();
      if (data.type === "done") resolve(data.result);
      else reject(Object.assign(new Error(data.message), { detail: data.detail }));
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error("The tool stopped unexpectedly. The file may be too large for this device's memory."));
      e.preventDefault();
    };
    w.postMessage(msg);
  });
}

let pdfjsLib = null;
let pdfjsWorker = null;
async function pdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import("./vendor/pdfjs/pdf.min.mjs");
    pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.mjs";
    // One long-lived worker shared by every document, so closing one document
    // can never tear down the worker another document is still using.
    pdfjsWorker = new pdfjsLib.PDFWorker();
  }
  return pdfjsLib;
}

async function openPdfjs(data, password) {
  const lib = await pdfjs();
  const task = lib.getDocument({
    worker: pdfjsWorker,
    data: data.slice(), // pdf.js takes ownership of the buffer it is given
    password: password || undefined,
    isEvalSupported: false,
    enableXfa: false,
    cMapUrl: "vendor/pdfjs/cmaps/",
    standardFontDataUrl: "vendor/pdfjs/standard_fonts/",
    wasmUrl: "vendor/pdfjs/wasm/",
    iccUrl: "vendor/pdfjs/iccs/",
  });
  const doc = await task.promise;
  doc.close = () => task.destroy(); // frees the document (the shared worker stays)
  return doc;
}

// Second, independent check (pdf.js) after qpdf has already verified the output.
async function doubleCheck(data, password, expectedPages) {
  const doc = await openPdfjs(data, password);
  try {
    if (expectedPages != null && doc.numPages !== expectedPages) {
      throw new Error(`Safety check failed: expected ${expectedPages} pages, got ${doc.numPages}.`);
    }
    await (await doc.getPage(1)).getOperatorList();
  } finally {
    await doc.close();
  }
}

// ------------------------------------------------------------- the tools ---

const ICONS = {
  compress: '<path d="M4 9h16M4 15h16M12 3v4m0 0-2-2m2 2 2-2M12 21v-4m0 0-2 2m2-2 2 2"/>',
  merge: '<path d="M6 4v5a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v5M18 4v5a3 3 0 0 1-3 3"/><path d="m15 17 3 3 3-3"/>',
  organize: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="9" rx="1"/><path d="M5 16h14m-3-3 3 3-3 3"/>',
  split: '<path d="M12 3v18M5 7l-2 5 2 5M19 7l2 5-2 5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  clean: '<path d="M4 20h16M7 16l9-9 3 3-9 9H7z"/><path d="m14 9 3 3"/>',
  pdf2img: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-8 8"/>',
  img2pdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  convert: '<path d="M4 7h13l-3-3M20 17H7l3 3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  sign: '<path d="M3 17c3-1 4-6 6-6s1 5 3 5 2-3 4-3 2 2 5 2"/><path d="M4 21h16"/>',
};

const icon = (name) => h("span", { class: "icon", "aria-hidden": "true",
  html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>` });

const TOOLS = [
  { id: "edit", title: "Edit PDF", blurb: "Change or delete the text already in a PDF, or erase parts of it.", kind: "pdf" },
  { id: "sign", title: "Fill & sign", blurb: "Fill in forms, add a signature, text, dates and check marks.", kind: "pdf" },
  { id: "compress", title: "Compress PDF", blurb: "Make a PDF smaller, e.g. to fit an upload limit.", kind: "pdf" },
  { id: "merge", title: "Merge PDFs", blurb: "Combine several PDFs into one, in the order you choose.", kind: "pdf", multiple: true },
  { id: "organize", title: "Organize pages", blurb: "Reorder, rotate or remove pages.", kind: "pdf" },
  { id: "split", title: "Split PDF", blurb: "Break a PDF into several smaller files.", kind: "pdf" },
  { id: "img2pdf", title: "Images to PDF", blurb: "Turn photos or scans into one PDF.", kind: "image", multiple: true },
  { id: "pdf2img", title: "PDF to images", blurb: "Save pages as PNG or JPG pictures.", kind: "pdf" },
  { id: "convert", title: "Convert images", blurb: "HEIC to JPG, PNG to JPG, resize, and more.", kind: "image", multiple: true },
  { id: "lock", title: "Add a password", blurb: "Encrypt a PDF so it needs a password to open.", kind: "pdf" },
  { id: "unlock", title: "Remove a password", blurb: "Save an unprotected copy of a PDF you have the password for.", kind: "pdf" },
  { id: "clean", title: "Remove hidden info", blurb: "Strip author, software and other metadata.", kind: "pdf" },
  { id: "info", title: "PDF info", blurb: "Pages, size, version and metadata.", kind: "pdf" },
];

// ---------------------------------------------------------------- state ---

const app = document.getElementById("app");
let tool = null;
let items = []; // { id, file, data, status: 'loading'|'ready'|'locked'|'error', info, password, error }
let opts = {};
let urls = [];
let busy = false;
let nextId = 1;

function resetState() {
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls = [];
  if (thumbDoc) thumbDoc.doc.then((d) => d.close()).catch(() => {});
  thumbDoc = null;
  thumbCache = new Map();
  disposeFillSign();
  items = [];
  opts = {};
  busy = false;
}

// ------------------------------------------------------------- routing ---

function route() {
  const id = location.hash.slice(1);
  const t = TOOLS.find((x) => x.id === id);
  resetState();
  tool = t || null;
  render();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

function render() {
  app.replaceChildren(tool ? toolView() : homeView());
  document.title = tool ? `${tool.title} · PDF Tools` : "PDF Tools";
}

function homeView() {
  return h("div", { class: "home" },
    h("section", { class: "hero" },
      h("h1", {}, "Everyday PDF and image tools"),
      h("p", { class: "lede" }, "Compress, merge, split, convert. ",
        h("strong", {}, "Your files never leave this device:"),
        " everything happens inside your browser, and this page is blocked from uploading anything.")),
    h("nav", { class: "grid", "aria-label": "Tools" },
      TOOLS.map((t) => h("a", { class: "card", href: `#${t.id}` },
        icon(t.id), h("span", { class: "card-title" }, t.title), h("span", { class: "card-blurb" }, t.blurb)))),
    aboutSection());
}

function aboutSection() {
  return h("details", { class: "about" },
    h("summary", {}, "How do I know my files stay private?"),
    h("ul", {},
      h("li", {}, "There is no server doing the work. The tools are WebAssembly programs (qpdf and Mozilla's pdf.js) that run inside this tab."),
      h("li", {}, "The page carries a security policy that makes the browser refuse any connection to another website, so even a bug couldn't upload a file."),
      h("li", {}, "Try it: once this page has loaded, turn on airplane mode. Everything keeps working."),
      h("li", {}, "Nothing is saved: closing the tab clears every file from memory.")));
}

// ------------------------------------------------------------ tool view ---

function toolView() {
  const view = h("div", { class: "tool" });
  const back = h("a", { class: "back", href: "#" }, "← All tools");
  view.append(back, h("header", { class: "tool-head" }, icon(tool.id), h("div", {},
    h("h1", {}, tool.title), h("p", {}, tool.blurb))));

  const picker = filePicker();
  const list = h("div", { class: "files" });
  const optsBox = h("div", { class: "options" });
  const status = h("div", { class: "status", role: "status", "aria-live": "polite" });
  const results = h("div", { class: "results" });
  view.append(picker, list, optsBox, status, results);

  const refresh = () => {
    list.replaceChildren(...fileRows());
    optsBox.replaceChildren(...(readyItems().length ? optionsFor() : []));
    picker.classList.toggle("compact", items.length > 0);
    picker.hidden = items.length > 0 && !tool.multiple;
  };
  view.refresh = refresh;
  view.status = status;
  view.results = results;
  currentView = view;
  refresh();
  return view;
}

let currentView = null;
const refresh = () => currentView?.refresh();

function setStatus(text, frac, kind = "") {
  const s = currentView.status;
  s.className = `status ${kind}`;
  s.replaceChildren();
  if (!text) return;
  s.append(h("span", {}, text));
  if (frac != null) {
    const bar = h("progress", { max: 1 });
    if (frac >= 0) bar.value = frac;
    s.append(bar);
  }
}

function filePicker() {
  const accept = tool.kind === "pdf" ? "application/pdf,.pdf" : "image/*,.heic,.heif";
  const input = h("input", { type: "file", accept, multiple: tool.multiple, hidden: true,
    onchange: () => { addFiles([...input.files]); input.value = ""; } });
  const zone = h("div", { class: "drop" },
    h("p", { class: "drop-main" }, tool.multiple ? "Drop files here" : "Drop a file here"),
    h("p", { class: "drop-or" }, "or"),
    h("button", { type: "button", class: "btn", onclick: () => input.click() },
      tool.kind === "pdf" ? (tool.multiple ? "Choose PDFs" : "Choose a PDF") : "Choose images"),
    input);
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    addFiles([...e.dataTransfer.files]);
  });
  return zone;
}

async function addFiles(files) {
  if (busy) return;
  currentView.results.replaceChildren();
  setStatus("");
  const wanted = files.filter((f) => (tool.kind === "pdf" ? isPdf(f) : !isPdf(f)));
  if (wanted.length < files.length) {
    setStatus(tool.kind === "pdf" ? "Only PDF files can be used here." : "Only image files can be used here.", null, "error");
  }
  const add = tool.multiple ? wanted : wanted.slice(0, 1);
  if (!tool.multiple) items = [];
  for (const file of add) {
    const it = { id: nextId++, file, status: tool.kind === "pdf" ? "loading" : "ready" };
    items.push(it);
    if (tool.kind === "pdf") loadPdf(it);
  }
  refresh();
}

async function loadPdf(it) {
  try {
    it.data = new Uint8Array(await it.file.arrayBuffer());
    const r = await job({ op: "inspect", data: it.data });
    if (r.needsPassword) it.status = "locked";
    else { it.status = "ready"; it.info = r; }
  } catch (e) {
    console.error(e, e?.detail);
    it.status = "error";
    it.error = "This doesn't look like a readable PDF.";
  }
  refresh();
}

async function unlockItem(it, password) {
  const r = await job({ op: "checkPassword", data: it.data, password });
  if (!r.ok) return false;
  it.password = password;
  it.info = r;
  it.status = "ready";
  refresh();
  return true;
}

const readyItems = () => items.filter((i) => i.status === "ready");

function fileRows() {
  return items.map((it, idx) => {
    const meta = [];
    meta.push(fmtSize(it.file.size));
    if (it.info) meta.push(`${it.info.pages} page${it.info.pages === 1 ? "" : "s"}`);
    if (it.password) meta.push("unlocked");
    const row = h("div", { class: `file ${it.status}` },
      h("div", { class: "file-main" },
        h("span", { class: "file-name" }, it.file.name),
        h("span", { class: "file-meta" },
          it.status === "loading" ? "Reading…" : it.status === "error" ? it.error : meta.join(" · "))),
      h("div", { class: "file-actions" },
        tool.multiple && items.length > 1 && h("button", { type: "button", class: "icon-btn", "aria-label": "Move up",
          disabled: idx === 0 || busy, onclick: () => { move(idx, -1); } }, "↑"),
        tool.multiple && items.length > 1 && h("button", { type: "button", class: "icon-btn", "aria-label": "Move down",
          disabled: idx === items.length - 1 || busy, onclick: () => { move(idx, 1); } }, "↓"),
        h("button", { type: "button", class: "icon-btn", "aria-label": `Remove ${it.file.name}`, disabled: busy,
          onclick: () => { items.splice(idx, 1); currentView.results.replaceChildren(); setStatus(""); refresh(); } }, "✕")));
    if (it.status === "locked") row.append(passwordPrompt(it));
    return row;
  });
}

function move(idx, d) {
  const [x] = items.splice(idx, 1);
  items.splice(idx + d, 0, x);
  refresh();
}

function passwordPrompt(it) {
  const input = h("input", { type: "password", placeholder: "Password", autocomplete: "off", "aria-label": "PDF password" });
  const msg = h("span", { class: "hint" }, "This PDF is password-protected.");
  const go = async () => {
    msg.textContent = "Checking…";
    if (!(await unlockItem(it, input.value))) { msg.textContent = "That password didn't work."; input.select(); }
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  return h("div", { class: "pw-row" }, msg, input, h("button", { type: "button", class: "btn small", onclick: go }, "Unlock"));
}

// --------------------------------------------------------- tool options ---

function field(label, control, hint) {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, hint && h("span", { class: "hint" }, hint));
}

function radios(name, choices, current, onchange) {
  return h("div", { class: "radios", role: "radiogroup" }, choices.map(([value, label, sub]) =>
    h("label", { class: "radio" },
      h("input", { type: "radio", name, value, checked: value === current, onchange: () => onchange(value) }),
      h("span", {}, h("span", { class: "radio-label" }, label), sub && h("span", { class: "hint" }, sub)))));
}

function runButton(label, fn, enabled = true) {
  return h("button", { type: "button", class: "btn primary", disabled: !enabled || busy, onclick: () => guard(fn) }, label);
}

async function guard(fn) {
  if (busy) return;
  busy = true;
  refresh();
  currentView.results.replaceChildren();
  setStatus("Starting…", -1);
  try {
    await fn();
  } catch (e) {
    console.error(e, e?.detail);
    setStatus(e?.message || "Something went wrong. The file may be damaged or in an unsupported format.", null, "error");
  } finally {
    busy = false;
    refresh();
  }
}

function optionsFor() {
  const one = readyItems()[0];
  switch (tool.id) {
    case "sign": return fillSignView(one, signCtx);
    case "edit": return fillSignView(one, editCtx);
    case "compress": return compressOptions(one);
    case "merge": return mergeOptions();
    case "organize": return organizeOptions(one);
    case "split": return splitOptions(one);
    case "lock": return lockOptions(one);
    case "unlock": return unlockOptions(one);
    case "clean": return cleanOptions(one);
    case "info": return infoView(one);
    case "pdf2img": return pdf2imgOptions(one);
    case "img2pdf": return img2pdfOptions();
    case "convert": return convertOptions();
  }
  return [];
}

// --- fill & sign (editor lives in fill-sign.js)

const signCtx = { h, job, openPdfjs, pdfjs, setStatus, doubleCheck, stem, guard,
  showResults: (...a) => showResults(...a), isBusy: () => busy };
const editCtx = { ...signCtx, mode: "edit" };

// --- compress

const LADDER = [[200, 85], [150, 75], [150, 62], [125, 60], [100, 55], [85, 50], [72, 45], [60, 40]];
const LEVELS = {
  balanced: [[150, 75]],
  best: [[200, 85]],
  small: [[100, 55]],
  smallest: [[72, 45]],
};

function compressOptions(it) {
  opts.mode ??= "balanced";
  opts.limit ??= "";
  const limitInput = h("input", { type: "number", min: "0.1", step: "0.1", inputmode: "decimal",
    class: "limit", value: opts.limit, placeholder: "2", "aria-label": "Size limit in MB",
    oninput: (e) => { opts.limit = e.target.value; opts.mode = "limit"; syncRadio(); } });
  const syncRadio = () => { const r = document.querySelector('input[name="mode"][value="limit"]'); if (r) r.checked = true; };
  const choices = radios("mode", [
    ["balanced", "Balanced", "Good for email and most uploads. 150 dpi."],
    ["limit", h("span", { class: "inline" }, "Under ", limitInput, " MB"), "Picks the best quality that fits."],
    ["best", "Best quality", "Light compression. 200 dpi."],
    ["small", "Small", "Still readable on screen. 100 dpi."],
    ["smallest", "Smallest", "Lowest quality. 72 dpi."],
    ["lossless", "No quality loss", "Only repacks the file. Usually a small saving."],
  ], opts.mode, (v) => { opts.mode = v; if (v === "limit") limitInput.focus(); });
  return [
    field("How small?", choices),
    runButton("Compress", () => runCompress(it)),
  ];
}

async function runCompress(it) {
  const msg = { op: "compress", data: it.data, password: it.password };
  if (opts.mode === "limit") {
    const mb = parseFloat(opts.limit);
    if (!(mb > 0)) throw new Error("Enter a size limit in MB, like 2.");
    msg.targetBytes = Math.floor(mb * 1e6);
    if (it.file.size <= msg.targetBytes) {
      setStatus(`This file is already ${fmtSize(it.file.size)}, which is under ${mb} MB. Nothing to do.`, null, "ok");
      return;
    }
    msg.steps = LADDER;
  } else if (opts.mode === "lossless") {
    msg.lossless = true;
    msg.steps = [[0, 0]];
  } else msg.steps = LEVELS[opts.mode];

  const r = await job(msg, (t, f) => setStatus(t, f));
  const out = r.files[0].data;
  await doubleCheck(out, it.password, it.info.pages);
  const name = `${stem(it.file.name)}-compressed.pdf`;
  if (out.length >= it.file.size) {
    setStatus("This PDF can't be made any smaller at this setting. It's probably mostly text, or already compressed. Try a smaller setting.", null, "warn");
    return;
  }
  const saved = Math.round((1 - out.length / it.file.size) * 100);
  let note = `${fmtSize(it.file.size)} → ${fmtSize(out.length)} (${saved}% smaller).`;
  if (msg.targetBytes && !r.metTarget) {
    setStatus(`Couldn't get under ${fmtSize(msg.targetBytes)} without making it unreadable. Smallest result: ${note}`, null, "warn");
  } else {
    if (msg.targetBytes) note += ` Used ${r.used[0]} dpi.`;
    setStatus(`Done. ${note} Open it and check it looks right before sending.`, null, "ok");
  }
  showResults([{ name, data: out, type: "application/pdf" }]);
}

// --- merge

function mergeOptions() {
  const ready = readyItems();
  const waiting = items.some((i) => i.status === "locked" || i.status === "loading");
  return [
    h("p", { class: "hint" }, "Files are joined top to bottom. Use the arrows to change the order."),
    runButton(`Merge ${ready.length} PDFs`, runMerge, ready.length >= 2 && !waiting),
  ];
}

async function runMerge() {
  const list = readyItems();
  const pages = list.reduce((n, i) => n + i.info.pages, 0);
  const args = ["--empty", "--pages"];
  list.forEach((it, i) => args.push(`/in${i}.pdf`, ...(it.password ? [`--password=${it.password}`] : []), "1-z"));
  args.push("--", "/out/merged.pdf");
  const r = await job({ op: "runQpdf", inputs: list.map((i) => i.data), commands: [
    { args, outputs: ["/out/merged.pdf"], names: ["merged.pdf"], expectPages: [pages], label: "Merging…" }] },
  (t, f) => setStatus(t, f));
  await doubleCheck(r.files[0].data, null, pages);
  setStatus(`Done. ${pages} pages in total.`, null, "ok");
  showResults([{ name: "merged.pdf", data: r.files[0].data, type: "application/pdf" }]);
}

// --- organize

function organizeOptions(it) {
  if (!opts.pages || opts.pagesFor !== it.id) {
    opts.pagesFor = it.id;
    opts.pages = Array.from({ length: it.info.pages }, (_, i) => ({ src: i + 1, rot: 0, del: false }));
  }
  const grid = h("div", { class: "thumbs" });
  const draw = () => {
    grid.replaceChildren(...opts.pages.map((p, idx) => thumbCard(it, p, idx, draw)));
    summary.textContent = summaryText();
  };
  const summaryText = () => {
    const kept = opts.pages.filter((p) => !p.del).length;
    return `${kept} of ${opts.pages.length} pages will be kept.`;
  };
  const summary = h("span", { class: "hint" });
  const bar = h("div", { class: "toolbar" },
    h("button", { type: "button", class: "btn small", onclick: () => { opts.pages.forEach((p) => (p.rot = (p.rot + 90) % 360)); draw(); } }, "Rotate all ↻"),
    h("button", { type: "button", class: "btn small", onclick: () => { opts.pages.reverse(); draw(); } }, "Reverse order"),
    h("button", { type: "button", class: "btn small", onclick: () => { opts.pages = null; refresh(); } }, "Reset"),
    summary);
  draw();
  return [
    h("p", { class: "hint" }, "Drag pages to reorder (or use the arrows). ↻ rotates, ✕ removes."),
    bar, grid,
    runButton("Save PDF", () => runOrganize(it)),
  ];
}

let thumbCache = new Map();
function thumbCard(it, p, idx, redraw) {
  const img = h("canvas", { class: "thumb-img", style: `transform: rotate(${p.rot}deg)` });
  renderThumb(it, p.src, img).catch(() => {}); // cancelled when leaving the tool: harmless
  const card = h("div", { class: `thumb ${p.del ? "deleted" : ""}`, draggable: "true" },
    h("div", { class: "thumb-frame" }, img),
    h("div", { class: "thumb-bar" },
      h("button", { type: "button", class: "icon-btn", "aria-label": `Move page ${p.src} left`, disabled: idx === 0,
        onclick: () => { swap(idx, idx - 1); redraw(); } }, "←"),
      h("button", { type: "button", class: "icon-btn", "aria-label": `Rotate page ${p.src}`,
        onclick: () => { p.rot = (p.rot + 90) % 360; redraw(); } }, "↻"),
      h("button", { type: "button", class: "icon-btn", "aria-label": p.del ? `Keep page ${p.src}` : `Remove page ${p.src}`,
        onclick: () => { p.del = !p.del; redraw(); } }, p.del ? "↺" : "✕"),
      h("button", { type: "button", class: "icon-btn", "aria-label": `Move page ${p.src} right`, disabled: idx === opts.pages.length - 1,
        onclick: () => { swap(idx, idx + 1); redraw(); } }, "→")),
    h("span", { class: "thumb-num" }, `Page ${p.src}`));
  card.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", String(idx)); card.classList.add("dragging"); });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));
  card.addEventListener("dragover", (e) => { e.preventDefault(); card.classList.add("drop-target"); });
  card.addEventListener("dragleave", () => card.classList.remove("drop-target"));
  card.addEventListener("drop", (e) => {
    e.preventDefault();
    const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
    if (Number.isNaN(from) || from === idx) return;
    const [x] = opts.pages.splice(from, 1);
    opts.pages.splice(idx, 0, x);
    redraw();
  });
  return card;
}

function swap(a, b) {
  [opts.pages[a], opts.pages[b]] = [opts.pages[b], opts.pages[a]];
}

let thumbDoc = null;
async function renderThumb(it, pageNo, canvas) {
  const key = `${it.id}:${pageNo}`;
  const cached = thumbCache.get(key);
  if (cached) { drawCached(cached, canvas); return; }
  if (!thumbDoc || thumbDoc.forId !== it.id) {
    thumbCache = new Map();
    thumbDoc = { forId: it.id, doc: openPdfjs(it.data, it.password) };
  }
  const doc = await thumbDoc.doc;
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const scale = (140 * (window.devicePixelRatio || 1)) / Math.max(base.width, base.height);
  const vp = page.getViewport({ scale });
  const off = document.createElement("canvas");
  off.width = Math.ceil(vp.width);
  off.height = Math.ceil(vp.height);
  // "print" intent: renders in one go instead of pacing itself to screen refreshes,
  // which browsers pause while the tab is in the background
  await page.render({ canvas: off, canvasContext: off.getContext("2d"), viewport: vp, intent: "print" }).promise;
  thumbCache.set(key, off);
  drawCached(off, canvas);
}

function drawCached(src, canvas) {
  canvas.width = src.width;
  canvas.height = src.height;
  canvas.getContext("2d").drawImage(src, 0, 0);
}

async function runOrganize(it) {
  const kept = opts.pages.filter((p) => !p.del);
  if (!kept.length) throw new Error("You've removed every page. Keep at least one.");
  const args = [...(it.password ? [`--password=${it.password}`] : []), "/in0.pdf",
    "--pages", ".", kept.map((p) => p.src).join(","), "--"];
  for (const angle of [90, 180, 270]) {
    const which = kept.map((p, i) => (p.rot === angle ? i + 1 : 0)).filter(Boolean);
    if (which.length) args.push(`--rotate=+${angle}:${which.join(",")}`);
  }
  args.push("/out/x.pdf");
  const r = await job({ op: "runQpdf", inputs: [it.data], password: it.password, commands: [
    { args, outputs: ["/out/x.pdf"], names: ["x"], expectPages: [kept.length], label: "Saving…" }] },
  (t, f) => setStatus(t, f));
  await doubleCheck(r.files[0].data, it.password, kept.length);
  setStatus(`Done. ${kept.length} pages.`, null, "ok");
  showResults([{ name: `${stem(it.file.name)}-edited.pdf`, data: r.files[0].data, type: "application/pdf" }]);
}

// --- split

function splitOptions(it) {
  opts.split ??= "each";
  opts.every ??= "2";
  opts.ranges ??= "";
  const n = it.info.pages;
  const every = h("input", { type: "number", min: "1", max: String(n), class: "limit", value: opts.every,
    "aria-label": "Pages per file", oninput: (e) => { opts.every = e.target.value; opts.split = "every"; check("every"); } });
  const ranges = h("input", { type: "text", class: "wide", value: opts.ranges, placeholder: `e.g. 1-3, 4, 5-${n}`,
    "aria-label": "Page ranges", oninput: (e) => { opts.ranges = e.target.value; opts.split = "ranges"; check("ranges"); } });
  const check = (v) => { const r = document.querySelector(`input[name="split"][value="${v}"]`); if (r) r.checked = true; };
  return [
    field("Split into", radios("split", [
      ["each", "One file per page", `${n} files`],
      ["every", h("span", { class: "inline" }, "Files of ", every, " pages each"), null],
      ["ranges", h("span", { class: "inline wrap" }, "These parts: ", ranges), "Each part becomes its own file. Use \"end\" for the last page."],
    ], opts.split, (v) => { opts.split = v; })),
    runButton("Split", () => runSplit(it)),
  ];
}

async function runSplit(it) {
  const n = it.info.pages;
  let parts;
  if (opts.split === "each") parts = Array.from({ length: n }, (_, i) => [i + 1, i + 1]);
  else if (opts.split === "every") {
    const k = parseInt(opts.every, 10);
    if (!(k >= 1)) throw new Error("Enter how many pages each file should have.");
    parts = [];
    for (let a = 1; a <= n; a += k) parts.push([a, Math.min(n, a + k - 1)]);
  } else parts = parseRanges(opts.ranges, n);
  const base = stem(it.file.name);
  const pw = it.password ? [`--password=${it.password}`] : [];
  const commands = parts.map((p, i) => ({
    args: [...pw, "/in0.pdf", "--pages", ".", qpdfRange(p), "--", `/out/${i}.pdf`],
    outputs: [`/out/${i}.pdf`],
    names: [`${base} (page${p[0] === p[1] ? "" : "s"} ${rangeLabel(p)}).pdf`],
    expectPages: [Math.abs(p[1] - p[0]) + 1],
    label: `Making file ${i + 1} of ${parts.length}…`,
  }));
  const r = await job({ op: "runQpdf", inputs: [it.data], password: it.password, commands }, (t, f) => setStatus(t, f));
  for (let i = 0; i < r.files.length; i++) {
    setStatus(`Double-checking file ${i + 1} of ${r.files.length}…`, i / r.files.length);
    await doubleCheck(r.files[i].data, it.password, commands[i].expectPages[0]);
  }
  setStatus(`Done. ${r.files.length} files.`, null, "ok");
  showResults(r.files.map((f) => ({ name: f.name, data: f.data, type: "application/pdf" })), `${base} (split).zip`);
}

// --- lock / unlock / clean / info

function lockOptions(it) {
  const a = h("input", { type: "password", autocomplete: "new-password", "aria-label": "New password" });
  const b = h("input", { type: "password", autocomplete: "new-password", "aria-label": "Repeat password" });
  const show = h("input", { type: "checkbox", onchange: () => { a.type = b.type = show.checked ? "text" : "password"; } });
  return [
    field("New password", a),
    field("Repeat it", b),
    h("label", { class: "check" }, show, " Show password"),
    h("p", { class: "hint" }, "Uses AES-256 encryption. If the password is forgotten, nobody can recover the PDF, so keep it somewhere safe."),
    runButton("Add password", async () => {
      if (!a.value) throw new Error("Enter a password.");
      if (a.value !== b.value) throw new Error("The two passwords don't match.");
      const args = [...(it.password ? [`--password=${it.password}`] : []), "/in0.pdf", "--encrypt",
        `--user-password=${a.value}`, `--owner-password=${a.value}`, "--bits=256", "--", "/out/x.pdf"];
      const r = await job({ op: "runQpdf", inputs: [it.data], password: it.password, outputPassword: a.value,
        commands: [{ args, outputs: ["/out/x.pdf"], names: ["x"], expectPages: [it.info.pages], label: "Encrypting…" }] });
      await doubleCheck(r.files[0].data, a.value, it.info.pages);
      setStatus("Done. The new PDF asks for the password when it's opened.", null, "ok");
      showResults([{ name: `${stem(it.file.name)}-protected.pdf`, data: r.files[0].data, type: "application/pdf" }]);
    }),
  ];
}

function unlockOptions(it) {
  if (!it.info.encrypted) return [h("p", { class: "notice" }, "This PDF isn't password-protected, so there's nothing to remove.")];
  return [
    h("p", { class: "hint" }, it.password ? "Password accepted." : "This PDF opens without a password but has restrictions (for example on printing or copying). They will be removed."),
    runButton("Save without password", async () => {
      const args = [...(it.password ? [`--password=${it.password}`] : []), "/in0.pdf", "--decrypt", "/out/x.pdf"];
      const r = await job({ op: "runQpdf", inputs: [it.data], password: it.password, outputPassword: "",
        commands: [{ args, outputs: ["/out/x.pdf"], names: ["x"], expectPages: [it.info.pages], label: "Decrypting…" }] });
      await doubleCheck(r.files[0].data, null, it.info.pages);
      setStatus("Done. The new copy opens without a password.", null, "ok");
      showResults([{ name: `${stem(it.file.name)}-unlocked.pdf`, data: r.files[0].data, type: "application/pdf" }]);
    }),
  ];
}

function infoTable(it) {
  const i = it.info;
  const rows = [
    ["File size", fmtSize(it.file.size)],
    ["Pages", String(i.pages)],
    ["PDF version", i.version],
    ["Password", i.encrypted ? (it.password ? "Yes (unlocked here)" : "Restrictions only") : "No"],
    ["Images", String(i.images)],
  ];
  if (i.firstPage) rows.push(["Page 1 size", `${Math.round(i.firstPage.w / 72 * 25.4)} × ${Math.round(i.firstPage.h / 72 * 25.4)} mm`]);
  for (const [k, v] of Object.entries(i.info)) rows.push([k, v]);
  if (i.hasXmp) rows.push(["XMP metadata", "Present"]);
  return h("table", { class: "info" }, h("tbody", {}, rows.map(([k, v]) => h("tr", {}, h("th", {}, k), h("td", {}, v)))));
}

function infoView(it) {
  return [infoTable(it)];
}

function cleanOptions(it) {
  const found = Object.keys(it.info.info);
  return [
    h("p", { class: "hint" }, found.length || it.info.hasXmp
      ? `Found: ${[...found, ...(it.info.hasXmp ? ["XMP metadata"] : [])].join(", ")}. All of it will be removed. Page content is not changed.`
      : "No document metadata found, but you can still run this to be sure."),
    runButton("Remove hidden info", async () => {
      const args = [...(it.password ? [`--password=${it.password}`] : []), "/in0.pdf", "--remove-info", "--remove-metadata", "/out/x.pdf"];
      const r = await job({ op: "runQpdf", inputs: [it.data], password: it.password,
        commands: [{ args, outputs: ["/out/x.pdf"], names: ["x"], expectPages: [it.info.pages], label: "Cleaning…" }] });
      await doubleCheck(r.files[0].data, it.password, it.info.pages);
      setStatus("Done. Metadata removed.", null, "ok");
      showResults([{ name: `${stem(it.file.name)}-clean.pdf`, data: r.files[0].data, type: "application/pdf" }]);
    }),
  ];
}

// --- pdf to images

function pdf2imgOptions(it) {
  opts.fmt ??= "png";
  opts.dpi ??= "150";
  opts.which ??= "";
  return [
    field("Format", radios("fmt", [["png", "PNG", "Sharpest, bigger files"], ["jpg", "JPG", "Smaller, good for photos"]], opts.fmt, (v) => (opts.fmt = v))),
    field("Resolution", h("select", { onchange: (e) => (opts.dpi = e.target.value) },
      [["72", "Low (72 dpi)"], ["150", "Medium (150 dpi)"], ["300", "High (300 dpi)"]].map(([v, l]) =>
        h("option", { value: v, selected: v === opts.dpi }, l)))),
    field("Pages", h("input", { type: "text", class: "wide", value: opts.which, placeholder: `All ${it.info.pages} pages (or e.g. 1-3, 5)`,
      oninput: (e) => (opts.which = e.target.value) })),
    runButton("Convert to images", () => runPdf2img(it)),
  ];
}

const MAX_PIXELS = 16e6; // iPhone Safari refuses canvases above ~16.7 megapixels

async function runPdf2img(it) {
  const n = it.info.pages;
  const pages = opts.which.trim()
    ? parseRanges(opts.which, n).flatMap(([a, b]) => { const s = a <= b ? 1 : -1; const out = []; for (let p = a; p !== b + s; p += s) out.push(p); return out; })
    : Array.from({ length: n }, (_, i) => i + 1);
  const doc = await openPdfjs(it.data, it.password);
  const files = [];
  let shrunk = false;
  const pad = String(n).length;
  const mime = opts.fmt === "png" ? "image/png" : "image/jpeg";
  try {
    for (let k = 0; k < pages.length; k++) {
      setStatus(`Rendering page ${pages[k]} (${k + 1} of ${pages.length})…`, k / pages.length);
      const page = await doc.getPage(pages[k]);
      const base = page.getViewport({ scale: 1 });
      let scale = Number(opts.dpi) / 72;
      const px = base.width * base.height * scale * scale;
      if (px > MAX_PIXELS) { scale *= Math.sqrt(MAX_PIXELS / px); shrunk = true; }
      const vp = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport: vp, intent: "print" }).promise; // see renderThumb
      const blob = await new Promise((res) => canvas.toBlob(res, mime, 0.9));
      if (!blob) throw new Error("This browser couldn't create the image (the page may be too large).");
      files.push({ name: `${stem(it.file.name)}-page-${String(pages[k]).padStart(pad, "0")}.${opts.fmt}`,
        data: new Uint8Array(await blob.arrayBuffer()), type: mime });
      canvas.width = canvas.height = 0;
      page.cleanup();
    }
  } finally {
    await doc.close();
  }
  setStatus(`Done. ${files.length} image${files.length === 1 ? "" : "s"}.` +
    (shrunk ? " Some very large pages were rendered at a lower resolution to stay within this device's limits." : ""), null, "ok");
  showResults(files, `${stem(it.file.name)} (images).zip`);
}

// --- images to pdf

function img2pdfOptions() {
  opts.size ??= "fit";
  return [
    h("p", { class: "hint" }, "One image per page, top to bottom. Use the arrows to change the order."),
    field("Page size", radios("size", [
      ["fit", "Same shape as each image", "No margins."],
      ["a4", "A4", "Image centered with a small margin."],
      ["letter", "US Letter", "Image centered with a small margin."],
    ], opts.size, (v) => (opts.size = v))),
    runButton(`Make PDF from ${items.length} image${items.length === 1 ? "" : "s"}`, runImg2pdf, items.length > 0),
  ];
}

async function runImg2pdf() {
  const files = items.map((i) => i.file);
  const built = await imagesToPdf(files, opts.size, (t, f) => setStatus(t, f));
  setStatus("Checking…", 1);
  const r = await job({ op: "runQpdf", inputs: [built.data], commands: [{
    args: ["/in0.pdf", "--object-streams=generate", "/out/x.pdf"], outputs: ["/out/x.pdf"], names: ["x"],
    expectPages: [built.pages], label: "Checking…" }] });
  await doubleCheck(r.files[0].data, null, built.pages);
  const name = files.length === 1 ? `${stem(files[0].name)}.pdf` : "images.pdf";
  setStatus(`Done. ${built.pages} page${built.pages === 1 ? "" : "s"}.`, null, "ok");
  showResults([{ name, data: r.files[0].data, type: "application/pdf" }]);
}

// --- convert images

function convertOptions() {
  opts.to ??= "jpg";
  opts.quality ??= 90;
  opts.max ??= "";
  const q = h("input", { type: "range", min: "40", max: "100", value: String(opts.quality),
    oninput: (e) => { opts.quality = Number(e.target.value); qv.textContent = String(opts.quality); } });
  const qv = h("span", { class: "hint" }, String(opts.quality));
  return [
    field("Convert to", radios("to", Object.entries(OUTPUT_TYPES).map(([k, t]) => [k, t.label,
      k === "jpg" ? "Works everywhere" : k === "png" ? "No quality loss, bigger" : "Small, modern"]),
    opts.to, (v) => { opts.to = v; refresh(); })),
    OUTPUT_TYPES[opts.to].lossy && field("Quality", h("span", { class: "inline" }, q, qv)),
    field("Resize", h("select", { onchange: (e) => (opts.max = e.target.value) },
      [["", "Keep original size"], ["3840", "Max 3840 px (4K)"], ["2048", "Max 2048 px"], ["1600", "Max 1600 px"], ["1024", "Max 1024 px"], ["640", "Max 640 px"]]
        .map(([v, l]) => h("option", { value: v, selected: v === opts.max }, l))),
    "Longest side. Smaller images, smaller files."),
    h("p", { class: "hint" }, "Location and camera details (EXIF) are removed from the converted images."),
    runButton(`Convert ${items.length} image${items.length === 1 ? "" : "s"}`, runConvert, items.length > 0),
  ];
}

async function runConvert() {
  const t = OUTPUT_TYPES[opts.to];
  const out = [];
  let before = 0, after = 0;
  for (let i = 0; i < items.length; i++) {
    const f = items[i].file;
    setStatus(`Converting ${f.name} (${i + 1} of ${items.length})…`, i / items.length);
    const blob = await convertImage(f, opts.to, opts.quality, opts.max ? Number(opts.max) : 0);
    before += f.size;
    after += blob.size;
    out.push({ name: `${stem(f.name)}.${opts.to}`, data: new Uint8Array(await blob.arrayBuffer()), type: t.mime });
  }
  setStatus(`Done. ${fmtSize(before)} → ${fmtSize(after)}.`, null, "ok");
  showResults(out, "converted images.zip");
}

// -------------------------------------------------------------- results ---

function showResults(files, zipName) {
  const box = currentView.results;
  box.replaceChildren();
  const entries = files.map((f) => {
    const blob = new Blob([f.data], { type: f.type });
    const url = URL.createObjectURL(blob);
    urls.push(url);
    return { ...f, blob, url };
  });
  if (entries.length > 1 && zipName) {
    const zip = makeZip(entries);
    const url = URL.createObjectURL(zip);
    urls.push(url);
    box.append(resultCard({ name: zipName, blob: zip, url, type: "application/zip" }, `${entries.length} files`, true));
  }
  const list = h("div", { class: "result-list" }, entries.map((e) => resultCard(e, fmtSize(e.blob.size), entries.length === 1)));
  if (entries.length > 1) box.append(h("details", { class: "each", open: entries.length <= 6 }, h("summary", {}, "Or download them one by one"), list));
  else box.append(list);
  box.append(h("button", { type: "button", class: "btn ghost", onclick: () => { resetState(); render(); window.scrollTo(0, 0); } }, "Start over"));
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function resultCard(e, meta, primary) {
  const file = new File([e.blob], e.name, { type: e.type });
  const canShare = navigator.canShare?.({ files: [file] });
  const viewable = e.type !== "application/zip";
  return h("div", { class: `result ${primary ? "primary" : ""}` },
    h("div", { class: "file-main" }, h("span", { class: "file-name" }, e.name), h("span", { class: "file-meta" }, meta)),
    h("div", { class: "result-actions" },
      viewable && h("a", { class: "btn small ghost", href: e.url, target: "_blank", rel: "noopener" }, "Open"),
      canShare && h("button", { type: "button", class: "btn small ghost",
        onclick: () => navigator.share({ files: [file] }).catch(() => {}) }, "Share"),
      h("a", { class: `btn small ${primary ? "primary" : ""}`, href: e.url, download: e.name }, "Download")));
}

// ---------------------------------------------------------------- start ---

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
route();

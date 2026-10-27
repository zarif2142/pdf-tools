// "Edit PDF" as a document: the PDF's text is turned into paragraphs you can
// edit like a word processor (text reflows as you type), then laid out into
// pages again and saved as a new PDF.
//
// Reading: pdf.js gives the text pieces with their positions and fonts. Pieces
// on the same baseline make lines; lines make paragraphs (a paragraph ends at a
// bigger gap, a short line, a change of size, a bullet...). Pictures are found
// in the page's drawing commands and cut out of the drawn page, together with
// any labels printed on them.
//
// Saving: the editor uses Arimo, Tinos and Cousine, which have exactly the letter
// widths of Helvetica, Times and Courier, so every word's on-screen position is
// where it goes in the PDF. Each word is measured in the browser, lines are
// split into pages, and the PDF is written with the standard fonts.

import { mulM, standardFont, sampleColors, keepTypeable, winAnsiCode, stdName } from "./page-text.js";
import { deflate } from "./images.js";

const SCALE = 2; // pages are drawn at 2x (144 dpi) for cutting out pictures...
// ...but never bigger than this. iPhones refuse canvases over ~16.7 megapixels,
// and PDFs made on a phone often have huge pages (3024 x 4032 points, the size
// of the photo), which at 2x would be 49 megapixels.
const MAX_PIXELS = 8e6;
const ASCENT = 0.905, DESCENT = 0.212; // must match the @font-face overrides in app.css
const BULLET_RE = /^\s*([•●▪◦‣■□➢➤✓-]|\(?\d{1,2}[.)]|\(?[a-z][.)])\s/;
const PAGE_NUMBER_RE = /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i;
const FAMILIES = { Helvetica: "PDF Helvetica", Times: "PDF Times", Courier: "PDF Courier" };
const CSS_STACK = { Helvetica: '"PDF Helvetica", Arial, sans-serif', Times: '"PDF Times", "Times New Roman", serif',
  Courier: '"PDF Courier", "Courier New", monospace' };
const INK = { black: "#000000", blue: "#0d3399", red: "#b3261e" };

let editor = null;

export function disposeDocEdit() {
  editor?.dispose();
  editor = null;
}

// ctx: helpers from app.js { h, job, openPdfjs, pdfjs, setStatus, showResults, doubleCheck, stem, guard, isBusy }
export function docEditView(it, ctx) {
  if (!editor || editor.it !== it) {
    disposeDocEdit();
    editor = createDocEditor(it, ctx);
  }
  editor.update();
  return [editor.el];
}

// ---------------------------------------------------------------- reading ---

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

// Boxes (page units) of the pictures drawn on a page
function findImages(ops, OPS, vpT) {
  const out = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  for (let k = 0; k < ops.fnArray.length; k++) {
    const fn = ops.fnArray[k], args = ops.argsArray[k];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mulM(args, ctm);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (Array.isArray(args?.[0])) ctm = mulM(args[0], ctm); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
      const m = mulM(ctm, vpT);
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      if (box.w >= 20 && box.h >= 20) out.push(box);
    }
  }
  // pictures made of several touching pieces become one
  const merged = [];
  for (const b of out) {
    let cur = { ...b };
    for (let i = merged.length - 1; i >= 0; i--) {
      const o = merged[i];
      if (cur.x <= o.x + o.w + 2 && o.x <= cur.x + cur.w + 2 && cur.y <= o.y + o.h + 2 && o.y <= cur.y + cur.h + 2) {
        const x = Math.min(cur.x, o.x), y = Math.min(cur.y, o.y);
        cur = { x, y, w: Math.max(cur.x + cur.w, o.x + o.w) - x, h: Math.max(cur.y + cur.h, o.y + o.h) - y };
        merged.splice(i, 1);
      }
    }
    merged.push(cur);
  }
  return merged;
}

// Splits a piece of text into words with their colours. Word positions are
// estimated with the matching font (same letter widths), scaled to the piece.
const measurer = document.createElement("canvas").getContext("2d");
function wordColors(str, font, x, width, base, size, canvas, scale, pixels) {
  measurer.font = `${font.italic ? "italic " : ""}${font.bold ? 700 : 400} 100px "${FAMILIES[font.family]}"`;
  const k = width / (measurer.measureText(str).width || 1);
  const out = [];
  const lead = /^\s*/.exec(str)[0];
  for (const m of str.matchAll(/\S+\s*/g)) {
    const x0 = x + measurer.measureText(str.slice(0, m.index)).width * k;
    const w = measurer.measureText(m[0].trimEnd()).width * k;
    const color = sampleColors(canvas, scale, { x: x0, y: base - 0.8 * size, w, h: 0.95 * size }, pixels).ink;
    const prev = out[out.length - 1];
    if (prev && prev.color.every((v, i) => Math.abs(v - color[i]) < 0.08)) prev.text += m[0];
    else out.push({ text: m[0], color });
  }
  if (out.length) out[0].text = lead + out[0].text;
  return out.length ? out : [{ text: str, color: [0, 0, 0] }];
}

// The editor's fonts must be loaded before words are measured with them
async function loadFonts() {
  const faces = [];
  for (const fam of Object.values(FAMILIES)) {
    for (const v of ["400", "700", "italic 400", "italic 700"]) faces.push(document.fonts.load(`${v} 16px "${fam}"`));
  }
  await Promise.all(faces).catch(() => {});
}

// One page -> { w, h, lines, images }. Lines: { x0, x1, baseline, size, runs }.
async function readPage(page, lib) {
  const vp = page.getViewport({ scale: 1 });
  const scale = Math.min(SCALE, Math.sqrt(MAX_PIXELS / (vp.width * vp.height)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width * scale);
  canvas.height = Math.ceil(vp.height * scale);
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) throw new Error("this device ran out of memory for drawing pages");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: g, viewport: page.getViewport({ scale }), intent: "print" }).promise;
  const ops = await page.getOperatorList({ intent: "print" });
  const tc = await page.getTextContent();

  let images = findImages(ops, lib.OPS, vp.transform);
  const pixels = g.getImageData(0, 0, canvas.width, canvas.height);

  // text pieces -> lines of runs
  const lines = [];
  let cur = null;
  for (const it of tc.items) {
    if (typeof it.str !== "string") continue;
    const m = mulM(it.transform, vp.transform);
    const size = Math.hypot(m[2], m[3]);
    if (!it.str.trim()) {
      if (cur) cur.space = true;
      if (it.hasEOL) cur = null;
      continue;
    }
    if (!(size > 1) || m[0] <= 0 || Math.abs(m[1]) > 0.02 * m[0] || Math.abs(m[2]) > 0.02 * size) { cur = null; continue; }
    const x = m[4], base = m[5];
    // superscripts and subscripts (km³, footnote marks) stay on their line
    const dy = cur ? base - cur.baseline : 0;
    // a small bullet drawn on its own, a little raised, starts the line that follows it
    const bulletOnly = cur && /^[•·▪◦‣∙●\-]\s*$/.test(cur.runs.map((r) => r.text).join("")) &&
      x > cur.x1 && x - cur.x1 < 3 * size && Math.abs(dy) < 0.8 * size;
    if (bulletOnly) {
      Object.assign(cur, { baseline: base, size });
      cur.runs = [{ ...cur.runs[0], text: "• ", size, shift: null }];
    }
    const same = cur && (bulletOnly || (x > cur.x1 - 0.5 * size && x - cur.x1 < 1.5 * Math.max(size, cur.size) &&
      (Math.abs(dy) < 0.2 * cur.size || (size < 0.85 * cur.size && Math.abs(dy) < 0.6 * cur.size))));
    const shift = same && !bulletOnly && dy < -0.1 * cur.size ? "super" : same && !bulletOnly && dy > 0.1 * cur.size ? "sub" : null;
    // text far to the right on the same line (dates on a resume) stays with it,
    // pushed to the right edge
    const right = !same && cur && !cur.rightOf && x > cur.x1 + 1.5 * size && Math.abs(dy) < 0.2 * cur.size &&
      x + it.width > 0.75 * vp.width;
    if (!same) {
      cur = { x0: x, x1: x, baseline: base, size, runs: [], rightOf: right ? cur : null };
      lines.push(cur);
    } else if ((cur.space || x - cur.x1 > 0.15 * size) && !/\s$/.test(cur.runs[cur.runs.length - 1].text)) {
      cur.runs[cur.runs.length - 1].text += " ";
    }
    cur.space = false;
    const font = standardFont(page, tc.styles[it.fontName], it.fontName);
    // one piece of text can hold words in different colours (links, highlights),
    // so each word's colour is read from the drawn page
    for (const wd of wordColors(it.str, font, x, it.width, base, size, canvas, scale, pixels)) {
      cur.runs.push({ text: keepTypeable(wd.text), family: font.family, bold: font.bold, italic: font.italic, size, color: wd.color, shift });
    }
    if (!shift) cur.size = Math.max(cur.size, size);
    cur.x1 = Math.max(cur.x1, x + it.width);
    if (it.hasEOL) cur = null;
  }
  for (const l of lines) l.text = l.runs.map((r) => r.text).join("");
  let kept = lines.filter((l) => l.text.trim());

  // a picture covering most of a page that also has text is a background (or a
  // scan with recognised text): keep the text, leave the picture out
  const area = vp.width * vp.height;
  if (kept.length) images = images.filter((b) => b.w * b.h < 0.6 * area);
  // labels printed on a picture stay part of the picture
  const inImage = (l) => images.some((b) => {
    const cx = (l.x0 + l.x1) / 2, cy = l.baseline - 0.3 * l.size;
    return cx > b.x && cx < b.x + b.w && cy > b.y && cy < b.y + b.h;
  });
  kept = kept.filter((l) => !inImage(l));
  // page numbers mean nothing once the text reflows
  kept = kept.filter((l) => !(PAGE_NUMBER_RE.test(l.text.trim()) && (l.baseline > 0.9 * vp.height || l.baseline < 0.1 * vp.height)));

  const pics = [];
  for (const b of images) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(b.w * scale));
    c.height = Math.max(1, Math.round(b.h * scale));
    const cg = c.getContext("2d");
    if (!cg) continue; // a picture that can't be cut out is left out, not the whole PDF
    cg.drawImage(canvas, b.x * scale, b.y * scale, b.w * scale, b.h * scale, 0, 0, c.width, c.height);
    pics.push({ ...b, src: c.toDataURL("image/jpeg", 0.9) });
    c.width = c.height = 0; // iPhones count canvas memory until it's released
  }
  canvas.width = canvas.height = 0; // free the memory now
  return { w: vp.width, h: vp.height, lines: kept, images: pics };
}

// Pages -> document blocks: paragraphs ({ type: "p", runs, align, size, spaceBefore })
// and pictures ({ type: "img", src, w, h, x, spaceBefore })
function buildDocument(pages) {
  const allLines = pages.flatMap((p) => p.lines);
  const ratios = [];
  for (const p of pages) {
    for (let i = 1; i < p.lines.length; i++) {
      const a = p.lines[i - 1], b = p.lines[i];
      const d = b.baseline - a.baseline;
      if (d > 0 && d < 3 * a.size && Math.abs(a.size - b.size) < 0.1 * a.size) ratios.push(d / a.size);
    }
  }
  const lineRatio = Math.min(2.2, Math.max(1.05, median(ratios) || 1.2));
  const left = pct(allLines.map((l) => l.x0), 0.1) || 72;
  const right = pct(allLines.map((l) => l.x1), 0.9) || (pages[0]?.w ?? 612) - 72;
  const margins = {
    l: Math.max(18, Math.min(left, 144)),
    r: Math.max(18, Math.min((pages[0]?.w ?? 612) - right, 144)),
    t: Math.max(36, Math.min(median(pages.filter((p) => p.lines.length).map((p) => p.lines.reduce((m, l) => Math.min(m, l.baseline - l.size), 1e9))) || 72, 108)),
    b: 72,
  };
  const colL = margins.l, colR = (pages[0]?.w ?? 612) - margins.r, colMid = (colL + colR) / 2;
  const centered = (l) => Math.abs((l.x0 + l.x1) / 2 - colMid) < 0.04 * (colR - colL) && l.x0 > colL + 2.5 * l.size;
  // a line ends its paragraph early if the next line's first word would have fit on it
  const firstWord = (l) => {
    const r = l.runs[0];
    measurer.font = `${r.italic ? "italic " : ""}${r.bold ? 700 : 400} 100px "${FAMILIES[r.family]}"`;
    return measurer.measureText(`${/\S+/.exec(l.text)?.[0] || ""} `).width * r.size / 100;
  };
  // the right edge of the column a line is in: its neighbours with the same left
  // edge (text beside a picture makes a narrower column)
  for (const p of pages) {
    p.lines.forEach((l, i) => {
      l.right = l.x1;
      for (const o of [p.lines[i - 1], p.lines[i + 1]]) {
        if (o && Math.abs(o.x0 - l.x0) < l.size && Math.abs(o.baseline - l.baseline) < lineRatio * l.size * 1.4) l.right = Math.max(l.right, o.x1);
      }
    });
  }
  const short = (l, next) => (next ? l.right : colR) - l.x1 > (next ? firstWord(next) : 2.5 * l.size) + 0.5 * l.size;

  const blocks = [];
  let para = null, last = null, lastPage = -1;
  // pictures wait until the paragraph they were next to has ended
  const waiting = [];
  const flushPics = () => {
    for (const b of waiting.splice(0)) {
      blocks.push({ type: "img", src: b.src, w: b.w, h: b.h, x: b.x,
        centered: Math.abs(b.x + b.w / 2 - colMid) < 0.06 * (colR - colL), spaceBefore: 10 });
    }
  };
  const endPara = () => { if (para) blocks.push(para); para = null; flushPics(); };
  pages.forEach((p, pi) => {
    const pics = [...p.images].sort((a, b) => a.y - b.y);
    for (const l of p.lines) {
      if (l.rightOf && para && last === l.rightOf) {
        para.right = l.runs.map((r) => ({ ...r }));
        para.closed = true; // nothing joins a line that has right-hand text
        continue;
      }
      while (pics.length && pics[0].y < l.baseline - l.size) waiting.push(pics.shift());
      if (!para) flushPics();
      let brk = true;
      let gap = 0;
      if (para && last && lastPage === pi) {
        const d = l.baseline - last.baseline;
        gap = d - lineRatio * l.size;
        brk = d <= 0.5 * l.size || d > lineRatio * last.size * 1.4 || Math.abs(l.size - last.size) > 0.12 * last.size ||
          short(last, l) || BULLET_RE.test(l.text) || centered(l) !== centered(last) || para.closed;
      } else if (para && last && lastPage === pi - 1) {
        // a paragraph running on from the previous page
        brk = short(last, l) || !/^[a-z]/.test(l.text.trim());
        gap = 10;
      } else gap = lastPage >= 0 ? 12 : 0;
      if (waiting.length && brk) gap = 10;
      if (brk) {
        endPara();
        para = { type: "p", runs: [], align: centered(l) ? "center" : "left", size: l.size,
          spaceBefore: Math.max(0, Math.min(40, gap)), lineRatio };
      } else {
        // join the lines: a word broken with a hyphen is put back together
        const prev = para.runs[para.runs.length - 1];
        if (/[a-z]-$/.test(prev.text) && /^[a-z]/.test(l.text)) prev.text = prev.text.slice(0, -1);
        else if (!/\s$/.test(prev.text)) prev.text += " ";
      }
      for (const r of l.runs) {
        const prev = para.runs[para.runs.length - 1];
        if (prev && prev.family === r.family && prev.bold === r.bold && prev.italic === r.italic && prev.shift === r.shift &&
          Math.abs(prev.size - r.size) < 0.3 && prev.color.every((v, i) => Math.abs(v - r.color[i]) < 0.06)) prev.text += r.text;
        else para.runs.push({ ...r });
      }
      last = l;
      lastPage = pi;
    }
    waiting.push(...pics);
    if (!para) flushPics();
  });
  endPara();
  for (const b of blocks) if (b.type === "p") b.runs.forEach((r, i) => { if (i === b.runs.length - 1) r.text = r.text.replace(/\s+$/, ""); });
  return { pageW: pages[0]?.w ?? 612, pageH: pages[0]?.h ?? 792, margins, blocks, lineRatio };
}

// ----------------------------------------------------------------- editor ---

function createDocEditor(it, ctx) {
  const { h } = ctx;
  let model = null;
  let disposed = false;
  let savedRange = null;
  let scale = 1;

  // --- toolbar (buttons keep the text selection: they never take focus)
  const cmd = (name, value) => () => { restoreSelection(); document.execCommand("styleWithCSS", false, true); document.execCommand(name, false, value); sheet.focus(); queueBreaks(); };
  const btn = (label, title, action, cls = "") => {
    const b = h("button", { type: "button", class: `icon-btn ${cls}`, title, "aria-label": title }, label);
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", action);
    return b;
  };
  const fontSel = h("select", { "aria-label": "Font", onchange: (e) => { cmd("fontName", FAMILIES[e.target.value])(); } },
    h("option", { value: "Times" }, "Serif"), h("option", { value: "Helvetica" }, "Sans"), h("option", { value: "Courier" }, "Mono"));
  const toolbar = h("div", { class: "sign-toolbar doc-toolbar" },
    h("span", { class: "tool-group" },
      btn(h("b", {}, "B"), "Bold", cmd("bold")),
      btn(h("i", {}, "I"), "Italic", cmd("italic")),
      btn(h("u", {}, "U"), "Underline", cmd("underline")),
      btn("A−", "Smaller text", () => resize(1 / 1.12)),
      btn("A+", "Bigger text", () => resize(1.12)),
      fontSel),
    h("span", { class: "tool-group" },
      ...Object.entries(INK).map(([k, v]) => btn("", `${k} text`, cmd("foreColor", v), `swatch ${k}`)),
      btn(icon("M4 6h16M4 10h10M4 14h16M4 18h10"), "Align left", cmd("justifyLeft")),
      btn(icon("M4 6h16M7 10h10M4 14h16M7 18h10"), "Center", cmd("justifyCenter")),
      btn(icon("M4 6h16M10 10h10M4 14h16M10 18h10"), "Align right", cmd("justifyRight")),
      btn(icon("M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"), "Undo", cmd("undo")),
      btn(icon("m15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3"), "Redo", cmd("redo"))));
  function icon(d) {
    return h("span", { class: "tb-icon", html: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>` });
  }
  const hint = h("p", { class: "hint sign-hint" }, "Reading the PDF…");
  const sheet = h("div", { class: "doc-sheet", contenteditable: "true", spellcheck: "true", role: "textbox",
    "aria-multiline": "true", "aria-label": "Document text" });
  const breaks = h("div", { class: "doc-breaks", "aria-hidden": "true" });
  const scaler = h("div", { class: "doc-scaler" }, sheet, breaks);
  const frame = h("div", { class: "doc-frame" }, scaler);
  const saveBtn = h("button", { type: "button", class: "btn primary", onclick: () => ctx.guard(save) }, "Save PDF");
  const pageCount = h("span", { class: "hint" });
  const footer = h("div", { class: "sign-footer" }, pageCount, saveBtn);
  const el = h("div", { class: "sign-editor doc-editor" }, toolbar, hint, frame, footer);
  toolbar.hidden = footer.hidden = true;

  // --- selection memory, so the font menu (which takes focus) still applies
  const onSel = () => {
    const s = getSelection();
    if (s.rangeCount && sheet.contains(s.getRangeAt(0).commonAncestorContainer)) savedRange = s.getRangeAt(0).cloneRange();
  };
  document.addEventListener("selectionchange", onSel);
  function restoreSelection() {
    if (!savedRange) return;
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(savedRange);
  }

  // bigger/smaller: mark the selection with the browser's size 7, then swap
  // those marks for real sizes
  function resize(f) {
    restoreSelection();
    const s = getSelection();
    if (!s.rangeCount || s.isCollapsed) { hint.textContent = "Select some text first, then make it bigger or smaller."; return; }
    const base = parseFloat(getComputedStyle(s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement).fontSize) || 12;
    document.execCommand("styleWithCSS", false, false);
    document.execCommand("fontSize", false, "7");
    const spans = [];
    for (const font of sheet.querySelectorAll('font[size="7"]')) {
      const span = document.createElement("span");
      span.style.fontSize = `${Math.round(Math.min(96, Math.max(5, base * f)) * 10) / 10}px`;
      span.append(...font.childNodes);
      font.replaceWith(span);
      spans.push(span);
    }
    // keep the same text selected, so it can be changed again
    if (spans.length) {
      const r = document.createRange();
      r.setStartBefore(spans[0]);
      r.setEndAfter(spans[spans.length - 1]);
      s.removeAllRanges();
      s.addRange(r);
      savedRange = r.cloneRange();
    }
    queueBreaks();
  }

  // keep pasted text plain, and new paragraphs as <p>
  sheet.addEventListener("paste", (e) => {
    e.preventDefault();
    document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
  });
  sheet.addEventListener("focus", () => document.execCommand("defaultParagraphSeparator", false, "p"));
  sheet.addEventListener("input", () => queueBreaks());

  // --- fit the page to the screen width
  function fit() {
    if (!model) return;
    const w = frame.clientWidth;
    scale = Math.min(1.6, w / model.pageW);
    scaler.style.transform = `scale(${scale})`;
    frame.style.height = `${sheet.offsetHeight * scale}px`;
  }
  const ro = new ResizeObserver(() => fit());
  ro.observe(frame);
  ro.observe(sheet);

  // --- page break markers
  let breakTimer = 0;
  function queueBreaks() {
    clearTimeout(breakTimer);
    breakTimer = setTimeout(drawBreaks, 300);
  }
  function drawBreaks() {
    if (!model || disposed) return;
    const { pages } = layout();
    breaks.replaceChildren(...pages.slice(1).map((p, i) => {
      const m = h("div", { class: "doc-break" }, h("span", {}, `Page ${i + 2}`));
      m.style.top = `${p.startY}px`;
      return m;
    }));
    pageCount.textContent = `${pages.length} page${pages.length === 1 ? "" : "s"}`;
  }

  // --- build the editable document
  async function init() {
    try {
      const lib = await ctx.pdfjs();
      await loadFonts();
      const doc = await ctx.openPdfjs(it.data, it.password);
      const pages = [];
      try {
        for (let i = 1; i <= doc.numPages; i++) {
          if (disposed) return;
          hint.textContent = `Reading page ${i} of ${doc.numPages}…`;
          pages.push(await readPage(await doc.getPage(i), lib));
        }
      } finally {
        await doc.close();
      }
      model = buildDocument(pages);
      if (!model.blocks.some((b) => b.type === "p")) {
        hint.textContent = "This PDF has no text to edit (it's probably a scan). Switch to Exact layout to cover parts of it and type on top.";
        return;
      }
      render();
      toolbar.hidden = footer.hidden = false;
      hint.textContent = "Select text to make it bold, bigger or a different colour. Pictures can be deleted, not moved.";
    } catch (e) {
      console.error(e);
      hint.textContent = `This PDF couldn't be read${e?.message ? ` (${e.message})` : ""}. Exact layout may still work.`;
    }
  }

  function render() {
    const { margins: m, pageW } = model;
    Object.assign(sheet.style, { width: `${pageW}px`, padding: `${m.t}px ${m.r}px ${m.b}px ${m.l}px` });
    const nodes = model.blocks.map((b) => {
      if (b.type === "img") {
        const img = h("img", { src: b.src, alt: "", draggable: "false" });
        img.style.width = `${Math.min(b.w, pageW - m.l - m.r)}px`;
        const fig = h("figure", { contenteditable: "false" }, img);
        fig.style.marginTop = `${b.spaceBefore}px`;
        if (b.centered) fig.style.textAlign = "center";
        else fig.style.paddingLeft = `${Math.max(0, Math.min(b.x - m.l, pageW - m.l - m.r - b.w))}px`;
        return fig;
      }
      const p = h("p", {});
      Object.assign(p.style, { textAlign: b.align, marginTop: `${b.spaceBefore}px`, lineHeight: String(b.lineRatio),
        fontSize: `${b.size}px` });
      const runEl = (r) => {
        const span = h("span", {}, r.text);
        Object.assign(span.style, { fontFamily: CSS_STACK[r.family], fontWeight: r.bold ? "700" : "400",
          fontStyle: r.italic ? "italic" : "normal", fontSize: `${Math.round(r.size * 10) / 10}px`,
          color: `rgb(${r.color.map((v) => Math.round(v * 255)).join(" ")})` });
        if (r.shift) span.style.verticalAlign = r.shift;
        return span;
      };
      if (b.right) {
        const right = h("span", { class: "doc-right" }, b.right.map(runEl));
        right.style.float = "right";
        p.append(right);
      }
      p.append(...b.runs.map(runEl));
      return p;
    });
    sheet.replaceChildren(...nodes);
    fit();
    queueBreaks();
  }

  // --- measure every word and picture, and split the lines into pages
  function layout() {
    const { pageW, pageH, margins: m } = model;
    const o = sheet.getBoundingClientRect();
    const k = o.width / pageW; // screen pixels per point
    const pieces = [];
    let unsupported = 0;
    const walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || el.closest("figure")) continue;
      const cs = getComputedStyle(el);
      const size = parseFloat(cs.fontSize);
      const fam = /Courier|mono/i.test(cs.fontFamily) ? "Courier" : /Times|serif/i.test(cs.fontFamily.replace(/sans-serif/i, "")) ? "Times" : "Helvetica";
      const bold = (parseInt(cs.fontWeight, 10) || 400) >= 600;
      const italic = cs.fontStyle !== "normal";
      const color = (cs.color.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map((v) => Math.round(Number(v) / 255 * 1000) / 1000);
      let underline = false;
      for (let a = el; a && a !== sheet; a = a.parentElement) if (/underline/.test(getComputedStyle(a).textDecorationLine)) underline = true;
      for (const mt of node.data.matchAll(/\S+/g)) {
        range.setStart(node, mt.index);
        range.setEnd(node, mt.index + mt[0].length);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0);
        // a word split over two lines (long links) is measured letter by letter
        const parts = rects.length <= 1 ? [[mt[0], rects[0]]] : splitWord(node, mt.index, mt[0], range);
        for (const [text, r] of parts) {
          if (!r) continue;
          const clean = [...text].map((ch) => (winAnsiCode(ch) != null ? ch : (unsupported++, "?"))).join("");
          const bottom = (r.bottom - o.top) / k, x = (r.left - o.left) / k;
          const baseline = bottom - DESCENT * size;
          pieces.push({ kind: "text", text: clean, x, w: r.width / k, baseline, top: baseline - ASCENT * size, bottom,
            font: stdName(fam, bold, italic), size, color, underline });
        }
      }
    }
    for (const img of sheet.querySelectorAll("img")) {
      const r = img.getBoundingClientRect();
      if (!r.width) continue;
      pieces.push({ kind: "img", img, x: (r.left - o.left) / k, top: (r.top - o.top) / k, bottom: (r.bottom - o.top) / k, w: r.width / k, h: r.height / k });
    }
    // lines: pieces sharing a baseline; pictures are lines of their own
    pieces.sort((a, b) => a.top - b.top || a.x - b.x);
    const lines = [];
    for (const p of pieces) {
      const l = lines[lines.length - 1];
      if (l && p.kind === "text" && l.kind === "text" && Math.abs(l.baseline - p.baseline) < 0.5) {
        l.items.push(p); l.top = Math.min(l.top, p.top); l.bottom = Math.max(l.bottom, p.bottom);
      } else lines.push({ kind: p.kind, baseline: p.baseline, top: p.top, bottom: p.bottom, items: [p] });
    }
    // pages: a line that would cross the bottom margin starts the next page
    const room = pageH - m.t - m.b;
    const pages = [{ startY: 0, shift: 0, lines: [] }];
    for (const l of lines) {
      let pg = pages[pages.length - 1];
      if (l.bottom - pg.shift > m.t + room && pg.lines.length) {
        pg = { startY: l.top - 2, shift: l.top - m.t, lines: [] };
        pages.push(pg);
      }
      pg.lines.push(l);
    }
    return { pages, unsupported };
  }

  function splitWord(node, start, word, range) {
    const groups = [];
    for (let i = 0; i < word.length; i++) {
      range.setStart(node, start + i);
      range.setEnd(node, start + i + 1);
      const r = range.getClientRects()[0];
      if (!r) continue;
      const g = groups[groups.length - 1];
      if (g && Math.abs(g.r.bottom - r.bottom) < 1) {
        g.text += word[i];
        g.r = { left: g.r.left, right: r.right, width: r.right - g.r.left, top: g.r.top, bottom: g.r.bottom };
      } else groups.push({ text: word[i], r: { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom } });
    }
    return groups.map((g) => [g.text, g.r]);
  }

  // ------------------------------------------------------------- saving ---

  async function save() {
    if (!model) return;
    ctx.setStatus("Laying out pages…", -1);
    const { pages, unsupported } = layout();
    const { pageW, pageH } = model;
    const pdf = new PdfWriter();
    const fonts = {}; // standard font name -> { key, ref }
    const font = (name) => (fonts[name] ??= { key: `F${Object.keys(fonts).length + 1}`,
      ref: pdf.add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`) });
    const imgCache = new Map();
    const pageRefs = [];
    const pagesRef = pdf.reserve();
    for (const pg of pages) {
      let ops = "";
      const used = {};
      const xobj = {};
      for (const l of pg.lines) {
        for (const p of l.items) {
          if (p.kind === "img") {
            if (!imgCache.has(p.img)) imgCache.set(p.img, await addImage(pdf, p.img));
            const ref = imgCache.get(p.img);
            const name = `Im${ref}`;
            xobj[name] = ref;
            const y = pageH - (p.bottom - pg.shift);
            ops += `q ${n(p.w)} 0 0 ${n(p.h)} ${n(p.x)} ${n(y)} cm /${name} Do Q\n`;
            continue;
          }
          const { key, ref } = font(p.font);
          used[key] = ref;
          const y = pageH - (p.baseline - pg.shift);
          ops += `BT /${key} ${n(p.size)} Tf ${p.color.map(n).join(" ")} rg 1 0 0 1 ${n(p.x)} ${n(y)} Tm ${pdfString(p.text)} Tj ET\n`;
          if (p.underline) ops += `${p.color.map(n).join(" ")} rg ${n(p.x)} ${n(y - 0.12 * p.size)} ${n(p.w)} ${n(0.06 * p.size)} re f\n`;
        }
      }
      const content = pdf.addStream("", await deflate(latin1Bytes(ops)), "/Filter /FlateDecode");
      const fontDict = Object.entries(used).map(([k, r]) => `/${k} ${r} 0 R`).join(" ");
      const xDict = Object.entries(xobj).map(([k, r]) => `/${k} ${r} 0 R`).join(" ");
      pageRefs.push(pdf.add(`<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${n(pageW)} ${n(pageH)}] ` +
        `/Resources << /Font << ${fontDict} >> /XObject << ${xDict} >> >> /Contents ${content} 0 R >>`));
    }
    pdf.set(pagesRef, `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(" ")}] /Count ${pageRefs.length} >>`);
    const catalog = pdf.add(`<< /Type /Catalog /Pages ${pagesRef} 0 R >>`);
    const bytes = pdf.finish(catalog);

    // qpdf tidies the file and checks it; pdf.js then opens it as a second check
    const name = `${ctx.stem(it.file.name)}-edited.pdf`;
    const r = await ctx.job({ op: "runQpdf", inputs: [bytes], commands: [{
      args: ["/in0.pdf", "--object-streams=generate", "/out/doc.pdf"], outputs: ["/out/doc.pdf"], names: [name],
      expectPages: [pages.length], label: "Checking the PDF…" }] }, (t, f) => ctx.setStatus(t, f));
    const out = r.files[0].data;
    await ctx.doubleCheck(out, null, pages.length);
    ctx.setStatus(`Done: ${pages.length} page${pages.length === 1 ? "" : "s"}.` +
      (unsupported ? ` ${unsupported} character${unsupported === 1 ? "" : "s"} the standard fonts can't show became "?".` : "") +
      " Open it and check it before sending.", null, unsupported ? "warn" : "ok");
    ctx.showResults([{ name, data: out, type: "application/pdf" }]);
  }

  init();

  return {
    it,
    el,
    update() { saveBtn.disabled = ctx.isBusy(); },
    dispose() {
      disposed = true;
      ro.disconnect();
      clearTimeout(breakTimer);
      document.removeEventListener("selectionchange", onSel);
    },
  };
}

// --------------------------------------------------------------- PDF file ---

const n = (x) => (Math.round(x * 1000) / 1000).toString();

function pdfString(s) {
  let out = "(";
  for (const ch of s) {
    const code = winAnsiCode(ch) ?? 0x3f;
    if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`;
    else if (code >= 0x20 && code <= 0x7e) out += String.fromCharCode(code);
    else out += `\\${code.toString(8).padStart(3, "0")}`;
  }
  return `${out})`;
}

function latin1Bytes(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return b;
}

// A picture from the editor as a JPEG image object
async function addImage(pdf, img) {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0);
  const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.9));
  const data = new Uint8Array(await blob.arrayBuffer());
  return pdf.addStream(`/Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8`,
    data, "/Filter /DCTDecode");
}

// Minimal PDF writer: numbered objects, then the cross-reference table
class PdfWriter {
  constructor() { this.objs = []; }
  reserve() { this.objs.push(null); return this.objs.length; }
  set(ref, body) { this.objs[ref - 1] = body; }
  add(body) { this.objs.push(body); return this.objs.length; }
  addStream(dict, data, filter = "") {
    return this.add({ dict: `<< ${dict} ${filter} /Length ${data.length} >>`, data });
  }
  finish(root) {
    const parts = [];
    let size = 0;
    const push = (x) => { const b = typeof x === "string" ? latin1Bytes(x) : x; parts.push(b); size += b.length; };
    push("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
    const offsets = [];
    this.objs.forEach((o, i) => {
      offsets.push(size);
      if (typeof o === "string") push(`${i + 1} 0 obj\n${o}\nendobj\n`);
      else { push(`${i + 1} 0 obj\n${o.dict}\nstream\n`); push(o.data); push("\nendstream\nendobj\n"); }
    });
    const xref = size;
    push(`xref\n0 ${this.objs.length + 1}\n0000000000 65535 f \n`);
    for (const off of offsets) push(`${String(off).padStart(10, "0")} 00000 n \n`);
    push(`trailer\n<< /Size ${this.objs.length + 1} /Root ${root} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }
}

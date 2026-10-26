// "Fill & sign" and "Edit PDF": fill a PDF's form fields, change or erase the
// text already on its pages, and place text, dates, check marks and signatures
// anywhere.
//
// Positions are kept in "page units": pdf.js viewport coordinates at scale 1
// (points, y pointing down, page rotation applied), which is exactly what the
// user sees. fill-core.js converts them to PDF coordinates when saving.

import { canvasToPdfImage } from "./images.js";

const LINE_HEIGHT = 1.2; // must match fill-core.js
const FIRST_BASELINE = 0.9465; // likewise
const COLORS = { black: [0, 0, 0], blue: [0.05, 0.2, 0.6] };
const cssColor = ([r, g, b]) => `rgb(${r * 255} ${g * 255} ${b * 255})`;
const MAX_SIG_PX = 1000;

let editor = null; // one editor per loaded file; survives the app's re-renders

export function disposeFillSign() {
  editor?.dispose();
  editor = null;
}

// ctx: helpers from app.js { h, job, openPdfjs, pdfjs, setStatus, showResults, doubleCheck, stem, guard, isBusy, mode }
// mode "edit" starts with the Edit text tool picked
export function fillSignView(it, ctx) {
  if (!editor || editor.it !== it || editor.mode !== ctx.mode) {
    disposeFillSign();
    editor = createEditor(it, ctx);
  }
  editor.update();
  return [editor.el];
}

// ------------------------------------------------------------------ dates ---

const DATE_FORMATS = {
  iso: (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
  long: (d) => d.toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" }),
  dmy: (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`,
  mdy: (d) => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`,
};
const DATE_LABELS = { iso: "2026-10-16", long: "October 16, 2026", dmy: "16/10/2026", mdy: "10/16/2026" };
const pad = (n) => String(n).padStart(2, "0");

// ----------------------------------------------------------------- editor ---

// PDF rectangle [x1 y1 x2 y2] -> box in page units, via the page transform
function toViewBox(m, [x1, y1, x2, y2]) {
  const pts = [[x1, y1], [x2, y1], [x1, y2], [x2, y2]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// [a b c d e f] maps (x, y) -> (a x + c y + e, b x + d y + f)
const mulM = (A, B) => [ // apply A, then B
  A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3],
  A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3],
  A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5],
];
function invertM(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
// box in page units -> PDF rectangle [x1 y1 x2 y2], via the inverse page transform
function pdfRect(inv, { x, y, w, h }) {
  const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => [inv[0] * px + inv[2] * py + inv[4], inv[1] * px + inv[3] * py + inv[5]]);
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
const normText = (s) => s.normalize("NFKC").replace(/\s+/gu, "");

// Retyped text uses the standard PDF fonts, which can show Latin letters and
// common symbols (WinAnsi). Ligatures are split ("ﬁ" -> "fi"), curly quotes and
// dashes kept, and anything else (icon fonts, other scripts) left out.
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const typeable = (ch) => { const c = ch.codePointAt(0); return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.has(ch); };
const toTypeable = (s) => [...s].map((ch) => (typeable(ch) ? ch : [...ch.normalize("NFKC")].every(typeable) ? ch.normalize("NFKC") : ""))
  .join("").replace(/ {2,}/g, " ").trim();

function createEditor(it, ctx) {
  const { h } = ctx;
  const state = {
    pages: [], // { index, page, vp1, wrap, canvas, fieldLayer, itemLayer, scale, rendered }
    fields: new Map(), // fieldName -> { type, value, initial, display, widgetRefs: Set, els: [] }
    items: [],
    edits: [], // { line, item }: lines of the page's own text being changed (item null = deleted)
    tool: null, // 'edittext' | 'erase' | 'text' | 'date' | 'check' | 'cross' | 'signature'
    selected: null,
    signature: null, // { canvas, url } most recent
    color: "black",
    dateFormat: "iso",
    flatten: false,
    doc: null,
    disposed: false,
  };
  let nextItemId = 1;

  // --- toolbar
  const toolBtn = (tool, label, title) => h("button", { type: "button", class: "tool-btn", "data-tool": tool, title,
    "aria-pressed": "false", onclick: () => setTool(state.tool === tool ? null : tool) }, label);
  const sigBtn = h("button", { type: "button", class: "tool-btn", "data-tool": "signature", title: "Add a signature",
    onclick: () => openSignatureDialog() }, "✍ Signature");
  const colorBtns = Object.keys(COLORS).map((c) => h("button", { type: "button", class: `swatch ${c}`, title: `${c} ink`,
    "aria-label": `${c} ink`, onclick: () => setColor(c) }));
  const sizeDown = h("button", { type: "button", class: "icon-btn", "aria-label": "Smaller", onclick: () => scaleSelected(1 / 1.15) }, "A−");
  const sizeUp = h("button", { type: "button", class: "icon-btn", "aria-label": "Bigger", onclick: () => scaleSelected(1.15) }, "A+");
  const dateSel = h("select", { "aria-label": "Date format", onchange: (e) => setDateFormat(e.target.value) },
    Object.entries(DATE_LABELS).map(([k, v]) => h("option", { value: k }, v)));
  const delBtn = h("button", { type: "button", class: "icon-btn", "aria-label": "Delete selected", onclick: () => removeItem(state.selected) }, "🗑");
  const selControls = h("span", { class: "sel-controls" }, sizeDown, sizeUp, dateSel, delBtn);
  const toolbar = h("div", { class: "sign-toolbar" },
    h("span", { class: "tool-group" },
      toolBtn("edittext", "✎ Edit text", "Tap text that's already on the page to change it"),
      toolBtn("erase", "▭ Erase", "Drag a box over anything to remove it"),
      toolBtn("text", "T Text", "Type text anywhere"),
      toolBtn("date", "📅 Date", "Add today's date"),
      toolBtn("check", "✓", "Check mark"),
      toolBtn("cross", "✗", "Cross"),
      sigBtn),
    h("span", { class: "tool-group" }, ...colorBtns, selControls));
  const hint = h("p", { class: "hint sign-hint" });

  // --- pages + footer
  const pagesBox = h("div", { class: "sign-pages" });
  const flattenBox = h("input", { type: "checkbox", onchange: (e) => (state.flatten = e.target.checked) });
  const saveBtn = h("button", { type: "button", class: "btn primary", onclick: () => ctx.guard(save) }, "Save PDF");
  const flattenLabel = h("label", { class: "check" }, flattenBox,
    h("span", {}, " Lock answers in place ", h("span", { class: "hint" }, "(fields become part of the page and can't be edited later)")));
  const footer = h("div", { class: "sign-footer" }, flattenLabel, saveBtn);
  const el = h("div", { class: "sign-editor" }, toolbar, hint, pagesBox, footer);

  // --- signature dialog (created once)
  const dialog = signatureDialog(ctx, (canvas) => {
    state.signature = { canvas, url: canvas.toDataURL() };
    if (pendingSigField) {
      const { page, box } = pendingSigField;
      pendingSigField = null;
      const a = canvas.width / canvas.height;
      let w = box.w, hh = w / a;
      if (hh > box.h) { hh = box.h; w = hh * a; }
      addItem({ type: "image", page, x: box.x + (box.w - w) / 2, y: box.y + (box.h - hh) / 2, w, h: hh, sig: state.signature });
    } else setTool("signature");
  });
  el.append(dialog.el);
  let pendingSigField = null;

  function openSignatureDialog() {
    dialog.open(state.signature, state.color);
  }

  // ------------------------------------------------------------ helpers ---

  function setTool(tool) {
    state.tool = tool;
    for (const b of toolbar.querySelectorAll(".tool-btn")) b.setAttribute("aria-pressed", String(b.dataset.tool === tool));
    el.classList.toggle("placing", !!tool && tool !== "edittext");
    el.dataset.tool = tool || "";
    updateHint();
  }

  function updateHint() {
    const hasFields = state.fields.size > 0;
    const noText = state.tool === "edittext" && state.pages.length && state.pages.every((p) => p.lines && !p.lines.length);
    const msgs = {
      edittext: noText
        ? "No typed text found in this PDF (it's probably a scan). Use ▭ Erase to cover words, then T Text to type new ones."
        : "Tap any line of text to change it. Delete all of a line's text to remove it.",
      erase: "Drag a box over anything to remove it. Tap ▭ Erase again when done.",
      text: "Tap the page where the text should start.",
      date: "Tap the page where the date should go.",
      check: "Tap each spot that needs a check mark. Tap ✓ again when done.",
      cross: "Tap each spot that needs a cross. Tap ✗ again when done.",
      signature: "Tap the page where the signature should go.",
    };
    hint.textContent = msgs[state.tool] || (hasFields
      ? "Fill in the blue boxes, which are the form's own fields. To add anything else, pick a tool above and tap the page."
      : "Pick a tool above, then tap the page to place it. Drag to move, use the corner handle to resize.");
  }

  function setColor(c) {
    state.color = c;
    for (const b of colorBtns) b.classList.toggle("on", b.classList.contains(c));
    const item = state.selected;
    if (item && item.type !== "image" && item.type !== "erase") { item.color = COLORS[c]; layoutItem(item); }
  }

  function setDateFormat(fmt) {
    state.dateFormat = fmt;
    const item = state.selected;
    if (item?.isDate) {
      item.text = DATE_FORMATS[fmt](new Date());
      item.el.querySelector(".item-text").textContent = item.text;
      measureText(item);
    }
  }

  function updateSelControls() {
    const item = state.selected;
    selControls.hidden = !item;
    dateSel.hidden = !item?.isDate;
    if (item?.isDate) dateSel.value = item.dateFormat;
  }

  // -------------------------------------------------------------- pages ---

  async function init() {
    try {
      state.doc = await ctx.openPdfjs(it.data, it.password);
      if (state.disposed) return;
      if (state.doc.isPureXfa) {
        pagesBox.replaceChildren(h("p", { class: "notice" },
          "This form is built with Adobe's dynamic XFA format, which only Adobe Acrobat/Reader can fill. Open it there instead."));
        toolbar.hidden = footer.hidden = true;
        return;
      }
      for (let i = 1; i <= state.doc.numPages; i++) {
        const page = await state.doc.getPage(i);
        const vp1 = page.getViewport({ scale: 1 });
        const p = { index: i - 1, page, vp1 };
        p.canvas = h("canvas", { class: "sign-canvas" });
        p.textLayer = h("div", { class: "text-layer" });
        p.fieldLayer = h("div", { class: "field-layer" });
        p.itemLayer = h("div", { class: "item-layer" });
        p.wrap = h("div", { class: "sign-page", "data-page": i }, p.canvas, p.textLayer, p.fieldLayer, p.itemLayer,
          h("span", { class: "page-label" }, `Page ${i} of ${state.doc.numPages}`));
        // the page fills the column (up to 900px) at its own aspect ratio; its real
        // on-screen size is measured by the ResizeObserver below
        p.wrap.style.aspectRatio = `${vp1.width} / ${vp1.height}`;
        p.scale = Math.min(pagesBox.clientWidth || 800, 900) / vp1.width;
        p.wrap.addEventListener("click", (e) => onPageClick(p, e));
        p.wrap.addEventListener("pointerdown", (e) => onPagePointerDown(p, e));
        state.pages.push(p);
        pagesBox.append(p.wrap);
        await addFields(p);
      }
      observer = new IntersectionObserver((entries) => {
        for (const en of entries) if (en.isIntersecting) renderPage(state.pages[Number(en.target.dataset.page) - 1]);
      }, { rootMargin: "600px 0px" });
      sizeObserver = new ResizeObserver((entries) => {
        for (const en of entries) {
          const p = state.pages[Number(en.target.dataset.page) - 1];
          const scale = en.contentRect.width / p.vp1.width;
          if (!scale || Math.abs(scale - p.scale) * p.vp1.width < 0.5 && p.laidOut) continue;
          p.scale = scale;
          layoutPage(p);
        }
      });
      state.pages.forEach((p) => { layoutPage(p); observer.observe(p.wrap); sizeObserver.observe(p.wrap); });
      flattenLabel.hidden = !state.fields.size;
      updateHint();
    } catch (e) {
      console.error(e);
      pagesBox.replaceChildren(h("p", { class: "notice" }, "This PDF couldn't be displayed."));
    }
  }
  let observer = null, sizeObserver = null;

  // Position fields and items for the page's current on-screen scale, and
  // redraw the page picture at the new size (debounced while resizing).
  function layoutPage(p) {
    p.laidOut = true;
    for (const f of p.fieldEls || []) f.layout();
    for (const l of p.lines || []) layoutLine(l);
    state.items.filter((i) => i.page === p).forEach(layoutItem);
    p.rendered = false;
    clearTimeout(p.renderTimer);
    p.renderTimer = setTimeout(() => { if (isNearViewport(p.wrap)) renderPage(p); }, 120);
  }

  // Re-measure a page's real on-screen scale (also done by the ResizeObserver;
  // this covers the moments it hasn't run yet, e.g. right after a rotation).
  function measure(p) {
    const w = p.wrap.getBoundingClientRect().width;
    const scale = w / p.vp1.width;
    if (scale && Math.abs(scale - p.scale) * p.vp1.width >= 0.5) {
      p.scale = scale;
      layoutPage(p);
    }
  }
  const onWindowResize = () => state.pages.forEach(measure);
  addEventListener("resize", onWindowResize);

  function isNearViewport(node) {
    const r = node.getBoundingClientRect();
    return r.bottom > -600 && r.top < innerHeight + 600;
  }

  async function renderPage(p) {
    if (p.rendered || p.rendering) return;
    p.rendering = true;
    try {
      const lib = await ctx.pdfjs();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = p.page.getViewport({ scale: p.scale * dpr });
      const c = document.createElement("canvas");
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      const g = c.getContext("2d");
      g.fillStyle = "#fff";
      g.fillRect(0, 0, c.width, c.height);
      // form fields are left out of the picture: the editable boxes sit there
      await p.page.render({ canvas: c, canvasContext: g, viewport: vp, intent: "print",
        annotationMode: lib.AnnotationMode.ENABLE_FORMS }).promise;
      p.canvas.replaceWith(c);
      c.className = "sign-canvas";
      p.canvas = c;
      p.rendered = true;
      if (!p.lines) await loadLines(p); // fonts are known once the page has been drawn
    } catch (e) {
      if (e?.name !== "RenderingCancelledException") console.error(e);
    } finally {
      p.rendering = false;
    }
  }

  // ------------------------------------------------------------- fields ---

  async function addFields(p) {
    p.fieldEls = [];
    const annots = await p.page.getAnnotations({ intent: "display" });
    for (const a of annots) {
      if (a.annotationType !== 20 || !a.fieldName || a.hidden || a.noView) continue;
      const m = /^(\d+)R(\d*)$/.exec(a.id || "");
      if (!m) continue;
      const ref = `${m[1]} ${m[2] || 0} R`;
      const box = toViewBox(p.vp1.transform, a.rect);
      const fe = fieldElement(p, a, ref, box);
      if (fe) { p.fieldEls.push(fe); p.fieldLayer.append(fe.el); }
    }
  }

  function fieldRecord(name, type, initial, ref) {
    let f = state.fields.get(name);
    if (!f) {
      f = { type, value: initial, initial, widgetRefs: new Set(), els: [] };
      state.fields.set(name, f);
    }
    f.widgetRefs.add(ref);
    return f;
  }

  function fieldElement(p, a, ref, box) {
    const ro = !!a.readOnly;
    let node, f;
    const fontPt = a.defaultAppearanceData?.fontSize || 0;

    if (a.fieldType === "Tx") {
      f = fieldRecord(a.fieldName, "text", a.fieldValue ?? "", ref);
      node = a.multiLine ? h("textarea", {}) : h("input", { type: "text" });
      if (a.maxLen) node.maxLength = a.maxLen;
      node.value = f.value;
      node.disabled = ro;
      node.addEventListener("input", () => setField(a.fieldName, node.value, node));
      if (a.comb && a.maxLen) node.classList.add("comb");
    } else if (a.fieldType === "Btn" && (a.checkBox || a.radioButton)) {
      const on = a.checkBox ? a.exportValue : a.buttonValue;
      if (!on) return null;
      f = fieldRecord(a.fieldName, a.checkBox ? "checkbox" : "radio", a.fieldValue || "Off", ref);
      node = h("button", { type: "button", class: `toggle ${a.radioButton ? "radio" : ""}`, role: a.radioButton ? "radio" : "checkbox",
        "data-on": on, disabled: ro, "aria-label": `${a.fieldName} ${on}` });
      node.addEventListener("click", (e) => {
        e.stopPropagation();
        const cur = state.fields.get(a.fieldName).value;
        setField(a.fieldName, cur === on ? (a.radioButton && a.noToggleToOff ? on : "Off") : on);
      });
    } else if (a.fieldType === "Ch" && a.options?.length) {
      f = fieldRecord(a.fieldName, "choice", Array.isArray(a.fieldValue) ? a.fieldValue[0] ?? "" : a.fieldValue ?? "", ref);
      node = h("select", { disabled: ro },
        h("option", { value: "" }, ""),
        a.options.map((o) => h("option", { value: o.exportValue }, o.displayValue)));
      node.value = f.value;
      f.options = a.options;
      node.addEventListener("change", () => setField(a.fieldName, node.value, node));
    } else if (a.fieldType === "Sig") {
      node = h("button", { type: "button", class: "sig-field" }, "Sign here");
      node.addEventListener("click", (e) => {
        e.stopPropagation();
        pendingSigField = { page: p, box };
        openSignatureDialog();
      });
      const fe = { el: node, layout: () => place(node, p, box) };
      fe.layout();
      return fe;
    } else return null;

    node.classList.add("field");
    node.title = a.alternativeText || a.fieldName;
    if (f) f.els.push(node);
    const fe = {
      el: node,
      layout: () => {
        place(node, p, box);
        const auto = Math.min(box.h * 0.7, 12);
        node.style.fontSize = `${(a.multiLine ? fontPt || 10 : fontPt || auto) * p.scale}px`;
        if (node.classList.contains("comb")) {
          const cell = box.w / a.maxLen;
          node.style.letterSpacing = `${(cell - 0.6 * (fontPt || auto)) * p.scale}px`;
          node.style.paddingLeft = `${(cell / 2 - 0.3 * (fontPt || auto)) * p.scale}px`;
        }
      },
    };
    fe.layout();
    syncField(a.fieldName);
    return fe;
  }

  function place(node, p, box) {
    Object.assign(node.style, { left: `${box.x * p.scale}px`, top: `${box.y * p.scale}px`,
      width: `${box.w * p.scale}px`, height: `${box.h * p.scale}px` });
  }

  function setField(name, value, source) {
    const f = state.fields.get(name);
    f.value = value;
    syncField(name, source);
  }

  function syncField(name, source) {
    const f = state.fields.get(name);
    for (const node of f.els) {
      if (node === source) continue;
      if (node.tagName === "BUTTON") node.setAttribute("aria-checked", String(f.value === node.dataset.on));
      else if (node.value !== f.value) node.value = f.value;
    }
  }

  // ------------------------------------------------------ existing text ---

  // Groups the page's text into lines that can be tapped and retyped. Each line
  // remembers where it is, in page units for the screen and in PDF units for
  // removing it, plus its font, size and colours.
  async function loadLines(p) {
    p.lines = [];
    let tc;
    try {
      tc = await p.page.getTextContent();
    } catch {
      return;
    }
    const inv = invertM(p.vp1.transform);
    p.textItems = []; // every piece of text, in order, for checking the result
    let cur = null;
    let blank = null; // spaces just before a line: removing the line removes them too
    for (const it2 of tc.items) {
      if (typeof it2.str !== "string") continue;
      const t = it2.transform;
      p.textItems.push({ str: it2.str, x: t[4], y: t[5] });
      if (!it2.str.trim()) {
        if (cur && it2.hasEOL) cur = null;
        const m = mulM(t, p.vp1.transform);
        blank ??= { x: m[4], base: m[5] };
        continue;
      }
      const m = mulM(t, p.vp1.transform); // text space -> page units
      const size = Math.hypot(m[2], m[3]);
      // only text running left to right on screen can be retyped in place
      if (!(size > 1) || m[0] <= 0 || Math.abs(m[1]) > 0.02 * m[0] || Math.abs(m[2]) > 0.02 * size) { cur = null; continue; }
      const x = m[4], base = m[5], w = it2.width;
      const sameLine = cur && Math.abs(base - cur.baseline) < 0.2 * size && Math.abs(size - cur.size) < 0.25 * size &&
        x > cur.x1 - 0.5 * size && x - cur.x1 < 1.2 * size;
      if (!sameLine) {
        cur = { page: p, text: "", x0: x, x1: x, baseline: base, size, fontName: it2.fontName, items: [] };
        cur.start = blank && Math.abs(blank.base - base) < 0.2 * size && blank.x < x && x - blank.x < 4 * size ? blank.x : x;
        p.lines.push(cur);
      } else if (x - cur.x1 > 0.15 * size && !/\s$/.test(cur.text)) cur.text += " ";
      cur.text += it2.str;
      cur.x1 = Math.max(cur.x1, x + w);
      cur.items.push(p.textItems.length - 1);
      blank = null;
      if (it2.hasEOL) cur = null;
    }
    for (const l of p.lines) l.text = toTypeable(l.text);
    p.lines = p.lines.filter((l) => l.text); // e.g. a line of icons only
    for (const l of p.lines) {
      l.font = lineFont(p, tc.styles[l.fontName], l.fontName);
      // box covering the letters on screen (also drawn over them if needed)
      l.box = { x: l.x0 - 0.5, y: l.baseline - 0.95 * l.size, w: l.x1 - l.x0 + 1, h: 1.22 * l.size };
      l.coverRect = pdfRect(inv, l.box);
      // where the line's text starts: on its baseline, from its left edge
      l.removeRect = pdfRect(inv, { x: l.start - 1, y: l.baseline - 0.25 * l.size, w: l.x1 - l.start + 1, h: 0.5 * l.size });
      l.hit = h("div", { class: "text-hit", title: "Tap to change this text" });
      l.hit.addEventListener("click", (e) => {
        if (state.tool !== "edittext") return;
        e.stopPropagation();
        startEdit(l);
      });
      p.textLayer.append(l.hit);
      layoutLine(l);
    }
    updateHint();
  }

  function layoutLine(l) {
    place(l.hit, l.page, l.box);
    if (l.mask) place(l.mask, l.page, l.box);
  }

  // The closest standard font: Helvetica, Times or Courier, bold and/or italic
  function lineFont(p, style, id) {
    let f = null;
    try { f = p.page.commonObjs.has(id) ? p.page.commonObjs.get(id) : null; } catch { /* not loaded */ }
    const name = String(f?.name || "").replace(/^[A-Z]{6}\+/, "");
    const mono = f?.isMonospace || /courier|mono|consol/i.test(name) || style?.fontFamily === "monospace";
    const serif = !mono && !/sans|arial|helvet|calibri|verdana/i.test(name) &&
      (f?.isSerifFont || /times|serif|georgia|garamond|cambria|roman|minion|palatino|book/i.test(name) || style?.fontFamily === "serif");
    const bold = !!(f?.bold || f?.black) || /bold|black|heavy|semibold|demi/i.test(name);
    const italic = !!f?.italic || /italic|oblique/i.test(name);
    const family = mono ? "Courier" : serif ? "Times" : "Helvetica";
    const slant = family === "Times" ? "Italic" : "Oblique";
    const std = family === "Times"
      ? `Times-${bold && italic ? "BoldItalic" : bold ? "Bold" : italic ? "Italic" : "Roman"}`
      : `${family}${bold || italic ? "-" : ""}${bold ? "Bold" : ""}${italic ? slant : ""}`;
    return { std, css: `PDF ${family}`, bold, italic };
  }

  // Colours under a box on the drawn page: the background (most common colour
  // around its edge) and, for text, the ink (the pixels least like it).
  function sampleColors(p, box) {
    const c = p.canvas;
    const k = c.width / p.vp1.width;
    const x = Math.max(0, Math.floor(box.x * k) - 2), y = Math.max(0, Math.floor(box.y * k) - 2);
    const w = Math.min(c.width - x, Math.ceil(box.w * k) + 4), hh = Math.min(c.height - y, Math.ceil(box.h * k) + 4);
    if (w < 3 || hh < 3) return { bg: [1, 1, 1], ink: [0, 0, 0] };
    const px = c.getContext("2d", { willReadFrequently: true }).getImageData(x, y, w, hh).data;
    const at = (i, j) => { const o = (j * w + i) * 4; return [px[o], px[o + 1], px[o + 2]]; };
    const counts = new Map();
    const edge = [];
    for (let i = 0; i < w; i++) edge.push(at(i, 0), at(i, hh - 1));
    for (let j = 0; j < hh; j++) edge.push(at(0, j), at(w - 1, j));
    for (const q of edge) {
      const key = q.map((v) => v >> 3).join();
      const e = counts.get(key) || { n: 0, sum: [0, 0, 0] };
      e.n++; e.sum = e.sum.map((v, i) => v + q[i]);
      counts.set(key, e);
    }
    const top = [...counts.values()].sort((a, b) => b.n - a.n)[0];
    const bg = top.sum.map((v) => v / top.n);
    const dist = (q) => Math.hypot(q[0] - bg[0], q[1] - bg[1], q[2] - bg[2]);
    let max = 0;
    const inner = [];
    for (let j = 2; j < hh - 2; j++) for (let i = 2; i < w - 2; i++) { const q = at(i, j); inner.push(q); max = Math.max(max, dist(q)); }
    const inkPx = inner.filter((q) => dist(q) > 0.8 * max);
    const ink = max > 40 && inkPx.length
      ? [0, 1, 2].map((i) => inkPx.reduce((a, q) => a + q[i], 0) / inkPx.length)
      : [0, 0, 0];
    const unit = (v) => v.map((x) => Math.round(x / 255 * 1000) / 1000);
    // edge smoothing lightens thin letters a little: near-black is black
    const grey = Math.max(...ink) - Math.min(...ink) < 20;
    return { bg: unit(bg), ink: max > 40 && !(grey && Math.max(...ink) < 60) ? unit(ink) : [0, 0, 0] };
  }

  function startEdit(l) {
    if (l.edit?.item) { focusEnd(l.edit.item); return; }
    const p = l.page;
    measure(p);
    if (!l.colors) l.colors = sampleColors(p, l.box);
    if (!l.edit) {
      l.mask = h("div", { class: "text-mask" });
      l.mask.style.background = cssColor(l.colors.bg);
      p.textLayer.insertBefore(l.mask, l.hit);
      layoutLine(l);
      l.edit = { line: l, item: null };
      state.edits.push(l.edit);
    }
    const size = l.size;
    const item = addItem({ type: "text", page: p, x: l.x0, y: l.baseline - FIRST_BASELINE * size, w: 0, h: LINE_HEIGHT * size,
      size, text: l.text, color: l.colors.ink, font: l.font, edit: l.edit }, true);
    item.initial = { x: item.x, y: item.y, size, color: item.color, text: l.text };
    l.edit.item = item;
    focusEnd(item);
  }

  function focusEnd(item) {
    const body = item.el.querySelector(".item-text");
    body.focus();
    const r = document.createRange();
    r.selectNodeContents(body);
    r.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  const unchanged = (item) => item.initial && item.text === item.initial.text && item.x === item.initial.x &&
    item.y === item.initial.y && item.size === item.initial.size && item.color === item.initial.color;

  // An edited line put back exactly as it was: show the original again
  function revertIfUnchanged(item) {
    if (!item?.edit || !unchanged(item)) return;
    const { line } = item.edit;
    item.edit.item = null;
    item.el.remove();
    state.items = state.items.filter((x) => x !== item);
    line.mask.remove();
    line.mask = null;
    state.edits = state.edits.filter((e) => e !== line.edit);
    line.edit = null;
  }

  // Erase: drag out a box on the page
  function onPagePointerDown(p, e) {
    if (state.tool !== "erase" || e.button !== 0 || e.target.closest(".sign-item, .field, .sig-field")) return;
    e.preventDefault();
    measure(p);
    const r = p.wrap.getBoundingClientRect();
    const at = (ev) => [(ev.clientX - r.left) / p.scale, (ev.clientY - r.top) / p.scale];
    const [x0, y0] = at(e);
    const item = addItem({ type: "erase", page: p, x: x0, y: y0, w: 0, h: 0, color: [1, 1, 1] });
    try { p.wrap.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    const move = (ev) => {
      const [x, y] = at(ev);
      Object.assign(item, { x: Math.min(x, x0), y: Math.min(y, y0), w: Math.abs(x - x0), h: Math.abs(y - y0) });
      layoutItem(item);
    };
    const up = (ev) => {
      p.wrap.removeEventListener("pointermove", move);
      p.wrap.removeEventListener("pointerup", up);
      p.wrap.removeEventListener("pointercancel", up);
      swallowClick = ev.type === "pointerup"; // the click that ends this drag
      if (item.w < 4 || item.h < 4) Object.assign(item, { x: x0 - 40, y: y0 - 8, w: 80, h: 16 }); // a tap
      item.color = sampleColors(p, item).bg;
      layoutItem(item);
    };
    p.wrap.addEventListener("pointermove", move);
    p.wrap.addEventListener("pointerup", up);
    p.wrap.addEventListener("pointercancel", up);
  }
  let swallowClick = false;

  // -------------------------------------------------------------- items ---

  function onPageClick(p, e) {
    if (swallowClick) { swallowClick = false; return; }
    if (state.tool === "edittext" || state.tool === "erase") {
      if (!e.target.closest(".sign-item")) select(null);
      return;
    }
    if (!state.tool || e.target.closest(".field, .sign-item, .sig-field")) {
      if (!e.target.closest(".sign-item")) select(null);
      return;
    }
    measure(p);
    const r = p.wrap.getBoundingClientRect();
    const x = (e.clientX - r.left) / p.scale, y = (e.clientY - r.top) / p.scale;
    const tool = state.tool;
    const color = COLORS[state.color];
    if (tool === "text" || tool === "date") {
      const size = 11;
      const text = tool === "date" ? DATE_FORMATS[state.dateFormat](new Date()) : "";
      addItem({ type: "text", page: p, x, y: y - (LINE_HEIGHT * size) / 2, w: 0, h: LINE_HEIGHT * size, size, text, color,
        isDate: tool === "date", dateFormat: state.dateFormat }, tool === "text");
      setTool(null);
    } else if (tool === "check" || tool === "cross") {
      const s = 14;
      addItem({ type: tool, page: p, x: x - s / 2, y: y - s / 2, w: s, h: s, color });
    } else if (tool === "signature" && state.signature) {
      const w = 150, hh = w * state.signature.canvas.height / state.signature.canvas.width;
      addItem({ type: "image", page: p, x: x - w / 2, y: y - hh / 2, w, h: hh, sig: state.signature });
      setTool(null);
    }
  }

  function addItem(item, focus = false) {
    item.id = nextItemId++;
    state.items.push(item);
    const body = item.type === "text"
      ? h("div", { class: "item-text", contenteditable: "plaintext-only", spellcheck: "false" }, item.text)
      : item.type === "erase"
        ? h("div", { class: "erase-fill" })
      : item.type === "image"
        ? h("img", { src: item.sig.url, alt: "Signature", draggable: "false" })
        : h("span", { class: "mark", html: markSvg(item.type) });
    const handle = h("span", { class: "resize-handle", "aria-hidden": "true" });
    const grip = item.type === "text" ? h("span", { class: "grip", title: "Drag to move", "aria-hidden": "true" }, "⠿") : null;
    item.el = h("div", { class: `sign-item ${item.type}` }, grip, body, handle);
    item.page.itemLayer.append(item.el);

    if (item.type === "text") {
      body.addEventListener("input", () => { item.text = body.innerText.replace(/\n$/, ""); measureText(item); });
      body.addEventListener("focus", () => select(item));
      body.addEventListener("blur", () => { if (!item.text.trim()) removeItem(item); });
      body.addEventListener("paste", (e) => { // keep it plain text
        e.preventDefault();
        document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
      });
      if (!body.isContentEditable) body.contentEditable = "true"; // older browsers
    }
    dragBehaviour(item, item.type === "text" ? grip : item.el, false);
    dragBehaviour(item, handle, true);
    item.el.addEventListener("pointerdown", () => select(item));
    layoutItem(item);
    select(item);
    // focus right away (not on the next frame): phones only open the keyboard
  // when focus happens inside the tap itself
  if (focus) body.focus();
    return item;
  }

  function markSvg(type) {
    const path = type === "check"
      ? '<path d="M0.15 0.5 L0.4 0.78 L0.88 0.18"/>'
      : '<path d="M0.18 0.18 L0.82 0.82 M0.18 0.82 L0.82 0.18"/>';
    return `<svg viewBox="0 0 1 1" preserveAspectRatio="none" fill="none" stroke="currentColor" stroke-width="0.12" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  }

  function layoutItem(item) {
    const s = item.page.scale;
    const st = item.el.style;
    st.left = `${item.x * s}px`;
    st.top = `${item.y * s}px`;
    if (item.type === "erase") st.background = cssColor(item.color);
    else st.color = item.color ? cssColor(item.color) : "";
    if (item.type === "text") {
      const body = item.el.querySelector(".item-text");
      body.style.fontSize = `${item.size * s}px`;
      if (item.font) {
        body.style.fontFamily = `"${item.font.css}"`;
        body.style.fontWeight = item.font.bold ? "700" : "400";
        body.style.fontStyle = item.font.italic ? "italic" : "normal";
      }
      st.width = st.height = "";
      measureText(item);
    } else {
      st.width = `${item.w * s}px`;
      st.height = `${item.h * s}px`;
    }
  }

  function measureText(item) {
    const body = item.el.querySelector(".item-text");
    item.w = body.offsetWidth / item.page.scale;
    item.h = body.offsetHeight / item.page.scale;
  }

  function select(item) {
    if (state.selected === item) return;
    const prev = state.selected;
    prev?.el.classList.remove("selected");
    revertIfUnchanged(prev);
    state.selected = item;
    item?.el.classList.add("selected");
    updateSelControls();
  }

  function removeItem(item) {
    if (!item) return;
    if (item.edit) item.edit.item = null; // the line stays hidden: it's deleted
    item.el.remove();
    state.items = state.items.filter((x) => x !== item);
    if (state.selected === item) select(null);
  }

  function scaleSelected(f) {
    const item = state.selected;
    if (!item) return;
    if (item.type === "text") item.size = Math.min(72, Math.max(5, item.size * f));
    else {
      const cx = item.x + item.w / 2, cy = item.y + item.h / 2;
      item.w *= f; item.h *= f;
      item.x = cx - item.w / 2; item.y = cy - item.h / 2;
    }
    layoutItem(item);
  }

  // Drag to move (or, for the corner handle, to resize keeping proportions).
  function dragBehaviour(item, target, resize) {
    target.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      select(item);
      measure(item.page);
      try { target.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      const s = item.page.scale;
      const start = { px: e.clientX, py: e.clientY, x: item.x, y: item.y, w: item.w, h: item.h, size: item.size };
      const move = (ev) => {
        const dx = (ev.clientX - start.px) / s, dy = (ev.clientY - start.py) / s;
        if (resize) {
          const f = Math.max(0.2, (start.w + dx) / start.w);
          if (item.type === "text") item.size = Math.min(72, Math.max(5, start.size * f));
          else if (item.type === "erase") { item.w = Math.max(4, start.w + dx); item.h = Math.max(4, start.h + dy); }
          else { item.w = start.w * f; item.h = start.h * f; }
        } else {
          const pw = item.page.vp1.width, ph = item.page.vp1.height;
          item.x = Math.min(pw - 4, Math.max(-item.w + 4, start.x + dx));
          item.y = Math.min(ph - 4, Math.max(-item.h + 4, start.y + dy));
        }
        layoutItem(item);
      };
      const up = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", up);
    });
  }

  const onKey = (e) => {
    if (e.key === "Escape") { setTool(null); select(null); }
    const editing = document.activeElement?.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    if ((e.key === "Delete" || e.key === "Backspace") && state.selected && !editing) {
      e.preventDefault();
      removeItem(state.selected);
    }
  };
  addEventListener("keydown", onKey);

  // --------------------------------------------------------------- save ---

  async function save() {
    document.activeElement?.blur?.();
    for (const e of [...state.edits]) revertIfUnchanged(e.item);
    const fieldChanges = [];
    for (const f of state.fields.values()) {
      if (f.value === f.initial) continue;
      const change = { widgetRefs: [...f.widgetRefs], type: f.type, value: f.value };
      if (f.type === "choice") change.display = f.options?.find((o) => o.exportValue === f.value)?.displayValue ?? f.value;
      fieldChanges.push(change);
    }
    const items = state.items.filter((i) => i.type !== "erase" && (i.type !== "text" || i.text.trim()));
    const erased = state.items.filter((i) => i.type === "erase");
    if (!fieldChanges.length && !items.length && !state.edits.length && !erased.length) {
      throw new Error("Nothing to save yet. Change some text, fill in a field or add something to a page first.");
    }

    ctx.setStatus("Preparing…", -1);
    const encoded = new Map(); // one PDF image per signature, reused for every placement
    const pageItems = [];
    for (const p of state.pages) {
      const list = [];
      for (const i of items.filter((x) => x.page === p)) {
        const out = { type: i.type, x: i.x, y: i.y, w: i.w, h: i.h };
        if (i.type === "text") Object.assign(out, { text: i.text, size: i.size, color: i.color, font: i.font?.std });
        else if (i.type === "image") {
          if (!encoded.has(i.sig)) encoded.set(i.sig, await canvasToPdfImage(i.sig.canvas));
          const img = encoded.get(i.sig);
          out.image = { dict: img.dict, data: img.data.slice(), smask: img.smask && { dict: img.smask.dict, data: img.smask.data.slice() } };
        } else out.color = i.color;
        list.push(out);
      }
      if (list.length) pageItems.push({ pageIndex: p.index, viewportTransform: p.vp1.transform, items: list });
    }

    // text to remove: retyped or deleted lines, and erased boxes
    const edits = [];
    for (const p of state.pages) {
      const inv = invertM(p.vp1.transform);
      const regions = [
        ...state.edits.filter((e) => e.line.page === p).map(({ line }) =>
          ({ rect: line.removeRect, coverRect: line.coverRect, color: line.colors.bg, cover: "auto" })),
        ...erased.filter((i) => i.page === p).map((i) => {
          const rect = pdfRect(inv, i);
          return { rect, coverRect: rect, color: i.color, cover: "always" };
        }),
      ];
      if (regions.length) edits.push({ pageIndex: p.index, regions, removeText: true });
    }

    const run = () => ctx.job({ op: "fillSign", data: it.data, password: it.password, fieldChanges, pageItems, edits,
      flatten: state.flatten }, (t, f) => ctx.setStatus(t, f));
    let r = await run();
    // Check that removing text took away exactly what it should have. If not
    // (unusual PDFs), redo those pages by covering the old text instead.
    const bad = await checkRemoval(r.files[0].data, r.report, edits, pageItems);
    if (bad.length) {
      for (const e of edits) if (bad.includes(e.pageIndex)) e.removeText = false;
      r = await run();
    }
    const out = r.files[0].data;
    await ctx.doubleCheck(out, it.password, state.pages.length);
    const parts = [];
    const changed = state.edits.filter((e) => e.item?.text.trim()).length, deleted = state.edits.length - changed;
    if (changed) parts.push(`${changed} line${changed === 1 ? "" : "s"} changed`);
    if (deleted) parts.push(`${deleted} line${deleted === 1 ? "" : "s"} deleted`);
    if (erased.length) parts.push(`${erased.length} area${erased.length === 1 ? "" : "s"} erased`);
    if (fieldChanges.length) parts.push(`${fieldChanges.length} field${fieldChanges.length === 1 ? "" : "s"} filled`);
    const added = items.filter((i) => !i.edit).length;
    if (added) parts.push(`${added} item${added === 1 ? "" : "s"} added`);
    ctx.setStatus(`Done: ${parts.join(", ")}. Open it and check everything before sending.`, null, "ok");
    ctx.showResults([{ name: `${ctx.stem(it.file.name)}-${ctx.mode === "edit" ? "edited" : "signed"}.pdf`, data: out, type: "application/pdf" }]);
  }

  // Pages where the text left over isn't exactly the original minus what was
  // removed, followed by what was added. Returns their indexes.
  async function checkRemoval(data, report, edits, pageItems) {
    const pagesToCheck = report.filter((x) => x.removed.some(Boolean));
    if (!pagesToCheck.length) return [];
    const doc = await ctx.openPdfjs(data, it.password);
    const bad = [];
    try {
      for (const { pageIndex, removed } of pagesToCheck) {
        const p = state.pages[pageIndex];
        const rects = edits.find((e) => e.pageIndex === pageIndex).regions.filter((_, k) => removed[k]).map((g) => g.rect);
        const kept = p.textItems.filter((t) => !rects.some((r) => t.x >= r[0] && t.x <= r[2] && t.y >= r[1] && t.y <= r[3]));
        const added = pageItems.find((x) => x.pageIndex === pageIndex)?.items.filter((x) => x.type === "text") || [];
        const expected = normText(kept.map((t) => t.str).join("") + added.map((x) => x.text).join(""));
        const tc = await (await doc.getPage(pageIndex + 1)).getTextContent();
        const got = normText(tc.items.map((t) => t.str ?? "").join(""));
        if (!got.startsWith(expected)) bad.push(pageIndex);
      }
    } finally {
      await doc.close();
    }
    return bad;
  }

  init();
  setColor("black");
  updateSelControls();
  if (ctx.mode === "edit") setTool("edittext");

  return {
    it,
    mode: ctx.mode,
    el,
    update() { saveBtn.disabled = ctx.isBusy(); },
    dispose() {
      state.disposed = true;
      observer?.disconnect();
      sizeObserver?.disconnect();
      removeEventListener("resize", onWindowResize);
      removeEventListener("keydown", onKey);
      state.doc?.close();
    },
  };
}

// --------------------------------------------------------- signature maker ---

const SIG_FONTS = [
  ["Dancing Script", "sig-dancing"],
  ["Great Vibes", "sig-vibes"],
  ["Homemade Apple", "sig-apple"],
];

function signatureDialog(ctx, onDone) {
  const { h } = ctx;
  let mode = "draw";
  let color = "black";

  // draw
  const pad = h("canvas", { class: "sig-pad", "aria-label": "Signature drawing area" });
  let strokes = [];
  let current = null;
  const padCtx = () => pad.getContext("2d");
  const resizePad = () => {
    const dpr = window.devicePixelRatio || 1;
    pad.width = Math.round(pad.clientWidth * dpr);
    pad.height = Math.round(pad.clientHeight * dpr);
    redraw();
  };
  const pt = (e) => {
    const r = pad.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  function drawStroke(g, s, w, hh, lineW) {
    g.lineWidth = lineW;
    g.lineCap = g.lineJoin = "round";
    g.strokeStyle = cssColor(COLORS[color]);
    g.beginPath();
    const P = s.map(([x, y]) => [x * w, y * hh]);
    g.moveTo(...P[0]);
    if (P.length === 1) g.lineTo(P[0][0] + 0.1, P[0][1]);
    // smooth curve through midpoints
    for (let i = 1; i < P.length - 1; i++) {
      const mx = (P[i][0] + P[i + 1][0]) / 2, my = (P[i][1] + P[i + 1][1]) / 2;
      g.quadraticCurveTo(P[i][0], P[i][1], mx, my);
    }
    if (P.length > 1) g.lineTo(...P[P.length - 1]);
    g.stroke();
  }
  function redraw() {
    const g = padCtx();
    g.clearRect(0, 0, pad.width, pad.height);
    const lw = 2.6 * (window.devicePixelRatio || 1);
    for (const s of strokes) drawStroke(g, s, pad.width, pad.height, lw);
    updateDone();
  }
  pad.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { pad.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    current = [pt(e)];
    strokes.push(current);
    redraw();
  });
  pad.addEventListener("pointermove", (e) => {
    if (!current) return;
    // coalesced events give smoother lines; some browsers return none, so fall back
    const batch = e.getCoalescedEvents?.();
    for (const ce of batch?.length ? batch : [e]) current.push(pt(ce));
    redraw();
  });
  const endStroke = () => { current = null; };
  pad.addEventListener("pointerup", endStroke);
  pad.addEventListener("pointercancel", endStroke);

  // type
  const nameInput = h("input", { type: "text", placeholder: "Type your name", autocomplete: "name",
    oninput: () => { for (const p of fontPreviews) p.textContent = nameInput.value || "Your Name"; updateDone(); } });
  let font = SIG_FONTS[0][0];
  const fontPreviews = [];
  const fontChoices = h("div", { class: "sig-fonts" }, SIG_FONTS.map(([name, cls]) => {
    const preview = h("span", { class: `sig-preview ${cls}` }, "Your Name");
    fontPreviews.push(preview);
    return h("label", { class: "radio" },
      h("input", { type: "radio", name: "sigfont", value: name, checked: name === font, onchange: () => (font = name) }),
      preview);
  }));

  // upload
  let uploaded = null;
  const fileInput = h("input", { type: "file", accept: "image/*", hidden: true, onchange: async () => {
    const f = fileInput.files[0];
    fileInput.value = "";
    if (!f) return;
    try {
      uploaded = await createImageBitmap(f, { imageOrientation: "from-image" });
      uploadPreview.replaceChildren(h("img", { src: (await imageCanvas()).toDataURL(), alt: "Uploaded signature" }));
    } catch {
      uploadPreview.textContent = "That image couldn't be read.";
    }
    updateDone();
  } });
  const removeBg = h("input", { type: "checkbox", checked: true, onchange: async () => {
    if (uploaded) uploadPreview.replaceChildren(h("img", { src: (await imageCanvas()).toDataURL(), alt: "Uploaded signature" }));
  } });
  const uploadPreview = h("div", { class: "sig-upload-preview" }, "No image chosen.");

  // shared
  const panels = {
    draw: h("div", { class: "sig-panel" }, pad, h("div", { class: "sig-row" },
      h("span", { class: "hint" }, "Sign with your finger, a stylus or the mouse."),
      h("button", { type: "button", class: "btn small ghost", onclick: () => { strokes = []; redraw(); } }, "Clear"))),
    type: h("div", { class: "sig-panel" }, nameInput, fontChoices),
    upload: h("div", { class: "sig-panel" },
      h("button", { type: "button", class: "btn small", onclick: () => fileInput.click() }, "Choose a photo of your signature"),
      fileInput, h("label", { class: "check" }, removeBg, " Remove the paper background"), uploadPreview),
  };
  const tabs = Object.keys(panels).map((k) => h("button", { type: "button", role: "tab", class: "sig-tab", "data-k": k,
    onclick: () => setMode(k) }, { draw: "Draw", type: "Type", upload: "Upload" }[k]));
  const inkBtns = Object.keys(COLORS).map((c) => h("button", { type: "button", class: `swatch ${c}`, "aria-label": `${c} ink`,
    onclick: () => setInk(c) }));
  const doneBtn = h("button", { type: "button", class: "btn primary", onclick: finish }, "Use this signature");
  const reuseBtn = h("button", { type: "button", class: "btn ghost", hidden: true, onclick: () => { dlg.close(); onDone(previous.canvas); } }, "Use previous");
  let previous = null;

  const dlg = h("dialog", { class: "sig-dialog" },
    h("div", { class: "sig-head" }, h("strong", {}, "Your signature"),
      h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onclick: () => dlg.close() }, "✕")),
    h("div", { class: "sig-tabs", role: "tablist" }, tabs),
    ...Object.values(panels),
    h("div", { class: "sig-row" }, h("span", { class: "inline" }, "Ink ", ...inkBtns), h("span", { class: "inline" }, reuseBtn, doneBtn)),
    h("p", { class: "hint" }, "Your signature stays in this tab only and is never saved or uploaded."));

  function setMode(k) {
    mode = k;
    for (const t of tabs) t.setAttribute("aria-selected", String(t.dataset.k === k));
    for (const [name, p] of Object.entries(panels)) p.hidden = name !== k;
    if (k === "draw") resizePad(); // the dialog is open, so its size is known now
    updateDone();
  }
  function setInk(c) {
    color = c;
    for (const b of inkBtns) b.classList.toggle("on", b.classList.contains(c));
    for (const p of fontPreviews) p.style.color = cssColor(COLORS[c]);
    redraw();
  }
  function updateDone() {
    doneBtn.disabled = mode === "draw" ? !strokes.length : mode === "type" ? !nameInput.value.trim() : !uploaded;
  }

  async function finish() {
    let canvas;
    if (mode === "draw") {
      const scale = 3; // re-draw at higher resolution for print quality
      canvas = document.createElement("canvas");
      canvas.width = pad.clientWidth * scale;
      canvas.height = pad.clientHeight * scale;
      const g = canvas.getContext("2d");
      for (const s of strokes) drawStroke(g, s, canvas.width, canvas.height, 2.6 * scale);
    } else if (mode === "type") {
      await document.fonts.load(`120px "${font}"`, nameInput.value);
      canvas = document.createElement("canvas");
      const g = canvas.getContext("2d");
      g.font = `120px "${font}"`;
      const m = g.measureText(nameInput.value);
      canvas.width = Math.ceil(m.width + 80);
      canvas.height = 260;
      g.font = `120px "${font}"`;
      g.fillStyle = cssColor(COLORS[color]);
      g.textBaseline = "middle";
      g.fillText(nameInput.value, 40, 130);
    } else canvas = await imageCanvas();
    const trimmed = trim(canvas);
    if (!trimmed) return;
    previous = { canvas: trimmed };
    dlg.close();
    onDone(trimmed);
  }

  async function imageCanvas() {
    const s = Math.min(1, 1600 / Math.max(uploaded.width, uploaded.height));
    const c = document.createElement("canvas");
    c.width = Math.round(uploaded.width * s);
    c.height = Math.round(uploaded.height * s);
    const g = c.getContext("2d");
    g.drawImage(uploaded, 0, 0, c.width, c.height);
    if (removeBg.checked) {
      // paper becomes transparent; ink keeps its darkness as opacity
      const d = g.getImageData(0, 0, c.width, c.height);
      const px = d.data;
      const ink = COLORS[color].map((v) => v * 255);
      for (let i = 0; i < px.length; i += 4) {
        const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        const a = Math.max(0, Math.min(255, (200 - lum) * 2.2));
        px[i] = ink[0]; px[i + 1] = ink[1]; px[i + 2] = ink[2]; px[i + 3] = a;
      }
      g.putImageData(d, 0, 0);
    }
    return c;
  }

  // crop to the ink, with a little margin, and cap the size
  function trim(src) {
    const g = src.getContext("2d");
    const { width: w, height: hh } = src;
    const px = g.getImageData(0, 0, w, hh).data;
    let x0 = w, y0 = hh, x1 = -1, y1 = -1;
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return null;
    const m = Math.round(Math.max(x1 - x0, y1 - y0) * 0.03);
    x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(hh - 1, y1 + m);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    const s = Math.min(1, MAX_SIG_PX / Math.max(cw, ch));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(cw * s));
    out.height = Math.max(1, Math.round(ch * s));
    const og = out.getContext("2d");
    og.imageSmoothingQuality = "high";
    og.drawImage(src, x0, y0, cw, ch, 0, 0, out.width, out.height);
    return out;
  }

  dlg.addEventListener("close", () => { current = null; });

  return {
    el: dlg,
    open(prev, ink) {
      previous = prev ? { canvas: prev.canvas } : previous;
      reuseBtn.hidden = !previous;
      setInk(ink in COLORS ? ink : "black");
      dlg.showModal();
      setMode(mode);
    },
  };
}

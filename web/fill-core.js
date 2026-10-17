// Builds the qpdf JSON update for "Fill & sign": form-field values (with their
// visible appearance) and new drawing (text, dates, marks, signatures) on pages.
//
// New drawing goes in an extra content stream appended to the page. The page's
// original content is wrapped in q/Q so nothing it does to the graphics state
// can affect the additions; the original content itself is never modified.
//
// All text is drawn in standard Helvetica, which every PDF viewer has built in,
// so it can't come out invisible the way text in a form's embedded subset font
// can when that font lacks a character.
//
// Plain script so the worker can importScripts() it and Node can require() it.

/* exported FillCore */

(function () {
  const REF_RE = /^\d+ \d+ R$/;

  // ------------------------------------------------- WinAnsi + Helvetica ---

  const WIN_ANSI_EXTRA = {
    "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88,
    "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93,
    "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b,
    "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
  };

  function winAnsiCode(ch) {
    const c = ch.codePointAt(0);
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)) return c;
    return WIN_ANSI_EXTRA[ch] ?? null;
  }

  // Helvetica advance widths (per 1000 em) for ASCII 32-126, from the Adobe AFM.
  const ASCII_W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667,
    722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722,
    667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556,
    222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
    260, 334, 584];

  function charWidth(ch) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c <= 126) return ASCII_W[c - 32];
    if ("ÀÁÂÃÄÅÈÉÊËÝÞ".includes(ch)) return 667;
    if ("ÇÐÑÙÚÛÜ".includes(ch)) return 722;
    if ("ÌÍÎÏìíîï".includes(ch)) return 278;
    if ("ÒÓÔÕÖØ".includes(ch)) return 778;
    if ("çýÿ".includes(ch)) return 500;
    if (ch === "Æ") return 1000;
    if (ch === "æ") return 889;
    if (ch === "ß") return 611;
    return 556;
  }

  const textWidth = (s, size) => [...s].reduce((n, ch) => n + charWidth(ch), 0) * size / 1000;

  // PDF string literal in WinAnsi, ASCII-only (non-ASCII bytes as octal escapes)
  function pdfString(s) {
    let out = "(";
    for (const ch of s) {
      const code = winAnsiCode(ch);
      if (code == null) {
        const err = new Error(`The character "${ch}" can't be used in typed text. Letters with accents, numbers and common symbols work.`);
        err.userFacing = true;
        throw err;
      }
      if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`;
      else if (code >= 0x20 && code <= 0x7e) out += ch;
      else out += `\\${code.toString(8).padStart(3, "0")}`;
    }
    return `${out})`;
  }

  const n = (x) => (Math.round(x * 1000) / 1000).toString();

  // ----------------------------------------------------------- matrices ---

  // [a b c d e f] maps (x, y) -> (a x + c y + e, b x + d y + f)
  const compose = (A, B) => [ // apply B, then A
    A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
  ];

  function invert(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
      (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
  }

  // ------------------------------------------------------ drawing items ---

  // Font metrics used by both the on-screen editor (CSS) and the PDF output, so
  // text lands where it was placed: line height 1.2 em, baseline 0.9465 em
  // below the top of the line box (Helvetica/Arial ascent .905 + half-leading).
  const LINE_HEIGHT = 1.2;
  const FIRST_BASELINE = 0.9465;

  // item: { type, x, y, w, h, text, size, color, imageName } in "page space":
  // pdf.js viewport units at scale 1 (points, y down, rotation applied).
  function itemOps(item, viewportTransform) {
    const toPdf = compose(invert(viewportTransform), [1, 0, 0, -1, item.x, item.y + item.h]);
    let body = "";
    const [r, g, b] = item.color || [0, 0, 0];
    const color = `${n(r)} ${n(g)} ${n(b)}`;
    if (item.type === "text") {
      const s = item.size;
      const lines = item.text.split("\n");
      body += `BT /FsHelv ${n(s)} Tf ${color} rg\n`;
      lines.forEach((line, i) => {
        const y = item.h - FIRST_BASELINE * s - i * LINE_HEIGHT * s;
        body += `1 0 0 1 0 ${n(y)} Tm ${pdfString(line)} Tj\n`;
      });
      body += "ET\n";
    } else if (item.type === "check" || item.type === "cross") {
      const { w, h } = item;
      const lw = Math.max(0.5, 0.12 * Math.min(w, h));
      body += `${color} RG ${n(lw)} w 1 J 1 j\n`;
      if (item.type === "check") {
        body += `${n(0.15 * w)} ${n(0.5 * h)} m ${n(0.4 * w)} ${n(0.22 * h)} l ${n(0.88 * w)} ${n(0.82 * h)} l S\n`;
      } else {
        body += `${n(0.18 * w)} ${n(0.18 * h)} m ${n(0.82 * w)} ${n(0.82 * h)} l S\n`;
        body += `${n(0.18 * w)} ${n(0.82 * h)} m ${n(0.82 * w)} ${n(0.18 * h)} l S\n`;
      }
    } else if (item.type === "image") {
      body += `${n(item.w)} 0 0 ${n(item.h)} 0 0 cm /${item.imageName} Do\n`;
    }
    return `q ${toPdf.map(n).join(" ")} cm\n${body}Q\n`;
  }

  // ------------------------------------------------- field appearances ---

  // Draws a text (or dropdown) field's visible value the way viewers do: inside
  // a 2pt padding, clipped to the box, honouring alignment, comb and multi-line.
  function textFieldAppearance({ w, h, value, da, q, flags, maxLen }) {
    const multiline = !!(flags & (1 << 12));
    const comb = !!(flags & (1 << 24)) && maxLen > 0;
    const m = /([\d.]+)\s+Tf/.exec(da || "");
    let size = m ? parseFloat(m[1]) : 0;
    const colorOp = /([\d.]+\s+[\d.]+\s+[\d.]+\s+rg|[\d.]+\s+g|[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+k)\s*$/.exec(
      (da || "").replace(/\/\S+\s+[\d.]+\s+Tf/, "").trim())?.[1] || "0 g";
    const pad = 2;
    const innerW = Math.max(1, w - 2 * pad);

    let lines = [value];
    if (multiline) {
      if (!size) size = 10;
      lines = wrap(value, innerW, size);
    } else {
      value = value.replace(/[\r\n]+/g, " ");
      lines = [value];
      if (!size) size = Math.max(4, Math.min(12, (h - 2 * pad) * 0.75, comb ? 12 : innerW / Math.max(1, textWidth(value, 1))));
    }

    let body = "";
    if (comb) {
      const cell = w / maxLen;
      const y = (h - size * 0.72) / 2;
      [...value].slice(0, maxLen).forEach((ch, i) => {
        const x = i * cell + (cell - textWidth(ch, size)) / 2;
        body += `1 0 0 1 ${n(x)} ${n(y)} Tm ${pdfString(ch)} Tj\n`;
      });
    } else {
      const lead = size * 1.15;
      let y = multiline ? h - pad - size * 0.9 : (h - size * 0.72) / 2;
      for (const line of lines) {
        const tw = textWidth(line, size);
        const x = q === 1 ? (w - tw) / 2 : q === 2 ? w - pad - tw : pad;
        body += `1 0 0 1 ${n(x)} ${n(y)} Tm ${pdfString(line)} Tj\n`;
        y -= lead;
      }
    }
    return `/Tx BMC\nq 1 1 ${n(w - 2)} ${n(h - 2)} re W n\nBT /FsHelv ${n(size)} Tf ${colorOp}\n${body}ET\nQ\nEMC\n`;
  }

  function wrap(text, width, size) {
    const out = [];
    for (const para of text.split(/\r\n|\r|\n/)) {
      let line = "";
      for (const word of para.split(/(\s+)/)) {
        const next = line + word;
        if (line && textWidth(next.trimEnd(), size) > width) {
          out.push(line.trimEnd());
          line = word.trimStart();
        } else line = next;
      }
      out.push(line);
    }
    return out;
  }

  // ------------------------------------------------------------ update ---

  function buildFillUpdate({ header, objects, pages, fieldChanges = [], pageItems = [] }) {
    const working = new Map(); // ref -> edited copy of an object's value
    let nextId = header.maxobjectid + 1;
    const created = {};

    const val = (ref) => {
      if (!working.has(ref)) working.set(ref, structuredClone(objects[`obj:${ref}`]?.value));
      return working.get(ref);
    };
    const resolve = (v, depth = 0) => {
      if (typeof v === "string" && REF_RE.test(v) && depth < 20) {
        const o = objects[`obj:${v}`];
        return o ? resolve(o.value ?? o.stream?.dict, depth + 1) : null;
      }
      return v;
    };
    const newRef = () => `${nextId++} 0 R`;
    const b64 = (s) => btoa(s); // our generated content is ASCII-only
    const newStream = (text, dict = {}) => {
      const ref = newRef();
      created[`obj:${ref}`] = { stream: { dict, data: b64(text) } };
      return ref;
    };
    let fontRef = null;
    const helvetica = () => {
      if (!fontRef) {
        fontRef = newRef();
        created[`obj:${fontRef}`] = { value: { "/Type": "/Font", "/Subtype": "/Type1",
          "/BaseFont": "/Helvetica", "/Encoding": "/WinAnsiEncoding" } };
      }
      return fontRef;
    };
    const apStates = (widget) => {
      const nAp = resolve(resolve(widget["/AP"])?.["/N"]);
      return nAp && typeof nAp === "object" ? Object.keys(nAp) : [];
    };

    const rootRef = objects.trailer.value["/Root"];
    const acroForm = () => {
      const root = val(rootRef);
      const raw = root["/AcroForm"];
      return typeof raw === "string" ? val(raw) : raw;
    };
    // inherited field attribute: walk up /Parent, then the form's default
    const inherited = (fieldRef, key) => {
      let node = val(fieldRef);
      for (let i = 0; node && i < 50; i++) {
        if (key in node) return resolve(node[key]);
        node = node["/Parent"] ? val(node["/Parent"]) : null;
      }
      return resolve(acroForm()?.[key]);
    };

    // --- form fields
    for (const ch of fieldChanges) {
      const widgetRef = ch.widgetRefs[0];
      const w = val(widgetRef);
      if (!w) continue;
      // a widget that carries /T is the field itself; otherwise its parent is
      const fieldRef = "/T" in w || !w["/Parent"] ? widgetRef : w["/Parent"];
      const f = val(fieldRef);
      const widgets = fieldRef !== widgetRef && Array.isArray(f["/Kids"]) ? f["/Kids"] : [fieldRef];

      if (ch.type === "text" || ch.type === "choice") {
        f["/V"] = `u:${ch.value}`;
        const da = inherited(fieldRef, "/DA");
        const q = Number(inherited(fieldRef, "/Q") || 0);
        const flags = Number(inherited(fieldRef, "/Ff") || 0);
        const maxLen = Number(inherited(fieldRef, "/MaxLen") || 0);
        const shown = ch.type === "choice" ? (ch.display ?? ch.value) : ch.value;
        for (const wRef of widgets) {
          const wd = wRef === fieldRef ? f : val(wRef);
          const rect = resolve(wd["/Rect"]).map((x) => Number(resolve(x)));
          const ww = Math.abs(rect[2] - rect[0]), hh = Math.abs(rect[3] - rect[1]);
          const ap = newStream(textFieldAppearance({ w: ww, h: hh, value: shown, da, q, flags, maxLen }), {
            "/Type": "/XObject", "/Subtype": "/Form", "/BBox": [0, 0, ww, hh],
            "/Resources": { "/Font": { "/FsHelv": helvetica() } },
          });
          wd["/AP"] = { "/N": ap };
        }
      } else {
        const on = ch.value && ch.value !== "Off" ? `/${ch.value}` : "/Off";
        f["/V"] = on;
        for (const wRef of widgets) {
          const wd = wRef === fieldRef ? f : val(wRef);
          if (wd) wd["/AS"] = apStates(wd).includes(on) ? on : "/Off";
        }
      }
    }

    if (fieldChanges.length) {
      // drop any XFA layer so every viewer shows the regular, now filled, form;
      // appearances are already generated, so viewers needn't rebuild them
      const af = acroForm();
      if (af) {
        delete af["/XFA"];
        delete af["/NeedAppearances"];
      }
    }

    // --- drawing added to pages
    for (const pi of pageItems) {
      if (!pi.items.length) continue;
      const pageRef = pages[pi.pageIndex].object;
      const page = val(pageRef);

      // resources may be inline, indirect, or inherited from a parent node
      let res = page["/Resources"];
      for (let node = page, i = 0; res === undefined && node && i < 50; i++) {
        node = resolve(node["/Parent"]);
        res = node?.["/Resources"];
      }
      const resources = { ...(resolve(res) || {}) };
      const xobjects = { ...(resolve(resources["/XObject"]) || {}) };
      const fonts = { ...(resolve(resources["/Font"]) || {}) };

      let ops = "";
      for (const item of pi.items) {
        if (item.type === "text") {
          fonts["/FsHelv"] = helvetica();
          resources["/Font"] = fonts;
        }
        if (item.type === "image") {
          const im = item.image;
          let dict = im.dict;
          if (im.smask) {
            const smaskRef = newRef();
            created[`obj:${smaskRef}`] = { stream: { dict: im.smask.dict, datafile: im.smask.file } };
            dict = { ...dict, "/SMask": smaskRef };
          }
          const ref = newRef();
          created[`obj:${ref}`] = { stream: { dict, datafile: im.file } };
          item.imageName = `FsIm${ref.split(" ")[0]}`;
          xobjects[`/${item.imageName}`] = ref;
          resources["/XObject"] = xobjects;
        }
        ops += itemOps(item, pi.viewportTransform);
      }
      page["/Resources"] = resources;

      const old = page["/Contents"];
      const oldList = old === undefined ? [] : Array.isArray(old) ? old : [old];
      page["/Contents"] = [newStream("q\n"), ...oldList, newStream(`\nQ\n${ops}`)];
    }

    const update = {};
    for (const [ref, v] of working) update[`obj:${ref}`] = { value: v };
    Object.assign(update, created);
    return {
      qpdf: [{
        jsonversion: 2,
        pushedinheritedpageresources: header.pushedinheritedpageresources,
        calledgetallpages: header.calledgetallpages,
        maxobjectid: header.maxobjectid,
      }, update],
    };
  }

  // After flattening, fields that were never filled (so had no appearance to
  // bake in) are left as loose widget annotations. Remove them.
  function removeLeftoverWidgets({ header, objects, pages }) {
    const resolve = (v) => (typeof v === "string" && REF_RE.test(v) ? objects[`obj:${v}`]?.value : v);
    const update = {};
    for (const pg of pages) {
      const page = structuredClone(objects[`obj:${pg.object}`].value);
      const annots = resolve(page["/Annots"]);
      if (!Array.isArray(annots)) continue;
      const keep = annots.filter((a) => resolve(a)?.["/Subtype"] !== "/Widget");
      if (keep.length === annots.length) continue;
      if (keep.length) page["/Annots"] = keep;
      else delete page["/Annots"];
      update[`obj:${pg.object}`] = { value: page };
    }
    if (!Object.keys(update).length) return null;
    return { qpdf: [{ jsonversion: 2, pushedinheritedpageresources: header.pushedinheritedpageresources,
      calledgetallpages: header.calledgetallpages, maxobjectid: header.maxobjectid }, update] };
  }

  const api = { buildFillUpdate, removeLeftoverWidgets, textFieldAppearance, itemOps, pdfString, LINE_HEIGHT, FIRST_BASELINE };
  if (typeof module !== "undefined") module.exports = api;
  else globalThis.FillCore = api;
})();

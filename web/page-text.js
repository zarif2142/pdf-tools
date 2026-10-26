// Helpers shared by the two ways of editing a PDF's text (fill-sign.js and
// doc-edit.js): matrices, matching a PDF font to a standard one, the characters
// the standard fonts can show, and reading colours off a drawn page.

// [a b c d e f] maps (x, y) -> (a x + c y + e, b x + d y + f)
export const mulM = (A, B) => [ // apply A, then B
  A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3],
  A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3],
  A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5],
];

export function invertM(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

// Text in the standard PDF fonts uses WinAnsi: Latin letters and common
// symbols. Ligatures are split ("ﬁ" -> "fi"), curly quotes and dashes kept.
const WIN_ANSI_EXTRA = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88,
  "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93,
  "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b,
  "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};
export function winAnsiCode(ch) {
  const c = ch.codePointAt(0);
  if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)) return c;
  return WIN_ANSI_EXTRA[ch] ?? null;
}
const typeable = (ch) => winAnsiCode(ch) != null;

// Anything the standard fonts can't show (icon fonts, other scripts) is left out
export const keepTypeable = (s) => [...s]
  .map((ch) => (typeable(ch) ? ch : [...ch.normalize("NFKC")].every(typeable) ? ch.normalize("NFKC") : ""))
  .join("");
export const toTypeable = (s) => keepTypeable(s).replace(/ {2,}/g, " ").trim();

// The closest standard font to the one a piece of text uses: Helvetica, Times
// or Courier, bold and/or italic. page: pdf.js page (drawn or with its operator
// list loaded, so its fonts are known); style and id from getTextContent().
export function standardFont(page, style, id) {
  let f = null;
  try { f = page.commonObjs.has(id) ? page.commonObjs.get(id) : null; } catch { /* not loaded */ }
  const name = String(f?.name || "").replace(/^[A-Z]{6}\+/, "");
  const mono = f?.isMonospace || /courier|mono|consol/i.test(name) || style?.fontFamily === "monospace";
  const serif = !mono && !/sans|arial|helvet|calibri|verdana/i.test(name) &&
    (f?.isSerifFont || /times|serif|georgia|garamond|cambria|roman|minion|palatino|book/i.test(name) || style?.fontFamily === "serif");
  const bold = !!(f?.bold || f?.black) || /bold|black|heavy|semibold|demi/i.test(name);
  const italic = !!f?.italic || /italic|oblique/i.test(name);
  const family = mono ? "Courier" : serif ? "Times" : "Helvetica";
  return { std: stdName(family, bold, italic), css: `PDF ${family}`, family, bold, italic };
}

export function stdName(family, bold, italic) {
  if (family === "Times") return `Times-${bold && italic ? "BoldItalic" : bold ? "Bold" : italic ? "Italic" : "Roman"}`;
  return `${family}${bold || italic ? "-" : ""}${bold ? "Bold" : ""}${italic ? "Oblique" : ""}`;
}

// Colours under a box on a drawn page: the background (most common colour
// around its edge) and, for text, the ink (the pixels least like it).
// k: canvas pixels per page unit. pixels: the whole canvas's ImageData, when
// sampling many boxes from one canvas.
export function sampleColors(canvas, k, box, pixels) {
  const x = Math.max(0, Math.floor(box.x * k) - 2), y = Math.max(0, Math.floor(box.y * k) - 2);
  const w = Math.min(canvas.width - x, Math.ceil(box.w * k) + 4), hh = Math.min(canvas.height - y, Math.ceil(box.h * k) + 4);
  if (w < 3 || hh < 3) return { bg: [1, 1, 1], ink: [0, 0, 0] };
  const px = pixels ? pixels.data : canvas.getContext("2d", { willReadFrequently: true }).getImageData(x, y, w, hh).data;
  const at = pixels
    ? (i, j) => { const o = ((y + j) * pixels.width + x + i) * 4; return [px[o], px[o + 1], px[o + 2]]; }
    : (i, j) => { const o = (j * w + i) * 4; return [px[o], px[o + 1], px[o + 2]]; };
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
  const unit = (v) => v.map((c) => Math.round(c / 255 * 1000) / 1000);
  // edge smoothing lightens thin letters a little: near-black is black
  const grey = Math.max(...ink) - Math.min(...ink) < 20;
  return { bg: unit(bg), ink: max > 40 && !(grey && Math.max(...ink) < 60) ? unit(ink) : [0, 0, 0] };
}

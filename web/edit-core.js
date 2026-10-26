// Removes existing text from a page's content stream, for "Edit text" and
// "Erase" in the editor. Only the text-showing operators are dropped; every
// other operator (graphics, images, clipping, fonts, positions) is kept as is,
// so the rest of the page is untouched.
//
// A region is a rectangle in PDF user space. A text-showing operator is dropped
// when the point where its text starts (its origin) lies inside a region. To
// know where text that follows other text starts, the width of every character
// is added up from the page's font metrics (see fontMetrics).
//
// Dropping text could move other text: a following operator with no position
// of its own starts where the dropped one ended. When that would happen the
// region is left alone instead (reported as not removed), and the caller
// covers it with a background-coloured box.
//
// Plain script so the worker can importScripts() it and Node can require() it.

/* exported EditCore */

(function () {
  const WS = new Set([0, 9, 10, 12, 13, 32]);
  const DELIM = new Set([..."()<>[]{}/%"].map((c) => c.charCodeAt(0)));
  const ESCAPES = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };

  // Tokenizes a content stream held as a latin1 string (one char per byte).
  // Yields { op, operands, start, end }. Strings come back as their bytes.
  function* operations(s) {
    let i = 0;
    let operands = [];
    let opStart = -1;
    const n = s.length;

    const skipWs = () => {
      for (;;) {
        while (i < n && WS.has(s.charCodeAt(i))) i++;
        if (s[i] !== "%") return;
        while (i < n && s[i] !== "\n" && s[i] !== "\r") i++;
      }
    };

    const literal = () => {
      let depth = 0;
      let out = "";
      for (i++; i < n; i++) {
        const ch = s[i];
        if (ch === "\\") {
          const e = s[++i];
          if (e >= "0" && e <= "7") {
            let oct = e;
            while (oct.length < 3 && s[i + 1] >= "0" && s[i + 1] <= "7") oct += s[++i];
            out += String.fromCharCode(parseInt(oct, 8) & 255);
          } else if (e === "\r") {
            if (s[i + 1] === "\n") i++; // line continuation
          } else if (e !== "\n") out += ESCAPES[e] ?? e;
          continue;
        }
        if (ch === "(") depth++;
        else if (ch === ")" && depth-- === 0) { i++; break; }
        out += ch;
      }
      return { str: out };
    };

    // reads one object at i: numbers, strings, names, arrays, dicts or an operator
    const readObject = () => {
      const c = s[i];
      if (c === "(") return literal();
      if (c === "<" && s[i + 1] === "<") {
        i += 2;
        const d = [];
        for (;;) {
          skipWs();
          if (i >= n) break;
          if (s[i] === ">" && s[i + 1] === ">") { i += 2; break; }
          d.push(readObject());
        }
        return { dict: d };
      }
      if (c === "<") {
        const j = s.indexOf(">", i);
        const hex = s.slice(i + 1, j < 0 ? n : j).replace(/[^0-9a-fA-F]/g, "");
        i = j < 0 ? n : j + 1;
        let out = "";
        for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex[k] + (hex[k + 1] || "0"), 16));
        return { str: out };
      }
      if (c === "[") {
        i++;
        const a = [];
        for (;;) {
          skipWs();
          if (i >= n) break;
          if (s[i] === "]") { i++; break; }
          a.push(readObject());
        }
        return { arr: a };
      }
      if (c === "/") {
        let j = i + 1;
        while (j < n && !WS.has(s.charCodeAt(j)) && !DELIM.has(s.charCodeAt(j))) j++;
        const name = s.slice(i, j);
        i = j;
        return { name };
      }
      if (c === "{" || c === "}" || c === ")" || c === ">" || c === "]") { i++; return { junk: c }; }
      let j = i;
      while (j < n && !WS.has(s.charCodeAt(j)) && !DELIM.has(s.charCodeAt(j))) j++;
      const word = s.slice(i, j);
      i = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { num: parseFloat(word) };
      if (word === "true" || word === "false" || word === "null") return { kw: word };
      return { op: word };
    };

    for (;;) {
      skipWs();
      if (i >= n) return;
      const start = i;
      const tok = readObject();
      if (opStart < 0) opStart = start;
      if (!tok.op) { operands.push(tok); continue; }
      if (tok.op === "ID") {
        // inline image: binary data runs to "EI" followed by whitespace or the end
        let j = i + 1;
        for (;;) {
          j = s.indexOf("EI", j);
          if (j < 0) { j = n; break; }
          const before = s.charCodeAt(j - 1), after = s.charCodeAt(j + 2);
          if (WS.has(before) && (j + 2 >= n || WS.has(after))) break;
          j += 2;
        }
        i = Math.min(n, j + 2);
        yield { op: "EI", operands: [], start: opStart, end: i };
      } else {
        yield { op: tok.op, operands, start: opStart, end: i };
      }
      operands = [];
      opStart = -1;
    }
  }

  // [a b c d e f] maps (x, y) -> (a x + c y + e, b x + d y + f)
  const mul = (A, B) => [ // apply A, then B
    A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3],
    A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3],
    A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5],
  ];
  const ID = [1, 0, 0, 1, 0, 0];
  const SHOW = new Set(["Tj", "TJ", "'", "\""]);
  const POSITION = new Set(["BT", "ET", "Td", "TD", "Tm", "T*", "'", "\""]);
  const inside = (r, x, y) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
  const UNKNOWN_FONT = { twoByte: false, widths: {}, missing: 500, scale: 0.001 };

  // How far a string moves the text position, in text space (before Tz)
  function advance(str, font, size, tc, tw) {
    const m = font || UNKNOWN_FONT;
    const step = m.twoByte ? 2 : 1;
    let w = 0;
    for (let k = 0; k + step <= str.length; k += step) {
      const code = m.twoByte ? (str.charCodeAt(k) << 8) | str.charCodeAt(k + 1) : str.charCodeAt(k);
      w += (m.widths[code] ?? m.missing) * m.scale * size + tc + (!m.twoByte && code === 32 ? tw : 0);
    }
    return w;
  }

  // Walk the stream once, finding which text-showing operators start in which
  // region, and which regions can't be removed safely.
  function analyse(s, regions, enabled, fonts) {
    const nums = (o) => o.operands.map((t) => t.num ?? 0);
    const gs = [];
    let ctm = ID;
    let tm = ID, tlm = ID, leading = 0, rise = 0, mode = 0;
    let font = null, size = 0, tc = 0, tw = 0, th = 1;
    const drops = new Map(); // op index -> region index
    const info = regions.map(() => ({ found: 0, invisible: false, unsafe: false }));
    let lostAdvance = -1; // region whose dropped text would have moved the next text
    let idx = -1;
    for (const o of operations(s)) {
      idx++;
      const op = o.op;
      if (op === "q") gs.push([ctm, leading, rise, mode, font, size, tc, tw, th]);
      else if (op === "Q") { if (gs.length) [ctm, leading, rise, mode, font, size, tc, tw, th] = gs.pop(); }
      else if (op === "cm") ctm = mul(nums(o), ctm);
      else if (op === "BT") { tm = tlm = ID; }
      else if (op === "Tm") { tm = tlm = nums(o); }
      else if (op === "Td" || op === "TD") {
        const [tx, ty] = nums(o);
        if (op === "TD") leading = -ty;
        tm = tlm = mul([1, 0, 0, 1, tx, ty], tlm);
      } else if (op === "T*" || op === "'" || op === "\"") {
        if (op === "\"") [tw, tc] = nums(o);
        tm = tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
      } else if (op === "TL") leading = nums(o)[0];
      else if (op === "Ts") rise = nums(o)[0];
      else if (op === "Tr") mode = nums(o)[0];
      else if (op === "Tc") tc = nums(o)[0];
      else if (op === "Tw") tw = nums(o)[0];
      else if (op === "Tz") th = nums(o)[0] / 100;
      else if (op === "Tf") { font = fonts[o.operands[0]?.name] || null; size = nums(o)[1]; }

      if (POSITION.has(op)) lostAdvance = -1;
      if (!SHOW.has(op)) continue;

      const m = mul(tm, ctm);
      const x = m[2] * rise + m[4], y = m[3] * rise + m[5];
      const r = regions.findIndex((reg, k) => enabled[k] && inside(reg, x, y));
      if (r >= 0) {
        drops.set(idx, r);
        info[r].found++;
        if (mode === 3 || mode === 7) info[r].invisible = true;
        lostAdvance = r;
      } else if (lostAdvance >= 0) {
        info[lostAdvance].unsafe = true;
      }

      // move past the text just shown
      let tx = 0;
      const last = o.operands[o.operands.length - 1];
      if (op === "TJ") {
        for (const el of last?.arr || []) {
          if (el.num != null) tx -= el.num / 1000 * size;
          else if (typeof el.str === "string") tx += advance(el.str, font, size, tc, tw);
        }
      } else if (typeof last?.str === "string") tx = advance(last.str, font, size, tc, tw);
      tm = mul([1, 0, 0, 1, tx * th, 0], tm);
    }
    return { drops, info };
  }

  // Returns { content, removed: [bool per region], invisible: [bool per region] }.
  // content is the new stream as a latin1 string. fonts: from fontMetrics().
  function removeText(content, regions, fonts = {}) {
    let enabled = regions.map(() => true);
    let result;
    // switching an unsafe region off can make another one unsafe; settle it
    for (let round = 0; round < regions.length + 1; round++) {
      result = analyse(content, regions, enabled, fonts);
      const next = enabled.map((on, k) => on && !result.info[k].unsafe);
      if (next.every((v, k) => v === enabled[k])) break;
      enabled = next;
    }
    const { drops, info } = result;
    let out = "";
    let last = 0;
    let idx = -1;
    for (const o of operations(content)) {
      idx++;
      if (!drops.has(idx)) continue;
      out += content.slice(last, o.start);
      // ' and " also move to the next line (and " sets spacing): keep that part
      if (o.op === "'") out += "T*";
      else if (o.op === "\"") {
        const [aw, ac] = o.operands.map((t) => t.num ?? 0);
        out += `${aw} Tw ${ac} Tc T*`;
      }
      last = o.end;
    }
    out += content.slice(last);
    return {
      content: out,
      removed: regions.map((_, k) => enabled[k] && info[k].found > 0),
      invisible: info.map((x) => x.invisible),
    };
  }

  // Character widths of the fonts in a page's /Font resource dictionary
  // (name -> reference or dictionary), read from qpdf JSON objects.
  function fontMetrics(fontDict, resolve) {
    const out = {};
    for (const [name, ref] of Object.entries(fontDict || {})) {
      const f = resolve(ref);
      if (!f || typeof f !== "object") continue;
      const m = { twoByte: false, widths: {}, missing: 500, scale: 0.001 };
      if (f["/Subtype"] === "/Type0") {
        m.twoByte = true;
        const d = resolve(resolve(f["/DescendantFonts"])?.[0]) || {};
        m.missing = Number(resolve(d["/DW"]) ?? 1000);
        const w = resolve(d["/W"]) || [];
        for (let k = 0; k < w.length;) {
          const first = Number(resolve(w[k]));
          const next = resolve(w[k + 1]);
          if (Array.isArray(next)) {
            next.forEach((v, j) => { m.widths[first + j] = Number(resolve(v)); });
            k += 2;
          } else {
            const last = Number(next), v = Number(resolve(w[k + 2]));
            for (let c = first; c <= last && c - first < 65536; c++) m.widths[c] = v;
            k += 3;
          }
        }
      } else {
        const first = Number(resolve(f["/FirstChar"]) ?? 0);
        const widths = resolve(f["/Widths"]);
        if (Array.isArray(widths)) widths.forEach((v, j) => { m.widths[first + j] = Number(resolve(v)); });
        const base = String(f["/BaseFont"] || "");
        m.missing = Number(resolve(resolve(f["/FontDescriptor"])?.["/MissingWidth"]) ?? (/Courier/.test(base) ? 600 : 500));
        if (f["/Subtype"] === "/Type3") m.scale = Number(resolve(resolve(f["/FontMatrix"])?.[0]) ?? 0.001);
      }
      out[name] = m;
    }
    return out;
  }

  const api = { removeText, operations, fontMetrics };
  if (typeof module !== "undefined") module.exports = api;
  else globalThis.EditCore = api;
})();

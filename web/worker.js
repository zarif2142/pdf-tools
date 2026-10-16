// Runs qpdf (compiled to WebAssembly) off the main thread.
//
// The page starts a fresh worker for every job and terminates it afterwards, so
// no file data outlives the job. Inside, every qpdf call gets its own in-memory
// filesystem; nothing is ever written to disk or sent over the network.

importScripts("vendor/qpdf/qpdf.js"); // defines the global factory `Module`

let wasmModule = null;

async function newQpdf() {
  // compiled once per job, then instantiated fresh for every qpdf call
  wasmModule ??= await WebAssembly.compileStreaming(fetch("vendor/qpdf/qpdf.wasm"));
  const log = [];
  const q = await Module({
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(wasmModule, imports).then((inst) => done(inst, wasmModule));
      return {};
    },
    locateFile: (p) => `vendor/qpdf/${p}`,
    noInitialRun: true,
    print: (s) => log.push(s),
    printErr: (s) => log.push(s),
  });
  q.log = log;
  q.run = (args) => {
    log.length = 0;
    let rc;
    try {
      rc = q.callMain(args);
    } catch (e) {
      // qpdf calls exit(); Emscripten reports that as an exception with a status
      rc = typeof e?.status === "number" ? e.status : 2;
      if (rc !== 0 && rc !== 3) log.push(String(e?.message || e));
    }
    return { rc, out: log.join("\n") };
  };
  return q;
}

const progress = (text, frac) => postMessage({ type: "progress", text, frac });

function fail(msg, out) {
  const err = new Error(msg);
  err.detail = out;
  throw err;
}

// rc 0 = fine, 3 = fine with warnings (output still written), anything else failed
function ok(res, what) {
  if (res.rc !== 0 && res.rc !== 3) {
    if (/invalid password/i.test(res.out)) fail("Wrong password.", res.out);
    fail(`${what} failed.`, res.out);
  }
  return res;
}

function pwArgs(pw) {
  return pw ? [`--password=${pw}`] : [];
}

// Every PDF we hand back is re-read in full by qpdf and its page count checked.
function verify(q, path, password, expectedPages) {
  ok(q.run([...pwArgs(password), "--check", path]), "Checking the result");
  // read the count from a file: qpdf's stdout isn't reliably flushed in WebAssembly
  ok(q.run([...pwArgs(password), path, "--json-output", "--json-key=pages", "/npages.json"]), "Counting pages");
  const n = JSON.parse(q.FS.readFile("/npages.json", { encoding: "utf8" })).pages.length;
  q.FS.unlink("/npages.json");
  if (expectedPages != null && n !== expectedPages) {
    fail(`Safety check failed: expected ${expectedPages} pages but the result has ${n}.`);
  }
  return n;
}

// ------------------------------------------------------------------ ops ---

// Inspect a PDF: page count, encryption, info dictionary.
async function inspect({ data }) {
  const q = await newQpdf();
  q.FS.writeFile("/in.pdf", data);
  // This qpdf build won't even report encryption without the password, so if
  // the file doesn't open, look for the /Encrypt key, which an encrypted PDF's
  // trailer always carries in plain text.
  if (!opens(q, "") && hasEncryptKey(data)) return { needsPassword: true };
  return { needsPassword: false, ...(await describe(q, "/in.pdf", "")) };
}

function hasEncryptKey(bytes) {
  const key = [0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74]; // "/Encrypt"
  outer: for (let i = 0; i <= bytes.length - key.length; i++) {
    for (let k = 0; k < key.length; k++) if (bytes[i + k] !== key[k]) continue outer;
    return true;
  }
  return false;
}

function opens(q, password) {
  const r = q.run([...pwArgs(password), "/in.pdf", "--json-output", "--json-key=pages", "/try.json"]);
  try { q.FS.unlink("/try.json"); } catch {}
  return r.rc === 0 || r.rc === 3;
}

async function checkPassword({ data, password }) {
  const q = await newQpdf();
  q.FS.writeFile("/in.pdf", data);
  if (!password || !opens(q, password)) return { ok: false };
  return { ok: true, ...(await describe(q, "/in.pdf", password)) };
}

async function describe(q, path, password) {
  const r = ok(q.run([...pwArgs(password), path, "--json-output", "--json-key=qpdf",
    "--json-key=pages", "--json-key=encrypt", "--json-stream-data=none", "/info.json"]), "Reading the PDF");
  const j = JSON.parse(q.FS.readFile("/info.json", { encoding: "utf8" }));
  const objects = j.qpdf[1];
  const trailer = objects.trailer?.value || {};
  const info = {};
  const infoObj = resolve(objects, trailer["/Info"]);
  if (infoObj && typeof infoObj === "object") {
    for (const [k, v] of Object.entries(infoObj)) {
      const val = resolve(objects, v);
      if (typeof val === "string") info[k.slice(1)] = cleanString(val);
    }
  }
  let images = 0;
  for (const v of Object.values(objects)) if (v.stream?.dict?.["/Subtype"] === "/Image") images++;
  const first = j.pages[0] ? pageBox(objects, j.pages[0].object) : null;
  return {
    pages: j.pages.length,
    version: j.qpdf[0].pdfversion,
    encrypted: !!j.encrypt?.encrypted,
    hasXmp: !!resolve(objects, resolve(objects, objects.trailer?.value?.["/Root"])?.["/Metadata"]),
    images,
    info,
    firstPage: first,
    warnings: r.rc === 3 ? r.out : "",
  };
}

// qpdf JSON v2: "u:..." is a text string, "b:..." hex bytes, "5 0 R" a reference
function cleanString(s) {
  if (s.startsWith("u:")) return s.slice(2);
  if (s.startsWith("b:")) return "(binary)";
  return s;
}

function resolve(objects, v, depth = 0) {
  if (typeof v === "string" && /^\d+ \d+ R$/.test(v) && depth < 20) {
    const o = objects[`obj:${v}`];
    if (!o) return null;
    return resolve(objects, o.value ?? o.stream, depth + 1);
  }
  return v;
}

function pageBox(objects, ref) {
  let node = resolve(objects, ref);
  for (let i = 0; node && i < 50; i++) {
    const box = resolve(objects, node["/MediaBox"]);
    if (Array.isArray(box)) {
      const n = box.map((x) => Number(resolve(objects, x)));
      return { w: Math.abs(n[2] - n[0]), h: Math.abs(n[3] - n[1]) };
    }
    node = resolve(objects, node["/Parent"]);
  }
  return { w: 612, h: 792 };
}

// Run one or more qpdf commands and return the requested output files.
// cmd: { args: [...], outputs: [paths], expectPages: [n per output] }
async function runQpdf({ inputs, commands, password, outputPassword }) {
  const q = await newQpdf();
  q.FS.mkdir("/out");
  inputs.forEach((f, i) => q.FS.writeFile(`/in${i}.pdf`, f));
  const results = [];
  for (let c = 0; c < commands.length; c++) {
    const cmd = commands[c];
    progress(cmd.label || "Working…", c / commands.length);
    ok(q.run(cmd.args), cmd.what || "Processing");
    cmd.outputs.forEach((p, k) => {
      const exp = cmd.expectPages ? cmd.expectPages[k] : null;
      verify(q, p, outputPassword ?? password, exp);
      results.push({ name: cmd.names[k], data: q.FS.readFile(p) });
      q.FS.unlink(p);
    });
  }
  return { files: results };
}

// ---------------------------------------------------------- compression ---

const SKIP_FILTERS = new Set(["/JBIG2Decode", "/CCITTFaxDecode", "/JPXDecode", "/RunLengthDecode"]);

function filterList(f) {
  if (!f) return [];
  return Array.isArray(f) ? f : [f];
}

// Decide whether an image object is safe to re-encode as JPEG. Mirrors pdftool.py.
function candidate(objects, dict) {
  if (dict["/ImageMask"] === true || "/Decode" in dict) return null;
  if (Array.isArray(dict["/Mask"])) return null; // colour-key masks need exact pixels
  if (Number(resolve(objects, dict["/BitsPerComponent"]) ?? 8) !== 8) return null;
  const filters = filterList(resolve(objects, dict["/Filter"]));
  if (filters.some((f) => SKIP_FILTERS.has(f))) return null;
  if (filters.length > 1) return null;
  const isJpeg = filters[0] === "/DCTDecode";
  const cs = resolve(objects, dict["/ColorSpace"]);
  let comps;
  if (cs === "/DeviceRGB") comps = 3;
  else if (cs === "/DeviceGray") comps = 1;
  else if (Array.isArray(cs) && cs.length === 2 && cs[0] === "/ICCBased") {
    const icc = resolve(objects, cs[1]);
    const n = Number(resolve(objects, icc?.dict?.["/N"]));
    if (n === 1 || n === 3) comps = n;
  }
  if (!comps) return null; // CMYK, Indexed, Separation, Lab… are left alone
  return { comps, isJpeg };
}

// Remove APP1 (EXIF/XMP) segments: PDF viewers ignore EXIF rotation, so the
// browser must not apply it while decoding either.
function stripExif(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const parts = [bytes.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1];
    if (marker === 0xda) break; // start of scan: rest is image data
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker !== 0xe1) parts.push(bytes.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  parts.push(bytes.subarray(i));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function decodeImage(bytes, isJpeg, comps, w, h) {
  if (isJpeg) {
    const bmp = await createImageBitmap(new Blob([stripExif(bytes)], { type: "image/jpeg" }),
      { imageOrientation: "none", colorSpaceConversion: "none", premultiplyAlpha: "none" });
    if (bmp.width !== w || bmp.height !== h) { bmp.close(); return null; }
    return bmp;
  }
  if (bytes.length !== w * h * comps) return null; // unexpected layout: leave it alone
  const rgba = new Uint8ClampedArray(w * h * 4);
  if (comps === 3) {
    for (let i = 0, j = 0; i < bytes.length; i += 3, j += 4) {
      rgba[j] = bytes[i]; rgba[j + 1] = bytes[i + 1]; rgba[j + 2] = bytes[i + 2]; rgba[j + 3] = 255;
    }
  } else {
    for (let i = 0, j = 0; i < bytes.length; i++, j += 4) {
      rgba[j] = rgba[j + 1] = rgba[j + 2] = bytes[i]; rgba[j + 3] = 255;
    }
  }
  return createImageBitmap(new ImageData(rgba, w, h));
}

// Downscale in halving steps for a sharper result than one big jump.
function resizeTo(bmp, tw, th) {
  let src = bmp, sw = bmp.width, sh = bmp.height;
  while (sw / 2 >= tw && sh / 2 >= th) {
    const c = new OffscreenCanvas(Math.round(sw / 2), Math.round(sh / 2));
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, c.width, c.height);
    src = c; sw = c.width; sh = c.height;
  }
  const out = new OffscreenCanvas(tw, th);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, tw, th);
  return out;
}

async function encodeJpeg(canvas, quality) {
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: quality / 100 });
  return new Uint8Array(await blob.arrayBuffer());
}

function streamLength(objects, dict) {
  return Number(resolve(objects, dict["/Length"])) || 0;
}

// Two lossless packing strategies; keep whichever produces the smaller file.
function pack(q, pw, extra, outPath) {
  let best = null;
  const variants = [
    ["--recompress-flate", "--compression-level=9"],
    ["--decode-level=none"], // keeps existing Flate data (and its PNG predictors) as is
  ];
  for (let i = 0; i < variants.length; i++) {
    const tmp = `/pack${i}.pdf`;
    const r = q.run([...pwArgs(pw), "/in.pdf", ...extra, "--object-streams=generate",
      "--compress-streams=y", ...variants[i], tmp]);
    if (r.rc !== 0 && r.rc !== 3) { if (i === 0) ok(r, "Saving"); continue; }
    const size = q.FS.stat(tmp).size;
    if (!best || size < best.size) {
      if (best) q.FS.unlink(best.path);
      best = { path: tmp, size };
    } else q.FS.unlink(tmp);
  }
  q.FS.rename(best.path, outPath);
  return best.size;
}

async function compress({ data, password, steps, targetBytes, lossless }) {
  const q = await newQpdf();
  q.FS.writeFile("/in.pdf", data);
  progress("Reading the PDF…", 0);
  ok(q.run([...pwArgs(password), "/in.pdf", "--json-output", "--json-key=qpdf", "--json-key=pages",
    "--json-stream-data=none", "/list.json"]), "Reading the PDF");
  const j = JSON.parse(q.FS.readFile("/list.json", { encoding: "utf8" }));
  q.FS.unlink("/list.json");
  const objects = j.qpdf[1];
  const nPages = j.pages.length;

  // An image can never be shown bigger than the largest page. Pages bigger than
  // A4 (common for scans) get shrunk to fit paper when printed, so cap there.
  let maxEdge = 0;
  for (const p of j.pages) {
    const b = pageBox(objects, p.object);
    maxEdge = Math.max(maxEdge, b.w, b.h);
  }
  const maxInches = Math.min((maxEdge || 792) / 72, 11.7);

  const images = [];
  for (const [key, v] of Object.entries(objects)) {
    const dict = v.stream?.dict;
    if (!dict || dict["/Subtype"] !== "/Image") continue;
    const c = candidate(objects, dict);
    if (c) images.push({ key, dict, ...c, w: Number(resolve(objects, dict["/Width"])),
      h: Number(resolve(objects, dict["/Height"])), oldLen: streamLength(objects, dict) });
  }

  const attempt = async (dpi, quality, stepLabel) => {
    const maxPx = Math.round(maxInches * dpi);
    const updates = {};
    let changed = 0;
    if (!lossless) {
      for (let i = 0; i < images.length; i++) {
        const im = images[i];
        progress(`${stepLabel}Image ${i + 1} of ${images.length}…`, i / images.length);
        const longest = Math.max(im.w, im.h);
        if (im.isJpeg && longest <= maxPx) continue; // re-encoding would only lose quality
        const id = im.key.match(/^obj:(\d+) (\d+) R$/);
        q.FS.mkdir("/x");
        const r = q.run([...pwArgs(password), "/in.pdf", "--json-output", "--json-key=qpdf",
          `--json-object=${id[1]},${id[2]}`, "--json-stream-data=file", "--json-stream-prefix=/x/s",
          "--decode-level=generalized", "/x/one.json"]);
        let raw = null, rawIsJpeg = false;
        if (r.rc === 0 || r.rc === 3) {
          const one = JSON.parse(q.FS.readFile("/x/one.json", { encoding: "utf8" })).qpdf[1][im.key];
          const f = filterList(one?.stream?.dict?.["/Filter"]);
          if (one?.stream?.datafile && (f.length === 0 || (f.length === 1 && f[0] === "/DCTDecode"))) {
            raw = q.FS.readFile(one.stream.datafile);
            rawIsJpeg = f.length === 1;
          }
        }
        for (const name of q.FS.readdir("/x")) if (name !== "." && name !== "..") q.FS.unlink(`/x/${name}`);
        q.FS.rmdir("/x");
        if (!raw) continue;

        let bmp;
        try { bmp = await decodeImage(raw, rawIsJpeg, im.comps, im.w, im.h); } catch { bmp = null; }
        raw = null;
        if (!bmp) continue;
        const scale = longest > maxPx ? maxPx / longest : 1;
        const tw = Math.max(1, Math.round(im.w * scale)), th = Math.max(1, Math.round(im.h * scale));
        const canvas = resizeTo(bmp, tw, th);
        bmp.close();
        const jpeg = await encodeJpeg(canvas, quality);
        if (jpeg.length >= im.oldLen) continue;

        const path = `/r${id[1]}.jpg`;
        q.FS.writeFile(path, jpeg);
        const dict = { ...im.dict };
        delete dict["/Filter"]; delete dict["/DecodeParms"]; delete dict["/Length"];
        dict["/Width"] = tw;
        dict["/Height"] = th;
        dict["/BitsPerComponent"] = 8;
        dict["/Filter"] = "/DCTDecode";
        // browsers always write 3-channel JPEGs; grey sources become DeviceRGB
        if (im.comps === 1) dict["/ColorSpace"] = "/DeviceRGB";
        updates[im.key] = { stream: { dict, datafile: path } };
        changed++;
      }
    }
    const extra = [];
    if (changed) {
      const h = j.qpdf[0];
      q.FS.writeFile("/u.json", JSON.stringify({ qpdf: [{ jsonversion: 2,
        pushedinheritedpageresources: h.pushedinheritedpageresources, calledgetallpages: h.calledgetallpages,
        maxobjectid: h.maxobjectid }, updates] }));
      extra.push("--update-from-json=/u.json");
    }
    progress(`${stepLabel}Saving…`, 1);
    const size = pack(q, password, extra, "/out.pdf");
    for (const u of Object.values(updates)) q.FS.unlink(u.stream.datafile);
    if (changed) q.FS.unlink("/u.json");
    return { size, changed };
  };

  let result, used;
  for (let s = 0; s < steps.length; s++) {
    const [dpi, quality] = steps[s];
    const label = steps.length > 1 ? `Try ${s + 1}: ` : "";
    result = await attempt(dpi, quality, label);
    used = steps[s];
    if (!targetBytes || result.size <= targetBytes) break;
    if (s < steps.length - 1) q.FS.unlink("/out.pdf");
  }
  progress("Checking the result…", 1);
  verify(q, "/out.pdf", password, nPages);
  return {
    files: [{ data: q.FS.readFile("/out.pdf") }],
    changed: result.changed,
    totalImages: images.length,
    used,
    metTarget: !targetBytes || result.size <= targetBytes,
  };
}

// ----------------------------------------------------------------- main ---

const OPS = { inspect, checkPassword, runQpdf, compress };

onmessage = async ({ data: msg }) => {
  try {
    const result = await OPS[msg.op](msg);
    const transfer = (result.files || []).map((f) => f.data.buffer);
    postMessage({ type: "done", result }, transfer);
  } catch (e) {
    postMessage({ type: "error", message: e.message || String(e), detail: e.detail || "" });
  }
};

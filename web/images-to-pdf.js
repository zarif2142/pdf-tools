// Builds a PDF from images, one image per page.
//
// JPEGs are embedded byte-for-byte (no quality loss) and their EXIF rotation is
// applied by the page geometry, not by re-encoding. PNG, GIF, BMP and lossless
// WEBP are stored losslessly (Flate). HEIC/AVIF/lossy WEBP photos become
// high-quality JPEGs. The result is then normalised and checked by qpdf.

import { decodeToBitmap } from "./images.js";

const enc = new TextEncoder();
const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

// ------------------------------------------------------------ JPEG info ---

function jpegInfo(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2, orientation = 1, info = null;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78) orientation = exifOrientation(b, i + 10) || 1;
    // SOF0-SOF15 except DHT (c4), JPG (c8), DAC (cc)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      info = { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8], comps: b[i + 9] };
    }
    if (m === 0xda) break;
    i += 2 + len;
  }
  return info && { ...info, orientation };
}

function exifOrientation(b, t) {
  const le = b[t] === 0x49;
  const u16 = (o) => (le ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
  const u32 = (o) => (le ? (u16(o) | (u16(o + 2) << 16)) >>> 0 : ((u16(o) << 16) | u16(o + 2)) >>> 0);
  if (t + 8 > b.length) return 1;
  const ifd = u32(4);
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (t + e + 10 > b.length) break;
    if (u16(e) === 0x0112) return u16(e + 8);
  }
  return 1;
}

// ------------------------------------------------------- image encoding ---

async function deflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function isLossyWebp(b) {
  return b.length > 16 && String.fromCharCode(...b.subarray(8, 12)) === "WEBP" &&
    String.fromCharCode(...b.subarray(12, 16)) === "VP8 ";
}

// Returns { w, h, orientation, objects: { image: {dict, data}, smask?: {...} } }
async function prepareImage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const jpg = jpegInfo(bytes);
  if (jpg && (jpg.comps === 1 || jpg.comps === 3)) {
    return {
      w: jpg.w, h: jpg.h, orientation: jpg.orientation,
      image: { dict: `/Type /XObject /Subtype /Image /Width ${jpg.w} /Height ${jpg.h} ` +
        `/ColorSpace /${jpg.comps === 1 ? "DeviceGray" : "DeviceRGB"} /BitsPerComponent 8 /Filter /DCTDecode`,
        data: bytes },
    };
  }

  const bmp = await decodeToBitmap(file); // EXIF orientation already applied here
  const { width: w, height: h } = bmp;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  const photo = /heic|heif|avif/i.test(file.type + file.name) || isLossyWebp(bytes) || jpg;

  if (photo) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
    const data = new Uint8Array(await blob.arrayBuffer());
    return { w, h, orientation: 1, image: { dict: `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} ` +
      "/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", data } };
  }

  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const px = ctx.getImageData(0, 0, w, h).data;
  let gray = true, opaque = true;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] !== px[i + 1] || px[i] !== px[i + 2]) gray = false;
    if (px[i + 3] !== 255) opaque = false;
    if (!gray && !opaque) break;
  }
  const comps = gray ? 1 : 3;
  const color = new Uint8Array(w * h * comps);
  const alpha = opaque ? null : new Uint8Array(w * h);
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    if (gray) color[p] = px[i];
    else { color[p * 3] = px[i]; color[p * 3 + 1] = px[i + 1]; color[p * 3 + 2] = px[i + 2]; }
    if (alpha) alpha[p] = px[i + 3];
  }
  const out = {
    w, h, orientation: 1,
    image: { dict: `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} ` +
      `/ColorSpace /${gray ? "DeviceGray" : "DeviceRGB"} /BitsPerComponent 8 /Filter /FlateDecode`,
      data: await deflate(color) },
  };
  if (alpha) {
    out.smask = { dict: `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} ` +
      "/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode", data: await deflate(alpha) };
  }
  return out;
}

// ------------------------------------------------------------- geometry ---

// Maps the image's unit square to its place on the page, applying one of the
// eight EXIF orientations. (u, v) = (0, 0) is the stored image's bottom-left.
function placement(img, x0, y0, s) {
  const { w: W, h: H, orientation: o } = img;
  const swap = o >= 5;
  const Dh = swap ? W : H;
  const toDisplay = (px, py) => {
    switch (o) {
      case 2: return [W - px, py];
      case 3: return [W - px, H - py];
      case 4: return [px, H - py];
      case 5: return [py, px];
      case 6: return [H - py, px];
      case 7: return [H - py, W - px];
      case 8: return [py, W - px];
      default: return [px, py];
    }
  };
  const P = (u, v) => {
    const [x, y] = toDisplay(u * W, (1 - v) * H);
    return [x0 + x * s, y0 + (Dh - y) * s];
  };
  const [e, f] = P(0, 0), [a1, b1] = P(1, 0), [c1, d1] = P(0, 1);
  return [a1 - e, b1 - f, c1 - e, d1 - f, e, f];
}

function layout(img, pageSize) {
  const swap = img.orientation >= 5;
  const dw = swap ? img.h : img.w, dh = swap ? img.w : img.h;
  if (pageSize === "fit") {
    // no margins; long edge = A4's long edge so it prints at a normal size
    const s = 841.89 / Math.max(dw, dh);
    return { pw: dw * s, ph: dh * s, matrix: placement(img, 0, 0, s) };
  }
  let [pw, ph] = PAGE_SIZES[pageSize];
  if (dw > dh) [pw, ph] = [ph, pw]; // landscape pictures get landscape pages
  const margin = 18;
  const s = Math.min((pw - 2 * margin) / dw, (ph - 2 * margin) / dh);
  const x0 = (pw - dw * s) / 2, y0 = (ph - dh * s) / 2;
  return { pw, ph, matrix: placement(img, x0, y0, s) };
}

// --------------------------------------------------------------- writer ---

const num = (n) => (Math.round(n * 1000) / 1000).toString();

export async function imagesToPdf(files, pageSize, onProgress) {
  const chunks = [];
  let offset = 0;
  const offsets = [];
  const push = (x) => {
    const b = typeof x === "string" ? enc.encode(x) : x;
    chunks.push(b);
    offset += b.length;
  };
  let nextId = 3; // 1 = catalog, 2 = page tree
  const obj = (id, body) => { offsets[id] = offset; push(`${id} 0 obj\n${body}\nendobj\n`); };
  const stream = (id, dict, data) => {
    offsets[id] = offset;
    push(`${id} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`);
    push(data);
    push("\nendstream\nendobj\n");
  };

  // header plus four high bytes, which marks the file as binary for old tools
  push(new Uint8Array([...enc.encode("%PDF-1.7\n%"), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const pageIds = [];
  for (let i = 0; i < files.length; i++) {
    onProgress?.(`Adding image ${i + 1} of ${files.length}…`, i / files.length);
    const img = await prepareImage(files[i]);
    const { pw, ph, matrix } = layout(img, pageSize);
    const imgId = nextId++, contentId = nextId++, pageId = nextId++;
    let smaskRef = "";
    if (img.smask) {
      const smId = nextId++;
      stream(smId, img.smask.dict, img.smask.data);
      smaskRef = ` /SMask ${smId} 0 R`;
    }
    stream(imgId, img.image.dict + smaskRef, img.image.data);
    stream(contentId, "", enc.encode(`q ${matrix.map(num).join(" ")} cm /Im0 Do Q`));
    obj(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pw)} ${num(ph)}] ` +
      `/Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);

  const xref = offset;
  let x = `xref\n0 ${nextId}\n0000000000 65535 f \n`;
  for (let id = 1; id < nextId; id++) x += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  push(x + `trailer\n<< /Size ${nextId} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(offset);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return { data: out, pages: pageIds.length };
}

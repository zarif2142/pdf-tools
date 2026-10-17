// Image decoding/encoding with the browser's own codecs. HEIC (iPhone photos)
// is decoded natively where the browser can (Safari); elsewhere the bundled
// libheif build is loaded on first use.

const HEIC_RE = /\.(heic|heif)$/i;

export function isHeic(file) {
  return /heic|heif/i.test(file.type) || HEIC_RE.test(file.name);
}

export async function decodeToBitmap(file) {
  // 'from-image' applies EXIF rotation so phone photos come out upright
  const opts = { imageOrientation: "from-image" };
  try {
    return await createImageBitmap(file, opts);
  } catch (e) {
    if (!isHeic(file)) throw new Error(`Can't read ${file.name}: this browser doesn't support that image type.`);
  }
  const { heicTo } = await import("./vendor/heic-to/heic-to.js");
  try {
    return await heicTo({ blob: file, type: "bitmap", options: opts });
  } catch {
    throw new Error(`Can't read ${file.name}. It may be damaged or use an unsupported HEIC variant.`);
  }
}

export const OUTPUT_TYPES = {
  jpg: { mime: "image/jpeg", label: "JPG", lossy: true, opaque: true },
  png: { mime: "image/png", label: "PNG", lossy: false },
  webp: { mime: "image/webp", label: "WEBP", lossy: true },
};

// Draw, optionally shrink, and re-encode. Metadata (EXIF, GPS) is never copied.
export async function convertImage(file, type, quality, maxSize) {
  const t = OUTPUT_TYPES[type];
  const bmp = await decodeToBitmap(file);
  let w = bmp.width, h = bmp.height;
  if (maxSize && Math.max(w, h) > maxSize) {
    const s = maxSize / Math.max(w, h);
    w = Math.max(1, Math.round(w * s));
    h = Math.max(1, Math.round(h * s));
  }
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  if (t.opaque) {
    ctx.fillStyle = "#fff"; // JPG has no transparency: use white, not black
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: t.mime, quality: quality / 100 });
  if (blob.type !== t.mime) throw new Error(`This browser can't save ${t.label} files.`);
  return blob;
}

export async function deflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// Canvas -> PDF image in qpdf JSON form: lossless colour plus, where the
// canvas has transparency (signatures), a soft mask.
export async function canvasToPdfImage(canvas) {
  const { width: w, height: h } = canvas;
  const px = canvas.getContext("2d").getImageData(0, 0, w, h).data;
  const color = new Uint8Array(w * h * 3);
  const alpha = new Uint8Array(w * h);
  let opaque = true;
  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    color[p * 3] = px[i]; color[p * 3 + 1] = px[i + 1]; color[p * 3 + 2] = px[i + 2];
    alpha[p] = px[i + 3];
    if (px[i + 3] !== 255) opaque = false;
  }
  const dict = (cs) => ({ "/Type": "/XObject", "/Subtype": "/Image", "/Width": w, "/Height": h,
    "/ColorSpace": cs, "/BitsPerComponent": 8, "/Filter": "/FlateDecode" });
  const out = { dict: dict("/DeviceRGB"), data: await deflate(color) };
  if (!opaque) out.smask = { dict: dict("/DeviceGray"), data: await deflate(alpha) };
  return out;
}

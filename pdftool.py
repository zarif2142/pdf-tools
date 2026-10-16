#!/usr/bin/env python3
"""pdftool: offline PDF and image utilities.

Everything runs locally. No network calls, no telemetry. The heavy lifting is
done by well-known open-source libraries:

  pikepdf    (qpdf)   - reading, writing, merging, splitting, encryption
  pypdfium2  (PDFium) - rendering pages to images (same engine as Chrome)
  Pillow              - image decoding/encoding
  pillow-heif         - HEIC/HEIF (iPhone photos)
  img2pdf             - lossless images -> PDF

Safety rules applied to every command:
  * Inputs are never modified. Outputs that already exist are not overwritten
    unless --force is given.
  * Outputs are written to a temporary file next to the destination, checked,
    and only then moved into place, so a crash never leaves a half-written file.
  * Every PDF written is re-opened and its page count verified.
  * Passwords are read with a hidden prompt, never from the command line.
"""

from __future__ import annotations

import argparse
import getpass
import io
import os
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium
from PIL import Image, ImageOps

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:  # HEIC support is optional
    pass


class ToolError(Exception):
    pass


# ---------------------------------------------------------------- helpers ---


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return str(n)


def parse_ranges(spec: str, n_pages: int) -> list[int]:
    """Turn '1-3,5,8-' into zero-based page indexes (order kept, 'last' allowed)."""
    out: list[int] = []

    def num(tok: str) -> int:
        tok = tok.strip().lower()
        v = n_pages if tok in ("last", "end") else int(tok)
        if not 1 <= v <= n_pages:
            raise ToolError(f"page {v} is out of range (document has {n_pages} pages)")
        return v

    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            if "-" in part:
                a, b = part.split("-", 1)
                start = num(a) if a.strip() else 1
                end = num(b) if b.strip() else n_pages
                step = 1 if end >= start else -1
                out.extend(range(start - 1, end - 1 + step, step))
            else:
                out.append(num(part) - 1)
        except ValueError:
            raise ToolError(f"cannot understand page range '{part}'") from None
    if not out:
        raise ToolError("no pages selected")
    return out


def password_for(path: Path) -> str | None:
    """Return None for unprotected PDFs, otherwise prompt (hidden) until it works."""
    if not path.is_file():
        raise ToolError(f"file not found: {path}")
    try:
        pikepdf.open(path).close()
        return None
    except pikepdf.PasswordError:
        pass
    except pikepdf.PdfError as e:
        raise ToolError(f"{path.name} is not a readable PDF: {e}") from None
    for _ in range(3):
        pw = getpass.getpass(f"Password for {path.name}: ")
        try:
            pikepdf.open(path, password=pw).close()
            return pw
        except pikepdf.PasswordError:
            print("wrong password", file=sys.stderr)
    raise ToolError("wrong password")


def open_pdf(path: Path, password: str | None = None) -> pikepdf.Pdf:
    if password is None:
        password = password_for(path)
    try:
        return pikepdf.open(path, password=password or "")
    except pikepdf.PdfError as e:
        raise ToolError(f"{path.name} is not a readable PDF: {e}") from None


def default_out(src: Path, suffix: str, ext: str | None = None) -> Path:
    return src.with_name(f"{src.stem}-{suffix}{ext or src.suffix}")


def check_dest(dest: Path, force: bool, sources: list[Path] = ()) -> None:
    for s in sources:
        if dest.exists() and s.exists() and dest.resolve() == s.resolve():
            raise ToolError(f"refusing to overwrite the input file {dest}")
    if dest.exists() and not force:
        raise ToolError(f"{dest} already exists (use --force to overwrite)")
    dest.parent.mkdir(parents=True, exist_ok=True)


@contextmanager
def atomic_path(dest: Path):
    """Yield a temp path in dest's folder; move it onto dest only on success."""
    fd, tmp = tempfile.mkstemp(prefix=f".{dest.stem}-", suffix=dest.suffix, dir=dest.parent)
    os.close(fd)
    tmp_path = Path(tmp)
    try:
        yield tmp_path
        os.replace(tmp_path, dest)
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


def verify_pdf(path: Path, expected_pages: int | None, password: str = "") -> None:
    """Open with both qpdf and PDFium; fail loudly if either disagrees."""
    with pikepdf.open(path, password=password) as p:
        n = len(p.pages)
    doc = pdfium.PdfDocument(str(path), password=password or None)
    try:
        if len(doc) != n:
            raise ToolError("verification failed: page count mismatch between engines")
        if n:
            doc[0].render(scale=0.1)  # make sure the first page actually renders
    finally:
        doc.close()
    if expected_pages is not None and n != expected_pages:
        raise ToolError(f"verification failed: expected {expected_pages} pages, got {n}")


def save_pdf(pdf: pikepdf.Pdf, dest: Path, expected_pages: int | None, **save_kw) -> None:
    save_kw.setdefault("compress_streams", True)
    save_kw.setdefault("object_stream_mode", pikepdf.ObjectStreamMode.generate)
    password = ""
    enc = save_kw.get("encryption")
    if enc:
        password = enc.owner
    with atomic_path(dest) as tmp:
        pdf.save(tmp, **save_kw)
        verify_pdf(tmp, expected_pages, password)


def report(src_size: int | None, dest: Path) -> None:
    new = dest.stat().st_size
    if src_size:
        pct = (1 - new / src_size) * 100
        print(f"wrote {dest}  ({human(src_size)} -> {human(new)}, {pct:.0f}% smaller)"
              if pct >= 0 else f"wrote {dest}  ({human(src_size)} -> {human(new)})")
    else:
        print(f"wrote {dest}  ({human(new)})")


# --------------------------------------------------------------- compress ---

PRESETS = {
    # name: (target dpi, jpeg quality)
    "high": (200, 85),
    "medium": (150, 75),
    "low": (100, 60),
    "tiny": (72, 45),
}


def _page_max_inches(pdf: pikepdf.Pdf) -> float:
    """Largest page edge in inches; an image can never be shown bigger than this."""
    best = 0.0
    for page in pdf.pages:
        box = page.mediabox
        w = abs(float(box[2]) - float(box[0]))
        h = abs(float(box[3]) - float(box[1]))
        best = max(best, w, h)
    # Scans and phone photos often declare poster-sized pages (pixels taken as
    # points). Anything bigger than A4 gets shrunk to fit paper when printed, so
    # measure the target resolution against A4's long edge at most.
    return min((best or 792) / 72.0, 11.7)


def _recompress_image(obj: pikepdf.Stream, max_px: int, quality: int) -> int:
    """Re-encode one image as JPEG if that is safe and smaller. Returns bytes saved."""
    if obj.get("/ImageMask", False) or "/Decode" in obj:
        return 0
    if isinstance(obj.get("/Mask"), pikepdf.Array):
        return 0  # colour-key masks depend on exact pixel values; JPEG would break them
    if int(obj.get("/BitsPerComponent", 8)) != 8:
        return 0
    filters = obj.get("/Filter")
    flist = [filters] if isinstance(filters, pikepdf.Name) else list(filters or [])
    if any(f in ("/JBIG2Decode", "/CCITTFaxDecode", "/JPXDecode") for f in flist):
        return 0
    cs = obj.get("/ColorSpace")
    if cs in ("/DeviceRGB", "/DeviceGray"):
        pass
    elif isinstance(cs, pikepdf.Array) and len(cs) == 2 and cs[0] == "/ICCBased" and int(cs[1].get("/N", 0)) in (1, 3):
        pass
    else:
        return 0  # CMYK, Indexed, Separation etc. are left alone

    try:
        pil = pikepdf.PdfImage(obj).as_pil_image()
    except Exception:
        return 0
    if pil.mode not in ("RGB", "L"):
        return 0

    w, h = pil.size
    longest = max(w, h)
    if longest > max_px:
        scale = max_px / longest
        pil = pil.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    elif "/DCTDecode" in flist:
        return 0  # already a JPEG at acceptable resolution: re-encoding only loses quality

    buf = io.BytesIO()
    pil.save(buf, format="JPEG", quality=quality, optimize=True, progressive=True)
    data = buf.getvalue()
    old_len = len(obj.read_raw_bytes())
    if len(data) >= old_len:
        return 0

    obj.write(data, filter=pikepdf.Name.DCTDecode)
    obj.Width, obj.Height = pil.size
    obj.BitsPerComponent = 8
    if not isinstance(cs, pikepdf.Array):
        obj.ColorSpace = pikepdf.Name.DeviceRGB if pil.mode == "RGB" else pikepdf.Name.DeviceGray
    if "/DecodeParms" in obj:
        del obj.DecodeParms
    return old_len - len(data)


def cmd_compress(a) -> None:
    src = Path(a.input)
    dest = Path(a.output) if a.output else default_out(src, "compressed")
    check_dest(dest, a.force, [src])
    src_size = src.stat().st_size
    with open_pdf(src) as pdf:
        n = len(pdf.pages)
        saved = changed = 0
        if not a.lossless:
            dpi, quality = PRESETS[a.level]
            if a.dpi:
                dpi = a.dpi
            if a.quality:
                quality = a.quality
            max_px = int(_page_max_inches(pdf) * dpi)
            for obj in pdf.objects:
                if isinstance(obj, pikepdf.Stream) and obj.get("/Subtype") == "/Image":
                    s = _recompress_image(obj, max_px, quality)
                    if s:
                        saved += s
                        changed += 1
        pdf.remove_unreferenced_resources()
        # Two lossless packing strategies; recompressing Flate streams usually
        # wins, but drops PNG predictors, which can make image-heavy files bigger.
        # Try both and keep whichever is smaller.
        best = None
        for kw in ({"recompress_flate": True},
                   {"stream_decode_level": pikepdf.StreamDecodeLevel.none}):
            fd, tmp = tempfile.mkstemp(prefix=f".{dest.stem}-try", dir=dest.parent)
            os.close(fd)
            try:
                pdf.save(tmp, compress_streams=True,
                         object_stream_mode=pikepdf.ObjectStreamMode.generate, **kw)
                size = os.path.getsize(tmp)
            finally:
                os.unlink(tmp)
            if best is None or size < best[0]:
                best = (size, kw)
        if not changed and best[0] >= src_size:
            print("this PDF is already as small as it can be made without losing quality;"
                  " nothing written. Try a lossy level, e.g. --level low.")
            return
        save_pdf(pdf, dest, n, **best[1])
    if not a.lossless:
        print(f"re-encoded {changed} image(s)")
    report(src_size, dest)


# ------------------------------------------------------- page operations ---


def cmd_merge(a) -> None:
    srcs = [Path(p) for p in a.inputs]
    dest = Path(a.output)
    check_dest(dest, a.force, srcs)
    out = pikepdf.new()
    total = 0
    opened = []
    try:
        for s in srcs:
            p = open_pdf(s)
            opened.append(p)
            out.pages.extend(p.pages)
            total += len(p.pages)
        save_pdf(out, dest, total)
    finally:
        for p in opened:
            p.close()
    report(None, dest)


def cmd_split(a) -> None:
    src = Path(a.input)
    outdir = Path(a.outdir) if a.outdir else src.with_name(f"{src.stem}-split")
    outdir.mkdir(parents=True, exist_ok=True)
    with open_pdf(src) as pdf:
        n = len(pdf.pages)
        if a.ranges:
            groups = [parse_ranges(r, n) for r in a.ranges.split(";")]
        else:
            size = a.every
            groups = [list(range(i, min(i + size, n))) for i in range(0, n, size)]
        width = len(str(len(groups)))
        for i, idxs in enumerate(groups, 1):
            dest = outdir / f"{src.stem}-{i:0{width}d}.pdf"
            check_dest(dest, a.force, [src])
            part = pikepdf.new()
            for j in idxs:
                part.pages.append(pdf.pages[j])
            part.remove_unreferenced_resources()
            save_pdf(part, dest, len(idxs))
            print(f"wrote {dest}  (pages {', '.join(_fmt(idxs))})")


def _fmt(idxs: list[int]) -> list[str]:
    """Compact [0,1,2,4] -> ['1-3', '5'] for messages."""
    out, start, prev = [], None, None
    for i in idxs + [None]:
        if start is None:
            start = prev = i
        elif i is not None and i == prev + 1:
            prev = i
        else:
            out.append(f"{start + 1}" if start == prev else f"{start + 1}-{prev + 1}")
            start = prev = i
    return out


def _select(a, keep: bool) -> None:
    src = Path(a.input)
    dest = Path(a.output) if a.output else default_out(src, "pages" if keep else "trimmed")
    check_dest(dest, a.force, [src])
    with open_pdf(src) as pdf:
        n = len(pdf.pages)
        chosen = parse_ranges(a.pages, n)
        if keep:
            order = chosen
        else:
            drop = set(chosen)
            order = [i for i in range(n) if i not in drop]
            if not order:
                raise ToolError("that would delete every page")
        out = pikepdf.new()
        for i in order:
            out.pages.append(pdf.pages[i])
        out.remove_unreferenced_resources()
        save_pdf(out, dest, len(order))
    print(f"{len(order)} of {n} pages kept")
    report(None, dest)


def cmd_extract(a) -> None:
    _select(a, keep=True)


def cmd_delete(a) -> None:
    _select(a, keep=False)


def cmd_rotate(a) -> None:
    if a.angle % 90:
        raise ToolError("angle must be a multiple of 90")
    src = Path(a.input)
    dest = Path(a.output) if a.output else default_out(src, "rotated")
    check_dest(dest, a.force, [src])
    with open_pdf(src) as pdf:
        n = len(pdf.pages)
        idxs = parse_ranges(a.pages, n) if a.pages else range(n)
        for i in idxs:
            pdf.pages[i].rotate(a.angle, relative=True)
        save_pdf(pdf, dest, n)
    report(None, dest)


# ------------------------------------------------------ security & cleanup ---


def _new_password(prompt: str) -> str:
    pw = getpass.getpass(prompt)
    if not pw:
        raise ToolError("password cannot be empty")
    if getpass.getpass("Repeat: ") != pw:
        raise ToolError("passwords do not match")
    return pw


def cmd_encrypt(a) -> None:
    src = Path(a.input)
    dest = Path(a.output) if a.output else default_out(src, "locked")
    check_dest(dest, a.force, [src])
    pw = _new_password("New password to open the PDF: ")
    with open_pdf(src) as pdf:
        enc = pikepdf.Encryption(owner=pw, user=pw, R=6)  # AES-256
        save_pdf(pdf, dest, len(pdf.pages), encryption=enc)
    report(None, dest)


def cmd_decrypt(a) -> None:
    src = Path(a.input)
    dest = Path(a.output) if a.output else default_out(src, "unlocked")
    check_dest(dest, a.force, [src])
    with open_pdf(src) as pdf:
        if not pdf.is_encrypted:
            raise ToolError(f"{src.name} is not password-protected")
        save_pdf(pdf, dest, len(pdf.pages), encryption=False)
    report(None, dest)


def cmd_clean(a) -> None:
    """Remove document metadata (author, software, dates, XMP)."""
    src = Path(a.input)
    dest = Path(a.output) if a.output else default_out(src, "clean")
    check_dest(dest, a.force, [src])
    with open_pdf(src) as pdf:
        if "/Metadata" in pdf.Root:
            del pdf.Root.Metadata
        for page in pdf.pages:
            if "/Metadata" in page.obj:
                del page.obj.Metadata
        del pdf.docinfo
        save_pdf(pdf, dest, len(pdf.pages), fix_metadata_version=False,
                 deterministic_id=True)
    report(None, dest)


def cmd_info(a) -> None:
    src = Path(a.input)
    with open_pdf(src) as pdf:
        print(f"file:       {src}")
        print(f"size:       {human(src.stat().st_size)}")
        print(f"pages:      {len(pdf.pages)}")
        print(f"version:    PDF {pdf.pdf_version}")
        print(f"encrypted:  {'yes' if pdf.is_encrypted else 'no'}")
        n_img = sum(1 for o in pdf.objects
                    if isinstance(o, pikepdf.Stream) and o.get("/Subtype") == "/Image")
        print(f"images:     {n_img}")
        if pdf.pages:
            b = pdf.pages[0].mediabox
            w, h = float(b[2]) - float(b[0]), float(b[3]) - float(b[1])
            print(f"page 1:     {w / 72 * 25.4:.0f} x {h / 72 * 25.4:.0f} mm")
        for k, v in pdf.docinfo.items():
            print(f"{k[1:]:<11} {v}")


# ----------------------------------------------------------------- images ---

IMAGE_FORMATS = {"jpg": "JPEG", "jpeg": "JPEG", "png": "PNG", "webp": "WEBP",
                 "tiff": "TIFF", "tif": "TIFF", "bmp": "BMP", "gif": "GIF",
                 "heic": "HEIF", "avif": "AVIF"}


def _flatten(img: Image.Image, fmt: str) -> Image.Image:
    """Formats without alpha get a white background instead of black."""
    if fmt in ("JPEG", "BMP") and img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, "white")
        bg.paste(img, mask=img.getchannel("A"))
        return bg
    if fmt == "JPEG" and img.mode not in ("RGB", "L"):
        return img.convert("RGB")
    return img


def _save_image(img: Image.Image, dest: Path, quality: int) -> None:
    fmt = IMAGE_FORMATS.get(dest.suffix.lower().lstrip("."))
    if not fmt:
        raise ToolError(f"unsupported output format '{dest.suffix}'")
    img = _flatten(img, fmt)
    kw = {}
    if fmt in ("JPEG", "WEBP", "HEIF", "AVIF"):
        kw["quality"] = quality
    if fmt == "JPEG":
        kw.update(optimize=True, progressive=True)
    if fmt == "PNG":
        kw["optimize"] = True
    with atomic_path(dest) as tmp:
        img.save(tmp, format=fmt, **kw)  # no exif passed: metadata is stripped
        with Image.open(tmp) as check:
            check.verify()


def cmd_convert(a) -> None:
    for name in a.inputs:
        src = Path(name)
        if not src.is_file():
            raise ToolError(f"file not found: {src}")
        ext = "." + a.to.lower().lstrip(".")
        dest = Path(a.output) if a.output and len(a.inputs) == 1 else src.with_suffix(ext)
        check_dest(dest, a.force, [src])
        with Image.open(src) as img:
            img = ImageOps.exif_transpose(img)  # keep phone photos the right way up
            if a.max_size:
                img.thumbnail((a.max_size, a.max_size), Image.LANCZOS)
            _save_image(img, dest, a.quality)
        report(src.stat().st_size, dest)


def cmd_pdf2img(a) -> None:
    src = Path(a.input)
    outdir = Path(a.outdir) if a.outdir else src.with_name(f"{src.stem}-images")
    outdir.mkdir(parents=True, exist_ok=True)
    pw = password_for(src)
    with open_pdf(src, pw or "") as p:
        n = len(p.pages)
    doc = pdfium.PdfDocument(str(src), password=pw)
    try:
        idxs = parse_ranges(a.pages, n) if a.pages else range(n)
        width = len(str(n))
        for i in idxs:
            img = doc[i].render(scale=a.dpi / 72).to_pil()
            dest = outdir / f"{src.stem}-p{i + 1:0{width}d}.{a.format}"
            check_dest(dest, a.force, [src])
            _save_image(img, dest, a.quality)
            print(f"wrote {dest}")
    finally:
        doc.close()


def cmd_img2pdf(a) -> None:
    import img2pdf

    srcs = [Path(p) for p in a.inputs]
    dest = Path(a.output)
    check_dest(dest, a.force, srcs)
    blobs = []
    for s in srcs:
        if not s.is_file():
            raise ToolError(f"file not found: {s}")
        raw = s.read_bytes()
        with Image.open(io.BytesIO(raw)) as img:
            # JPEGs and plain PNGs are embedded byte-for-byte (lossless). Anything
            # img2pdf cannot take directly (HEIC, WEBP, transparency) is re-encoded:
            # lossless PNG for graphics, high-quality JPEG for photos.
            fmt = img.format
            if fmt not in ("JPEG", "PNG") or "A" in img.getbands() or "transparency" in img.info:
                photo = fmt in ("HEIF", "AVIF", "JPEG") or (fmt == "WEBP" and not img.info.get("lossless"))
                img = _flatten(ImageOps.exif_transpose(img), "JPEG")
                buf = io.BytesIO()
                if photo:
                    img.save(buf, format="JPEG", quality=95)
                else:
                    img.save(buf, format="PNG")
                raw = buf.getvalue()
        blobs.append(raw)
    layout = None
    if a.page_size:
        sizes = {"a4": (img2pdf.mm_to_pt(210), img2pdf.mm_to_pt(297)),
                 "letter": (img2pdf.in_to_pt(8.5), img2pdf.in_to_pt(11))}
        layout = img2pdf.get_layout_fun(sizes[a.page_size])
    with atomic_path(dest) as tmp:
        tmp.write_bytes(img2pdf.convert(blobs, layout_fun=layout) if layout
                        else img2pdf.convert(blobs))
        verify_pdf(tmp, len(blobs))
    report(None, dest)


# -------------------------------------------------------------------- CLI ---


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="pdftool",
        description="Offline PDF and image utilities. Page numbers start at 1; "
                    "ranges look like 1-3,5,8- (8- means 8 to the end, 'last' is allowed).")
    sub = ap.add_subparsers(dest="cmd", required=True, metavar="command")

    def cmd(name, fn, help_):
        p = sub.add_parser(name, help=help_, description=help_)
        p.set_defaults(fn=fn)
        p.add_argument("-f", "--force", action="store_true", help="overwrite existing output")
        return p

    p = cmd("compress", cmd_compress, "make a PDF smaller")
    p.add_argument("input")
    p.add_argument("-o", "--output")
    p.add_argument("-l", "--level", choices=PRESETS, default="medium",
                   help="high=200dpi, medium=150dpi (default), low=100dpi, tiny=72dpi")
    p.add_argument("--dpi", type=int, help="override target image resolution")
    p.add_argument("--quality", type=int, help="override JPEG quality (1-95)")
    p.add_argument("--lossless", action="store_true",
                   help="only repack the file structure; never touch images")

    p = cmd("merge", cmd_merge, "join PDFs in the order given")
    p.add_argument("inputs", nargs="+")
    p.add_argument("-o", "--output", required=True)

    p = cmd("split", cmd_split, "split a PDF into several files")
    p.add_argument("input")
    p.add_argument("-d", "--outdir")
    g = p.add_mutually_exclusive_group()
    g.add_argument("-n", "--every", type=int, default=1, help="pages per file (default 1)")
    g.add_argument("-r", "--ranges", help="custom parts separated by ';', e.g. '1-3;4-10;11-'")

    p = cmd("extract", cmd_extract, "keep only the given pages (in the given order)")
    p.add_argument("input")
    p.add_argument("pages", help="e.g. 1-3,7 or 5,4,3,2,1 to reorder")
    p.add_argument("-o", "--output")

    p = cmd("delete", cmd_delete, "remove the given pages")
    p.add_argument("input")
    p.add_argument("pages")
    p.add_argument("-o", "--output")

    p = cmd("rotate", cmd_rotate, "rotate pages clockwise")
    p.add_argument("input")
    p.add_argument("angle", type=int, help="90, 180, 270 or -90")
    p.add_argument("-p", "--pages", help="only these pages (default all)")
    p.add_argument("-o", "--output")

    p = cmd("encrypt", cmd_encrypt, "password-protect a PDF (AES-256)")
    p.add_argument("input")
    p.add_argument("-o", "--output")

    p = cmd("decrypt", cmd_decrypt, "remove a password you know")
    p.add_argument("input")
    p.add_argument("-o", "--output")

    p = cmd("clean", cmd_clean, "strip metadata (author, software, dates)")
    p.add_argument("input")
    p.add_argument("-o", "--output")

    p = cmd("info", cmd_info, "show page count, size, metadata")
    p.add_argument("input")

    p = cmd("pdf2img", cmd_pdf2img, "render PDF pages to images")
    p.add_argument("input")
    p.add_argument("-d", "--outdir")
    p.add_argument("-p", "--pages")
    p.add_argument("--dpi", type=int, default=150)
    p.add_argument("--format", choices=["png", "jpg", "webp"], default="png")
    p.add_argument("--quality", type=int, default=90)

    p = cmd("img2pdf", cmd_img2pdf, "combine images into a PDF (lossless where possible)")
    p.add_argument("inputs", nargs="+")
    p.add_argument("-o", "--output", required=True)
    p.add_argument("--page-size", choices=["a4", "letter"],
                   help="fit images onto this paper size (default: page = image size)")

    p = cmd("convert", cmd_convert, "convert images, e.g. HEIC -> JPG, PNG -> WEBP")
    p.add_argument("inputs", nargs="+")
    p.add_argument("-t", "--to", required=True, help="jpg, png, webp, tiff, bmp, gif, heic, avif")
    p.add_argument("-o", "--output", help="output path (single input only)")
    p.add_argument("--quality", type=int, default=90)
    p.add_argument("--max-size", type=int, help="shrink so the longest side is at most N px")
    return ap


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        args.fn(args)
    except ToolError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\ncancelled", file=sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())

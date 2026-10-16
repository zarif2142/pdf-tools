# PDF Tools

Private replacements for the "free online PDF tools" websites, in two forms:

- **A website** (`web/`) that runs entirely in the browser. Files are processed on
  the device that opens the page and are never uploaded. Works on phones, can be
  installed like an app, and works offline after the first visit.
- **A command-line tool** (`pdftool.py`) for the same jobs on a Mac/PC.

Both are thin layers over well-known open-source engines:

| Engine | Used for |
|---|---|
| [qpdf](https://github.com/qpdf/qpdf) | merge, split, pages, rotate, passwords, metadata, compression (website: qpdf 12 compiled to WebAssembly; CLI: via [pikepdf](https://github.com/pikepdf/pikepdf)) |
| [pdf.js](https://github.com/mozilla/pdf.js) (Mozilla) / [PDFium](https://pdfium.googlesource.com/pdfium/) (Google) | rendering pages, independent check of every output |
| [libheif](https://github.com/strukturag/libheif) via [heic-to](https://github.com/hoppergee/heic-to) / [pillow-heif](https://github.com/bigcat88/pillow_heif) | iPhone HEIC photos |
| The browser's own image codecs / [Pillow](https://python-pillow.org) | JPG, PNG, WEBP |

## Website

Tools: compress (including "get it under N MB"), merge, organize pages (reorder /
rotate / delete with thumbnails), split, images to PDF, PDF to images, convert
images (HEIC/PNG/WEBP/JPG, resize), add password (AES-256), remove password,
remove hidden metadata, PDF info.

### Why it's private

- No server does any work. GitHub Pages only serves the static files.
- The page's Content-Security-Policy (top of `web/index.html`) makes the browser
  refuse connections to any other site, so a bug can't upload a file either.
- Every job runs in a fresh background worker that is destroyed afterwards.
  Nothing is stored; closing the tab clears everything.
- All third-party code is bundled in `web/vendor/` at pinned versions with
  checksums (`web/vendor/SHA256SUMS`, verified on every deploy). Nothing is
  loaded from a CDN.

### Safety checks

Every PDF produced is re-read in full by qpdf (`--check` + page count) and then
opened again by pdf.js, a separate engine, before it's offered for download.
Compression only re-encodes plain RGB/grey photos and only when the result is
smaller. Text, vector graphics, fonts, transparency masks, CMYK and black-and-white
scans are left exactly as they are.

### Run it locally

```bash
python3 scripts/serve.py
```

Then open http://127.0.0.1:8765.

### Deploy

Pushing to `main` publishes `web/` with GitHub Pages
(`.github/workflows/pages.yml`). In the repository settings, Pages → Source must
be set to "GitHub Actions".

### Update the bundled libraries

Edit the versions at the top of `scripts/update-vendor.sh`, then run:

```bash
./scripts/update-vendor.sh
```

## Command-line tool

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
./pdftool compress report.pdf                 # -> report-compressed.pdf (150 dpi)
./pdftool compress scan.pdf --dpi 150 --quality 62
./pdftool merge a.pdf b.pdf -o all.pdf
./pdftool split big.pdf -r "1-3;4-10;11-"
./pdftool extract doc.pdf 3,1,2               # keep / reorder pages
./pdftool delete doc.pdf 1,last
./pdftool rotate scan.pdf 90 -p 2-4
./pdftool encrypt doc.pdf                     # AES-256, password prompted
./pdftool decrypt doc.pdf
./pdftool clean doc.pdf                       # strip metadata
./pdftool pdf2img doc.pdf --dpi 200 --format jpg
./pdftool img2pdf scan1.jpg scan2.heic -o scans.pdf --page-size a4
./pdftool convert IMG_0001.HEIC -t jpg
```

Every command has `--help`. Inputs are never modified, outputs are never
overwritten without `--force`, and passwords are only read from a hidden prompt.

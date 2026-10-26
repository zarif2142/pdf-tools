# PDF Tools

Private replacements for the "free online PDF tools" websites, in two forms:

- **A website** (`web/`) that runs entirely in the browser. Files are processed on
  the device that opens the page and are never uploaded. Works on phones, can be
  installed like an app, and works offline after the first visit.
- **A command-line tool** (`pdftool.py`) for the same jobs on a Mac/PC.

  Link to use the site: https://zarif2142.github.io/pdf-tools/
Both are thin layers over well-known open-source engines:

| Engine | Used for |
|---|---|
| [qpdf](https://github.com/qpdf/qpdf) | merge, split, pages, rotate, passwords, metadata, compression (website: qpdf 12 compiled to WebAssembly; CLI: via [pikepdf](https://github.com/pikepdf/pikepdf)) |
| [pdf.js](https://github.com/mozilla/pdf.js) (Mozilla) / [PDFium](https://pdfium.googlesource.com/pdfium/) (Google) | rendering pages, independent check of every output |
| [libheif](https://github.com/strukturag/libheif) via [heic-to](https://github.com/hoppergee/heic-to) / [pillow-heif](https://github.com/bigcat88/pillow_heif) | iPhone HEIC photos |
| [Fontsource](https://fontsource.org) fonts (Arimo, Tinos, Cousine, Dancing Script, Great Vibes, Homemade Apple) | text preview and typed signatures |
| The browser's own image codecs / [Pillow](https://python-pillow.org) | JPG, PNG, WEBP |

## Website

Tools: edit PDF, fill & sign, compress (including "get it under N MB"), merge, organize
pages (reorder / rotate / delete with thumbnails), split, images to PDF, PDF to
images, convert images (HEIC/PNG/WEBP/JPG, resize), add password (AES-256),
remove password, remove hidden metadata, PDF info.

### Fill & sign

- Fills the PDF's own form fields (text, multi-line, checkboxes, radio buttons,
  dropdowns, comb boxes) and draws their visible text itself in standard
  Helvetica, so nothing can come out blank because of a form's embedded font.
- Places text, dates, check marks, crosses and signatures anywhere on any page,
  including rotated and cropped pages. Signatures can be drawn, typed in a
  handwriting font, or taken from a photo with the paper background removed.
- Additions go in a new content layer on top of each page; the original page
  content is never edited. "Lock answers in place" flattens the form.
- What you see while editing is what you get: the editor previews text in Arimo,
  which has the same letter widths as Helvetica.
- Logic for the PDF changes is in `web/fill-core.js` (plain JS, testable in Node);
  the editor is `web/fill-sign.js`.

### Edit PDF

Two ways to edit, switched at the top of the tool:

**Document** (`web/doc-edit.js`): the PDF opens as an ordinary editable
document. Text reflows as you type, and you can make text bold, italic,
underlined, bigger or coloured, and align it. Paragraphs, headings, fonts,
colours, superscripts, bullets, right-aligned dates and pictures (with their
labels) are rebuilt from the PDF. Saving lays the document out into pages again
and writes a new PDF in the standard fonts. Because the editor's fonts have the
same letter widths as those, every word lands where it was on screen. Dashed
lines show where pages will break. Very complex layouts (columns, tables) are
simplified, so use Exact layout for those.

**Exact layout** (the Fill & sign editor):

- Tap any line of text in a PDF to retype it, or clear it to delete it. "Erase"
  removes everything inside a box you drag. Works in the same editor as Fill &
  sign, so text, dates, marks and signatures can be added too.
- The old text is really removed from the file, not just covered up:
  `web/edit-core.js` drops exactly the text-drawing commands that start on that
  line (using the fonts' own letter widths to find where each piece starts) and
  keeps everything else on the page as it was.
- New text goes in the closest standard font (Helvetica, Times or Courier, bold
  or italic to match), in the original size, colour and position. The preview
  uses Arimo, Tinos and Cousine, which have the same letter widths.
- After saving, the page's text is read back with pdf.js and checked against
  what should be left. If anything differs (unusual PDFs), that page is redone by
  covering the old text with a box in the background colour instead.
- Scanned PDFs have no text to edit: use Erase and then type new text on top.

### Assistant (family only)

`web/assistant.html` is a chat with Claude for people with an access code: it can
explain photos or PDFs of letters and bills, write emails, spot scams and more.
Unlike the PDF tools this page does send data (to Anthropic, through our own
server); it says so on the page. Its server is a Cloudflare Worker in
`assistant/` that holds the API key. Setup: [assistant/README.md](assistant/README.md).

### Why it's private

- No server does any work. GitHub Pages only serves the static files. (The
  separate assistant page is the one exception, see above.)
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

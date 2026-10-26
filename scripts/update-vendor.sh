#!/bin/sh
# Re-downloads the third-party libraries the website uses, at pinned versions,
# and copies only the files the site needs into web/vendor/. Run from repo root.
set -eu
QPDF=0.3.0      # @neslinesli93/qpdf-wasm (qpdf 12.2.0)
PDFJS=6.4.299   # pdfjs-dist (Mozilla pdf.js)
HEIC=1.6.6      # heic-to (libheif)
FONTS=5.3.0     # @fontsource: signature fonts + Arimo, Tinos, Cousine (same letter widths as Helvetica, Times, Courier)

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
( cd "$tmp" && echo '{"private":true}' > package.json &&
  npm install --silent --ignore-scripts --save-exact \
    "@neslinesli93/qpdf-wasm@$QPDF" "pdfjs-dist@$PDFJS" "heic-to@$HEIC" \
    "@fontsource/dancing-script@$FONTS" "@fontsource/great-vibes@$FONTS" "@fontsource/homemade-apple@$FONTS" "@fontsource/arimo@$FONTS" \
    "@fontsource/tinos@$FONTS" "@fontsource/cousine@$FONTS" )
nm="$tmp/node_modules"
v=web/vendor
rm -rf "$v" && mkdir -p "$v/qpdf" "$v/pdfjs" "$v/heic-to" "$v/fonts"

cp "$nm/@neslinesli93/qpdf-wasm/dist/qpdf.js" "$nm/@neslinesli93/qpdf-wasm/dist/qpdf.wasm" "$v/qpdf/"
cp "$nm/pdfjs-dist/build/pdf.min.mjs" "$nm/pdfjs-dist/build/pdf.worker.min.mjs" "$nm/pdfjs-dist/LICENSE" "$v/pdfjs/"
cp -R "$nm/pdfjs-dist/cmaps" "$nm/pdfjs-dist/standard_fonts" "$nm/pdfjs-dist/iccs" "$nm/pdfjs-dist/wasm" "$v/pdfjs/"
cp "$nm/heic-to/dist/csp/heic-to.min.js" "$v/heic-to/heic-to.js"
cp "$nm/heic-to/LICENSE" "$v/heic-to/LICENSE"
for f in dancing-script great-vibes homemade-apple arimo tinos cousine; do
  cp "$nm/@fontsource/$f/files/$f-latin-400-normal.woff2" "$v/fonts/$f.woff2"
  cp "$nm/@fontsource/$f/LICENSE" "$v/fonts/$f-LICENSE"
done
# bold and italic too, for retyping text in "Edit PDF"
for f in arimo tinos cousine; do
  for s in 700-normal 400-italic 700-italic; do
    cp "$nm/@fontsource/$f/files/$f-latin-$s.woff2" "$v/fonts/$f-$s.woff2"
  done
done

cat > "$v/VERSIONS.txt" <<TXT
qpdf (via @neslinesli93/qpdf-wasm $QPDF)  Apache-2.0  https://github.com/qpdf/qpdf
pdf.js (pdfjs-dist $PDFJS)                Apache-2.0  https://github.com/mozilla/pdf.js
heic-to $HEIC (libheif)                   LGPL-3.0    https://github.com/hoppergee/heic-to
Dancing Script, Great Vibes, Arimo, Tinos, Cousine ($FONTS) OFL-1.1   https://fontsource.org
Homemade Apple ($FONTS)                   Apache-2.0  https://fontsource.org
TXT
( cd "$v" && find . -type f ! -name SHA256SUMS | sort | xargs shasum -a 256 > SHA256SUMS )
echo "vendored into $v"

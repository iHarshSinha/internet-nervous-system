#!/bin/bash
# Download the web fonts into apps/web/public/fonts (self-hosted: the app makes
# no font requests to other sites at runtime).
#
#   bash apps/web/scripts/fetch-fonts.sh
#
# Fonts, all under the SIL Open Font License 1.1, from the Fontsource CDN:
#   Michroma (Vernon Adams) for headings, Rajdhani (Indian Type Foundry) for
#   body text, Share Tech Mono (Carrois Apostrophe) for live numbers.
set -euo pipefail
cd "$(dirname "$0")/../public/fonts"

fetch() {
  curl -fsS -m 60 -o "$1-$2.woff2" "https://cdn.jsdelivr.net/fontsource/fonts/$1@latest/$2.woff2"
  echo "$1-$2.woff2 $(wc -c <"$1-$2.woff2") bytes"
}

fetch michroma latin-400-normal
fetch rajdhani latin-400-normal
fetch rajdhani latin-500-normal
fetch rajdhani latin-600-normal
fetch rajdhani latin-700-normal
fetch share-tech-mono latin-400-normal

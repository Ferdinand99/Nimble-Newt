#!/usr/bin/env bash
# Local start-up/size measurement (Linux + Xvfb). Usage: scripts/measure.sh [runs]
# Build first: npm run build:unsigned -- --no-bundle
set -euo pipefail
runs="${1:-5}"
bin="target/release/nimble-newt"
[ -x "$bin" ] || { echo "build the release binary first"; exit 1; }
tmp="$(mktemp -d)"
sample="$tmp/sample.rs"
printf 'fn main() {\n    println!("hello");\n}\n' > "$sample"
echo "binary: $(stat -c %s "$bin") bytes"
echo "dist (js+css, raw / gzip): $(cat dist/assets/*.js dist/assets/*.css | wc -c) / $(cat dist/assets/*.js dist/assets/*.css | gzip -9 | wc -c)"
echo "entry chunk (raw / gzip): $(ls -S dist/assets/index-*.js | head -1 | xargs cat | wc -c) / $(ls -S dist/assets/index-*.js | head -1 | xargs cat | gzip -9 | wc -c)"
for kind in cold warm; do
  vals=()
  for i in $(seq 1 "$runs"); do
    home="$tmp/home-$kind"
    [ "$kind" = cold ] && home="$tmp/home-cold-$i"
    mkdir -p "$home"
    HOME="$home" NIMBLE_STARTUP_REPORT="$tmp/r.json" timeout 90 xvfb-run -a "$bin" "$sample" > /dev/null 2>&1 || true
    ms=$(sed -n 's/.*"startup_ms":\([0-9.]*\).*/\1/p' "$tmp/r.json")
    vals+=("${ms%.*}")
    rm -f "$tmp/r.json"
  done
  sorted=($(printf '%s\n' "${vals[@]}" | sort -n))
  echo "$kind start-up ms: min ${sorted[0]}, median ${sorted[$((${#sorted[@]}/2))]}  (all: ${vals[*]})"
done

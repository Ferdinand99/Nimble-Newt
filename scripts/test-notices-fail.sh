#!/usr/bin/env bash
# Proves that `cargo about generate --fail` stops on a crate whose licence it can not read, and
# that without --fail the same crate is silently left out (exit code 0). scripts/notices.sh relies
# on --fail for the promise "a dependency with a licence outside the allowlist fails the build".
#
# The test builds two tiny crates in a temporary folder. The dependency has no `license` field and
# a `license-file` with a custom, non-open text, which cargo-about can not identify. No network is
# needed. Needs cargo and cargo-about in the PATH. Run from anywhere.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/app/src" "$tmp/badlic/src"
cat > "$tmp/badlic/Cargo.toml" <<'TOML'
[package]
name = "badlic"
version = "0.1.0"
edition = "2021"
license-file = "LICENSE-CUSTOM"
TOML
echo "pub fn f() {}" > "$tmp/badlic/src/lib.rs"
cat > "$tmp/badlic/LICENSE-CUSTOM" <<'TEXT'
Acme Proprietary Licence. All rights reserved.
You may not copy, modify or redistribute this software without a written agreement.
TEXT
cat > "$tmp/app/Cargo.toml" <<'TOML'
[package]
name = "app"
version = "0.1.0"
edition = "2021"
license = "MIT"
publish = false

[dependencies]
badlic = { path = "../badlic" }
TOML
echo "fn main() {}" > "$tmp/app/src/main.rs"
cat > "$tmp/about.toml" <<'TOML'
accepted = ["MIT"]
private = { ignore = true }
TOML

generate() {
  (cd "$tmp/app" && cargo about generate --config "$tmp/about.toml" --format json "$@" --manifest-path "$tmp/app/Cargo.toml" --output-file "$tmp/out.json")
}

# Without --fail the crate is dropped and the command succeeds: this is the gap.
rm -f "$tmp/out.json"
if ! generate; then
  echo "ERROR: without --fail the command was expected to succeed (it is the case --fail closes)." >&2
  exit 1
fi
if node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(j.licenses.some((l) => l.used_by.some((u) => u.crate.name === "badlic")) ? 0 : 1)' "$tmp/out.json"; then
  echo "ERROR: expected badlic to be left out without --fail" >&2
  exit 1
fi
echo "Without --fail: exit 0, badlic left out (the gap)."

# With --fail it must stop.
rm -f "$tmp/out.json"
if generate --fail; then
  echo "ERROR: --fail did not stop on a crate with an unreadable licence." >&2
  exit 1
fi
echo "With --fail: stopped, as it must."

# And scripts/notices.sh must use it for every report it makes.
runs="$(grep -c 'cargo about generate' "$root/scripts/notices.sh")"
if [ "$runs" -lt 1 ] || [ "$(grep -c -- '--fail' "$root/scripts/notices.sh")" -lt "$runs" ]; then
  echo "ERROR: scripts/notices.sh does not pass --fail to every cargo about run." >&2
  exit 1
fi
echo "OK"

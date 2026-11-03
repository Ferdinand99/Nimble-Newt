#!/usr/bin/env bash
# Unpacks the installers that CI built into a folder, so that checks can look at what a user
# really gets: the files inside the package, not the build configuration.
#
# Usage: scripts/unpack-installer.sh <linux|macos|windows> <folder with the installers> <output folder>
#   linux:   every .deb         -> <output>/deb
#   macos:   every .dmg         -> <output>/dmg (the volume as a user sees it when it is opened)
#   windows: every .msi         -> <output>/msi (administrative install, nothing is installed)
#            every NSIS setup   -> <output>/nsis (unpacked with 7-Zip)
set -euo pipefail

kind="${1:?kind}"
from="${2:?installer folder}"
out="${3:?output folder}"
mkdir -p "$out"

count_of() { find "$from" -maxdepth 1 -type f -name "$1" | wc -l | tr -d ' '; }
need_one() {
  if [ "$(count_of "$1")" -lt 1 ]; then
    echo "ERROR: no $1 in $from" >&2
    exit 1
  fi
}

case "$kind" in
  linux)
    need_one '*.deb'
    for f in "$from"/*.deb; do
      mkdir -p "$out/deb"
      dpkg-deb -x "$f" "$out/deb"
    done
    ;;
  macos)
    need_one '*.dmg'
    for f in "$from"/*.dmg; do
      mount="$(mktemp -d)"
      # A dmg with a software licence agreement makes hdiutil ask for acceptance ("attach
      # canceled" otherwise), so accept it, and report whether the agreement is there.
      hdiutil imageinfo "$f" | grep -i "software license agreement" || echo "NOTE: the dmg has no software licence agreement"
      echo Y | hdiutil attach -nobrowse -readonly -noverify -mountpoint "$mount" "$f" >/dev/null
      mkdir -p "$out/dmg"
      cp -R "$mount"/. "$out/dmg"/ || { hdiutil detach "$mount" -force >/dev/null; exit 1; }
      hdiutil detach "$mount" >/dev/null
    done
    ;;
  windows)
    need_one '*.msi'
    need_one '*-setup.exe'
    for f in "$from"/*.msi; do
      mkdir -p "$out/msi"
      # "/a" is an administrative install: it unpacks the files and installs nothing. MSYS_NO_PATHCONV
      # keeps Git Bash from turning the switches into paths.
      MSYS_NO_PATHCONV=1 msiexec /a "$(cygpath -w "$f")" /qn "TARGETDIR=$(cygpath -w "$(cd "$out" && pwd)/msi")"
    done
    for f in "$from"/*-setup.exe; do
      mkdir -p "$out/nsis"
      7z x -y "-o$(cygpath -w "$(cd "$out" && pwd)/nsis")" "$f" >/dev/null
    done
    ;;
  *)
    echo "Usage: $0 <linux|macos|windows> <installer folder> <output folder>" >&2
    exit 2
    ;;
esac

echo "Unpacked into $out:"
find "$out" -type f | sed -n '1,200p'

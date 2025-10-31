#!/usr/bin/env bash
set -euo pipefail

# Build a distributable ZIP for the Firefox add-on.
# Output: web-ext-artifacts/<slug>-<version>.zip

# Resolve repo root (directory containing this script is scripts/)
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="${SCRIPT_DIR%/scripts}"
cd "$REPO_ROOT"

if [[ ! -f manifest.json ]]; then
  echo "Error: manifest.json not found in repo root: $REPO_ROOT" >&2
  exit 1
fi

# Ensure running under bash (helpful when users run `sh script`)
if [ -z "${BASH_VERSION:-}" ]; then
  echo "Please run this script with bash (e.g. 'bash $0' or make it executable and run it)." >&2
  exit 1
fi

# Utilities
have_cmd() { command -v "$1" >/dev/null 2>&1; }

# Read version and name from manifest.json (prefer jq, fallback to sed)
read_manifest_field() {
  field="$1"
  if have_cmd jq; then
    jq -r ".${field} // \"\"" manifest.json
  else
    # naive sed fallback for simple JSON (double-quoted field at top level)
    sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" manifest.json | head -n1
  fi
}

NAME_RAW="$(read_manifest_field name)"
VERSION="$(read_manifest_field version)"

if [[ -z "${VERSION:-}" ]]; then
  echo "Error: Could not determine version from manifest.json" >&2
  exit 1
fi

# Slugify name for filename
NAME_SLUG=$(printf '%s' "${NAME_RAW:-extension}" \
  | tr '[:upper:]' '[:lower:]' \
  | tr -cs 'a-z0-9' '-' \
  | sed -e 's/^-\+//' -e 's/-\+$//')
[[ -z "$NAME_SLUG" ]] && NAME_SLUG="fireflashcards"

ARTIFACT_BASE="$NAME_SLUG"

OUT_DIR="web-ext-artifacts"
# Use absolute path for output file so zip executed from staging dir can write it
OUT_FILE="${REPO_ROOT}/${OUT_DIR}/${ARTIFACT_BASE}-${VERSION}.zip"

mkdir -p "${REPO_ROOT}/${OUT_DIR}"

# Create staging area to control what goes into the zip
STAGE_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t fireflashcards-build-XXXXXX)"
cleanup() { rm -rf "$STAGE_DIR"; }
trap cleanup EXIT

# Always include manifest.json
cp manifest.json "$STAGE_DIR/"

# Attempt to ensure required icons exist; try to generate if missing
STRICT_ICON_CHECK=${STRICT_ICON_CHECK:-0}
need_48=0; need_96=0
[[ ! -f icons/icon-48.png ]] && need_48=1
[[ ! -f icons/icon-96.png ]] && need_96=1

if (( need_48 == 1 || need_96 == 1 )); then
  echo "Info: PNG icons missing; attempting to generate from icons/icon.svg (if tools available)..."
  if [[ -f icons/icon.svg ]]; then
    if have_cmd inkscape; then
      (( need_48 == 1 )) && inkscape icons/icon.svg -o icons/icon-48.png -w 48 -h 48 || true
      (( need_96 == 1 )) && inkscape icons/icon.svg -o icons/icon-96.png -w 96 -h 96 || true
    elif have_cmd convert; then
      (( need_48 == 1 )) && convert -background none icons/icon.svg -resize 48x48 icons/icon-48.png || true
      (( need_96 == 1 )) && convert -background none icons/icon.svg -resize 96x96 icons/icon-96.png || true
    else
      echo "Warning: No SVG-to-PNG tool (inkscape/convert) found; skipping auto-generation." >&2
    fi
  else
    echo "Warning: icons/icon.svg not found; cannot auto-generate PNGs." >&2
  fi
fi

# Re-evaluate presence after attempted generation
if [[ ! -f icons/icon-48.png || ! -f icons/icon-96.png ]]; then
  if [[ "$STRICT_ICON_CHECK" == "1" ]]; then
    echo "Error: Missing icons PNGs and STRICT_ICON_CHECK=1 set. Aborting." >&2
    exit 3
  else
    echo "Warning: PNG icons still missing. The add-on will build but icons may not display correctly." >&2
  fi
fi

# Ensure popup exists per manifest
if [[ ! -f popup/popup.html ]]; then
  echo "Error: popup/popup.html not found." >&2
  exit 1
fi

# Optionally include common webextension folders if present
maybe_copy_dir() {
  local d="$1"
  if [[ -d "$d" ]]; then
    mkdir -p "$STAGE_DIR/$d"
    cp -R "$d"/. "$STAGE_DIR/$d/"
  fi
}

# Known typical directories for WebExtensions (include options explicitly)
for d in icons popup background content scripts content_scripts options src assets css js images _locales dist; do
  maybe_copy_dir "$d"
done

# Optionally include top-level files commonly useful (not required by runtime)
copy_if_exists() { [[ -f "$1" ]] && cp "$1" "$STAGE_DIR/" || true; }
copy_if_exists "LICENSE"
copy_if_exists "README.md"
# Include top-level background script if present
copy_if_exists "background.js"

# Ensure zip is available
if ! have_cmd zip; then
  echo "Error: 'zip' command not found. Install it (e.g., sudo apt-get install zip) and retry." >&2
  exit 2
fi

# Build zip from staging dir contents (zip without extra parent folder)
OLDPWD="$(pwd)"
cd "$STAGE_DIR"
zip -9rq "${OUT_FILE}" .
cd "$OLDPWD"

# Show result
SIZE_BYTES=$(stat -c%s "$OUT_FILE" 2>/dev/null || wc -c < "$OUT_FILE")
echo "Created: $OUT_FILE (${SIZE_BYTES} bytes)"
echo "Tip: Upload the ZIP on https://addons.mozilla.org/ (AMO) or load via about:debugging → This Firefox → Load Temporary Add-on..."

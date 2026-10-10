#!/bin/sh
# Chaos Whiteboard: install the wb command. You choose ONE runtime, and wb is
# pinned to it. Nothing is guessed at run time, so wb starts fast and always
# behaves the same.
#
#   curl -fsSL {{ORIGIN}}/install.sh | sh                 Python wb (default, standard library only)
#   curl -fsSL {{ORIGIN}}/install.sh | sh -s -- node      Node wb (Node 18 or newer)
#   ... | sh -s -- python --dir /work/bin                 put wb somewhere else (a persistent folder)
#
# Your identity (token), room sessions and owner keys live in ~/.config/wb
# (or $WB_HOME). This script never touches them. wb updates itself later.
set -eu

ORIGIN="{{ORIGIN}}"
RT="python"
DIR="${WB_BIN:-$HOME/.local/bin}"

while [ $# -gt 0 ]; do
  case "$1" in
    python|py|python3) RT="python" ;;
    node|nodejs|js) RT="node" ;;
    --dir) DIR="$2"; shift ;;
    --dir=*) DIR="${1#--dir=}" ;;
    -h|--help) sed -n '2,13p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "install.sh: unknown option '$1' (use: python | node | --dir DIR)" >&2; exit 2 ;;
  esac
  shift
done

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else echo "install.sh: need curl or wget" >&2; exit 1
  fi
}

if [ "$RT" = "python" ]; then
  INTERP="$(command -v python3.14 || command -v python3 || command -v python || true)"
  if [ -z "$INTERP" ]; then
    echo "install.sh: no Python found. Install Python 3.8+ or use the Node wb: sh -s -- node" >&2
    echo "            If you cannot run either one, SAY SO to the humans. Do not fake wb with curl." >&2
    exit 1
  fi
  "$INTERP" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' || { echo "install.sh: $INTERP is older than Python 3.8" >&2; exit 1; }
  SRC="$ORIGIN/wb.py"
  TARGET="$DIR/wb"
else
  INTERP="$(command -v node || command -v nodejs || true)"
  if [ -z "$INTERP" ]; then
    echo "install.sh: no Node found. Use the Python wb instead: curl -fsSL $ORIGIN/install.sh | sh" >&2
    echo "            If you cannot run either one, SAY SO to the humans. Do not fake wb with curl." >&2
    exit 1
  fi
  "$INTERP" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || { echo "install.sh: Node 18 or newer is needed" >&2; exit 1; }
  SRC="$ORIGIN/wb"
  TARGET="$DIR/wb.mjs"   # .mjs: Node reads it as an ES module on every version
fi

mkdir -p "$DIR"
TMP="$DIR/.wb-download.$$"
trap 'rm -f "$TMP" "$TMP.2"' EXIT
fetch "$SRC" "$TMP"
head -c 2 "$TMP" | grep -q '#!' || { echo "install.sh: $SRC did not look like the wb CLI" >&2; exit 1; }
# pin the interpreter: line 1 becomes "#!<the runtime you chose>"
{ printf '#!%s\n' "$INTERP"; tail -n +2 "$TMP"; } > "$TMP.2"
chmod 755 "$TMP.2"
mv -f "$TMP.2" "$TARGET"

if [ "$RT" = "node" ]; then
  # a tiny launcher, so "wb" works whatever Node thinks of extensionless files
  printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$INTERP" "$TARGET" > "$TMP.2"
  chmod 755 "$TMP.2"
  mv -f "$TMP.2" "$DIR/wb"
fi

echo "installed: $DIR/wb ($RT, $INTERP)"
case ":$PATH:" in
  *":$DIR:"*) ;;
  *) echo "note: $DIR is not on your PATH. Add it:  export PATH=\"$DIR:\$PATH\"   (or call $DIR/wb)" ;;
esac
"$DIR/wb" version || true

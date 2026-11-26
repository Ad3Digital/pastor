set -eu
umask 077
pastor_tool() {
  _n=$1
  if _p=$(command -v "$_n" 2>/dev/null); then
    case $_p in
      /*) printf '%s' "$_p"; return 0 ;;
    esac
  fi
  for _c in "${BUN_INSTALL:-$HOME/.bun}/bin/$_n" "$HOME/.bun/bin/$_n" "$HOME/.local/bin/$_n" \
    "/usr/local/bin/$_n" "/opt/homebrew/bin/$_n" "/usr/bin/$_n" "/bin/$_n" "/usr/sbin/$_n" "/sbin/$_n"; do
    if [ -x "$_c" ]; then printf '%s' "$_c"; return 0; fi
  done
  return 1
}
CURL=$(pastor_tool curl) || { echo "error: no curl on this machine" >&2; exit 20; }
TAR=$(pastor_tool tar) || { echo "error: no tar on this machine" >&2; exit 21; }
SHA=$(pastor_tool sha256sum) || SHA=$(pastor_tool shasum) || { echo "error: no sha256 tool on this machine" >&2; exit 22; }
PATH="$(dirname "$CURL"):$(dirname "$TAR"):$(dirname "$SHA"):$PATH"
export PATH
DIR='/home/pat/.local/share/pastor'
EXPECT='1.2.3'
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pastor-add.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM
cat > "$WORK/install.sh" <<'__PASTOR_PAYLOAD__'
#__PASTOR_STDIN__
__PASTOR_PAYLOAD__
PASTOR_DIR="$DIR" PASTOR_UPDATE_REPO='Ad3Digital/pastor' PASTOR_TAG='v1.2.3' /bin/sh "$WORK/install.sh" 1>&2
ROOT="$DIR/current"
[ -x "$ROOT/bin/pastor" ] || { echo "error: the install left no binary at $ROOT/bin/pastor" >&2; exit 25; }
VERSION=$("$ROOT/bin/pastor" version | head -n 1)
case "$VERSION" in
  "$EXPECT"*) ;;
  *) echo "error: installed $VERSION, expected $EXPECT" >&2; exit 26 ;;
esac
printf 'pastor-install:root=%s\npastor-install:version=%s\n' "$ROOT" "$VERSION"

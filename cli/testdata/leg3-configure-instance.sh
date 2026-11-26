set -eu
umask 077
CFG='/cfg'
mkdir -p "$CFG"
ENVFILE="$CFG/.env"
TMP="$ENVFILE.pastor-add.$$"
trap 'rm -f "$TMP"' EXIT INT TERM
: > "$TMP"
chmod 600 "$TMP"
KEYS='PASTOR_HOST|PASTOR_PORT|PASTOR_INSTANCE'
if [ -f "$ENVFILE" ]; then
  grep -v -E "^[[:space:]]*(export[[:space:]]+)?($KEYS)=" "$ENVFILE" >> "$TMP" || true
fi
printf 'PASTOR_HOST=%s\n' '100.1.2.3' >> "$TMP"
printf 'PASTOR_PORT=%s\n' '9000' >> "$TMP"
printf 'PASTOR_INSTANCE=%s\n' 'v1' >> "$TMP"
[ -s "$TMP" ] || { echo "error: refusing to write an empty .env" >&2; exit 30; }
mv "$TMP" "$ENVFILE"
printf 'pastor-configure:env=%s\n' "$ENVFILE"

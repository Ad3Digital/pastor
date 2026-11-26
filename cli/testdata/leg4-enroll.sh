set -eu
ROOT='/home/pat/.pastor'
exec "$ROOT/bin/pastor" 'join' 'desk.tail.ts.net' '-' '--address' '100.1.2.3:8787' '--label' 'nas' <<'__PASTOR_PAYLOAD__'
#__PASTOR_STDIN__
__PASTOR_PAYLOAD__

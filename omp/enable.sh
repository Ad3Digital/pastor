#!/usr/bin/env bash
# Liga a ligacao ao vivo do Pastor nos paineis do OMP: registra omp/extension.ts nas extensoes do OMP.
# Rode de novo depois de mover a pasta do Pastor. Para desligar: bash omp/enable.sh --off
set -euo pipefail
ext="$(cd "$(dirname "$0")" && pwd)/extension.ts"
current="$(omp config get extensions --json)"
next="$(EXT="$ext" OFF="${1:-}" bun -e '
  const cur = JSON.parse(await Bun.stdin.text()).value ?? [];
  const rest = cur.filter((p) => p !== process.env.EXT);
  if (process.env.OFF !== "--off") rest.push(process.env.EXT);
  process.stdout.write(JSON.stringify(rest));
' <<<"$current")"
omp config set extensions "$next" >/dev/null
if [ "${1:-}" = "--off" ]; then echo "OK  ligacao ao vivo do OMP desligada."; else echo "OK  ligacao ao vivo ligada para os proximos OMP abertos no Herdr."; fi

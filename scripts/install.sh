#!/bin/sh
# Pastor's installer — download the release for this platform, verify its sha256, lay it down, put
# `pastor` on PATH.
#
# This file is curl-piped into a shell AND read by people who will not run what they have not read,
# so it is deliberately one page of POSIX sh with no helpers to go and find. What it will never do:
# ask for sudo, write outside $PASTOR_DIR and ~/.local/bin, start a service, or send anything
# anywhere. It ends by PRINTING the next three steps rather than taking them — choosing a
# multiplexer and seeding a config are the operator's decisions, and a script that guesses them
# guesses wrong (docs/install.md spells out the same steps by hand, for exactly this reason).
#
# It is a convenience, never the only door. Every asset it fetches — tarball, `.sha256` sidecar,
# release manifest — is a plain GitHub Release file you can download and check by hand; the commands
# to do that are in docs/install.md, and this script does nothing they do not.
#
# Three environment variables steer it, and nothing else does: PASTOR_DIR (where to install),
# PASTOR_UPDATE_REPO (which repo to fetch from), and PASTOR_TAG (install one exact release tag, e.g.
# PASTOR_TAG=v1.0.0-beta.49). A pin skips the tag lookup completely — no call to api.github.com — so
# it is both the way to ask for an older version on purpose and the way back onto a known-good one
# when an install is stuck. It is an environment variable rather than an option because `curl … | sh`
# gives options to the shell, not to this script.
set -eu

REPO="${PASTOR_UPDATE_REPO:-Ad3Digital/pastor}"
DIR="${PASTOR_DIR:-$HOME/.local/share/pastor}"
BETA=0

for arg in "$@"; do
  case "$arg" in
    --beta) BETA=1 ;;
    *) echo "pastor install: opção desconhecida '$arg'. A única opção é --beta." >&2; exit 2 ;;
  esac
done

die() { echo "pastor install: $1" >&2; exit 1; }

# ── A pinned tag, if the operator named one ──────────────────────────────────
# Checked here, before anything is fetched or touched, because a typo in a pinned tag would otherwise
# only surface as a 404 three requests later. The shape is the one the tag list is filtered by, so a
# prerelease pins fine and needs no --beta: naming it IS the opt-in.
PIN="${PASTOR_TAG:-}"
if [ -n "$PIN" ]; then
  printf '%s\n' "$PIN" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' ||
    die "PASTOR_TAG='$PIN' não é uma tag de versão. Tem que ser como v1.0.0, ou v1.0.0-beta.49 para uma prévia."
fi

# ── What has to be here already ──────────────────────────────────────────────
# Three ordinary tools, and no toolchain: the payload is a compiled binary plus a built web bundle,
# so nothing is installed and nothing is built here. Bun is needed only to build FROM SOURCE, which
# is the other documented route.
command -v curl >/dev/null 2>&1 || die "o curl é necessário. Instale pelo gerenciador de pacotes e rode isto de novo."
command -v tar  >/dev/null 2>&1 || die "o tar é necessário. Instale pelo gerenciador de pacotes e rode isto de novo."
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"
elif command -v shasum >/dev/null 2>&1; then SHA="shasum -a 256"
else die "nenhuma ferramenta de sha256 encontrada (sha256sum ou shasum). O download precisa ser conferido, então a instalação para aqui."
fi

# ── Which platform ───────────────────────────────────────────────────────────
# The same canonical ids the release manifest and `pastor update` use. A platform with no artifact is
# told so plainly and pointed at the source build — never handed a binary for another machine.
case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=macos ;;
  *) die "o Pastor não publica binário para $(uname -s). Instale como plugin do Herdr: https://github.com/${REPO}#instalar-no-linux" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "o Pastor não publica binário para $(uname -m). Instale como plugin do Herdr: https://github.com/${REPO}#instalar-no-linux" ;;
esac
# A shell under Rosetta on Apple Silicon reports x86_64, and the x64 build dies there with an illegal
# instruction (seen on the macos-14 runner, #385), so a translated shell gets the native arm64 one.
if [ "$OS" = macos ] && [ "$ARCH" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
  ARCH=arm64
fi
PLATFORM="${OS}-${ARCH}"

# ── Leave an existing install alone — unless a tag was pinned ────────────────
# Pastor updates itself, in place, keeping the previous version for `pastor update --rollback`. A
# fresh install over the top would throw away a config, a linked plugin registration and any local
# state the operator put there. PASTOR_TAG is the one way past that, and it is not a clobber: the
# versioned layout holds one payload per version, so a pin lays the named one down BESIDE what is
# there and flips `current`. That is the rescue when the installed version is the thing that is
# broken — the moment `pastor update` cannot be the answer.
RESCUE=0
if [ -e "$DIR" ]; then
  if [ -d "$DIR/.git" ]; then
    [ -z "$PIN" ] ||
      die "$DIR é um checkout do git, e PASTOR_TAG só fixa a versão de uma instalação binária. Fixe pelo git:  git -C $DIR checkout $PIN"
  elif [ -d "$DIR/versions" ] && [ -n "$PIN" ]; then
    echo "O Pastor já está instalado em $DIR. Instalando $PIN ao lado e apontando current para ela."
    RESCUE=1
  fi
  if [ "$RESCUE" -eq 0 ]; then
    if [ -d "$DIR/versions" ] || [ -d "$DIR/.git" ]; then
      echo "O Pastor já está instalado em $DIR. Nada foi alterado."
      echo "Para atualizar, rode:  pastor update"
      echo "Para instalar uma versão específica, rode este script de novo com PASTOR_TAG=vX.Y.Z"
      echo "Se o próprio \`pastor update\` falhar, veja docs/upgrading.md, seção \"When pastor will not run\"."
      exit 0
    fi
    die "$DIR já existe e não é uma instalação do Pastor. Tire do lugar, ou defina PASTOR_DIR com outra pasta."
  fi
fi

# ── Somewhere to work ────────────────────────────────────────────────────────
# A scratch directory beside the install root, swept by the trap on every exit. It is made this early
# because the tag lookup below writes its answer to a file — reading the HTTP status is how a rate
# limit gets named as a rate limit instead of failing as "no release tag found".
TMP="${DIR}.download.$$"
mkdir -p "$TMP" || die "não deu para criar $TMP."
trap 'rm -rf "$TMP"' EXIT INT HUP TERM

# ── Which release ────────────────────────────────────────────────────────────
# The tags are the contract, sorted by semver — the same list `pastor update` and the in-app banner
# read, and the reason docs/upgrading.md tells scripts never to ask GitHub for `releases/latest`
# (that endpoint hides prereleases, so it stalls on the last stable tag for a whole beta train).
# Default: the newest STRICT release. `--beta` widens it to prerelease tags, which is the opt-in a
# tester makes deliberately — installing a prerelease is what joins its train. PASTOR_TAG replaces
# the whole question, so a pinned run never asks GitHub anything.
#
# A GitHub token, when the caller has one, goes with this ONE call and never with a download: it makes
# the rate limit the caller's own instead of the network's, and a public repository's tags need no
# scope at all. The same three names `pastor update` reads, in the same order. The token is never
# printed, and never on a command line either: `ps` shows every argument of a running curl to every
# user of the machine, and `sh -x` would echo it, so the header travels in a curl config file under
# the swept scratch directory, mode 600. A message names the variable it came from.
if [ -n "${PASTOR_GITHUB_TOKEN:-}" ]; then TOKEN="$PASTOR_GITHUB_TOKEN"; TOKEN_SRC="PASTOR_GITHUB_TOKEN"
elif [ -n "${GH_TOKEN:-}" ]; then TOKEN="$GH_TOKEN"; TOKEN_SRC="GH_TOKEN"
elif [ -n "${GITHUB_TOKEN:-}" ]; then TOKEN="$GITHUB_TOKEN"; TOKEN_SRC="GITHUB_TOKEN"
else TOKEN=""; TOKEN_SRC=""
fi
tags_api() {
  if [ -n "$TOKEN" ]; then
    ( umask 077; printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" > "$TMP/auth.curlrc" ) ||
      die "não deu para gravar $TMP/auth.curlrc."
    curl -sSL -o "$TMP/tags.json" -w '%{http_code}' -H 'Accept: application/vnd.github+json' \
      -K "$TMP/auth.curlrc" "$1"
  else
    curl -sSL -o "$TMP/tags.json" -w '%{http_code}' -H 'Accept: application/vnd.github+json' "$1"
  fi
}
if [ -n "$PIN" ]; then
  TAG="$PIN"
else
  CODE=$(tags_api "https://api.github.com/repos/${REPO}/tags?per_page=100") ||
    die "não deu para acessar api.github.com para listar as versões. Confira a sua internet e tente de novo."
  case "$CODE" in
    200) ;;
    401) if [ -n "$TOKEN" ]; then
           die "o GitHub recusou o token em ${TOKEN_SRC} (HTTP 401). Corrija ou remova e rode isto de novo."
         fi
         die "api.github.com respondeu HTTP 401 ao pedir as tags de ${REPO}. Tente de novo mais tarde, ou diga a versão e pule esta consulta:  PASTOR_TAG=vX.Y.Z" ;;
    403|429) if [ -n "$TOKEN" ]; then
           die "o limite de consultas da API do GitHub foi atingido (HTTP ${CODE}), mesmo com o token em ${TOKEN_SRC}. Espere uma hora, ou diga a versão e pule esta consulta:  PASTOR_TAG=vX.Y.Z  (as tags estão em https://github.com/${REPO}/releases)."
         fi
         die "o limite de consultas da API do GitHub foi atingido (HTTP ${CODE}). Sem token o GitHub permite 60 consultas por hora por endereço de rede, então todo mundo atrás do seu roteador divide a mesma cota. Defina GH_TOKEN com um token do GitHub sem permissões e rode de novo, espere uma hora, ou diga a versão e pule esta consulta:  PASTOR_TAG=vX.Y.Z  (as tags estão em https://github.com/${REPO}/releases)." ;;
    *) die "api.github.com respondeu HTTP ${CODE} ao pedir as tags de ${REPO}. Tente de novo mais tarde, ou diga a versão e pule esta consulta:  PASTOR_TAG=vX.Y.Z" ;;
  esac
  # One `"name"` per tag object, and no other key in that payload is called `name` — so this is a
  # grep, not a JSON parser, and the install stays dependency-light (no jq).
  TAGS=$(tr ',{}' '\n\n\n' < "$TMP/tags.json" | grep -o '"name":[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/' || true)
  if [ "$BETA" -eq 1 ]; then
    TAG=$(printf '%s\n' "$TAGS" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' | sort -V | tail -1 || true)
  else
    TAG=$(printf '%s\n' "$TAGS" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)
  fi
  [ -n "${TAG:-}" ] || die "nenhuma tag de versão encontrada para ${REPO}. Use --beta para incluir prévias, ou avise em https://github.com/${REPO}/issues."
fi
VERSION="${TAG#v}"
BASE="https://github.com/${REPO}/releases/download/${TAG}"
NAME="pastor-${VERSION}-${PLATFORM}.tar.gz"

# ── The name on PATH ─────────────────────────────────────────────────────────
# A symlink to `current/bin/pastor`, never a copy — so every later update is live through the same
# name, with nothing to refresh (ADR 0021). `pastor link` publishes it and refuses to touch a name it
# did not publish, which is why this asks the binary rather than making the link itself. It is a
# function because the rescue path below reaches the end of the install without downloading anything.
publish_name() {
  "$DIR/versions/$VERSION/bin/pastor" link ||
    echo "nota: o \`pastor link\` não publicou o nome. Rode \`$DIR/current/bin/pastor link\` para ver o motivo."
  case ":${PATH}:" in
    *":$HOME/.local/bin:"*) ;;
    *) echo "nota: $HOME/.local/bin não está no seu PATH, então \`pastor\` sozinho ainda não funciona. Adicione no perfil do shell, ou use $DIR/current/bin/pastor <comando>." ;;
  esac
}

# ── The pinned version may already be on disk ────────────────────────────────
# A rollback usually is: `pastor update` keeps the version it replaced, so the rescue is a symlink
# flip and nothing else. Downloading a payload that is already here would be the only risky part of
# an otherwise free operation.
if [ "$RESCUE" -eq 1 ] && [ -d "$DIR/versions/$VERSION" ]; then
  [ -x "$DIR/versions/$VERSION/bin/pastor" ] ||
    die "$DIR/versions/$VERSION existe mas não tem um bin/pastor que rode. Tire do lugar e rode isto de novo."
  ln -sfn "versions/$VERSION" "$DIR/current" || die "could not point $DIR/current at versions/$VERSION."
  publish_name
  echo "✓ O Pastor ${TAG} já estava em $DIR/versions/${VERSION}. current agora aponta para ele, e nada foi baixado."
  exit 0
fi

# ── Download, and verify before anything is unpacked ──────────────────────────
# The `.sha256` sidecar is the digest, in coreutils format, so this is the same one command a reader
# would run by hand. The release manifest is fetched too and cross-checked: it is the release's own
# integrity document, so a digest that is not in it does not get installed. A mismatch is fatal —
# there is no flag to skip it.
echo "Baixando o Pastor ${TAG} para ${PLATFORM}…"
curl -fsSL -o "$TMP/$NAME" "$BASE/$NAME" ||
  die "a versão ${TAG} não tem arquivo para ${PLATFORM}: ou essa tag não existe, ou nunca publicou um. Confira o nome da tag em https://github.com/${REPO}/releases, ou instale como plugin do Herdr: https://github.com/${REPO}#instalar-no-linux"
curl -fsSL -o "$TMP/$NAME.sha256" "$BASE/$NAME.sha256" || die "não deu para baixar $NAME.sha256. Um binário que não foi conferido não é instalado."
curl -fsSL -o "$TMP/manifest.json" "$BASE/pastor-${VERSION}.manifest.json" || die "não deu para baixar o manifesto da versão ${VERSION}."
grep -q '"schemaVersion":[[:space:]]*1' "$TMP/manifest.json" ||
  die "a versão ${VERSION} usa um manifesto que este instalador não entende. Pegue um install.sh mais novo em https://raw.githubusercontent.com/Ad3Digital/pastor/main/scripts/install.sh"
( cd "$TMP" && $SHA -c "$NAME.sha256" >/dev/null 2>&1 ) ||
  die "CHECKSUM DIFERENTE em $NAME. O download foi descartado e nada foi instalado. Tente de novo; se repetir, avise."
DIGEST=$(cd "$TMP" && $SHA "$NAME" | cut -d' ' -f1)
grep -q "\"$DIGEST\"" "$TMP/manifest.json" ||
  die "o hash de $NAME não é o que o manifesto da versão ${VERSION} indica. Nada foi instalado."

# ── Lay it down ──────────────────────────────────────────────────────────────
# One complete payload per version, and a `current` symlink pointing at one of them. An update lays
# the next version down beside this one and flips that symlink, so the two halves — the binary and
# the web bundle it serves from disk — can never skew.
tar -xzf "$TMP/$NAME" -C "$TMP" || die "não deu para descompactar $NAME."
[ -x "$TMP/pastor-${VERSION}-${PLATFORM}/bin/pastor" ] || die "$NAME não contém bin/pastor. A instalação foi recusada."
mkdir -p "$DIR/versions" || die "não deu para criar $DIR/versions."
mv "$TMP/pastor-${VERSION}-${PLATFORM}" "$DIR/versions/$VERSION" || die "não deu para mover os arquivos para $DIR/versions/$VERSION."
ln -sfn "versions/$VERSION" "$DIR/current" || die "could not point $DIR/current at versions/$VERSION."

publish_name

# ── What is left, which is yours ─────────────────────────────────────────────
cat <<EOF

✓ O Pastor $TAG está instalado em $DIR. Nada está rodando ainda.

Faltam quatro passos, e cada um é uma escolha sua:

  1. Crie a configuração:
       mkdir -p ~/.config/pastor
       cp $DIR/current/.env.example ~/.config/pastor/.env

  2. Diga o seu multiplexador nesse arquivo: PASTOR_MUX=herdr, tmux ou zellij. Se deixar de fora,
     o primeiro \`pastor start\` procura um e pergunta.
     O Herdr precisa estar rodando; tmux e zellij precisam de um endpoint dizendo qual servidor
     ou sessão espelhar. Passo a passo: $DIR/current/docs/multiplexers.md

  3. Ligue o Pastor e leia o quadro que ele mostra:
       pastor start

  4. Pareie o celular. O Pastor não responde a nenhum aparelho até um ser pareado:
       pastor pair

Leia $DIR/current/docs/security.md antes de abrir o endereço no celular. O Pastor dá acesso remoto
ao terminal do seu computador, de propósito.
EOF

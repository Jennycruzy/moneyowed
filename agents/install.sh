#!/usr/bin/env bash
# Install MONEY OWED into an agent and schedule the weekly check.
#   agents/install.sh openclaw   skill in ~/.openclaw/skills, weekly command job (Gateway must be reachable)
#   agents/install.sh hermes     skill in ~/.hermes/skills, weekly no-agent cron job
#   agents/install.sh cron       plain crontab line, output appended to ~/.moneyowed/messages.log
# Run from a clone, it installs that clone's CLI; otherwise from GitHub. MONEYOWED_SRC=/path overrides both.
set -euo pipefail
target="${1:-}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
schedule="${MONEYOWED_SCHEDULE:-0 9 * * 1}"

case "$target" in openclaw|hermes|cron) ;; *) echo "usage: $0 openclaw|hermes|cron" >&2; exit 2 ;; esac

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "needs Node 22 or newer" >&2; exit 1; }
if ! command -v moneyowed >/dev/null 2>&1; then
  src="${MONEYOWED_SRC:-}"
  if [ -z "$src" ] && [ -f "$here/../package.json" ]; then src="$(cd "$here/.." && pwd)"; fi   # run from a clone: install that clone
  npm install -g "${src:-github:Jennycruzy/moneyowed#build}"
fi
bin="$(command -v moneyowed)"
echo "moneyowed CLI: $bin"

mkdir -p "$HOME/.moneyowed"
if [ -f "$HOME/.moneyowed/.env" ]; then chmod 600 "$HOME/.moneyowed/.env"; fi

case "$target" in
  openclaw)
    oc="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    mkdir -p "$oc/skills/moneyowed"
    cp "$here/moneyowed/SKILL.md" "$oc/skills/moneyowed/SKILL.md"
    echo "skill: $oc/skills/moneyowed/SKILL.md"
    to=()   # MONEYOWED_DELIVER=telegram:<chat id> (or discord:<channel id>, ...) sends to that chat; default is the last chat used
    if [ -n "${MONEYOWED_DELIVER:-}" ]; then to=(--channel "${MONEYOWED_DELIVER%%:*}" --to "${MONEYOWED_DELIVER#*:}"); fi
    if openclaw cron add --name moneyowed-weekly --cron "$schedule" --command "$bin watch run" "${to[@]}" \
         --description "MONEY OWED: SLA credits owed, promises missed, terms changed" --announce --declaration-key moneyowed-weekly; then
      echo "scheduled: $schedule (OpenClaw automation moneyowed-weekly)"
    else
      echo "could not reach the OpenClaw Gateway; schedule it later with:" >&2
      echo "  openclaw cron add --name moneyowed-weekly --cron \"$schedule\" --command \"$bin watch run\" --announce" >&2
    fi
    ;;
  hermes)
    hh="${HERMES_HOME:-$HOME/.hermes}"
    mkdir -p "$hh/skills/moneyowed" "$hh/scripts"
    cp "$here/moneyowed/SKILL.md" "$hh/skills/moneyowed/SKILL.md"
    printf '#!/usr/bin/env bash\n# MONEY OWED weekly check: prints only when money is owed, a promise is missed or terms changed\nexport PATH="%s:$PATH"\nexec "%s" watch run --silent-token none\n' "$(dirname "$(command -v node)")" "$bin" > "$hh/scripts/moneyowed-watch.sh"
    chmod +x "$hh/scripts/moneyowed-watch.sh"
    echo "skill: $hh/skills/moneyowed/SKILL.md   script: $hh/scripts/moneyowed-watch.sh"
    if command -v hermes >/dev/null 2>&1 && hermes cron create "$schedule" --no-agent --script moneyowed-watch.sh --name moneyowed-weekly --deliver "${MONEYOWED_DELIVER:-origin}"; then
      echo "scheduled: $schedule (Hermes cron moneyowed-weekly)"
    else
      echo "schedule it with: hermes cron create \"$schedule\" --no-agent --script moneyowed-watch.sh --name moneyowed-weekly --deliver origin" >&2
    fi
    ;;
  cron)
    line="$schedule $bin watch run --silent-token none >> $HOME/.moneyowed/messages.log 2>&1"
    ( crontab -l 2>/dev/null | grep -v 'moneyowed watch run' ; echo "$line" ) | crontab -
    echo "crontab: $line"
    ;;
esac

if [ "$(moneyowed watch list | head -1 | cut -c1-9)" = "Telegraph" ]; then
  echo
  echo "Next: add the vendors you pay, for example"
  echo "  moneyowed watch add vercel --spend 2000"
  echo "  moneyowed watch run"
fi

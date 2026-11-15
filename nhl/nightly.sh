#!/usr/bin/env bash
# nightly.sh: scrape new NHL games, score xG, refit the ratings, and push the site files to GitHub.
#
#   nhl/nightly.sh                 the normal run (cron calls this); does nothing when no new games finished
#   nhl/nightly.sh --force         run every stage even with no new games
#   nhl/nightly.sh --from ratings  pick up after a failed stage (scrape, xg, ratings, check, export, publish)
#   nhl/nightly.sh --no-push       build the site files but do not commit or push
#   nhl/nightly.sh --tune          search for the xG model settings again (hours)
#
# The first run builds everything it does not find in $NHL_DATA_DIR, so it is the long one:
# start it before bed. See nhl/README.md.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export NHL_DATA_DIR="${NHL_DATA_DIR:-/var/lib/pte-nhl}"
VENV="${NHL_VENV:-$NHL_DATA_DIR/venv}"
export MPLBACKEND=Agg

mkdir -p "$NHL_DATA_DIR/logs"

# One run at a time: a cron run that starts while yours is still going exits quietly.
exec 9>"$NHL_DATA_DIR/nightly.lock"
if ! flock -n 9; then
    echo "nhl/nightly.sh is already running; see $NHL_DATA_DIR/logs/"
    exit 0
fi

if [[ ! -x "$VENV/bin/python" ]]; then
    echo "Creating the Python environment in $VENV (first run only)"
    python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install -q -r "$REPO/nhl/requirements.txt" \
    || echo "WARNING: could not check the Python packages; carrying on with what is installed"

LOG="$NHL_DATA_DIR/logs/$(date -u +%Y-%m-%d_%H%M).log"
ln -sfn "$LOG" "$NHL_DATA_DIR/logs/latest.log"
ls -1t "$NHL_DATA_DIR"/logs/20*.log 2>/dev/null | tail -n +61 | xargs -r rm -f      # keep the last 60 logs

cd "$REPO"
echo "Log: $LOG"
nice -n 10 "$VENV/bin/python" -u -m nhl.run nightly "$@" 2>&1 | tee -a "$LOG"

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

LOG="$NHL_DATA_DIR/logs/$(date -u +%Y-%m-%d_%H%M).log"
ln -sfn "$LOG" "$NHL_DATA_DIR/logs/latest.log"
{ ls -1t "$NHL_DATA_DIR"/logs/20*.log 2>/dev/null || true; } | tail -n +61 | xargs -r rm -f    # keep the last 60 logs
exec > >(tee -a "$LOG") 2>&1          # from here on, everything is in the log as well as on screen
echo "Log: $LOG"

# The Python environment. Rebuilt when it is missing or half-made (an interrupted first run).
if ! "$VENV/bin/python" -c "import pip" 2>/dev/null; then
    echo "Creating the Python environment in $VENV (first run only; the packages take a few minutes)"
    if [[ -f "$VENV/pyvenv.cfg" ]]; then rm -rf "$VENV"; fi
    if ! python3 -m venv "$VENV"; then
        echo "Could not create the Python environment. On Ubuntu run:  apt install -y python3-venv"
        echo "then start nhl/nightly.sh again."
        exit 1
    fi
fi
"$VENV/bin/python" -m pip install -q --disable-pip-version-check -r "$REPO/nhl/requirements.txt" \
    || echo "WARNING: could not check the Python packages; carrying on with what is installed"
if ! "$VENV/bin/python" -c "import numpy, pandas, scipy, sklearn, xgboost, matplotlib, requests"; then
    echo "The Python packages in $VENV are incomplete (see the error above). Fix that, then start again."
    exit 1
fi

cd "$REPO"
nice -n 10 "$VENV/bin/python" -u -m nhl.run nightly "$@"

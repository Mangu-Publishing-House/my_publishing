#!/usr/bin/env bash
# Create (or reuse) the org Project "MANGU Delivery" and attach the seeded issues.
# Requires GitHub CLI with project scope:
#   gh auth refresh -s project,read:project -h github.com
set -euo pipefail

OWNER="${OWNER:-Mangu-Publishing-House}"
REPO="${REPO:-my_publishing}"
TITLE="${PROJECT_TITLE:-MANGU Delivery}"
ISSUES=(415 416 417 418 419 420 421 422 423 424 425 426 427 428 429)

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required: https://cli.github.com" >&2
  exit 1
fi

echo "== auth"
gh auth status

echo "== locate or create project"
EXISTING="$(gh project list --owner "$OWNER" --format json --limit 50 \n  | python3 -c 'import json,sys; data=json.load(sys.stdin); items=data if isinstance(data,list) else data.get("projects", data.get("items", []));
print(next((str(p.get("number","")) for p in items if p.get("title")==sys.argv[1]), ""))' "$TITLE" || true)"

if [[ -z "$EXISTING" ]]; then
  echo "creating $TITLE"
  CREATE_JSON="$(gh project create --owner "$OWNER" --title "$TITLE" --format json)"
  NUMBER="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["number"])' <<<"$CREATE_JSON")"
else
  NUMBER="$EXISTING"
  echo "reusing project #$NUMBER"
fi

echo "== attach issues"
for n in "${ISSUES[@]}"; do
  echo "  + $OWNER/$REPO#$n"
  gh project item-add "$NUMBER" --owner "$OWNER" --url "https://github.com/$OWNER/$REPO/issues/$n" >/dev/null || {
    echo "    (already on board or item-add failed — continuing)"
  }
done

URL="$(gh project view "$NUMBER" --owner "$OWNER" --format json | python3 -c 'import json,sys; print(json.load(sys.stdin).get("url",""))')"
echo
echo "Board: $URL"
echo "Manual columns if the UI is still empty: Backlog / Ready / In progress / Review / Done"

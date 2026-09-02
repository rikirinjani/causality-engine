#!/usr/bin/env bash
# Audit a CE tarball for release. Mirrors the CI package job exactly, so the
# same check can run locally and on a hosted runner.
#
# Usage: bash scripts/audit-tarball.sh <path-to-tgz>
set -uo pipefail

TARBALL="${1:-}"
if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
  echo "usage: bash scripts/audit-tarball.sh <path-to-tgz>"
  exit 2
fi

CONTENTS=$(mktemp)
tar -tzf "$TARBALL" > "$CONTENTS"
echo "auditing $TARBALL ($(wc -l < "$CONTENTS" | tr -d ' ') entries)"
echo

fail=0

echo "-- must NOT be present --"
for pattern in 'package/src/' '\.test\.' 'package/docs/P-0' 'RECONNAISSANCE' 'godot-iso' '\.png$' 'package/examples/' 'package/scripts/' 'node_modules'; do
  if grep -qE "$pattern" "$CONTENTS"; then
    echo "FAIL  $pattern"
    grep -E "$pattern" "$CONTENTS" | head -3 | sed 's/^/        /'
    fail=1
  else
    echo "ok    $pattern absent"
  fi
done

echo
echo "-- must be present --"
for required in \
  'package/dist/api/product.js' \
  'package/dist/api/product.d.ts' \
  'package/dist/api/public.js' \
  'package/godot/addons/causality_engine/ce_client.gd' \
  'package/godot/addons/causality_engine/quantity.gd' \
  'package/godot/addons/causality_engine/plugin.cfg' \
  'package/docs/GETTING-STARTED.md' \
  'package/docs/INSTALLATION.md' \
  'package/docs/DEPLOYMENT.md' \
  'package/docs/TROUBLESHOOTING.md' \
  'package/CHANGELOG.md' \
  'package/README.md' \
  'package/LICENSE' \
  'package/package.json'
do
  if grep -qF "$required" "$CONTENTS"; then
    echo "ok    $required"
  else
    echo "FAIL  missing $required"
    fail=1
  fi
done

echo
echo "-- credential / secret scan --"
LEAKS=$(grep -inE 'password|secret|api[_-]?key|token|private[_-]?key|\.env' "$CONTENTS" || true)
if [ -n "$LEAKS" ]; then
  echo "FAIL  suspicious filenames:"
  echo "$LEAKS" | sed 's/^/        /'
  fail=1
else
  echo "ok    no credential-shaped filenames"
fi

rm -f "$CONTENTS"

echo
if [ "$fail" -ne 0 ]; then
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"

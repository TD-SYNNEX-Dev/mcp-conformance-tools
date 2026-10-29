#!/usr/bin/env bash
# Run both checks against one MCP server:
#   1. MCP Inspector CLI  - tools/list (wire-level: can the reference TS client connect and list?)
#   2. mcp-check (Python) - initialize, tools/list, schema lint, tool calls validated by the Python SDK
# Exit code: 0 only if both pass. 1 = a check failed. 2 = usage error.
#
# Env: MCP_URL (required unless --url), MCP_API_KEY, MCP_AUTH_HEADER (default Authorization),
#      MCP_AUTH_SCHEME (default Bearer for Authorization, none otherwise), MCP_TRANSPORT (http|sse),
#      INSPECTOR_VERSION (default pinned below), SKIP_INSPECTOR=1, OUT_DIR (default ./out),
#      MCP_AUTH=oauth (or --oauth): OAuth browser sign-in. The Inspector CLI step is skipped in
#      OAuth mode (it cannot share mcp-check's token store, and passing a token on argv would leak it).
# Any arguments are passed to mcp-check, e.g.:  ./run-all.sh --cases cases.yaml --json out/report.json
set -uo pipefail

INSPECTOR_VERSION="${INSPECTOR_VERSION:-2.12.0}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${OUT_DIR:-out}"
mkdir -p "$OUT_DIR"

# Allow --url on the command line too (it is also forwarded to mcp-check).
URL="${MCP_URL:-}"
prev=""
for a in ${@+"$@"}; do
  [[ "$prev" == "--url" ]] && URL="$a"
  [[ "$a" == --url=* ]] && URL="${a#--url=}"
  prev="$a"
done
[[ -z "$URL" ]] && { echo "run-all.sh: set MCP_URL or pass --url" >&2; exit 2; }

TRANSPORT="${MCP_TRANSPORT:-http}"
for a in ${@+"$@"}; do [[ "$a" == "--sse" ]] && TRANSPORT="sse"; done
AUTH_HEADER="${MCP_AUTH_HEADER:-Authorization}"
if [[ -n "${MCP_AUTH_SCHEME+x}" ]]; then SCHEME="$MCP_AUTH_SCHEME"
elif [[ "$(printf %s "$AUTH_HEADER" | tr "[:upper:]" "[:lower:]")" == "authorization" ]]; then SCHEME="Bearer"
else SCHEME=""; fi

PY="${PYTHON:-python3}"
[[ -x "$HERE/.venv/bin/python" ]] && PY="$HERE/.venv/bin/python"

# Masks MCP_API_KEY in anything we echo (reads the key from the environment, not argv).
mask() { "$PY" -c '
import os, sys
k = os.environ.get("MCP_API_KEY") or ""
for line in sys.stdin:
    sys.stdout.write(line.replace(k, "<SECRET>") if len(k) >= 4 else line)'; }

safe_url() { "$PY" -c 'import sys; sys.path.insert(0, sys.argv[2]); from mcp_check.masking import safe_url; print(safe_url(sys.argv[1]))' "$1" "$HERE"; }

OAUTH=0
[[ "${MCP_AUTH:-}" == "oauth" ]] && OAUTH=1
for a in ${@+"$@"}; do [[ "$a" == "--oauth" ]] && OAUTH=1; done

inspector_rc=0
if [[ "$OAUTH" == "1" && "${SKIP_INSPECTOR:-0}" != "1" ]]; then
  echo "== [1/2] MCP Inspector CLI: SKIPPED (OAuth mode; run 'npx @modelcontextprotocol/inspector' interactively if needed)"
  echo
elif [[ "${SKIP_INSPECTOR:-0}" != "1" ]]; then
  echo "== [1/2] MCP Inspector CLI ${INSPECTOR_VERSION}: tools/list on $(safe_url "$URL") ($TRANSPORT)"
  args=(--cli "$URL" --transport "$TRANSPORT" --method tools/list --stored-auth-only)
  if [[ -n "${MCP_API_KEY:-}" ]]; then
    if [[ -n "$SCHEME" ]]; then args+=(--header "${AUTH_HEADER}: ${SCHEME} ${MCP_API_KEY}")
    else args+=(--header "${AUTH_HEADER}: ${MCP_API_KEY}"); fi
  fi
  # memory secret store: do not write tokens to ~/.mcp-inspector on CI runners.
  MCP_INSPECTOR_SECRET_STORE=memory npm_config_update_notifier=false \
    npx -y "@modelcontextprotocol/inspector@${INSPECTOR_VERSION}" "${args[@]}" \
    >"$OUT_DIR/inspector-tools.json" 2>"$OUT_DIR/inspector.stderr"
  inspector_rc=$?
  grep -v -E '^npm warn' "$OUT_DIR/inspector.stderr" | mask >&2 || true
  # Re-mask the saved files in place, just in case a server echoes headers.
  for f in "$OUT_DIR/inspector-tools.json" "$OUT_DIR/inspector.stderr"; do
    mask <"$f" >"$f.tmp" && mv "$f.tmp" "$f"
  done
  if [[ $inspector_rc -eq 0 ]]; then
    n=$("$PY" -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["tools"]))' "$OUT_DIR/inspector-tools.json" 2>/dev/null || echo "?")
    echo "Inspector tools/list: PASS ($n tools) -> $OUT_DIR/inspector-tools.json"
  else
    echo "Inspector tools/list: FAIL (exit $inspector_rc)"; head -c 2000 "$OUT_DIR/inspector-tools.json" | mask; echo
  fi
  echo
fi

echo "== [2/2] mcp-check (MCP Python SDK)"
if command -v mcp-check >/dev/null 2>&1 && [[ ! -x "$HERE/.venv/bin/python" ]]; then
  mcp-check ${@+"$@"}
else
  PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}" "$PY" -m mcp_check ${@+"$@"}
fi
check_rc=$?

echo
echo "== combined: inspector=$inspector_rc mcp-check=$check_rc"
if [[ $inspector_rc -eq 0 && $check_rc -eq 0 ]]; then exit 0; fi
[[ $check_rc -eq 2 ]] && exit 2
exit 1

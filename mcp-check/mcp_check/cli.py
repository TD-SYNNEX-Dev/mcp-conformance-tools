"""mcp-check command line.

Auth is either an API key from the MCP_API_KEY environment variable (never a CLI flag, never
printed) or OAuth browser sign-in (--oauth / MCP_AUTH=oauth) with a URL-based client ID.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import anyio

from mcp_check import __version__
from mcp_check.cases import CasesError, load_cases
from mcp_check.masking import mask, register, safe_url
from mcp_check.report import header, responses, summary, table, to_dict, write_json, write_junit
from mcp_check.runner import Options, run

from mcp_check.oauth import DEFAULT_CLIENT_METADATA_URL, DEFAULT_PORT

EPILOG = """environment:
  MCP_URL          server URL (if --url is not given)
  MCP_API_KEY      API key / token sent in the auth header (never pass it on the command line)
  MCP_AUTH_HEADER  auth header name (default: Authorization)
  MCP_AUTH_SCHEME  value prefix (default: "Bearer" for Authorization, none for other headers)
  MCP_TRANSPORT    http | sse (default: http)
  MCP_AUTH         apikey | oauth (default: apikey; same as --oauth)
  MCP_CLIENT_METADATA_URL  OAuth client ID = URL of the public client metadata document
                   (required for --oauth unless MCP_OAUTH_CLIENT_ID is set; e.g. %s)
  MCP_OAUTH_CLIENT_ID  pre-registered public client_id from the server owner (skips the metadata document)
  MCP_OAUTH_PORT   loopback callback port (default %d; must be in the document's redirect_uris)
  MCP_OAUTH_NO_BROWSER=1   print the sign-in URL but do not open a browser
  MCP_OAUTH_CALLBACK_TIMEOUT  seconds to wait for the browser sign-in (default 300)
  MCP_CHECK_HOME   token store root (default ~/.mcp-check; tokens in oauth/*.json, mode 0600)

exit codes: 0 all checks passed, 1 at least one FAIL, 2 usage/config error
""" % (DEFAULT_CLIENT_METADATA_URL, DEFAULT_PORT)


def _csv(values: list[str] | None) -> list[str]:
    return [p.strip() for v in (values or []) for p in v.split(",") if p.strip()]


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="mcp-check", description="MCP server conformance check (official MCP Python SDK).",
                                epilog=EPILOG, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", default=os.environ.get("MCP_URL"), help="MCP endpoint URL (env MCP_URL)")
    t = p.add_mutually_exclusive_group()
    t.add_argument("--transport", choices=["http", "sse"], default=os.environ.get("MCP_TRANSPORT", "http"),
                   help="http = Streamable HTTP (default), sse = legacy HTTP+SSE")
    t.add_argument("--sse", dest="transport", action="store_const", const="sse", help="shorthand for --transport sse")
    p.add_argument("--auth-header", default=os.environ.get("MCP_AUTH_HEADER", "Authorization"),
                   help="header that carries MCP_API_KEY, e.g. X-API-Key (default Authorization)")
    p.add_argument("--auth-scheme", default=os.environ.get("MCP_AUTH_SCHEME"),
                   help='prefix before the key; default "Bearer" for Authorization, "" otherwise')
    p.add_argument("--oauth", action="store_true", default=os.environ.get("MCP_AUTH", "").lower() == "oauth",
                   help="OAuth browser sign-in instead of an API key (env MCP_AUTH=oauth)")
    p.add_argument("--oauth-logout", action="store_true",
                   help="delete the stored OAuth tokens for this server and exit")
    p.add_argument("--header", action="append", default=[], metavar="'Name: value'",
                   help="extra NON-SECRET header (repeatable)")
    p.add_argument("--cases", help="YAML/JSON cases file (tool -> list of {args, expect})")
    p.add_argument("--only", action="append", help="only these tools (comma list / repeatable, globs ok)")
    p.add_argument("--skip", action="append", help="skip these tools (comma list / repeatable, globs ok)")
    p.add_argument("--tool", action="append", default=[], metavar="NAME",
                   help="test only this tool (exact name, repeatable): lint it and call it with its cases-file "
                   "cases, --args, or minimal args built from its inputSchema")
    p.add_argument("--args", dest="tool_args", metavar="JSON|@file",
                   help="with exactly one --tool: call it with these arguments (a JSON object, or @path to a JSON file)")
    p.add_argument("--confirm-side-effects", action="store_true",
                   help="with --tool: allow calling a tool whose name or annotations suggest side effects "
                   "(otherwise you are asked y/N on a terminal, and it is skipped elsewhere)")
    p.add_argument("--no-calls", action="store_true", help="initialize + list + lint only")
    p.add_argument("--auto-cases", action="store_true",
                   help="call tools that have no case with minimal args built from inputSchema (opt-in). Tools "
                   "whose names suggest side effects (submit/create/update/delete/place/order/send/cancel/write/"
                   "post), or marked destructiveHint=true or readOnlyHint=false, are never auto-called")
    p.add_argument("--auto-allow", action="append", metavar="GLOB",
                   help="with --auto-cases: only auto-call tools matching these globs (comma list / repeatable)")
    p.add_argument("--auto-deny", action="append", metavar="WORD|GLOB",
                   help="with --auto-cases: extra deny words/globs on top of the built-in list")
    p.add_argument("--strict-lint", action="store_true", help="treat lint warnings (e.g. `nullable`) as FAIL")
    p.add_argument("--timeout", type=float, default=60.0, help="per-request timeout seconds (default 60)")
    p.add_argument("--delay", type=float, default=0.0, help="seconds to wait between tool calls")
    p.add_argument("--no-stop-on-rate-limit", dest="stop_on_rate_limit", action="store_false",
                   help="keep calling after a 429 / rate-limit error")
    p.add_argument("--json", dest="json_path", metavar="report.json", help="write full JSON report")
    p.add_argument("--junit", metavar="junit.xml", help="write JUnit XML for CI")
    p.add_argument("--dump-tools", metavar="tools.json", help="write the tools/list manifest")
    p.add_argument("--show-response", action="store_true",
                   help="for each failing call, print the args sent, the raw result and the outputSchema, "
                        "with the problem lines marked '>>'")
    p.add_argument("--no-wrap", action="store_true", help="truncate instead of wrapping the detail column")
    p.add_argument("--version", action="version", version=f"mcp-check {__version__}")
    return p


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    if not a.url:
        print("mcp-check: --url or MCP_URL is required", file=sys.stderr)
        return 2

    headers: dict[str, str] = {}
    for h in a.header:
        if ":" not in h:
            print(f"mcp-check: --header must look like 'Name: value', got {h!r}", file=sys.stderr)
            return 2
        k, v = h.split(":", 1)
        headers[k.strip()] = v.strip()

    auth = None
    key = None if a.oauth or a.oauth_logout else os.environ.get("MCP_API_KEY")
    if a.oauth or a.oauth_logout:
        from mcp_check.oauth import build_auth
        try:
            auth = build_auth(a.url)
        except ValueError as e:
            print(f"mcp-check: {e}", file=sys.stderr)
            return 2
        if a.oauth_logout:
            gone = auth.token_storage.clear()
            print(f"mcp-check: {'removed' if gone else 'no'} stored OAuth tokens for {safe_url(a.url)}", file=sys.stderr)
            return 0
    elif key:
        register(key)
        scheme = a.auth_scheme if a.auth_scheme is not None else ("Bearer" if a.auth_header.lower() == "authorization" else "")
        headers[a.auth_header] = f"{scheme} {key}".strip() if scheme else key
    else:
        print("mcp-check: MCP_API_KEY not set - connecting without auth", file=sys.stderr)

    try:
        cases = load_cases(a.cases) if a.cases else {}
    except (OSError, CasesError) as e:
        print(f"mcp-check: {e}", file=sys.stderr)
        return 2

    tool_args = None
    if a.tool_args is not None:
        if len(a.tool) != 1:
            print("mcp-check: --args needs exactly one --tool NAME", file=sys.stderr)
            return 2
        raw = a.tool_args
        try:
            if raw.startswith("@"):
                with open(raw[1:], encoding="utf-8") as f:
                    raw = f.read()
            tool_args = json.loads(raw)
        except (OSError, ValueError) as e:
            print(f"mcp-check: --args is not valid JSON: {e}", file=sys.stderr)
            return 2
        if not isinstance(tool_args, dict):
            print("mcp-check: --args must be a JSON object, e.g. '{\"id\": \"1\"}'", file=sys.stderr)
            return 2

    def confirm(name: str, why: str, args: dict) -> bool:
        if not sys.stdin.isatty():
            return False
        print(f"mcp-check: {name} looks like it has side effects ({why}).", file=sys.stderr)
        print(f"mcp-check: args: {json.dumps(mask(args))}", file=sys.stderr)
        try:
            return input(f"Call {name} anyway? [y/N] ").strip().lower() in ("y", "yes")
        except EOFError:
            return False

    opts = Options(url=a.url, transport=a.transport, headers=headers, auth=auth,
                   init_timeout=max(a.timeout, 600.0) if auth else None, cases=cases, only=_csv(a.only),
                   skip=_csv(a.skip), timeout=a.timeout, delay=a.delay, no_calls=a.no_calls,
                   strict_lint=a.strict_lint, stop_on_rate_limit=a.stop_on_rate_limit,
                   auto_cases=a.auto_cases, auto_allow=_csv(a.auto_allow), auto_deny=_csv(a.auto_deny),
                   tools=list(dict.fromkeys(a.tool)), tool_args=tool_args,
                   confirm_side_effects=a.confirm_side_effects, confirm=confirm)
    print(f"mcp-check: connecting to {safe_url(a.url)} ({a.transport}); "
          f"auth: {'oauth (client_id ' + auth.effective_client_id + ')' if auth else (a.auth_header + ': <SECRET>' if key else 'none')}",
          file=sys.stderr)
    report = anyio.run(run, opts)
    if auth is not None and report.fatal and getattr(auth, "auth_errors", None):
        extra = "OAuth: " + " | ".join(dict.fromkeys(auth.auth_errors))
        report.fatal += " | " + extra
        for r in report.rows:
            if r.status == "FAIL" and r.check in ("initialize", "connection"):
                r.detail += " | " + extra

    print(header(report))
    print()
    print(table(report, wrap=not a.no_wrap))
    print()
    if a.show_response:
        blocks = responses(report)
        if blocks:
            print(blocks)
            print()
    print(summary(report))
    if a.json_path:
        write_json(report, a.json_path)
    if a.junit:
        write_junit(report, a.junit)
    if a.dump_tools:
        with open(a.dump_tools, "w", encoding="utf-8") as f:
            json.dump(mask({"tools": report.tools}), f, indent=2)
    return 1 if report.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

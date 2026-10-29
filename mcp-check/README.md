# mcp-check

A standalone conformance check for MCP servers. It connects the way a real MCP client
does, using the official Python `mcp` SDK (pinned), and reports what a client would
reject. That includes results that don't match a tool's own `outputSchema`.

## Why this exists

A tool declared `outputSchema.properties.message = {"type": "string"}` but returned
`"message": null` on some code paths. The MCP Inspector `tools/list` (and older Inspector
`tools/call`) looked fine, but SDK-based clients validate `structuredContent` against
`outputSchema`. They raise `Invalid structured content returned by tool X: None is not of
type 'string'`, so the agent gets an error instead of data. Adding OpenAPI's
`"nullable": true` doesn't help, because JSON Schema ignores `nullable`. The schema has to say
`"type": ["string", "null"]` (or the server has to always send a string). mcp-check
calls the tools, lets the SDK validate exactly as a client would, and also validates
with `jsonschema` independently so you get the exact JSON path (`/message`).

## What it checks

1. **initialize**: records server name/version and the negotiated protocol version.
2. **tools/list**: follows `nextCursor` pagination.
3. **Static lint** of every tool's `inputSchema` / `outputSchema`:
   - valid JSON Schema (Draft 2020-12 unless `$schema` says otherwise)
   - the root of `inputSchema` and `outputSchema` must be `type: object` (MCP requires it)
   - OpenAPI-only keywords (`nullable`, `discriminator`, `example`, ...) are flagged as WARN.
     `nullable` on a non-null type means null is still **rejected** by JSON Schema.
   - tool names must be 1-128 characters of `A-Z a-z 0-9 _ - .` (WARN otherwise)
   - required output fields that can't be null are listed, because these are what break when a backend returns null.
4. **Calls** from a cases file. A tool without a case is **NOT EXERCISED** and never called.
   For each call:
   - SDK rejects the result → **FAIL**, with a plain-language detail per problem (below)
   - output schema declared but no `structuredContent` → **FAIL**
   - `isError: true` or a JSON-RPC/HTTP error → **FAIL**, or PASS if the case says `expect: error`
     (an error result with no text in `content` is called out, since clients can't show it)
   - SDK accepted but independent jsonschema found errors → **WARN**
   - otherwise **PASS**
   - request IDs (headers like `x-request-id`/`traceparent`, or `requestId` in bodies) are captured
   - on a 429 / "rate limit" / "throttl" response, the remaining calls are SKIPPED (`--no-stop-on-rate-limit` to disable)

5. **Null sweep** (every call): every field that came back `null` where the `outputSchema` does
   not allow null gets a `null-sweep` **FAIL** row listing all such paths (a validator reports one
   best match; this lists them all, resolves local `$ref`s, and calls out an ignored `nullable: true`).
   If there is no `structuredContent`, a JSON object in the text content is swept instead.
6. **Coverage** line under the summary: `coverage: N tools, X exercised, Y not exercised (names)`,
   so a newly added tool without a case shows up by name. Also `coverage` in the JSON report.

Every detail says what was expected, what came back, the JSON path, and how to fix it, e.g.

```
Field /message is null, but the output schema says it must be a string. Strict clients (like the
Python SDK) will reject this response. Fix: return a string, or allow null with "type": ["string", "null"].
```

The Inspector fork's Conformance tab uses the same rules and the same wording.

Output is a table (tool, check, status, ms, detail), `--json FILE`, and `--junit FILE`.

`--show-response` prints, for each failing call, the args sent, the raw result (`content`,
`structuredContent`, `isError`) and the tool's outputSchema as pretty JSON, with the lines at each
problem path marked `>>` (the same lines the Inspector highlights when you open a row). The `--json`
report always carries this per call row: `data.args`, `data.result` and `data.output_schema`
(older keys such as `structured_content` are unchanged).

```
--- null_string_field call[auto] (FAIL)
  problem: /message is null (marked >>)
  ...
         "structuredContent": {
    >>     "message": null,
```
Exit code: `0` pass, `1` any FAIL (or connection failure), `2` usage error.

## Setup

Requires Python ≥ 3.10. Node ≥ 22 is only needed for `run-all.sh`'s Inspector step.

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt && pip install -e .
```

Pinned: `mcp==2.3.0`, `jsonschema==4.26.0`, `PyYAML==6.0.3`, `pytest==9.1.1`, Inspector `@modelcontextprotocol/inspector@2.12.0`.
The code also runs on the 1.x SDK (the test suite passes on `mcp==1.30.0`).

## Usage

```bash
export MCP_URL=https://example.com/mcp           # or --url
export MCP_API_KEY=...                           # ONLY via env; never a CLI flag
export MCP_AUTH_HEADER=X-API-Key                 # default: Authorization (sent as "Bearer <key>")

mcp-check --no-calls --dump-tools tools.json     # connect + list + lint only, no tool calls
mcp-check --cases cases.yaml --json out/report.json --junit out/report.junit.xml
mcp-check --cases cases.yaml --only 'search_*' --skip search_admin --delay 1
mcp-check --tool get_order                       # test one tool (args built from its inputSchema)
mcp-check --tool get_order --args '{"id": "42"}' # ... with your own args (or --args @args.json)
mcp-check --sse --url https://example.com/sse    # legacy SSE transport
./run-all.sh --cases cases.yaml --json out/report.json   # Inspector tools/list + mcp-check
```

| Env / flag | Meaning |
|---|---|
| `MCP_URL` / `--url` | server URL |
| `MCP_API_KEY` | secret; masked as `<SECRET>` in all output (stdout, stderr, JSON, JUnit) |
| `MCP_AUTH_HEADER` / `--auth-header` | header name (default `Authorization`) |
| `MCP_AUTH_SCHEME` / `--auth-scheme` | value prefix (default `Bearer` for Authorization, none otherwise) |
| `MCP_TRANSPORT` / `--transport http\|sse`, `--sse` | transport (default Streamable HTTP) |
| `--header 'Name: value'` | extra **non-secret** headers |
| `--only`, `--skip` | comma lists / globs of tool names |
| `--tool NAME` (repeatable) | test only these tools (exact names); see "Testing one tool" |
| `--args JSON\|@file` | with exactly one `--tool`: call it with these args |
| `--confirm-side-effects` | with `--tool`: allow calling a tool that looks like it changes data |
| `--no-calls`, `--strict-lint`, `--timeout`, `--delay` | see `mcp-check --help` |

## OAuth sign-in (instead of an API key)

```bash
mcp-check --oauth --url "$MCP_URL" --no-calls          # or: export MCP_AUTH=oauth
mcp-check --oauth --url "$MCP_URL" --oauth-logout      # forget stored tokens
```

How it works (MCP SDK `OAuthClientProvider`, authorization code + PKCE S256):

1. The first request gets a 401; the SDK reads the server's protected-resource metadata and
   its authorization server metadata.
2. The client ID is the HTTPS URL of a public **client ID metadata document** (CIMD). There is
   no hosted default: publish `client-metadata/client-metadata.json` (a template; its `client_id` is a placeholder) on any HTTPS host, set its
   `client_id` to the URL it is served from, and export `MCP_CLIENT_METADATA_URL` with that URL
   (or use `MCP_OAUTH_CLIENT_ID`). No client secret exists.
3. mcp-check starts a one-shot listener on `http://127.0.0.1:33418/callback`, prints the
   sign-in URL and opens your browser. After you sign in, the browser comes back to that
   listener and the code is exchanged for tokens.
4. Tokens are saved in `~/.mcp-check/oauth/<hash>.json` (dir `0700`, file `0600`) and reused
   or refreshed next time. They are never printed; access, refresh and id tokens are masked as
   `<SECRET>` in every output.

| Env | Meaning |
|---|---|
| `MCP_AUTH=oauth` / `--oauth` | use OAuth; `MCP_API_KEY` is ignored |
| `MCP_CLIENT_METADATA_URL` | the CIMD URL (required for OAuth unless `MCP_OAUTH_CLIENT_ID` is set; must be HTTPS and serve JSON whose `client_id` equals the URL) |
| `MCP_OAUTH_CLIENT_ID` | use a pre-registered public client_id issued by the server owner instead of CIMD |
| `MCP_OAUTH_PORT` | callback port (default 33418; must be listed in the client's `redirect_uris`) |
| `MCP_OAUTH_NO_BROWSER=1` | only print the URL |
| `MCP_OAUTH_CALLBACK_TIMEOUT` | seconds to wait for sign-in (default 300) |
| `MCP_CHECK_HOME` | token store root (default `~/.mcp-check`) |
| `MCP_OAUTH_DEBUG=1` | show the SDK's OAuth tracebacks on stderr |

Notes:

* **An authorization server may only accept pre-registered client IDs.** Some advertise CIMD
  support but answer unknown metadata URLs with an error page such as
  `client_id is not preregistered`. Until the server owner registers
  your metadata URL (or issues a client_id for `MCP_OAUTH_CLIENT_ID`), sign-in stops at that page.
* `run-all.sh` works with `--oauth` / `MCP_AUTH=oauth`, but it skips the Inspector step:
  passing a bearer token on the Inspector's command line would expose it.
* The GitHub Actions workflow is API-key only, because a browser sign-in can't run in CI.

## Cases file

See `cases.example.yaml`:

```yaml
healthy_tool:
  - args: {query: laptop}
  - {name: error result, args: {query: error}, expect: error}
```

Only list tools that are safe to call against the target environment. Anything that
creates, updates or sends should stay out of the file, and it will show as NOT EXERCISED.

### `--auto-cases` (opt-in)

For tools with no case, build the smallest valid arguments from `inputSchema` (required
properties only; `const`/`default`/`enum[0]`/`examples[0]`, then type minimums, local `$ref`s
resolved) and call once. Aimed at read-only lookups added after the cases file was written.

- **Never auto-called** (tools whose names suggest side effects): names containing `submit`, `create`, `update`, `delete`, `place`, `order`,
  `send`, `cancel`, `write`, `post` (substring, case-insensitive, deliberately over-broad:
  `order_search` is skipped too), tools annotated `destructiveHint: true` or `readOnlyHint: false`,
  and tools whose generated args would not validate. Add more with `--auto-deny WORD|GLOB`.
- `--auto-allow GLOB[,GLOB]`: only auto-call matching tools. The deny rules still win.
- An auto-call is `call[auto]`: a schema mismatch is **FAIL**, `isError`/JSON-RPC error with the
  made-up args is **WARN** ("add a real case"), otherwise PASS.
- Explicit cases are never affected by these rules: what is in the cases file is called.

### Testing one tool

`--tool NAME` limits the whole run (lint, calls, summary, coverage) to that tool. Repeat it for
a few tools. A name the server doesn't list is a FAIL row ("check the spelling"). Arguments:

1. `--args '{"id": "42"}'` (or `--args @args.json`): one call with exactly these args,
   reported as `call[args]`. It must succeed (an `isError` result is a FAIL).
2. otherwise the tool's cases from `--cases`, if any;
3. otherwise the minimal args auto-cases would build, as `call[auto]` (no `--auto-cases` needed).

A tool that looks like it changes data (same rules as the auto-cases deny list) is not called
unless you pass `--confirm-side-effects` or answer `y` at the prompt (shown only on a terminal):

```bash
mcp-check --tool delete_record --args '{"record_id": "r1"}' --confirm-side-effects
```

## CI (GitHub Actions)

`.github/workflows/mcp-check.yml` is `workflow_dispatch` only. Add repo secrets `MCP_URL` and
`MCP_API_KEY`, then run it from the Actions tab, choosing the cases file, the auth header/scheme and
the transport. The reports (`out/`) are uploaded as an artifact, including JUnit.

## run-all.sh

1. `npx @modelcontextprotocol/inspector@$INSPECTOR_VERSION --cli $URL --transport http|sse --method tools/list --stored-auth-only [--header "H: value"]`
   writes `out/inspector-tools.json` (masked).
2. `python -m mcp_check "$@"`.
3. Exit 0 only if both passed. It prints `combined: inspector=X mcp-check=Y`.

Env: `INSPECTOR_VERSION` (2.12.0), `OUT_DIR` (`out`), `SKIP_INSPECTOR=1`, `PYTHON`.

### Inspector notes / caveats
- The Inspector CLI has no env-based header option, so the key goes in `--header` on the
  `npx` process argv. While it runs, other processes **under the same user** can see it
  (`ps`, `/proc`). That's fine on a CI runner; on shared hosts use `SKIP_INSPECTOR=1`.
  `MCP_INSPECTOR_SECRET_STORE=memory` keeps it from writing tokens to `~/.mcp-inspector`.
- Without `--stored-auth-only`, a non-TTY run with no token tries interactive OAuth and fails.
- Inspector 2.12 declares `node >=22.19`. It works on node 20 with an EBADENGINE warning.
- `tools/list` can never detect output/result mismatches. Inspector 2.12's `tools/call` does
  validate (`data/message must be string`), but older 0.x releases didn't. `--strict` didn't
  flag `nullable`.

## Tests

```bash
pip install -e '.[test]' && pytest -q
```

`tests/demo_server.py` is a small MCP server (Streamable HTTP at `/mcp`, SSE at `/sse`,
optional API-key middleware) with a good tool (PASS), a `message: None` vs `type: string`
tool (FAIL), a `nullable: true` variant (FAIL + lint WARN), and an uncased tool (NOT EXERCISED).
It also exercises pagination, auth and masking, and runs `run-all.sh` (needs `npx`).

`tests/sample_bad_server.py` has one tool per common output bug, so you can see every message
(and compare with the Inspector's Conformance tab):

| Tool | What it does | Result |
|---|---|---|
| `null_string_field` | returns `"message": null`, schema says string | FAIL |
| `nullable_keyword` | same, but the schema adds OpenAPI `nullable: true` | lint WARN + FAIL |
| `wrong_type_field` | returns `"count": "12"`, schema says integer | FAIL |
| `missing_required_field` | leaves out the required `name` | FAIL |
| `extra_property` | sends `debug`, schema has `additionalProperties: false` | FAIL |
| `enum_violation` | returns `"status": "archived"`, not in the enum | FAIL |
| `missing_structured_content` | has an output schema, returns only text | FAIL |
| `healthy_tool` | valid result (`query: "error"` returns `isError`) | PASS |
| `delete_record` | side effect (`destructiveHint: true`), logs every call to `$MOCK_CALL_LOG` | NOT EXERCISED |

`tests/test_sample_server.py` proves `--auto-cases` FAILs each bug tool with the right message,
passes `healthy_tool`, never calls `delete_record`, and covers `--tool` / `--args`.

## Quick start with the sample server (macOS / Linux)

```zsh
cd mcp-check
python3 -m venv .venv && .venv/bin/pip install -U pip && .venv/bin/pip install -e '.[test]'

# terminal 1: the sample server on http://127.0.0.1:8766/mcp
.venv/bin/python tests/sample_bad_server.py --port 8766

# terminal 2: check every tool, then one tool with your own args
.venv/bin/mcp-check --url http://127.0.0.1:8766/mcp --auto-cases
.venv/bin/mcp-check --url http://127.0.0.1:8766/mcp --tool healthy_tool --args '{"query": "error"}'
```

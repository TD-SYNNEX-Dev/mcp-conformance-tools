# MCP Conformance Tools

Two tools for finding MCP server schema problems that the stock MCP Inspector misses but strict clients, such as the Python MCP SDK, reject. Examples are `null` where the output schema says `string`, wrong types, missing required fields, extra properties, enum violations, a missing `structuredContent`, and OpenAPI `nullable` (which JSON Schema 2020-12 ignores).

| Folder | What it is |
|---|---|
| `mcp-inspector-fork/` | A fork of the MCP Inspector (web UI) with a **Conformance** tab: schema lint, response checks, a details dialog for each finding, and a JSON export. |
| `mcp-check/` | A command-line tool with the same rules and wording, built on the official Python MCP SDK, for scripts and CI. It also contains `tests/sample_bad_server.py`, a small MCP server with one tool for each common mistake. |
| `guide/` | The user guide: [MCP-Inspector-Conformance-User-Guide.md](guide/MCP-Inspector-Conformance-User-Guide.md) (with images) and the same guide as a Word document (`.docx`). |

**Read the guide first:** [guide/MCP-Inspector-Conformance-User-Guide.md](guide/MCP-Inspector-Conformance-User-Guide.md)

## Requirements

- Node.js **22.19 or newer** (with npm)
- Python **3.10 or newer**
- A current browser (Chrome is the one tested)

## Quick start

Run these from this folder (the one that contains this README).

**1. Install (first time only)**

```bash
cd mcp-inspector-fork && npm install && cd ..
cd mcp-check && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/pip install -e . && cd ..
```

**2. Start the sample server** (in terminal 1)

```bash
cd mcp-check
.venv/bin/python tests/sample_bad_server.py --port 8766      # serves http://127.0.0.1:8766/mcp
```

**3. Start the Inspector** (in terminal 2). `<your-token>` is any local password you choose:

```bash
cd mcp-inspector-fork/clients/web
MCP_INSPECTOR_API_TOKEN=<your-token> npm run dev
```

Open `http://127.0.0.1:6274/?MCP_INSPECTOR_API_TOKEN=<your-token>`. Then:

1. Click **Add Servers → + Add manually**.
2. Fill in **Server ID** `sample-bad-server`, **Transport** `streamable-http` and **URL** `http://127.0.0.1:8766/mcp`, then click **Add**.
3. Connect the server with the switch on its card.
4. Open **Conformance**, tick **Auto-cases** and click **Run checks**.

**4. Or use the command line**

```bash
cd mcp-check
.venv/bin/mcp-check --url http://127.0.0.1:8766/mcp --auto-cases
```

> **Safe on production:** **List & lint** in the Conformance tab and `mcp-check --no-calls` only list tools and check their schemas. They never call a tool. Keep **Auto-cases** off against production servers.

## Licenses

- `mcp-inspector-fork/` is a fork of the official [MCP Inspector](https://github.com/modelcontextprotocol/inspector) (`modelcontextprotocol/inspector`, MIT, with newer upstream contributions under Apache-2.0). It adds a **Conformance** tab and other changes. The upstream license and credit are kept unchanged in `mcp-inspector-fork/LICENSE`.
- `mcp-check/` is MIT licensed, Copyright (c) 2026 TD SYNNEX Corporation. See `mcp-check/LICENSE`.

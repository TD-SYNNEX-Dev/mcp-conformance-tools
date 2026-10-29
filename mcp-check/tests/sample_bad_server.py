"""A small MCP server with one tool per common output bug, for trying mcp-check and the
Inspector's Conformance tab side by side (both should report the same thing).

Tools (Streamable HTTP at /mcp); every tool takes a required `query` string except delete_record:
  null_string_field           returns "message": null, but the schema says string           -> FAIL
  nullable_keyword            same, but the schema adds OpenAPI `nullable: true`, which JSON
                              Schema ignores (lint WARN; some clients accept, others reject) -> FAIL
  wrong_type_field            returns "count": "12" (a string), the schema says integer       -> FAIL
  missing_required_field      leaves out the required "name" field                           -> FAIL
  extra_property              sends "debug", but the schema has additionalProperties: false  -> FAIL
  enum_violation              returns "status": "archived", not one of active/inactive        -> FAIL
  missing_structured_content  declares an output schema but returns only text content        -> FAIL
  healthy_tool                returns a valid result (query "error" makes it report isError) -> PASS
  delete_record               side effect (destructiveHint: true): auto-cases must never call
                              it. Every call is appended to $MOCK_CALL_LOG / --log (if set)
                              and printed to stderr, so tests can prove it was not called.

tools/list is split over two pages, so pagination is exercised too.

Run:  python tests/sample_bad_server.py --port 8766 [--log /tmp/mock-calls.log]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

import mcp.types as types
import uvicorn
from mcp.server.lowlevel import Server
from mcp.server.transport_security import TransportSecuritySettings
from starlette.middleware.cors import CORSMiddleware

QUERY_INPUT = {"type": "object", "properties": {"query": {"type": "string", "minLength": 1}},
               "required": ["query"]}
DELETE_INPUT = {"type": "object", "properties": {"record_id": {"type": "string", "minLength": 1}},
                "required": ["record_id"]}

MESSAGE = {"type": "object", "properties": {"message": {"type": "string"}, "items": {"type": "array"}},
           "required": ["message", "items"]}
MESSAGE_NULLABLE = {"type": "object",
                    "properties": {"message": {"type": "string", "nullable": True}, "items": {"type": "array"}},
                    "required": ["message", "items"]}
COUNT = {"type": "object", "properties": {"count": {"type": "integer"}}, "required": ["count"]}
RECORD = {"type": "object", "properties": {"id": {"type": "string"}, "name": {"type": "string"}},
          "required": ["id", "name"]}
STRICT_RECORD = {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"],
                 "additionalProperties": False}
STATUS = {"type": "object", "properties": {"status": {"type": "string", "enum": ["active", "inactive"]}},
          "required": ["status"]}
RESULT = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}

RO = types.ToolAnnotations(read_only_hint=True)


def _tool(name: str, description: str, output_schema: dict[str, Any], **kw: Any) -> types.Tool:
    return types.Tool(name=name, description=description, input_schema=kw.pop("input_schema", QUERY_INPUT),
                      output_schema=output_schema, annotations=kw.pop("annotations", RO), **kw)


TOOLS = [
    _tool("null_string_field", "Returns message: null where the schema says string.", MESSAGE),
    _tool("nullable_keyword", "Schema uses OpenAPI `nullable: true`; returns message: null.", MESSAGE_NULLABLE),
    _tool("wrong_type_field", 'Returns count: "12" (string) where the schema says integer.', COUNT),
    _tool("missing_required_field", "Leaves out the required name field.", RECORD),
    _tool("extra_property", "Sends a field the schema does not allow (additionalProperties: false).", STRICT_RECORD),
    _tool("enum_violation", "Returns a status that is not in the enum.", STATUS),
    _tool("missing_structured_content", "Has an output schema but returns only text content.", RECORD),
    _tool("healthy_tool", 'Returns a valid result. Pass query "error" to get an isError result.', MESSAGE),
    _tool("delete_record", "Deletes a record (side effect). Never auto-called.", RESULT,
          input_schema=DELETE_INPUT, annotations=types.ToolAnnotations(destructive_hint=True, read_only_hint=False)),
]
PAGE = 5

LOG = os.environ.get("MOCK_CALL_LOG")


def _result(payload: dict[str, Any]) -> types.CallToolResult:
    return types.CallToolResult(content=[types.TextContent(type="text", text=json.dumps(payload))],
                                structured_content=payload)


async def list_tools(ctx: Any, params: types.PaginatedRequestParams | None) -> types.ListToolsResult:
    if params is None or not params.cursor:
        return types.ListToolsResult(tools=TOOLS[:PAGE], next_cursor="page2")
    return types.ListToolsResult(tools=TOOLS[PAGE:])


async def call_tool(ctx: Any, params: types.CallToolRequestParams) -> types.CallToolResult:
    if LOG:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(params.name + "\n")
    args = params.arguments or {}
    q = args.get("query")
    name = params.name
    if name == "null_string_field" or name == "nullable_keyword":
        return _result({"message": None, "items": [{"query": q}]})
    if name == "wrong_type_field":
        return _result({"count": "12"})
    if name == "missing_required_field":
        return _result({"id": "1"})
    if name == "extra_property":
        return _result({"id": "1", "debug": "internal trace id 42"})
    if name == "enum_violation":
        return _result({"status": "archived"})
    if name == "missing_structured_content":
        return types.CallToolResult(content=[types.TextContent(type="text", text=json.dumps({"id": "1", "name": "A"}))])
    if name == "healthy_tool":
        if q == "error":
            return types.CallToolResult(content=[types.TextContent(type="text", text="query 'error' is not allowed")],
                                        is_error=True)
        return _result({"message": f"found 1 result for {q!r}", "items": [{"query": q}]})
    if name == "delete_record":
        print("MOCK: delete_record CALLED", file=sys.stderr, flush=True)
        return _result({"ok": True})
    return types.CallToolResult(content=[types.TextContent(type="text", text=f"unknown tool {name}")], is_error=True)


server: Server[Any] = Server("sample-bad-server", version="0.1.0", on_list_tools=list_tools, on_call_tool=call_tool)


def build_app() -> Any:
    security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=["127.0.0.1:*", "localhost:*"],
        allowed_origins=["http://127.0.0.1:*", "http://localhost:*"],
    )
    app = server.streamable_http_app(transport_security=security)
    # Browser clients (the Inspector web app in direct mode) need CORS.
    return CORSMiddleware(app, allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
                          allow_methods=["GET", "POST", "DELETE", "OPTIONS"], allow_headers=["*"],
                          expose_headers=["mcp-session-id", "mcp-protocol-version"])


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8766)
    p.add_argument("--log", help="append every called tool name here (same as $MOCK_CALL_LOG)")
    a = p.parse_args()
    if a.log:
        LOG = a.log
    uvicorn.run(build_app(), host=a.host, port=a.port, log_level="warning")

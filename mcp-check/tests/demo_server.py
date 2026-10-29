"""Tiny local MCP server for proving mcp-check works end to end without a real server.

Tools:
  good_tool         returns structured content that matches its outputSchema   -> PASS
  null_message_tool returns {"message": None} against {"type": "string"}       -> FAIL
  nullable_tool     same null, but the schema uses OpenAPI `nullable: true`      -> lint WARN + FAIL
  uncovered_tool    valid, but has no entry in the cases file                    -> NOT EXERCISED

Serves Streamable HTTP at /mcp and legacy SSE at /sse (+ /messages/).
If DEMO_SERVER_API_KEY is set, every request must carry it in DEMO_SERVER_AUTH_HEADER
(default "Authorization", value "Bearer <key>"; for other headers the raw key).
If DEMO_SERVER_OAUTH=1, the server is also a tiny OAuth authorization server that supports
URL-based client IDs (CIMD) and auto-approves /authorize (no login page), so the --oauth
flow can be tested end to end. Every MCP request then needs a Bearer token it issued.

Run:  python tests/demo_server.py --port 8765
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import secrets
from urllib.parse import parse_qs, urlencode
from typing import Any

import mcp.types as types
import uvicorn
from mcp.server.lowlevel import Server
from mcp.server.sse import SseServerTransport
from mcp.server.transport_security import TransportSecuritySettings
from starlette.responses import Response
from starlette.routing import Mount, Route

STRING_MESSAGE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "success": {"type": "boolean"},
        "message": {"type": "string"},
        "data": {"type": "array", "items": {"type": "object"}},
    },
    "required": ["success", "message", "data"],
}

NULLABLE_MESSAGE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "success": {"type": "boolean"},
        "message": {"type": "string", "nullable": True},  # OpenAPI-only; JSON Schema ignores it
        "data": {"type": "array", "items": {"type": "object"}},
    },
    "required": ["success", "message", "data"],
}

INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"keyword": {"type": "string"}},
    "required": ["keyword"],
}

TOOLS = [
    types.Tool(name="good_tool", description="Returns valid structured content.",
               input_schema=INPUT_SCHEMA, output_schema=STRING_MESSAGE_SCHEMA),
    types.Tool(name="null_message_tool", description="Returns message: null against a string schema.",
               input_schema=INPUT_SCHEMA, output_schema=STRING_MESSAGE_SCHEMA),
    types.Tool(name="nullable_tool", description="Returns message: null; schema uses OpenAPI nullable.",
               input_schema=INPUT_SCHEMA, output_schema=NULLABLE_MESSAGE_SCHEMA),
    types.Tool(name="uncovered_tool", description="Valid tool with no test case.",
               input_schema={"type": "object", "properties": {}}, output_schema=STRING_MESSAGE_SCHEMA),
]


def _result(payload: dict[str, Any]) -> types.CallToolResult:
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=json.dumps(payload))],
        structured_content=payload,
    )


async def list_tools(ctx: Any, params: types.PaginatedRequestParams | None) -> types.ListToolsResult:
    # Two pages so the client's pagination is exercised.
    if params is None or not params.cursor:
        return types.ListToolsResult(tools=TOOLS[:2], next_cursor="page2")
    return types.ListToolsResult(tools=TOOLS[2:])


async def call_tool(ctx: Any, params: types.CallToolRequestParams) -> types.CallToolResult:
    args = params.arguments or {}
    rows = [{"keyword": args.get("keyword"), "sku": "DEMO-1"}]
    if params.name == "good_tool":
        return _result({"success": True, "message": "ok", "data": rows})
    if params.name in ("null_message_tool", "nullable_tool"):
        # The classic bug: a successful call with message = null against a string schema.
        return _result({"success": True, "message": None, "data": rows})
    if params.name == "uncovered_tool":
        return _result({"success": True, "message": "ok", "data": []})
    return types.CallToolResult(content=[types.TextContent(type="text", text=f"unknown tool {params.name}")],
                                is_error=True)


server: Server[Any] = Server("mcp-check-demo-server", version="0.1.0", on_list_tools=list_tools, on_call_tool=call_tool)


class ApiKeyMiddleware:
    """Pure-ASGI header check so the auth path of the client and Inspector is exercised."""

    def __init__(self, app: Any, key: str, header: str) -> None:
        self.app, self.header = app, header.lower().encode()
        self.expected = (f"Bearer {key}" if header.lower() == "authorization" else key).encode()

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] == "http":
            got = dict(scope.get("headers") or []).get(self.header, b"")
            if not hmac.compare_digest(got, self.expected):
                await Response("unauthorized", status_code=401)(scope, receive, send)
                return
        await self.app(scope, receive, send)


class OAuthDemoMiddleware:
    """Protected-resource metadata + an auto-approving CIMD authorization server (tests only)."""

    def __init__(self, app: Any) -> None:
        self.app = app
        self.codes: dict[str, dict[str, str]] = {}
        self.tokens: set[str] = set()
        self.refresh: set[str] = set()
        self.seen_client_ids: list[str] = []

    @staticmethod
    def _base(scope: Any) -> str:
        host = dict(scope.get("headers") or []).get(b"host", b"127.0.0.1").decode()
        return f"http://{host}"

    async def _body(self, receive: Any) -> bytes:
        body = b""
        while True:
            msg = await receive()
            body += msg.get("body", b"")
            if not msg.get("more_body"):
                return body

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path, base = scope["path"], self._base(scope)

        def js(obj: Any, status: int = 200) -> Response:
            return Response(json.dumps(obj), status_code=status, media_type="application/json")

        if path.startswith("/.well-known/oauth-protected-resource"):
            await js({"resource": f"{base}/mcp", "authorization_servers": [base],
                      "scopes_supported": ["openid", "offline_access"]})(scope, receive, send)
            return
        if path in ("/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"):
            await js({"issuer": base, "authorization_endpoint": f"{base}/authorize",
                      "token_endpoint": f"{base}/token", "response_types_supported": ["code"],
                      "grant_types_supported": ["authorization_code", "refresh_token"],
                      "code_challenge_methods_supported": ["S256"],
                      "token_endpoint_auth_methods_supported": ["none"],
                      "scopes_supported": ["openid", "offline_access"],
                      "client_id_metadata_document_supported": True})(scope, receive, send)
            return
        if path == "/authorize":
            q = {k: v[0] for k, v in parse_qs(scope.get("query_string", b"").decode()).items()}
            if not q.get("client_id", "").startswith("https://") or q.get("code_challenge_method") != "S256":
                await js({"error": "invalid_client"}, 400)(scope, receive, send)
                return
            self.seen_client_ids.append(q["client_id"])
            code = secrets.token_urlsafe(16)
            self.codes[code] = {"challenge": q["code_challenge"], "client_id": q["client_id"],
                                "redirect_uri": q["redirect_uri"]}
            loc = q["redirect_uri"] + "?" + urlencode({"code": code, "state": q.get("state", ""), "iss": base})
            await Response(status_code=302, headers={"location": loc})(scope, receive, send)
            return
        if path == "/token":
            f = {k: v[0] for k, v in parse_qs((await self._body(receive)).decode()).items()}
            if f.get("grant_type") == "authorization_code":
                c = self.codes.pop(f.get("code", ""), None)
                digest = base64.urlsafe_b64encode(hashlib.sha256(f.get("code_verifier", "").encode()).digest())
                if (not c or c["client_id"] != f.get("client_id")
                        or digest.rstrip(b"=").decode() != c["challenge"]):
                    await js({"error": "invalid_grant"}, 400)(scope, receive, send)
                    return
            elif f.get("grant_type") == "refresh_token":
                if f.get("refresh_token") not in self.refresh:
                    await js({"error": "invalid_grant"}, 400)(scope, receive, send)
                    return
            else:
                await js({"error": "unsupported_grant_type"}, 400)(scope, receive, send)
                return
            at, rt = "demo-at-" + secrets.token_urlsafe(24), "demo-rt-" + secrets.token_urlsafe(24)
            self.tokens.add(at)
            self.refresh.add(rt)
            await js({"access_token": at, "token_type": "Bearer", "expires_in": 3600,
                      "refresh_token": rt, "scope": "openid offline_access"})(scope, receive, send)
            return
        auth = dict(scope.get("headers") or []).get(b"authorization", b"").decode()
        if not (auth.startswith("Bearer ") and auth[7:] in self.tokens):
            await Response("unauthorized", status_code=401, headers={
                "www-authenticate": f'Bearer resource_metadata="{base}/.well-known/oauth-protected-resource/mcp"'})(
                scope, receive, send)
            return
        await self.app(scope, receive, send)


def build_app() -> Any:
    security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=["127.0.0.1:*", "localhost:*"],
        allowed_origins=["http://127.0.0.1:*", "http://localhost:*"],
    )
    sse = SseServerTransport("/messages/", security_settings=security)

    async def handle_sse(request: Any) -> Response:
        async with sse.connect_sse(request.scope, request.receive, request._send) as streams:
            await server.run(streams[0], streams[1], server.create_initialization_options())
        return Response()

    app = server.streamable_http_app(
        transport_security=security,
        custom_starlette_routes=[
            Route("/sse", endpoint=handle_sse, methods=["GET"]),
            Mount("/messages/", app=sse.handle_post_message),
        ],
    )
    if os.environ.get("DEMO_SERVER_OAUTH") == "1":
        return OAuthDemoMiddleware(app)
    key = os.environ.get("DEMO_SERVER_API_KEY")
    if key:
        return ApiKeyMiddleware(app, key, os.environ.get("DEMO_SERVER_AUTH_HEADER", "Authorization"))
    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    a = parser.parse_args()
    uvicorn.run(build_app(), host=a.host, port=a.port, log_level="warning")

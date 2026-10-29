"""OAuth browser sign-in for mcp-check (authorization code + PKCE, URL-based client ID / CIMD).

The client_id is the HTTPS URL of a public client metadata document (draft
"OAuth Client ID Metadata Document"). Authorization servers that advertise
`client_id_metadata_document_supported: true` fetch that document instead of requiring
dynamic client registration. Some servers only accept metadata URLs
they have pre-registered ("client_id is not preregistered"); MCP_OAUTH_CLIENT_ID lets you use a
client_id the server owner issued instead.

Tokens are kept in ~/.mcp-check/oauth/<hash>.json (dir 0700, file 0600). They are registered
with the masker on load/save and never printed.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import anyio

from mcp_check.masking import mask, register


class _AuthErrorCapture(logging.Handler):
    """Keeps the SDK's OAuth flow errors (one line, masked) instead of a traceback on stderr."""

    def __init__(self) -> None:
        super().__init__(logging.WARNING)
        self.errors: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        msg = record.getMessage()
        if record.exc_info and record.exc_info[1] is not None:
            e = record.exc_info[1]
            msg = f"{msg}: {type(e).__name__}: {e}"
        self.errors.append(mask(" ".join(msg.split())[:500]))

# No hosted default: publish client-metadata/client-metadata.json (with client_id set to its own
# HTTPS URL) and point MCP_CLIENT_METADATA_URL at it, or use MCP_OAUTH_CLIENT_ID.
DEFAULT_CLIENT_METADATA_URL = "https://example.com/mcp-check/client-metadata.json"
DEFAULT_PORT = 33418  # must match a redirect_uri in the published metadata document
CALLBACK_PATH = "/callback"
DEFAULT_SCOPE = "openid email profile offline_access"


def token_dir() -> Path:
    return Path(os.environ.get("MCP_CHECK_HOME") or Path.home() / ".mcp-check") / "oauth"


def _register_token(tok: Any) -> None:
    if tok is None:
        return
    for attr in ("access_token", "refresh_token", "id_token"):
        register(getattr(tok, attr, None))


class FileTokenStorage:
    """SDK TokenStorage backed by one JSON file per (server, client_id)."""

    def __init__(self, server_url: str, client_id: str, directory: Path | None = None,
                 preset_client: dict[str, Any] | None = None) -> None:
        self._preset = preset_client
        key = hashlib.sha256(f"{server_url}\n{client_id}".encode()).hexdigest()[:16]
        self.dir = directory or token_dir()
        self.path = self.dir / f"{key}.json"

    def _read(self) -> dict[str, Any]:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _write(self, data: dict[str, Any]) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.dir, 0o700)
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)

    async def get_tokens(self) -> Any:
        from mcp.shared.auth import OAuthToken
        raw = self._read().get("tokens")
        if not raw:
            return None
        tok = OAuthToken.model_validate(raw)
        _register_token(tok)
        return tok

    async def set_tokens(self, tokens: Any) -> None:
        _register_token(tokens)
        data = self._read()
        data["tokens"] = tokens.model_dump(mode="json", exclude_none=True)
        self._write(data)

    async def get_client_info(self) -> Any:
        from mcp.shared.auth import OAuthClientInformationFull
        raw = self._read().get("client_info") or self._preset
        return OAuthClientInformationFull.model_validate(raw) if raw else None

    async def set_client_info(self, client_info: Any) -> None:
        data = self._read()
        data["client_info"] = client_info.model_dump(mode="json", exclude_none=True)
        self._write(data)

    def clear(self) -> bool:
        try:
            self.path.unlink()
            return True
        except FileNotFoundError:
            return False


class CallbackServer:
    """One-shot loopback HTTP server that catches ?code=&state=&iss= on /callback."""

    def __init__(self, port: int = DEFAULT_PORT, host: str = "127.0.0.1") -> None:
        self.host, self.port = host, port
        self.result: dict[str, str] | None = None
        self._event = threading.Event()
        self._httpd: HTTPServer | None = None

    @property
    def redirect_uri(self) -> str:
        return f"http://{self.host}:{self.port}{CALLBACK_PATH}"

    def start(self) -> None:
        if self._httpd is not None:
            return
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                parts = urlsplit(self.path)
                if parts.path != CALLBACK_PATH:
                    self.send_response(404)
                    self.end_headers()
                    return
                q = {k: v[0] for k, v in parse_qs(parts.query).items()}
                ok = "code" in q
                self.send_response(200 if ok else 400)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                msg = ("Signed in. You can close this tab and return to the terminal." if ok else
                       f"Sign-in failed: {q.get('error', 'no code')} {q.get('error_description', '')}")
                self.wfile.write(f"<html><body><h3>mcp-check</h3><p>{_html(msg)}</p></body></html>".encode())
                if outer.result is None:
                    outer.result = q
                    outer._event.set()

            def log_message(self, *args: Any) -> None:  # never log the query string (it has the code)
                pass

        self._httpd = HTTPServer((self.host, self.port), Handler)
        threading.Thread(target=self._httpd.serve_forever, daemon=True).start()

    def wait(self, timeout: float) -> dict[str, str] | None:
        self._event.wait(timeout)
        return self.result

    def stop(self) -> None:
        if self._httpd is not None:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None


def _html(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_auth(server_url: str, *, client_metadata_url: str | None = None, port: int | None = None,
               open_browser: bool | None = None, callback_timeout: float | None = None,
               storage_dir: Path | None = None, client_id: str | None = None) -> Any:
    """Return an httpx Auth (the SDK's OAuthClientProvider) for `server_url`."""
    from mcp.client.auth import OAuthClientProvider
    from mcp.shared.auth import AuthorizationCodeResult, OAuthClientMetadata

    cmd_url = client_metadata_url or os.environ.get("MCP_CLIENT_METADATA_URL") or DEFAULT_CLIENT_METADATA_URL
    if cmd_url == DEFAULT_CLIENT_METADATA_URL and not (client_id or os.environ.get("MCP_OAUTH_CLIENT_ID")):
        raise ValueError("OAuth needs a client: set MCP_CLIENT_METADATA_URL to the HTTPS URL of your published "
                         "client metadata document (see client-metadata/), or MCP_OAUTH_CLIENT_ID to a client_id "
                         "issued by the server owner.")
    port = port or int(os.environ.get("MCP_OAUTH_PORT", DEFAULT_PORT))
    if open_browser is None:
        open_browser = os.environ.get("MCP_OAUTH_NO_BROWSER", "") not in ("1", "true", "yes")
    if callback_timeout is None:
        callback_timeout = float(os.environ.get("MCP_OAUTH_CALLBACK_TIMEOUT", "300"))
    cb = CallbackServer(port)

    async def redirect_handler(url: str) -> None:
        cb.start()  # listen before the browser can come back
        print("\nmcp-check: sign in to continue. Opening your browser; if it does not open, paste this URL:\n"
              f"  {url}\n", file=sys.stderr, flush=True)
        if open_browser:
            try:
                webbrowser.open(url)
            except Exception:  # noqa: BLE001
                pass

    async def callback_handler() -> AuthorizationCodeResult:
        try:
            q = await anyio.to_thread.run_sync(cb.wait, callback_timeout)
        finally:
            cb.stop()
        if not q:
            raise TimeoutError(f"no OAuth callback on {cb.redirect_uri} within {callback_timeout:.0f}s")
        if "code" not in q:
            raise RuntimeError(f"authorization failed: {q.get('error', '?')} {q.get('error_description', '')}".strip())
        register(q["code"])
        print("mcp-check: sign-in callback received; exchanging code for tokens", file=sys.stderr, flush=True)
        return AuthorizationCodeResult(code=q["code"], state=q.get("state"), iss=q.get("iss"))

    meta = OAuthClientMetadata(
        client_name="MCP Conformance Check",
        redirect_uris=[cb.redirect_uri],
        grant_types=["authorization_code", "refresh_token"],
        response_types=["code"],
        token_endpoint_auth_method="none",
        scope=DEFAULT_SCOPE,
    )
    # A pre-registered public client_id (issued by the authorization server's owner) skips CIMD.
    preset_id = client_id or os.environ.get("MCP_OAUTH_CLIENT_ID") or None
    preset = None
    if preset_id:
        preset = {"client_id": preset_id, "redirect_uris": [cb.redirect_uri], "token_endpoint_auth_method": "none",
                  "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
                  "scope": DEFAULT_SCOPE}
    storage = FileTokenStorage(server_url, preset_id or cmd_url, storage_dir, preset)
    provider = OAuthClientProvider(server_url=server_url, client_metadata=meta, storage=storage,
                                   redirect_handler=redirect_handler, callback_handler=callback_handler,
                                   client_metadata_url=cmd_url)
    provider.token_storage = storage  # for --oauth-logout and tests
    provider.effective_client_id = preset_id or cmd_url
    cap = _AuthErrorCapture()
    log = logging.getLogger("mcp.client.auth")
    log.addHandler(cap)
    log.propagate = os.environ.get("MCP_OAUTH_DEBUG") == "1"
    provider.auth_errors = cap.errors
    return provider


def client_metadata_document(client_id_url: str, ports: tuple[int, ...] = (DEFAULT_PORT,)) -> dict[str, Any]:
    """The JSON to publish at `client_id_url` (client_id must equal the URL it is served from)."""
    return {
        "client_id": client_id_url,
        "client_name": "MCP Conformance Check",
        "redirect_uris": [f"http://127.0.0.1:{p}{CALLBACK_PATH}" for p in ports]
                         + [f"http://localhost:{p}{CALLBACK_PATH}" for p in ports],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "scope": DEFAULT_SCOPE,
    }

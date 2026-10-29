"""Secret masking. Every string that leaves the tool (table, JSON, JUnit, logs) goes through mask()."""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

MASK = "<SECRET>"
_secrets: list[str] = []
_SECRET_KEYS = re.compile(r"(?i)^(access_token|refresh_token|id_token|code_verifier|client_secret|x-api-key|authorization)$")


def register(value: str | None) -> None:
    if value and len(value) >= 4 and value not in _secrets:
        _secrets.append(value)
        _secrets.sort(key=len, reverse=True)


def mask(text: Any) -> Any:
    if isinstance(text, str):
        for s in _secrets:
            text = text.replace(s, MASK)
        # Belt and braces: bearer tokens / api-key headers echoed back by a server.
        text = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{12,}", r"\1" + MASK, text)
        text = re.sub(r"(?i)(x-api-key['\"]?\s*[:=]\s*['\"]?)[^\s'\",}]+", r"\1" + MASK, text)
        # OAuth: token / code fields in JSON bodies, form bodies or query strings.
        text = re.sub(r"(?i)([\"']?(?<![A-Za-z0-9_])(?:access_token|refresh_token|id_token|code_verifier|client_secret)[\"']?"
                      r"\s*[:=]\s*[\"']?)[^\s'\",}&]{6,}", r"\1" + MASK, text)
        return text
    if isinstance(text, dict):
        return {mask(k): (MASK if isinstance(k, str) and _SECRET_KEYS.match(k) and v else mask(v))
                for k, v in text.items()}
    if isinstance(text, (list, tuple)):
        return [mask(v) for v in text]
    return text


def safe_url(url: str) -> str:
    """URL with userinfo and every query-string value masked (keys sometimes ride in ?api_key=)."""
    parts = urlsplit(url)
    netloc = parts.hostname or ""
    if parts.port:
        netloc += f":{parts.port}"
    if parts.username or parts.password:
        netloc = f"{MASK}@{netloc}"
    query = urlencode([(k, MASK) for k, _ in parse_qsl(parts.query, keep_blank_values=True)])
    return mask(urlunsplit((parts.scheme, netloc, parts.path, query, parts.fragment)))

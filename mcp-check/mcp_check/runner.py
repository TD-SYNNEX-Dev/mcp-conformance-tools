"""Connect, list, lint and call tools using the official MCP Python SDK.

The SDK's own ClientSession.call_tool() decides whether a result is accepted: that is the code
path a partner's agent runs. We subclass ClientSession only to *observe* the raw result before
the SDK validates it, so we can (a) show the exact failing JSON path with jsonschema and (b) keep
the payload for the report. The SDK's validation is still the one that passes or fails.

Works with mcp 2.x (pinned) and mcp 1.x (validate hook name and a few field names differ).
"""

from __future__ import annotations

import inspect
import re
import time
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from fnmatch import fnmatch
from typing import Any, Callable

import anyio
from jsonschema.validators import validator_for
from mcp import ClientSession

from mcp_check.auto_cases import NO_CASE_DETAIL, AutoCaseError, auto_case, minimal_args, not_called_detail, side_effect_reason
from mcp_check.cases import Case
from mcp_check.detail import result_view
from mcp_check.explain import STRICT, js, mismatch_detail, null_sweep_detail, schema_issues
from mcp_check.lint import _DEFAULT_META, lint_detail, lint_tool
from mcp_check.null_sweep import null_sweep
from mcp_check.masking import mask

PASS, FAIL, WARN, NOT_EXERCISED, SKIPPED = "PASS", "FAIL", "WARN", "NOT EXERCISED", "SKIPPED"

SDK_VALIDATION_PATTERNS = (
    "Invalid structured content returned by tool",
    "has an output schema but did not return structured content",
    "Invalid schema for tool",
)
REQUEST_ID_KEYS = re.compile(r"^(x-)?(request|correlation|trace|transaction)[-_]?id$|^x-b3-traceid$|^traceparent$", re.I)
RATE_LIMIT = re.compile(r"\b429\b|rate.?limit|too many requests|throttl", re.I)


@dataclass
class Row:
    tool: str
    check: str
    status: str
    ms: float | None = None
    detail: str = ""
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class Options:
    url: str
    transport: str = "http"  # http | sse
    headers: dict[str, str] = field(default_factory=dict)
    auth: Any = None  # httpx Auth, e.g. the SDK's OAuthClientProvider (--oauth)
    init_timeout: float | None = None  # initialize timeout; longer with --oauth (browser sign-in)
    cases: dict[str, list[Case]] = field(default_factory=dict)
    only: list[str] = field(default_factory=list)
    skip: list[str] = field(default_factory=list)
    timeout: float = 60.0
    delay: float = 0.0
    no_calls: bool = False
    strict_lint: bool = False
    stop_on_rate_limit: bool = True
    auto_cases: bool = False  # opt-in: build minimal args for tools with no case (see auto_cases.py)
    auto_allow: list[str] = field(default_factory=list)  # globs; if set, only these may be auto-called
    auto_deny: list[str] = field(default_factory=list)  # extra deny words/globs on top of DEFAULT_DENY
    # Single-tool mode (--tool NAME, repeatable): lint and call only these tools.
    tools: list[str] = field(default_factory=list)
    tool_args: dict[str, Any] | None = None  # --args: custom args for the one --tool
    confirm_side_effects: bool = False  # --confirm-side-effects: allow calling a deny-listed --tool
    confirm: Callable[[str, str, dict[str, Any]], bool] | None = None  # interactive y/N prompt (TTY only)


@dataclass
class Report:
    url: str
    transport: str
    sdk_version: str
    server_info: dict[str, Any] | None = None
    protocol_version: str | None = None
    capabilities: dict[str, Any] | None = None
    tools: list[dict[str, Any]] = field(default_factory=list)
    rows: list[Row] = field(default_factory=list)
    filtered_out: list[str] = field(default_factory=list)
    fatal: str | None = None

    @property
    def failed(self) -> bool:
        return self.fatal is not None or any(r.status == FAIL for r in self.rows)


# --------------------------------------------------------------------------- helpers

def coverage(report: "Report") -> dict[str, Any]:
    """Which selected tools were actually called (by a case or an auto-case)."""
    names = [t["name"] for t in report.tools if t["name"] not in set(report.filtered_out)]
    hit = {r.tool for r in report.rows if r.check.startswith("call") and r.status not in (NOT_EXERCISED, SKIPPED)}
    missing = [n for n in names if n not in hit]
    return {"tools": len(names), "exercised": len(names) - len(missing), "not_exercised": missing}


def _attr(obj: Any, *names: str, default: Any = None) -> Any:
    for n in names:
        if hasattr(obj, n):
            return getattr(obj, n)
    return default


def _dump(model: Any) -> Any:
    if model is None:
        return None
    if hasattr(model, "model_dump"):
        return model.model_dump(by_alias=True, exclude_none=True, mode="json")
    return model


def sdk_version() -> str:
    from importlib.metadata import version
    return version("mcp")


def _selected(name: str, opts: Options) -> bool:
    if opts.tools and name not in opts.tools:
        return False
    if opts.only and not any(fnmatch(name, p) for p in opts.only):
        return False
    return not any(fnmatch(name, p) for p in opts.skip)


def _pointer(path: Any) -> str:
    parts = list(path)
    return "/" + "/".join(str(p) for p in parts) if parts else "/"


def schema_errors(schema: dict[str, Any], instance: Any) -> list[dict[str, str]]:
    """Every jsonschema error with its JSON pointer into the structured content."""
    cls = validator_for(schema, default=validator_for({"$schema": _DEFAULT_META}))
    errs = sorted(cls(schema).iter_errors(instance), key=lambda e: (list(e.absolute_path), e.message))
    return [{"path": _pointer(e.absolute_path), "message": e.message,
             "schema_path": _pointer(e.absolute_schema_path)} for e in errs]


def find_request_ids(*objs: Any) -> list[str]:
    found: list[str] = []

    def walk(o: Any, depth: int = 0) -> None:
        if depth > 6:
            return
        if isinstance(o, dict):
            for k, v in o.items():
                if isinstance(k, str) and REQUEST_ID_KEYS.match(k) and isinstance(v, (str, int)) and str(v):
                    found.append(f"{k}={v}")
                else:
                    walk(v, depth + 1)
        elif isinstance(o, list):
            for v in o[:50]:
                walk(v, depth + 1)
        elif isinstance(o, str):
            for m in re.finditer(r"(?i)\b(request[-_ ]?id|trace[-_ ]?id|correlation[-_ ]?id)[\"']?\s*[:=]\s*[\"']?([A-Za-z0-9-]{6,})", o):
                found.append(f"{m.group(1)}={m.group(2)}")

    for o in objs:
        walk(o)
    return list(dict.fromkeys(found))


class CapturingSession(ClientSession):
    """ClientSession that remembers the raw CallToolResult before the SDK validates it."""

    last_raw: Any = None

    async def validate_tool_result(self, name: str, result: Any) -> None:  # mcp 2.x
        self.last_raw = result
        await super().validate_tool_result(name, result)  # type: ignore[misc]

    async def _validate_tool_result(self, name: str, result: Any) -> None:  # mcp 1.x
        self.last_raw = result
        await super()._validate_tool_result(name, result)  # type: ignore[misc]


class HttpObserver:
    """httpx event hook: records status codes and request-id style response headers."""

    def __init__(self) -> None:
        self.ids: list[str] = []
        self.statuses: list[int] = []
        self.bodies: list[str] = []

    async def on_response(self, response: Any) -> None:
        self.statuses.append(response.status_code)
        if response.status_code >= 400:  # keep the error body: gateways put requestId / reason there
            try:
                await response.aread()
                self.bodies.append(mask(" ".join(response.text.split())[:600]))
            except Exception:  # noqa: BLE001
                pass
        for k, v in response.headers.items():
            if REQUEST_ID_KEYS.match(k):
                self.ids.append(f"{k}={v}")

    def take_bodies(self) -> list[str]:
        b, self.bodies = self.bodies, []
        return b

    def take(self) -> tuple[list[str], list[int]]:
        ids, st = list(dict.fromkeys(self.ids)), self.statuses
        self.ids, self.statuses = [], []
        return ids, st


async def _open(stack: AsyncExitStack, opts: Options, obs: HttpObserver) -> CapturingSession:
    from mcp.shared._httpx_utils import create_mcp_http_client

    def factory(headers: dict[str, str] | None = None, timeout: Any = None, auth: Any = None) -> Any:
        client = create_mcp_http_client(headers={**(headers or {}), **opts.headers}, timeout=timeout,
                                        auth=auth or opts.auth)
        client.event_hooks = {"request": [], "response": [obs.on_response]}
        return client

    if opts.transport == "sse":
        from mcp.client.sse import sse_client
        streams = await stack.enter_async_context(
            sse_client(opts.url, headers=opts.headers, httpx_client_factory=factory, auth=opts.auth))
    else:
        try:
            from mcp.client.streamable_http import streamable_http_client  # mcp >= 1.24 / 2.x
        except ImportError:  # pragma: no cover - old 1.x
            streamable_http_client = None
        if streamable_http_client is not None and "http_client" in inspect.signature(streamable_http_client).parameters:
            client = await stack.enter_async_context(factory())
            streams = await stack.enter_async_context(streamable_http_client(opts.url, http_client=client))
        else:  # pragma: no cover
            from mcp.client.streamable_http import streamablehttp_client
            streams = await stack.enter_async_context(
                streamablehttp_client(opts.url, headers=opts.headers, httpx_client_factory=factory,
                                      auth=opts.auth))
    read, write = streams[0], streams[1]
    return await stack.enter_async_context(CapturingSession(read, write))


async def _list_all_tools(session: ClientSession) -> list[Any]:
    tools: list[Any] = []
    cursor: str | None = None
    takes_params = "params" in inspect.signature(session.list_tools).parameters
    for _ in range(1000):
        if cursor is None:
            res = await session.list_tools()
        elif takes_params:
            from mcp.types import PaginatedRequestParams
            res = await session.list_tools(params=PaginatedRequestParams(cursor=cursor))
        else:  # pragma: no cover - old 1.x
            res = await session.list_tools(cursor=cursor)
        tools.extend(res.tools)
        cursor = _attr(res, "next_cursor", "nextCursor")
        if not cursor:
            break
    return tools


def _exc_text(e: BaseException) -> str:
    if isinstance(e, BaseExceptionGroup):
        return "; ".join(_exc_text(x) for x in e.exceptions)
    msg = str(e) or type(e).__name__
    err = getattr(e, "error", None)  # MCPError / McpError carry ErrorData
    data = getattr(err, "data", None)
    if data is not None:
        msg += f" (data: {data})"
    return f"{type(e).__name__}: {msg}"


# --------------------------------------------------------------------------- main flow

async def run(opts: Options) -> Report:
    report = Report(url=opts.url, transport=opts.transport, sdk_version=sdk_version())
    obs = HttpObserver()
    try:
        await _run(opts, report, obs)
    except Exception as e:  # noqa: BLE001 - transport task-group crashes surface here (ExceptionGroup)
        ids, statuses = obs.take()
        msg = f"connection failed: {_exc_text(e)}" + (f" (HTTP {statuses})" if statuses else "")
        if obs.bodies:
            msg += f" | response: {' / '.join(obs.bodies)}"
        report.fatal = report.fatal or mask(msg)
        report.rows.append(Row("-", "connection", FAIL, None, report.fatal, {"request_ids": ids}))
    return report


async def _run(opts: Options, report: Report, obs: HttpObserver) -> None:
    async with AsyncExitStack() as stack:
        # 1. initialize
        t0 = time.perf_counter()
        try:
            session = await _open(stack, opts, obs)
            with anyio.fail_after(opts.init_timeout or opts.timeout):
                init = await session.initialize()
        except BaseException as e:  # noqa: BLE001 - report anything, incl. ExceptionGroup
            if isinstance(e, (KeyboardInterrupt, SystemExit)):
                raise
            ids, statuses = obs.take()
            body = obs.take_bodies()
            ids = list(dict.fromkeys(ids + find_request_ids(*body)))
            report.fatal = mask(f"initialize failed: {_exc_text(e)}" + (f" (HTTP {statuses})" if statuses else "")
                                + (f" | response: {' / '.join(body)}" if body else "")
                                + (f" [{', '.join(ids)}]" if ids else ""))
            report.rows.append(Row("-", "initialize", FAIL, _ms(t0), report.fatal, {"request_ids": ids}))
            return
        info = _dump(_attr(init, "server_info", "serverInfo"))
        report.server_info = info
        report.protocol_version = _attr(init, "protocol_version", "protocolVersion")
        report.capabilities = _dump(_attr(init, "capabilities"))
        report.rows.append(Row("-", "initialize", PASS, _ms(t0),
                               f"server={info.get('name') if info else '?'} {info.get('version', '') if info else ''}"
                               f" protocol={report.protocol_version}"))
        obs.take()

        # 2. tools/list (all pages)
        t0 = time.perf_counter()
        try:
            with anyio.fail_after(opts.timeout):
                tools = await _list_all_tools(session)
        except Exception as e:  # noqa: BLE001
            report.fatal = mask(f"tools/list failed: {_exc_text(e)}")
            report.rows.append(Row("-", "tools/list", FAIL, _ms(t0), report.fatal))
            return
        report.tools = [_dump(t) for t in tools]
        names = [t.name for t in tools]
        dupes = sorted({n for n in names if names.count(n) > 1})
        report.rows.append(Row("-", "tools/list", FAIL if dupes else PASS, _ms(t0),
                               f"{len(tools)} tools" + (f"; duplicate names: {dupes}" if dupes else "")))
        obs.take()

        selected = [t for t in report.tools if _selected(t["name"], opts)]
        report.filtered_out = [t["name"] for t in report.tools if not _selected(t["name"], opts)]

        # 3. static lint
        for tool in selected:
            findings = lint_tool(tool)
            errs = [f for f in findings if f.severity == "error"]
            warns = [f for f in findings if f.severity == "warn"]
            status = FAIL if errs or (warns and opts.strict_lint) else WARN if warns else PASS
            report.rows.append(Row(tool["name"], "lint", status, None, mask(lint_detail(tool, findings)),
                                   {"findings": [f.to_dict() for f in findings]}))

        # 4/5. calls
        listed = {t["name"] for t in report.tools}
        for tool_name in opts.cases:
            if tool_name not in listed and _selected(tool_name, opts):
                report.rows.append(Row(tool_name, "call", WARN, None,
                                       "The cases file has a case for this tool, but the server does not list it."))
        for tool_name in opts.tools:
            if tool_name not in listed:
                report.rows.append(Row(tool_name, "call", FAIL, None,
                                       f"The server does not list a tool named {js(tool_name)} (check the spelling)."))
        rate_limited = False
        for tool in selected:
            if opts.no_calls:
                report.rows.append(Row(tool["name"], "call", NOT_EXERCISED, None, "Not called (--no-calls)."))
                continue
            if opts.tools:
                cases, why = _single_tool_cases(tool, opts)
                if cases is None:
                    report.rows.append(Row(tool["name"], "call", NOT_EXERCISED, None, why))
                    continue
            else:
                cases = opts.cases.get(tool["name"])
                if not cases and opts.auto_cases:
                    auto, why = auto_case(tool, opts.auto_allow, opts.auto_deny)
                    if auto is None:
                        report.rows.append(Row(tool["name"], "call", NOT_EXERCISED, None, not_called_detail(why)))
                        continue
                    cases = [auto]
            if not cases:
                report.rows.append(Row(tool["name"], "call", NOT_EXERCISED, None, NO_CASE_DETAIL))
                continue
            for i, case in enumerate(cases):
                label = ("call[auto]" if case.expect == "any" else "call[args]" if case.name == "args" and opts.tool_args is not None
                         else f"call[{i}]" + (f" {case.name}" if case.name else ""))
                if rate_limited:
                    report.rows.append(Row(tool["name"], label, SKIPPED, None, "stopped after rate limiting"))
                    continue
                row = await _call(session, tool, case, label, opts, obs)
                report.rows.append(row)
                if row.data.get("null_fields"):
                    nf = row.data["null_fields"]
                    report.rows.append(Row(tool["name"], "null-sweep", FAIL, None, mask(
                        null_sweep_detail(nf, row.data.get("null_sweep_source") == "text")),
                        {"null_fields": nf, "null_sweep_source": row.data.get("null_sweep_source")}))
                if opts.stop_on_rate_limit and (RATE_LIMIT.search(row.detail) or 429 in row.data.get("http", [])):
                    rate_limited = True
                if opts.delay:
                    await anyio.sleep(opts.delay)


def _single_tool_cases(tool: dict[str, Any], opts: Options) -> tuple[list[Case] | None, str]:
    """Cases for a tool named with --tool: --args, else its cases-file cases, else generated args.

    A tool that looks like it has side effects is only called with --confirm-side-effects or a "y"
    at the interactive prompt; cases-file cases are always explicit, so they need no confirmation.
    """
    name = tool["name"]
    if opts.tool_args is not None:
        cases = [Case(tool=name, args=opts.tool_args, expect="success", name="args")]
    elif opts.cases.get(name):
        return opts.cases[name], ""
    else:
        try:
            cases = [Case(tool=name, args=minimal_args(tool.get("inputSchema") or {"type": "object"}),
                          expect="any", name="auto")]
        except AutoCaseError as e:
            return None, (f"Not called: could not build valid args ({e}). "
                          "Pass your own with --args '{...}'.")
    why = side_effect_reason(tool, opts.auto_deny)
    if why and not opts.confirm_side_effects and not (opts.confirm and opts.confirm(name, why, cases[0].args)):
        return None, (f"Not called: {why}, so it may change data. To call it anyway, run it on its own "
                      "and confirm (--confirm-side-effects).")
    return cases, ""


def _ms(t0: float) -> float:
    return round((time.perf_counter() - t0) * 1000, 1)


async def _call(session: CapturingSession, tool: dict[str, Any], case: Case, label: str,
                opts: Options, obs: HttpObserver) -> Row:
    name, schema = tool["name"], tool.get("outputSchema")
    session.last_raw = None
    data: dict[str, Any] = {"args": case.args, "expect": case.expect, "output_schema": schema}
    t0 = time.perf_counter()
    result, exc = None, None
    try:
        with anyio.fail_after(opts.timeout):
            result = await session.call_tool(name, case.args)
    except Exception as e:  # noqa: BLE001
        exc = e
    ms = _ms(t0)
    raw = result if result is not None else session.last_raw
    structured = _attr(raw, "structured_content", "structuredContent") if raw is not None else None
    is_error = bool(_attr(raw, "is_error", "isError", default=False)) if raw is not None else False
    http_ids, statuses = obs.take()
    bodies = obs.take_bodies()
    data["http"] = statuses
    if bodies:
        data["http_error_bodies"] = bodies
    if raw is not None:
        data["structured_content"] = structured
        data["is_error"] = is_error
        data["content_text"] = [getattr(c, "text", None) for c in (_attr(raw, "content") or [])][:3]
        data["meta"] = _dump(_attr(raw, "meta", "_meta"))
        data["result"] = result_view([_dump(c) for c in (_attr(raw, "content") or [])], structured, is_error)
    data["request_ids"] = list(dict.fromkeys(http_ids + find_request_ids(
        structured, data.get("meta"), data.get("content_text"), str(exc) if exc else None, *bodies)))

    # Independent validation (shows every failing path, not just the SDK's best match).
    paths: list[dict[str, str]] = []
    issues: list[dict[str, Any]] = []
    if schema and raw is not None and not is_error:
        paths = schema_errors(schema, structured) if structured is not None else []
        issues = schema_issues(schema, structured)
        data["schema_errors"] = paths
        data["issues"] = issues

    # Null sweep: report every null the schema disallows, whatever the SDK decided.
    if schema and raw is not None and not is_error:
        target, source = structured, "structuredContent"
        if target is None:
            import json as _json
            for t in data.get("content_text") or []:
                try:
                    parsed = _json.loads(t) if t else None
                except ValueError:
                    continue
                if isinstance(parsed, dict):
                    target, source = parsed, "text"
                    break
        if target is not None:
            nulls = null_sweep(schema, target)
            if nulls:
                data["null_fields"] = nulls
                data["null_sweep_source"] = source

    def row(status: str, detail: str) -> Row:
        if data["request_ids"]:
            detail += f" [{', '.join(data['request_ids'][:3])}]"
        return Row(name, label, status, ms, mask(detail), mask(data))

    auto_args = f"the auto-generated args {js(case.args, 200)}"
    unrealistic = "The made-up args may just be unrealistic; add a real case, or run this tool on its own with your own args."

    if exc is not None:
        text = _exc_text(exc)
        data["error"] = text
        if any(p in text for p in SDK_VALIDATION_PATTERNS):
            data["sdk_accepted"] = False
            if issues:
                return row(FAIL, mismatch_detail(issues))
            first = text.splitlines()[0].strip()
            return row(FAIL, f"{STRICT} The Python SDK rejected it: {first}")
        data["sdk_accepted"] = None
        if isinstance(exc, TimeoutError):
            return row(WARN if case.expect == "any" else FAIL, f"No response within {opts.timeout:g}s.")
        if case.expect == "any":
            return row(WARN, f"The call failed for {auto_args}: {text[:300]}. {unrealistic}")
        if case.expect == "error":
            return row(PASS, f"The call failed, as this case expects: {text}")
        return row(FAIL, f"The call failed: {text}" + (f" (HTTP {statuses})" if any(s >= 400 for s in statuses) else "")
                   + (f" | response: {bodies[0][:300]}" if bodies else ""))

    data["sdk_accepted"] = True
    if is_error:
        msg = "; ".join(t for t in data["content_text"] if t)
        err_txt = (f' Error text: "{msg[:300]}".' if msg
                   else " The error result has no text in content, so clients can't show what went wrong.")
        if case.expect == "error":
            return row(PASS, "The tool reported an error, as this case expects." + err_txt)
        if case.expect == "any":
            return row(WARN, f"The tool reported an error for {auto_args}.{err_txt} {unrealistic}")
        return row(FAIL, "The tool reported an error (isError: true)." + err_txt
                   + " Fix: check the args (or, in a cases file, set expect: error if this case is meant to fail).")
    if case.expect == "error":
        return row(FAIL, "This case expects an error, but the call succeeded. "
                         "Fix: check the args, or change the case to expect: success.")
    if issues:  # SDK accepted but a full JSON Schema check disagrees
        return row(WARN, "The Python SDK accepted this response, but a full JSON Schema check disagrees. "
                   + mismatch_detail(issues))
    if data.get("null_fields"):
        return row(WARN, "Validation passed, but the null check found null fields the output schema does not "
                         "allow (see the null-sweep row).")
    suffix = f" (auto-generated args: {js(case.args, 200)})" if case.expect == "any" else ""
    if not schema:
        return row(PASS, f"OK: the call succeeded. The tool has no output schema, so there is nothing to validate.{suffix}")
    return row(PASS, f"OK: structuredContent matches the output schema.{suffix}")

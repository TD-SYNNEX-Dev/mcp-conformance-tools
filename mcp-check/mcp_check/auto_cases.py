"""--auto-cases: build a minimal argument set from a tool's inputSchema.

Opt-in only. The target is read-only lookups that nobody wrote a case for yet, so a newly added
tool is at least *called once* and its result validated against its outputSchema.

Safety rules, in order (the first that applies wins):
  1. deny-list: a tool whose name suggests side effects (contains any DEFAULT_DENY word, or matches
     an --auto-deny pattern) is never auto-called. Substring match on the lower-cased name, deliberately over-broad:
     `order_search` and `postal_lookup` are skipped too. Write an explicit case, or run the
     tool on its own (--tool NAME --confirm-side-effects), to call those.
  2. annotations: destructiveHint=true or readOnlyHint=false (explicitly) => never auto-called.
  3. allowlist: if --auto-allow is given, only names matching one of its globs are auto-called.
  4. the generated args must validate against the inputSchema, otherwise the tool is not called.

The same rules (and word list) are mirrored in the Inspector fork's conformanceRules.ts.
"""

from __future__ import annotations

from fnmatch import fnmatch
from typing import Any

from jsonschema.validators import validator_for

from mcp_check.cases import Case
from mcp_check.lint import _DEFAULT_META

DEFAULT_DENY = ("submit", "create", "update", "delete", "place", "order", "send", "cancel", "write", "post")

_FORMATS = {
    "date": "2026-01-01",
    "date-time": "2026-01-01T00:00:00Z",
    "time": "00:00:00Z",
    "email": "test@example.com",
    "uri": "https://example.com",
    "url": "https://example.com",
    "uuid": "00000000-0000-4000-8000-000000000000",
}


class AutoCaseError(ValueError):
    pass


def denied(name: str, extra: list[str] | tuple[str, ...] = ()) -> str | None:
    """The deny word / glob that blocks this tool, or None."""
    low = name.lower()
    for word in DEFAULT_DENY:
        if word in low:
            return word
    for pat in extra:
        if fnmatch(low, pat.lower()) or (not any(c in pat for c in "*?[") and pat.lower() in low):
            return pat
    return None


def side_effect_reason(tool: dict[str, Any], deny: list[str] | tuple[str, ...] = ()) -> str | None:
    """Why this tool looks like it changes something (so it is never called without asking), or None."""
    hit = denied(tool["name"], deny)
    if hit:
        return f"its name suggests side effects (contains '{hit}')"
    ann = tool.get("annotations") or {}
    if ann.get("destructiveHint") is True:
        return "the server marks it destructive (destructiveHint: true)"
    if ann.get("readOnlyHint") is False:
        return "the server marks it as not read-only (readOnlyHint: false)"
    return None


def eligibility(tool: dict[str, Any], allow: list[str] | tuple[str, ...] = (),
                deny: list[str] | tuple[str, ...] = ()) -> str | None:
    """None if the tool may be auto-called, else the plain-language reason it may not."""
    why = side_effect_reason(tool, deny)
    if why:
        return why
    if allow and not any(fnmatch(tool["name"], p) for p in allow):
        return "it is not in the auto-allow list"
    return None


def not_called_detail(reason: str) -> str:
    """NOT EXERCISED detail for a tool auto-cases skipped (same text as the Conformance tab)."""
    return (f"Not called: there is no case for it, and auto-cases skips it because {reason}. "
            "Add a case, or run this tool on its own.")


NO_CASE_DETAIL = "Not called: there is no case for it. Turn on auto-cases, or run this tool on its own."


def _resolve(schema: Any, root: Any, depth: int = 0) -> Any:
    while isinstance(schema, dict) and isinstance(schema.get("$ref"), str) and depth < 20:
        ref = schema["$ref"]
        if not ref.startswith("#"):
            raise AutoCaseError(f"remote $ref {ref!r} not supported")
        node = root
        for part in [p for p in ref[1:].split("/") if p]:
            part = part.replace("~1", "/").replace("~0", "~")
            if not isinstance(node, dict) or part not in node:
                raise AutoCaseError(f"unresolvable $ref {ref!r}")
            node = node[part]
        schema, depth = node, depth + 1
    return schema


def _value(schema: Any, root: Any, depth: int = 0) -> Any:
    if depth > 12:
        raise AutoCaseError("schema nests too deeply")
    schema = _resolve(schema, root)
    if schema is True or schema == {} or schema is None:
        return None
    if not isinstance(schema, dict):
        raise AutoCaseError("unsupported schema")
    if "const" in schema:
        return schema["const"]
    if "default" in schema:
        return schema["default"]
    if isinstance(schema.get("enum"), list) and schema["enum"]:
        return schema["enum"][0]
    if isinstance(schema.get("examples"), list) and schema["examples"]:
        return schema["examples"][0]
    for key in ("anyOf", "oneOf"):
        opts = schema.get(key)
        if isinstance(opts, list) and opts:
            non_null = [o for o in opts if not (isinstance(o, dict) and o.get("type") == "null")]
            return _value((non_null or opts)[0], root, depth + 1)
    if isinstance(schema.get("allOf"), list) and schema["allOf"]:
        merged: dict[str, Any] = {k: v for k, v in schema.items() if k != "allOf"}
        for part in schema["allOf"]:
            part = _resolve(part, root)
            if isinstance(part, dict):
                for k, v in part.items():
                    if k == "properties":
                        merged.setdefault("properties", {}).update(v)
                    elif k == "required":
                        merged["required"] = list(dict.fromkeys([*merged.get("required", []), *v]))
                    else:
                        merged.setdefault(k, v)
        return _value(merged, root, depth + 1)
    t = schema.get("type")
    if isinstance(t, list):
        t = next((x for x in t if x != "null"), "null")
    if t is None:
        t = "object" if "properties" in schema else None
    if t == "object":
        props = schema.get("properties") or {}
        out = {}
        for name in schema.get("required") or []:
            out[name] = _value(props.get(name, {}), root, depth + 1) if name in props else "test"
        return out
    if t == "array":
        n = int(schema.get("minItems") or 0)
        return [_value(schema.get("items", {}), root, depth + 1) for _ in range(n)]
    if t == "string":
        if schema.get("format") in _FORMATS:
            return _FORMATS[schema["format"]]
        n = int(schema.get("minLength") or 0)
        s = "test"
        return (s * (n // len(s) + 1))[:max(n, len(s))][: schema.get("maxLength", 10**6)]
    if t in ("integer", "number"):
        lo = schema.get("minimum")
        if lo is None and schema.get("exclusiveMinimum") is not None:
            lo = schema["exclusiveMinimum"] + 1
        v = lo if lo is not None else 1
        hi = schema.get("maximum")
        if hi is not None and v > hi:
            v = hi
        return int(v) if t == "integer" else v
    if t == "boolean":
        return False
    if t == "null":
        return None
    return None


def minimal_args(input_schema: Any) -> dict[str, Any]:
    """Required properties only, filled with the smallest plausible value. Raises AutoCaseError."""
    if not isinstance(input_schema, dict):
        raise AutoCaseError("inputSchema is not an object")
    args = _value(input_schema, input_schema)
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise AutoCaseError("inputSchema does not describe an object")
    cls = validator_for(input_schema, default=validator_for({"$schema": _DEFAULT_META}))
    err = next(iter(cls(input_schema).iter_errors(args)), None)
    if err is not None:
        where = "/" + "/".join(str(p) for p in err.absolute_path) if err.absolute_path else "/"
        raise AutoCaseError(f"the generated args do not validate at {where}: {err.message}")
    return args


def auto_case(tool: dict[str, Any], allow: list[str] | tuple[str, ...] = (),
              deny: list[str] | tuple[str, ...] = ()) -> tuple[Case | None, str]:
    """(Case, "") if the tool may be auto-called, else (None, reason)."""
    reason = eligibility(tool, allow, deny)
    if reason:
        return None, reason
    try:
        args = minimal_args(tool.get("inputSchema") or {"type": "object"})
    except AutoCaseError as e:
        return None, f"it could not build valid args ({e})"
    return Case(tool=tool["name"], args=args, expect="any", name="auto"), ""

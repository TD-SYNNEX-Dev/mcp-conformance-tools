"""Plain-language explanations for schema problems found in a tool result.

Every message says what the schema expected, what came back, where (JSON path), and how to fix it.
The Inspector fork's Conformance tab (conformanceRules.ts) produces the same text, word for word,
so the CLI and the UI read the same.

An "issue" is a small dict: {"kind": ..., "path": ...} plus kind-specific keys:
  null      expected (list of type names), nullable (schema has OpenAPI `nullable: true`)
  type      expected, actual (the value)
  required  name
  extra     name                          (additionalProperties: false)
  enum      allowed, actual
  const     allowed, actual
  missing_structured                      (outputSchema declared, no structuredContent)
  other     keyword, message              (validator's own wording; differs per validator)
"""

from __future__ import annotations

import ast
import json
import re
from typing import Any

from jsonschema.validators import validator_for

STRICT = "Strict clients (like the Python SDK) will reject this response."
MIXED = "Some clients (e.g. the TypeScript SDK) accept this, others (e.g. the Python SDK) reject it."
NULLABLE_IGNORED = "Its `nullable: true` does not help: that is an OpenAPI keyword, and JSON Schema ignores it."
MISSING_SC = "The tool declares an output schema, but the response has no structuredContent."
MISSING_SC_FIX = ("Fix: return the result in structuredContent as a JSON object that matches the output schema "
                  "(you can keep a text copy in content).")
MAX_ISSUES = 5

_DEFAULT_META = "https://json-schema.org/draft/2020-12/schema"
_ARTICLE = {"string": "a string", "integer": "an integer", "number": "a number", "boolean": "a boolean",
            "object": "an object", "array": "an array", "null": "null"}


def js(v: Any, limit: int = 60) -> str:
    """Compact JSON, the same way JSON.stringify prints it."""
    s = json.dumps(v, ensure_ascii=False, separators=(",", ":"), default=str)
    return s if len(s) <= limit else s[: limit - 1] + "…"


def json_kind(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int) or (isinstance(v, float) and v.is_integer()):
        return "integer"
    if isinstance(v, float):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    return "object"


def types_phrase(types: list[str]) -> str:
    return " or ".join(_ARTICLE.get(t, f'"{t}"') for t in types) or "a value"


def type_list_json(types: list[str]) -> str:
    """["string", "null"] - with a space after the comma, as people write it."""
    return "[" + ", ".join(f'"{t}"' for t in types) + "]"


def value_phrase(v: Any) -> str:
    k = json_kind(v)
    if k in ("null",):
        return "null"
    if k in ("array", "object"):
        return _ARTICLE[k]
    return f"{_ARTICLE[k]} ({js(v)})"


def field(path: str) -> str:
    return "The structuredContent" if path in ("", "/") else f"Field {path}"


def describe(issue: dict[str, Any]) -> tuple[str, str]:
    """(problem sentence, "Fix: ..." sentence)."""
    k, path, f = issue["kind"], issue["path"], field(issue["path"])
    if k == "missing_structured":
        return MISSING_SC, MISSING_SC_FIX
    if k == "null":
        exp = issue["expected"]
        p = f"{f} is null, but the output schema says it must be {types_phrase(exp)}."
        if issue.get("nullable"):
            p += " " + NULLABLE_IGNORED
        return p, f'Fix: return {types_phrase(exp)}, or allow null with "type": {type_list_json([*exp, "null"])}.'
    if k == "type":
        exp, actual = issue["expected"], issue["actual"]
        return (f"{f} is {value_phrase(actual)}, but the output schema says it must be {types_phrase(exp)}.",
                f'Fix: return {types_phrase(exp)}, or change the schema to "type": "{json_kind(actual)}".')
    if k == "required":
        return (f"Required field {path} is missing.",
                f'Fix: always include "{issue["name"]}", or remove it from "required" in the output schema.')
    if k == "extra":
        return (f'Field {path} is not in the output schema, which does not allow extra fields '
                f'("additionalProperties": false).',
                f'Fix: stop sending "{issue["name"]}", or add it to "properties" in the output schema.')
    if k == "enum":
        allowed = ", ".join(js(a) for a in issue["allowed"][:10])
        return (f"{f} is {js(issue['actual'])}, which is not one of the allowed values ({allowed}).",
                f"Fix: return one of the allowed values, or add {js(issue['actual'])} to the enum in the output schema.")
    if k == "const":
        return (f"{f} is {js(issue['actual'])}, but the output schema requires exactly {js(issue['allowed'])}.",
                "Fix: return that exact value, or change the schema.")
    return (f"{f} does not match the output schema ({issue.get('keyword')}: {issue.get('message')}).",
            "Fix: change the response or the output schema so they agree.")


def client_sentence(issues: list[dict[str, Any]]) -> str:
    """Only the ignored-`nullable` case splits clients; everything else is rejected by strict clients."""
    if issues and all(i["kind"] == "null" and i.get("nullable") for i in issues):
        return MIXED
    return STRICT


def mismatch_detail(issues: list[dict[str, Any]]) -> str:
    client = client_sentence(issues)
    if len(issues) == 1:
        p, fix = describe(issues[0])
        return f"{p} {client} {fix}"
    parts = [f"({n}) {' '.join(describe(i))}" for n, i in enumerate(issues[:MAX_ISSUES], 1)]
    more = f" (+{len(issues) - MAX_ISSUES} more)" if len(issues) > MAX_ISSUES else ""
    return f"{len(issues)} problems with this response. {client} " + " ".join(parts) + more


def null_reason(sub: dict[str, Any]) -> str:
    """Short reason for the null check: 'must be a string' (+ ignored nullable note)."""
    t = sub.get("type")
    ts = t if isinstance(t, list) else [t] if isinstance(t, str) else []
    msg = f"must be {types_phrase(ts)}" if ts else "must not be null"
    if sub.get("nullable") is True:
        msg += "; its `nullable: true` is an OpenAPI keyword that JSON Schema ignores"
    return msg


def null_sweep_detail(nulls: list[dict[str, Any]], from_text: bool) -> str:
    n = len(nulls)
    src = " (checked the JSON in the text content, because there is no structuredContent)" if from_text else ""
    listed = "; ".join(f"{x['path']} ({x['message']})" for x in nulls[:8]) + (f"; +{n - 8} more" if n > 8 else "")
    return (f"Null check: {n} field{'s' if n != 1 else ''} {'are' if n != 1 else 'is'} null where the output "
            f"schema does not allow null{src}: {listed}. "
            'Fix: send a real value, or allow null in the schema (e.g. "type": ["string", "null"]).')


# --------------------------------------------------------------------------- jsonschema -> issues

def _esc(name: str) -> str:
    return str(name).replace("~", "~0").replace("/", "~1")


def _ptr(parts: Any) -> str:
    p = list(parts)
    return "/" + "/".join(_esc(str(x)) for x in p) if p else "/"


def _join(base: str, name: str) -> str:
    return (base.rstrip("/") if base != "/" else "") + "/" + _esc(name)


def _types(v: Any) -> list[str]:
    return [str(x) for x in v] if isinstance(v, list) else [str(v)]


def schema_issues(schema: dict[str, Any], instance: Any) -> list[dict[str, Any]]:
    """Every problem in `instance` against `schema` (JSON Schema 2020-12 unless $schema says otherwise)."""
    if instance is None:
        return [{"kind": "missing_structured", "path": "/"}]
    cls = validator_for(schema, default=validator_for({"$schema": _DEFAULT_META}))
    out: list[dict[str, Any]] = []
    for e in cls(schema).iter_errors(instance):
        path = _ptr(e.absolute_path)
        sub = e.schema if isinstance(e.schema, dict) else {}
        v = e.validator
        if v == "type":
            exp = _types(e.validator_value)
            if e.instance is None:
                out.append({"kind": "null", "path": path, "expected": exp, "nullable": sub.get("nullable") is True})
            else:
                out.append({"kind": "type", "path": path, "expected": exp, "actual": e.instance})
        elif v == "required":
            m = re.match(r"^(.+?) is a required property$", e.message)
            try:
                name = ast.literal_eval(m.group(1)) if m else None
            except (ValueError, SyntaxError):
                name = None
            if name is None:
                out.append({"kind": "other", "path": path, "keyword": v, "message": e.message})
            else:
                out.append({"kind": "required", "path": _join(path, str(name)), "name": str(name)})
        elif v == "additionalProperties" and e.validator_value is False and isinstance(e.instance, dict):
            props = sub.get("properties") or {}
            pats = list((sub.get("patternProperties") or {}).keys())
            for k in e.instance:
                if k not in props and not any(re.search(p, k) for p in pats):
                    out.append({"kind": "extra", "path": _join(path, k), "name": k})
        elif v == "enum":
            out.append({"kind": "enum", "path": path, "allowed": list(e.validator_value), "actual": e.instance})
        elif v == "const":
            out.append({"kind": "const", "path": path, "allowed": e.validator_value, "actual": e.instance})
        else:
            out.append({"kind": "other", "path": path, "keyword": v, "message": e.message})
    seen: set[str] = set()
    uniq = []
    for i in sorted(out, key=lambda i: (i["path"], i["kind"])):
        key = f"{i['path']}|{i['kind']}"
        if key not in seen:
            seen.add(key)
            uniq.append(i)
    return uniq

"""Static lint of a tool's inputSchema / outputSchema.

Severities:
  error - the schema is not valid JSON Schema, or breaks an MCP rule (root must be "type": "object")
  warn  - OpenAPI-only keywords that JSON Schema validators silently ignore (e.g. `nullable`),
          tool names with characters some clients reject, and (input schema only) string fields
          whose description lists allowed values or a date format the schema itself does not state
  info  - required properties whose type does not allow null; if the server ever sends null
          for one of these, a strict client (like the Python SDK) rejects the whole result

Messages are plain sentences ending in "Fix: ..."; conformanceRules.ts uses the same wording.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from typing import Any, Iterator

from jsonschema import SchemaError
from jsonschema.validators import validator_for

from mcp_check.explain import js, type_list_json
from mcp_check.hints import date_format_hint, datetime_hint, enum_hint

# Keywords that exist in OpenAPI 3.0 Schema Objects but not in JSON Schema 2020-12 -> the fix.
OPENAPI_ONLY = {
    "nullable": 'Fix: use "type": [<type>, "null"] instead.',
    "discriminator": "Fix: remove it (it has no effect for MCP clients).",
    "xml": "Fix: remove it (it has no effect for MCP clients).",
    "externalDocs": "Fix: remove it (it has no effect for MCP clients).",
    "example": 'Fix: rename it to "examples" (a list).',
}

# MCP tool names: 1-128 chars of A-Z a-z 0-9 _ - .
TOOL_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")

# Sub-schema locations to descend into.
_MAP_KEYS = ("properties", "patternProperties", "$defs", "definitions", "dependentSchemas")
_LIST_KEYS = ("allOf", "anyOf", "oneOf", "prefixItems")
_ONE_KEYS = ("items", "additionalProperties", "not", "if", "then", "else", "contains",
             "propertyNames", "unevaluatedProperties", "unevaluatedItems", "additionalItems")

# MCP spec: schemas without $schema are JSON Schema 2020-12.
_DEFAULT_META = "https://json-schema.org/draft/2020-12/schema"


@dataclass
class Finding:
    schema: str  # "inputSchema" | "outputSchema" | "name"
    severity: str  # error | warn | info
    path: str  # JSON pointer into the schema
    message: str

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


def _walk(node: Any, path: str) -> Iterator[tuple[str, dict[str, Any]]]:
    if not isinstance(node, dict):
        return
    yield path, node
    for key in _MAP_KEYS:
        sub = node.get(key)
        if isinstance(sub, dict):
            for name, child in sub.items():
                yield from _walk(child, f"{path}/{key}/{_esc(name)}")
    for key in _LIST_KEYS:
        sub = node.get(key)
        if isinstance(sub, list):
            for i, child in enumerate(sub):
                yield from _walk(child, f"{path}/{key}/{i}")
    for key in _ONE_KEYS:
        sub = node.get(key)
        if isinstance(sub, dict):
            yield from _walk(sub, f"{path}/{key}")
        elif key == "items" and isinstance(sub, list):  # draft-04..2019 tuple form
            for i, child in enumerate(sub):
                yield from _walk(child, f"{path}/{key}/{i}")


def _esc(name: str) -> str:
    return str(name).replace("~", "~0").replace("/", "~1")


def allows_null(schema: Any) -> bool:
    """True if a JSON Schema validator would accept null for this (sub)schema, approximately."""
    if schema is True or schema == {}:
        return True
    if not isinstance(schema, dict):
        return False
    if "const" in schema:
        return schema["const"] is None
    if "enum" in schema:
        return None in schema["enum"]
    for key in ("anyOf", "oneOf"):
        if isinstance(schema.get(key), list) and any(allows_null(s) for s in schema[key]):
            return True
    if isinstance(schema.get("allOf"), list) and schema["allOf"]:
        if not all(allows_null(s) for s in schema["allOf"]):
            return False
    t = schema.get("type")
    if t is None:
        return "$ref" not in schema  # untyped => anything goes; $ref => unknown, assume strict
    if isinstance(t, list):
        return "null" in t
    return t == "null"


def _label(kind: str) -> str:
    return "output schema" if kind == "outputSchema" else "input schema"


def openapi_message(kw: str, val: Any, node: dict[str, Any]) -> str:
    if kw == "nullable" and val is True:
        rest = {k: v for k, v in node.items() if k != "nullable"}
        if allows_null(rest):
            return ("Uses `nullable: true`, an OpenAPI keyword that JSON Schema ignores. Null is already "
                    "allowed here, so it is harmless. Fix: remove it.")
        t = node.get("type")
        ts = t if isinstance(t, list) else [t] if isinstance(t, str) else []
        fix = (f'Fix: use "type": {type_list_json([*ts, "null"])} instead.' if ts
               else 'Fix: use anyOf with {"type": "null"} instead.')
        return ("Uses `nullable: true`. That is an OpenAPI keyword, and JSON Schema ignores it, so this field "
                f"still rejects null (its type is {js(t)}). Some clients (e.g. the TypeScript SDK) accept null "
                f"here, others (e.g. the Python SDK) reject it. {fix}")
    if kw == "nullable":
        return f"Uses `nullable: {js(val)}`, an OpenAPI keyword that JSON Schema ignores. Fix: remove it."
    if kw == "example":
        return f'Uses `example`, an OpenAPI keyword. JSON Schema uses "examples" (a list). {OPENAPI_ONLY[kw]}'
    return f"Uses `{kw}`, an OpenAPI keyword that JSON Schema ignores. {OPENAPI_ONLY[kw]}"


def lint_schema(kind: str, schema: Any) -> list[Finding]:
    out: list[Finding] = []
    if schema is None:
        return out
    if not isinstance(schema, dict):
        return [Finding(kind, "error", "", f"The {_label(kind)} must be a JSON object, but it is {type(schema).__name__}.")]

    cls = validator_for(schema, default=validator_for({"$schema": _DEFAULT_META}))
    try:
        cls.check_schema(schema)
    except SchemaError as e:
        ptr = "/" + "/".join(_esc(p) for p in e.absolute_path) if e.absolute_path else ""
        out.append(Finding(kind, "error", ptr, f"Not valid JSON Schema ({e.message}), so clients can't validate "
                                               "against it. Fix: correct the schema."))

    if schema.get("type") not in (None, "object"):
        if kind == "outputSchema":
            out.append(Finding(kind, "error", "/type",
                               'The output schema\'s root must be "type": "object" (MCP requires it, because '
                               "structuredContent is always a JSON object). Fix: wrap the value in an object, e.g. "
                               '{"type": "object", "properties": {"items": ...}}.'))
        else:
            out.append(Finding(kind, "error", "/type",
                               'The input schema\'s root must be "type": "object" (MCP requires it). Some clients '
                               "(e.g. the TypeScript SDK) refuse to load a tool list that breaks this. "
                               'Fix: set "type": "object".'))

    for path, node in _walk(schema, ""):
        for kw in OPENAPI_ONLY:
            if kw in node and not (kw == "xml" and path.endswith("/properties")):
                out.append(Finding(kind, "warn", f"{path}/{kw}", openapi_message(kw, node[kw], node)))
        if kind == "inputSchema":
            out += _hint_findings(kind, path, node)
        req = node.get("required")
        props = node.get("properties")
        if isinstance(req, list) and isinstance(props, dict):
            for name in req:
                sub = props.get(name)
                if sub is not None and not allows_null(sub):
                    t = sub.get("type") if isinstance(sub, dict) else sub
                    out.append(Finding(kind, "info", f"{path}/properties/{_esc(name)}",
                                       f'Required field "{name}" can\'t be null (type {js(t)}).'))
    return out


def _is_string(node: dict[str, Any]) -> bool:
    t = node.get("type")
    return t == "string" or (isinstance(t, list) and "string" in t)


def _hint_findings(kind: str, path: str, node: dict[str, Any]) -> list[Finding]:
    """Description-only constraints: allowed values or a date format the schema doesn't state."""
    desc = node.get("description")
    if not isinstance(desc, str) or not _is_string(node) or "enum" in node or "const" in node:
        return []
    vals = enum_hint(desc)
    if vals:
        listed = ", ".join(json.dumps(v) for v in vals)
        return [Finding(kind, "warn", f"{path}/description",
                        f'The description lists allowed values ({listed}), but the schema has no "enum", so '
                        f'clients and test tools can\'t see them. Fix: add "enum": [{listed}].')]
    if "format" in node or "pattern" in node:
        return []
    dh = date_format_hint(desc)
    if dh:
        what, fmt = dh[0], f" ({dh[1]}{dh[2]})"
    elif datetime_hint(desc):
        what, fmt = "date-time", ""
    else:
        return []
    return [Finding(kind, "warn", f"{path}/description",
                    f'The description asks for a {what}{fmt}, but the schema has no "format" or "pattern", so '
                    f'clients and test tools can\'t see it. Fix: add "format": "{what}" (or a "pattern").')]


def lint_tool(tool: dict[str, Any]) -> list[Finding]:
    """`tool` is the wire-format dict (camelCase keys) from tools/list."""
    findings = []
    name = str(tool.get("name", ""))
    if not TOOL_NAME.match(name):
        findings.append(Finding("name", "warn", "", f"Tool name {js(name)} breaks the MCP naming rule (1-128 "
                                'characters, only A-Z, a-z, 0-9, "_", "-" and "."). Some clients reject or rename '
                                "such tools. Fix: rename the tool."))
    if "inputSchema" not in tool:
        findings.append(Finding("inputSchema", "error", "", 'The tool has no input schema (MCP requires one). '
                                'Fix: add "inputSchema": {"type": "object"}.'))
    else:
        findings += lint_schema("inputSchema", tool.get("inputSchema"))
    findings += lint_schema("outputSchema", tool.get("outputSchema"))
    return findings


def lint_detail(tool: dict[str, Any], findings: list[Finding]) -> str:
    """The lint row's detail text (same layout as the Conformance tab)."""
    bits = []
    for f in [f for f in findings if f.severity == "error"] + [f for f in findings if f.severity == "warn"]:
        where = f.path.rsplit("/", 1)[0] if f.severity == "warn" and f.schema != "name" else f.path
        if f.schema == "name":
            bits.append(f.message)
        else:
            bits.append(f"{f.schema} at {where or '/'}: {f.message}")
    req = [f.path.rsplit("/", 1)[-1].replace("~1", "/").replace("~0", "~")
           for f in findings if f.severity == "info" and f.schema == "outputSchema"]
    if req:
        bits.append(f"Required output fields that can't be null: {', '.join(req)}.")
    if not tool.get("outputSchema"):
        bits.append("No output schema, so clients can't validate this tool's results.")
    return " | ".join(bits) or "OK: the schemas are valid."

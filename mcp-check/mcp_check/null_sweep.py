"""Null sweep: every field that came back null where the outputSchema does not allow null.

This is the common "`message: null` against `type: string`" bug. A validator stops at (or
best-matches) one error and a lenient client may not validate at all; the sweep walks the whole
result and lists every such field, and calls out an ignored OpenAPI `nullable: true` next to it. Mirrored in the Inspector
fork (conformanceRules.ts: nullSweep).
"""

from __future__ import annotations

from typing import Any

from mcp_check.explain import null_reason
from mcp_check.lint import _esc, allows_null

_UNKNOWN = object()


def _resolve(schema: Any, root: Any) -> Any:
    seen = 0
    while isinstance(schema, dict) and isinstance(schema.get("$ref"), str):
        ref = schema["$ref"]
        seen += 1
        if not ref.startswith("#") or seen > 20:
            return _UNKNOWN
        node = root
        for part in [p for p in ref[1:].split("/") if p]:
            part = part.replace("~1", "/").replace("~0", "~")
            if not isinstance(node, dict) or part not in node:
                return _UNKNOWN
            node = node[part]
        schema = node
    return schema


def _type_of(v: Any) -> str:
    if isinstance(v, dict):
        return "object"
    if isinstance(v, list):
        return "array"
    return "other"


def _branch_for(schema: dict[str, Any], inst: Any, root: Any) -> list[Any]:
    """Sub-schemas that also constrain `inst`: allOf all, anyOf/oneOf the first matching container type."""
    out = list(schema.get("allOf") or [])
    for key in ("anyOf", "oneOf"):
        for opt in schema.get(key) or []:
            r = _resolve(opt, root)
            if not isinstance(r, dict):
                continue
            t = r.get("type")
            ts = t if isinstance(t, list) else [t] if t else []
            if _type_of(inst) in ts or (not ts and ("properties" in r or "items" in r)):
                out.append(r)
                break
    return out


def null_sweep(schema: Any, instance: Any) -> list[dict[str, str]]:
    found: list[dict[str, str]] = []

    def walk(sub: Any, inst: Any, ptr: str, sptr: str, depth: int) -> None:
        if depth > 40:
            return
        sub = _resolve(sub, schema)
        if sub is _UNKNOWN or not isinstance(sub, dict):
            return
        if inst is None:
            if not allows_null(sub):
                found.append({"path": ptr or "/", "schema_path": sptr or "/", "message": null_reason(sub)})
            return
        for i, extra in enumerate(_branch_for(sub, inst, schema)):
            walk(extra, inst, ptr, f"{sptr}/branch{i}", depth + 1)
        if isinstance(inst, dict):
            props = sub.get("properties") if isinstance(sub.get("properties"), dict) else {}
            addl = sub.get("additionalProperties")
            for k, v in inst.items():
                if k in props:
                    walk(props[k], v, f"{ptr}/{_esc(k)}", f"{sptr}/properties/{_esc(k)}", depth + 1)
                elif isinstance(addl, dict):
                    walk(addl, v, f"{ptr}/{_esc(k)}", f"{sptr}/additionalProperties", depth + 1)
        elif isinstance(inst, list):
            prefix = sub.get("prefixItems") if isinstance(sub.get("prefixItems"), list) else []
            items = sub.get("items")
            for i, v in enumerate(inst[:500]):
                if i < len(prefix):
                    walk(prefix[i], v, f"{ptr}/{i}", f"{sptr}/prefixItems/{i}", depth + 1)
                elif isinstance(items, dict):
                    walk(items, v, f"{ptr}/{i}", f"{sptr}/items", depth + 1)

    walk(schema, instance, "", "", 0)
    # dedupe (allOf branches can revisit the same field)
    uniq: dict[str, dict[str, str]] = {}
    for f in found:
        uniq.setdefault(f["path"], f)
    return list(uniq.values())

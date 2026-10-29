"""Row detail for failing calls (--show-response): the args sent, the raw result and the output schema,
pretty-printed, with the lines under each problem path marked ">>".

Mirrors the Inspector fork's Conformance tab (conformanceDetail.ts), which highlights the same lines
when you open a row.
"""

from __future__ import annotations

import json
import re
from typing import Any

MARK = ">> "
PAD = "   "


def _esc(name: str) -> str:
    return str(name).replace("~", "~0").replace("/", "~1")


def split_pointer(pointer: str) -> list[str]:
    if pointer in ("", "/"):
        return []
    return [p.replace("~1", "/").replace("~0", "~") for p in pointer.split("/")[1:]]


def json_lines(value: Any) -> list[tuple[str, str, str]]:
    """json.dumps(value, indent=2) as (text, pointer, kind) lines; kind is open | close | leaf."""
    out: list[tuple[str, str, str]] = []

    def dump(v: Any) -> str:
        return json.dumps(v, ensure_ascii=False, default=str)

    def visit(v: Any, ptr: str, indent: str, prefix: str, comma: str) -> None:
        if isinstance(v, list):
            entries = [(str(i), "", x) for i, x in enumerate(v)]
            open_, close = "[", "]"
        elif isinstance(v, dict):
            entries = [(_esc(k), f"{dump(str(k))}: ", x) for k, x in v.items()]
            open_, close = "{", "}"
        else:
            out.append((indent + prefix + dump(v) + comma, ptr, "leaf"))
            return
        if not entries:
            out.append((indent + prefix + open_ + close + comma, ptr, "leaf"))
            return
        out.append((indent + prefix + open_, ptr, "open"))
        for i, (seg, key_text, x) in enumerate(entries):
            visit(x, f"{ptr}/{seg}", indent + "  ", key_text, "," if i < len(entries) - 1 else "")
        out.append((indent + close + comma, ptr, "close"))

    visit(value, "", "", "", "")
    return out


def line_matches(line: tuple[str, str, str], target: str, mode: str = "subtree") -> bool:
    _, ptr, kind = line
    if mode == "open":
        return ptr == target and kind != "close"
    return ptr == target or ptr.startswith(target + "/")


def _resolve(node: Any, root: Any) -> tuple[Any, str | None]:
    if isinstance(node, dict) and isinstance(node.get("$ref"), str) and node["$ref"].startswith("#"):
        ptr = node["$ref"][1:]
        cur = root
        for part in split_pointer(ptr):
            if isinstance(cur, dict):
                cur = cur.get(part)
            elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
                cur = cur[int(part)]
            else:
                return node, None
        return cur, ptr
    return node, None


def _step(node: dict[str, Any], seg: str, root: Any) -> tuple[str, Any] | None:
    props = node.get("properties")
    if isinstance(props, dict) and seg in props:
        return f"/properties/{_esc(seg)}", props[seg]
    if re.fullmatch(r"\d+", seg):
        i = int(seg)
        prefix = node.get("prefixItems")
        if isinstance(prefix, list) and i < len(prefix):
            return f"/prefixItems/{i}", prefix[i]
        if isinstance(node.get("items"), dict):
            return "/items", node["items"]
    for key in ("allOf", "anyOf", "oneOf"):
        branches = node.get(key)
        if not isinstance(branches, list):
            continue
        for i, b in enumerate(branches):
            branch, ref = _resolve(b, root)
            if not isinstance(branch, dict):
                continue
            step = _step(branch, seg, root)
            if step:
                return (ref if ref is not None else f"/{key}/{i}") + step[0], step[1]
    if isinstance(node.get("additionalProperties"), dict):
        return "/additionalProperties", node["additionalProperties"]
    return None


def schema_pointer(schema: Any, instance_path: str) -> str:
    """Best-effort pointer to the schema node describing instance_path (/message -> /properties/message)."""
    ptr, node = "", schema
    for seg in split_pointer(instance_path):
        node, ref = _resolve(node, schema)
        if ref is not None:
            ptr = ref
        if not isinstance(node, dict):
            return ptr
        step = _step(node, seg, schema)
        if not step:
            return ptr
        ptr += step[0]
        node = step[1]
    _, ref = _resolve(node, schema)
    return ref if ref is not None else ptr


def _parent(pointer: str) -> str:
    i = pointer.rfind("/")
    return "" if i <= 0 else pointer[:i]


def _under(base: str, path: str) -> str:
    return base if path in ("", "/") else base + path


_WHAT = {"null": "is null", "type": "has the wrong type", "enum": "is not an allowed value",
         "const": "is not the required value"}


def highlights_for(issues: list[dict[str, Any]], null_fields: list[dict[str, Any]], schema: Any,
                   null_source: str = "structuredContent") -> list[dict[str, Any]]:
    """What to mark: {result, result_mode, schema, note}; result pointers are into result_view()."""
    out: list[dict[str, Any]] = []
    seen: set[tuple[Any, Any, Any]] = set()

    def add(result: str | None, mode: str, sch: str | None, note: str) -> None:
        k = (result, mode, sch)
        if k not in seen:
            seen.add(k)
            out.append({"result": result, "result_mode": mode, "schema": sch, "note": note})

    for i in issues:
        k, path = i["kind"], i["path"]
        if k == "missing_structured":
            add(None, "subtree", None, "no structuredContent in the result")
        elif k == "required":
            add(_under("/structuredContent", _parent(path)), "open", schema_pointer(schema, path), f"{path} is missing")
        elif k == "extra":
            add(_under("/structuredContent", path), "subtree",
                _under(schema_pointer(schema, _parent(path)), "/additionalProperties"), f"{path} is not allowed")
        else:
            add(_under("/structuredContent", path), "subtree", schema_pointer(schema, path),
                f"{path} {_WHAT.get(k, 'does not match')}")
    for n in null_fields:
        add("/content" if null_source == "text" else _under("/structuredContent", n["path"]), "subtree",
            schema_pointer(schema, n["path"]), f"{n['path']} is null")
    return out


def result_view(content: Any, structured: Any, is_error: bool) -> dict[str, Any]:
    view: dict[str, Any] = {"content": content or []}
    if structured is not None:
        view["structuredContent"] = structured
    view["isError"] = bool(is_error)
    return view


def marked_json(value: Any, marks: list[tuple[str, str]], indent: str = "  ") -> str:
    lines = []
    for line in json_lines(value):
        hit = any(line_matches(line, p, m) for p, m in marks)
        lines.append(indent + (MARK if hit else PAD) + line[0])
    return "\n".join(lines)


def render(tool: str, check: str, status: str, data: dict[str, Any]) -> str:
    """Text block for one call row: problems, args, result and outputSchema with problem lines marked."""
    schema = data.get("output_schema")
    hs = highlights_for(data.get("issues") or [], data.get("null_fields") or [], schema,
                        data.get("null_sweep_source") or "structuredContent")
    parts = [f"--- {tool} {check} ({status})"]
    for h in hs:
        marked = " (marked >>)" if h["result"] is not None or h["schema"] is not None else ""
        parts.append(f"  problem: {h['note']}{marked}")
    parts.append("  Args sent:")
    parts.append(marked_json(data.get("args") or {}, [], "    "))
    parts.append("  Result:")
    if isinstance(data.get("result"), dict):
        parts.append(marked_json(data["result"], [(h["result"], h["result_mode"]) for h in hs if h["result"] is not None], "    "))
    else:
        parts.append(f"    No result: {data.get('error') or 'the call did not return'}")
    parts.append("  Structured schema (outputSchema):")
    parts.append(marked_json(schema, [(h["schema"], "subtree") for h in hs if h["schema"] is not None], "    "))
    return "\n".join(parts)

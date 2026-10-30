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
  5. every required value must be realistic: from const/default/enum/examples, a known format, a
     pattern, or a description/name hint (hints.py). A required string that would only get the
     "test" placeholder skips the tool ("can't build a realistic value for <field>"). Optional
     properties are always omitted. Values guessed from a description or name are listed in
     Case.guessed (and in the row's data as guessed_args).

The same rules (and word list) are mirrored in the Inspector fork's conformanceRules.ts.
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from fnmatch import fnmatch
from typing import Any

from jsonschema.validators import validator_for

from mcp_check.cases import Case
from mcp_check.hints import date_format_hint, datetime_hint, enum_hint, name_kind, range_key, render_date_format
from mcp_check.lint import _DEFAULT_META

DEFAULT_DENY = ("submit", "create", "update", "delete", "place", "order", "send", "cancel", "write", "post")

# Sample values per JSON Schema "format" ({today} is today's UTC date, YYYY-MM-DD).
_FORMATS = {
    "date": "{today}",
    "date-time": "{today}T00:00:00Z",
    "time": "00:00:00Z",
    "duration": "P1D",
    "email": "test@example.com",
    "idn-email": "test@example.com",
    "hostname": "example.com",
    "idn-hostname": "example.com",
    "ipv4": "192.0.2.1",
    "ipv6": "2001:db8::1",
    "uri": "https://example.com",
    "uri-reference": "https://example.com",
    "iri": "https://example.com",
    "iri-reference": "https://example.com",
    "uri-template": "https://example.com/{id}",
    "url": "https://example.com",
    "uuid": "00000000-0000-4000-8000-000000000000",
    "json-pointer": "/a",
    "relative-json-pointer": "0",
    "regex": ".*",
}
_DATE_KINDS = {"date": "date", "date-time": "date-time"}
_NO_HINT = "no enum, format, pattern, examples or description hint"

class AutoCaseError(ValueError):
    pass


class PlaceholderError(AutoCaseError):
    """A required value would only be the "test" placeholder (the tool is skipped, not called)."""


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


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


# ----------------------------------------------------------------------------- pattern -> sample
# A small regex-to-sample generator: literals, escapes (\d \w \s ...), classes, groups, alternation
# (first branch) and quantifiers (their minimum). Lookarounds, backreferences and \p{..} are not
# supported (None). The sample is always re-checked against the pattern.

_CLASS_ESC = {"d": "0-9", "w": "a-zA-Z0-9_", "s": " "}
_ATOM_ESC = {"d": "0", "D": "a", "w": "a", "W": "-", "s": " ", "S": "a", "n": "\n", "t": "\t", "r": "\r",
             "f": "\f", "v": "\v"}
_NEG_CANDIDATES = "aA0_- .x"


class _Unsupported(Exception):
    pass


def _class_items(p: str, i: int) -> tuple[list[tuple[str, str]], bool, int]:
    """Parse a [...] class starting after '['. Returns (ranges, negated, index after ']')."""
    neg = i < len(p) and p[i] == "^"
    if neg:
        i += 1
    items: list[tuple[str, str]] = []
    first = True
    while i < len(p) and (p[i] != "]" or first):
        first = False
        c = p[i]
        if c == "\\":
            if i + 1 >= len(p):
                raise _Unsupported
            e = p[i + 1]
            i += 2
            if e in _CLASS_ESC:
                spec = _CLASS_ESC[e]
                j = 0
                while j < len(spec):
                    if j + 2 < len(spec) and spec[j + 1] == "-":
                        items.append((spec[j], spec[j + 2]))
                        j += 3
                    else:
                        items.append((spec[j], spec[j]))
                        j += 1
                continue
            if e in "DWSpP":
                raise _Unsupported
            ch = _ATOM_ESC.get(e, e)
        else:
            ch = c
            i += 1
        if i + 1 < len(p) and p[i] == "-" and p[i + 1] != "]":
            hi = p[i + 1]
            if hi == "\\":
                if i + 2 >= len(p):
                    raise _Unsupported
                hi = _ATOM_ESC.get(p[i + 2], p[i + 2])
                i += 3
            else:
                i += 2
            items.append((ch, hi))
        else:
            items.append((ch, ch))
    if i >= len(p):
        raise _Unsupported
    return items, neg, i + 1


def _quant(p: str, i: int) -> tuple[int, int]:
    """(minimum repeat, index after the quantifier) for the quantifier at p[i], or (1, i) if none."""
    if i >= len(p):
        return 1, i
    c = p[i]
    if c in "*?":
        n, i = 0, i + 1
    elif c == "+":
        n, i = 1, i + 1
    elif c == "{":
        m = re.match(r"\{(\d+)(,\d*)?\}", p[i:])
        if not m:
            return 1, i
        n, i = int(m.group(1)), i + m.end()
    else:
        return 1, i
    if i < len(p) and p[i] in "?+":
        i += 1
    return min(n, 1000), i


def _alt(p: str, i: int) -> tuple[str, int]:
    first: str | None = None
    while True:
        s, i = _seq(p, i)
        if first is None:
            first = s
        if i < len(p) and p[i] == "|":
            i += 1
            continue
        return first, i


def _seq(p: str, i: int) -> tuple[str, int]:
    out = ""
    while i < len(p) and p[i] not in "|)":
        c = p[i]
        if c in "^$":
            i += 1
            continue
        if c in "*+?{" and not (c == "{" and not re.match(r"\{\d+(,\d*)?\}", p[i:])):
            raise _Unsupported
        if c == "(":
            i += 1
            if p.startswith("?:", i):
                i += 2
            elif p.startswith("?<", i) and not p.startswith("?<=", i) and not p.startswith("?<!", i):
                close = p.find(">", i)
                if close < 0:
                    raise _Unsupported
                i = close + 1
            elif i < len(p) and p[i] == "?":
                raise _Unsupported
            atom, i = _alt(p, i)
            if i >= len(p) or p[i] != ")":
                raise _Unsupported
            i += 1
        elif c == "[":
            items, neg, i = _class_items(p, i + 1)
            if neg:
                atom = next((ch for ch in _NEG_CANDIDATES if not any(lo <= ch <= hi for lo, hi in items)), None)
                if atom is None:
                    raise _Unsupported
            else:
                if not items:
                    raise _Unsupported
                atom = items[0][0]
        elif c == ".":
            atom, i = "a", i + 1
        elif c == "\\":
            if i + 1 >= len(p):
                raise _Unsupported
            e = p[i + 1]
            i += 2
            if e in "bB":
                continue
            if e.isdigit() or e in "pPkcux":
                raise _Unsupported
            atom = _ATOM_ESC.get(e, e)
        else:
            atom, i = c, i + 1
        n, i = _quant(p, i)
        out += atom * n
    return out, i


def pattern_sample(pattern: str) -> str | None:
    """A short string that matches `pattern` (JSON Schema regex, unanchored), or None."""
    try:
        s, i = _alt(pattern, 0)
        if i != len(pattern):
            return None
        return s if re.search(pattern, s) else None
    except (_Unsupported, re.error, RecursionError):
        return None


# ----------------------------------------------------------------------------- value generation
class _Ctx:
    def __init__(self, today: str):
        self.today = today
        self.guessed: list[dict[str, Any]] = []
        self.placeholders: list[str] = []
        self.kinds: dict[str, str] = {}

    def fork(self) -> "_Ctx":
        return _Ctx(self.today)

    def merge(self, other: "_Ctx") -> None:
        self.guessed += other.guessed
        self.placeholders += other.placeholders
        self.kinds.update(other.kinds)


def _first(values: list[Any]) -> Any:
    return next((v for v in values if v is not None), values[0])


def _placeholder(schema: dict[str, Any]) -> str:
    n = int(schema.get("minLength") or 0)
    s = "test"
    return (s * (n // len(s) + 1))[:max(n, len(s))][: schema.get("maxLength", 10**6)]


def _string(schema: dict[str, Any], ctx: _Ctx, path: str, name: str) -> str:
    today = ctx.today
    fmt = schema.get("format")
    if isinstance(fmt, str) and fmt in _FORMATS:
        if fmt in _DATE_KINDS:
            ctx.kinds[path] = _DATE_KINDS[fmt]
        return _FORMATS[fmt].replace("{today}", today)
    pat = schema.get("pattern")
    if isinstance(pat, str):
        s = pattern_sample(pat)
        if s is None:
            raise AutoCaseError(f"can't generate a value for {path} that matches its pattern {json.dumps(pat)}")
        return s

    def guess(value: str, source: str, kind: str | None = None) -> str:
        ctx.guessed.append({"path": path, "value": value, "source": source})
        if kind:
            ctx.kinds[path] = kind
        return value

    desc = schema.get("description")
    vals = enum_hint(desc)
    if vals:
        return guess(vals[0], "description lists allowed values")
    dh = date_format_hint(desc)
    if dh:
        kind, token, tail = dh
        return guess(render_date_format(token, tail, today), f"description date format {token}{tail}", kind)
    if datetime_hint(desc):
        return guess(f"{today}T00:00:00Z", "description asks for a date-time", "date-time")
    nk = name_kind(name) if name else None
    if nk == "date":
        return guess(today, "name suggests a date", "date")
    if nk == "date-time":
        return guess(f"{today}T00:00:00Z", "name suggests a date-time", "date-time")
    if nk == "text":
        return guess(_placeholder(schema), "name suggests free text")
    ctx.placeholders.append(path)
    return _placeholder(schema)


def _number(schema: dict[str, Any], integer: bool) -> int | float:
    lo = schema.get("minimum")
    ex_lo = schema.get("exclusiveMinimum")
    if isinstance(ex_lo, (int, float)) and not isinstance(ex_lo, bool):
        lo = max(lo, ex_lo + 1) if lo is not None else ex_lo + 1
    hi = schema.get("maximum")
    ex_hi = schema.get("exclusiveMaximum")
    if isinstance(ex_hi, (int, float)) and not isinstance(ex_hi, bool):
        hi = min(hi, ex_hi - 1) if hi is not None else ex_hi - 1
    v = lo if lo is not None else 1
    if hi is not None and v > hi:
        v = hi
    step = schema.get("multipleOf")
    if isinstance(step, (int, float)) and not isinstance(step, bool) and step > 0:
        v = math.ceil(v / step) * step
    return int(v) if integer else v


def _value(schema: Any, root: Any, depth: int, ctx: _Ctx, path: str, name: str) -> Any:
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
        return _first(schema["enum"])
    if isinstance(schema.get("examples"), list) and schema["examples"]:
        return _first(schema["examples"])
    for key in ("anyOf", "oneOf"):
        opts = schema.get(key)
        if isinstance(opts, list) and opts:
            non_null = [o for o in opts if not (isinstance(o, dict) and o.get("type") == "null")]
            best: tuple[Any, _Ctx] | None = None
            last: AutoCaseError | None = None
            for opt in non_null or opts:
                opt = _resolve(opt, root)
                if isinstance(opt, dict) and "description" not in opt and isinstance(schema.get("description"), str):
                    opt = {**opt, "description": schema["description"]}  # hints usually sit on the parent
                sub = ctx.fork()
                try:
                    v = _value(opt, root, depth + 1, sub, path, name)
                except AutoCaseError as e:
                    last = e
                    continue
                if not sub.placeholders:
                    best = (v, sub)
                    break
                if best is None:
                    best = (v, sub)
            if best is None:
                raise last or AutoCaseError("no usable anyOf/oneOf option")
            ctx.merge(best[1])
            return best[0]
    if isinstance(schema.get("allOf"), list) and schema["allOf"]:
        merged: dict[str, Any] = {k: v for k, v in schema.items() if k != "allOf"}
        for part in schema["allOf"]:
            part = _resolve(part, root)
            if isinstance(part, dict):
                for k, v in part.items():
                    if k == "properties":
                        merged["properties"] = {**(merged.get("properties") or {}), **v}  # don't mutate the input
                    elif k == "required":
                        merged["required"] = list(dict.fromkeys([*merged.get("required", []), *v]))
                    else:
                        merged.setdefault(k, v)
        return _value(merged, root, depth + 1, ctx, path, name)
    t = schema.get("type")
    if isinstance(t, list):
        t = next((x for x in t if x != "null"), "null")
    if t is None:
        t = "object" if "properties" in schema else None
    if t == "object":
        props = schema.get("properties") or {}
        out = {}
        req = [n for n in (schema.get("required") or []) if isinstance(n, str)]
        child = {n: f"{path}.{n}" if path else n for n in req}
        for n in req:
            if n in props:
                out[n] = _value(props[n], root, depth + 1, ctx, child[n], n)
            else:
                ctx.placeholders.append(child[n])
                out[n] = "test"
        # A range (startDate/endDate, from/to, ...) gets the same value on both ends, so limits hold.
        for n in req:
            key = range_key(n)
            if child[n] not in ctx.placeholders or key is None:
                continue
            partner = next((m for m in req if m != n and range_key(m) == key and child[m] in ctx.kinds), None)
            if partner is not None:
                out[n] = out[partner]
                ctx.placeholders.remove(child[n])
                ctx.kinds[child[n]] = ctx.kinds[child[partner]]
                ctx.guessed.append({"path": child[n], "value": out[n], "source": f"range pair with {partner}"})
        return out
    if t == "array":
        n = int(schema.get("minItems") or 0)
        return [_value(schema.get("items", {}), root, depth + 1, ctx, f"{path}[{i}]", name) for i in range(n)]
    if t == "string":
        return _string(schema, ctx, path, name)
    if t in ("integer", "number"):
        return _number(schema, t == "integer")
    if t == "boolean":
        return False
    if t == "null":
        return None
    return None


def build_args(input_schema: Any, today: str | None = None,
               allow_placeholders: bool = False) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """(args, guessed): required properties only, each with the most realistic value the schema allows.

    `guessed` lists values taken from a description or name ({"path", "value", "source"}).
    Raises PlaceholderError if a required value would only be the "test" placeholder (unless
    allow_placeholders), and AutoCaseError if the args can't be built or don't validate."""
    if not isinstance(input_schema, dict):
        raise AutoCaseError("inputSchema is not an object")
    ctx = _Ctx(today or _today())
    args = _value(input_schema, input_schema, 0, ctx, "", "")
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise AutoCaseError("inputSchema does not describe an object")
    if ctx.placeholders and not allow_placeholders:
        raise PlaceholderError(f"can't build a realistic value for {', '.join(ctx.placeholders)} ({_NO_HINT})")
    cls = validator_for(input_schema, default=validator_for({"$schema": _DEFAULT_META}))
    err = next(iter(cls(input_schema).iter_errors(args)), None)
    if err is not None:
        where = "/" + "/".join(str(p) for p in err.absolute_path) if err.absolute_path else "/"
        raise AutoCaseError(f"the generated args do not validate at {where}: {err.message}")
    return args, ctx.guessed


def minimal_args(input_schema: Any, today: str | None = None, allow_placeholders: bool = False) -> dict[str, Any]:
    """Required properties only, filled with the most realistic value. Raises AutoCaseError."""
    return build_args(input_schema, today, allow_placeholders)[0]


def auto_case(tool: dict[str, Any], allow: list[str] | tuple[str, ...] = (),
              deny: list[str] | tuple[str, ...] = ()) -> tuple[Case | None, str]:
    """(Case, "") if the tool may be auto-called, else (None, reason)."""
    reason = eligibility(tool, allow, deny)
    if reason:
        return None, reason
    try:
        args, guessed = build_args(tool.get("inputSchema") or {"type": "object"})
    except PlaceholderError as e:
        return None, f"it {e}"
    except AutoCaseError as e:
        return None, f"it could not build valid args ({e})"
    return Case(tool=tool["name"], args=args, expect="any", name="auto", guessed=guessed), ""


def guessed_note(guessed: list[dict[str, Any]]) -> str:
    """Row-detail note for values guessed from a description or name (same text as the Conformance tab)."""
    if not guessed:
        return ""
    return " Values guessed from the description or name: " + ", ".join(
        f"{g['path']} = {json.dumps(g['value'])} ({g['source']})" for g in guessed) + "."

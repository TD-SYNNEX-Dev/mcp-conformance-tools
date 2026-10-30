"""Value hints read from a property's description and name (used by auto-cases and lint).

Generic heuristics only. Each returns a hint, or None when the text says nothing usable:

  enum_hint("Enum: invoices, charges.")         -> ["invoices", "charges"]
  date_format_hint("Start date (yyyy-MM-dd).")  -> ("date", "yyyy-MM-dd", "")
  datetime_hint("ISO 8601 timestamp")           -> True   (but not for "Unix/epoch timestamp")
  name_kind("endDate") -> "date"; name_kind("startTime") -> "date-time"; name_kind("query") -> "text"
  range_key("StartDate") == range_key("EndDate") -> pairs of a range (start/end, from/to, ...)

The Inspector fork's conformanceRules.ts mirrors these rules (same regexes, same order).
"""

from __future__ import annotations

import re

# "Enum: a, b", "one of a, b", "allowed values: a | b", "possible/valid/accepted values: ..."
_ENUM_LEAD = re.compile(
    r"(?:\benum\b|\bone of\b|\b(?:allowed|possible|valid|accepted|supported|permitted) values?\b)\s*(?:is|are)?\s*[:=]?\s*",
    re.IGNORECASE)
_ENUM_TOKEN = re.compile(r"^[A-Za-z0-9_.:+\-]+$")
_QUOTES = "\"'`\u2018\u2019\u201c\u201d()[]{}"

# yyyy-MM-dd, YYYY-MM-DD, dd/MM/yyyy, MM/DD/YYYY, yyyyMMdd, yyyy.MM.dd ... (y, M and d once each)
_DATE_TOKEN = re.compile(
    r"(?<![A-Za-z0-9])(y{4}|y{2}|m{1,2}|d{1,2})([-/.]?)(y{4}|y{2}|m{1,2}|d{1,2})\2(y{4}|y{2}|m{1,2}|d{1,2})(?![A-Za-z0-9])",
    re.IGNORECASE)
_TIME_TAIL = re.compile(r"^(\s*'T'\s*|\s*T\s*|\s+)(hh?):mm(:ss)?", re.IGNORECASE)
_DATETIME = re.compile(r"\biso[\s_-]?8601\b|\bdate[\s_-]?time\b|\brfc[\s_-]?3339\b|\btimestamps?\b",
                       re.IGNORECASE)

_NOT_ISO = re.compile(r"\b(?:unix|epoch)\b", re.IGNORECASE)

_NAME_TOKENS = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z0-9]+|[A-Z]+")
_NOT_DATE = {"candidate", "candidates", "validate", "update", "updates", "mandate", "mandates",
             "consolidate", "accommodate", "liquidate"}
_NOT_TIME = {"runtime", "uptime", "lifetime", "overtime", "onetime", "anytime"}
_TEXT = {"q", "query", "keyword", "keywords", "search", "searchterm", "searchtext", "searchquery",
         "term", "terms", "text", "freetext"}
_RANGE = {"start", "end", "from", "to", "begin", "since", "until", "after", "before"}


def enum_hint(description: object) -> list[str] | None:
    """Values a description lists as allowed ("Enum: a, b"), or None."""
    if not isinstance(description, str):
        return None
    m = _ENUM_LEAD.search(description)
    if not m:
        return None
    rest = description[m.end():]
    lead = re.match(r"^[^:.;\n]{0,40}:\s*", rest)  # "one of the following: a, b"
    if lead:
        rest = rest[lead.end():]
    rest = re.split(r"\.\s|\.$|;|\n", rest, maxsplit=1)[0]
    vals = []
    for raw in re.split(r",|\||/|\bor\b|\band\b", rest):
        v = raw.strip().strip(_QUOTES).strip()
        if not v:
            continue
        if not _ENUM_TOKEN.match(v):
            break
        vals.append(v)
    return vals or None


def date_format_hint(description: object) -> tuple[str, str, str] | None:
    """(kind, date token, time tail) for the first date-format token in the text, or None.

    kind is "date" or "date-time" (a time like HH:mm follows the date token)."""
    if not isinstance(description, str):
        return None
    for m in _DATE_TOKEN.finditer(description):
        groups = (m.group(1), m.group(3), m.group(4))
        if {g[0].lower() for g in groups} != {"y", "m", "d"}:
            continue
        tail = _TIME_TAIL.match(description[m.end():])
        return ("date-time" if tail else "date", m.group(0), tail.group(0) if tail else "")
    return None


def render_date_format(token: str, tail: str, today: str) -> str:
    """Render a date token like "dd/MM/yyyy" (plus an optional "THH:mm:ss" tail) for `today` (YYYY-MM-DD)."""
    y, mo, d = today[0:4], today[5:7], today[8:10]
    m = _DATE_TOKEN.fullmatch(token)
    assert m
    sep = m.group(2)
    parts = []
    for g in (m.group(1), m.group(3), m.group(4)):
        k = g[0].lower()
        parts.append((y if len(g) == 4 else y[2:]) if k == "y" else mo if k == "m" else d)
    out = sep.join(parts)
    if tail:
        t = _TIME_TAIL.match(tail)
        assert t
        out += ("T" if "t" in t.group(1).lower() else " ") + "00:00" + (":00" if t.group(3) else "")
    return out


def datetime_hint(description: object) -> bool:
    """True if the text asks for an ISO 8601 / RFC 3339 date-time or a timestamp."""
    return (isinstance(description, str) and bool(_DATETIME.search(description))
            and not _NOT_ISO.search(description))


def name_tokens(name: str) -> list[str]:
    return [t.lower() for t in _NAME_TOKENS.findall(name)]


def name_kind(name: str) -> str | None:
    """"date-time", "date" or "text" (a free-text search field) from a property name, or None."""
    toks = name_tokens(name)
    if any(t in ("time", "timestamp", "datetime") or
           ((t.endswith("time") or t.endswith("timestamp")) and t not in _NOT_TIME) for t in toks):
        return "date-time"
    if len(toks) >= 2 and toks[-1] == "at" and toks[-2].endswith("ed"):  # createdAt, updated_at
        return "date-time"
    if any((t.startswith("date") or t.endswith("date")) and t not in _NOT_DATE for t in toks):
        return "date"
    if any(t in _TEXT for t in toks):
        return "text"
    return None


def range_key(name: str) -> str | None:
    """Name with its one range word (start/end, from/to, ...) removed; None if it has none."""
    toks = name_tokens(name)
    hits = [i for i, t in enumerate(toks) if t in _RANGE]
    if len(hits) != 1:
        return None
    return "_".join(t for i, t in enumerate(toks) if i != hits[0])

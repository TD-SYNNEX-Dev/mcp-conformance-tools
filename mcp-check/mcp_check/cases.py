"""Cases file loader (YAML or JSON).

Format - a mapping of tool name to a list of argument sets:

    search_items:
      - args: {query: laptop}
        expect: success        # default
      - name: missing query    # optional label
        args: {}
        expect: error          # a JSON-RPC error or isError result counts as PASS
    list_categories:
      - args: {}
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


@dataclass
class Case:
    tool: str
    args: dict[str, Any] = field(default_factory=dict)
    expect: str = "success"  # success | error | any (any = auto-case: only a schema mismatch FAILs)
    name: str | None = None


class CasesError(ValueError):
    pass


def load_cases(path: str | Path) -> dict[str, list[Case]]:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    data = json.loads(text) if p.suffix.lower() == ".json" else yaml.safe_load(text)
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise CasesError(f"{p}: top level must be a mapping of tool name -> list of cases")
    out: dict[str, list[Case]] = {}
    for tool, entries in data.items():
        if entries is None:
            entries = [{}]
        if isinstance(entries, dict):
            entries = [entries]
        if not isinstance(entries, list):
            raise CasesError(f"{p}: {tool}: expected a list of cases")
        cases = []
        for i, e in enumerate(entries):
            if e is None:
                e = {}
            if not isinstance(e, dict):
                raise CasesError(f"{p}: {tool}[{i}]: each case must be a mapping with `args`")
            unknown = set(e) - {"args", "expect", "name"}
            if unknown:
                raise CasesError(f"{p}: {tool}[{i}]: unknown keys {sorted(unknown)} (put tool arguments under `args`)")
            args = e.get("args") or {}
            if not isinstance(args, dict):
                raise CasesError(f"{p}: {tool}[{i}]: `args` must be a mapping")
            expect = str(e.get("expect", "success")).lower()
            if expect not in ("success", "error"):
                raise CasesError(f"{p}: {tool}[{i}]: expect must be success or error")
            cases.append(Case(tool=str(tool), args=args, expect=expect, name=e.get("name")))
        out[str(tool)] = cases
    return out

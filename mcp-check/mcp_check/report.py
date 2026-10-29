"""Table, JSON and JUnit XML output. All text is masked before it is written."""

from __future__ import annotations

import json
import shutil
import textwrap
from collections import Counter
from datetime import datetime, timezone
from typing import Any
from xml.etree import ElementTree as ET

from mcp_check import __version__
from mcp_check.detail import render
from mcp_check.masking import mask, safe_url
from mcp_check.runner import FAIL, NOT_EXERCISED, PASS, SKIPPED, WARN, Report, coverage


def table(report: Report, width: int | None = None, wrap: bool = True) -> str:
    width = width or max(100, shutil.get_terminal_size((160, 20)).columns)
    rows = [(r.tool, r.check, r.status, "" if r.ms is None else f"{r.ms:.0f}", mask(r.detail)) for r in report.rows]
    heads = ("TOOL", "CHECK", "STATUS", "MS", "DETAIL")
    w = [max(len(h), *(len(x[i]) for x in rows)) if rows else len(h) for i, h in enumerate(heads[:4])]
    w[0] = min(w[0], 40)
    dw = max(30, width - sum(w) - 8)
    lines = [f"{heads[0]:<{w[0]}}  {heads[1]:<{w[1]}}  {heads[2]:<{w[2]}}  {heads[3]:>{w[3]}}  {heads[4]}",
             "-" * min(width, sum(w) + 8 + dw)]
    for tool, check, status, ms, detail in rows:
        chunks = (textwrap.wrap(detail, dw) or [""]) if wrap else [detail]
        chunks = chunks or [""]
        lines.append(f"{tool[:w[0]]:<{w[0]}}  {check:<{w[1]}}  {status:<{w[2]}}  {ms:>{w[3]}}  {chunks[0]}")
        pad = " " * (sum(w) + 8)
        lines += [pad + c for c in chunks[1:]]
    return "\n".join(lines)


def responses(report: Report) -> str:
    """--show-response: one block per failing call (args, raw result, outputSchema, problems marked)."""
    blocks = [render(r.tool, r.check, r.status, r.data or {}) for r in report.rows
              if r.check.startswith("call") and r.status == FAIL and r.data and "args" in r.data]
    return mask("\n\n".join(blocks))


def header(report: Report) -> str:
    si = report.server_info or {}
    return (f"mcp-check {__version__} | mcp SDK {report.sdk_version} | {report.transport} {safe_url(report.url)}\n"
            f"server: {si.get('name', '?')} {si.get('version', '')}  protocol: {report.protocol_version or '?'}")


def summary(report: Report) -> str:
    c = Counter(r.status for r in report.rows if r.check.startswith("call"))
    lint = Counter(r.status for r in report.rows if r.check == "lint")
    s = (f"tools: {len(report.tools)}"
         + (f" ({len(report.filtered_out)} filtered out)" if report.filtered_out else "")
         + f" | lint: {lint[PASS]} pass, {lint[WARN]} warn, {lint[FAIL]} fail"
         + f" | calls: {c[PASS]} pass, {c[FAIL]} fail, {c[WARN]} warn, {c[NOT_EXERCISED]} not exercised"
         + (f", {c[SKIPPED]} skipped" if c[SKIPPED] else ""))
    nulls = [r for r in report.rows if r.check == "null-sweep"]
    if nulls:
        s += f" | null sweep: {sum(len(r.data.get('null_fields', [])) for r in nulls)} disallowed null field(s) in {len(nulls)} call(s)"
    return s + "\n" + coverage_line(report) + ("\nRESULT: FAIL" if report.failed else "\nRESULT: PASS")


def coverage_line(report: Report, max_names: int = 40) -> str:
    cov = coverage(report)
    miss = cov["not_exercised"]
    names = ", ".join(miss[:max_names]) + (f", ... +{len(miss) - max_names} more" if len(miss) > max_names else "")
    return (f"coverage: {cov['tools']} tool{'' if cov['tools'] == 1 else 's'}, {cov['exercised']} exercised, {len(miss)} not exercised"
            + (f" ({names})" if miss else ""))


def to_dict(report: Report) -> dict[str, Any]:
    return mask({
        "tool": f"mcp-check {__version__}",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "url": safe_url(report.url),
        "transport": report.transport,
        "mcp_sdk_version": report.sdk_version,
        "server_info": report.server_info,
        "protocol_version": report.protocol_version,
        "capabilities": report.capabilities,
        "tool_count": len(report.tools),
        "filtered_out": report.filtered_out,
        "result": "FAIL" if report.failed else "PASS",
        "coverage": coverage(report),
        "fatal": report.fatal,
        "rows": [r.__dict__ for r in report.rows],
        "tools": report.tools,
    })


def write_json(report: Report, path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(to_dict(report), f, indent=2, default=str)


def write_junit(report: Report, path: str) -> None:
    rows = report.rows
    suite = ET.Element("testsuite", name="mcp-check", tests=str(len(rows)),
                       failures=str(sum(r.status == FAIL for r in rows)),
                       skipped=str(sum(r.status in (NOT_EXERCISED, SKIPPED) for r in rows)),
                       time=f"{sum((r.ms or 0) for r in rows) / 1000:.3f}")
    props = ET.SubElement(suite, "properties")
    for k, v in (("url", safe_url(report.url)), ("mcp_sdk_version", report.sdk_version),
                 ("protocol_version", report.protocol_version or ""),
                 ("server", json.dumps(report.server_info or {}))):
        ET.SubElement(props, "property", name=k, value=mask(str(v)))
    for r in rows:
        tc = ET.SubElement(suite, "testcase", classname=mask(f"mcp.{r.tool}"), name=mask(r.check),
                           time=f"{(r.ms or 0) / 1000:.3f}")
        if r.status == FAIL:
            ET.SubElement(tc, "failure", message=mask(r.detail[:500])).text = mask(r.detail)
        elif r.status in (NOT_EXERCISED, SKIPPED):
            ET.SubElement(tc, "skipped", message=mask(r.detail))
        elif r.status == WARN:
            ET.SubElement(tc, "system-out").text = "WARN: " + mask(r.detail)
    root = ET.Element("testsuites", name="mcp-check")
    root.append(suite)
    ET.indent(root)
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)

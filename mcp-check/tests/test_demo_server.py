"""End-to-end proof against the local demo server: good tool PASS, null-message tools FAIL,
Inspector tools/list passes, and the API key never appears in any output."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest

from conftest import DEMO_KEY, ROOT

CASES = str(ROOT / "tests" / "cases.demo.yaml")
NPX = shutil.which("npx")


def run_check(url: str, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    e = {k: v for k, v in os.environ.items() if not k.startswith("MCP_")}
    e.update(env or {})
    e["PYTHONPATH"] = str(ROOT)
    return subprocess.run([sys.executable, "-m", "mcp_check", "--url", url, *args],
                          env=e, capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL)


def rows_by(report: dict) -> dict[tuple[str, str], dict]:
    return {(r["tool"], r["check"]): r for r in report["rows"]}


def test_good_pass_bad_fail(demo_server, tmp_path: Path):
    out = tmp_path / "report.json"
    junit = tmp_path / "junit.xml"
    p = run_check(f"{demo_server}/mcp", "--cases", CASES, "--json", str(out), "--junit", str(junit))
    assert p.returncode == 1, p.stdout + p.stderr  # FAIL rows => non-zero
    rep = json.loads(out.read_text())
    rows = rows_by(rep)
    assert rep["server_info"]["name"] == "mcp-check-demo-server"
    assert rep["protocol_version"]
    assert rep["tool_count"] == 4  # two pages => pagination works

    good = rows[("good_tool", "call[0]")]
    assert good["status"] == "PASS" and good["data"]["sdk_accepted"] is True

    for bad in ("null_message_tool", "nullable_tool"):
        r = rows[(bad, "call[0]")]
        assert r["status"] == "FAIL"
        assert r["data"]["sdk_accepted"] is False
        assert f"Invalid structured content returned by tool {bad}: None is not of type 'string'" in r["data"]["error"]
        assert r["detail"].startswith("Field /message is null, but the output schema says it must be a string.")
        assert {"path": "/message", "message": "None is not of type 'string'",
                "schema_path": "/properties/message/type"} in r["data"]["schema_errors"]

    assert rows[("uncovered_tool", "call")]["status"] == "NOT EXERCISED"
    lint = rows[("nullable_tool", "lint")]
    assert lint["status"] == "WARN" and "outputSchema at /properties/message: Uses `nullable: true`" in lint["detail"]
    assert rows[("good_tool", "lint")]["status"] == "PASS"

    for bad in ("null_message_tool", "nullable_tool"):  # null sweep: one extra FAIL row per bad call
        sweep = rows[(bad, "null-sweep")]
        assert sweep["status"] == "FAIL" and sweep["data"]["null_fields"][0]["path"] == "/message"
    assert "coverage: 4 tools, 3 exercised, 1 not exercised (uncovered_tool)" in p.stdout

    suite = ET.parse(junit).getroot().find("testsuite")
    assert suite.get("failures") == "4"
    assert "PASS" in p.stdout and "FAIL" in p.stdout


def test_only_skip_filters(demo_server, tmp_path: Path):
    out = tmp_path / "r.json"
    p = run_check(f"{demo_server}/mcp", "--cases", CASES, "--only", "good_*,uncovered_tool",
                  "--skip", "uncovered_tool", "--json", str(out))
    assert p.returncode == 0, p.stdout
    rep = json.loads(out.read_text())
    assert {r["tool"] for r in rep["rows"]} == {"-", "good_tool"}


def test_strict_lint_fails_on_nullable(demo_server):
    p = run_check(f"{demo_server}/mcp", "--no-calls", "--only", "nullable_tool", "--strict-lint")
    assert p.returncode == 1
    p = run_check(f"{demo_server}/mcp", "--no-calls", "--only", "nullable_tool")
    assert p.returncode == 0


def test_sse_fallback(demo_server):
    p = run_check(f"{demo_server}/sse", "--sse", "--cases", CASES, "--only", "good_tool")
    assert p.returncode == 0, p.stdout + p.stderr
    assert "OK: structuredContent matches the output schema." in p.stdout


def test_auth_header_and_masking(demo_server_auth, tmp_path: Path):
    out, junit = tmp_path / "r.json", tmp_path / "j.xml"
    env = {"MCP_API_KEY": DEMO_KEY, "MCP_AUTH_HEADER": "X-API-Key"}
    p = run_check(f"{demo_server_auth}/mcp?api_key={DEMO_KEY}", "--cases", CASES, "--json", str(out),
                  "--junit", str(junit), env=env)
    assert p.returncode == 1  # bad tools still FAIL, but we got in
    assert "X-API-Key: <SECRET>" in p.stderr
    for text in (p.stdout, p.stderr, out.read_text(), junit.read_text()):
        assert DEMO_KEY not in text
    assert rows_by(json.loads(out.read_text()))[("good_tool", "call[0]")]["status"] == "PASS"

    bad = run_check(f"{demo_server_auth}/mcp", "--no-calls", env={"MCP_API_KEY": "wrong-key-xyz", "MCP_AUTH_HEADER": "X-API-Key"})
    assert bad.returncode == 1 and "401" in bad.stdout and "unauthorized" in bad.stdout


def test_no_url_is_usage_error():
    p = run_check("", "--no-calls")
    assert p.returncode == 2


@pytest.mark.skipif(NPX is None, reason="npx not installed")
@pytest.mark.parametrize("auth", [False, True])
def test_run_all_inspector_and_python(demo_server, demo_server_auth, tmp_path: Path, auth: bool):
    base = demo_server_auth if auth else demo_server
    env = {k: v for k, v in os.environ.items() if not k.startswith("MCP_")}
    env.update({"MCP_URL": f"{base}/mcp", "OUT_DIR": str(tmp_path), "PYTHON": sys.executable})
    if auth:
        env.update({"MCP_API_KEY": DEMO_KEY, "MCP_AUTH_HEADER": "X-API-Key"})
    p = subprocess.run(["bash", str(ROOT / "run-all.sh"), "--cases", CASES], env=env,
                       capture_output=True, text=True, timeout=300)
    out = p.stdout + p.stderr
    # Inspector's tools/list passes for all tools (bad ones included) ...
    assert "Inspector tools/list: PASS (4 tools)" in out, out
    tools = json.loads((tmp_path / "inspector-tools.json").read_text())["tools"]
    assert {t["name"] for t in tools} >= {"good_tool", "null_message_tool"}
    # ... while the Python SDK check fails the null-message tools, so the combined exit is 1.
    assert "combined: inspector=0 mcp-check=1" in out
    assert p.returncode == 1
    for f in tmp_path.iterdir():
        assert DEMO_KEY not in f.read_text()
    assert DEMO_KEY not in out

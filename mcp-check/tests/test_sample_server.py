"""End to end against tests/sample_bad_server.py: every bug tool FAILs with a plain-language
detail, healthy_tool passes, delete_record is never called unless you run it on its own and confirm."""

from __future__ import annotations

import json
from pathlib import Path

from tests.test_demo_server import rows_by, run_check

BAD = ["null_string_field", "nullable_keyword", "wrong_type_field", "missing_required_field",
       "extra_property", "enum_violation", "missing_structured_content"]

EXPECTED_DETAIL = {
    "null_string_field": 'Field /message is null, but the output schema says it must be a string. Strict clients '
                         '(like the Python SDK) will reject this response. Fix: return a string, or allow null '
                         'with "type": ["string", "null"].',
    "nullable_keyword": "Its `nullable: true` does not help: that is an OpenAPI keyword, and JSON Schema ignores it. "
                        "Some clients (e.g. the TypeScript SDK) accept this, others (e.g. the Python SDK) reject it.",
    "wrong_type_field": 'Field /count is a string ("12"), but the output schema says it must be an integer.',
    "missing_required_field": 'Required field /name is missing.',
    "extra_property": 'Field /debug is not in the output schema, which does not allow extra fields',
    "enum_violation": 'Field /status is "archived", which is not one of the allowed values ("active", "inactive").',
    "missing_structured_content": "The tool declares an output schema, but the response has no structuredContent.",
}


def test_auto_cases_fail_each_bug_and_never_delete(sample_server, tmp_path: Path):
    base, log = sample_server
    out = tmp_path / "r.json"
    p = run_check(f"{base}/mcp", "--auto-cases", "--json", str(out))
    assert p.returncode == 1, p.stdout + p.stderr
    rep = json.loads(out.read_text())
    rows = rows_by(rep)

    ok = rows[("healthy_tool", "call[auto]")]
    assert ok["status"] == "PASS" and ok["data"]["args"] == {"query": "test"}
    assert ok["detail"].startswith("OK: structuredContent matches the output schema.")
    for bad in BAD:
        row = rows[(bad, "call[auto]")]
        assert row["status"] == "FAIL", (bad, row)
        assert EXPECTED_DETAIL[bad] in row["detail"], (bad, row["detail"])
        assert "Fix:" in row["detail"]
        assert "Ajv" not in row["detail"]
    for bad in ("null_string_field", "nullable_keyword"):
        assert rows[(bad, "null-sweep")]["status"] == "FAIL"
        assert {"path": "/message", "message": "None is not of type 'string'",
                "schema_path": "/properties/message/type"} in rows[(bad, "call[auto]")]["data"]["schema_errors"]
    assert "JSON Schema ignores" in rows[("nullable_keyword", "null-sweep")]["detail"]
    lint = rows[("nullable_keyword", "lint")]
    assert lint["status"] == "WARN" and "OpenAPI keyword, and JSON Schema ignores it" in lint["detail"]
    assert 'Fix: use "type": ["string", "null"] instead.' in lint["detail"]

    d = rows[("delete_record", "call")]
    assert d["status"] == "NOT EXERCISED"
    assert "its name suggests side effects (contains 'delete')" in d["detail"]
    called = log.read_text().split()
    assert sorted(called) == sorted(BAD + ["healthy_tool"])  # never delete_record
    assert rep["coverage"] == {"tools": 9, "exercised": 8, "not_exercised": ["delete_record"]}
    assert "coverage: 9 tools, 8 exercised, 1 not exercised (delete_record)" in p.stdout


def test_auto_allow_restricts_and_default_is_off(sample_server, tmp_path: Path):
    base, log = sample_server
    out = tmp_path / "r.json"
    p = run_check(f"{base}/mcp", "--auto-cases", "--auto-allow", "healthy_tool,delete_*", "--json", str(out))
    assert p.returncode == 0, p.stdout + p.stderr
    rows = rows_by(json.loads(out.read_text()))
    assert rows[("healthy_tool", "call[auto]")]["status"] == "PASS"
    assert "it is not in the auto-allow list" in rows[("nullable_keyword", "call")]["detail"]
    assert "suggests side effects" in rows[("delete_record", "call")]["detail"]  # allowlist can't override
    assert log.read_text().split() == ["healthy_tool"]

    log.write_text("")
    p = run_check(f"{base}/mcp", "--json", str(out))  # no --auto-cases: nothing is called
    assert p.returncode == 0
    assert log.read_text() == ""
    assert "coverage: 9 tools, 0 exercised, 9 not exercised" in p.stdout


def test_single_tool_with_custom_args(sample_server, tmp_path: Path):
    base, log = sample_server
    out = tmp_path / "r.json"
    p = run_check(f"{base}/mcp", "--tool", "healthy_tool", "--args", '{"query": "error"}', "--json", str(out))
    assert p.returncode == 1, p.stdout + p.stderr
    rep = json.loads(out.read_text())
    rows = rows_by(rep)
    assert {r["tool"] for r in rep["rows"]} == {"-", "healthy_tool"}
    row = rows[("healthy_tool", "call[args]")]
    assert row["status"] == "FAIL" and row["data"]["args"] == {"query": "error"}
    assert 'The tool reported an error (isError: true). Error text: "query \'error\' is not allowed".' in row["detail"]
    assert rep["coverage"] == {"tools": 1, "exercised": 1, "not_exercised": []}
    assert "coverage: 1 tool, 1 exercised, 0 not exercised" in p.stdout
    assert log.read_text().split() == ["healthy_tool"]

    p = run_check(f"{base}/mcp", "--tool", "wrong_type_field", "--tool", "nope", "--json", str(out))
    rows = rows_by(json.loads(out.read_text()))
    assert rows[("wrong_type_field", "call[auto]")]["status"] == "FAIL"  # minimal args, no --auto-cases needed
    assert rows[("nope", "call")]["status"] == "FAIL"
    assert 'does not list a tool named "nope"' in rows[("nope", "call")]["detail"]

    p = run_check(f"{base}/mcp", "--args", "{}")
    assert p.returncode == 2 and "exactly one --tool" in p.stderr
    p = run_check(f"{base}/mcp", "--tool", "healthy_tool", "--args", "[1]")
    assert p.returncode == 2 and "JSON object" in p.stderr


def test_single_side_effect_tool_needs_confirmation(sample_server, tmp_path: Path):
    base, log = sample_server
    out = tmp_path / "r.json"
    p = run_check(f"{base}/mcp", "--tool", "delete_record", "--json", str(out))  # stdin is not a TTY
    assert p.returncode == 0, p.stdout + p.stderr
    row = rows_by(json.loads(out.read_text()))[("delete_record", "call")]
    assert row["status"] == "NOT EXERCISED" and "--confirm-side-effects" in row["detail"]
    assert not log.exists()  # nothing was called

    p = run_check(f"{base}/mcp", "--tool", "delete_record", "--args", '{"record_id": "r1"}',
                  "--confirm-side-effects", "--json", str(out))
    assert p.returncode == 0, p.stdout + p.stderr
    row = rows_by(json.loads(out.read_text()))[("delete_record", "call[args]")]
    assert row["status"] == "PASS"
    assert log.read_text().split() == ["delete_record"]

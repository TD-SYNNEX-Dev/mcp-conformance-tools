"""Path highlighting for --show-response (mirrors the Inspector's conformanceDetail.ts tests)."""

from __future__ import annotations

import json
from pathlib import Path

from mcp_check.detail import highlights_for, json_lines, line_matches, marked_json, result_view, schema_pointer
from tests.test_demo_server import rows_by, run_check

SCHEMA = {
    "type": "object",
    "properties": {
        "message": {"type": "string"},
        "items": {"type": "array", "items": {"$ref": "#/$defs/item"}},
        "status": {"enum": ["active", "inactive"]},
        "name": {"type": "string"},
    },
    "required": ["message", "name"],
    "additionalProperties": False,
    "$defs": {"item": {"type": "object", "properties": {"id": {"type": "integer"}}}},
}


def test_json_lines_match_json_dumps_and_carry_pointers():
    v = {"a": 1, "b": {"c": [True, None], "d": {}}, "e": []}
    lines = json_lines(v)
    assert "\n".join(t for t, _, _ in lines) == json.dumps(v, indent=2)
    assert [p for _, p, _ in lines] == ["", "/a", "/b", "/b/c", "/b/c/0", "/b/c/1", "/b/c", "/b/d", "/b", "/e", ""]
    assert "/a~1b" in [p for _, p, _ in json_lines({"a/b": 1})]


def test_line_matching_subtree_and_open():
    v = {"message": None, "items": [{"id": "x"}], "name": "n"}
    hit = lambda ptr, mode="subtree": [t.strip() for t, p, k in json_lines(v) if line_matches((t, p, k), ptr, mode)]
    assert hit("/message") == ['"message": null,']
    assert hit("/items") == ['"items": [', "{", '"id": "x"', "}", "],"]
    assert hit("", "open") == ["{"]
    assert hit("/nope") == []


def test_schema_pointer():
    assert schema_pointer(SCHEMA, "/message") == "/properties/message"
    assert schema_pointer(SCHEMA, "/items/3/id") == "/$defs/item/properties/id"
    assert schema_pointer(SCHEMA, "/") == ""
    assert schema_pointer(SCHEMA, "/unknown/deep") == ""
    branchy = {"anyOf": [{"type": "null"}, {"type": "object", "properties": {"x": {"type": "string"}}}]}
    assert schema_pointer(branchy, "/x") == "/anyOf/1/properties/x"


def test_highlights_per_issue_kind():
    hs = highlights_for([
        {"kind": "null", "path": "/message", "expected": ["string"], "nullable": False},
        {"kind": "required", "path": "/name", "name": "name"},
        {"kind": "extra", "path": "/debug", "name": "debug"},
        {"kind": "enum", "path": "/status", "allowed": ["active"], "actual": "archived"},
        {"kind": "missing_structured", "path": "/"},
    ], [{"path": "/message"}], SCHEMA)
    assert hs == [
        {"result": "/structuredContent/message", "result_mode": "subtree", "schema": "/properties/message",
         "note": "/message is null"},
        {"result": "/structuredContent", "result_mode": "open", "schema": "/properties/name", "note": "/name is missing"},
        {"result": "/structuredContent/debug", "result_mode": "subtree", "schema": "/additionalProperties",
         "note": "/debug is not allowed"},
        {"result": "/structuredContent/status", "result_mode": "subtree", "schema": "/properties/status",
         "note": "/status is not an allowed value"},
        {"result": None, "result_mode": "subtree", "schema": None, "note": "no structuredContent in the result"},
    ]
    assert highlights_for([], [{"path": "/message"}], SCHEMA, "text")[0]["result"] == "/content"


def test_marked_json_and_result_view():
    view = result_view([], {"message": None, "ok": True}, False)
    assert view == {"content": [], "structuredContent": {"message": None, "ok": True}, "isError": False}
    text = marked_json(view, [("/structuredContent/message", "subtree")], "")
    assert '>>     "message": null,' in text.splitlines()
    assert '       "ok": true' in text.splitlines()


def test_show_response_and_json_fields(sample_server, tmp_path: Path):
    base, _ = sample_server
    out = tmp_path / "r.json"
    p = run_check(f"{base}/mcp", "--tool", "null_string_field", "--tool", "missing_required_field",
                  "--tool", "healthy_tool", "--show-response", "--json", str(out))
    assert p.returncode == 1, p.stdout + p.stderr
    s = p.stdout
    assert "--- null_string_field call[auto] (FAIL)" in s
    assert "  problem: /message is null (marked >>)" in s
    assert '>>     "message": null,' in s  # in the result
    assert '>>     "message": {' in s  # in the schema
    assert "--- missing_required_field call[auto] (FAIL)" in s
    assert "  problem: /name is missing (marked >>)" in s
    assert "--- healthy_tool" not in s  # PASS rows are not printed

    rows = rows_by(json.loads(out.read_text()))
    row = rows[("null_string_field", "call[auto]")]["data"]
    assert row["args"] == {"query": "test"}
    assert row["result"]["structuredContent"]["message"] is None
    assert row["result"]["isError"] is False and isinstance(row["result"]["content"], list)
    assert row["output_schema"]["properties"]["message"] == {"type": "string"}
    assert row["structured_content"]["message"] is None  # old fields kept
    assert rows[("null_string_field", "null-sweep")]["data"]["null_sweep_source"] == "structuredContent"

    p = run_check(f"{base}/mcp", "--tool", "null_string_field")
    assert "--- null_string_field" not in p.stdout  # off by default

from __future__ import annotations

from pathlib import Path

import pytest

from mcp_check.cases import CasesError, load_cases
from mcp_check.lint import allows_null, lint_tool
from mcp_check.masking import mask, register, safe_url
from mcp_check.runner import find_request_ids, schema_errors


def sev(findings, s):
    return [f for f in findings if f.severity == s]


def test_nullable_flagged_and_required_non_nullable_info():
    tool = {"name": "t", "inputSchema": {"type": "object"},
            "outputSchema": {"type": "object", "required": ["message", "data"],
                             "properties": {"message": {"type": "string", "nullable": True},
                                            "data": {"type": ["array", "null"]}}}}
    f = lint_tool(tool)
    warn = sev(f, "warn")
    assert len(warn) == 1 and warn[0].path == "/properties/message/nullable" and "still rejects null" in warn[0].message
    assert 'Fix: use "type": ["string", "null"] instead.' in warn[0].message
    info = sev(f, "info")
    assert [i.path for i in info] == ["/properties/message"]  # data allows null


def test_invalid_schema_is_error():
    f = lint_tool({"name": "t", "inputSchema": {"type": "obj"}, "outputSchema": {"type": "array"}})
    errs = sev(f, "error")
    assert any("Not valid JSON Schema" in e.message for e in errs)
    assert any("outputSchema" == e.schema and "object" in e.message for e in errs)


def test_nested_nullable_found():
    tool = {"name": "t", "inputSchema": {"type": "object"}, "outputSchema": {"type": "object", "properties": {
        "data": {"type": "array", "items": {"type": "object", "properties": {"sku": {"type": "string", "nullable": True}}}}}}}
    assert sev(lint_tool(tool), "warn")[0].path == "/properties/data/items/properties/sku/nullable"


@pytest.mark.parametrize("schema,ok", [({"type": ["string", "null"]}, True), ({"anyOf": [{"type": "string"}, {"type": "null"}]}, True),
                                       ({"type": "string"}, False), ({}, True), ({"enum": ["a", None]}, True)])
def test_allows_null(schema, ok):
    assert allows_null(schema) is ok


def test_schema_errors_paths():
    s = {"type": "object", "properties": {"message": {"type": "string"}, "data": {"type": "array", "items": {"type": "integer"}}}}
    errs = schema_errors(s, {"message": None, "data": [1, "x"]})
    assert [e["path"] for e in errs] == ["/data/1", "/message"]


def test_cases_loader(tmp_path: Path):
    p = tmp_path / "c.yaml"
    p.write_text("a:\n  - args: {x: 1}\n  - name: bad\n    args: {}\n    expect: error\nb:\n")
    c = load_cases(p)
    assert c["a"][1].expect == "error" and c["a"][1].name == "bad"
    assert c["b"][0].args == {}
    p.write_text("a:\n  - x: 1\n")
    with pytest.raises(CasesError):
        load_cases(p)
    j = tmp_path / "c.json"
    j.write_text('{"a": [{"args": {"k": "v"}}]}')
    assert load_cases(j)["a"][0].args == {"k": "v"}


def test_masking():
    register("supersecretvalue123")
    assert mask({"h": "x-api-key: supersecretvalue123"}) == {"h": "x-api-key: <SECRET>"}
    assert "supersecret" not in safe_url("https://u:supersecretvalue123@h.example/mcp?api_key=supersecretvalue123")
    assert mask("Authorization: Bearer abcdefghijklmnop") == "Authorization: Bearer <SECRET>"


def test_request_ids():
    ids = find_request_ids({"message": None, "requestId": "abc-123"}, None, ["error, requestId: 9f8e7d6c"])
    assert ids == ["requestId=abc-123", "requestId=9f8e7d6c"]


def test_tool_name_and_input_root_checks():
    bad = lint_tool({"name": "bad name!", "inputSchema": {"type": "array"}})
    assert any(f.schema == "name" and f.severity == "warn" and "MCP naming rule" in f.message for f in bad)
    assert any(f.schema == "inputSchema" and f.severity == "error" and f.path == "/type" for f in bad)
    assert lint_tool({"name": "ok.tool-1_x", "inputSchema": {"type": "object"}}) == []


def test_plain_language_details():
    from mcp_check.explain import mismatch_detail, schema_issues
    schema = {"type": "object", "properties": {"a": {"type": "string"}, "n": {"type": "integer"}},
              "required": ["a", "n", "b"]}
    issues = schema_issues(schema, {"a": None, "n": "x"})
    assert [(i["path"], i["kind"]) for i in issues] == [("/a", "null"), ("/b", "required"), ("/n", "type")]
    d = mismatch_detail(issues)
    assert d.startswith("3 problems with this response. Strict clients (like the Python SDK) will reject this response. (1) ")
    assert schema_issues(schema, None)[0]["kind"] == "missing_structured"

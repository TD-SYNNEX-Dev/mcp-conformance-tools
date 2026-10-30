"""Unit tests: --auto-cases arg building + deny/allow rules, the null sweep, the coverage line."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from mcp_check.auto_cases import (DEFAULT_DENY, AutoCaseError, auto_case, build_args, denied, eligibility, guessed_note,
                                  minimal_args, pattern_sample)
from mcp_check.lint import lint_schema
from mcp_check.null_sweep import null_sweep
from mcp_check.report import coverage_line
from mcp_check.runner import NOT_EXERCISED, PASS, Report, Row

MSG = {"type": "object", "properties": {"message": {"type": "string"}, "ok": {"type": "boolean"}},
       "required": ["message"]}


@pytest.mark.parametrize("name", ["submit_po", "create_quote", "update_cart", "delete_x", "place_order",
                                  "order_search", "send_invoice", "cancel_rma", "write_note", "post_comment",
                                  "SubmitPO", "reorder_items", "postal_lookup"])
def test_deny_list_blocks_write_like_names(name):
    assert denied(name)
    case, why = auto_case({"name": name, "inputSchema": {"type": "object"}})
    assert case is None and "its name suggests side effects (contains" in why


def test_deny_words_are_the_documented_set():
    assert set(DEFAULT_DENY) == {"submit", "create", "update", "delete", "place", "order", "send", "cancel",
                                 "write", "post"}


def test_extra_deny_and_allowlist_and_annotations():
    t = {"name": "get_invoice_pdf", "inputSchema": {"type": "object"}}
    assert eligibility(t) is None
    assert "suggests side effects (contains '*pdf*')" in eligibility(t, deny=["*pdf*"])
    assert "suggests side effects (contains 'invoice')" in eligibility(t, deny=["invoice"])
    assert "it is not in the auto-allow list" in eligibility(t, allow=["search_*"])
    assert eligibility(t, allow=["get_*"]) is None
    assert "suggests side effects" in eligibility({"name": "submit_po"}, allow=["*"])  # deny beats allow
    assert "(destructiveHint: true)" in eligibility({**t, "annotations": {"destructiveHint": True}})
    assert "(readOnlyHint: false)" in eligibility({**t, "annotations": {"readOnlyHint": False}})


def test_minimal_args_required_only_and_valid():
    schema = {
        "type": "object",
        "properties": {
            "keyword": {"type": "string", "minLength": 1},
            "page": {"type": "integer", "minimum": 1},
            "region": {"type": "string", "enum": ["US", "CA"]},
            "since": {"type": "string", "format": "date"},
            "flag": {"type": "boolean"},
            "ids": {"type": "array", "items": {"type": "string", "pattern": "^[0-9]+$"}, "minItems": 1},
            "filter": {"$ref": "#/$defs/F"},
            "optional": {"type": "string"},
            "maybe": {"anyOf": [{"type": "null"}, {"type": "integer", "minimum": 5}]},
        },
        "required": ["keyword", "page", "region", "since", "flag", "ids", "filter", "maybe"],
        "$defs": {"F": {"type": "object", "properties": {"k": {"type": "string", "default": "x"}},
                        "required": ["k"]}},
    }
    assert minimal_args(schema, today="2026-01-01") == {"keyword": "test", "page": 1, "region": "US",
                                                        "since": "2026-01-01", "flag": False, "ids": ["0"],
                                                        "filter": {"k": "x"}, "maybe": 5}
    assert minimal_args({"type": "object", "properties": {}}) == {}
    assert minimal_args({"type": "object"}) == {}


def test_minimal_args_refuses_when_it_cannot_satisfy_schema():
    with pytest.raises(AutoCaseError):
        minimal_args({"type": "object", "properties": {"sku": {"type": "string", "pattern": "^(?=9)[0-9]{8}$"}},
                      "required": ["sku"]})
    with pytest.raises(AutoCaseError):  # the sample can't satisfy maxLength
        minimal_args({"type": "object", "properties": {"sku": {"type": "string", "pattern": "^[0-9]{8}$",
                                                               "maxLength": 4}}, "required": ["sku"]})
    case, why = auto_case({"name": "get_sku", "inputSchema": {
        "type": "object", "properties": {"sku": {"type": "string", "pattern": "^(?=9)[0-9]{8}$"}}, "required": ["sku"]}})
    assert case is None and "could not build valid args" in why and "sku" in why


def test_auto_case_shape():
    case, why = auto_case({"name": "product_search", "inputSchema": {
        "type": "object", "properties": {"keyword": {"type": "string"}}, "required": ["keyword"]}})
    assert why == "" and case.args == {"keyword": "test"} and case.expect == "any" and case.name == "auto"


# ---------------------------------------------------------------- null sweep

def test_null_sweep_message_null():
    assert null_sweep(MSG, {"message": None, "ok": True}) == [
        {"path": "/message", "schema_path": "/properties/message",
         "message": "must be a string"}]


def test_null_sweep_nullable_is_ignored_and_called_out():
    schema = {"type": "object", "properties": {"message": {"type": "string", "nullable": True}}}
    [f] = null_sweep(schema, {"message": None})
    assert f["path"] == "/message" and f["message"] == ("must be a string; its `nullable: true` is an OpenAPI keyword "
                                                 "that JSON Schema ignores")


def test_null_sweep_allows_real_null_unions():
    for sub in ({"type": ["string", "null"]}, {"anyOf": [{"type": "string"}, {"type": "null"}]}, {},
                {"enum": ["a", None]}, {"const": None}):
        assert null_sweep({"type": "object", "properties": {"m": sub}}, {"m": None}) == []


def test_null_sweep_finds_every_nested_null():
    schema = {"type": "object", "properties": {
        "data": {"type": "array", "items": {"$ref": "#/$defs/Row"}},
        "meta": {"type": "object", "additionalProperties": {"type": "integer"}}},
        "$defs": {"Row": {"type": "object", "properties": {"sku": {"type": "string"},
                                                          "price": {"type": ["number", "null"]}}}}}
    inst = {"data": [{"sku": "A", "price": None}, {"sku": None}, {"sku": None, "price": 1}],
            "meta": {"count": None}, "extra": None}
    assert [f["path"] for f in null_sweep(schema, inst)] == ["/data/1/sku", "/data/2/sku", "/meta/count"]


def test_null_sweep_unknown_ref_is_not_guessed():
    assert null_sweep({"type": "object", "properties": {"m": {"$ref": "https://x/y.json"}}}, {"m": None}) == []


# ---------------------------------------------------------------- coverage

def test_coverage_line():
    r = Report(url="u", transport="http", sdk_version="x",
               tools=[{"name": "a"}, {"name": "b"}, {"name": "c"}, {"name": "d"}], filtered_out=["d"])
    r.rows = [Row("a", "lint", PASS), Row("a", "call[0]", PASS), Row("b", "call", NOT_EXERCISED),
              Row("c", "call[auto]", "WARN")]
    assert coverage_line(r) == "coverage: 3 tools, 2 exercised, 1 not exercised (b)"


# --------------------------------------------------------------------------- realistic values
# tests/auto_args_parity.json is shared with the Inspector fork (conformanceRules.test.ts runs the
# same fixture), so the CLI and the Conformance tab build the same args and lint the same way.
PARITY_FILE = Path(__file__).with_name("auto_args_parity.json")
PARITY = json.loads(PARITY_FILE.read_text())


@pytest.mark.parametrize("fx", PARITY["args"], ids=[c["name"] for c in PARITY["args"]])
def test_build_args_parity_fixture(fx):
    if "error" in fx:
        with pytest.raises(AutoCaseError) as e:
            build_args(fx["schema"], today=PARITY["today"])
        assert str(e.value) == fx["error"]
    else:
        assert build_args(fx["schema"], today=PARITY["today"]) == (fx["args"], fx["guessed"])


@pytest.mark.parametrize("fx", PARITY["lint"], ids=[c["name"] for c in PARITY["lint"]])
def test_description_hint_lint_parity_fixture(fx):
    got = [{"severity": f.severity, "path": f.path, "message": f.message}
           for f in lint_schema("inputSchema", fx["schema"]) if f.severity != "info"]
    assert got == fx["findings"]
    assert not [f for f in lint_schema("outputSchema", fx["schema"]) if f.severity == "warn"]  # input only


def test_parity_fixture_matches_the_inspector_copy():
    other = (Path(__file__).resolve().parents[2] / "mcp-inspector-fork" / "clients" / "web" / "src" / "utils"
             / "__fixtures__" / "auto_args_parity.json")
    if not other.exists():
        pytest.skip("the Inspector fork is not next to mcp-check")
    assert json.loads(other.read_text()) == PARITY


def test_prd_style_billing_tool_gets_realistic_args():
    tool = {"name": "get_billing_summary", "inputSchema": {"type": "object", "properties": {
        "startDate": {"type": "string", "description": "Start date filter (yyyy-MM-dd)."},
        "endDate": {"type": "string", "description": "End date filter (yyyy-MM-dd)."},
        "scope": {"type": "string", "description": "Enum: invoices, charges. Use charges for line items."},
        "limit": {"type": "integer"}}, "required": ["startDate", "endDate", "scope"]}}
    case, why = auto_case(tool)
    assert why == ""
    today = datetime.now(timezone.utc).date().isoformat()
    assert case.args == {"startDate": today, "endDate": today, "scope": "invoices"}
    assert [g["path"] for g in case.guessed] == ["startDate", "endDate", "scope"]
    assert guessed_note(case.guessed).startswith(" Values guessed from the description or name: startDate = ")


def test_placeholder_only_required_field_is_skipped_with_its_name():
    case, why = auto_case({"name": "get_thing", "inputSchema": {
        "type": "object", "properties": {"thing_id": {"type": "string"}, "note": {"type": "string"}},
        "required": ["thing_id"]}})
    assert case is None
    assert why == ("it can't build a realistic value for thing_id "
                   "(no enum, format, pattern, examples or description hint)")
    assert minimal_args({"type": "object", "properties": {"thing_id": {"type": "string"}}, "required": ["thing_id"]},
                        allow_placeholders=True) == {"thing_id": "test"}


@pytest.mark.parametrize("pattern,sample", [
    (r"^[0-9]{8}$", "00000000"), (r"^[A-Z]{2}-\d{4}$", "AA-0000"), (r"^(foo|bar)_[a-z]+$", "foo_a"),
    (r"^[^0-9]+$", "a"), (r"\.json$", ".json"), (r"^(?:ab){2,3}c?$", "abab"), (r"^\w+@\w+\.com$", "a@a.com"),
    (r"^(?=a)", None), (r"(a)\1", None), (r"^\p{L}+$", None),
])
def test_pattern_sample(pattern, sample):
    assert pattern_sample(pattern) == sample

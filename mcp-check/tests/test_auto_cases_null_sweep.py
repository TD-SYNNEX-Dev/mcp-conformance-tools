"""Unit tests: --auto-cases arg building + deny/allow rules, the null sweep, the coverage line."""

from __future__ import annotations

import pytest

from mcp_check.auto_cases import DEFAULT_DENY, AutoCaseError, auto_case, denied, eligibility, minimal_args
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
            "ids": {"type": "array", "items": {"type": "string"}, "minItems": 1},
            "filter": {"$ref": "#/$defs/F"},
            "optional": {"type": "string"},
            "maybe": {"anyOf": [{"type": "null"}, {"type": "integer", "minimum": 5}]},
        },
        "required": ["keyword", "page", "region", "since", "flag", "ids", "filter", "maybe"],
        "$defs": {"F": {"type": "object", "properties": {"k": {"type": "string", "default": "x"}},
                        "required": ["k"]}},
    }
    assert minimal_args(schema) == {"keyword": "test", "page": 1, "region": "US", "since": "2026-01-01",
                                    "flag": False, "ids": ["test"], "filter": {"k": "x"}, "maybe": 5}
    assert minimal_args({"type": "object", "properties": {}}) == {}
    assert minimal_args({"type": "object"}) == {}


def test_minimal_args_refuses_when_it_cannot_satisfy_schema():
    with pytest.raises(AutoCaseError):
        minimal_args({"type": "object", "properties": {"sku": {"type": "string", "pattern": "^[0-9]{8}$"}},
                      "required": ["sku"]})
    case, why = auto_case({"name": "get_sku", "inputSchema": {
        "type": "object", "properties": {"sku": {"type": "string", "pattern": "^[0-9]{8}$"}}, "required": ["sku"]}})
    assert case is None and "could not build valid args" in why


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

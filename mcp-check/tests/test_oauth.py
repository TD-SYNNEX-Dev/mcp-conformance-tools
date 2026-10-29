"""--oauth end to end against the demo server's auto-approving CIMD authorization server.

The "browser" is curl (via $BROWSER), which follows the /authorize redirect back to the
loopback callback, exactly like a real browser after login."""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from conftest import ROOT, _free_port
from mcp_check.masking import mask, register
from mcp_check.oauth import DEFAULT_CLIENT_METADATA_URL, client_metadata_document

CASES = str(ROOT / "tests" / "cases.demo.yaml")
CLIENT_ID = "https://example.test/mcp-check/client-metadata.json"


def run_oauth(url: str, home: Path, *args: str, browser: bool = True) -> subprocess.CompletedProcess:
    e = {k: v for k, v in os.environ.items() if not k.startswith("MCP_")}
    e.update({"PYTHONPATH": str(ROOT), "MCP_AUTH": "oauth", "MCP_CHECK_HOME": str(home),
              "MCP_CLIENT_METADATA_URL": CLIENT_ID, "MCP_OAUTH_PORT": str(_free_port()),
              "MCP_OAUTH_CALLBACK_TIMEOUT": "20"})
    if browser:
        e["BROWSER"] = "curl -s -L -o /dev/null %s"
    else:
        e["MCP_OAUTH_NO_BROWSER"] = "1"
    return subprocess.run([sys.executable, "-m", "mcp_check", "--url", url, *args],
                          env=e, capture_output=True, text=True, timeout=120)


@pytest.mark.skipif(shutil.which("curl") is None, reason="curl needed as the fake browser")
def test_oauth_signin_list_lint_call_and_token_reuse(demo_server_oauth, tmp_path: Path):
    out = tmp_path / "r.json"
    p = run_oauth(f"{demo_server_oauth}/mcp", tmp_path, "--cases", CASES, "--json", str(out))
    assert p.returncode == 1, p.stdout + p.stderr  # bad tools still FAIL; we got in
    assert "Opening your browser" in p.stderr and "client_id=" in p.stderr
    assert "https%3A%2F%2Fexample.test%2Fmcp-check%2Fclient-metadata.json" in p.stderr  # CIMD client_id
    rows = {(r["tool"], r["check"]): r for r in json.loads(out.read_text())["rows"]}
    assert rows[("good_tool", "call[0]")]["status"] == "PASS"
    assert rows[("null_message_tool", "call[0]")]["status"] == "FAIL"

    files = list((tmp_path / "oauth").glob("*.json"))
    assert len(files) == 1
    assert stat.S_IMODE(files[0].stat().st_mode) == 0o600
    assert stat.S_IMODE((tmp_path / "oauth").stat().st_mode) == 0o700
    stored = json.loads(files[0].read_text())
    at, rt = stored["tokens"]["access_token"], stored["tokens"]["refresh_token"]
    assert stored["client_info"]["client_id"] == CLIENT_ID
    for text in (p.stdout, p.stderr, out.read_text()):
        assert at not in text and rt not in text

    # Second run reuses stored tokens: no browser, no sign-in prompt.
    p2 = run_oauth(f"{demo_server_oauth}/mcp", tmp_path, "--no-calls", browser=False)
    assert p2.returncode == 0, p2.stdout + p2.stderr
    assert "Opening your browser" not in p2.stderr

    p3 = run_oauth(f"{demo_server_oauth}/mcp", tmp_path, "--oauth-logout")
    assert p3.returncode == 0 and "removed" in p3.stderr
    assert not list((tmp_path / "oauth").glob("*.json"))


def test_oauth_callback_timeout_is_a_clean_fail(demo_server_oauth, tmp_path: Path):
    e_home = tmp_path
    p = subprocess.run([sys.executable, "-m", "mcp_check", "--url", f"{demo_server_oauth}/mcp", "--oauth", "--no-calls"],
                       env={**{k: v for k, v in os.environ.items() if not k.startswith("MCP_")},
                            "PYTHONPATH": str(ROOT), "MCP_CHECK_HOME": str(e_home), "MCP_OAUTH_NO_BROWSER": "1",
                            "MCP_CLIENT_METADATA_URL": CLIENT_ID, "MCP_OAUTH_PORT": str(_free_port()),
                            "MCP_OAUTH_CALLBACK_TIMEOUT": "2"},
                       capture_output=True, text=True, timeout=60)
    assert p.returncode == 1
    assert "no OAuth callback" in p.stdout


def test_bad_metadata_url_is_usage_error(tmp_path: Path):
    p = subprocess.run([sys.executable, "-m", "mcp_check", "--url", "http://127.0.0.1:9/mcp", "--oauth"],
                       env={**{k: v for k, v in os.environ.items() if not k.startswith("MCP_")},
                            "PYTHONPATH": str(ROOT), "MCP_CHECK_HOME": str(tmp_path),
                            "MCP_CLIENT_METADATA_URL": "http://insecure.example/x.json"},
                       capture_output=True, text=True, timeout=60)
    assert p.returncode == 2 and "HTTPS" in p.stderr


def test_metadata_document_shape():
    doc = client_metadata_document(DEFAULT_CLIENT_METADATA_URL)
    assert doc["client_id"] == DEFAULT_CLIENT_METADATA_URL
    assert "http://127.0.0.1:33418/callback" in doc["redirect_uris"]
    assert doc["token_endpoint_auth_method"] == "none"
    published = ROOT / "client-metadata" / "client-metadata.json"
    if published.exists():
        assert json.loads(published.read_text()) == doc


def test_masking_oauth_fields():
    register("tok-abcdef-123456")
    assert "tok-abcdef-123456" not in mask("Authorization: Bearer tok-abcdef-123456")
    assert mask('{"access_token": "eyJhbGciOiJ.xyz", "token_type": "Bearer"}') == \
        '{"access_token": "<SECRET>", "token_type": "Bearer"}'
    assert mask("grant_type=refresh_token&refresh_token=abcdefghijk&x=1") == \
        "grant_type=refresh_token&refresh_token=<SECRET>&x=1"
    assert mask({"refresh_token": "zzzzzz", "ok": "fine"}) == {"refresh_token": "<SECRET>", "ok": "fine"}
    assert mask('{"code": "INVALID_ARGUMENT"}') == '{"code": "INVALID_ARGUMENT"}'


@pytest.mark.skipif(shutil.which("curl") is None, reason="curl needed as the fake browser")
def test_run_all_oauth_skips_inspector(demo_server_oauth, tmp_path: Path):
    e = {k: v for k, v in os.environ.items() if not k.startswith("MCP_")}
    e.update({"MCP_URL": f"{demo_server_oauth}/mcp", "MCP_AUTH": "oauth", "OUT_DIR": str(tmp_path / "out"),
              "PYTHON": sys.executable, "MCP_CHECK_HOME": str(tmp_path), "MCP_CLIENT_METADATA_URL": CLIENT_ID,
              "MCP_OAUTH_PORT": str(_free_port()), "BROWSER": "curl -s -L -o /dev/null %s"})
    p = subprocess.run(["bash", str(ROOT / "run-all.sh"), "--cases", CASES, "--only", "good_tool"], env=e,
                       capture_output=True, text=True, timeout=180)
    out = p.stdout + p.stderr
    assert "MCP Inspector CLI: SKIPPED (OAuth mode" in out, out
    assert p.returncode == 0, out
    assert "combined: inspector=0 mcp-check=0" in out


@pytest.mark.skipif(shutil.which("curl") is None, reason="curl needed as the fake browser")
def test_preregistered_client_id_is_used(demo_server_oauth, tmp_path: Path):
    preset = "https://preset.example.test/registered-client"
    e = {k: v for k, v in os.environ.items() if not k.startswith("MCP_")}
    e.update({"MCP_CHECK_HOME": str(tmp_path), "MCP_CLIENT_METADATA_URL": CLIENT_ID, "MCP_OAUTH_CLIENT_ID": preset,
              "MCP_OAUTH_PORT": str(_free_port()), "BROWSER": "curl -s -L -o /dev/null %s"})
    p = subprocess.run([sys.executable, "-m", "mcp_check", "--oauth", "--url", f"{demo_server_oauth}/mcp",
                        "--cases", CASES, "--only", "good_tool"], env=e, capture_output=True, text=True, timeout=120)
    out = p.stdout + p.stderr
    assert p.returncode == 0, out
    assert "client_id=https%3A%2F%2Fpreset.example.test%2Fregistered-client" in out
    assert f"client_id {preset}" in out


def test_oauth_without_client_config_is_usage_error(tmp_path: Path):
    p = subprocess.run([sys.executable, "-m", "mcp_check", "--url", "http://127.0.0.1:9/mcp", "--oauth"],
                       env={**{k: v for k, v in os.environ.items() if not k.startswith("MCP_")},
                            "PYTHONPATH": str(ROOT), "MCP_CHECK_HOME": str(tmp_path)},
                       capture_output=True, text=True, timeout=60)
    assert p.returncode == 2 and "MCP_CLIENT_METADATA_URL" in p.stderr

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
DEMO_KEY = "demo-test-key-0123456789"  # local throwaway key for the demo server only


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _start(env_extra: dict[str, str], script: str = "demo_server.py") -> tuple[subprocess.Popen, str]:
    port = _free_port()
    py = os.environ.get("DEMO_SERVER_PYTHON", sys.executable)  # lets a 1.x client venv reuse a 2.x server
    env = {**os.environ, **env_extra}
    proc = subprocess.Popen([py, str(ROOT / "tests" / script), "--port", str(port)], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    deadline = time.time() + 20
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return proc, f"http://127.0.0.1:{port}"
        except OSError:
            if proc.poll() is not None:
                raise RuntimeError(proc.stderr.read().decode())
            time.sleep(0.1)
    proc.kill()
    raise RuntimeError("demo server did not start")


@pytest.fixture(scope="session")
def demo_server():
    proc, base = _start({"DEMO_SERVER_API_KEY": ""})
    yield base
    proc.terminate()
    proc.wait(10)


@pytest.fixture(scope="session")
def demo_server_auth():
    proc, base = _start({"DEMO_SERVER_API_KEY": DEMO_KEY, "DEMO_SERVER_AUTH_HEADER": "X-API-Key"})
    yield base
    proc.terminate()
    proc.wait(10)


@pytest.fixture(scope="session")
def demo_server_oauth():
    proc, base = _start({"DEMO_SERVER_API_KEY": "", "DEMO_SERVER_OAUTH": "1"})
    yield base
    proc.terminate()
    proc.wait(10)


@pytest.fixture()
def sample_server(tmp_path):
    """tests/sample_bad_server.py (one tool per output bug + delete_record); yields (base_url, call_log)."""
    log = tmp_path / "calls.log"
    proc, base = _start({"MOCK_CALL_LOG": str(log)}, "sample_bad_server.py")
    yield base, log
    proc.terminate()
    proc.wait(10)

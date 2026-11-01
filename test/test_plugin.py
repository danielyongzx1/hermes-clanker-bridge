"""The plugin's Python half. Run with Hermes's Python, which has FastAPI:
    python -m unittest discover -s test
Set CLANKER_BRIDGE_NODE to a Node 22+ executable if `node` on PATH is older.
"""

from __future__ import annotations

import importlib.util
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent


def load(name: str, path: Path, package_dir: Path | None = None):
    spec = importlib.util.spec_from_file_location(
        name, path, submodule_search_locations=[str(package_dir)] if package_dir else None)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


plugin = load("clanker_bridge_plugin", ROOT / "__init__.py", ROOT)
supervisor = sys.modules["clanker_bridge_plugin.supervisor"]
api = load("clanker_bridge_api", ROOT / "dashboard" / "plugin_api.py")

KEY = "hermes-test-key-abcdefghijklmnopqrstuvwxyz"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def until(check, timeout=30.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.1)
    raise AssertionError("Timed out")


class FakeHermes(BaseHTTPRequestHandler):
    """Just enough of Hermes's API server for the bridge to list models."""

    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.headers.get("Authorization") != f"Bearer {KEY}":
            self.send_response(401)
            self.end_headers()
            return
        body = {
            "/v1/capabilities": {"features": {"run_status": True, "run_events_sse": True, "run_stop": True}},
            "/v1/models": {"data": [{"id": "hermes-agent"}]},
            "/api/model/options?include_unconfigured=false": {
                "provider": "local", "model": "qwen", "providers": [{"slug": "local", "authenticated": True, "models": ["qwen"]}],
            },
        }.get(self.path)
        self.send_response(200 if body else 404)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body or {}).encode())


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_a_token_is_made_once_and_kept(self):
        first = supervisor.load_connection(self.dir)
        self.assertRegex(first["bridgeToken"], r"^[0-9a-f]{64}$")
        self.assertEqual(supervisor.load_connection(self.dir), first)

    def test_a_damaged_file_is_reported_not_replaced(self):
        (self.dir / "connection.json").write_text("{nope", encoding="utf-8")
        with self.assertRaises(ValueError):
            supervisor.load_connection(self.dir)
        self.assertEqual((self.dir / "connection.json").read_text(encoding="utf-8"), "{nope")

    def test_importing_a_checkout_bridge_keeps_its_token_state_and_upstream(self):
        old = self.dir / "remote-bridge"
        old.mkdir()
        (old / "bridge.config.json").write_text(json.dumps({
            "kind": "hermes", "port": 8790, "upstreamUrl": "http://127.0.0.1:8642",
            "workspaceRoot": "./workspaces", "stateDir": "./.clanker-bridge",
        }), encoding="utf-8")
        (old / ".env").write_text("BRIDGE_TOKEN=ABCDEF0123456789ABCDEF0123456789\nHERMES_API_KEY=x\n", encoding="utf-8")
        data = self.dir / "data"
        data.mkdir()
        supervisor.load_connection(data)
        imported = supervisor.load_connection(data, str(old))
        self.assertEqual(imported["bridgeToken"], "ABCDEF0123456789ABCDEF0123456789")
        self.assertEqual(Path(imported["stateDir"]), (old / ".clanker-bridge").resolve())
        self.assertEqual(Path(imported["workspaceRoot"]), (old / "workspaces").resolve())
        self.assertEqual((imported["port"], imported["upstreamUrl"]), (8790, "http://127.0.0.1:8642"))
        # Importing the same folder again changes nothing.
        self.assertEqual(supervisor.load_connection(data, str(old)), imported)

    def test_importing_a_folder_without_a_bridge_fails(self):
        with self.assertRaises(ValueError):
            supervisor.load_connection(self.dir, str(self.dir))


class LockTests(unittest.TestCase):
    def test_only_one_holder_at_a_time(self):
        path = Path(tempfile.mkdtemp()) / "supervisor.lock"
        first, second = supervisor.ProcessLock(path), supervisor.ProcessLock(path)
        self.assertTrue(first.acquire())
        self.assertFalse(second.acquire())
        first.release()
        self.assertTrue(second.acquire())
        second.release()


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def test_states_without_a_running_bridge(self):
        self.assertEqual(api.pairing_state(self.dir)["state"], "not-started")
        supervisor.write_json(self.dir / "status.json", {"state": "port-busy", "error": "Port 8787 is in use"})
        self.assertEqual(api.pairing_state(self.dir)["error"], "Port 8787 is in use")
        supervisor.write_json(self.dir / "status.json", {"state": "running"})
        self.assertEqual(api.pairing_state(self.dir)["state"], "starting")
        supervisor.write_json(self.dir / "pairing.json", {"port": 1, "token": "t", "qr": "<svg/>"})
        self.assertEqual(api.pairing_state(self.dir, is_listening=lambda port: False)["state"], "stopped")
        live = api.pairing_state(self.dir, is_listening=lambda port: True)
        self.assertEqual((live["state"], live["token"], live["qr"]), ("running", "t", "<svg/>"))

    def test_the_route_refuses_unauthenticated_requests(self):
        request = SimpleNamespace(scope={"state": {"hosted_http_authenticated": False}})
        self.assertFalse(api.authorized(request))
        request = SimpleNamespace(scope={"state": {"hosted_http_authenticated": True}})
        self.assertTrue(api.authorized(request))


class RegisterTests(unittest.TestCase):
    def test_only_the_gateway_starts_the_bridge(self):
        started = []
        original = plugin.Supervisor
        plugin.Supervisor = lambda *args: SimpleNamespace(start=lambda: started.append(args), stop=lambda: None)
        previous = os.environ.pop("_HERMES_GATEWAY", None)
        unloads = []
        ctx = SimpleNamespace(get_config=lambda key: None, on_unload=unloads.append)
        try:
            plugin.register(ctx)
            self.assertEqual(started, [])
            os.environ["_HERMES_GATEWAY"] = "1"
            plugin.plugin_data_dir = lambda: Path(tempfile.mkdtemp())
            plugin.register(ctx)
            self.assertEqual(len(started), 1)
            self.assertEqual(len(unloads), 1)  # Stopped when Hermes unloads this copy.
        finally:
            plugin.Supervisor = original
            os.environ.pop("_HERMES_GATEWAY", None)
            if previous is not None:
                os.environ["_HERMES_GATEWAY"] = previous


class EndToEndTests(unittest.TestCase):
    def setUp(self):
        self.hermes = ThreadingHTTPServer(("127.0.0.1", 0), FakeHermes)
        threading.Thread(target=self.hermes.serve_forever, daemon=True).start()
        self.upstream = supervisor.Upstream(f"http://127.0.0.1:{self.hermes.server_address[1]}", KEY)
        self.dir = Path(tempfile.mkdtemp())
        self.port = free_port()

    def tearDown(self):
        self.hermes.shutdown()
        self.hermes.server_close()

    def run_supervisor(self, **settings):
        sup = supervisor.Supervisor(self.dir, supervisor.Settings(port=self.port, listen_address="127.0.0.1", **settings),
                                    lambda: self.upstream, restart_delay=0.5, wait_delay=0.5)
        sup.start()
        self.addCleanup(sup.stop)
        return sup

    def status(self):
        return supervisor.read_json(self.dir / "status.json") or {}

    def test_runs_the_bridge_pairs_and_stops_with_the_supervisor(self):
        sup = self.run_supervisor()
        until(lambda: self.status().get("state") == "running")
        pairing = until(lambda: api.pairing_state(self.dir) if api.pairing_state(self.dir).get("token") else None)
        token = supervisor.load_connection(self.dir)["bridgeToken"]
        self.assertEqual(pairing["token"], token)
        # Listening on 127.0.0.1 only, so there's no address a phone could use and no code.
        self.assertTrue(pairing["loopbackOnly"])
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}/v1/capabilities", headers={"Authorization": f"Bearer {token}"})
        info = json.loads(urllib.request.urlopen(request, timeout=10).read())
        self.assertEqual((info["kind"], info["modelSwitching"]), ("hermes", "any"))
        self.assertIn("local/qwen", info["models"])
        self.assertFalse(supervisor.ProcessLock(self.dir / "supervisor.lock").acquire())  # Held by the supervisor.
        until(lambda: (self.dir / "pairing.json").exists())
        sup.stop()
        self.assertEqual(self.status()["state"], "stopped")
        self.assertFalse(supervisor.port_in_use("127.0.0.1", self.port))
        lock = supervisor.ProcessLock(self.dir / "supervisor.lock")
        self.assertTrue(lock.acquire())
        lock.release()

    def test_a_reloaded_copy_takes_over_when_the_old_one_unloads(self):
        # As Hermes does while the gateway starts: the new copy registers before the old one unloads.
        old = self.run_supervisor()
        until(lambda: self.status().get("state") == "running")
        new = self.run_supervisor()
        time.sleep(1)
        self.assertTrue(supervisor.port_in_use("127.0.0.1", self.port))
        old.stop()
        until(lambda: self.status().get("state") == "running" and self.status().get("pid") not in (None, ""), timeout=40)
        self.assertTrue(supervisor.port_in_use("127.0.0.1", self.port))
        new.stop()
        self.assertEqual(self.status()["state"], "stopped")

    def test_waits_for_a_busy_port_instead_of_taking_it(self):
        blocker = socket.socket()
        blocker.bind(("127.0.0.1", self.port))
        blocker.listen()
        try:
            self.run_supervisor()
            until(lambda: self.status().get("state") == "port-busy")
        finally:
            blocker.close()
        until(lambda: self.status().get("state") == "running")

    def test_a_missing_api_key_is_explained(self):
        sup = supervisor.Supervisor(self.dir, supervisor.Settings(port=self.port), lambda: None, wait_delay=0.5)
        sup.start()
        self.addCleanup(sup.stop)
        self.assertIn("API_SERVER_KEY", until(lambda: self.status().get("error")))


if __name__ == "__main__":
    unittest.main()

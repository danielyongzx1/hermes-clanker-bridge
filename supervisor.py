"""Keeps the Clanker bridge running beside the Hermes gateway.

The bridge is the Node program in ``bridge/``. The gateway that loads this plugin starts it on
Hermes's own Node, restarts it if it stops, and stops it on unload or exit. An exclusive lock in the
plugin's data folder makes sure only one process per profile runs it. The settings page reads
``status.json`` and ``pairing.json`` from the same folder (see ``dashboard/plugin_api.py``).

Nothing here imports Hermes at module level, so the tests run it without a Hermes install.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

PLUGIN_ID = "hermes-clanker-bridge"
BRIDGE_DIR = Path(__file__).resolve().parent / "bridge"
DEFAULT_PORT = 8787
MIN_NODE_MAJOR = 22
RESTART_DELAY = 5.0
WAIT_DELAY = 10.0
LOCK_RETRY = 2.0
MAX_LOG_BYTES = 1_000_000
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
# The bridge gets these from the gateway's environment and nothing else, so provider keys and other
# secrets the gateway holds never reach it.
CHILD_ENV = (
    "PATH", "PATHEXT", "SYSTEMROOT", "SystemRoot", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP",
    "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "TZ",
)

log = logging.getLogger(f"hermes_plugins.{PLUGIN_ID}")


@dataclass(frozen=True)
class Settings:
    """From the plugin's settings in Hermes; a port of None keeps an imported bridge's port."""

    port: Optional[int] = None
    listen_address: str = "0.0.0.0"
    import_from: str = ""


@dataclass(frozen=True)
class Upstream:
    url: str
    key: str


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def write_json(path: Path, value) -> None:
    """Atomically, readable only by this user. Windows refuses to replace a file while a reader
    (the settings page) has it open, so that is retried briefly."""
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(value, handle)
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 19:
                tmp.unlink(missing_ok=True)
                raise
            time.sleep(0.05)


def read_env_file(path: Path) -> dict:
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip().removeprefix("export ").strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def valid_token(token) -> bool:
    return isinstance(token, str) and re.fullmatch(r"[A-Za-z0-9_-]{24,256}", token) is not None


def import_existing(folder: Path) -> dict:
    """What a bridge run from a Clanker checkout (tools/remote-bridge) needs to carry on under this
    plugin: its phone token, state and workspaces (so its chats resume), upstream and port."""
    config = read_json(folder / "bridge.config.json")
    if not isinstance(config, dict) or config.get("kind") != "hermes":
        raise ValueError(f"{folder} has no Hermes bridge.config.json to import.")
    env = folder / ".env"
    token = read_env_file(env).get("BRIDGE_TOKEN", "") if env.is_file() else ""
    if not valid_token(token):
        raise ValueError(f"{env} has no usable BRIDGE_TOKEN to import.")
    # Its relative paths were resolved against that folder, the old bridge's working directory.
    imported = {
        "bridgeToken": token,
        "stateDir": str((folder / config.get("stateDir", ".clanker-bridge")).resolve()),
        "workspaceRoot": str((folder / config.get("workspaceRoot", "./workspaces")).resolve()),
        "importedFrom": str(folder.resolve()),
    }
    for key in ("upstreamUrl", "port", "modelEfforts"):
        if key in config:
            imported[key] = config[key]
    return imported


def load_connection(data_dir: Path, import_from: str = "") -> dict:
    """The bridge's lasting identity: the token the phone pairs with, and where an imported bridge
    keeps its state. Created once; a damaged file is reported rather than replaced, since a new
    token would unpair the phone."""
    path = data_dir / "connection.json"
    saved = read_json(path)
    if saved is None and path.exists():
        raise ValueError(f"{path} is damaged. Restore it, or delete it to pair the phone again.")
    if saved is not None and (not isinstance(saved, dict) or saved.get("version") != 1 or not valid_token(saved.get("bridgeToken"))):
        raise ValueError(f"{path} is damaged. Restore it, or delete it to pair the phone again.")
    if import_from:
        folder = Path(import_from).expanduser()
        if str(folder.resolve()) != (saved or {}).get("importedFrom"):
            saved = {"version": 1, **import_existing(folder)}
            write_json(path, saved)
    if saved is None:
        saved = {"version": 1, "bridgeToken": secrets.token_hex(32)}
        write_json(path, saved)
    return saved


def hermes_api_server() -> Optional[Upstream]:
    """This gateway's API server address and key, read the way its own adapter reads them, or None
    when the server has no key (it then refuses to start)."""
    host, port, key = None, None, None
    try:
        from gateway.config import Platform, load_gateway_config

        platform = load_gateway_config().platforms.get(Platform.API_SERVER)
        if platform is not None:
            # config.yaml's platforms.api_server wins over the environment, as in the adapter.
            extra = dict(platform.extra or {})
            key, host, port = extra.get("key"), extra.get("host"), extra.get("port")
    except Exception:  # Older or newer Hermes layouts: fall back to the documented variables.
        log.debug("Could not read the gateway's API server config", exc_info=True)
    if not key:
        try:
            from agent.secret_scope import get_secret

            key = get_secret("API_SERVER_KEY")
        except Exception:
            key = os.environ.get("API_SERVER_KEY")
    if not key:
        return None
    host = host or os.environ.get("API_SERVER_HOST") or "127.0.0.1"
    try:
        port = int(port or os.environ.get("API_SERVER_PORT") or 8642)
    except ValueError:
        port = 8642
    connect = "127.0.0.1" if host in ("0.0.0.0", "::", "", "localhost") else host
    if ":" in connect:
        connect = f"[{connect}]"
    return Upstream(f"http://{connect}:{port}", key)


def node_major(path: str) -> Optional[int]:
    try:
        out = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=15, creationflags=NO_WINDOW).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.match(r"v(\d+)\.", out.strip())
    return int(match.group(1)) if match else None


def find_node(hermes_home: Optional[Path]) -> Optional[str]:
    """Node 22 or newer: an explicit CLANKER_BRIDGE_NODE, the gateway's PATH (where Hermes puts its
    managed Node), then the Node Hermes ships in its home folder."""
    candidates = [os.environ.get("CLANKER_BRIDGE_NODE"), shutil.which("node")]
    if hermes_home:
        candidates += [hermes_home / "node" / "node.exe", hermes_home / "node" / "bin" / "node", hermes_home / "node" / "node"]
    seen = set()
    for candidate in candidates:
        if not candidate or str(candidate) in seen or not Path(candidate).is_file():
            continue
        seen.add(str(candidate))
        major = node_major(str(candidate))
        if major is not None and major >= MIN_NODE_MAJOR:
            return str(candidate)
    return None


def probe_host(host: str) -> str:
    return "127.0.0.1" if host in ("0.0.0.0", "::", "") else host


def port_in_use(host: str, port: int) -> bool:
    try:
        with socket.create_connection((probe_host(host), port), timeout=1):
            return True
    except OSError:
        return False


class ProcessLock:
    """An exclusive OS lock on a file; released automatically if the process dies."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._handle = None

    def acquire(self) -> bool:
        handle = open(self.path, "a+b")
        try:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            return False
        self._handle = handle
        return True

    def release(self) -> None:
        handle, self._handle = self._handle, None
        if handle is None:
            return
        try:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


class Supervisor:
    """Runs the bridge until stopped, restarting it after it exits and reporting each state."""

    def __init__(
        self,
        data_dir: Path,
        settings: Settings,
        upstream: Callable[[], Optional[Upstream]],
        hermes_home: Optional[Path] = None,
        *,
        restart_delay: float = RESTART_DELAY,
        wait_delay: float = WAIT_DELAY,
    ) -> None:
        self.data_dir = data_dir
        self.settings = settings
        self._upstream = upstream
        self._hermes_home = hermes_home
        self._restart_delay = restart_delay
        self._wait_delay = wait_delay
        self._lock = ProcessLock(data_dir / "supervisor.lock")
        self._stopping = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._process: Optional[subprocess.Popen] = None
        self._guard = threading.Lock()
        self._locked = False

    def start(self) -> None:
        """Begins supervising in the background, once this supervisor holds the profile's lock."""
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._thread = threading.Thread(target=self._run, name=f"{PLUGIN_ID}-supervisor", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._stopping.is_set():
            return
        self._stopping.set()
        self._terminate()
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=15)
        if self._locked:
            self._status("stopped")
            self._lock.release()

    def _status(self, state: str, error: str = "", **extra) -> None:
        try:
            write_json(self.data_dir / "status.json", {"state": state, "error": error, "updatedAt": time.time(), **extra})
        except OSError:
            log.warning("Clanker bridge: could not write its status", exc_info=True)

    def _wait(self, seconds: float) -> None:
        self._stopping.wait(seconds)

    def _run(self) -> None:
        # Hermes loads a plugin several times as the gateway starts, and a new copy registers before
        # the old one unloads. So the new one waits for the old to stop and release the lock, rather
        # than giving up. Another process with the lock (a second gateway) keeps it waiting too.
        while not self._lock.acquire():
            if self._stopping.wait(LOCK_RETRY):
                return
        self._locked = True
        if self._stopping.is_set():
            self._lock.release()
            self._locked = False
            return
        while not self._stopping.is_set():
            try:
                delay = self._run_once()
            except Exception as error:
                log.warning("Clanker bridge could not start: %s", error)
                self._status("failed", str(error))
                delay = self._wait_delay
            self._wait(delay)

    def _run_once(self) -> float:
        """Starts the bridge and waits for it to exit; returns how long to wait before trying again."""
        connection = load_connection(self.data_dir, self.settings.import_from)
        upstream = self._upstream()
        if upstream is None:
            self._status("failed", "Hermes's API server has no key. Set API_SERVER_ENABLED=true and API_SERVER_KEY in "
                         "Hermes's .env, then restart the gateway.")
            return self._wait_delay * 3
        node = find_node(self._hermes_home)
        if node is None:
            self._status("failed", f"Node.js {MIN_NODE_MAJOR} or newer was not found. Hermes normally ships it; "
                         "set CLANKER_BRIDGE_NODE to a Node executable otherwise.")
            return self._wait_delay * 3
        host = self.settings.listen_address or "0.0.0.0"
        port = int(self.settings.port or connection.get("port") or DEFAULT_PORT)
        if port_in_use(host, port):
            self._status("port-busy", f"Port {port} is already in use, for example by a bridge started from a Clanker "
                         "checkout. Stop that program, or change this plugin's port.", port=port)
            return self._wait_delay
        config = {
            "host": host,
            "port": port,
            "upstreamUrl": connection.get("upstreamUrl") or upstream.url,
            "stateDir": connection.get("stateDir") or str(self.data_dir / "state"),
            "workspaceRoot": connection.get("workspaceRoot") or str(self.data_dir / "workspaces"),
            "dataDir": str(self.data_dir),
        }
        if connection.get("modelEfforts"):
            config["modelEfforts"] = connection["modelEfforts"]
        env = {name: os.environ[name] for name in CHILD_ENV if name in os.environ}
        env.update(CLANKER_BRIDGE_CONFIG=json.dumps(config), BRIDGE_TOKEN=connection["bridgeToken"], HERMES_API_KEY=upstream.key)
        log_path = self.data_dir / "bridge.log"
        if log_path.exists() and log_path.stat().st_size > MAX_LOG_BYTES:
            log_path.replace(log_path.with_suffix(".log.old"))
        with open(log_path, "ab") as output, self._guard:
            if self._stopping.is_set():
                return 0
            self._process = subprocess.Popen(
                [node, str(BRIDGE_DIR / "main.mjs")], cwd=str(BRIDGE_DIR), env=env,
                stdin=subprocess.PIPE, stdout=output, stderr=subprocess.STDOUT, creationflags=NO_WINDOW,
            )
        process = self._process
        self._status("starting", port=port, pid=process.pid)
        running = False
        while process.poll() is None:
            if not running and port_in_use(host, port):
                running = True
                self._status("running", port=port, pid=process.pid)
                log.info("Clanker bridge running on port %s", port)
            try:
                process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                pass
        if self._stopping.is_set():
            return 0
        self._status("failed", f"The bridge stopped (exit code {process.returncode}): {last_line(log_path)} "
                     "Restarting it.", port=port)
        return self._restart_delay

    def _terminate(self) -> None:
        with self._guard:
            process = self._process
        if process is None or process.poll() is not None:
            return
        try:
            process.stdin.close()  # The bridge closes cleanly when its stdin ends.
            process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()


def last_line(path: Path) -> str:
    """The log's last meaningful line: Node ends a crash with stack frames and its own version."""
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()[-200:]
    except OSError:
        return ""
    lines = [line.strip() for line in lines if line.strip() and not re.match(r"\s*(at |Node\.js v|\^|})", line)]
    return lines[-1][:300] if lines else ""

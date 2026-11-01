"""The settings page's backend: GET /api/plugins/hermes-clanker-bridge/pairing.

It reads what the gateway's supervisor and the bridge write to the plugin's data folder, so it
works whether this route runs in the gateway or in Hermes's separate plugin host.
"""

from __future__ import annotations

import json
import socket
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

PLUGIN_ID = "hermes-clanker-bridge"
PAIRING_FIELDS = ("name", "addresses", "qr", "loopbackOnly", "token", "bridgeId", "port")

router = APIRouter()


def data_dir() -> Path:
    from hermes_cli.plugins_state import PluginState

    return PluginState(PLUGIN_ID).data_dir


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def listening(port) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=1):
            return True
    except (OSError, TypeError, ValueError):
        return False


def authorized(request: Request) -> bool:
    """Hermes's own guard for sensitive routes: Desktop's native grant or a dashboard session, or the
    decision the plugin host forwards. The dashboard's sign-in gate covers plugin routes, but it is
    off for a local-only dashboard, and this route returns the bridge token."""
    state = request.scope.get("state") or {}
    if "hosted_http_authenticated" in state:
        return state["hosted_http_authenticated"] is True
    try:
        from hermes_cli.plugin_host_http_auth import admitted_for_sensitive_route
    except ImportError:
        # A Hermes without this (private) check: rely on the dashboard's documented gate alone.
        return True
    try:
        return admitted_for_sensitive_route(request)
    except Exception:
        return False


def pairing_state(folder: Path, is_listening=listening) -> dict:
    status = read_json(folder / "status.json")
    if not isinstance(status, dict):
        return {"state": "not-started", "error": "The bridge starts with the Hermes gateway. Restart the gateway after "
                "enabling this plugin."}
    result = {"state": status.get("state", "starting"), "error": status.get("error", ""), "log": str(folder / "bridge.log")}
    if result["state"] != "running":
        return result
    pairing = read_json(folder / "pairing.json")
    if not isinstance(pairing, dict):
        return {**result, "state": "starting"}
    if not is_listening(pairing.get("port")):
        return {**result, "state": "stopped", "error": "The bridge isn't running. Start the Hermes gateway."}
    return {**result, **{key: pairing.get(key) for key in PAIRING_FIELDS}, "file": str(folder / "pairing.html")}


@router.get("/pairing")
async def pairing(request: Request):
    if not authorized(request):
        return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return JSONResponse(pairing_state(data_dir()), headers={"Cache-Control": "no-store"})

"""Clanker bridge for Hermes: lets the Clanker phone app use this Hermes agent remotely.

Only the gateway runs the bridge. Hermes loads plugins in every process (CLI chats, cron, tool
runs), and those leave it alone. The pairing code is on this plugin's page under Settings → Plugins
in Hermes Desktop.
"""

from __future__ import annotations

import atexit
import logging
import os
import sys
from pathlib import Path

from .supervisor import PLUGIN_ID, Settings, Supervisor, hermes_api_server

log = logging.getLogger(f"hermes_plugins.{PLUGIN_ID}")


def plugin_data_dir() -> Path:
    """This profile's data folder for the plugin; ``dashboard/plugin_api.py`` reads the same one."""
    from hermes_cli.plugins_state import PluginState

    return PluginState(PLUGIN_ID).data_dir


def _hermes_home():
    try:
        from hermes_constants import get_hermes_home

        return get_hermes_home()
    except Exception:
        return None


def _settings(ctx) -> Settings:
    port = ctx.get_config("port")
    try:
        port = int(port) if port not in (None, "") else None
    except (TypeError, ValueError):
        log.warning("Clanker bridge: ignoring port setting %r; it must be a number", port)
        port = None
    return Settings(
        port=port,
        listen_address=str(ctx.get_config("listen_address") or "0.0.0.0").strip(),
        import_from=str(ctx.get_config("import_from") or "").strip(),
    )


def in_gateway(argv=None) -> bool:
    """Whether this process is the Hermes gateway. It sets _HERMES_GATEWAY as it starts, which can be
    after it loads plugins, so its command line (``hermes gateway run``, or ``python -m
    hermes_cli.main gateway run`` from its scheduled task or service) counts as well."""
    if os.environ.get("_HERMES_GATEWAY") == "1":
        return True
    args = list(sys.argv[1:] if argv is None else argv)
    return any(arg == "gateway" and args[i + 1:i + 2] == ["run"] for i, arg in enumerate(args))


def register(ctx) -> None:
    supervisor = Supervisor(plugin_data_dir(), _settings(ctx), hermes_api_server, _hermes_home())
    # Elsewhere (CLI chats, cron, tools) it gives up after a while without doing anything.
    supervisor.start(when=in_gateway)
    ctx.on_unload(supervisor.stop)
    atexit.register(supervisor.stop)

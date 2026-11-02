# Clanker Bridge for Hermes

Use your [Hermes](https://hermes-agent.nousresearch.com/) agent from [Clanker](https://github.com/danielyongzx1/Clanker) on your phone: streamed replies and reasoning, approvals and questions, model switching, effort selection and file transfer both ways.

The plugin runs the Clanker bridge alongside the Hermes gateway, on the Node.js that Hermes ships with. It starts and stops with the gateway, and it shows the pairing QR code in Hermes Desktop. You don't need a Clanker checkout, a separate Node install or a startup script.

## Before you install

Turn on Hermes's API server, which the bridge talks to. In your Hermes profile's `.env` (`~/.hermes/.env`, or `%LOCALAPPDATA%\hermes\.env` on Windows):

```dotenv
API_SERVER_ENABLED=true
API_SERVER_KEY=replace-with-a-long-random-key
```

The bridge reads this key from Hermes itself; the phone never sees it. Set up Hermes's model provider and file tools as usual.

## Install

**Hermes Desktop:** in **Plugins**, open **Install plugin**, enter `https://github.com/danielyongzx1/hermes-clanker-bridge` and choose **Review repository**. Install it with both its agent and desktop parts, and enable it.

**Command line:**

```sh
hermes plugins install danielyongzx1/hermes-clanker-bridge --enable
```

Then restart the gateway so it starts the bridge:

```sh
hermes gateway restart
```

## Pair your phone

1. In Hermes Desktop, open **Settings → Plugins → Clanker bridge**. It shows a QR code, the PC's addresses and the bridge token.
2. In Clanker, open **Settings → Backends → Add remote backend**, tap **Scan QR code** and scan it. Clanker fills in the addresses and token and tests them.
3. Choose a model for new chats, then **Save**.

To reconnect after the PC's address changes, open the backend in Clanker and scan the code again. Its chats carry on.

Without Hermes Desktop, open `pairing.html` from the plugin's data folder (below) in a browser on the PC. It shows the same code.

The bridge listens on port **8787**. Allow it on your private network in the firewall. Your phone needs a route to the PC over the same LAN or a private VPN; for internet access, put an HTTPS reverse proxy in front.

## Settings

In Hermes Desktop under **Settings → Plugins → Clanker bridge → Agent settings**, or in `config.yaml` under `plugins.entries.hermes-clanker-bridge.settings`. Restart the gateway after changing them.

| Setting | Default | Meaning |
| --- | --- | --- |
| `port` | `8787` | Port the phone connects to. |
| `listen_address` | `0.0.0.0` | Listen on LAN/VPN interfaces. `127.0.0.1` limits it to this PC. |
| `import_from` | empty | Take over a bridge you ran from a Clanker checkout; see below. |

## Moving from a bridge run from a Clanker checkout

If you already run `tools/remote-bridge` from a Clanker checkout, the plugin can take it over, keeping the phone's pairing, chats and files:

1. Stop the old bridge. If you used `npm run hermes:autostart`, delete the **Clanker Hermes Bridge** shortcut from your Windows Startup folder (`shell:startup`), then end its `node` processes (`run-hermes.mjs` and `src/main.mjs bridge.config.json`).
2. Set `import_from` to that folder, for example `C:\Users\you\Clanker\tools\remote-bridge`.
3. Restart the gateway.

The plugin reads the old token from that folder's `.env`, and keeps using its state and workspace folders where they are, so don't delete them. Until the old bridge stops, the plugin waits for its port rather than taking it.

## Files

The plugin keeps its files in `plugin-data/agent-plugin-hermes-clanker-bridge-<id>` in your Hermes home:

- `connection.json`: the bridge token your phone pairs with. Deleting it unpairs the phone.
- `pairing.json`, `pairing.html`: the pairing details and code. Keep them private; like the token, they give access to your agent.
- `status.json`, `bridge.log`: what the bridge is doing.
- `state/`, `workspaces/`: chat sessions, file versions and each chat's working folder.

Hermes reads and writes files for a chat in its workspace folder, so Hermes's file and terminal tools must be able to see it. A local terminal backend works as is.

## How it works

- Hermes loads plugins in every process, but only the gateway (`gateway run`) runs the bridge. A lock in the data folder keeps it to one bridge per profile, and hands over cleanly when Hermes reloads the plugin.
- The gateway starts `bridge/main.mjs` on Node 22 or newer: from its `PATH`, which includes the Node Hermes manages, or from Hermes's own `node` folder. Set `CLANKER_BRIDGE_NODE` to use another. The bridge gets only the bridge token, Hermes's API key and basic system variables, not the gateway's other secrets.
- If the bridge stops, the gateway starts it again. When the gateway exits, the bridge exits too.
- The settings page reads `/api/plugins/hermes-clanker-bridge/pairing`, which answers only Hermes Desktop or a signed-in dashboard session.

The code in `bridge/` is the same as Clanker's `tools/remote-bridge`, without the DeepSeek Harness adapter, and with the QR encoder vendored in `bridge/vendor`.

## Development

```sh
# Bridge, on Hermes's Node:
node --test test/*.test.mjs
# Plugin, on Hermes's Python (it has FastAPI):
python -m unittest discover -s test
# Hermes's own checks:
hermes plugins validate .
```

The validator warns about one private Hermes import: the pairing route reuses Hermes's own check for sensitive routes, because plugin routes are otherwise open on a local-only dashboard. If a Hermes update removes that check, the route falls back to the dashboard's documented sign-in gate.

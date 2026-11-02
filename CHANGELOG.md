# Changelog

## 0.1.2

- Fix the bridge not starting with the gateway: Hermes can load plugins before the gateway marks itself (`_HERMES_GATEWAY`), so the plugin took the gateway for another process. It now also recognises the gateway's command line (`gateway run`), and otherwise waits up to two minutes for the mark.

## 0.1.1

- Fix the bridge not starting after a gateway restart: Hermes loads a plugin several times as the gateway starts, and a newer copy gave up while an older one still held the profile's lock. It now waits and takes over when the older copy unloads.
- Retry status and pairing writes that Windows refuses while the settings page is reading them.

## 0.1.0

- Run the Clanker bridge as a Hermes plugin: the gateway starts it on Hermes's own Node, keeps it running and stops it with itself. Only one gateway per profile runs it.
- Read Hermes's API server address and key from Hermes; the phone gets its own bridge token, created on first start.
- Show the pairing QR code, addresses and token in Hermes Desktop under Settings → Plugins → Clanker bridge, and in a private `pairing.html`.
- Take over a bridge run from a Clanker checkout (`import_from`), keeping its token, chats and files.
- A chat can switch to any of Hermes's models after it starts.

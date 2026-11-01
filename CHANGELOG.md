# Changelog

## 0.1.0

- Run the Clanker bridge as a Hermes plugin: the gateway starts it on Hermes's own Node, keeps it running and stops it with itself. Only one gateway per profile runs it.
- Read Hermes's API server address and key from Hermes; the phone gets its own bridge token, created on first start.
- Show the pairing QR code, addresses and token in Hermes Desktop under Settings → Plugins → Clanker bridge, and in a private `pairing.html`.
- Take over a bridge run from a Clanker checkout (`import_from`), keeping its token, chats and files.
- A chat can switch to any of Hermes's models after it starts.

import { writeFile } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';
import qrcode from './vendor/qrcode-generator.mjs';

const KIND_LABELS = { hermes: 'Hermes', harness: 'Harness' };
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Addresses a phone can reach the bridge on; a loopback listener has none. */
export function pairingAddresses(host, port, interfaces = networkInterfaces()) {
  if (LOOPBACK.includes(host)) return [];
  if (host && !['0.0.0.0', '::'].includes(host)) return [{ name: host, url: `http://${host.includes(':') ? `[${host}]` : host}:${port}` }];
  return Object.entries(interfaces).flatMap(([name, entries]) => (entries ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .map((a) => ({ name, url: `http://${a.address}:${port}` })));
}

/** What the QR code holds. Clanker fills in a backend from it, and matches a saved one by bridge identity. */
export function pairingLink({ bridgeId, token, name, urls }) {
  const query = [['bridge', bridgeId], ['token', token], ['name', name], ...urls.map((url) => ['url', url])];
  return `clanker://pair?${query.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
}

/** The name, current addresses and QR code (an SVG; empty when the phone can't reach the bridge). */
export function pairingDetails({ kind, bridgeId, token, host = '0.0.0.0', port, name = `${KIND_LABELS[kind]} · ${hostname()}`, interfaces }) {
  const addresses = pairingAddresses(host, port, interfaces);
  let qr = '';
  if (addresses.length) {
    const code = qrcode(0, 'M');
    code.addData(pairingLink({ bridgeId, token, name, urls: addresses.map((a) => a.url) }));
    code.make();
    qr = code.createSvgTag({ cellSize: 4, margin: 4, scalable: true, alt: 'Clanker pairing code' });
  }
  return { name, addresses, qr, loopbackOnly: LOOPBACK.includes(host) };
}

export function pairingHtml(options) {
  const { token, host = '0.0.0.0' } = options;
  const { name, addresses, qr } = pairingDetails(options);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Pair Clanker</title>
<style>:root{color-scheme:light dark;font:16px/1.55 system-ui,sans-serif}body{max-width:600px;margin:48px auto;padding:0 24px}h1{font-size:28px;letter-spacing:-.6px;margin-bottom:8px}h2{font-size:17px;margin-top:28px}p{margin:8px 0 16px}label{display:block;margin-top:16px;font-size:14px}input{box-sizing:border-box;width:100%;padding:10px 12px;font:14px/1.5 ui-monospace,monospace;border:1px solid #8886;border-radius:6px;background:transparent;color:inherit}button{margin-top:8px;padding:7px 12px;font:inherit;border:1px solid #8886;border-radius:6px;cursor:pointer}li{margin:8px 0}.qr{width:260px;max-width:100%;margin:16px 0;border-radius:8px;overflow:hidden}.qr svg{display:block;width:100%;height:auto}.note{margin-top:32px;border-top:1px solid #8884;padding-top:16px;font-size:14px}</style>
<h1>Pair Clanker with this PC</h1>
${qr ? `<p>In Clanker, open <strong>Settings → Backends</strong>, then <strong>Add remote backend</strong>, or this backend to reconnect it. Tap <strong>Scan QR code</strong>, then <strong>Save</strong>.</p><div class="qr">${qr}</div><p>Your phone’s camera can also open the code in Clanker. A backend already saved for this bridge keeps its chats.</p><h2>Or enter it by hand</h2>` : `<p>In Clanker, open <strong>Settings → Backends → Add remote backend</strong>.</p>`}
<label>Connection name<input readonly value="${escape(name)}"></label>
${addresses.map((a, i) => `<label>Address · ${escape(a.name)}<input id="address${i}" readonly value="${escape(a.url)}"></label><button type="button" data-copy="address${i}">Copy address</button>`).join('') || (LOOPBACK.includes(host) ? `<p>This bridge only accepts connections from this PC (${escape(host)}). Set its host to 0.0.0.0 to reach it from your phone.</p>` : '<p>No LAN address was found. Connect this PC to your network, then restart the bridge to refresh these instructions.</p>')}
<label>Bridge token<input id="token" readonly value="${escape(token)}" autocomplete="off" spellcheck="false"></label><button type="button" data-copy="token">Copy token</button><p id="status" aria-live="polite"></p>
<h2>Finish on your phone</h2><ol><li>Enter a name, the PC’s Wi-Fi/Ethernet address, and the bridge token.</li><li>Tap <strong>Test connection</strong>, choose a model, and <strong>Save</strong>.</li><li>Start a new chat and select the saved backend.</li></ol>
<p class="note">Keep the bridge running. The saved connection stays the same across restarts. Your phone needs a route to this PC through the same LAN or a private VPN. Use an HTTPS reverse proxy for internet access. Keep this file, its code and token private: they give access to this agent.</p>
<script>for(const b of document.querySelectorAll('[data-copy]'))b.addEventListener('click',async()=>{const input=document.getElementById(b.dataset.copy);try{await navigator.clipboard.writeText(input.value);document.getElementById('status').textContent='Copied.'}catch{input.select();document.getElementById('status').textContent='Press Ctrl+C to copy the selected text.'}});</script></html>`;
}

/** Pairing is a private local file, never an unauthenticated HTTP endpoint. */
export async function writePairingPage(file, options) {
  await writeFile(file, pairingHtml(options), { mode: 0o600 });
  return file;
}

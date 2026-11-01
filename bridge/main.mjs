// The bridge as the Hermes plugin runs it: started by the plugin's supervisor (supervisor.py) inside
// the Hermes gateway, which passes the configuration as JSON and the two secrets in the environment.
// It keeps the pairing details current for the plugin's settings page, and exits when the
// supervisor's end of stdin closes, so it never outlives the gateway that started it.
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createBridge } from './server.mjs';
import { pairingDetails, writePairingPage } from './pairing.mjs';

const config = JSON.parse(process.env.CLANKER_BRIDGE_CONFIG ?? '{}');
const token = process.env.BRIDGE_TOKEN;
const upstreamKey = process.env.HERMES_API_KEY;
delete process.env.BRIDGE_TOKEN;
delete process.env.HERMES_API_KEY;
if (!config.dataDir) throw new Error('CLANKER_BRIDGE_CONFIG has no dataDir.');
if (!upstreamKey) throw new Error('Hermes API_SERVER_KEY is not set.');

const bridge = await createBridge({ ...config, kind: 'hermes', token, upstreamKey });
let stopping;
const stop = () => (stopping ??= bridge.close().finally(() => process.exit(0)));
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdin.resume();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);

try {
  await new Promise((resolve, reject) => { bridge.server.once('error', reject); bridge.server.listen(config.port, config.host, resolve); });
} catch (error) {
  console.error(`Could not listen on ${config.host}:${config.port}: ${error.message}`);
  await bridge.close();
  process.exit(3);
}
console.log(`Clanker hermes bridge listening on ${config.host}:${config.port}. Identity: ${bridge.state.bridgeId}`);

// Rewritten when the PC's addresses change, so a refresh of the settings page shows the current ones.
const pairing = { kind: 'hermes', bridgeId: bridge.state.bridgeId, token, host: config.host, port: config.port };
let published = '';
async function publish() {
  const body = JSON.stringify({ bridgeId: bridge.state.bridgeId, token, port: config.port, ...pairingDetails(pairing) });
  if (body === published) return;
  const file = path.join(config.dataDir, 'pairing.json');
  await writeFile(`${file}.tmp`, body, { mode: 0o600 });
  // Windows refuses to replace a file while the settings page is reading it.
  for (let attempt = 0; ; attempt++) {
    try { await rename(`${file}.tmp`, file); break; }
    catch (error) { if (attempt >= 19 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error; await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  await writePairingPage(path.join(config.dataDir, 'pairing.html'), pairing);
  published = body;
}
const republish = () => publish().catch((error) => console.error(`Could not write the pairing details: ${error.message}`));
await republish();
setInterval(republish, 30000).unref();

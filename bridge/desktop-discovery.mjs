import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export function desktopIdentity(config) {
  const discovery = config.desktopDiscovery;
  if (!discovery) return;
  if (config.kind !== 'harness' || typeof discovery.profileId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(discovery.profileId) || typeof discovery.file !== 'string') throw new Error('Invalid Harness Desktop discovery configuration.');
  return `harness-desktop:${discovery.profileId}`;
}

export async function harnessEndpoint(config) {
  if (!config.desktopDiscovery) return { url: config.upstreamUrl, token: config.launchToken, key: config.upstreamUrl + '\0' + config.launchToken };
  desktopIdentity(config);
  const file = path.resolve(config.desktopDiscovery.file);
  let data;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('Invalid discovery file.');
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Open Harness Desktop to connect. Its Clanker plugin publishes the connection automatically.');
    throw new Error('Harness Desktop discovery is unreadable. Check the Clanker plugin configuration.');
  }
  if (data.version !== 1 || data.profileId !== config.desktopDiscovery.profileId || typeof data.launchToken !== 'string' || data.launchToken.length < 16 || typeof data.generation !== 'string') throw new Error('Harness Desktop profile identity does not match this bridge.');
  const url = new URL(data.upstreamUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Harness Desktop discovery must name a clean loopback origin.');
  return { url: url.origin, token: data.launchToken, key: createHash('sha256').update(`${data.generation}\0${url.origin}\0${data.launchToken}`).digest('hex') };
}

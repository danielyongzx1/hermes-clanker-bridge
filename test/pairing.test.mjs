import test from 'node:test';
import assert from 'node:assert/strict';
import { pairingAddresses, pairingHtml, pairingLink } from '../bridge/pairing.mjs';

const lan = { Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.1.10' }, { family: 'IPv4', internal: true, address: '127.0.0.1' }], Link: [{ family: 'IPv4', internal: false, address: '169.254.3.4' }] };

test('the pairing link carries identity, token, name and every reachable address', () => {
  const link = pairingLink({ bridgeId: 'b1', token: 't&k', name: 'Harness · PC', urls: ['http://192.168.1.10:8788', 'http://100.64.0.2:8788'] });
  assert.equal(link, 'clanker://pair?bridge=b1&token=t%26k&name=Harness%20%C2%B7%20PC&url=http%3A%2F%2F192.168.1.10%3A8788&url=http%3A%2F%2F100.64.0.2%3A8788');
});

test('addresses follow the listen host: all LAN interfaces, one fixed host, or none on loopback', () => {
  assert.deepEqual(pairingAddresses('0.0.0.0', 8787, lan), [{ name: 'Ethernet', url: 'http://192.168.1.10:8787' }]);
  assert.deepEqual(pairingAddresses('100.64.0.2', 8787, lan), [{ name: '100.64.0.2', url: 'http://100.64.0.2:8787' }]);
  assert.deepEqual(pairingAddresses('127.0.0.1', 8787, lan), []);
});

test('the page shows a QR code only when the phone can reach the bridge, and escapes values', () => {
  const page = pairingHtml({ kind: 'hermes', bridgeId: 'b1', token: 'fixture-token', port: 8787, name: '<b>PC</b>', interfaces: lan });
  assert.match(page, /<svg[^>]*viewBox/); assert.ok(page.includes('fixture-token')); assert.ok(!page.includes('<b>PC</b>'));
  const local = pairingHtml({ kind: 'hermes', bridgeId: 'b1', token: 'fixture-token', host: '127.0.0.1', port: 8787, interfaces: lan });
  assert.ok(!local.includes('<svg')); assert.match(local, /only accepts connections from this PC/);
});

// Copied from Clanker's tools/remote-bridge tests, less the Harness-only ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createBridge } from '../bridge/server.mjs';
import { WorkspaceFiles } from '../bridge/files.mjs';
import { applyHermesEvent } from '../bridge/hermes.mjs';

const token = 'fixture-token-abcdefghijklmnopqrstuvwxyz';
const listen = async (server) => { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; };
const until = async (fn) => { for (let i = 0; i < 150; i++) { const result = await fn(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error('Fixture timed out.'); };
async function hermesFixture(t) {
  const runs = new Map(); const sessionBodies = []; let starts = 0; let creates = 0;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    body = body ? JSON.parse(body) : {};
    const send = (value) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== 'Bearer hermes-test-key') { res.writeHead(401); res.end(); return; }
    if (req.url === '/v1/capabilities') return send({ features: { run_status: true, run_events_sse: true, run_stop: true } });
    if (req.url === '/v1/models') return send({ data: [{ id: 'hermes-agent' }] });
    if (req.url === '/api/model/options?include_unconfigured=false') return send({ provider: 'local', model: 'qwen/reasoning', providers: [
      { slug: 'local', authenticated: true, models: ['qwen/reasoning', 'qwen/fast', 'offline'], unavailable_models: ['offline'] },
      { slug: 'cloud', authenticated: true, models: ['qwen/reasoning'], capabilities: { 'qwen/reasoning': { reasoning: false } } },
      { slug: 'unconfigured', authenticated: false, models: ['hidden'] },
    ] });
    if (req.url === '/api/sessions') { creates++; sessionBodies.push(body); return send({ id: body.id }); }
    if (req.url === '/v1/runs') {
      const id = req.headers['idempotency-key'];
      if (!runs.has(id)) { starts++; runs.set(id, { id, ...body, status: 'running' }); }
      return send({ run_id: id });
    }
    const match = req.url.match(/^\/v1\/runs\/([^/]+)(?:\/(.*))?$/);
    if (!match || !runs.has(match[1])) { res.writeHead(404); res.end(); return; }
    const run = runs.get(match[1]); const route = match[2];
    if (!route) { const { res: _stream, ...status } = run; return send({ ...status, output: run.status === 'completed' ? 'Updated the file.' : undefined }); }
    let seq = 0;
    const event = (name, value) => { res.write(`id: ${seq}\ndata: ${JSON.stringify({ event: name, seq, ...value })}\n\n`); seq++; };
    if (route === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); run.res = res;
      event('reasoning.delta', { delta: 'First thought. ' }); event('reasoning.delta', { delta: 'Second thought.' });
      event('message.delta', { text: 'Working…' }); event('tool.started', { tool: 'terminal', preview: 'edit file' });
      if (run.input.startsWith('reconnect') && !run.streamedOnce) { run.streamedOnce = true; res.end(); return; }
      if (run.input.startsWith('reconnect')) assert.equal(req.headers['last-event-id'], '3');
      run.clanker_metrics = { context_used: 12000, context_max: 64000, context_estimated: false, tokens_per_s: 44.5, cache_hit_pct: 25 };
      event('usage.update', { clanker_metrics: run.clanker_metrics });
      if (run.input.startsWith('wait')) return;
      if (run.input.startsWith('approve')) { run.status = 'waiting_for_approval'; event('approval.request', { request_id: 'approval-1', execution_generation: 3, prompt: 'Allow this operation?' }); return; }
      const filename = run.input.split('\n').at(-1);
      if (run.input.includes('Uploaded files')) await writeFile(filename, Buffer.from([0x50, 0x4b, 0x00, 0xff, 0x42]));
      event('tool.completed', { tool: 'terminal', preview: 'edited', duration: 0.1 });
      run.status = 'completed'; event('run.completed', { output: 'Updated the file.', clanker_metrics: run.clanker_metrics }); res.end(); return;
    }
    if (route === 'approval') {
      assert.deepEqual(body, { request_id: 'approval-1', execution_generation: 3, choice: 'once' });
      run.status = 'completed'; run.res?.write('event: run.completed\ndata: {"output":"Approved."}\n\n'); run.res?.end(); return send({ status: 'accepted' });
    }
    if (route === 'stop') {
      run.status = 'cancelled'; run.res?.write('event: run.cancelled\ndata: {}\n\n'); run.res?.end(); return send({ status: 'stopping' });
    }
    res.writeHead(404); res.end();
  });
  const url = await listen(server);
  return { url, runs, sessionBodies, close() { server.closeAllConnections(); server.close(); }, get starts() { return starts; }, get creates() { return creates; } };
}
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'clanker-bridge-'));
  const host = await hermesFixture(t);
  const config = { kind: 'hermes', token, upstreamUrl: host.url, upstreamKey: 'hermes-test-key', stateDir: path.join(root, 'state'), workspaceRoot: path.join(root, 'workspaces'), ...overrides };
  const bridge = await createBridge(config); const url = await listen(bridge.server);
  t.after(async () => { await bridge.close(); host.close(); await rm(root, { recursive: true, force: true }); });
  const request = async (route, body, init = {}) => fetch(`${url}/v1/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Clanker-Bridge': bridge.state.bridgeId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...init });
  const json = async (route, body) => { const response = await request(route, body); assert.ok(response.ok, await response.clone().text()); return response.json(); };
  const session = async (chatId = 'chat1') => json('sessions', { chatId, model: 'hermes-agent', instructions: '' });
  const done = async (id) => until(async () => { const result = await json(`runs/${id}`); return ['completed', 'cancelled', 'failed'].includes(result.state) && result; });
  return { root, host, bridge, config, url, request, json, session, done };
}

test('authenticated connection, stable bridge identity, and concurrent session creation', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.url}/v1/capabilities`)).status, 401);
  const info = await f.json('capabilities'); assert.equal(info.kind, 'hermes'); assert.equal(info.protocol, 1);
  assert.equal((await fetch(`${f.url}/v1/capabilities`, { headers: { Authorization: `Bearer ${token}`, 'X-Clanker-Bridge': 'other' } })).status, 409);
  const sessions = await Promise.all([f.session(), f.session()]); assert.equal(sessions[0].sessionId, sessions[1].sessionId); assert.equal(f.host.creates, 1);
});

test('full Hermes inventory keeps provider routes distinct and sends the selected route', async (t) => {
  const f = await fixture(t);
  const info = await f.json('capabilities');
  assert.deepEqual(info.models, ['hermes-agent', 'local/qwen/reasoning', 'local/qwen/fast', 'cloud/qwen/reasoning']);
  await f.json('sessions', { chatId: 'routed', model: 'local/qwen/reasoning', instructions: '' });
  assert.equal(f.host.sessionBodies[0].provider, 'local'); assert.equal(f.host.sessionBodies[0].model, 'qwen/reasoning');
  const { id } = await f.json('sessions/routed/runs', { submissionId: 'routed', text: 'wait', files: [] });
  await until(() => f.host.runs.has(id));
  assert.equal(f.host.runs.get(id).provider, 'local'); assert.equal(f.host.runs.get(id).model, 'qwen/reasoning');
  // Both reasoning deltas, not a snapshot taken between them.
  const live = await until(async () => { const run = await f.json(`runs/${id}`); return run.content[0]?.text === 'First thought. Second thought.' && run; });
  assert.equal(live.state, 'running'); assert.equal(live.content[0].text, 'First thought. Second thought.');
  await f.json(`runs/${id}/stop`, {}); await f.done(id);
});

test('a chat switches to any model the bridge offers, from the next submission', async (t) => {
  const f = await fixture(t);
  const info = await f.json('capabilities'); assert.equal(info.modelSwitching, 'any');
  await f.json('sessions', { chatId: 'switch', model: 'local/qwen/reasoning', instructions: '' });
  const first = await f.json('sessions/switch/runs', { submissionId: 'one', text: 'Hello', files: [] });
  await f.done(first.id);
  assert.equal((await f.request('sessions/switch/runs', { submissionId: 'missing', text: 'Hello', files: [], model: 'local/qwen/missing' })).status, 400);
  const second = await f.json('sessions/switch/runs', { submissionId: 'two', text: 'Hello', files: [], model: 'local/qwen/fast' });
  await f.done(second.id);
  const third = await f.json('sessions/switch/runs', { submissionId: 'three', text: 'Hello', files: [], model: 'cloud/qwen/reasoning' });
  await f.done(third.id);
  assert.equal(f.host.runs.get(first.id).model, 'qwen/reasoning');
  assert.equal(f.host.runs.get(second.id).provider, 'local'); assert.equal(f.host.runs.get(second.id).model, 'qwen/fast');
  assert.equal(f.host.runs.get(third.id).provider, 'cloud'); assert.equal(f.host.runs.get(third.id).model, 'qwen/reasoning');
  // Ensuring the session again with the chat's current model is not a configuration change; its instructions are.
  assert.equal((await f.json('sessions', { chatId: 'switch', model: 'cloud/qwen/reasoning', instructions: '' })).sessionId, 'switch');
  assert.equal((await f.request('sessions', { chatId: 'switch', model: 'cloud/qwen/reasoning', instructions: 'Other' })).status, 409);
});

test('Hermes effort is per submission; usage survives streaming, reconciliation and bridge restart', async (t) => {
  const f = await fixture(t);
  const info = await f.json('capabilities');
  assert.ok(info.modelOptions['hermes-agent'].efforts.includes('high'));
  assert.deepEqual(info.modelOptions['cloud/qwen/reasoning'].efforts, []);
  await f.session();
  const body = { submissionId: 'effort', text: 'wait for metrics', files: [], effort: 'high' };
  const { id } = await f.json('sessions/chat1/runs', body);
  const live = await until(async () => { const r = await f.json(`runs/${id}`); return r.metrics && r; });
  assert.equal(f.host.runs.get(id).model_options.reasoning_effort, 'high');
  assert.equal(f.host.runs.get(id).model_options.reasoning.effort, 'high');
  assert.deepEqual(live.metrics, { context: { used: 12000, budget: 64000, estimated: false }, tokensPerSec: 44.5, cacheHit: 0.25 });
  assert.equal((await f.json('sessions/chat1/runs', body)).id, id);
  assert.equal((await f.request('sessions/chat1/runs', { ...body, effort: 'low' })).status, 409);
  await f.json(`runs/${id}/stop`, {}); await f.done(id);
  await f.bridge.close();
  const resumed = await createBridge(f.config);
  try {
    const url = await listen(resumed.server);
    const saved = await (await fetch(`${url}/v1/runs/${id}`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.deepEqual(saved.metrics, live.metrics); assert.equal(f.host.starts, 1);
  } finally { await resumed.close(); }
});

test('Hermes missing metrics stay unknown; zero cache is retained and usage cannot become context', () => {
  const run = { state: 'running', content: [], controls: [] };
  applyHermesEvent(run, 'run.completed', { usage: { input_tokens: 3000000, output_tokens: 80 } });
  assert.equal(run.metrics, undefined);
  applyHermesEvent(run, 'run.completed', { usage: { input_tokens: 3000000, cache_read_tokens: 0, output_tokens: 80, decode_ms: 2000 } });
  assert.deepEqual(run.metrics, { cacheHit: 0, tokensPerSec: 40 });
  applyHermesEvent(run, 'usage.update', { clanker_metrics: { context_used: 12000, context_max: 64000, context_estimated: true, tokens_per_s: 30, cache_hit_pct: 25 } });
  const once = structuredClone(run.metrics);
  applyHermesEvent(run, 'usage.update', { clanker_metrics: { context_used: 12000, context_max: 64000, context_estimated: true, tokens_per_s: 30, cache_hit_pct: 25 } });
  assert.deepEqual(run.metrics, once);
});

test('host effort constraints apply to the route and default alias before upstream submission', async (t) => {
  const f = await fixture(t, { modelEfforts: { 'local/qwen/reasoning': ['low', 'medium', 'xhigh'] } });
  const info = await f.json('capabilities');
  assert.deepEqual(info.modelOptions['local/qwen/reasoning'].efforts, ['low', 'medium', 'xhigh']);
  assert.deepEqual(info.modelOptions['hermes-agent'].efforts, ['low', 'medium', 'xhigh']);
  await f.session();
  assert.equal((await f.request('sessions/chat1/runs', { submissionId: 'invalid', text: 'Hello', files: [], effort: 'high' })).status, 400);
  assert.equal(f.host.starts, 0);
});

test('actual bytes, duplicate filenames, idempotent turns, edited artifacts, immutable downloads', async (t) => {
  const f = await fixture(t); await f.session();
  const original = Buffer.from([0x50, 0x4b, 0x01, 0x00, 0xfe]);
  const upload = async (id, body) => {
    const res = await f.request(`sessions/chat1/files/${id}?name=budget.xlsx`, undefined, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body });
    assert.ok(res.ok, await res.clone().text()); return res.json();
  };
  const first = await upload('upload1', original); const second = await upload('upload2', original);
  assert.notEqual(first.path, second.path); assert.equal((await upload('upload1', Buffer.from('different'))).version, first.version);
  const payload = { submissionId: 'message1', text: 'Edit this spreadsheet', files: ['upload1'] };
  const replies = await Promise.all([f.json('sessions/chat1/runs', payload), f.json('sessions/chat1/runs', payload)]);
  assert.equal(replies[0].id, replies[1].id);
  const finished = await f.done(replies[0].id); assert.equal(f.host.starts, 1); assert.equal(finished.files.length, 1);
  assert.equal(finished.content.filter((p) => p.type === 'tool').length, 1);
  const artifact = finished.files[0]; assert.notEqual(artifact.version, first.version);
  const download = await f.request(`sessions/chat1/files/${artifact.id}?version=${artifact.version}`);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from([0x50, 0x4b, 0x00, 0xff, 0x42]));
  const old = await f.request(`sessions/chat1/files/${first.id}?version=${first.version}`);
  assert.deepEqual(Buffer.from(await old.arrayBuffer()), original);
  await writeFile(path.join(f.config.workspaceRoot, 'chat1', artifact.path), 'changed after reply');
  const again = await f.request(`sessions/chat1/files/${artifact.id}?version=${artifact.version}`);
  assert.deepEqual(Buffer.from(await again.arrayBuffer()), Buffer.from([0x50, 0x4b, 0x00, 0xff, 0x42]));
  assert.equal((await f.request('sessions/chat1/runs', { ...payload, text: 'different request' })).status, 409);
});

test('approvals preserve identity and generation; stale decisions are rejected', async (t) => {
  const f = await fixture(t); await f.session();
  const { id } = await f.json('sessions/chat1/runs', { submissionId: 'approval', text: 'approve please', files: [] });
  const waiting = await until(async () => { const run = await f.json(`runs/${id}`); return run.controls.length && run; });
  assert.equal(waiting.state, 'waiting');
  await f.json(`runs/${id}/controls`, { controlId: 'approval-1', answer: 'once' });
  assert.equal((await f.done(id)).state, 'completed');
  assert.equal((await f.request(`runs/${id}/controls`, { controlId: 'approval-1', answer: 'once' })).status, 409);
});

test('Stop reaches upstream and terminal cancellation keeps the run receipt', async (t) => {
  const f = await fixture(t); await f.session();
  const { id } = await f.json('sessions/chat1/runs', { submissionId: 'stop', text: 'wait for me', files: [] });
  await until(async () => f.host.runs.get(id)?.res);
  await f.json(`runs/${id}/stop`, {});
  assert.equal((await f.done(id)).state, 'cancelled');
  assert.equal((await f.json('sessions/chat1/runs', { submissionId: 'stop', text: 'wait for me', files: [] })).id, id);
  assert.equal(f.host.starts, 1);
});

test('Stop before submission reserves cancellation and cannot start an agent turn later', async (t) => {
  const f = await fixture(t); await f.session();
  const stopped = await f.json('sessions/chat1/submissions/before_send/stop', {});
  const submitted = await f.json('sessions/chat1/runs', { submissionId: 'before_send', text: 'must not run', files: [] });
  assert.equal(stopped.id, submitted.id); assert.equal((await f.done(stopped.id)).state, 'cancelled'); assert.equal(f.host.starts, 0);
});

test('upstream stream reconnect resumes its cursor without repeating tools or submissions', async (t) => {
  const f = await fixture(t); await f.session();
  const { id } = await f.json('sessions/chat1/runs', { submissionId: 'reconnect', text: 'reconnect fixture', files: [] });
  const result = await f.done(id);
  assert.equal(f.host.starts, 1); assert.equal(result.content.filter((p) => p.type === 'tool').length, 1);
});

test('bridge restart preserves receipts and never resubmits an uncertain acceptance', async (t) => {
  const f = await fixture(t); await f.session();
  const { id } = await f.json('sessions/chat1/runs', { submissionId: 'restart', text: 'normal', files: [] });
  await f.done(id); await f.bridge.close();
  const statePath = path.join(f.config.stateDir, 'state.json'); const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.runs.uncertain = { id: 'uncertain', sessionId: 'chat1', state: 'running', cursor: 0, content: [], files: [], controls: [] };
  await writeFile(statePath, JSON.stringify(state));
  const restored = await createBridge(f.config); const url = await listen(restored.server); t.after(() => restored.close());
  assert.equal(restored.state.bridgeId, f.bridge.state.bridgeId);
  await until(() => restored.state.runs.uncertain.state === 'unknown'); assert.equal(f.host.starts, 1);
  const acknowledged = await fetch(`${url}/v1/runs/uncertain/acknowledge`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmedStopped: true }) });
  assert.equal((await acknowledged.json()).state, 'failed'); assert.equal(f.host.starts, 1);
  const res = await fetch(`${url}/v1/runs/${id}`, { headers: { Authorization: `Bearer ${token}` } }); assert.equal((await res.json()).state, 'completed');
  await restored.close();
});

test('workspace transfer blocks traversal, symlinks and oversized files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'clanker-files-')); t.after(() => rm(root, { recursive: true, force: true }));
  const files = new WorkspaceFiles(path.join(root, 'work'), path.join(root, 'objects')); await files.init();
  await files.directory('chat'); await writeFile(path.join(root, 'secret'), 'private');
  await assert.rejects(files.safeFile('chat', '../secret'), /Unsafe/);
  await assert.rejects(files.safeFile('chat', '/secret'), /Unsafe/);
  await assert.rejects(files.upload('chat', 'oversized', 'file', Readable.from([Buffer.alloc(20 * 1024 * 1024), Buffer.from('1')])) , /20 MB/);
  try { await symlink(path.join(root, 'secret'), path.join(root, 'work', 'chat', 'link')); }
  catch (error) { if (error.code !== 'EPERM') throw error; t.diagnostic('Symlink creation requires Windows developer mode; traversal and size checks passed.'); return; }
  await assert.rejects(files.safeFile('chat', 'link'), /Symlink/);
});

test('Hermes event fixtures retain reasoning, tool failures and terminal state', () => {
  const run = { state: 'running', content: [], controls: [] };
  applyHermesEvent(run, 'reasoning.delta', { text: 'Thinking' });
  applyHermesEvent(run, 'tool.started', { id: 'one', tool: 'terminal' });
  applyHermesEvent(run, 'tool.failed', { id: 'one', tool: 'terminal', error: true, preview: 'blocked' });
  applyHermesEvent(run, 'run.failed', { error: 'failed' });
  assert.equal(run.content[0].type, 'thought'); assert.equal(run.content[1].status, 'error'); assert.equal(run.state, 'failed');
});


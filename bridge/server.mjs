import http from 'node:http';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, readFile, realpath, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { WorkspaceFiles } from './files.mjs';
import { MAX_FILE_BYTES, assertId, terminal } from './protocol.mjs';
import { HermesAdapter } from './hermes.mjs';
import { desktopIdentity } from './desktop-discovery.mjs';
import { writeState } from './persistence.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const pause = (ms, signal) => new Promise((resolve) => { const timer = setTimeout(done, ms); function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); } signal?.addEventListener('abort', done, { once: true }); });
async function jsonBody(req) {
  let body = ''; for await (const part of req) { body += part; if (Buffer.byteLength(body) > 1024 * 1024) throw fail('Request exceeds 1 MB.', 413); }
  try { return JSON.parse(body || '{}'); } catch { throw fail('Invalid JSON.'); }
}
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const runIdentity = (sessionId, submissionId) => createHash('sha256').update(`${sessionId}\0${submissionId}`).digest('hex');
const unsettled = (run) => !terminal(run.state) || !run.finalized;

export async function createBridge(config, suppliedAdapter) {
  if (!config.token || config.token.length < 24) throw new Error('Set BRIDGE_TOKEN to a random token of at least 24 characters.');
  if (!['hermes', 'harness'].includes(config.kind)) throw new Error('kind must be hermes or harness.');
  // Harness's adapter needs Harness's client packages, which a Hermes-only install doesn't have.
  const adapter = suppliedAdapter ?? (config.kind === 'hermes' ? new HermesAdapter(config) : new (await import('./harness.mjs')).HarnessAdapter(config));
  const stateDir = path.resolve(config.stateDir ?? '.clanker-bridge');
  await mkdir(stateDir, { recursive: true });
  if ((await lstat(stateDir)).isSymbolicLink()) throw new Error('State directory must not be a symlink.');
  const stateFile = path.join(await realpath(stateDir), 'state.json');
  let state;
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = { protocol: 1, bridgeId: randomUUID(), kind: config.kind, sessions: {}, runs: {} }; }
  if (state.protocol !== 1 || state.kind !== config.kind) throw new Error('This state directory belongs to a different bridge type or protocol.');
  let writes = Promise.resolve();
  const save = () => {
    const body = JSON.stringify(state);
    const operation = writes.catch(() => {}).then(() => writeState(stateFile, body));
    writes = operation; return operation;
  };
  await save();
  const files = new WorkspaceFiles(config.workspaceRoot ?? './workspaces', path.join(stateDir, 'objects'));
  await files.init();
  if (state.workspaceRoot && state.workspaceRoot !== files.root) throw new Error('The workspace root changed. Restore the original root for this bridge state.');
  const identity = desktopIdentity(config);
  if (state.upstreamIdentity) {
    if (state.upstreamIdentity !== identity) throw new Error('The upstream Desktop profile changed. Restore its original discovery configuration.');
  } else if (state.upstreamUrl && state.upstreamUrl !== config.upstreamUrl) throw new Error('The upstream address changed. Use a separate state directory for a different upstream.');
  if (identity) state.upstreamIdentity = identity;
  state.workspaceRoot = files.root; state.upstreamUrl = config.upstreamUrl; await save();
  const abort = new AbortController();
  const tasks = new Map();
  const sessionLocks = new Map();
  let models = [], modelsAt = 0, modelsKey;
  const readModels = async () => {
    const key = await adapter.modelCacheKey?.();
    if (Date.now() - modelsAt > 30000 || key !== modelsKey) { models = await adapter.models(); modelsAt = Date.now(); modelsKey = key; }
    return models;
  };
  const publicRun = (run) => ({ id: run.id, sessionId: run.sessionId, cursor: run.cursor, state: terminal(run.state) && !run.finalized ? 'running' : run.state, content: run.content, files: run.files, controls: run.controls, error: run.error, metrics: run.metrics });
  const update = (run) => async (mutate) => { mutate(run); run.cursor++; await save(); };
  async function finish(run) {
    const session = state.sessions[run.sessionId];
    const listed = await files.list(session.id);
    const before = new Map((run.beforeFiles ?? []).map((file) => [file.path, file.version]));
    run.files = listed.filter((file) => before.get(file.path) !== file.version);
    session.files = listed;
    run.controls = [];
    for (const part of run.content) if (part.type === 'tool' && part.status === 'running') { part.status = 'error'; part.output ??= 'Remote turn ended before this tool completed.'; }
    run.finalized = true; run.cursor++; await save();
  }
  async function execute(run, fresh) {
    const session = state.sessions[run.sessionId];
    try {
      if (fresh) {
        // The durable reservation exists before the upstream request. A crash in the
        // acceptance window becomes unknown and is never retried automatically.
        run.upstreamId = await adapter.start(run, session, update(run));
        await save();
        if (run.stopRequested) { await adapter.stop(run); run.state = 'stopping'; run.cursor++; await save(); }
      } else if (!run.upstreamId) {
        run.state = 'unknown'; run.error = 'Bridge restarted before upstream acceptance could be confirmed. Check the host; this turn will not be repeated.';
        run.cursor++; await save(); return;
      }
      while (!abort.signal.aborted && !terminal(run.state) && run.state !== 'unknown') {
        try {
          if (adapter.reconcile) await adapter.reconcile(run, update(run));
          if (!terminal(run.state) && run.state !== 'unknown') await adapter.observe(run, update(run), abort.signal);
          if (!terminal(run.state) && run.state !== 'unknown') await pause(1000, abort.signal);
        } catch (error) {
          if (abort.signal.aborted) break;
          run.error = `Upstream connection interrupted: ${error.message}. Reconnecting; the turn is not resubmitted.`;
          run.cursor++; await save(); await pause(2000, abort.signal);
        }
      }
      if (terminal(run.state)) await finish(run);
    } catch (error) {
      run.state = 'unknown'; run.error = `Upstream acceptance is uncertain: ${error.message}. Check the host before continuing.`; run.cursor++; await save();
    }
  }
  function startTask(run, fresh = false) {
    if (tasks.has(run.id) || terminal(run.state) || run.state === 'unknown') return;
    const task = execute(run, fresh).finally(() => tasks.delete(run.id)); tasks.set(run.id, task);
  }
  for (const run of Object.values(state.runs)) {
    if (terminal(run.state) && !run.finalized) await finish(run);
    else startTask(run);
  }
  const server = http.createServer(async (req, res) => {
    const send = (value, status = 200) => { if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      const expected = Buffer.from(`Bearer ${config.token}`), actual = Buffer.from(req.headers.authorization ?? '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return send({ error: 'Invalid bridge token.' }, 401);
      const url = new URL(req.url, 'http://localhost');
      if (req.headers['x-clanker-bridge'] && req.headers['x-clanker-bridge'] !== state.bridgeId) return send({ error: 'Bridge identity changed. Restore the original bridge state.' }, 409);
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts.shift() !== 'v1') throw fail('Unknown API version.', 404);
      if (req.method === 'GET' && parts[0] === 'capabilities') return send({ protocol: 1, bridgeId: state.bridgeId, kind: config.kind, models: await readModels(), modelOptions: adapter.modelOptions, modelSwitching: 'any', maxFileBytes: MAX_FILE_BYTES });
      if (req.method === 'POST' && parts.length === 1 && parts[0] === 'sessions') {
        const body = await jsonBody(req); assertId(body.chatId);
        if (typeof body.model !== 'string' || typeof body.instructions !== 'string' || body.instructions.length > 16000) throw fail('Invalid session configuration.');
        const operation = (sessionLocks.get(body.chatId) ?? Promise.resolve()).catch(() => {}).then(async () => {
          let session = state.sessions[body.chatId];
          if (!session) {
            if (!(await readModels()).includes(body.model)) throw fail('Model is unavailable.');
            const workspace = await files.directory(body.chatId);
            session = state.sessions[body.chatId] = { id: body.chatId, upstreamCandidate: `clanker_${state.bridgeId}_${body.chatId}`, model: body.model, instructions: body.instructions, workspace, files: [], uploads: {} };
            await save();
          }
          // Each run names its own model, so only the instructions are fixed.
          if (session.instructions !== body.instructions) throw fail('Session configuration is locked.', 409);
          if (!session.upstreamId) { session.upstreamId = await adapter.ensureSession(session); await save(); }
          return session;
        });
        sessionLocks.set(body.chatId, operation);
        try { const session = await operation; return send({ sessionId: session.id }); } finally { if (sessionLocks.get(body.chatId) === operation) sessionLocks.delete(body.chatId); }
      }
      if (parts[0] === 'sessions' && parts[1]) {
        const session = state.sessions[assertId(parts[1])]; if (!session) throw fail('Session not found.', 404);
        if (parts[2] === 'files') {
          if (req.method === 'PUT' && parts[3]) {
            const uploadId = assertId(parts[3]);
            if (Number(req.headers['content-length'] ?? 0) > MAX_FILE_BYTES) throw fail('File exceeds 20 MB.', 413);
            if (session.uploads[uploadId]) { req.resume(); return send(session.uploads[uploadId]); }
            if (Object.values(state.runs).some((r) => r.sessionId === session.id && unsettled(r))) throw fail('Wait for this chat’s active turn before uploading.', 409);
            const uploaded = await files.upload(session.id, uploadId, url.searchParams.get('name'), req);
            if (!uploaded) throw fail('Upload could not be stored.');
            session.uploads[uploadId] = uploaded; await save(); return send(uploaded);
          }
          if (req.method === 'GET' && !parts[3]) { session.files = await files.list(session.id); await save(); return send(session.files); }
          if (req.method === 'GET' && parts[3]) {
            const version = url.searchParams.get('version');
            const candidates = [...session.files, ...Object.values(session.uploads), ...Object.values(state.runs).filter((r) => r.sessionId === session.id).flatMap((r) => r.files)];
            const artifact = candidates.find((file) => file.id === parts[3] && file.version === version);
            if (!artifact) throw fail('File version not found in this session.', 404);
            const object = await files.object(version);
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': artifact.size, 'Cache-Control': 'no-store' });
            await pipeline(createReadStream(object), res); return;
          }
        }
        if (req.method === 'POST' && parts[2] === 'submissions' && parts[3] && parts[4] === 'stop') {
          const submissionId = assertId(parts[3]); const id = runIdentity(session.id, submissionId);
          let run = state.runs[id];
          if (!run) {
            run = state.runs[id] = { id, sessionId: session.id, state: 'cancelled', finalized: true, cursor: 0, content: [], controls: [], files: [] };
          } else if (!terminal(run.state)) {
            run.stopRequested = true;
            if (run.upstreamId && run.state !== 'unknown') { await adapter.stop(run); run.state = 'stopping'; run.cursor++; }
          }
          await save(); return send({ id });
        }
        if (req.method === 'POST' && parts[2] === 'runs') {
          const body = await jsonBody(req); assertId(body.submissionId);
          if (typeof body.text !== 'string' || !Array.isArray(body.files) || body.files.some((id) => !session.uploads[id])) throw fail('Invalid message or file reference.');
          if (!body.text.trim() && !body.files.length) throw fail('Message is empty.');
          const id = runIdentity(session.id, body.submissionId);
          const hash = fingerprint(body);
          if (state.runs[id]) { if (state.runs[id].fingerprint && state.runs[id].fingerprint !== hash) throw fail('Submission identity already has a different payload.', 409); return send({ id }); }
          const model = body.model ?? session.model;
          if (typeof model !== 'string') throw fail('Invalid model.');
          if (model !== session.model && !(await readModels()).includes(model)) throw fail('Model is unavailable. Refresh the backend connection.');
          if (body.effort !== undefined) {
            await readModels();
            if (!adapter.modelOptions?.[model]?.efforts?.includes(body.effort)) throw fail('This reasoning effort is unavailable for the selected model. Refresh the backend connection.');
          }
          if (Object.values(state.runs).some((r) => r.sessionId === session.id && unsettled(r))) throw fail('This session already has an unsettled run. Reconnect to it first.', 409);
          const beforeFiles = await files.list(session.id);
          // Recheck after asynchronous filesystem reads, before reserving the run.
          if (state.runs[id]) { if (state.runs[id].fingerprint && state.runs[id].fingerprint !== hash) throw fail('Submission identity already has a different payload.', 409); return send({ id }); }
          if (Object.values(state.runs).some((r) => r.sessionId === session.id && unsettled(r))) throw fail('This session already has an unsettled run.', 409);
          // Hermes caches the resolved route on the session; the next turn resolves the new one.
          if (model !== session.model) { session.model = model; delete session.modelRequest; }
          const input = `${body.text}${body.files.length ? '\n\nUploaded files (actual bytes on this device):\n' + body.files.map((fileId) => path.join(session.workspace, session.uploads[fileId].path)).join('\n') : ''}`;
          const run = state.runs[id] = { id, sessionId: session.id, fingerprint: hash, input, effort: body.effort, state: 'running', cursor: 0, content: [], controls: [], files: [], beforeFiles };
          await save(); startTask(run, true); return send({ id }, 202);
        }
      }
      if (parts[0] === 'runs' && parts[1]) {
        const run = state.runs[parts[1]]; if (!run) throw fail('Run not found. The original bridge state is required; this turn will not be resubmitted.', 404);
        if (req.method === 'GET' && !parts[2]) return send(publicRun(run));
        if (req.method === 'POST' && parts[2] === 'acknowledge') {
          const body = await jsonBody(req);
          if (run.state !== 'unknown' || body.confirmedStopped !== true) throw fail('Only a confirmed, unknown execution can be acknowledged.', 409);
          await adapter.acknowledge?.(run);
          run.state = 'failed'; run.error = 'Unknown execution acknowledged as interrupted. This turn was not resubmitted.';
          await finish(run); return send(publicRun(run));
        }
        if (req.method === 'GET' && parts[2] === 'events') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
          let cursor = -1, closed = false; req.on('close', () => { closed = true; });
          while (!closed && !abort.signal.aborted) {
            if (run.cursor !== cursor) { cursor = run.cursor; res.write(`id: ${cursor}\nevent: snapshot\ndata: ${JSON.stringify(publicRun(run))}\n\n`); }
            else res.write(': keepalive\n\n');
            if (terminal(run.state)) break;
            await pause(750, abort.signal);
          }
          res.end(); return;
        }
        if (req.method === 'POST' && parts[2] === 'stop') {
          if (terminal(run.state)) return send(publicRun(run));
          if (!run.upstreamId || run.state === 'unknown') throw fail('Execution outcome is unknown. Check and stop the task on the host device.', 409);
          await adapter.stop(run); if (!terminal(run.state)) run.state = 'stopping'; run.cursor++; await save(); return send(publicRun(run));
        }
        if (req.method === 'POST' && parts[2] === 'controls') {
          const body = await jsonBody(req);
          const control = run.controls.find((c) => c.id === body.controlId);
          if (!control || terminal(run.state)) throw fail('This prompt is no longer current.', 409);
          if (typeof body.answer !== 'string' || body.answer.length > 16000 || (control.kind === 'approval' && !control.choices?.includes(body.answer))) throw fail('Invalid answer.');
          await adapter.respond(run, control, body.answer);
          run.controls = run.controls.filter((c) => c.id !== control.id); if (!terminal(run.state)) run.state = run.controls.length ? 'waiting' : 'running'; run.cursor++; await save(); return send(publicRun(run));
        }
      }
      throw fail('Unknown bridge endpoint.', 404);
    } catch (error) {
      if (res.headersSent) res.destroy(); else send({ error: error.message }, error.status ?? 502);
    }
  });
  let closePromise;
  return { server, state, files, adapter, close() {
    return closePromise ??= (async () => { abort.abort(); await adapter.close?.(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await Promise.allSettled([...tasks.values()]); await save(); })();
  } };
}

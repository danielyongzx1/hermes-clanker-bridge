import { addText, sse, terminal, toolEvent } from './protocol.mjs';

// Hermes's vocabulary; known providers can clamp it further on their wire API.
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
function applyMetrics(run, data) {
  const raw = data.clanker_metrics;
  const usage = data.usage;
  const metrics = { ...run.metrics };
  if (raw && typeof raw === 'object') {
    if (finite(raw.context_used) && finite(raw.context_max) && raw.context_max > 0) {
      metrics.context = { used: raw.context_used, budget: raw.context_max, estimated: raw.context_estimated !== false };
    }
    if (finite(raw.tokens_per_s)) metrics.tokensPerSec = raw.tokens_per_s;
    if (finite(raw.cache_hit_pct)) metrics.cacheHit = Math.min(1, raw.cache_hit_pct / 100);
  }
  if (usage && typeof usage === 'object') {
    const input = usage.input_tokens ?? usage.prompt_tokens;
    const cached = usage.cache_read_tokens ?? usage.prompt_tokens_details?.cached_tokens;
    if (finite(input) && input > 0 && finite(cached) && raw?.cache_hit_pct == null) metrics.cacheHit = Math.min(1, cached / input);
    if (finite(usage.output_tokens) && finite(usage.decode_ms) && usage.decode_ms >= 100 && raw?.tokens_per_s == null) metrics.tokensPerSec = usage.output_tokens / usage.decode_ms * 1000;
  }
  if (Object.keys(metrics).length) run.metrics = metrics;
}

export function applyHermesEvent(run, event, data) {
  applyMetrics(run, data);
  if (['message.delta', 'assistant.delta'].includes(event)) addText(run, data.text ?? data.delta ?? data.content ?? '');
  if (['reasoning.delta', 'reasoning_delta', 'reasoning.available'].includes(event)) addText(run, data.text ?? data.delta ?? '', 'thought');
  if (event === 'tool.started') toolEvent(run, data);
  if (['tool.completed', 'tool.failed'].includes(event)) toolEvent(run, { ...data, error: data.error || event === 'tool.failed' }, true);
  if (['approval.request', 'clarification.request', 'clarify.request'].includes(event)) {
    const id = data.request_id ?? data.prompt_id;
    if (id && !run.controls.some((c) => c.id === id)) {
      run.controls.push({ id, kind: event === 'approval.request' ? 'approval' : 'clarification', prompt: data.prompt ?? data.description ?? data.question ?? JSON.stringify(data), choices: event === 'approval.request' ? ['once', 'deny'] : undefined, generation: data.execution_generation });
      run.state = 'waiting';
    }
  }
  if (event === 'run.completed') {
    // The terminal output is authoritative; progress commentary must not be mistaken for the answer.
    if (typeof data.output === 'string' && data.output) {
      run.content = run.content.filter((p) => p.type !== 'text'); addText(run, data.output);
    }
    run.state = 'completed';
  }
  if (['run.failed', 'run.cancelled', 'run.interrupted'].includes(event)) {
    run.state = event === 'run.cancelled' ? 'cancelled' : 'failed'; run.error = data.error?.message ?? data.error ?? 'Remote run interrupted.';
  }
}

export class HermesAdapter {
  constructor(config) { this.config = config; this.kind = 'hermes'; }
  async request(route, body, extraHeaders = {}) {
    const response = await fetch(`${this.config.upstreamUrl.replace(/\/+$/, '')}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${this.config.upstreamKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw Object.assign(new Error(`Hermes ${response.status}: ${(await response.text()).slice(0, 500)}`), { status: response.status });
    return response.json();
  }
  async models() {
    const capabilities = await this.request('/v1/capabilities');
    for (const feature of ['run_status', 'run_events_sse', 'run_stop']) if (!capabilities.features?.[feature]) throw new Error(`Hermes is missing ${feature}. Update Hermes before connecting.`);
    const aliases = await this.request('/v1/models');
    const routes = new Map((aliases.data ?? []).map((entry) => [entry.id, { model: entry.id }]));
    const options = Object.fromEntries([...routes.keys()].map((id) => [id, { efforts: EFFORTS }]));
    let defaultRoute;
    try {
      const inventory = await this.request('/api/model/options?include_unconfigured=false');
      defaultRoute = `${inventory.provider}/${inventory.model}`;
      for (const provider of inventory.providers ?? []) {
        if (provider.authenticated !== true || typeof provider.slug !== 'string') continue;
        const unavailable = new Set((provider.unavailable_models ?? []).map((entry) => typeof entry === 'string' ? entry : entry.id));
        for (const model of provider.models ?? []) {
          const id = typeof model === 'string' ? model : model.id;
          if (typeof id !== 'string' || unavailable.has(id)) continue;
          routes.set(`${provider.slug}/${id}`, { provider: provider.slug, model: id });
          const caps = provider.capabilities?.[id];
          const advertised = Array.isArray(caps?.supported_efforts) ? EFFORTS.filter((e) => caps.supported_efforts.includes(e)) : EFFORTS;
          options[`${provider.slug}/${id}`] = { efforts: caps?.reasoning === false ? [] : advertised.filter((effort) => effort !== 'none' || caps?.can_disable_reasoning !== false) };
        }
      }
    } catch (error) {
      // Older Hermes versions have only the compatibility aliases. A real auth or
      // provider failure must remain visible instead of silently hiding the catalogue.
      if (error.status !== 404) throw error;
    }
    for (const [route, efforts] of Object.entries(this.config.modelEfforts ?? {})) {
      if (!Array.isArray(efforts) || efforts.some((effort) => !EFFORTS.includes(effort)) || new Set(efforts).size !== efforts.length) throw new Error(`Invalid modelEfforts for ${route}. Use distinct Hermes effort names.`);
      if (routes.has(route)) options[route] = { efforts: EFFORTS.filter((e) => efforts.includes(e)) };
    }
    if (routes.has('hermes-agent') && options[defaultRoute] && !Object.hasOwn(this.config.modelEfforts ?? {}, 'hermes-agent')) options['hermes-agent'] = options[defaultRoute];
    this.modelRoutes = routes;
    this.modelOptions = options;
    return [...routes.keys()];
  }
  async modelRequest(session) {
    if (session.modelRequest) return session.modelRequest;
    if (!this.modelRoutes) await this.models();
    const route = this.modelRoutes.get(session.model);
    if (!route) throw new Error('The selected Hermes provider/model is unavailable. Refresh models for a new chat.');
    session.modelRequest = route;
    return route;
  }
  async ensureSession(session) {
    const id = session.upstreamCandidate ?? session.id;
    let result;
    try { result = await this.request('/api/sessions', {
      id, source: 'api_server', ...await this.modelRequest(session),
      system_prompt: `This chat works in ${session.workspace}. Read uploaded files there. Save files you create or edit inside this directory so the user can download them.\n${session.instructions}`,
    }); } catch (error) {
      if (error.status !== 409) throw error;
      result = await this.request(`/api/sessions/${encodeURIComponent(id)}`);
      result = result.session ?? result;
      if ((result.id ?? result.session_id) !== id || result.source !== 'api_server') throw new Error('The upstream session identity belongs to another surface.');
    }
    return result.id ?? result.session_id ?? id;
  }
  async start(run, session) {
    const result = await this.request('/v1/runs', {
      session_id: session.upstreamId, input: run.input,
      instructions: `Use this chat's workspace: ${session.workspace}. Write deliverable files here.\n${session.instructions}`,
      ...await this.modelRequest(session),
      ...(run.effort ? { model_options: { reasoning_effort: run.effort, reasoning: run.effort === 'none' ? { enabled: false } : { enabled: true, effort: run.effort } } } : {}),
    }, { 'Idempotency-Key': run.id });
    if (!result.run_id) throw new Error('Hermes returned no run identity.');
    return result.run_id;
  }
  async observe(run, update, signal) {
    const response = await fetch(`${this.config.upstreamUrl.replace(/\/+$/, '')}/v1/runs/${encodeURIComponent(run.upstreamId)}/events`, {
      headers: { Authorization: `Bearer ${this.config.upstreamKey}`, ...(run.hermesSeq === undefined ? {} : { 'Last-Event-ID': String(run.hermesSeq) }) }, signal,
    });
    for await (const item of sse(response)) {
      const seq = item.data.seq ?? (item.id === undefined ? undefined : Number(item.id));
      if (seq !== undefined && seq <= (run.hermesSeq ?? -1)) continue;
      await update((r) => {
        r.error = undefined;
        applyHermesEvent(r, item.data.event ?? item.event, item.data);
        if (Number.isInteger(seq)) r.hermesSeq = seq;
      });
      if (terminal(run.state)) return;
    }
    if (!terminal(run.state)) await this.reconcile(run, update);
  }
  async reconcile(run, update) {
    let status;
    try { status = await this.request(`/v1/runs/${encodeURIComponent(run.upstreamId)}`); }
    catch (error) {
      if (error.status !== 404) throw error;
      await update((r) => { r.state = 'unknown'; r.error = 'Hermes no longer has this run receipt. Check the host before acknowledging interruption; the turn will not be replayed.'; });
      return;
    }
    await update((r) => {
      applyMetrics(r, status);
      if (status.status === 'completed') applyHermesEvent(r, 'run.completed', status);
      else if (['failed', 'interrupted', 'cancelled'].includes(status.status)) applyHermesEvent(r, status.status === 'cancelled' ? 'run.cancelled' : 'run.failed', status);
      else if (status.status === 'unknown') { r.state = 'unknown'; r.error = 'Hermes restarted with an unknown execution outcome. Resolve it on the host before continuing.'; }
      else {
        r.state = status.status?.startsWith('waiting') ? 'waiting' : status.status === 'stopping' ? 'stopping' : 'running';
        if (status.pending_controls) {
          r.controls = status.pending_controls.map((c) => ({ id: c.prompt_id ?? c.request_id, kind: c.kind?.includes('clar') ? 'clarification' : 'approval', prompt: c.prompt ?? c.description ?? c.question ?? JSON.stringify(c), choices: c.kind?.includes('clar') ? undefined : ['once', 'deny'], generation: c.execution_generation }));
        }
      }
    });
  }
  async stop(run) { await this.request(`/v1/runs/${encodeURIComponent(run.upstreamId)}/stop`, {}); }
  async respond(run, control, answer) {
    const body = { request_id: control.id, execution_generation: control.generation };
    if (control.kind === 'clarification') body.answer = answer;
    else body.choice = answer;
    await this.request(`/v1/runs/${encodeURIComponent(run.upstreamId)}/${control.kind === 'clarification' ? 'clarify' : 'approval'}`, body);
  }
  async acknowledge(run) {
    if (!run.upstreamId) return;
    let status;
    try { status = await this.request(`/v1/runs/${encodeURIComponent(run.upstreamId)}`); }
    catch (error) { if (error.status === 404) return; throw error; }
    if (status.status === 'unknown') {
      await this.request(`/v1/runs/${encodeURIComponent(run.upstreamId)}/resolve-unknown`, { admission_id: status.admission_id, execution_generation: status.execution_generation });
    } else if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(status.status)) {
      throw Object.assign(new Error('Hermes still reports this task as active. Stop it on the host first.'), { status: 409 });
    }
  }
}

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const terminal = (state) => ['completed', 'cancelled', 'failed'].includes(state);
export const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
export function assertId(id) {
  if (!idPattern.test(id ?? '') || ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf'].includes(id)) throw Object.assign(new Error('Invalid identity.'), { status: 400 });
  return id;
}
export function addText(run, text, type = 'text') {
  if (!text) return;
  const last = run.content.at(-1);
  if (last?.type === type) last.text += text;
  else run.content.push({ type, text });
}
export function toolEvent(run, event, done = false) {
  const id = event.id ?? event.tool_call_id;
  const name = event.tool ?? event.name ?? 'Remote tool';
  let tool = id ? run.content.find((p) => p.type === 'tool' && p.id === id) : undefined;
  if (!tool && done) tool = run.content.findLast((p) => p.type === 'tool' && p.name === name && p.status === 'running');
  if (!tool) {
    tool = { type: 'tool', id: id ?? `tool_${run.content.length}`, name, input: typeof event.input === 'object' ? event.input : { preview: event.preview ?? '' }, status: 'running' };
    run.content.push(tool);
  }
  if (done) Object.assign(tool, { status: event.error ? 'error' : 'done', output: typeof event.preview === 'string' ? event.preview : JSON.stringify(event.output ?? ''), durationMs: event.duration ? event.duration * 1000 : undefined });
}
export async function* sse(response) {
  if (!response.ok) throw new Error(`Upstream ${response.status}: ${(await response.text()).slice(0, 300)}`);
  let buffer = '', name = 'message', data = [], id;
  const dispatch = () => {
    const value = data.join('\n');
    const event = name, eventId = id;
    name = 'message'; data = []; id = undefined;
    if (!value || value === '[DONE]') return null;
    return { event, id: eventId, data: JSON.parse(value) };
  };
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
      if (!line) { const value = dispatch(); if (value) yield value; }
      else if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
  }
  if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart());
  const value = dispatch(); if (value) yield value;
}

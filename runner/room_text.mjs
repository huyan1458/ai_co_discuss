/** Chinese room records retain their source text; the website chooses the display language. */
const templates = new Map();
const MAX_TEMPLATES = 1024;
/** Render and remember a room-owned template, preserving external content as parameters. */
export function room_text(template, params = {}) {
  params = Object.fromEntries(Object.entries(params).map(([name, value]) => [name, typeof value === 'number' ? value : String(value)]));
  const value = template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
  templates.set(value, { template, params });
  if (templates.size > MAX_TEMPLATES) templates.delete(templates.keys().next().value);
  return value;
}
/** Attach validated text metadata at the room API boundary, without changing source strings. */
export function room_payload(value) {
  if (Array.isArray(value)) return value.map(room_payload);
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, room_payload(item)]));
  for (const field of ['reason', 'label', 'error', ...(value.seq !== undefined ? ['text'] : [])]) {
    const metadata = templates.get(value[field]);
    if (metadata && !result[`${field}_text`]) result[`${field}_text`] = metadata;
  }
  return result;
}

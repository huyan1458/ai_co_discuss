/**
 * How a workflow or sub-workflow is named with "/" in a room message, shared by the page that writes it (the input
 * box's "/" menu) and the runner that reads it back for the host's task, so the two cannot drift apart.
 * Pure JavaScript with no Node.js modules: the page imports it too.
 */

// `/name` starting a word; a path such as a/b or /a/b names nothing.
const SLASH_NAME = /(?:^|[\s(（，,。；;：:])\/([A-Za-z0-9][\w:.-]*)(?![\w:/-])/gu;

/** What the "/" menu inserts for a workflow or sub-workflow ID, with a space for the text that follows. */
export function slash_insertion(id, target) {
  if (target?.scope === 'global') return `/global:${id} `;
  if (target?.scope === 'project' && target.project_id) return `/project:${target.project_id}:${id} `;
  return `/${id} `;
}

/** Decode a scoped menu choice or a bare workflow name. */
export function parse_slash_workflow(token) {
  const name = String(token).trim().replace(/^\//, '');
  const parts = name.split(':');
  if (parts.length === 2 && parts[0] === 'global' && parts[1]) return { id: parts[1], scope: 'global', project_id: '' };
  if (parts.length === 3 && parts[0] === 'project' && parts[1] && parts[2]) return { id: parts[2], scope: 'project', project_id: parts[1] };
  return { id: name, scope: '', project_id: '' };
}

/** The names a message gives with "/", outside code and quotes, each once in order of appearance. */
export function slash_names(text) {
  const prose = String(text || '').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '').replace(/^>.*$/gm, '');
  return [...new Set([...prose.matchAll(SLASH_NAME)].map(match => match[1]))];
}

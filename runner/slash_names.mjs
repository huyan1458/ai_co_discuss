/**
 * How a workflow or sub-workflow is named with "/" in a room message, shared by the page that writes it (the input
 * box's "/" menu) and the runner that reads it back for the host's task, so the two cannot drift apart.
 * Pure JavaScript with no Node.js modules: the page imports it too.
 */

// `/name` starting a word; a path such as a/b or /a/b names nothing.
const SLASH_NAME = /(?:^|[\s(（，,。；;：:])\/([A-Za-z0-9][\w:.-]*)(?![\w:/-])/gu;

/** What the "/" menu inserts for a workflow or sub-workflow ID, with a space for the text that follows. */
export function slash_insertion(id) {
  return `/${id} `;
}

/** The names a message gives with "/", outside code and quotes, each once in order of appearance. */
export function slash_names(text) {
  const prose = String(text || '').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '').replace(/^>.*$/gm, '');
  return [...new Set([...prose.matchAll(SLASH_NAME)].map(match => match[1]))];
}

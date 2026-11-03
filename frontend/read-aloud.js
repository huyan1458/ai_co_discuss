/**
 * Read-aloud for the transcript: split a rendered message into sentences, have the local service synthesize each one,
 * play them in order with the current sentence highlighted, then go on through later messages up to the latest.
 */
import { reactive } from "vue";

const HIGHLIGHT_NAME = "codiscuss-reading";
// Code is skipped; the rest is read as plain text (links and tables by their words).
const SKIP_SELECTOR = "pre, svg, script, style, button, .katex-mathml";
const BLOCK_TAGS = new Set(["P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "TR", "TD", "TH", "DIV", "UL", "OL", "TABLE", "DT", "DD", "BR", "HR", "PRE"]);
const SENTENCE_END = /[。！？!?；;…\n]/;
const CLOSING = /[”’」』）)"'\]】]/;
const SOFT_BREAK = /[，、,：:\s]/;
// Short enough to start quickly and keep one synthesized answer small over the relay; the service allows 300.
const MAX_SENTENCE = 120;
const PREFETCH = 2;

/** Flatten an element's readable text, remembering where each character lives so a sentence can be highlighted. */
function collect_text(root) {
  const chars = [], points = [];
  const separate = () => { if (chars.length && chars[chars.length - 1] !== "\n") { chars.push("\n"); points.push(null); } };
  const visit = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      for (let offset = 0; offset < node.data.length; offset += 1) { chars.push(node.data[offset]); points.push([node, offset]); }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const block = BLOCK_TAGS.has(node.tagName);
    if (block) separate();
    if (!node.matches(SKIP_SELECTOR)) for (const child of node.childNodes) visit(child);
    if (block) separate();
  };
  visit(root);
  return { text: chars.join(""), points };
}

/** Cut flattened text into sentences that each carry a highlight range. */
function split_sentences({ text, points }, from = 0) {
  const sentences = [];
  const push = (start, end) => {
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    if (end <= start || !/[\p{L}\p{N}]/u.test(text.slice(start, end))) return;
    const range = document.createRange();
    range.setStart(...points[start]);
    const [node, offset] = points[end - 1];
    range.setEnd(node, offset + 1);
    sentences.push({ text: text.slice(start, end).replace(/\s+/g, " "), range });
  };
  let start = from;
  for (let index = from; index < text.length; index += 1) {
    if (SENTENCE_END.test(text[index])) {
      let end = index + 1;
      while (end < text.length && CLOSING.test(text[end])) end += 1;
      push(start, end); start = end; index = end - 1;
    } else if (index - start + 1 >= MAX_SENTENCE) {
      let cut = index;
      while (cut > start + MAX_SENTENCE / 2 && !SOFT_BREAK.test(text[cut])) cut -= 1;
      if (cut <= start + MAX_SENTENCE / 2) cut = index;
      push(start, cut + 1); start = cut + 1;
    }
  }
  push(start, text.length);
  return sentences;
}

/** The first character at or after where a selection begins, or 0 when the selection is elsewhere. */
function selection_index({ points }, selection) {
  const index = points.findIndex(point => point && selection.comparePoint(point[0], point[1]) >= 0);
  return Math.max(0, index);
}

/**
 * Create the transcript reader.
 * @param {object} options
 * @param {object} options.bridge Page bridge; uses local_request, notify and display_name.
 * @param {() => HTMLElement} options.container The transcript element, searched in display order.
 * @param {(id: number) => Promise<void>} options.prepare Show a message in full before it is read.
 * @param {(id: number) => string} options.author Author name of a message.
 * @returns {{ state: { message_id: number, loading: boolean }, start: Function, stop: Function, body_of: Function }}
 */
export function use_read_aloud({ bridge, container, prepare, author }) {
  const state = reactive({ message_id: 0, loading: false });
  let run = 0, context = null, source = null;

  const body_of = (id) => container()?.querySelector(`.channel-message[data-message-id="${id}"] .channel-answer > .channel-message-text`) || null;

  /** The message shown after this one, read from the page so new arrivals are included. */
  function next_message(id) {
    const ids = [...(container()?.querySelectorAll(".channel-message[data-message-id]") || [])].map(node => Number(node.dataset.messageId));
    const index = ids.indexOf(id);
    return index >= 0 ? ids.slice(index + 1).find(next => body_of(next)) || 0 : 0;
  }

  function highlight(range) {
    if (!globalThis.CSS?.highlights || typeof Highlight !== "function") return;
    if (range) CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
    else CSS.highlights.delete(HIGHLIGHT_NAME);
  }

  /** Ask the local service for one sentence and decode it for playback. */
  async function synthesize(text) {
    const { audio } = await bridge.local_request("tts", { text });
    const bytes = Uint8Array.from(atob(audio), character => character.charCodeAt(0));
    return context.decodeAudioData(bytes.buffer);
  }

  function play(buffer) {
    return new Promise((resolve) => {
      source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = resolve;
      source.start();
    });
  }

  /** Read a list of sentences in order, keeping a few synthesized ahead; false when stopped. */
  async function read_sentences(sentences, token) {
    const pending = [];
    const fetch_at = (index) => { if (index < sentences.length && !pending[index]) pending[index] = synthesize(sentences[index].spoken || sentences[index].text); };
    for (let index = 0; index < sentences.length; index += 1) {
      for (let ahead = 0; ahead <= PREFETCH; ahead += 1) fetch_at(index + ahead);
      state.loading = true;
      const buffer = await pending[index];
      state.loading = false;
      if (token !== run) return false;
      highlight(sentences[index].range);
      sentences[index].range.startContainer.parentElement?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      await play(buffer);
      if (token !== run) return false;
    }
    return true;
  }

  function stop() {
    run += 1;
    const playing = source;
    source = null;
    try { playing?.stop(); } catch { /* Already ended. */ }
    Object.assign(state, { message_id: 0, loading: false });
    highlight(null);
  }

  /**
   * Read from a message (or from where a selection inside it begins) through to the latest message.
   * Must be called from the click itself so mobile browsers allow sound.
   */
  async function start(message_id, selection = null) {
    stop();
    const token = run;
    context ||= new AudioContext();
    context.resume();
    // Expanding a shortened answer replaces its text nodes, so a selection is turned into a character position first.
    const first_body = selection && body_of(message_id);
    let id = message_id, from = first_body ? selection_index(collect_text(first_body), selection) : 0;
    let announce = !selection;
    try {
      while (id && token === run) {
        state.message_id = id;
        await prepare(id);
        const body = body_of(id);
        if (body) {
          const sentences = split_sentences(collect_text(body), from);
          if (sentences.length && announce) sentences[0].spoken = `${bridge.display_name(author(id))}：${sentences[0].text}`;
          if (!await read_sentences(sentences, token)) return;
        }
        from = 0;
        announce = true;
        id = next_message(id);
      }
    } catch (error) {
      if (token === run) bridge.notify("error", `朗读失败：${error.message}`);
    }
    if (token === run) stop();
  }

  return { state, start, stop, body_of };
}

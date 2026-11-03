/**
 * Read-aloud for the transcript: split a rendered message into sentences, group them into paragraphs the local service
 * synthesizes in one go (so pauses and intonation stay natural), play them with the sentence being spoken highlighted
 * from the service's word timings, then go on through later messages up to the latest.
 */
import { reactive } from "vue";

// Code is skipped; the rest is read as plain text (links and tables by their words).
const SKIP_SELECTOR = "pre, svg, script, style, button, .katex-mathml";
const BLOCK_TAGS = new Set(["P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "TR", "TD", "TH", "DIV", "UL", "OL", "TABLE", "DT", "DD", "BR", "HR", "PRE"]);
const SENTENCE_END = /[。！？!?；;…\n]/;
const CLOSING = /[”’」』）)"'\]】]/;
const SOFT_BREAK = /[，、,：:\s]/;
const MAX_SENTENCE = 120;
// One request reads a whole paragraph up to this length; the service allows 300 and the relay answer must stay small.
const MAX_CHUNK = 200;
const PREFETCH = 1;
// Silence added between paragraphs and between messages, on top of the service's own pauses.
const PARAGRAPH_GAP_MS = 350;
const MESSAGE_GAP_MS = 700;
// The sentence being read stays between these fractions of the transcript height; when it leaves, it is brought to the anchor.
const FOLLOW_TOP = 0.12;
const FOLLOW_BOTTOM = 0.75;
const FOLLOW_ANCHOR = 0.3;
const READABLE = /[\p{L}\p{N}]/gu;
const readable_length = (text) => (text.match(READABLE) || []).length;

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

/** One range per text node a sentence covers, so highlight boxes never double up on inline elements. */
function text_ranges(points, start, end) {
  const ranges = [];
  for (let index = start; index < end; index += 1) {
    const point = points[index];
    if (!point) continue;
    const last = ranges[ranges.length - 1];
    if (last && last.endContainer === point[0] && last.endOffset === point[1]) { last.setEnd(point[0], point[1] + 1); continue; }
    const range = document.createRange();
    range.setStart(point[0], point[1]);
    range.setEnd(point[0], point[1] + 1);
    ranges.push(range);
  }
  return ranges;
}

/** Cut flattened text into sentences that each carry the ranges to highlight. */
function split_sentences({ text, points }, from = 0) {
  const sentences = [];
  const push = (start, end) => {
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    if (end <= start || !/[\p{L}\p{N}]/u.test(text.slice(start, end))) return;
    let after = end;
    while (after < text.length && text[after] !== "\n" && /\s/.test(text[after])) after += 1;
    sentences.push({ text: text.slice(start, end).replace(/\s+/g, " "), ranges: text_ranges(points, start, end),
      paragraph_end: after >= text.length || text[after] === "\n" });
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
 * @returns {{ state: { message_id: number, loading: boolean, paused: boolean }, start: Function, stop: Function, toggle_pause: Function, body_of: Function }}
 */
export function use_read_aloud({ bridge, container, prepare, author }) {
  const state = reactive({ message_id: 0, loading: false, paused: false });
  let run = 0, context = null, source = null, layer = null, current = null;

  const body_of = (id) => container()?.querySelector(`.channel-message[data-message-id="${id}"] .channel-answer > .channel-message-text`) || null;

  /** The message shown after this one, read from the page so new arrivals are included. */
  function next_message(id) {
    const ids = [...(container()?.querySelectorAll(".channel-message[data-message-id]") || [])].map(node => Number(node.dataset.messageId));
    const index = ids.indexOf(id);
    return index >= 0 ? ids.slice(index + 1).find(next => body_of(next)) || 0 : 0;
  }

  /**
   * Draw the sentence as boxes in a layer under the text of its answer. Drawn boxes are removed reliably everywhere;
   * Safari can leave an earlier CSS highlight painted.
   */
  function highlight(sentence) {
    layer?.remove();
    layer = null;
    current = sentence;
    const host = sentence?.ranges[0]?.startContainer.parentElement?.closest(".channel-answer");
    if (!host) return;
    const origin = host.getBoundingClientRect();
    layer = document.createElement("div");
    layer.className = "channel-reading-layer";
    layer.classList.toggle("is-paused", state.paused);
    for (const range of sentence.ranges) for (const rect of range.getClientRects()) {
      if (!rect.width) continue;
      const box = document.createElement("i");
      Object.assign(box.style, { left: `${rect.left - origin.left}px`, top: `${rect.top - origin.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      layer.append(box);
    }
    host.append(layer);
  }

  /** Keep the sentence being read in view: once it leaves the comfortable band, bring it to about a third from the top. */
  function follow_scroll() {
    const scroller = container(), box = layer?.firstElementChild;
    if (!scroller || !box) return;
    const view = scroller.getBoundingClientRect(), line = box.getBoundingClientRect();
    if (line.top >= view.top + view.height * FOLLOW_TOP && line.bottom <= view.top + view.height * FOLLOW_BOTTOM) return;
    scroller.scrollBy({ top: line.top - (view.top + view.height * FOLLOW_ANCHOR), behavior: "smooth" });
  }

  /** Pause or resume where it is, as when tapping the sentence being read. */
  function toggle_pause() {
    if (!state.message_id || !context) return;
    state.paused = !state.paused;
    if (state.paused) context.suspend(); else context.resume();
    layer?.classList.toggle("is-paused", state.paused);
    if (state.paused) bridge.notify("info", "已暂停 · 点击高亮文字继续");
  }

  /** A tap on the highlighted sentence pauses or resumes; selecting text does not. */
  function tap(event) {
    if (!layer || !document.getSelection()?.isCollapsed) return;
    const hit = [...layer.children].some((box) => {
      const rect = box.getBoundingClientRect();
      return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    });
    if (hit) toggle_pause();
  }

  /** Group sentences into paragraph-sized requests; a long paragraph is split only between sentences. */
  function chunks_of(sentences, prefix) {
    const chunks = [];
    let chunk = null;
    for (const sentence of sentences) {
      if (!chunk || chunk.text.length + sentence.text.length > MAX_CHUNK) {
        const first = !chunks.length;
        chunks.push(chunk = { sentences: [], text: first ? prefix : "", prefix: first ? readable_length(prefix) : 0, gap: 0 });
      }
      chunk.sentences.push(sentence);
      chunk.text += sentence.text;
      chunk.gap = sentence.paragraph_end ? PARAGRAPH_GAP_MS : 0;
      if (sentence.paragraph_end) chunk = null;
    }
    return chunks;
  }

  /** When each sentence starts: readable characters matched to the word timings, or spread evenly if they do not line up. */
  function sentence_starts(chunk, marks, duration) {
    const times = [];
    for (const mark of marks) for (let count = readable_length(mark.w); count > 0; count -= 1) times.push(mark.t);
    const total = chunk.prefix + chunk.sentences.reduce((sum, sentence) => sum + readable_length(sentence.text), 0);
    let offset = chunk.prefix;
    return chunk.sentences.map((sentence, index) => {
      const at = index === 0 ? 0 : times.length >= total ? times[offset] : (offset / Math.max(1, total)) * duration;
      offset += readable_length(sentence.text);
      return at;
    });
  }

  /** Ask the local service for one paragraph and decode it for playback. */
  async function synthesize(chunk, section_id) {
    const { audio, marks } = await bridge.local_request("tts", { text: chunk.text, section_id });
    const bytes = Uint8Array.from(atob(audio), character => character.charCodeAt(0));
    const buffer = await context.decodeAudioData(bytes.buffer);
    return { buffer, starts: sentence_starts(chunk, marks || [], buffer.duration * 1000) };
  }

  /** Play a buffer, moving the highlight as the audio clock (which stops while paused) passes each sentence. */
  function play(sentences, { buffer, starts }) {
    return new Promise((resolve) => {
      let frame = 0, shown = -1;
      source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const begin = context.currentTime;
      const follow = () => {
        const elapsed = (context.currentTime - begin) * 1000;
        let index = 0;
        while (index + 1 < starts.length && starts[index + 1] <= elapsed) index += 1;
        if (index !== shown && sentences[index]) {
          shown = index;
          highlight(sentences[index]);
          follow_scroll();
        }
        frame = requestAnimationFrame(follow);
      };
      source.onended = () => { cancelAnimationFrame(frame); resolve(); };
      source.start();
      follow();
    });
  }

  /** Silence on the audio clock, so a pause also holds the gap. */
  function rest(milliseconds) {
    const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * milliseconds / 1000), context.sampleRate);
    return play([], { buffer, starts: [0] });
  }

  /** Read one message's sentences with one paragraph synthesized ahead; false when stopped. */
  async function read_sentences(sentences, token, prefix, section_id) {
    const chunks = chunks_of(sentences, prefix), pending = [];
    const fetch_at = (index) => { if (index < chunks.length && !pending[index]) pending[index] = synthesize(chunks[index], section_id); };
    for (let index = 0; index < chunks.length; index += 1) {
      for (let ahead = 0; ahead <= PREFETCH; ahead += 1) fetch_at(index + ahead);
      state.loading = true;
      const audio = await pending[index];
      state.loading = false;
      if (token !== run) return false;
      await play(chunks[index].sentences, audio);
      if (token !== run) return false;
      if (index + 1 < chunks.length && chunks[index].gap) await rest(chunks[index].gap);
      if (token !== run) return false;
    }
    return true;
  }

  function stop() {
    run += 1;
    const playing = source;
    source = null;
    try { playing?.stop(); } catch { /* Already ended. */ }
    if (state.paused) context?.resume();
    Object.assign(state, { message_id: 0, loading: false, paused: false });
    highlight(null);
    container()?.removeEventListener("click", tap);
  }

  /**
   * Read from a message (or from where a selection inside it begins) through to the latest message.
   * Must be called from the click itself so mobile browsers allow sound.
   */
  async function start(message_id, selection = null) {
    stop();
    const token = run;
    // iPhone mutes Web Audio under the silent switch unless the page declares itself a player.
    if (navigator.audioSession) navigator.audioSession.type = "playback";
    context ||= new AudioContext();
    context.resume();
    container()?.addEventListener("click", tap);
    // Expanding a shortened answer replaces its text nodes, so a selection is turned into a character position first.
    const first_body = selection && body_of(message_id);
    let id = message_id, from = first_body ? selection_index(collect_text(first_body), selection) : 0;
    let announce = !selection, first = true;
    // One context for the whole pass, so the service carries tone across paragraphs and messages.
    const section_id = crypto.randomUUID();
    try {
      while (id && token === run) {
        state.message_id = id;
        await prepare(id);
        const body = body_of(id);
        const sentences = body ? split_sentences(collect_text(body), from) : [];
        if (sentences.length) {
          if (!first) await rest(MESSAGE_GAP_MS);
          if (token !== run) return;
          if (!await read_sentences(sentences, token, announce ? `${bridge.display_name(author(id))}：` : "", section_id)) return;
          first = false;
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

  // Re-draw on resize: the boxes are fixed to where the text was laid out.
  window.addEventListener("resize", () => { if (current) highlight(current); });

  return { state, start, stop, toggle_pause, body_of };
}

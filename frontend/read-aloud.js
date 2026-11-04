/**
 * Read-aloud for the transcript: split a rendered message into sentences, group them into paragraphs the local service
 * synthesizes in one go (so pauses and intonation stay natural) in the voice set for the author's platform, play them
 * with the sentence being spoken highlighted from the service's word timings, then go on through later messages up to
 * the latest; or, while broadcasting, announce new replies by their summary along with short room narration.
 */
import { reactive } from "vue";

// Code is skipped; the rest is read as plain text (links and tables by their words).
const SKIP_SELECTOR = "pre, svg, script, style, button, .katex-mathml";
const BLOCK_TAGS = new Set(["P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "TR", "TD", "TH", "DIV", "UL", "OL", "TABLE", "DT", "DD", "BR", "HR", "PRE"]);
const SENTENCE_END = /[。！？!?；;…\n]/;
const CLOSING = /[”’」』）)"'\]】]/;
const SOFT_BREAK = /[，、,：:\s]/;
const MAX_SENTENCE = 120;
// One request reads up to this many characters, joining short paragraphs; the service allows 300 and the relay answer
// must stay small. The first request of every message is shorter so reading starts sooner; it is cut the same way however
// the message is reached, so the same text always makes the same requests and a replay is served from the cache.
const MAX_CHUNK = 200;
const FIRST_CHUNK = 80;
// What follows is requested only once the audio already requested would run out within this many seconds (a relayed
// request takes 2–8 s), so a stop leaves little synthesized and billed but never heard. Durations not yet known are
// estimated at the measured ~4.7 readable characters per second.
const LEAD_SECONDS = 15;
const CHARS_PER_SECOND = 4.7;
// Silence added between paragraphs and between messages, on top of the service's own pauses.
const PARAGRAPH_GAP_MS = 350;
const MESSAGE_GAP_MS = 700;
// The sentence being read stays between these fractions of the transcript height; when it leaves, it is brought to the anchor.
const FOLLOW_TOP = 0.12;
const FOLLOW_BOTTOM = 0.75;
const FOLLOW_ANCHOR = 0.3;
// Synthesized requests kept in this page for instant replay.
const MEMORY_LIMIT = 60;
// A broadcast reply without a summary is read whole up to this length; a longer one gives its first paragraph (at least
// BRIEF_MIN_FIRST characters, within this length) and its total length.
const BRIEF_FULL_LENGTH = 200;
const BRIEF_MIN_FIRST = 20;
// Replies piled up beyond this are skipped but for the latest ones.
const BACKLOG_LIMIT = 3;
const READABLE = /[\p{L}\p{N}]/gu;
const readable_length = (text) => (text.match(READABLE) || []).length;
// A document read on its own (a file preview) is not a message; any non-zero id marks that something is playing.
const DOCUMENT_ID = -2;
// Readers on this page (the transcript's and a file preview's) share the speakers: one plays at a time, and a broadcast
// waits while another reader is reading on request.
const readers = new Set();

/** The position just past the first `count` readable characters, so text shown before the reading start is skipped. */
function skip_readable(text, count) {
  let index = 0;
  for (; index < text.length && count > 0; index += 1) if (/[\p{L}\p{N}]/u.test(text[index])) count -= 1;
  return index;
}

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

/** Cut flattened text between `from` and `to` into sentences that each carry the ranges to highlight and their positions. */
function split_sentences({ text, points }, from = 0, to = text.length) {
  const sentences = [];
  const push = (start, end) => {
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    if (end <= start || !/[\p{L}\p{N}]/u.test(text.slice(start, end))) return;
    let after = end;
    while (after < text.length && text[after] !== "\n" && /\s/.test(text[after])) after += 1;
    sentences.push({ text: text.slice(start, end).replace(/\s+/g, " "), ranges: text_ranges(points, start, end),
      paragraph_end: after >= text.length || text[after] === "\n", start, end });
  };
  let start = from;
  for (let index = from; index < to; index += 1) {
    if (SENTENCE_END.test(text[index])) {
      let end = index + 1;
      while (end < to && CLOSING.test(text[end])) end += 1;
      push(start, end); start = end; index = end - 1;
    } else if (index - start + 1 >= MAX_SENTENCE) {
      let cut = index;
      while (cut > start + MAX_SENTENCE / 2 && !SOFT_BREAK.test(text[cut])) cut -= 1;
      if (cut <= start + MAX_SENTENCE / 2) cut = index;
      push(start, cut + 1); start = cut + 1;
    }
  }
  push(start, to);
  return sentences;
}

/** The first character at or after where a selection begins, or 0 when the selection is elsewhere. */
function selection_index({ points }, selection) {
  const index = points.findIndex(point => point && selection.comparePoint(point[0], point[1]) >= 0);
  return Math.max(0, index);
}

/**
 * Create the transcript reader.
 * Playback uses one <audio> element and the Media Session, so it goes on with the screen locked or the page in the
 * background and answers lock-screen and headphone controls; Web Audio would be suspended there.
 * Besides reading on request (`start`), it plays a broadcast queue (`announce`): new replies by their summary and short
 * room narration, one at a time; a reading on request takes over and the queue resumes after it.
 * @param {object} options
 * @param {object} options.bridge Page bridge; uses local_request, notify and display_name.
 * @param {() => HTMLElement} options.container The transcript element, searched in display order.
 * @param {(id: number) => Promise<void>} options.prepare Show a message in full before it is read.
 * @param {(id: number) => object} options.message_of The message with this id from the room view.
 * @param {(name: string) => Promise<string>} options.voice_for Voice for a member, or "" for the default voice.
 * @param {() => string} options.title Room title shown on the lock screen.
 * @param {string} [options.hosts] Selector of the elements the highlight is drawn in (positioned, isolated).
 * @returns {{ state: object, start: Function, read_document: Function, stop: Function, dispose: Function, follow: Function, toggle_pause: Function, body_of: Function, unlock: Function, set_broadcast: Function, announce: Function }}
 */
export function use_read_aloud({ bridge, container, prepare = async () => {}, message_of = () => null, voice_for, title, hosts = ".channel-answer, .channel-answer-summary" }) {
  // `reading`: a reading on request is running (not a broadcast). `following`: the transcript scrolls with the sentence
  // being read; off until the user turns it on, and the page turns it off on any manual scroll.
  const state = reactive({ message_id: 0, loading: false, paused: false, broadcasting: false, reading: false, following: false });
  let run = 0, element = null, ending = null, switching = false, layer = null, current = null, silent_url = "";
  let queue = [], draining = false, broadcast_section = "";
  // Synthesized paragraphs already heard in this page, so replaying is instant even over the relay.
  const memory = new Map();
  const author = (id) => message_of(id)?.author || "";

  const body_of = (id) => container()?.querySelector(`.channel-message[data-message-id="${id}"] .channel-answer > .channel-message-text`) || null;
  const summary_of = (id) => container()?.querySelector(`.channel-message[data-message-id="${id}"] .channel-answer-summary > .channel-message-text`) || null;

  /** The message shown after this one, read from the page so new arrivals are included. */
  function next_message(id) {
    const ids = [...(container()?.querySelectorAll(".channel-message[data-message-id]") || [])].map(node => Number(node.dataset.messageId));
    const index = ids.indexOf(id);
    return index >= 0 ? ids.slice(index + 1).find(next => body_of(next)) || 0 : 0;
  }

  /** A short silent WAV: playing it inside a click unlocks the audio element for later, unprompted playback on phones. */
  function silence() {
    if (silent_url) return silent_url;
    const samples = 800, bytes = new DataView(new ArrayBuffer(44 + samples * 2));
    const text = (offset, value) => [...value].forEach((character, index) => bytes.setUint8(offset + index, character.charCodeAt(0)));
    text(0, "RIFF"); bytes.setUint32(4, 36 + samples * 2, true); text(8, "WAVE"); text(12, "fmt "); bytes.setUint32(16, 16, true);
    bytes.setUint16(20, 1, true); bytes.setUint16(22, 1, true); bytes.setUint32(24, 16000, true); bytes.setUint32(28, 32000, true);
    bytes.setUint16(32, 2, true); bytes.setUint16(34, 16, true); text(36, "data"); bytes.setUint32(40, samples * 2, true);
    return silent_url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  }

  /** The one audio element; a pause from outside (a call, unplugged headphones) shows as paused. */
  function player() {
    if (element) return element;
    element = new Audio();
    element.preload = "auto";
    element.addEventListener("pause", () => { if (!switching && !element.ended && state.message_id) set_paused(true); });
    element.addEventListener("play", () => { if (state.message_id) set_paused(false); });
    return element;
  }

  /** Start the audio element inside the current click, so later playback needs no gesture; also binds the lock screen. */
  function unlock() {
    const audio = player();
    if (state.message_id) return;
    switching = true;
    audio.src = silence();
    audio.play().catch(() => {}).finally(() => { switching = false; });
    bind_media_session();
    container()?.addEventListener("click", tap);
  }

  function set_paused(paused) {
    state.paused = paused;
    layer?.classList.toggle("is-paused", paused);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = paused ? "paused" : "playing";
  }

  /**
   * Draw the sentence as boxes in a layer under the text it belongs to. Drawn boxes are removed reliably everywhere;
   * Safari can leave an earlier CSS highlight painted. Narration has no text on the page and draws nothing.
   */
  function highlight(sentence) {
    layer?.remove();
    layer = null;
    current = sentence;
    const host = sentence?.ranges[0]?.startContainer.parentElement?.closest(hosts);
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
    if (!state.following || !scroller || !box) return;
    const view = scroller.getBoundingClientRect(), line = box.getBoundingClientRect();
    if (line.top >= view.top + view.height * FOLLOW_TOP && line.bottom <= view.top + view.height * FOLLOW_BOTTOM) return;
    scroller.scrollBy({ top: line.top - (view.top + view.height * FOLLOW_ANCHOR), behavior: "smooth" });
  }

  /** Turn following on and bring the sentence being read into view now. */
  function follow() {
    state.following = true;
    follow_scroll();
  }

  /** Pause or resume where it is, as when tapping the sentence being read or using the lock-screen controls. */
  function toggle_pause() {
    if (!state.message_id || !element) return;
    if (element.paused) element.play().catch(() => {});
    else { element.pause(); bridge.notify("info", "已暂停 · 点击高亮文字继续"); }
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

  /** Lock-screen and headphone controls: play, pause, stop, next item, and start this message again. */
  function bind_media_session() {
    if (!("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    session.setActionHandler("play", () => { if (state.paused) toggle_pause(); });
    session.setActionHandler("pause", () => { if (!state.paused) toggle_pause(); });
    session.setActionHandler("stop", () => { set_broadcast(false); stop(); });
    session.setActionHandler("nexttrack", () => {
      if (queue.length || state.broadcasting) return stop();
      const next = next_message(state.message_id);
      if (next) start(next);
    });
    session.setActionHandler("previoustrack", () => { if (state.message_id > 0) start(state.message_id); });
  }

  function show_on_lock_screen(plan) {
    if (!("mediaSession" in navigator) || typeof MediaMetadata !== "function") return;
    // Another reader may have taken the lock-screen controls since; whatever plays now answers them.
    bind_media_session();
    const heading = plan.heading || (plan.id > 0 ? `${bridge.display_name(author(plan.id))} · #${plan.id}` : "共议 · 播报");
    navigator.mediaSession.metadata = new MediaMetadata({ title: heading, artist: "共议 · 朗读", album: title() });
    navigator.mediaSession.playbackState = "playing";
  }

  /**
   * Group sentences into requests of up to MAX_CHUNK characters (the first up to `first_limit`), joining short paragraphs;
   * split only between sentences.
   */
  function chunks_of(sentences, prefix, first_limit = FIRST_CHUNK) {
    const chunks = [];
    let chunk = null;
    for (const sentence of sentences) {
      const limit = chunks.length === 1 ? first_limit : MAX_CHUNK;
      if (!chunk || chunk.text.length + sentence.text.length > limit) {
        const first = !chunks.length;
        chunks.push(chunk = { sentences: [], text: first ? prefix : "", prefix: first ? readable_length(prefix) : 0, silence: 0, end: 0 });
      }
      // A line break between paragraphs lets the service pause as it would between them.
      if (chunk.sentences.at(-1)?.paragraph_end) chunk.text += "\n";
      chunk.sentences.push(sentence);
      chunk.text += sentence.text;
      chunk.silence = sentence.paragraph_end ? PARAGRAPH_GAP_MS : 0;
      chunk.end = sentence.end;
    }
    // The pause before what comes next is part of this item's last audio, so it holds in the background too.
    if (chunks.length) chunks.at(-1).silence = MESSAGE_GAP_MS;
    return chunks;
  }

  /**
   * Requests for reading flattened text from position `from`. They are always cut from `base` (the start of the message,
   * or of a file after its front matter), so the same text makes the same requests and a replay hits the cache. Starting
   * inside a request reads the rest of that one as a single new request, then goes on with the regular ones.
   */
  function chunks_from(flat, base, from, prefix) {
    const chunks = chunks_of(split_sentences(flat, base), prefix);
    if (from <= base) return chunks;
    const index = chunks.findIndex((chunk) => chunk.end > from);
    if (index < 0) return [];
    const { sentences, silence } = chunks[index];
    const cut = sentences.find((sentence) => sentence.start < from && sentence.end > from);
    const rest = [...(cut ? split_sentences(flat, from, cut.end) : []), ...sentences.filter((sentence) => sentence.start >= from)];
    const [head] = chunks_of(rest, "", MAX_CHUNK);
    if (head) head.silence = silence;
    return [...(head ? [head] : []), ...chunks.slice(index + 1)];
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

  /** Ask the local service for one request's audio (or reuse it from this page) as a playable URL with word timings. */
  function synthesize(chunk, section_id, speaker) {
    const key = JSON.stringify([chunk.text, speaker, chunk.silence]);
    if (!memory.has(key)) {
      const pending = bridge.local_request("tts", { text: chunk.text, section_id, speaker: speaker || undefined, silence_ms: chunk.silence })
        .then(({ audio, marks }) => ({ url: URL.createObjectURL(new Blob([Uint8Array.from(atob(audio), (character) => character.charCodeAt(0))], { type: "audio/mpeg" })), marks: marks || [] }));
      pending.catch(() => memory.delete(key));
      memory.set(key, pending);
      if (memory.size > MEMORY_LIMIT) {
        const [oldest] = memory.keys();
        memory.get(oldest).then(({ url }) => URL.revokeObjectURL(url), () => {});
        memory.delete(oldest);
      }
    }
    return memory.get(key);
  }

  /**
   * Play one request, moving the highlight as the audio clock (which stops while paused) passes each sentence.
   * `on_progress` gets the seconds left of it; `timeupdate` also fires with the screen locked, unlike animation frames.
   */
  function play(chunk, { url, marks }, on_progress) {
    return new Promise((resolve, reject) => {
      const audio = player();
      let frame = 0, shown = -1, starts = null;
      const done = (error) => {
        cancelAnimationFrame(frame); ending = null; audio.onended = audio.onerror = audio.ontimeupdate = null; error ? reject(error) : resolve();
      };
      audio.ontimeupdate = () => { if (Number.isFinite(audio.duration)) on_progress(audio.duration - audio.currentTime); };
      ending = () => done();
      const follow = () => {
        starts ||= Number.isFinite(audio.duration) ? sentence_starts(chunk, marks, audio.duration * 1000 - chunk.silence) : null;
        const elapsed = audio.currentTime * 1000;
        let index = 0;
        while (starts && index + 1 < starts.length && starts[index + 1] <= elapsed) index += 1;
        if (index !== shown) { shown = index; highlight(chunk.sentences[index]); follow_scroll(); }
        frame = requestAnimationFrame(follow);
      };
      audio.onended = () => done();
      audio.onerror = () => done(new Error("音频无法播放"));
      switching = true;
      audio.src = url;
      audio.play().then(() => { switching = false; follow(); }, (error) => { switching = false; done(error); });
    });
  }

  /** Plain words with nothing on the page to highlight, as one sentence each. */
  const spoken = (text) => ({ text, ranges: [], paragraph_end: true });

  /** Prepare one message for reading in full: shown in full, split into requests, its voice chosen, nothing synthesized yet. */
  async function plan_message(id, from, prefix) {
    await prepare(id);
    const body = body_of(id);
    return { id, chunks: body ? chunks_from(collect_text(body), 0, from, prefix) : [], speaker: await voice_for(author(id)), pending: [] };
  }

  /**
   * Plan one broadcast message: its summary when it has one; otherwise all of a short answer, or the first paragraph of a
   * long one followed by how long the whole is. A host's message is announced as the host's.
   */
  async function plan_brief(id) {
    const message = message_of(id);
    if (!message) return null;
    const name = bridge.display_name(message.author);
    const prefix = message.kind === "moderation" ? `主持人 ${name}：` : `${name}：`;
    const speaker = await voice_for(message.author);
    const summary = summary_of(id), body = body_of(id);
    let sentences = summary ? split_sentences(collect_text(summary)) : body ? split_sentences(collect_text(body)) : [];
    const length = readable_length(message.text || "");
    if (!summary && length > BRIEF_FULL_LENGTH) {
      const first = [];
      for (const sentence of sentences) {
        if (first.length && first.reduce((sum, item) => sum + item.text.length, 0) + sentence.text.length > BRIEF_FULL_LENGTH) break;
        first.push(sentence);
        if (sentence.paragraph_end && readable_length(first.map((item) => item.text).join("")) >= BRIEF_MIN_FIRST) break;
      }
      sentences = [...first, spoken(`全文约 ${Math.round(length / 100) * 100 || length} 字，点开查看。`)];
    }
    if (!sentences.length) return null;
    return { id, chunks: chunks_of(sentences, prefix), speaker, pending: [] };
  }

  /** Plan one narration line in the default voice. */
  const plan_line = (text) => ({ id: -1, chunks: chunks_of([spoken(text)], ""), speaker: "", pending: [] });

  /** Start synthesizing one request of a plan unless already started; failures surface when it is awaited. */
  function fetch_chunk(plan, index, section_id) {
    if (!plan || index >= plan.chunks.length || plan.pending[index]) return;
    plan.pending[index] = synthesize(plan.chunks[index], section_id, plan.speaker);
    plan.pending[index].catch(() => {});
  }

  /** Estimated seconds of speech in one request. */
  const seconds_of = (chunk) => readable_length(chunk.text) / CHARS_PER_SECOND;

  /** Start requests from `index` on until they hold about `seconds` of speech. */
  function fetch_lead(plan, index, section_id, seconds = LEAD_SECONDS) {
    for (let next = index; next < plan.chunks.length && seconds > 0; next += 1) {
      fetch_chunk(plan, next, section_id);
      seconds -= seconds_of(plan.chunks[next]);
    }
  }

  /**
   * Play one plan's requests. While one plays, what follows is requested once the audio already requested would run out
   * within LEAD_SECONDS; past the plan's last request, `on_tail` lets the next item start preparing.
   */
  async function read_plan(plan, token, section_id, on_tail) {
    const { chunks } = plan;
    for (let index = 0; index < chunks.length; index += 1) {
      fetch_chunk(plan, index, section_id);
      state.loading = true;
      const audio = await plan.pending[index];
      state.loading = false;
      if (token !== run) return false;
      await play(chunks[index], audio, (left) => {
        let next = index + 1;
        while (next < chunks.length && plan.pending[next]) left += seconds_of(chunks[next++]);
        if (left >= LEAD_SECONDS) return;
        if (next < chunks.length) fetch_lead(plan, next, section_id, LEAD_SECONDS - left);
        else on_tail();
      });
      if (token !== run) return false;
    }
    return true;
  }

  /** Stop what is playing; a broadcast goes on with its next queued item unless it was turned off. */
  function stop() {
    run += 1;
    ending?.();
    if (element) { element.pause(); element.removeAttribute("src"); }
    Object.assign(state, { message_id: 0, loading: false, paused: false, reading: false });
    highlight(null);
    if ("mediaSession" in navigator) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = "none"; }
    queueMicrotask(() => readers.forEach((reader) => reader.drain()));
  }

  /** Stop any other reader on the page that is playing, so a reading on request is heard alone. */
  function claim() {
    for (const reader of readers) if (reader !== api && reader.state.message_id) reader.stop();
  }
  const reading_elsewhere = () => [...readers].some((reader) => reader !== api && reader.state.reading);

  /** Turn broadcasting on or off; off drops whatever is still queued. Turning it on must happen in a click. */
  function set_broadcast(on) {
    state.broadcasting = on;
    if (on) { unlock(); broadcast_section = crypto.randomUUID(); return; }
    queue = [];
    if (draining) stop();
  }

  /**
   * Queue broadcast items in order: `{ message_id }` for a reply, `{ text }` for a narration line. When replies pile up,
   * only the latest few are kept behind one line saying how many arrived.
   */
  function announce(...items) {
    if (!state.broadcasting) return;
    queue.push(...items);
    const replies = queue.filter((item) => item.message_id);
    if (replies.length > BACKLOG_LIMIT) {
      const kept = new Set(replies.slice(-BACKLOG_LIMIT));
      queue = [{ text: `有 ${replies.length} 条新回复，播最新 ${BACKLOG_LIMIT} 条。` }, ...queue.filter((item) => !item.message_id || kept.has(item))];
    }
    drain();
  }

  /** Play queued broadcast items one at a time while nothing else is playing. */
  async function drain() {
    if (draining || state.message_id || !state.broadcasting || !queue.length || reading_elsewhere()) return;
    draining = true;
    const token = run;
    try {
      while (queue.length && token === run && state.broadcasting) {
        const item = queue.shift();
        const plan = item.message_id ? await plan_brief(item.message_id) : plan_line(item.text);
        if (!plan || token !== run) continue;
        state.message_id = plan.id;
        show_on_lock_screen(plan);
        if (!await read_plan(plan, token, broadcast_section, () => {})) break;
        state.message_id = 0;
      }
    } catch (error) {
      if (token === run) bridge.notify("error", `播报失败：${error.message}`);
    } finally {
      draining = false;
      if (token === run) { state.message_id = 0; highlight(null); }
    }
  }

  /**
   * Read from a message (or from where a selection inside it begins) through to the latest message.
   * Must be called from the click itself so phones allow sound. A running broadcast waits until it ends.
   */
  async function start(message_id, selection = null) {
    stop();
    const token = run;
    // Unlock the element within this click; later paragraphs then play without a gesture, also with the screen locked.
    unlock();
    claim();
    // Expanding a shortened answer replaces its text nodes, so a selection is turned into a character position first.
    const first_body = selection && body_of(message_id);
    const from = first_body ? selection_index(collect_text(first_body), selection) : 0;
    // One context for the whole pass, so the service carries tone across paragraphs and messages.
    const section_id = crypto.randomUUID();
    const prefix_of = (id) => `${bridge.display_name(author(id))}：`;
    Object.assign(state, { message_id, reading: true, following: false });
    try {
      // The author is named even from a selection at the very start, so those requests match a plain reading's.
      let plan = await plan_message(message_id, from, prefix_of(message_id));
      while (plan && token === run) {
        state.message_id = plan.id;
        show_on_lock_screen(plan);
        // The next message is planned and its first requests started while this one is still playing.
        let upcoming = null;
        const prepare_next = () => {
          upcoming ||= (async () => {
            const next = next_message(plan.id);
            if (!next) return null;
            const ready = await plan_message(next, 0, prefix_of(next));
            fetch_lead(ready, 0, section_id);
            return ready;
          })();
        };
        if (plan.chunks.length && !await read_plan(plan, token, section_id, prepare_next)) return;
        prepare_next();
        // A message that arrived after the early look is still found here.
        const ready = await upcoming;
        const next = ready?.id || next_message(plan.id);
        if (token !== run) return;
        plan = next ? (ready?.id === next ? ready : await plan_message(next, 0, prefix_of(next))) : null;
      }
    } catch (error) {
      if (token === run) bridge.notify("error", `朗读失败：${error.message}`);
    }
    if (token === run) stop();
  }

  /**
   * Read one rendered document (a file preview) to its end: from where a selection inside it begins, or from its start
   * after `skip` readable characters (front matter). Must be called from the click itself so phones allow sound.
   * @param {HTMLElement} root The rendered document.
   * @param {{ selection?: Range, skip?: number, heading?: string }} [options]
   */
  async function read_document(root, { selection = null, skip = 0, heading = "" } = {}) {
    stop();
    const token = run;
    unlock();
    claim();
    Object.assign(state, { message_id: DOCUMENT_ID, reading: true, following: false });
    try {
      const flat = collect_text(root);
      const base = skip_readable(flat.text, skip);
      const from = selection ? selection_index(flat, selection) : base;
      const plan = { id: DOCUMENT_ID, heading, chunks: chunks_from(flat, base, from, ""), speaker: await voice_for(""), pending: [] };
      if (token === run) { show_on_lock_screen(plan); await read_plan(plan, token, crypto.randomUUID(), () => {}); }
    } catch (error) {
      if (token === run) bridge.notify("error", `朗读失败：${error.message}`);
    }
    if (token === run) stop();
  }

  // Re-draw on resize: the boxes are fixed to where the text was laid out.
  const redraw = () => { if (current) highlight(current); };
  window.addEventListener("resize", redraw);

  /** Stop and leave the page's readers, for a reader whose view goes away. */
  function dispose() {
    stop();
    readers.delete(api);
    window.removeEventListener("resize", redraw);
  }

  const api = { state, start, read_document, stop, dispose, drain, follow, toggle_pause, body_of, unlock, set_broadcast, announce };
  readers.add(api);
  return api;
}

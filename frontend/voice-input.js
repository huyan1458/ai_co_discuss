/**
 * Voice input for the composer: record the microphone as 16 kHz mono PCM, send it to the local service in parts while
 * recording, and when stopped have the last part recognized into text.
 */
import { nextTick, onBeforeUnmount, onMounted, reactive } from "vue";
import { ENTER_SENDS } from "./enter-sends.js";

const TARGET_RATE = 16000;
// Six seconds per part keeps each relayed request (base64, then sealed and base64 again) under the 512 KiB body limit.
const PART_BYTES = TARGET_RATE * 2 * 6;
const MAX_SECONDS = 300;
const LEVEL_BARS = 32;
const PROCESSOR_SIZE = 4096;

function to_base64(bytes) {
  let text = "";
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}

/**
 * Create the composer's voice recorder.
 * @param {object} options
 * @param {object} options.bridge Page bridge; uses local_request and notify.
 * @param {(text: string) => void} options.on_text Receives recognized text.
 * @returns {{ state: { status: string, levels: number[], seconds: number, capturing: boolean }, toggle: Function, cancel: Function, resume: Function }}
 */
export function use_voice_input({ bridge, on_text }) {
  const state = reactive({ status: "", levels: Array(LEVEL_BARS).fill(0), seconds: 0, capturing: false });
  let session = null, starting = null;
  // Kept after the first recording: a touch press does not count as a user gesture, so a context made then may stay
  // suspended, while one already running can be reused for press-and-hold.
  let context = null;

  /** Average the input down to 16 kHz, carrying the fractional position across buffers. */
  function resample(recording, input) {
    const ratio = recording.rate / TARGET_RATE, output = [];
    let position = recording.position;
    while (position + ratio <= input.length) {
      let sum = 0, count = 0;
      for (let index = Math.floor(position); index < Math.floor(position + ratio); index += 1) { sum += input[index]; count += 1; }
      output.push(count ? sum / count : 0);
      position += ratio;
    }
    recording.position = position - input.length;
    return output;
  }

  /** Queue one part for upload; parts go strictly in order. */
  function send(recording, bytes, final) {
    const index = recording.index++;
    recording.chain = recording.chain.then(() => bridge.local_request("stt", { upload_id: recording.id, index, data: to_base64(bytes), final }));
    return recording.chain;
  }

  function take_pending(recording) {
    const bytes = new Uint8Array(recording.pending.buffer, 0, recording.pending_length * 2).slice();
    recording.pending_length = 0;
    return bytes;
  }

  function capture(recording, event) {
    const input = event.inputBuffer.getChannelData(0);
    let energy = 0;
    for (const sample of input) energy += sample * sample;
    state.capturing = true;
    state.levels = [...state.levels.slice(1), Math.min(1, Math.sqrt(energy / input.length) * 6)];
    for (const sample of resample(recording, input)) {
      recording.pending[recording.pending_length++] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      if (recording.pending_length * 2 >= PART_BYTES) send(recording, take_pending(recording), false).catch(() => {});
    }
    recording.samples += input.length;
    state.seconds = Math.floor(recording.samples / recording.rate);
    if (state.seconds >= MAX_SECONDS) finish();
  }

  function release(recording) {
    recording.processor.disconnect();
    recording.source.disconnect();
    recording.stream.getTracks().forEach((track) => track.stop());
  }

  async function begin() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("此浏览器不支持录音；本机网页请用 127.0.0.1 打开，线上网页须为 HTTPS");
    // Created inside the press so phones let it run.
    context ??= new AudioContext();
    context.resume().catch(() => {});
    const token = starting = {};
    state.status = "starting";
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
    catch (error) {
      if (starting === token) state.status = "";
      if (token.cancelled) return;
      throw new Error(error.name === "NotAllowedError" ? "没有麦克风权限，请在浏览器设置中允许本站使用麦克风" : `无法打开麦克风：${error.message}`);
    }
    finally { if (starting === token) starting = null; }
    // Cancelled while the browser was still opening the microphone.
    if (token.cancelled) { stream.getTracks().forEach((track) => track.stop()); return; }
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(PROCESSOR_SIZE, 1, 1);
    const recording = { id: crypto.randomUUID(), context, stream, source, processor, rate: context.sampleRate, position: 0,
      pending: new Int16Array(PART_BYTES), pending_length: 0, index: 0, samples: 0, chain: Promise.resolve() };
    processor.onaudioprocess = (event) => capture(recording, event);
    source.connect(processor);
    processor.connect(context.destination);
    session = recording;
    Object.assign(state, { status: "recording", seconds: 0, capturing: false, levels: Array(LEVEL_BARS).fill(0) });
  }

  /** Stop recording and turn everything recorded into text. */
  async function finish() {
    const recording = session;
    if (!recording || state.status !== "recording") return;
    release(recording);
    state.status = "transcribing";
    try {
      const { text } = await send(recording, take_pending(recording), true);
      if (session !== recording) return;
      if (text) on_text(text);
      else bridge.notify("warning", "没有识别到说话内容");
    } catch (error) {
      if (session === recording) bridge.notify("error", `语音输入失败：${error.message}`);
    } finally {
      if (session === recording) { session = null; state.status = ""; }
    }
  }

  /** Start recording, or stop and recognize when already recording. */
  async function toggle() {
    if (state.status === "recording") return finish();
    if (state.status || starting) return;
    try { await begin(); } catch (error) { bridge.notify("error", error.message); }
  }

  /** Discard a recording in progress without recognizing it. */
  function cancel() {
    if (starting) starting.cancelled = true;
    if (session && state.status === "recording") release(session);
    session = null;
    state.status = "";
  }

  /** Resume audio from inside a user gesture, for a press that could not start it. */
  function resume() { context?.resume().catch(() => {}); }

  return { state, toggle, cancel, resume };
}

// Touch: hold the microphone to talk and let go to finish, slide up to discard; a short tap keeps recording until ✓.
const VOICE_HOLD_MS = 300;
const VOICE_CANCEL_SLIDE_PX = 60;

/** Recording time as m:ss. */
export const format_voice_time = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * How the composer's microphone is pressed: tap or hold on touch, click with a mouse, hold Space on desktop, and while
 * recording Esc discards and Enter finishes. Call from a component's setup; the keys are watched while it is mounted.
 * @param {object} options
 * @param {ReturnType<typeof use_voice_input>} options.voice The recorder.
 * @param {() => HTMLTextAreaElement | undefined} options.textarea The composer's text area.
 * @param {import("vue").Ref<string>} options.text The composer's text.
 * @param {() => boolean} options.busy Whether a send is in progress, which keeps recording from starting.
 * @returns {{ hold: { by: string, discard: boolean }, pointerdown: Function, click: Function }}
 */
export function use_voice_press({ voice, textarea, text, busy }) {
  // How the current recording is being held: "" (tap mode), "touch" or "space"; `discard` while slid up to cancel.
  const hold = reactive({ by: "", discard: false });
  let press = null, touch_click = false;

  function pointerdown(event) {
    touch_click = event.pointerType !== "mouse";
    if (!touch_click || voice.state.status || busy()) return;
    press = { id: event.pointerId, y: event.clientY, at: event.timeStamp };
    Object.assign(hold, { by: "touch", discard: false });
    // The button is replaced by the recording bar under the finger, so the rest of the press is followed on the window.
    window.addEventListener("pointermove", pointermove);
    window.addEventListener("pointerup", pointerup);
    window.addEventListener("pointercancel", pointerup);
    voice.toggle();
  }
  function pointermove(event) {
    if (event.pointerId === press?.id) hold.discard = press.y - event.clientY > VOICE_CANCEL_SLIDE_PX;
  }
  function pointerup(event) {
    if (event.pointerId !== press?.id) return;
    window.removeEventListener("pointermove", pointermove);
    window.removeEventListener("pointerup", pointerup);
    window.removeEventListener("pointercancel", pointerup);
    const held = event.type === "pointerup" && event.timeStamp - press.at >= VOICE_HOLD_MS, { discard } = hold;
    press = null;
    Object.assign(hold, { by: "", discard: false });
    voice.resume();
    if (discard) voice.cancel();
    // A tap, or a hold the browser would not record yet (first permission prompt), stays on as tap mode.
    else if (held && voice.state.status === "recording" && voice.state.capturing) voice.toggle();
  }
  /** Mouse clicks toggle recording; the click that ends a touch press is already handled by the press. */
  function click() {
    if (touch_click) { touch_click = false; return; }
    voice.toggle();
  }
  // Desktop: holding Space in the composer (or with nothing focused) talks until it is let go. A hold is known once
  // the key starts repeating; the one space the first press typed is taken back.
  function space_down(event) {
    if (hold.by === "space") { event.preventDefault(); return; }
    const area = textarea();
    if (!event.repeat || voice.state.status || busy() || ![area, document.body].includes(event.target)) return;
    event.preventDefault();
    const caret = area?.selectionStart ?? 0;
    if (event.target === area && text.value?.[caret - 1] === " ") {
      text.value = `${text.value.slice(0, caret - 1)}${text.value.slice(caret)}`;
      nextTick(() => area.setSelectionRange(caret - 1, caret - 1));
    }
    hold.by = "space";
    voice.toggle();
  }
  function keyup(event) {
    if (event.code !== "Space" || hold.by !== "space") return;
    event.preventDefault();
    hold.by = "";
    if (voice.state.status === "recording") voice.toggle();
  }
  /** While voice input is on, Esc discards it and Enter finishes it instead of sending; runs before the composer's keys. */
  function keydown(event) {
    if (event.isComposing) return;
    if (event.code === "Space" && !(event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)) return space_down(event);
    if (!voice.state.status) return;
    const finish = event.key === "Enter" && ENTER_SENDS && !event.shiftKey;
    if (event.key !== "Escape" && !finish) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") voice.cancel();
    else if (voice.state.status === "recording") voice.toggle();
  }
  onMounted(() => { window.addEventListener("keydown", keydown, true); window.addEventListener("keyup", keyup, true); });
  onBeforeUnmount(() => { window.removeEventListener("keydown", keydown, true); window.removeEventListener("keyup", keyup, true); });
  return { hold, pointerdown, click };
}

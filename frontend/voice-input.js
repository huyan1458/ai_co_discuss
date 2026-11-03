/**
 * Voice input for the composer: record the microphone as 16 kHz mono PCM, send it to the local service in parts while
 * recording, and when stopped have the last part recognized into text.
 */
import { reactive } from "vue";

const TARGET_RATE = 16000;
// Six seconds per part keeps each relayed request (base64, then sealed and base64 again) under the 512 KiB body limit.
const PART_BYTES = TARGET_RATE * 2 * 6;
const MAX_SECONDS = 300;
const LEVEL_BARS = 14;
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
 * @returns {{ state: { status: string, levels: number[], seconds: number }, toggle: Function, cancel: Function }}
 */
export function use_voice_input({ bridge, on_text }) {
  const state = reactive({ status: "", levels: Array(LEVEL_BARS).fill(0), seconds: 0 });
  let session = null;

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
    recording.context.close();
  }

  async function begin() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("此浏览器不支持录音；本机网页请用 127.0.0.1 打开，线上网页须为 HTTPS");
    // Created inside the click so phones let it run.
    const context = new AudioContext();
    context.resume();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
    catch (error) { context.close(); throw new Error(error.name === "NotAllowedError" ? "没有麦克风权限，请在浏览器设置中允许本站使用麦克风" : `无法打开麦克风：${error.message}`); }
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(PROCESSOR_SIZE, 1, 1);
    const recording = { id: crypto.randomUUID(), context, stream, source, processor, rate: context.sampleRate, position: 0,
      pending: new Int16Array(PART_BYTES), pending_length: 0, index: 0, samples: 0, chain: Promise.resolve() };
    processor.onaudioprocess = (event) => capture(recording, event);
    source.connect(processor);
    processor.connect(context.destination);
    session = recording;
    Object.assign(state, { status: "recording", seconds: 0, levels: Array(LEVEL_BARS).fill(0) });
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
    if (state.status) return;
    try { await begin(); } catch (error) { bridge.notify("error", error.message); }
  }

  /** Discard a recording in progress without recognizing it. */
  function cancel() {
    if (session && state.status === "recording") release(session);
    session = null;
    state.status = "";
  }

  return { state, toggle, cancel };
}

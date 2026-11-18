/**
 * Shrink a video in the browser before it is uploaded (built to web/video-compress.js and imported only when a video is
 * attached). A phone's screen recording can run above 10 Mbit/s and the relay carries 1–3 Mbit/s, while a copy at
 * WeChat's size (1280 on the long side, about 1.2 Mbit/s) still shows on-screen text clearly enough to work from.
 * Anything it cannot do well it declines by returning null, and the page then sends the original.
 */
import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, ConversionCanceledError, Input, Mp4OutputFormat, Output, Quality, canEncodeVideo } from "mediabunny";

const LONG_SIDE = 1280;
const VIDEO_BITRATE = 1_200_000;
// Below this a screen recording's text is no longer readable, so a video too long to fit is refused instead.
const MIN_VIDEO_BITRATE = 350_000;
const FRAME_RATE = 30;
// A source within this factor of the target bitrate, at a size already within LONG_SIDE, is not worth re-encoding.
const ALREADY_SMALL_FACTOR = 1.3;
// The result is used only if it is at most this share of the original.
const WORTHWHILE_SHARE = 0.8;
// Encoders overshoot their target bitrate a little; this share of the size limit is what a long video is planned for.
const SIZE_MARGIN = 0.92;
const PACKET_SAMPLE = 200;
// With the page in view, an encoder silent this long has stalled (ms); the original is sent instead of waiting for ever.
const STALL_MS = 30000;
const STALL_CHECK_MS = 2000;

/** The nearest even number, at least 2: H.264 frames have even sides. */
const even = (value) => Math.max(2, Math.round(value / 2) * 2);

/**
 * Decide how to encode a video, or return null when it should stay as it is.
 *
 * @param {object} source Measured from the file: `width`, `height` (as displayed), `duration` (s), `size` (bytes),
 *   `audio_bitrate` and `packet_rate` (frames per second).
 * @param {number} max_bytes The largest file the site accepts.
 * @returns {{ width: number, height: number, bitrate: number, frame_rate?: number } | null}
 */
export function plan_compression({ width, height, duration, size, audio_bitrate, packet_rate }, max_bytes) {
  if (!(duration > 0) || !width || !height) return null;
  const long_side = Math.max(width, height);
  if (size <= max_bytes && long_side <= LONG_SIDE && size * 8 / duration <= VIDEO_BITRATE * ALREADY_SMALL_FACTOR) return null;
  const bitrate = Math.floor(Math.min(VIDEO_BITRATE, max_bytes * SIZE_MARGIN * 8 / duration - audio_bitrate));
  if (bitrate < MIN_VIDEO_BITRATE) return null;
  const scale = Math.min(1, LONG_SIDE / long_side);
  return { width: even(width * scale), height: even(height * scale), bitrate, ...(packet_rate > FRAME_RATE ? { frame_rate: FRAME_RATE } : {}) };
}

/** Measure the file and plan its encoding; null when it has no video this browser can decode and encode as planned. */
async function plan_for(input, file, max_bytes) {
  const video = await input.getPrimaryVideoTrack();
  if (!video || !(await video.canDecode())) return null;
  const audio = await input.getPrimaryAudioTrack();
  const plan = plan_compression({ width: video.displayWidth, height: video.displayHeight, duration: await input.computeDuration(), size: file.size,
    audio_bitrate: audio ? (await audio.computePacketStats(PACKET_SAMPLE)).averageBitrate : 0,
    packet_rate: (await video.computePacketStats(PACKET_SAMPLE)).averagePacketRate }, max_bytes);
  if (!plan) return null;
  return await canEncodeVideo("avc", { width: plan.width, height: plan.height, bitrate: plan.bitrate }) ? plan : null;
}

/** Run a conversion to its end; false when it was cancelled by `signal` or stalled. */
async function run_conversion(conversion, on_progress, signal) {
  let heard_at = performance.now();
  conversion.onProgress = (share) => { heard_at = performance.now(); on_progress?.(share); };
  const cancel = () => conversion.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  // A phone suspends a page it has put away; that time is not a stall.
  const watchdog = setInterval(() => {
    if (document.hidden) heard_at = performance.now();
    else if (performance.now() - heard_at > STALL_MS) cancel();
  }, STALL_CHECK_MS);
  try {
    await conversion.execute();
    return true;
  } catch (error) {
    if (error instanceof ConversionCanceledError) return false;
    throw error;
  } finally {
    clearInterval(watchdog);
    signal?.removeEventListener("abort", cancel);
  }
}

/**
 * Make a smaller MP4 copy of a video, keeping its sound.
 *
 * @param {File} file The original video.
 * @param {object} options
 * @param {number} options.max_bytes The largest file the site accepts.
 * @param {(share: number) => void} [options.on_progress] How far along it is, 0 to 1.
 * @param {AbortSignal} [options.signal] Cancels the work.
 * @returns {Promise<File | null>} The copy, or null when the original should be sent as it is.
 */
export async function compress_video(file, { max_bytes, on_progress, signal }) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const plan = await plan_for(input, file, max_bytes);
    if (!plan || signal?.aborted) return null;
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
    const conversion = await Conversion.init({ input, output, tracks: "primary", video: { width: plan.width, height: plan.height, fit: "contain", codec: "avc",
      quality: new Quality({ bitrate: plan.bitrate }), forceTranscode: true, ...(plan.frame_rate ? { frameRate: plan.frame_rate } : {}) } });
    // A track that cannot be carried over would be lost without a word (most often the sound): keep the original.
    if (!conversion.isValid || conversion.discardedTracks.length) return null;
    if (!await run_conversion(conversion, on_progress, signal)) return null;
    const size = target.buffer.byteLength;
    if (size > max_bytes || (file.size <= max_bytes && size > file.size * WORTHWHILE_SHARE)) return null;
    return new File([target.buffer], `${file.name.replace(/\.[^.]*$/, "")}.mp4`, { type: "video/mp4" });
  } finally {
    input.dispose();
  }
}

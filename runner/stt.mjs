/**
 * Voice input: the page records 16 kHz mono PCM and sends it in small parts (each fits one relayed request);
 * the last part assembles a WAV file and the voice-input service chosen in settings turns it into text: Volcengine's
 * flash recognizer, OpenAI's transcription, or the recognizer on this computer (`local_transcribe`). Keys stay local.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { read_saved_api_key } from './discussion_api.mjs';
import { TTS_BASE_URL, tts_settings } from './tts.mjs';
import { local_transcribe, STT_PROVIDERS } from './tts_providers.mjs';

const STT_ENDPOINT = `${TTS_BASE_URL}/api/v3/auc/bigmodel/recognize/flash`;
// The console's “录音文件识别2.0” grants this resource; it answers on the flash route (verified 2026-11-03). The 1.0
// flash resource `volc.bigasr.auc_turbo` is a separate product and is refused with 45000030 when only 2.0 is enabled.
const STT_RESOURCE_ID = 'volc.seedasr.auc';
const STT_DONE_CODE = '20000000';
const STT_SILENT_CODE = '20000003';
const STT_TIMEOUT_MS = 50_000;
const SAMPLE_RATE = 16000;
// OpenAI's transcription (2026-11-10 docs): gpt-transcribe is the recommended model; it and the others shut down on
// 2027-02-26. `languages` lists the languages the speech may be in; both forms of the array field were accepted.
const OPENAI_MODEL = 'gpt-transcribe';
const OPENAI_LANGUAGES = ['zh', 'en'];
// About 5 minutes of 16-bit mono audio at 16 kHz.
export const STT_MAX_BYTES = 10 * 1024 * 1024;
const PART_MAX_BYTES = 256 * 1024;
const STALE_MS = 60 * 60 * 1000;
const STATUS_MESSAGES = {
  45000001: '请求参数有误',
  45000002: '没有录到声音',
  45000030: '火山引擎未授权该识别服务：请在控制台开通「录音文件识别2.0」',
  45000151: '音频格式不受支持',
  55000031: '火山引擎语音识别繁忙，请稍后再试',
};

/** Prefix raw 16-bit mono PCM with a WAV header. */
export function pcm_to_wav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Drop recordings abandoned mid-way (closed page, lost connection). */
function clean_stale(directory) {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    try { if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true }); } catch { /* Gone already. */ }
  }
}

/** Send a finished recording to the recognizer and return its text. */
async function recognize(key, wav, request) {
  let response;
  try {
    response = await request(STT_ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(STT_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': key, 'X-Api-Resource-Id': STT_RESOURCE_ID,
        'X-Api-Request-Id': randomUUID(), 'X-Api-Sequence': '-1' },
      body: JSON.stringify({ user: { uid: 'codiscuss' }, audio: { data: wav.toString('base64') }, request: { model_name: 'bigmodel', enable_punc: true, enable_itn: true } }) });
  } catch { throw new Error('语音识别请求超时或连接失败，请检查网络后重试'); }
  const code = response.headers.get('X-Api-Status-Code');
  if ((response.status === 401 || response.status === 403) && !STATUS_MESSAGES[code]) throw new Error('火山引擎拒绝了请求：API Key 无效或未开通录音文件识别 2.0');
  if (code === STT_SILENT_CODE) return '';
  if (code !== STT_DONE_CODE) {
    const message = STATUS_MESSAGES[code] || response.headers.get('X-Api-Message') || `HTTP ${response.status}`;
    throw new Error(`语音识别失败（${code || response.status}）：${message}`);
  }
  const data = await response.json();
  return String(data?.result?.text || '').trim();
}

/** Send a finished recording to OpenAI's transcription and return its text. */
async function openai_transcribe(base_url, key, wav, request) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', OPENAI_MODEL);
  for (const language of OPENAI_LANGUAGES) form.append('languages[]', language);
  let response;
  try {
    response = await request(`${base_url}/audio/transcriptions`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(STT_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${key}` }, body: form });
  } catch { throw new Error('语音识别请求超时或连接失败：请检查这台电脑能否访问 api.openai.com 后重试'); }
  if (!response.ok) {
    const reason = await response.json().then(body => body?.error?.message || '', () => '');
    if (response.status === 401) throw new Error('OpenAI 拒绝了 API Key：请在设置的“语音”中更换');
    throw new Error(`语音识别失败：OpenAI 返回 HTTP ${response.status}${reason ? `：${reason}` : ''}`);
  }
  return String((await response.json())?.text || '').trim();
}

/**
 * Store one part of a recording; the final part recognizes the whole recording and returns its text.
 * @param {string} home Local service directory.
 * @param {{ upload_id: string, index: number, data: string, final?: boolean }} input Base64 PCM part in order.
 * @param {Function} [request] `fetch`, replaceable in tests.
 * @param {Function} [start] Starts the local recognizer, replaceable in tests.
 * @returns {Promise<{ received: number } | { text: string }>}
 */
export async function stt_part(home, input, request = fetch, start = undefined) {
  const { upload_id, index, data, final } = input || {};
  if (!/^[a-f0-9-]{36}$/i.test(upload_id || '') || !Number.isInteger(index) || index < 0 || typeof data !== 'string') throw new Error('录音片段无效');
  const settings = tts_settings(home);
  const service = STT_PROVIDERS.find(item => item.id === settings.stt_provider);
  if (!settings.stt_key_ref) throw new Error(service.local ? '本机语音识别尚未安装：请让本机 AI 按 local-stt-setup 技能安装'
    : `语音输入使用${service.label}：请在设置的“语音”中填写${service.label} API Key`);
  const part = Buffer.from(data, 'base64');
  if (part.length > PART_MAX_BYTES || part.length % 2) throw new Error('录音片段无效');
  const root = join(home, 'stt');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  clean_stale(root);
  const directory = join(root, upload_id.toLowerCase());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, `${index}.pcm`), part, { mode: 0o600 });
  if (!final) return { received: index };
  try {
    const parts = [];
    for (let position = 0; position <= index; position += 1) {
      const path = join(directory, `${position}.pcm`);
      if (!existsSync(path)) throw new Error('录音片段缺失，请重新录制');
      parts.push(readFileSync(path));
    }
    const pcm = Buffer.concat(parts);
    if (pcm.length > STT_MAX_BYTES) throw new Error('录音超过 5 分钟，请分段录制');
    if (!pcm.length) return { text: '' };
    const key = read_saved_api_key(home, service.key_base_url, settings.stt_key_ref);
    if (service.local) return { text: await local_transcribe({ home, key, wav: pcm_to_wav(pcm) }, { request, ...(start ? { start } : {}) }) };
    if (service.id === 'openai') return { text: await openai_transcribe(service.key_base_url, key, pcm_to_wav(pcm), request) };
    return { text: await recognize(key, pcm_to_wav(pcm), request) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Read-aloud: synthesize short text with Volcengine Doubao TTS 2.0; the key stays in the local private store. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { read_saved_api_key } from './discussion_api.mjs';
import { atomic_json } from './files.mjs';

export const TTS_BASE_URL = 'https://openspeech.bytedance.com';
const TTS_ENDPOINT = `${TTS_BASE_URL}/api/v3/tts/unidirectional`;
const TTS_RESOURCE_ID = 'seed-tts-2.0';
const TTS_DONE_CODE = 20000000;
const TTS_TIMEOUT_MS = 45_000;
// The page sends one sentence at a time; this bounds a single relayed answer well under the relay frame size.
export const TTS_MAX_TEXT = 300;
const MAX_CONTEXT = 200;
const SETTINGS_FILE = 'tts-settings.json';
export const TTS_DEFAULTS = { speaker: 'zh_female_vv_uranus_bigtts', speech_rate: 0, context: '' };
// Voices a user can pick without looking up IDs; any other 2.0 voice ID enabled in the console may be typed.
export const TTS_VOICES = [{ id: 'zh_female_vv_uranus_bigtts', label: 'Vivi（通用女声）' }];
const STATUS_MESSAGES = {
  40402003: '文本超出单次合成长度上限',
  45000000: '音色不可用：请确认已在火山引擎控制台开通该豆包语音合成 2.0 音色，并核对音色 ID',
  55000000: '火山引擎语音服务暂时出错，请稍后再试',
};

/** Read the saved read-aloud settings; only the key reference is kept, never the key. */
export function tts_settings(home) {
  const path = join(home, SETTINGS_FILE);
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return { ...TTS_DEFAULTS, ...saved, voices: TTS_VOICES, key_base_url: TTS_BASE_URL };
}

/** Validate and save the read-aloud settings the page edits. */
export function save_tts_settings(home, input) {
  const speaker = String(input.speaker ?? TTS_DEFAULTS.speaker).trim();
  if (!/^[\w.-]{1,128}$/.test(speaker)) throw new Error('请填写有效的音色 ID');
  const speech_rate = Number(input.speech_rate ?? 0);
  if (!Number.isInteger(speech_rate) || speech_rate < -50 || speech_rate > 100) throw new Error('语速须为 -50 到 100 的整数');
  const context = String(input.context ?? '').trim();
  if (context.length > MAX_CONTEXT) throw new Error(`语气提示不超过 ${MAX_CONTEXT} 字`);
  const api_key_ref = input.api_key_ref || undefined;
  if (api_key_ref && !/^[a-f0-9-]{36}$/i.test(api_key_ref)) throw new Error('API Key 引用无效，请重新填写');
  const settings = { speaker, speech_rate, context, ...(api_key_ref ? { api_key_ref } : {}) };
  mkdirSync(home, { recursive: true, mode: 0o700 });
  atomic_json(join(home, SETTINGS_FILE), settings);
  return tts_settings(home);
}

/** Split a chunked answer made of concatenated JSON objects, newline-separated or not. */
export function split_json_objects(text) {
  const objects = [];
  let depth = 0, start = -1, in_string = false, escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (in_string) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') in_string = false;
    } else if (character === '"') in_string = true;
    else if (character === '{') { if (depth++ === 0) start = index; }
    else if (character === '}' && depth > 0 && --depth === 0) objects.push(JSON.parse(text.slice(start, index + 1)));
  }
  return objects;
}

/** Turn one service code into a message that says what to fix. */
function tts_error(code, message) {
  return new Error(`语音合成失败（${code}）：${STATUS_MESSAGES[code] || message || '请核对 API Key 与音色'}`);
}

/** Synthesize one piece of text and return it as base64 MP3. */
export async function tts_speak(home, input, request = fetch) {
  const text = typeof input?.text === 'string' ? input.text.trim() : '';
  if (!text) throw new Error('朗读文本为空');
  if (text.length > TTS_MAX_TEXT) throw new Error(`单次朗读不超过 ${TTS_MAX_TEXT} 字`);
  const settings = tts_settings(home);
  if (!settings.api_key_ref) throw new Error('尚未配置朗读：请在设置的“朗读”中填写火山引擎 API Key');
  const key = read_saved_api_key(home, TTS_BASE_URL, settings.api_key_ref);
  const additions = settings.context ? { context_texts: [settings.context] } : null;
  const body = { user: { uid: 'codiscuss' }, req_params: { text, speaker: settings.speaker,
    audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: settings.speech_rate },
    ...(additions ? { additions: JSON.stringify(additions) } : {}) } };
  let response;
  try {
    response = await request(TTS_ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': key, 'X-Api-Resource-Id': TTS_RESOURCE_ID, 'X-Api-Request-Id': randomUUID() },
      body: JSON.stringify(body) });
  } catch { throw new Error('语音合成请求超时或连接失败，请检查网络后重试'); }
  if (response.status === 401 || response.status === 403) throw new Error('火山引擎拒绝了请求：API Key 无效或未开通豆包语音合成 2.0');
  const objects = split_json_objects(await response.text());
  const chunks = [];
  for (const item of objects) {
    if (item.code === TTS_DONE_CODE) return { audio: Buffer.concat(chunks).toString('base64'), format: 'mp3' };
    if (item.code !== 0) throw tts_error(item.code, item.message);
    if (item.data) chunks.push(Buffer.from(item.data, 'base64'));
  }
  if (!response.ok) throw new Error(`语音合成失败：火山引擎返回 HTTP ${response.status}`);
  throw new Error('语音合成未完成：火山引擎没有返回结束标记');
}

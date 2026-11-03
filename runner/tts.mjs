/** Read-aloud: synthesize short text with Volcengine Doubao TTS 2.0; the key stays in the local private store. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { read_saved_api_key } from './discussion_api.mjs';
import { atomic_json } from './files.mjs';

export const TTS_BASE_URL = 'https://openspeech.bytedance.com';
const TTS_ENDPOINT = `${TTS_BASE_URL}/api/v3/tts/unidirectional`;
const TTS_RESOURCE_ID = 'seed-tts-2.0';
const TTS_DONE_CODE = 20000000;
const TTS_TIMEOUT_MS = 45_000;
// The page sends a paragraph of up to 200 characters; at about 8 KB of MP3 per second this keeps one relayed answer under 1 MiB.
export const TTS_MAX_TEXT = 300;
const MAX_CONTEXT = 200;
const SETTINGS_FILE = 'tts-settings.json';
const SPEAKER_PATTERN = /^[\w.-]{1,128}$/;
// Trailing silence the page may ask for at a paragraph or message end; it is part of the audio, so it also plays in the background.
const MAX_SILENCE_MS = 3000;
// Synthesized paragraphs are kept on this computer, so hearing the same text again is instant and not billed again.
const CACHE_DIR = 'tts-cache';
const CACHE_LIMIT = 400;
const CACHE_PRUNE = 100;
const MAX_MEMBER_VOICES = 50;
// A default tone instruction (context_texts) so reading sounds told rather than recited; users may change or clear it.
export const TTS_DEFAULT_CONTEXT = '请用自然放松的语气朗读，像给朋友讲故事一样，有轻重缓急，句子之间自然停顿。';
export const TTS_DEFAULTS = { speaker: 'zh_female_vv_uranus_bigtts', speech_rate: 0, context: TTS_DEFAULT_CONTEXT };
// Voices a user can pick without looking up IDs; any other 2.0 voice ID enabled in the console may be typed.
export const TTS_VOICES = [
  { id: 'zh_female_vv_uranus_bigtts', label: 'Vivi · 通用女声' },
  { id: 'zh_female_xiaohe_uranus_bigtts', label: '小何 · 通用女声' },
  { id: 'zh_male_m191_uranus_bigtts', label: '云舟 · 通用男声' },
  { id: 'zh_male_taocheng_uranus_bigtts', label: '小天 · 通用男声' },
  { id: 'zh_male_liufei_uranus_bigtts', label: '刘飞 · 通用男声' },
  { id: 'zh_female_sophie_uranus_bigtts', label: '魅力苏菲 · 女声' },
  { id: 'zh_female_qingxinnvsheng_uranus_bigtts', label: '清新女声' },
  { id: 'zh_female_cancan_uranus_bigtts', label: '知性灿灿 · 女声' },
  { id: 'zh_female_zhixingnv_uranus_bigtts', label: '知性女声' },
  { id: 'zh_female_wenroushunv_uranus_bigtts', label: '温柔淑女 · 女声' },
  { id: 'zh_female_linjianvhai_uranus_bigtts', label: '邻家女孩' },
  { id: 'zh_female_shuangkuaisisi_uranus_bigtts', label: '爽快思思 · 女声' },
  { id: 'zh_female_gaolengyujie_uranus_bigtts', label: '高冷御姐 · 女声' },
  { id: 'zh_female_xiaoxue_uranus_bigtts', label: '儿童绘本 · 女声' },
  { id: 'zh_male_ruyaqingnian_uranus_bigtts', label: '儒雅青年 · 男声' },
  { id: 'zh_male_yangguangqingnian_uranus_bigtts', label: '阳光青年 · 男声' },
  { id: 'zh_male_yuanboxiaoshu_uranus_bigtts', label: '渊博小叔 · 男声' },
  { id: 'zh_male_cixingjieshuonan_uranus_bigtts', label: '磁性解说 · 男声' },
  { id: 'zh_male_shenyeboke_uranus_bigtts', label: '深夜播客 · 男声' },
  { id: 'zh_male_xuanyijieshuo_uranus_bigtts', label: '悬疑解说 · 男声' },
  { id: 'zh_male_baqiqingshu_uranus_bigtts', label: '霸气青叔 · 有声书男声' },
  { id: 'zh_male_yizhipiannan_uranus_bigtts', label: '译制片男声' },
  { id: 'zh_male_jieshuoxiaoming_uranus_bigtts', label: '解说小明 · 男声' },
  { id: 'zh_male_wennuanahu_uranus_bigtts', label: '温暖阿虎 · 男声' },
];
const STATUS_MESSAGES = {
  40402003: '文本超出单次合成长度上限',
  45000000: '音色不可用：请确认已在火山引擎控制台开通该豆包语音合成 2.0 音色，并核对音色 ID',
  55000000: '火山引擎语音服务暂时出错，请稍后再试',
};

/** Read the saved read-aloud settings; only the key reference is kept, never the key. */
export function tts_settings(home) {
  const path = join(home, SETTINGS_FILE);
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return { ...TTS_DEFAULTS, member_voices: {}, ...saved, voices: TTS_VOICES, key_base_url: TTS_BASE_URL };
}

/** Validate and save the read-aloud settings the page edits. */
export function save_tts_settings(home, input) {
  const speaker = String(input.speaker ?? TTS_DEFAULTS.speaker).trim();
  if (!SPEAKER_PATTERN.test(speaker)) throw new Error('请填写有效的音色 ID');
  const speech_rate = Number(input.speech_rate ?? 0);
  if (!Number.isInteger(speech_rate) || speech_rate < -50 || speech_rate > 100) throw new Error('语速须为 -50 到 100 的整数');
  const context = String(input.context ?? '').trim();
  if (context.length > MAX_CONTEXT) throw new Error(`语气提示不超过 ${MAX_CONTEXT} 字`);
  const api_key_ref = input.api_key_ref || undefined;
  if (api_key_ref && !/^[a-f0-9-]{36}$/i.test(api_key_ref)) throw new Error('API Key 引用无效，请重新填写');
  // Voices chosen per AI platform; members of other platforms, the user and program messages use the default voice.
  const member_voices = {};
  for (const [name, voice] of Object.entries(input.member_voices || {}).slice(0, MAX_MEMBER_VOICES)) {
    if (!voice) continue;
    if (String(name).length > 40 || !SPEAKER_PATTERN.test(voice)) throw new Error('成员音色无效，请重新选择');
    member_voices[name] = voice;
  }
  const settings = { speaker, speech_rate, context, member_voices, ...(api_key_ref ? { api_key_ref } : {}) };
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

/** Flatten the per-word timings the service returns with subtitles, as { w: word, t: start in ms }. */
function word_marks(objects) {
  return objects.flatMap(item => item.sentence?.words || []).map(word => ({ w: String(word.word || ''), t: Math.round(Number(word.startTime || 0) * 1000) }));
}

/** Read a cached synthesis, refreshing its time so the most recently heard stay; null when absent or unreadable. */
function cache_read(path) {
  try { const value = JSON.parse(readFileSync(path, 'utf8')); atomic_json(path, value); return value; } catch { return null; }
}

/** Keep the cache bounded: past the limit, drop the least recently heard entries. */
function cache_write(directory, path, value) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomic_json(path, value);
  const names = readdirSync(directory).filter(name => name.endsWith('.json'));
  if (names.length <= CACHE_LIMIT) return;
  const aged = names.map(name => ({ name, time: statSync(join(directory, name)).mtimeMs })).sort((a, b) => a.time - b.time);
  for (const { name } of aged.slice(0, CACHE_PRUNE)) rmSync(join(directory, name), { force: true });
}

/**
 * Synthesize one paragraph and return it as base64 MP3 with word timings for highlighting.
 * `speaker` may name another voice for this paragraph (a member's own voice); `silence_ms` appends trailing silence.
 * Requests of one reading pass share `section_id`, so the service keeps the earlier paragraphs as context.
 */
export async function tts_speak(home, input, request = fetch) {
  const text = typeof input?.text === 'string' ? input.text.trim() : '';
  if (!text) throw new Error('朗读文本为空');
  if (text.length > TTS_MAX_TEXT) throw new Error(`单次朗读不超过 ${TTS_MAX_TEXT} 字`);
  const settings = tts_settings(home);
  if (!settings.api_key_ref) throw new Error('尚未配置语音：请在设置的“语音”中填写火山引擎 API Key');
  const speaker = SPEAKER_PATTERN.test(input.speaker || '') ? input.speaker : settings.speaker;
  const silence = Math.max(0, Math.min(MAX_SILENCE_MS, Math.round(Number(input.silence_ms) || 0)));
  const directory = join(home, CACHE_DIR);
  const cache_path = join(directory, `${createHash('sha256').update(JSON.stringify([text, speaker, settings.speech_rate, settings.context, silence])).digest('hex')}.json`);
  const cached = existsSync(cache_path) && cache_read(cache_path);
  if (cached?.audio) return { ...cached, cached: true };
  const key = read_saved_api_key(home, TTS_BASE_URL, settings.api_key_ref);
  const section_id = /^[a-f0-9-]{36}$/i.test(input.section_id || '') ? input.section_id : undefined;
  const additions = { ...(settings.context ? { context_texts: [settings.context] } : {}), ...(section_id ? { section_id } : {}),
    ...(silence ? { silence_duration: silence } : {}) };
  const body = { user: { uid: 'codiscuss' }, req_params: { text, speaker,
    audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: settings.speech_rate, enable_subtitle: true },
    ...(Object.keys(additions).length ? { additions: JSON.stringify(additions) } : {}) } };
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
    if (item.code === TTS_DONE_CODE) {
      const result = { audio: Buffer.concat(chunks).toString('base64'), format: 'mp3', marks: word_marks(objects) };
      cache_write(directory, cache_path, result);
      return result;
    }
    if (item.code !== 0) throw tts_error(item.code, item.message);
    if (item.data) chunks.push(Buffer.from(item.data, 'base64'));
  }
  if (!response.ok) throw new Error(`语音合成失败：火山引擎返回 HTTP ${response.status}`);
  throw new Error('语音合成未完成：火山引擎没有返回结束标记');
}

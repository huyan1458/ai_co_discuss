/**
 * Read-aloud: synthesize short text with the speech service chosen in settings (Volcengine, Aliyun, Azure or the local service); keys stay
 * in the local private store. Each service keeps its own key and voices, so switching back finds them as they were.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { read_saved_api_key, saved_api_keys } from './discussion_api.mjs';
import { atomic_json } from './files.mjs';
import { provider_release, provider_speak, STT_PROVIDERS, TTS_PROVIDERS } from './tts_providers.mjs';

// Volcengine's key root; its key also serves voice input.
export const TTS_BASE_URL = 'https://openspeech.bytedance.com';
// The page sends a paragraph of up to 200 characters; at about 8 KB of MP3 per second this keeps one relayed answer under 1 MiB.
export const TTS_MAX_TEXT = 300;
const MAX_CONTEXT = 200;
const SETTINGS_FILE = 'tts-settings.json';
const SPEAKER_PATTERN = /^[\w.:-]{1,128}$/;
const REGION_PATTERN = /^[a-z0-9]{2,32}$/;
const KEY_REF_PATTERN = /^[a-f0-9-]{36}$/i;
// Trailing silence the page may ask for at a paragraph or message end; it is part of the audio, so it also plays in the background.
const MAX_SILENCE_MS = 3000;
// Synthesized paragraphs are kept on this computer, so hearing the same text again is instant and not billed again.
const CACHE_DIR = 'tts-cache';
// The cache is bounded by total size; past it, the least recently heard entries go until it is back under the target.
const CACHE_LIMIT_BYTES = 50 * 1024 * 1024;
const CACHE_KEEP_BYTES = 40 * 1024 * 1024;
const MAX_MEMBER_VOICES = 50;
// A paragraph asked for again while its synthesis is still running (another device, a quick restart) waits for that call.
const in_flight = new Map();
const PROVIDER_IDS = TTS_PROVIDERS.map(provider => provider.id);
const provider_of = (id) => TTS_PROVIDERS.find(provider => provider.id === id);
const STT_IDS = STT_PROVIDERS.map(provider => provider.id);

/** The latest key saved for a service's root, or else for its former root (the local services' fixed ports before 2026-11-11). */
const latest_key_ref = (keys, service) => keys[service.key_base_url] || keys[service.legacy_key_base_url] || '';

/**
 * Read a service's saved key by reference; a local service's token saved for its former root is still accepted.
 * @param {string} home The service home.
 * @param {{ key_base_url: string, legacy_key_base_url?: string }} service One of TTS_PROVIDERS or STT_PROVIDERS.
 * @param {string} api_key_ref The key reference.
 * @returns {string} The key.
 */
export function read_service_key(home, service, api_key_ref) {
  try { return read_saved_api_key(home, service.key_base_url, api_key_ref); }
  catch (error) {
    if (!service.legacy_key_base_url) throw error;
    return read_saved_api_key(home, service.legacy_key_base_url, api_key_ref);
  }
}

/** One service's saved part with its defaults: key reference, voices, tone (services that take one) and (Azure) region. */
function provider_settings(provider, saved = {}) {
  return { api_key_ref: '', speaker: provider.default_speaker, member_voices: {}, file_voice: '', ...(provider.context ? { context: provider.default_context } : {}),
    ...(provider.region ? { region: '' } : {}), ...saved };
}

/**
 * Read the saved read-aloud settings; only key references are kept, never keys. Settings saved before services could be
 * chosen held Volcengine's key and voices at the top level and are read as Volcengine's; so is a tone saved at the top
 * level before each service kept its own.
 * The chosen service's key reference and voices are also given at the top level for readers that only play.
 * The local service's token is saved by the setup skill, so without a reference it uses the latest saved for its address;
 * so does OpenAI, whose key is usually saved already for model API members.
 * Voice input chooses its own service (`stt_provider`); `stt_key_ref` is the key reference of the one chosen, empty
 * until it is set up: a cloud service's key from its reading part of the same id, the local service's token as its skill saved it.
 */
export function tts_settings(home) {
  const path = join(home, SETTINGS_FILE);
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const stored = saved.providers || { volcengine: { api_key_ref: saved.api_key_ref, speaker: saved.speaker, member_voices: saved.member_voices,
    file_voice: saved.file_voice } };
  if (saved.context !== undefined && stored.volcengine?.context === undefined) stored.volcengine = { ...stored.volcengine, context: saved.context };
  const keys = saved_api_keys(home);
  const providers = Object.fromEntries(TTS_PROVIDERS.map(provider => {
    const own = provider_settings(provider, Object.fromEntries(Object.entries(stored[provider.id] || {}).filter(([, value]) => value !== undefined)));
    return [provider.id, (provider.local || provider.shared_key) && !own.api_key_ref ? { ...own, api_key_ref: latest_key_ref(keys, provider) } : own];
  }));
  // Never chosen: the service on this computer once installed (it needs no key), unless an older file holds a Volcengine key.
  const provider = PROVIDER_IDS.includes(saved.provider) ? saved.provider
    : providers.local.api_key_ref && !stored.volcengine?.api_key_ref ? 'local' : 'volcengine';
  const active = providers[provider];
  const ready = Boolean(active.api_key_ref && (!provider_of(provider).region || active.region));
  const local_stt = STT_PROVIDERS.find(item => item.local);
  const stt_provider = STT_IDS.includes(saved.stt_provider) ? saved.stt_provider : latest_key_ref(keys, local_stt) ? local_stt.id : 'volcengine';
  const stt = STT_PROVIDERS.find(item => item.id === stt_provider);
  return { provider, speech_rate: saved.speech_rate ?? 0, providers, catalog: TTS_PROVIDERS,
    api_key_ref: ready ? active.api_key_ref : '', speaker: active.speaker, member_voices: active.member_voices, file_voice: active.file_voice,
    stt_provider, stt_catalog: STT_PROVIDERS, stt_key_ref: stt.local ? latest_key_ref(keys, stt) : providers[stt.id]?.api_key_ref || '' };
}

/** Validate one service's part as the page sent it. */
function check_provider(provider, input = {}) {
  const speaker = String(input.speaker || provider.default_speaker).trim();
  if (!SPEAKER_PATTERN.test(speaker)) throw new Error('请填写有效的音色 ID');
  const api_key_ref = input.api_key_ref || '';
  if (api_key_ref && !KEY_REF_PATTERN.test(api_key_ref)) throw new Error('API Key 引用无效，请重新填写');
  // Voices chosen per AI platform; members of other platforms, the user and program messages use the default voice.
  const member_voices = {};
  for (const [name, voice] of Object.entries(input.member_voices || {}).slice(0, MAX_MEMBER_VOICES)) {
    if (!voice) continue;
    if (String(name).length > 40 || !SPEAKER_PATTERN.test(voice)) throw new Error('成员音色无效，请重新选择');
    member_voices[name] = voice;
  }
  // The voice for reading project files; empty uses the default voice.
  const file_voice = String(input.file_voice ?? '').trim();
  if (file_voice && !SPEAKER_PATTERN.test(file_voice)) throw new Error('文件音色无效，请重新选择');
  const region = String(input.region ?? '').trim().toLowerCase();
  if (region && !REGION_PATTERN.test(region)) throw new Error('Azure 区域应为如 eastasia 的小写英文与数字');
  const context = String(input.context ?? provider.default_context ?? '').trim();
  if (context.length > MAX_CONTEXT) throw new Error(`语气提示不超过 ${MAX_CONTEXT} 字`);
  return { api_key_ref, speaker, member_voices, file_voice, ...(provider.context ? { context } : {}), ...(provider.region ? { region } : {}) };
}

/**
 * Validate and save the speech settings the page edits: the reading service, each service's part (its tone among them), rate, and
 * the voice-input service. A service is saved only once the user picks one; until then neither is sent and the default
 * follows what is installed, so editing a voice or the rate before installing the local service does not pin the cloud one.
 */
export function save_tts_settings(home, input) {
  const current = tts_settings(home);
  const path = join(home, SETTINGS_FILE);
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const provider = input.provider ?? saved.provider;
  if (provider !== undefined && !PROVIDER_IDS.includes(provider)) throw new Error('请选择语音服务');
  const speech_rate = Number(input.speech_rate ?? 0);
  if (!Number.isInteger(speech_rate) || speech_rate < -50 || speech_rate > 100) throw new Error('语速须为 -50 到 100 的整数');
  const stt_provider = input.stt_provider ?? saved.stt_provider;
  if (stt_provider !== undefined && !STT_IDS.includes(stt_provider)) throw new Error('请选择语音输入服务');
  const providers = Object.fromEntries(TTS_PROVIDERS.map(item => [item.id, check_provider(item, input.providers?.[item.id] || current.providers[item.id])]));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  atomic_json(join(home, SETTINGS_FILE), { provider, speech_rate, providers, stt_provider });
  return tts_settings(home);
}

/** The user stopped reading: the chosen service frees what it holds on this computer (the local model's memory). */
export function tts_release(home) {
  provider_release(tts_settings(home).provider, home);
  return { released: true };
}

/** Read a cached synthesis, refreshing its time so the most recently heard stay; null when absent or unreadable. */
function cache_read(path) {
  try { const value = JSON.parse(readFileSync(path, 'utf8')); atomic_json(path, value); return value; } catch { return null; }
}

/** Keep the cache bounded: past the limit, drop the least recently heard entries. */
function cache_write(directory, path, value) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomic_json(path, value);
  const entries = readdirSync(directory).filter(name => name.endsWith('.json')).map(name => {
    const { size, mtimeMs } = statSync(join(directory, name));
    return { name, size, mtimeMs };
  });
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= CACHE_LIMIT_BYTES) return;
  for (const entry of entries.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= CACHE_KEEP_BYTES) break;
    rmSync(join(directory, entry.name), { force: true });
    total -= entry.size;
  }
}

/**
 * Synthesize one paragraph with the chosen service and return it as base64 MP3 with word timings for highlighting.
 * `speaker` may name another voice for this paragraph (a member's own voice); `silence_ms` appends trailing silence.
 * Requests of one reading pass share `section_id`, so Volcengine keeps the earlier paragraphs as context.
 * @param {{ request?: Function, open?: Function }} [transport] `fetch` and WebSocket factory, replaceable in tests.
 */
export async function tts_speak(home, input, transport) {
  const text = typeof input?.text === 'string' ? input.text.trim() : '';
  if (!text) throw new Error('朗读文本为空');
  if (text.length > TTS_MAX_TEXT) throw new Error(`单次朗读不超过 ${TTS_MAX_TEXT} 字`);
  const settings = tts_settings(home);
  const provider = provider_of(settings.provider);
  const own = settings.providers[provider.id];
  if (!own.api_key_ref) throw new Error(provider.local ? '本机语音尚未安装：请让本机 AI 按 local-tts-setup 技能安装'
    : `尚未配置语音：请在设置的“语音”中填写${provider.label} API Key`);
  const speaker = SPEAKER_PATTERN.test(input.speaker || '') ? input.speaker : own.speaker;
  const silence = Math.max(0, Math.min(MAX_SILENCE_MS, Math.round(Number(input.silence_ms) || 0)));
  const context = provider.context ? own.context : '';
  const directory = join(home, CACHE_DIR);
  // Local audio cached before 2026-11-10 has its index at the end, which iPhone Safari cannot play; a new key leaves it unused.
  const cache_path = join(directory, `${createHash('sha256').update(JSON.stringify([text, speaker, settings.speech_rate, context, silence,
    ...(provider.id === 'volcengine' ? [] : [provider.local ? 'local-faststart' : provider.id])])).digest('hex')}.json`);
  const cached = existsSync(cache_path) && cache_read(cache_path);
  if (cached?.audio) return { ...cached, cached: true };
  if (!in_flight.has(cache_path)) {
    const key = read_service_key(home, provider, own.api_key_ref);
    const section_id = KEY_REF_PATTERN.test(input.section_id || '') ? input.section_id : undefined;
    in_flight.set(cache_path, provider_speak(provider.id, { key, text, speaker, rate: settings.speech_rate, context, silence, section_id, region: own.region, home }, transport)
      .then((result) => { cache_write(directory, cache_path, result); return result; })
      .finally(() => in_flight.delete(cache_path)));
  }
  return in_flight.get(cache_path);
}

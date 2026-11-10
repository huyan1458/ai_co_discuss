/**
 * Read-aloud providers: what each speech service offers (voices, key root, console) and how one paragraph is
 * synthesized there. Every provider answers the same shape, `{ audio: base64 MP3, format: "mp3", marks: [{ w, t }] }`;
 * `marks` holds per-character start times in ms when the service gives them, otherwise it is empty and the page spreads
 * the highlight by length. The local service answers AAC in MP4 (`format: "m4a"`) instead, as its bundled converter
 * cannot write MP3, and OpenAI answers ADTS AAC (`format: "aac"`), its MP3 being too large for the relay.
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const TTS_TIMEOUT_MS = 45_000;
const VOLC_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const VOLC_RESOURCE_ID = 'seed-tts-2.0';
const VOLC_DONE_CODE = 20000000;
const VOLC_MESSAGES = {
  40402003: '文本超出单次合成长度上限',
  45000000: '音色不可用：请确认已在火山引擎控制台开通该豆包语音合成 2.0 音色，并核对音色 ID',
  55000000: '火山引擎语音服务暂时出错，请稍后再试',
};
const ALIYUN_SOCKET = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const ALIYUN_MODEL = 'cosyvoice-v3-flash';
// Its default answered 160 kbps (measured 2026-11-04); 64 kbps (8 KB/s, as Volcengine) keeps a 300-character answer under the 1 MiB relay limit.
const ALIYUN_BIT_RATE = 64;
// Aliyun and Azure answer 24 kHz mono MP3, so trailing silence is appended as silent frames of that format.
const SAMPLE_RATE = 24000;
// One silent MPEG-2 Layer III frame (24 kHz, 32 kbps, mono): a header and zeroed side info, 576 samples = 24 ms.
const SILENT_FRAME = Buffer.concat([Buffer.from([0xff, 0xf3, 0x44, 0xc0]), Buffer.alloc(92)]);
const SILENT_FRAME_MS = 24;
const AZURE_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
// OpenAI's Speech API (2026-11-10 docs): gpt-4o-mini-tts takes a tone instruction and a speed of 0.25–4; the docs say all
// its speech models shut down on 2027-01-06, the successor being a Realtime model that /v1/audio/speech does not serve.
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_MODEL = 'gpt-4o-mini-tts';
// Its MP3 is 128 kbps (measured 2026-11-10: 211 characters gave 890 KB, over the relay's 1 MiB frame once in base64);
// its AAC, ADTS at 24 kHz mono, gave 465 KB for the same text.
const OPENAI_FORMAT = 'aac';
// One silent AAC-LC frame (24 kHz, mono): an ADTS header for an 11-byte frame and a raw block holding one channel
// element with no spectral data, then the end element; 1024 samples, about 42.7 ms.
const SILENT_AAC_FRAME = Buffer.from([0xff, 0xf1, 0x58, 0x40, 0x01, 0x7f, 0xfc, 0x00, 0x00, 0x00, 0x07]);
const SILENT_AAC_FRAME_MS = 1024 / 24;
// Local speech: yovoice serving Qwen3-TTS CustomVoice on this computer, installed by the local-tts-setup skill into
// `<service home>/yovoice` (CLI in `cli/`, engine and model in `data/`). Like voice input's local service, the runner
// starts it through a supervisor (`local_speech_service.mjs`) and renews its lease on every request; a minute without
// one, or the user stopping reading, stops it, so the model does not hold graphics memory between uses, even when the
// runner has crashed.
const LOCAL_HOST = '127.0.0.1:18765';
const LOCAL_URL = `http://${LOCAL_HOST}`;
const LOCAL_MODEL = 'qwen3-tts-customvoice-q8';
const LOCAL_DIR = 'yovoice';
const LOCAL_START_MS = 30_000;
const LOCAL_POLL_MS = 500;
const LOCAL_CONVERT_MS = 30_000;
// 64 kbps AAC (8 KB/s, as the MP3 services) keeps a 300-character answer under the 1 MiB relay limit.
const LOCAL_BIT_RATE = '64k';
const LOCAL_EXE = process.platform === 'win32' ? '.exe' : '';
const run_file = promisify(execFile);
const LOCAL_SUPERVISOR = fileURLToPath(new URL('./local_speech_service.mjs', import.meta.url));
// Voice input on this computer: CrispASR serving Qwen3-ASR 0.6B, installed by the local-stt-setup skill into
// `<service home>/crispasr` (program in `cli/`, model in `models/`), started, renewed and stopped like the read-aloud
// service. Measured 2026-11-10 (RTX 5060, cuda13): about 35× realtime once loaded, a 5-minute recording in 8.5 s.
const LOCAL_STT_HOST = '127.0.0.1';
const LOCAL_STT_PORT = '18766';
const LOCAL_STT_URL = `http://${LOCAL_STT_HOST}:${LOCAL_STT_PORT}`;
const LOCAL_STT_DIR = 'crispasr';
const LOCAL_STT_MODEL = 'qwen3-asr-0.6b-q8_0.gguf';
const LOCAL_STT_TIMEOUT_MS = 120_000;
// While another page request is generating, ask again this often.
const LOCAL_BUSY_MS = 300;
// A released lease is dated 1970; anything before this is one.
const RELEASED_BEFORE_MS = 1000;
// The engine runs one generation at a time and answers 409 to any other, so requests wait their turn here.
let local_queue = Promise.resolve();

const VOLC_VOICES = [
  ['zh_female_vv_uranus_bigtts', 'Vivi · 通用女声'], ['zh_female_xiaohe_uranus_bigtts', '小何 · 通用女声'],
  ['zh_male_m191_uranus_bigtts', '云舟 · 通用男声'], ['zh_male_taocheng_uranus_bigtts', '小天 · 通用男声'],
  ['zh_male_liufei_uranus_bigtts', '刘飞 · 通用男声'], ['zh_female_sophie_uranus_bigtts', '魅力苏菲 · 女声'],
  ['zh_female_qingxinnvsheng_uranus_bigtts', '清新女声'], ['zh_female_cancan_uranus_bigtts', '知性灿灿 · 女声'],
  ['zh_female_zhixingnv_uranus_bigtts', '知性女声'], ['zh_female_wenroushunv_uranus_bigtts', '温柔淑女 · 女声'],
  ['zh_female_linjianvhai_uranus_bigtts', '邻家女孩'], ['zh_female_shuangkuaisisi_uranus_bigtts', '爽快思思 · 女声'],
  ['zh_female_gaolengyujie_uranus_bigtts', '高冷御姐 · 女声'], ['zh_female_xiaoxue_uranus_bigtts', '儿童绘本 · 女声'],
  ['zh_male_ruyaqingnian_uranus_bigtts', '儒雅青年 · 男声'], ['zh_male_yangguangqingnian_uranus_bigtts', '阳光青年 · 男声'],
  ['zh_male_yuanboxiaoshu_uranus_bigtts', '渊博小叔 · 男声'], ['zh_male_cixingjieshuonan_uranus_bigtts', '磁性解说 · 男声'],
  ['zh_male_shenyeboke_uranus_bigtts', '深夜播客 · 男声'], ['zh_male_xuanyijieshuo_uranus_bigtts', '悬疑解说 · 男声'],
  ['zh_male_baqiqingshu_uranus_bigtts', '霸气青叔 · 有声书男声'], ['zh_male_yizhipiannan_uranus_bigtts', '译制片男声'],
  ['zh_male_jieshuoxiaoming_uranus_bigtts', '解说小明 · 男声'], ['zh_male_wennuanahu_uranus_bigtts', '温暖阿虎 · 男声'],
];
// System voices of cosyvoice-v3-flash that read Mandarin and support per-character timings (voice list, 2026-11-04).
const ALIYUN_VOICES = [
  ['longxiaochun_v3', '龙小淳 · 知性女声'], ['longanwen_v3', '龙安温 · 优雅女声'], ['longanli_v3', '龙安莉 · 利落女声'],
  ['longyingtao_v3', '龙应桃 · 温柔女声'], ['longyuan_v3', '龙媛 · 治愈女声'], ['longyue_v3', '龙悦 · 磁性女声'],
  ['longxing_v3', '龙星 · 邻家女声'], ['longwan_v3', '龙婉 · 细腻女声'], ['longmiao_v3', '龙妙 · 抑扬顿挫女声'],
  ['longxiaoxia_v3', '龙小夏 · 沉稳女声'], ['longanyang', '龙安洋 · 阳光男声'], ['longanyun_v3', '龙安昀 · 暖男'],
  ['longanlang_v3', '龙安朗 · 清爽男声'], ['longanzhi_v3', '龙安智 · 睿智男声'], ['longcheng_v3', '龙橙 · 智慧青年'],
  ['longtian_v3', '龙天 · 磁性男声'], ['longsanshu_v3', '龙三叔 · 沉稳男声'], ['longxiu_v3', '龙修 · 说书男声'],
  ['longshu_v3', '龙书 · 沉稳青年'], ['longnan_v3', '龙楠 · 睿智青年'],
];
const AZURE_VOICES = [
  ['zh-CN-XiaoxiaoNeural', '晓晓 · 女声'], ['zh-CN-XiaoxiaoMultilingualNeural', '晓晓（多语言）· 女声'],
  ['zh-CN-XiaochenNeural', '晓辰 · 女声'], ['zh-CN-XiaoyiNeural', '晓伊 · 女声'], ['zh-CN-XiaohanNeural', '晓涵 · 女声'],
  ['zh-CN-XiaomoNeural', '晓墨 · 女声'], ['zh-CN-YunxiNeural', '云希 · 男声'],
  ['zh-CN-YunjianNeural', '云健 · 男声'], ['zh-CN-YunyangNeural', '云扬 · 新闻男声'], ['zh-CN-YunfengNeural', '云枫 · 男声'],
  ['zh-CN-YunzeNeural', '云泽 · 男声'],
];
// Qwen3-TTS CustomVoice's built-in speakers; all of them read Chinese, the last four with their own accent.
const LOCAL_VOICES = [
  ['Vivian', 'Vivian · 明亮女声'], ['Serena', 'Serena · 温柔女声'], ['Uncle_Fu', 'Uncle Fu · 低沉男声'],
  ['Dylan', 'Dylan · 北京青年男声'], ['Eric', 'Eric · 成都男声'], ['Ryan', 'Ryan · 英语男声'], ['Aiden', 'Aiden · 美式男声'],
  ['Ono_Anna', 'Ono Anna · 日语女声'], ['Sohee', 'Sohee · 韩语女声'],
];
// gpt-4o-mini-tts's built-in voices; the docs call them optimized for English and recommend marin or cedar.
const OPENAI_VOICES = [
  ['marin', 'Marin · 女声（推荐）'], ['cedar', 'Cedar · 男声（推荐）'], ['alloy', 'Alloy · 中性'], ['ash', 'Ash · 男声'],
  ['ballad', 'Ballad · 男声'], ['coral', 'Coral · 女声'], ['echo', 'Echo · 男声'], ['fable', 'Fable · 男声'], ['nova', 'Nova · 女声'],
  ['onyx', 'Onyx · 低沉男声'], ['sage', 'Sage · 女声'], ['shimmer', 'Shimmer · 女声'], ['verse', 'Verse · 男声'],
];
const voices = (list) => list.map(([id, label]) => ({ id, label }));

/**
 * The speech services the page can choose between. `key_base_url` is the root a saved key is bound to; `context` says
 * whether the tone instruction applies and `default_context` is the tone each starts with; `region` says whether the service also needs a region; `voice_input` marks the
 * one whose key also serves voice input; `rate: false` marks one that ignores the speech rate; `local` marks the service
 * on this computer, whose token the setup skill saves, so the page asks for no key; `shared_key` marks one that, without a
 * key of its own, uses the latest key saved for its address (OpenAI's, saved for model API members).
 */
export const TTS_PROVIDERS = [
  { id: 'local', label: '本机', key_base_url: LOCAL_URL, console_url: 'https://github.com/leemysw/yovoice',
    note: '本机显卡运行 Qwen3-TTS，不计费；用 local-tts-setup 技能安装', voices: voices(LOCAL_VOICES),
    default_speaker: 'Vivian', context: true, default_context: '语气平静克制，语调平稳，娓娓道来。', region: false, voice_input: false, rate: false, local: true },
  { id: 'volcengine', label: '火山引擎', key_base_url: 'https://openspeech.bytedance.com', console_url: 'https://console.volcengine.com/speech/new',
    note: '约 3 元/万字，语音输入共用此 Key', voices: voices(VOLC_VOICES),
    default_speaker: 'zh_female_vv_uranus_bigtts', context: true,
    default_context: '请用自然放松的语气朗读，像给朋友讲故事一样，有轻重缓急，句子之间自然停顿。', region: false, voice_input: true },
  { id: 'aliyun', label: '阿里云百炼', key_base_url: 'https://dashscope.aliyuncs.com', console_url: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    note: '约 2 元/万字（汉字计 2 字符）', voices: voices(ALIYUN_VOICES),
    default_speaker: 'longxiaochun_v3', context: false, region: false, voice_input: false },
  { id: 'azure', label: 'Azure', key_base_url: 'https://tts.speech.microsoft.com', console_url: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices',
    note: '每月免费约 25 万字，超出约 2 元/万字', voices: voices(AZURE_VOICES),
    default_speaker: 'zh-CN-XiaoxiaoNeural', context: false, region: true, voice_input: false },
  { id: 'openai', label: 'OpenAI', key_base_url: OPENAI_BASE_URL, console_url: 'https://platform.openai.com/api-keys',
    note: 'gpt-4o-mini-tts，约 0.1 元/分钟；音色偏英语口音，官方定于 2027-01-06 停用', voices: voices(OPENAI_VOICES),
    default_speaker: 'marin', context: true, default_context: '用标准普通话朗读，语气平稳自然，句间自然停顿。', region: false,
    voice_input: false, shared_key: true },
];

/** Trailing silence as silent MP3 frames matching Aliyun's and Azure's output. */
function silence_frames(silence_ms) {
  return Buffer.concat(Array(Math.round(silence_ms / SILENT_FRAME_MS)).fill(SILENT_FRAME));
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

/** Volcengine Doubao TTS 2.0: one-way chunked JSON; silence, tone and the shared section are sent as `additions`. */
async function volc_speak({ key, text, speaker, rate, context, silence, section_id }, request) {
  const additions = { ...(context ? { context_texts: [context] } : {}), ...(section_id ? { section_id } : {}),
    ...(silence ? { silence_duration: silence } : {}) };
  const body = { user: { uid: 'codiscuss' }, req_params: { text, speaker,
    audio_params: { format: 'mp3', sample_rate: SAMPLE_RATE, speech_rate: rate, enable_subtitle: true },
    ...(Object.keys(additions).length ? { additions: JSON.stringify(additions) } : {}) } };
  let response;
  try {
    response = await request(VOLC_ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': key, 'X-Api-Resource-Id': VOLC_RESOURCE_ID, 'X-Api-Request-Id': randomUUID() },
      body: JSON.stringify(body) });
  } catch { throw new Error('语音合成请求超时或连接失败，请检查网络后重试'); }
  if (response.status === 401 || response.status === 403) throw new Error('火山引擎拒绝了请求：API Key 无效或未开通豆包语音合成 2.0');
  const objects = split_json_objects(await response.text());
  const chunks = [];
  for (const item of objects) {
    if (item.code === VOLC_DONE_CODE) {
      const marks = objects.flatMap(part => part.sentence?.words || [])
        .map(word => ({ w: String(word.word || ''), t: Math.round(Number(word.startTime || 0) * 1000) }));
      return { audio: Buffer.concat(chunks).toString('base64'), format: 'mp3', marks };
    }
    if (item.code !== 0) throw new Error(`语音合成失败（${item.code}）：${VOLC_MESSAGES[item.code] || item.message || '请核对 API Key 与音色'}`);
    if (item.data) chunks.push(Buffer.from(item.data, 'base64'));
  }
  if (!response.ok) throw new Error(`语音合成失败：火山引擎返回 HTTP ${response.status}`);
  throw new Error('语音合成未完成：火山引擎没有返回结束标记');
}

/** Per-character timings over all sentences; each sentence's timings may restart at zero, so they are laid end to end. */
function aliyun_marks(sentences) {
  const marks = [];
  let base = 0, last = 0;
  for (const [, words] of [...sentences].sort((a, b) => a[0] - b[0])) {
    if (Number(words[0].begin_time) + base < last) base = last;
    for (const word of words) marks.push({ w: String(word.text || ''), t: Number(word.begin_time) + base });
    last = Number(words.at(-1).end_time) + base;
  }
  return marks;
}

/** Aliyun Bailian CosyVoice over its duplex WebSocket: run-task, the text, finish-task; audio arrives as binary frames. */
function aliyun_speak({ key, text, speaker, rate, silence }, open) {
  return new Promise((resolve, reject) => {
    const task_id = randomUUID();
    const chunks = [], sentences = new Map();
    let settled = false;
    const socket = open(ALIYUN_SOCKET, { headers: { Authorization: `Bearer ${key}` } });
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      // A close without a status code is never answered by the service, which then holds the connection open.
      try { socket.close(1000); } catch { /* Already closed. */ }
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('语音合成请求超时，请检查网络后重试')), TTS_TIMEOUT_MS);
    const send = (action, payload) => socket.send(JSON.stringify({ header: { action, task_id, streaming: 'duplex' }, payload }));
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => send('run-task', { task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: ALIYUN_MODEL, input: {},
      parameters: { text_type: 'PlainText', voice: speaker, format: 'mp3', sample_rate: SAMPLE_RATE, bit_rate: ALIYUN_BIT_RATE, rate: 1 + rate / 100,
        word_timestamp_enabled: true } });
    socket.onmessage = ({ data }) => {
      if (typeof data !== 'string') { chunks.push(Buffer.from(data)); return; }
      const { header = {}, payload = {} } = JSON.parse(data);
      const sentence = payload.output?.sentence;
      if (sentence?.words?.length) sentences.set(sentence.index, sentence.words);
      if (header.event === 'task-started') { send('continue-task', { input: { text } }); send('finish-task', { input: {} }); }
      else if (header.event === 'task-finished') {
        finish(null, { audio: Buffer.concat([...chunks, silence_frames(silence)]).toString('base64'), format: 'mp3', marks: aliyun_marks(sentences) });
      } else if (header.event === 'task-failed') finish(new Error(`语音合成失败（${header.error_code}）：${header.error_message || '请核对 API Key 与音色'}`));
    };
    socket.onerror = () => finish(new Error('连接阿里云百炼失败：请核对 API Key，并确认已开通 CosyVoice 语音合成'));
    socket.onclose = () => finish(new Error('阿里云百炼提前断开了连接，请稍后再试'));
  });
}

/** Escape text for SSML. */
const xml = (text) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** Azure neural voices over REST with SSML; the REST answer carries no word timings. */
async function azure_speak({ key, region, text, speaker, rate, silence }, request) {
  if (!region) throw new Error('尚未填写 Azure 区域：请在设置的“语音”中填写语音资源所在区域');
  const ssml = `<speak version="1.0" xml:lang="zh-CN"><voice name="${xml(speaker)}"><prosody rate="${rate >= 0 ? '+' : ''}${rate}%">${xml(text)}</prosody></voice></speak>`;
  let response;
  try {
    response = await request(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS), headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': AZURE_FORMAT, 'User-Agent': 'codiscuss' }, body: ssml });
  } catch { throw new Error('语音合成请求超时或连接失败，请检查网络与 Azure 区域后重试'); }
  if (response.status === 401 || response.status === 403) throw new Error('Azure 拒绝了请求：请核对 API Key 与区域是否属于同一个语音资源');
  if (response.status === 429) throw new Error('Azure 请求过于频繁（免费档每分钟 20 次），请稍后再试');
  if (!response.ok) throw new Error(`语音合成失败：Azure 返回 HTTP ${response.status}，请核对音色名称`);
  const audio = Buffer.from(await response.arrayBuffer());
  return { audio: Buffer.concat([audio, silence_frames(silence)]).toString('base64'), format: 'mp3', marks: [] };
}

/** OpenAI's Speech API; it gives no word timings. `rate` (-50..100 percent) maps to its speed multiplier. */
async function openai_speak({ key, text, speaker, rate, context, silence }, request) {
  let response;
  try {
    response = await request(`${OPENAI_BASE_URL}/audio/speech`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OPENAI_MODEL, input: text, voice: speaker, response_format: OPENAI_FORMAT, speed: 1 + rate / 100,
        ...(context ? { instructions: context } : {}) }) });
  } catch { throw new Error('语音合成请求超时或连接失败：请检查这台电脑能否访问 api.openai.com 后重试'); }
  if (!response.ok) {
    const reason = await response.json().then(body => body?.error?.message || '', () => '');
    if (response.status === 401) throw new Error('OpenAI 拒绝了 API Key：请在设置的“语音”中更换');
    if (response.status === 429) throw new Error(`OpenAI 请求过于频繁或额度不足，请稍后再试${reason ? `：${reason}` : ''}`);
    throw new Error(`语音合成失败：OpenAI 返回 HTTP ${response.status}${reason ? `：${reason}` : ''}`);
  }
  const audio = Buffer.from(await response.arrayBuffer());
  const pause = Buffer.concat(Array(Math.round(silence / SILENT_AAC_FRAME_MS)).fill(SILENT_AAC_FRAME));
  return { audio: Buffer.concat([audio, pause]).toString('base64'), format: 'aac', marks: [] };
}

/** Append trailing silence to a PCM WAV by extending its last (data) chunk with zeroed samples. */
export function wav_with_silence(wav, silence_ms) {
  if (!silence_ms) return wav;
  let offset = 12;
  while (wav.toString('latin1', offset, offset + 4) !== 'data') offset += 8 + wav.readUInt32LE(offset + 4);
  const block = wav.readUInt16LE(32);
  const silence = Buffer.alloc(Math.round(wav.readUInt32LE(28) * silence_ms / 1000 / block) * block);
  const result = Buffer.concat([wav, silence]);
  result.writeUInt32LE(result.length - 8, 4);
  result.writeUInt32LE(result.length - offset - 8, offset + 4);
  return result;
}

/** Ask the local service for one paragraph; the answer is a 24 kHz mono WAV. */
function local_generate({ key, text, speaker, context }, request) {
  return request(`${LOCAL_URL}/v1/generate`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, modelId: LOCAL_MODEL, speaker, language: 'zh', ...(context ? { voiceDescription: context } : {}) }) });
}

/**
 * Renew a local service's lease (in its directory); its supervisor stops the service once the lease is a minute old. A
 * renewal when a request ends keeps a release that came meanwhile (the user stopped reading), so the release still stops it.
 */
function local_renew(directory, { keep_release = false } = {}) {
  const lease = join(directory, 'lease');
  try {
    if (keep_release && statSync(lease).mtimeMs < RELEASED_BEFORE_MS) return;
    writeFileSync(lease, '');
  } catch { /* Not installed: the request reports it. */ }
}

/** Use stopped: date the lease back to 1970, so the supervisor stops the service at its next check (within 5 s). */
function local_release(directory) {
  try { utimesSync(join(directory, 'lease'), 0, 0); } catch { /* Not running or not installed. */ }
}

/**
 * Start an installed local service under its supervisor, detached so it outlives this process, and wait until `ready`
 * answers 200 with the token. `skill` names the setup skill to point at when it is missing.
 */
async function local_supervise({ directory, executable, args, env, ready, key, skill, wait_ms = LOCAL_START_MS }, request) {
  if (!existsSync(executable)) throw new Error(`本机服务尚未安装：请让本机 AI 按 ${skill} 技能安装`);
  local_renew(directory);
  spawn(process.execPath, [LOCAL_SUPERVISOR, directory, executable, ...args],
    { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env } }).unref();
  for (const deadline = Date.now() + wait_ms; Date.now() < deadline;) {
    await new Promise(resolve => setTimeout(resolve, LOCAL_POLL_MS));
    try { if ((await request(ready, { headers: { Authorization: `Bearer ${key}` } })).ok) return; } catch { /* Still starting. */ }
  }
  throw new Error(`本机服务启动超时，请查看 ${join(directory, 'serve.log')}`);
}

/** Start the read-aloud service (yovoice). */
function local_start(home, key, request) {
  const directory = join(home, LOCAL_DIR);
  return local_supervise({ directory, executable: join(directory, 'cli', `yovoice${LOCAL_EXE}`), key, skill: 'local-tts-setup',
    args: ['serve', '--listen', LOCAL_HOST, '--data-dir', join(directory, 'data')], env: { YOVOICE_API_TOKEN: key },
    ready: `${LOCAL_URL}/v1/status` }, request);
}

/**
 * Convert the WAV to 64 kbps AAC with the converter yovoice ships, which reads and writes files only. The index (moov)
 * goes before the audio: iPhone Safari rejects a blob with it at the end ("The operation is not supported.").
 */
async function local_convert(home, wav) {
  const work = mkdtempSync(join(tmpdir(), 'codiscuss-tts-'));
  try {
    writeFileSync(join(work, 'in.wav'), wav);
    await run_file(join(home, LOCAL_DIR, 'cli', 'tools', `ffmpeg${LOCAL_EXE}`), ['-hide_banner', '-loglevel', 'error', '-i', join(work, 'in.wav'),
      '-c:a', 'aac', '-b:a', LOCAL_BIT_RATE, '-movflags', '+faststart', '-f', 'ipod', join(work, 'out.m4a')], { windowsHide: true, timeout: LOCAL_CONVERT_MS })
      .catch(() => { throw new Error('本机语音转码失败：请重新运行 local-tts-setup 技能修复安装'); });
    return readFileSync(join(work, 'out.m4a'));
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/**
 * One paragraph on the local service, starting it first when nothing listens. The page's requests each run in their own
 * process, so another may be generating: the engine keeps no queue and answers 409, and this one waits its turn.
 */
async function local_once({ home, key, text, speaker, context, silence }, { request, convert, start }) {
  const deadline = Date.now() + TTS_TIMEOUT_MS;
  let response, started = false;
  for (;;) {
    try { response = await local_generate({ key, text, speaker, context }, request); }
    catch (error) {
      if (error.name === 'TimeoutError') throw new Error('本机语音合成超时，请稍后再试');
      if (started) throw new Error(`本机语音服务已启动但连接失败，请查看 ${join(home, LOCAL_DIR, 'serve.log')}`);
      await start(home, key, request);
      started = true;
      continue;
    }
    if (response.status !== 409 || Date.now() > deadline) break;
    await new Promise(resolve => setTimeout(resolve, LOCAL_BUSY_MS));
  }
  if (response.status === 401) throw new Error('本机语音服务拒绝了令牌：请重新运行 local-tts-setup 技能，或结束旧的 yovoice 进程后重试');
  if (response.status === 409) throw new Error('本机语音一直在忙，请稍后再试');
  if (!response.ok) {
    const code = (await response.json().catch(() => ({}))).error?.code;
    throw new Error(`本机语音合成失败（HTTP ${response.status}${code ? ` ${code}` : ''}），请查看 ${join(home, LOCAL_DIR, 'data', 'logs')}`);
  }
  const audio = await convert(home, wav_with_silence(Buffer.from(await response.arrayBuffer()), silence));
  return { audio: audio.toString('base64'), format: 'm4a', marks: [] };
}

/** Queue this process's local requests; each renews the lease when it arrives and, unless reading was stopped, when it ends. */
function local_speak(input, transport) {
  const directory = join(input.home, LOCAL_DIR);
  local_renew(directory);
  const result = local_queue.then(() => local_once(input, transport));
  local_queue = result.catch(() => {}).then(() => local_renew(directory, { keep_release: true }));
  return result;
}

/**
 * The voice-input services the page can choose between; `key_base_url` is the root a saved key is bound to, `local`
 * marks the service on this computer, whose token the setup skill saves.
 */
export const STT_PROVIDERS = [
  { id: 'local', label: '本机', key_base_url: LOCAL_STT_URL, note: '本机显卡运行 Qwen3-ASR，不计费；用 local-stt-setup 技能安装', local: true },
  { id: 'volcengine', label: '火山引擎', key_base_url: 'https://openspeech.bytedance.com', note: '用火山引擎「录音文件识别2.0」识别，单次最长 5 分钟' },
  { id: 'openai', label: 'OpenAI', key_base_url: OPENAI_BASE_URL, note: 'gpt-transcribe 识别，与朗读共用 OpenAI Key；官方定于 2027-02-26 停用' },
];

/** Start the voice-input service (CrispASR); its token comes in the environment, never on the command line. */
function local_stt_start(home, key, request) {
  const directory = join(home, LOCAL_STT_DIR);
  return local_supervise({ directory, executable: join(directory, 'cli', `crispasr${LOCAL_EXE}`), key, skill: 'local-stt-setup',
    args: ['--server', '--host', LOCAL_STT_HOST, '--port', LOCAL_STT_PORT, '--backend', 'qwen3', '-m', join(directory, 'models', LOCAL_STT_MODEL), '-l', 'zh'],
    env: { CRISPASR_API_KEYS: key }, ready: `${LOCAL_STT_URL}/health` }, request);
}

/** Send a recording (16 kHz mono WAV) to the local service. */
function local_stt_send(key, wav, request) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('language', 'zh');
  return request(`${LOCAL_STT_URL}/inference`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(LOCAL_STT_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${key}` }, body: form });
}

/**
 * Recognize a finished recording on this computer, starting the service when nothing listens.
 * @param {{ home: string, key: string, wav: Buffer }} input
 * @param {{ request?: Function, start?: Function }} [transport] `fetch` and the starter, replaceable in tests.
 * @returns {Promise<string>} The recognized text.
 */
export async function local_transcribe({ home, key, wav }, { request = fetch, start = local_stt_start } = {}) {
  const directory = join(home, LOCAL_STT_DIR);
  local_renew(directory);
  try {
    let response;
    try { response = await local_stt_send(key, wav, request); }
    catch (error) {
      if (error.name === 'TimeoutError') throw new Error('本机语音识别超时，请稍后再试');
      await start(home, key, request);
      try { response = await local_stt_send(key, wav, request); }
      catch { throw new Error(`本机语音识别服务已启动但连接失败，请查看 ${join(directory, 'serve.log')}`); }
    }
    if (response.status === 401) throw new Error('本机语音识别服务拒绝了令牌：请重新运行 local-stt-setup 技能，或结束旧的 crispasr 进程后重试');
    if (!response.ok) throw new Error(`本机语音识别失败（HTTP ${response.status}），请查看 ${join(directory, 'serve.log')}`);
    return String((await response.json()).text || '').trim();
  } finally { local_renew(directory); }
}

const SPEAKERS = { volcengine: volc_speak, aliyun: aliyun_speak, azure: azure_speak, openai: openai_speak };

/**
 * Synthesize one paragraph with one provider.
 * @param {string} provider One of TTS_PROVIDERS' ids.
 * @param {{ key: string, text: string, speaker: string, rate: number, context?: string, silence: number, section_id?: string, region?: string, home?: string }} input
 *   `rate` is -50..100 (percent faster), `silence` the trailing silence in ms; `home` (the service home) locates the local service.
 * @param {{ request?: Function, open?: Function, convert?: Function, start?: Function }} [transport] `fetch`, WebSocket factory and
 *   the local service's converter and starter, replaceable in tests.
 * @returns {Promise<{ audio: string, format: string, marks: { w: string, t: number }[] }>}
 */
export function provider_speak(provider, input, { request = fetch, open = (url, init) => new WebSocket(url, init), convert = local_convert,
  start = local_start } = {}) {
  if (provider === 'local') return local_speak(input, { request, convert, start });
  return SPEAKERS[provider](input, provider === 'aliyun' ? open : request);
}

/**
 * The user stopped reading: a service that runs on this computer frees its resources now instead of after its lease;
 * the cloud services hold nothing between requests.
 * @param {string} provider One of TTS_PROVIDERS' ids.
 * @param {string} home The service home.
 */
export function provider_release(provider, home) {
  if (provider === 'local') local_release(join(home, LOCAL_DIR));
}

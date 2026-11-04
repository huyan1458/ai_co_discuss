/**
 * Read-aloud providers: what each speech service offers (voices, key root, console) and how one paragraph is
 * synthesized there. Every provider answers the same shape, `{ audio: base64 MP3, format: "mp3", marks: [{ w, t }] }`;
 * `marks` holds per-character start times in ms when the service gives them, otherwise it is empty and the page spreads
 * the highlight by length.
 */
import { randomUUID } from 'node:crypto';

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
// Aliyun and Azure answer 24 kHz mono MP3, so trailing silence is appended as silent frames of that format.
const SAMPLE_RATE = 24000;
// One silent MPEG-2 Layer III frame (24 kHz, 32 kbps, mono): a header and zeroed side info, 576 samples = 24 ms.
const SILENT_FRAME = Buffer.concat([Buffer.from([0xff, 0xf3, 0x44, 0xc0]), Buffer.alloc(92)]);
const SILENT_FRAME_MS = 24;
const AZURE_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

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
const voices = (list) => list.map(([id, label]) => ({ id, label }));

/**
 * The speech services the page can choose between. `key_base_url` is the root a saved key is bound to; `context` says
 * whether the tone instruction applies; `region` says whether the service also needs a region; `voice_input` marks the
 * one whose key also serves voice input.
 */
export const TTS_PROVIDERS = [
  { id: 'volcengine', label: '火山引擎', key_base_url: 'https://openspeech.bytedance.com', console_url: 'https://console.volcengine.com/speech/new',
    note: '豆包语音合成 2.0，约 3 元/万字（字数包更便宜）；语音输入也用这个 Key。', voices: voices(VOLC_VOICES),
    default_speaker: 'zh_female_vv_uranus_bigtts', context: true, region: false, voice_input: true },
  { id: 'aliyun', label: '阿里云百炼', key_base_url: 'https://dashscope.aliyuncs.com', console_url: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    note: 'CosyVoice v3-flash，1 元/万字符（一个汉字计 2 字符，约 2 元/万字）。', voices: voices(ALIYUN_VOICES),
    default_speaker: 'longxiaochun_v3', context: false, region: false, voice_input: false },
  { id: 'azure', label: 'Azure', key_base_url: 'https://tts.speech.microsoft.com', console_url: 'https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices',
    note: '神经语音，免费档 F0 每月 50 万字符（一个汉字计 2 字符，约 25 万字）；付费档约 2 元/万字；高亮按时长估算。', voices: voices(AZURE_VOICES),
    default_speaker: 'zh-CN-XiaoxiaoNeural', context: false, region: true, voice_input: false },
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
      try { socket.close(); } catch { /* Already closed. */ }
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('语音合成请求超时，请检查网络后重试')), TTS_TIMEOUT_MS);
    const send = (action, payload) => socket.send(JSON.stringify({ header: { action, task_id, streaming: 'duplex' }, payload }));
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => send('run-task', { task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: ALIYUN_MODEL, input: {},
      parameters: { text_type: 'PlainText', voice: speaker, format: 'mp3', sample_rate: SAMPLE_RATE, rate: 1 + rate / 100, word_timestamp_enabled: true } });
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

const SPEAKERS = { volcengine: volc_speak, aliyun: aliyun_speak, azure: azure_speak };

/**
 * Synthesize one paragraph with one provider.
 * @param {string} provider One of TTS_PROVIDERS' ids.
 * @param {{ key: string, text: string, speaker: string, rate: number, context?: string, silence: number, section_id?: string, region?: string }} input
 *   `rate` is -50..100 (percent faster), `silence` the trailing silence in ms.
 * @param {{ request?: Function, open?: Function }} [transport] `fetch` and WebSocket factory, replaceable in tests.
 * @returns {Promise<{ audio: string, format: string, marks: { w: string, t: number }[] }>}
 */
export function provider_speak(provider, input, { request = fetch, open = (url, init) => new WebSocket(url, init) } = {}) {
  return SPEAKERS[provider](input, provider === 'aliyun' ? open : request);
}

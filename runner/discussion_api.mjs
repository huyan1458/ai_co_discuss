/** Provider presets and independent wire protocols; model IDs are never rewritten. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const API_PROVIDERS = {
  Codex: { label: 'OpenAI', base_url: 'https://api.openai.com/v1', api_protocol: 'responses', models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'] },
  Claude: { label: 'Anthropic', base_url: 'https://api.anthropic.com/v1', api_protocol: 'anthropic', models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'] },
  Gemini: { label: 'Google', base_url: 'https://generativelanguage.googleapis.com/v1beta', api_protocol: 'gemini', models: ['gemini-4-argon', 'gemini-3.8-flash'] },
  DeepSeek: { label: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', api_protocol: 'chat', models: ['deepseek-flash', 'deepseek-v4-pro'] },
  Qwen: { label: '阿里云百炼', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api_protocol: 'chat', models: ['qwen3.8-flash', 'qwen3.7-plus', 'qwen3.8-max'] },
  Grok: { label: 'xAI', base_url: 'https://api.x.ai/v1', api_protocol: 'responses', models: ['grok-4.7'] },
};
const PROTOCOLS = ['responses', 'chat', 'anthropic', 'gemini'];
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_TOKENS = 8192;

/** Validate an explicit API root, keeping custom gateway paths intact. */
export function api_base_url(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL 须为不含凭据、查询或片段的 HTTP(S) 地址');
  return url.href.replace(/\/+$/, '');
}

/** Check protocol/model independently of provider identity. */
export function validate_api_profile(profile) {
  api_base_url(profile.base_url);
  if (!PROTOCOLS.includes(profile.api_protocol)) throw new Error('请选择 API 请求协议');
  if (!profile.model || typeof profile.model !== 'string') throw new Error('请填写 API 模型 ID');
  if (!/^[a-f0-9-]{36}$/i.test(profile.api_key_ref || '')) throw new Error('请保存此 Base URL 对应的 API Key');
}

/** Save a key privately; browsers and room configuration receive only an opaque reference. */
export function save_api_key(home, input) {
  const base_url = api_base_url(input.base_url);
  const api_key = typeof input.api_key === 'string' ? input.api_key.trim() : '';
  if (!api_key || /[\r\n]/.test(api_key)) throw new Error('API Key 不能为空或包含换行');
  const api_key_ref = randomUUID();
  const directory = join(home, 'api-keys');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, `${api_key_ref}.json`), JSON.stringify({ base_url, api_key }), { flag: 'wx', mode: 0o600 });
  return { api_key_ref };
}

/** Map each API root to its most recently saved key reference, so a new form need not ask again. */
export function saved_api_keys(home) {
  const directory = join(home, 'api-keys');
  if (!existsSync(directory)) return {};
  const saved = readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/i.test(name)).map(name => {
    const path = join(directory, name);
    try { return { ref: name.slice(0, -5), base_url: JSON.parse(readFileSync(path, 'utf8')).base_url, time: statSync(path).mtimeMs }; }
    catch { return null; }
  }).filter(Boolean).sort((a, b) => a.time - b.time);
  return Object.fromEntries(saved.map(item => [item.base_url, item.ref]));
}

/** Resolve only a validated reference bound to this exact API root. */
export function read_api_key(home, profile) {
  validate_api_profile(profile);
  let saved;
  try { saved = JSON.parse(readFileSync(join(home, 'api-keys', `${profile.api_key_ref}.json`), 'utf8')); }
  catch { throw new Error('本机 API Key 不存在，请重新保存'); }
  if (saved.base_url !== api_base_url(profile.base_url)) throw new Error('Base URL 已变化，请为新地址重新填写 API Key');
  return saved.api_key;
}

/** Convert neutral tool definitions to one provider's request body. */
export function api_request(profile, context) {
  const { system, history, tools } = context;
  const model = profile.model;
  const functions = tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  if (profile.api_protocol === 'responses') return { path: '/responses', body: { model, instructions: system, input: history,
    tools: functions.map(tool => ({ type: 'function', ...tool, strict: false })), store: false,
    include: ['reasoning.encrypted_content'], max_output_tokens: MAX_OUTPUT_TOKENS } };
  if (profile.api_protocol === 'anthropic') return { path: '/messages', body: { model, system, messages: history,
    tools: functions.map(({ parameters, ...tool }) => ({ ...tool, input_schema: parameters })), max_tokens: MAX_OUTPUT_TOKENS } };
  if (profile.api_protocol === 'gemini') return { path: `/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`, body: {
    systemInstruction: { parts: [{ text: system }] }, contents: history,
    tools: [{ functionDeclarations: functions }], generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS } } };
  return { path: '/chat/completions', body: { model, messages: [{ role: 'system', content: system }, ...history],
    tools: functions.map(tool => ({ type: 'function', function: tool })) } };
}

/** Build authentication without encoding keys into URLs. */
function api_headers(protocol, key) {
  if (protocol === 'anthropic') return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  if (protocol === 'gemini') return { 'x-goog-api-key': key };
  return { Authorization: `Bearer ${key}` };
}

/** A bounded request; errors expose only status, never provider bodies or authorization. */
async function provider_fetch(profile, key, request, signal) {
  let response;
  try {
    response = await fetch(`${api_base_url(profile.base_url)}${request.path}`, {
      method: request.body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...api_headers(profile.api_protocol, key) },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch { throw new Error(signal?.aborted ? 'API 执行已取消' : 'API 请求超时或连接失败，请核对 Base URL'); }
  if (!response.ok) throw new Error(`模型 API 返回 HTTP ${response.status}，请核对地址、密钥、模型和请求协议`);
  try { return await response.json(); } catch { throw new Error('模型 API 返回的内容不是有效 JSON'); }
}

/** Fetch model IDs as returned by the provider; manual entry remains available. */
export async function api_models(home, profile) {
  const key = read_api_key(home, profile);
  const data = await provider_fetch(profile, key, { path: '/models' });
  const models = (data.data || data.models || []).map(model => ({ id: model.id || model.name?.replace(/^models\//, ''), label: model.displayName || model.name || model.id }))
    .filter(model => typeof model.id === 'string');
  return { adapter: 'api', models, error: '', source: 'api' };
}

/** Start protocol-specific history with a user request. */
export function api_history(profile, prompt) {
  return profile.api_protocol === 'gemini' ? [{ role: 'user', parts: [{ text: prompt }] }] : [{ role: 'user', content: prompt }];
}

/** Preserve raw reasoning/signature blocks for subsequent tool turns, without displaying them. */
export function api_response(profile, data, history) {
  if (profile.api_protocol === 'responses') {
    if (data.status === 'incomplete' || data.error) throw new Error('模型 API 未完成回答');
    const output = data.output || [];
    history.push(...output);
    return output.filter(item => item.type === 'function_call').map(item => ({ id: item.call_id, name: item.name, arguments: item.arguments }));
  }
  if (profile.api_protocol === 'anthropic') {
    if (data.stop_reason === 'max_tokens') throw new Error('模型 API 输出超过单次长度限制');
    history.push({ role: 'assistant', content: data.content });
    return (data.content || []).filter(item => item.type === 'tool_use').map(item => ({ id: item.id, name: item.name, arguments: item.input }));
  }
  if (profile.api_protocol === 'gemini') {
    const candidate = data.candidates?.[0];
    if (!candidate?.content || candidate.finishReason === 'MAX_TOKENS') throw new Error('模型 API 未完成回答');
    history.push(candidate.content);
    return (candidate.content.parts || []).filter(item => item.functionCall).map(item => ({ name: item.functionCall.name, arguments: item.functionCall.args }));
  }
  const choice = data.choices?.[0];
  if (!choice?.message || choice.finish_reason === 'length') throw new Error('模型 API 未完成回答');
  history.push(choice.message);
  return (choice.message.tool_calls || []).map(item => ({ id: item.id, name: item.function.name, arguments: item.function.arguments }));
}

/** Append all results together so parallel tool calls retain their protocol's pairing. */
export function api_tool_results(profile, history, results) {
  if (profile.api_protocol === 'anthropic') return history.push({ role: 'user', content: results.map(item => ({ type: 'tool_result', tool_use_id: item.id, content: JSON.stringify(item.result) })) });
  if (profile.api_protocol === 'gemini') return history.push({ role: 'user', parts: results.map(item => ({ functionResponse: { name: item.name, response: { result: item.result } } })) });
  history.push(...results.map(item => profile.api_protocol === 'responses'
    ? { type: 'function_call_output', call_id: item.id, output: JSON.stringify(item.result) }
    : { role: 'tool', tool_call_id: item.id, content: JSON.stringify(item.result) }));
}

/** Generate one tool-call turn with the selected wire protocol. */
export async function api_generate(profile, key, context, signal) {
  const data = await provider_fetch(profile, key, api_request(profile, context), signal);
  return api_response(profile, data, context.history);
}

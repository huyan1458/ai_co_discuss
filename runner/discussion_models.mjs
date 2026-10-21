/** Discover model selectors from the installed software without starting an AI turn. */
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';

const QUERY_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const SOURCES = { codex_cli: 'codex-app-server', claude: 'claude-cli', antigravity_cli: 'antigravity-cli' };
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/;

/** Return only model identifiers, display names and supported effort values. */
function model_entry(id, label, efforts) {
  if (typeof id !== 'string' || !MODEL_PATTERN.test(id)) return null;
  return { id, label: typeof label === 'string' && label.trim() ? label : id,
    ...(Array.isArray(efforts) ? { efforts: [...new Set(efforts.filter(item => typeof item === 'string'))] } : {}) };
}

/** Keep all query processes noninteractive and avoid user/project startup hooks. */
function query_arguments(adapter) {
  if (adapter === 'codex_cli') return ['app-server', '--listen', 'stdio://'];
  if (adapter === 'antigravity_cli') return ['models'];
  return ['--safe-mode', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
}

/** Read one catalog, kill its temporary process on every outcome, and bound response size/time. */
function query_catalog(profile, options) {
  return new Promise((resolve_result, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const child = (options.spawn || spawn)(profile.executable, query_arguments(profile.adapter), {
      cwd: tmpdir(), env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let finished = false, bytes = 0;
    const finish = (error, models) => {
      if (finished) return;
      finished = true; clearTimeout(timer); lines.close(); child.stdin.destroy(); child.kill();
      if (error) reject(error); else resolve_result(models);
    };
    const timer = setTimeout(() => finish(new Error('读取模型列表超时，请检查软件登录和网络后重试')), options.timeout_ms ?? QUERY_TIMEOUT_MS);
    const lines = createInterface({ input: child.stdout });
    const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
    const receive = catalog_reader(profile.adapter, send, finish);
    child.once('error', () => finish(new Error('无法启动模型查询，请检查 CLI 路径')));
    child.stdin.on('error', () => finish(new Error('模型查询连接已关闭')));
    child.stderr.on('data', () => {}); // CLI diagnostics can contain private account or configuration data.
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) finish(new Error('模型目录响应超出大小限制'));
    });
    lines.on('line', line => {
      if (finished) return;
      try { receive.line(line); } catch { finish(new Error('软件模型目录格式无法识别，请检查 CLI 版本')); }
    });
    child.once('close', code => {
      if (!finished && code === 0 && receive.complete) finish(null, receive.complete());
      else if (!finished) finish(new Error(`软件未返回模型目录（退出码 ${code ?? '未知'}），请检查版本、登录与网络`));
    });
    receive.start();
  });
}

/** Codex's catalog is paginated; initialize before querying and never create a thread or turn. */
function codex_reader(send, finish) {
  const models = [];
  let request_id = 1;
  return {
    start: () => send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'codiscuss', title: 'AI CoDiscuss', version: '0.2.1' } } }),
    line: line => {
      const reply = json_line(line);
      if (!reply || (reply.id !== 0 && reply.id !== request_id)) return;
      if (reply.error) return finish(new Error('Codex 模型目录查询失败，请检查 CLI 版本与登录'));
      if (reply.id === 0) {
        send({ method: 'initialized', params: {} });
        send({ id: request_id, method: 'model/list', params: { limit: 100, includeHidden: false } });
        return;
      }
      for (const model of reply.result?.data || []) {
        if (!model.hidden) models.push(model_entry(model.model || model.id, model.displayName,
          model.supportedReasoningEfforts?.map(item => item.reasoningEffort)));
      }
      const cursor = reply.result?.nextCursor;
      if (cursor) send({ id: ++request_id, method: 'model/list', params: { limit: 100, includeHidden: false, cursor } });
      else finish(null, models);
    },
  };
}

/** Ignore non-protocol diagnostics while leaving malformed or missing catalogs visibly unavailable. */
function json_line(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/** Claude initialization exposes its picker; agy emits tab-separated ids and labels. */
function catalog_reader(adapter, send, finish) {
  if (adapter === 'codex_cli') return codex_reader(send, finish);
  if (adapter === 'claude') return {
    start: () => send({ type: 'control_request', request_id: 'catalog', request: { subtype: 'initialize' } }),
    line: line => {
      const reply = json_line(line);
      if (reply?.type !== 'control_response' || reply.response?.request_id !== 'catalog') return;
      if (reply.response.subtype !== 'success') return finish(new Error('Claude 模型目录查询失败，请检查 CLI 版本与登录'));
      finish(null, (reply.response.response?.models || []).map(model => model_entry(model.value, model.displayName,
        model.supportedEffortLevels || (model.supportsEffort ? undefined : []))));
    },
  };
  const models = [];
  return { start: () => {}, complete: () => models, line: line => {
    const fields = line.trim().split(/\t+| {2,}/);
    if (fields.length >= 2) models.push(model_entry(fields[0], fields.slice(1).join(' ')));
  } };
}

/** Public model metadata only; failures leave the original-software default available to the UI. */
export async function software_models(profile, options = {}) {
  const { adapter, executable } = profile;
  const result = { adapter, models: [], source: SOURCES[adapter] || 'original-software' };
  if (!SOURCES[adapter]) return { ...result, error: '此入口的模型在原软件内设置' };
  if (typeof executable !== 'string' || !isAbsolute(executable)) return { ...result, error: '请先配置 CLI 的完整路径，再读取模型列表' };
  try {
    const models = (await query_catalog(profile, options)).filter(Boolean);
    result.models = [...new Map(models.map(model => [model.id, model])).values()];
    if (!result.models.length) result.error = '软件未返回可选模型，请检查版本、登录与网络；仍可使用软件默认模型';
  } catch (error) { result.error = error.message; }
  return result;
}

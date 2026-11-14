/** Calls to the management panel's own API; the server accepts them only from this page with its session. */

/**
 * Send one request and return its JSON.
 *
 * Args:
 *   path: Path under /api/, e.g. "accounts/demo/start".
 *   body: Sent as JSON with POST; omit for GET.
 */
export async function call(path, body) {
  const response = await fetch(`/api/${path}`, body === undefined ? { credentials: "same-origin" }
    : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CoDiscuss-Panel": "1" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

// Provider presets keyed as the server sends them, with the icon each shows.
const PROVIDER_ICONS = { Codex: "openai", OpenAI: "openai", Claude: "claude", Antigravity: "gemini", DeepSeek: "deepseek", Qwen: "qwen", Grok: "grok" };

/** The icon file of a provider preset, or "" for one without. */
export function provider_icon(key) {
  return PROVIDER_ICONS[key] ? `/icons/${PROVIDER_ICONS[key]}.svg` : "";
}

/** The preset whose address a saved key belongs to, so the key list can show its name and icon. */
export function provider_of(providers, base_url) {
  const found = Object.entries(providers).find(([key, provider]) => key !== "OpenAI" && provider.base_url && provider.base_url === base_url);
  return found ? { key: found[0], ...found[1] } : { key: "Custom", label: "自定义接口" };
}

/** The address a hosted account's person opens: the entry's public address, else its address on this computer. */
export function entry_address(entry) {
  if (!entry) return "";
  return entry.public_url || `http://127.0.0.1:${entry.port}`;
}

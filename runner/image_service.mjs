/**
 * Image generation as a service of this computer: one Images API address, key and image model, set once in the page's
 * settings like read-aloud, and used by any member of a room whose owner turned drawing on (the room's
 * `image_generation`). CLI members draw with `codiscuss launch image --file REQUEST` (discussion_launch.mjs), API
 * members with their image tools; both run `run_image_tool` (adapters/api_images.mjs).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { api_base_url, api_models, read_saved_api_key } from './discussion_api.mjs';
import { IMAGE_MODELS } from './adapters/profiles.mjs';
import { atomic_json } from './files.mjs';

const SETTINGS_FILE = 'image-settings.json';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
const KEY_REF = /^[a-f0-9-]{36}$/i;

/**
 * Before this service existed, an API member's card named its own image model at its own address; the first such saved
 * default becomes these settings.
 */
function legacy_settings(home) {
  try {
    const participants = JSON.parse(readFileSync(join(home, 'launch-settings.json'), 'utf8')).participants || {};
    const profile = Object.values(participants).find(item => item?.image_model && item.base_url && item.api_key_ref);
    return profile ? { base_url: profile.base_url, model: profile.image_model, api_key_ref: profile.api_key_ref } : null;
  } catch { return null; }
}

/** This computer's image settings `{base_url, model, api_key_ref, configured, catalog}`; never the key itself. */
export function image_settings(home) {
  const path = join(home, SETTINGS_FILE);
  let saved = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : legacy_settings(home);
  // Saved once, so the old card setting survives the next save of the defaults, which drops it.
  if (saved && !existsSync(path)) atomic_json(path, saved);
  saved ||= {};
  const settings = { base_url: saved.base_url || DEFAULT_BASE_URL, model: saved.model || IMAGE_MODELS[0], api_key_ref: saved.api_key_ref || '' };
  return { ...settings, configured: Boolean(settings.api_key_ref), catalog: IMAGE_MODELS };
}

/** Save the image settings; the key itself is saved beforehand through `api-key`, which returns its reference. */
export function save_image_settings(home, input) {
  const base_url = api_base_url(String(input.base_url || ''));
  const model = String(input.model || '').trim();
  if (!MODEL_ID.test(model)) throw new Error('图片模型只能是模型 ID，例如 gpt-image-2.6-flare');
  const api_key_ref = String(input.api_key_ref || '');
  if (api_key_ref && !KEY_REF.test(api_key_ref)) throw new Error('请先保存这个地址对应的 Key');
  atomic_json(join(home, SETTINGS_FILE), { base_url, model, ...(api_key_ref ? { api_key_ref } : {}) });
  return image_settings(home);
}

/** What a room's members draw with `{model, base_url, key}`, or null when the room is off or no key is set. */
export function room_image(home, config) {
  if (!config.image_generation) return null;
  const settings = image_settings(home);
  if (!settings.configured) return null;
  return { model: settings.model, base_url: api_base_url(settings.base_url), key: read_saved_api_key(home, settings.base_url, settings.api_key_ref) };
}

/** A refusal the page shows in its own language (`error_text`, see expert_failure in discussion_launch.mjs). */
function check_failure(template, params = {}) {
  return Object.assign(new Error(template.replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match)), { error_text: { template, params } });
}

/**
 * Check the saved address, key and image model without drawing (drawing is billed per image): list the models the key
 * can see and look for the chosen one. It cannot tell whether the account may actually draw (balance, verification).
 */
export async function image_check(home) {
  const settings = image_settings(home);
  if (!settings.configured) throw check_failure('请先填写生图 API Key');
  const { models } = await api_models(home, { base_url: settings.base_url, api_protocol: 'chat', model: settings.model, api_key_ref: settings.api_key_ref });
  if (!models.some(item => item.id === settings.model)) throw check_failure('地址与密钥可用，但这个密钥的模型列表里没有 {model}，请核对模型 ID 或账号是否已开通', { model: settings.model });
  return { ok: true };
}

/** Formatting and defensive normalization for local storage snapshots across the panel and room UI. */
const KIB = 1024;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const UNITS = [[GIB, "GiB"], [MIB, "MiB"], [KIB, "KiB"]];

export const DEFAULT_LIMITS = {
  room_draft_bytes: 1 * GIB,
  draft_bytes: 3 * GIB,
  home_warn_bytes: 8 * GIB,
  home_limit_bytes: 10 * GIB,
  warn_ratio: 0.8,
  max_scan_files: 200_000,
};

/** Format bytes into IEC units (`1.5 GiB`, `10 GiB`, `512 MiB`, `0 B`). */
export function format_storage_bytes(bytes) {
  const safe = Math.max(0, Number(bytes) || 0);
  for (const [unit, label] of UNITS) {
    if (safe >= unit) {
      const value = safe / unit;
      const text = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
      return `${text} ${label}`;
    }
  }
  return `${Math.round(safe)} B`;
}

/** Normalize member entries from either an array or a plain `{ name: bytes }` map. */
function normalize_members(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw)
    ? raw.map((item) => ({
      key: String(item.key || item.id || item.member || item.name || ""),
      label: String(item.label || item.name || item.member || item.key || ""),
      bytes: Math.max(0, Number(item.bytes ?? item.total_bytes ?? item.size ?? 0) || 0),
      scratch_bytes: Math.max(0, Number(item.scratch_bytes ?? item.temp_bytes ?? item.cleanable_bytes ?? 0) || 0),
    }))
    : Object.entries(raw).map(([key, value]) => ({
      key,
      label: key,
      bytes: Math.max(0, Number(typeof value === "object" ? (value?.bytes ?? value?.total_bytes ?? 0) : value) || 0),
      scratch_bytes: Math.max(0, Number(typeof value === "object" ? (value?.scratch_bytes ?? value?.temp_bytes ?? 0) : 0) || 0),
    }));
  return list.sort((a, b) => b.bytes - a.bytes);
}

/** Normalize room entries from either an array or a `{ room_key: bytes }` dictionary. */
function normalize_rooms(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw)
    ? raw.map((item) => ({
      key: String(item.key || item.draft_key || item.room_key || item.room_id || item.id || ""),
      room_id: String(item.room_id || item.id || ""),
      title: String(item.title || item.room_title || item.name || ""),
      bytes: Math.max(0, Number(item.bytes ?? item.draft_bytes ?? item.total_bytes ?? 0) || 0),
      scratch_bytes: Math.max(0, Number(item.scratch_bytes ?? item.temp_bytes ?? item.cleanable_bytes ?? 0) || 0),
      unreadable: Math.max(0, Number(item.unreadable ?? 0) || 0),
      members: normalize_members(item.members),
    }))
    : Object.entries(raw).map(([key, value]) => ({
      key,
      room_id: typeof value === "object" ? String(value?.room_id || "") : "",
      title: typeof value === "object" ? String(value?.title || "") : "",
      bytes: Math.max(0, Number(typeof value === "object" ? (value?.bytes ?? value?.draft_bytes ?? 0) : value) || 0),
      scratch_bytes: Math.max(0, Number(typeof value === "object" ? (value?.scratch_bytes ?? value?.temp_bytes ?? 0) : 0) || 0),
      unreadable: Math.max(0, Number(typeof value === "object" ? (value?.unreadable ?? 0) : 0) || 0),
      members: typeof value === "object" ? normalize_members(value?.members) : [],
    }));
  return list.sort((a, b) => b.bytes - a.bytes);
}

/** Normalize speech model storage summary (kept separate from the 10 GiB data cap). */
function normalize_models(raw, explicit_total) {
  if (!raw && explicit_total == null) return { total_bytes: 0, entries: [] };
  if (typeof raw === "number") return { total_bytes: Math.max(0, raw), entries: [] };
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.entries || raw?.items || raw?.directories) ? (raw.entries || raw.items || raw.directories) : [];
  const entries = items.map((item) => ({
    name: String(item.name || item.program || item.id || item.kind || ""),
    path: String(item.path || item.directory || ""),
    bytes: Math.max(0, Number(item.bytes ?? item.total_bytes ?? item.size ?? 0) || 0),
    unreadable: Math.max(0, Number(item.unreadable || 0) || 0),
  }));
  const sum = entries.reduce((total, item) => total + item.bytes, 0);
  const total_bytes = Math.max(0, Number(explicit_total ?? raw?.total_bytes ?? raw?.bytes ?? sum) || 0);
  return { total_bytes, entries };
}

/**
 * Normalize a storage payload returned by the panel API or local/relayed service API.
 * @param {object|null|undefined} raw Raw response payload.
 * @returns {object|null}
 */
export function normalize_storage_snapshot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const limits_raw = raw.limits || raw.thresholds || {};
  const limits = {
    room_draft_bytes: Number(limits_raw.room_bytes ?? limits_raw.room_draft_bytes ?? limits_raw.room_draft_limit ?? raw.room_draft_limit ?? DEFAULT_LIMITS.room_draft_bytes) || DEFAULT_LIMITS.room_draft_bytes,
    draft_bytes: Number(limits_raw.draft_bytes ?? limits_raw.draft_limit ?? raw.draft_limit ?? DEFAULT_LIMITS.draft_bytes) || DEFAULT_LIMITS.draft_bytes,
    home_warn_bytes: Number(limits_raw.warn_bytes ?? limits_raw.home_warn_bytes ?? limits_raw.home_warn ?? raw.home_warn ?? DEFAULT_LIMITS.home_warn_bytes) || DEFAULT_LIMITS.home_warn_bytes,
    home_limit_bytes: Number(limits_raw.home_bytes ?? limits_raw.home_limit_bytes ?? limits_raw.home_limit ?? raw.home_limit ?? DEFAULT_LIMITS.home_limit_bytes) || DEFAULT_LIMITS.home_limit_bytes,
    warn_ratio: Number(limits_raw.pressure_ratio ?? limits_raw.warn_ratio ?? raw.warn_ratio ?? DEFAULT_LIMITS.warn_ratio) || DEFAULT_LIMITS.warn_ratio,
    max_scan_files: Number(limits_raw.max_files ?? limits_raw.max_scan_files ?? raw.max_scan_files ?? DEFAULT_LIMITS.max_scan_files) || DEFAULT_LIMITS.max_scan_files,
  };
  const rooms = normalize_rooms(raw.rooms);
  const total_bytes = Math.max(0, Number(raw.total_bytes ?? 0) || 0);
  const draft_bytes = Math.max(0, Number(raw.draft_bytes ?? rooms.reduce((sum, item) => sum + item.bytes, 0)) || 0);
  const local_bytes = Math.max(0, Number(raw.local_bytes ?? 0) || 0);
  const scratch_bytes = Math.max(0, Number(raw.scratch_bytes ?? raw.cleanable_bytes ?? raw.temp_bytes ?? rooms.reduce((sum, item) => sum + item.scratch_bytes, 0)) || 0);
  const disk_raw = raw.disk || null;
  const disk = disk_raw && Number.isFinite(Number(disk_raw.available_bytes))
    ? { available_bytes: Math.max(0, Number(disk_raw.available_bytes)), reserve_bytes: Math.max(0, Number(disk_raw.reserve_bytes || 0)) }
    : null;
  const models = normalize_models(raw.models, raw.model_bytes);
  const truncated = Boolean(raw.truncated);
  const unreadable = Math.max(0, Number(raw.unreadable || 0) || 0);
  const warning = Boolean(raw.warning || total_bytes >= limits.home_warn_bytes);
  const over_limit = Boolean(raw.over_limit || truncated || total_bytes > limits.home_limit_bytes || draft_bytes > limits.draft_bytes || (disk && disk.available_bytes < disk.reserve_bytes));
  return {
    home: String(raw.home || ""),
    total_bytes,
    draft_bytes,
    local_bytes,
    scratch_bytes,
    unreadable,
    truncated,
    warning,
    warning_reason: String(raw.warning_reason || ""),
    block_reason: String(raw.block_reason || ""),
    over_limit,
    disk,
    models,
    rooms,
    limits,
    updated_at: Number(raw.updated_at || 0) || 0,
  };
}

/** Find one room's draft usage entry by room ID or draft directory key. */
export function find_room_storage(snapshot, room_id, draft_key = "") {
  if (!snapshot) return null;
  const rooms = snapshot.rooms || [];
  if (room_id) {
    const by_id = rooms.find((item) => item.room_id === room_id);
    if (by_id) return by_id;
  }
  if (draft_key) {
    const by_key = rooms.find((item) => item.key === draft_key);
    if (by_key) return by_key;
  }
  return null;
}

/** Clamped ratio in [0, 1] for progress bars. */
export function storage_ratio(used, limit) {
  if (!limit || limit <= 0) return 0;
  return Math.max(0, Math.min(1, (Number(used) || 0) / limit));
}

/** Visual tone for a storage meter: `error` (>100%), `warning` (>=80%), or `normal`. */
export function storage_tone(used, limit, warn_ratio = 0.8) {
  if (!limit || limit <= 0) return "normal";
  const ratio = (Number(used) || 0) / limit;
  if (ratio > 1) return "error";
  if (ratio >= warn_ratio) return "warning";
  return "normal";
}

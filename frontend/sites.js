/**
 * Websites published from rooms (`<site>.bimcanvas.com`): what the computer has recorded for each room, and the deploy
 * dialog shared by every answer card. Reads go to the room website (`/api/rooms/<room>/sites`, `/api/sites`); deploying,
 * renewing, rolling back and revoking are the runner's local commands (`site-*`), so a paired device reaches them
 * through the relay the same way.
 */
import { reactive } from "vue";

export const sites_state = reactive({
  /** room id -> { sites, stages, read_for }: `read_for` is the newest message id the read covers. */
  rooms: {},
  /** Every published site across rooms, for the "published" list; null until read. */
  all: null,
  /**
   * The deploy dialog: { phase: "checking" | "confirm" | "publishing" | "done" | "error", room_id, message_id,
   * execution_id, member, source, stage, site, error, files, exclude }.
   */
  dialog: null,
});

// Reads in flight by room, and the newest message each must cover: the answers of a room mount together and ask once.
const reading = new Map();
const wanted = new Map();
const access_token = (room_id) => localStorage.getItem(`discuss-access:${room_id}`) || "";

/** Read a room's sites and staged directories again when `message_id` is newer than the last read covered. */
export function load_room_sites(bridge, room_id, message_id = 0) {
  const known = sites_state.rooms[room_id];
  if (known && known.read_for >= message_id) return Promise.resolve(known);
  wanted.set(room_id, Math.max(message_id, wanted.get(room_id) || 0));
  if (reading.has(room_id)) return reading.get(room_id);
  const promise = bridge.request(`/api/rooms/${encodeURIComponent(room_id)}/sites`)
    .then((result) => { sites_state.rooms[room_id] = { sites: result.sites || [], stages: result.stages || [], read_for: wanted.get(room_id) || 0 }; return sites_state.rooms[room_id]; })
    // Not asked again for the same messages: a site that cannot answer (a share page, an older computer) stays quiet.
    .catch(() => (sites_state.rooms[room_id] = { sites: known?.sites || [], stages: known?.stages || [], read_for: wanted.get(room_id) || 0 }))
    .finally(() => { reading.delete(room_id); wanted.delete(room_id); });
  reading.set(room_id, promise);
  return promise;
}

/** Read every published site, for the "published" list. */
export async function load_all_sites(bridge) {
  try { sites_state.all = (await bridge.request("/api/sites")).sites || []; } catch { /* Keep what was shown. */ }
  return sites_state.all;
}

async function refresh(bridge, room_id) {
  if (room_id && sites_state.rooms[room_id]) sites_state.rooms[room_id].read_for = -1;
  await Promise.all([room_id ? load_room_sites(bridge, room_id) : null, sites_state.all ? load_all_sites(bridge) : null]);
}

/** Run one local site command for a room and read its sites again afterwards. */
export async function site_command(bridge, action, room_id, payload) {
  try { return await bridge.local_request(`site-${action}`, { ...payload, room_id, token: access_token(room_id) }); }
  finally { await refresh(bridge, room_id); }
}

/**
 * Open the deploy dialog for a project file (`{ path, root }`) the answer delivered, or for a directory a member staged
 * (`stage`). A file is checked first (`site-stage`), so the owner sees what goes public before confirming.
 */
export async function open_deploy(bridge, { room_id, message_id, execution_id, member = "", file = null, stage = null }) {
  sites_state.dialog = { phase: stage ? "confirm" : "checking", room_id, message_id, execution_id, member, stage, site: null, error: "", files: [], exclude: [] };
  if (stage) return;
  const dialog = sites_state.dialog;
  try {
    // A preview: it stays on this computer, so only a confirmed deploy leaves a card under the answer.
    dialog.stage = await site_command(bridge, "stage", room_id, { path: file.path, root: file.root, message_id, execution_id, member, preview: true });
    dialog.phase = "confirm";
  } catch (error) { Object.assign(dialog, { phase: "error", error: error.message, files: error.files || [] }); }
}

/** Publish what the dialog shows; `ignore_spots` sends files the scan flagged as they are. */
export async function confirm_deploy(bridge, { ignore_spots = false } = {}) {
  const dialog = sites_state.dialog;
  if (!dialog?.stage) return;
  const flagged = dialog.stage.spots?.length && !ignore_spots ? [...new Set(dialog.stage.spots.map((spot) => spot.path))] : [];
  dialog.phase = "publishing";
  try {
    dialog.site = await site_command(bridge, "publish", dialog.room_id, { stage_id: dialog.stage.stage_id, message_id: dialog.message_id, execution_id: dialog.execution_id,
      member: dialog.member, ...(dialog.stage.site_id ? { site_id: dialog.stage.site_id } : {}), ...(flagged.length ? { exclude: flagged } : { ignore_spots: Boolean(dialog.stage.spots?.length) }) });
    dialog.phase = "done";
  } catch (error) { Object.assign(dialog, { phase: "error", error: error.message, files: error.files || error.spots || [] }); }
}

export const close_deploy = () => { sites_state.dialog = null; };

/**
 * One list of the file page's transfers, shared by its project and cloud space views: uploads to the cloud drive (each
 * file of an uploaded folder too), large uploads into a project, download preparation, landing in a project, and copies
 * to the cloud space. Each row has a name, kind, progress and state; a running one can be cancelled, a failed one tried
 * again, a finished one cleared.
 *
 * A task the computer or the site runs in the background (`task_id`) is remembered in this browser by its ID and name
 * only, and followed again after a reload. A transfer this page makes itself cannot outlive it: after a reload its row
 * says it was interrupted, and leaving the page while one runs asks first.
 */
import { reactive } from "vue";

const STORE_KEY = "codiscuss-transfers";
// Uploads the page makes itself run three at a time; a failed one is tried twice more before it is left failed.
const PARALLEL = 3, RETRIES = 2;
const RETRY_DELAY_MS = 1500;

export const transfers = reactive({ rows: [] });
let serial = 0;
const waiting = [];
let running = 0;

/** The rows still going (queued or running), for the file tab's count. */
export function active_transfers() {
  return transfers.rows.filter((row) => row.status === "queued" || row.status === "running").length;
}

function row_of(id) { return transfers.rows.find((row) => row.id === id); }

function remember() {
  try {
    // Only IDs and names: never links or credentials. `source` says which site route follows a site-run task.
    const kept = transfers.rows.filter((row) => row.status === "queued" || row.status === "running")
      .map(({ name, kind, task_id, source }) => ({ name, kind, ...(task_id ? { task_id } : {}), ...(source ? { source } : {}) }));
    localStorage.setItem(STORE_KEY, JSON.stringify(kept));
  } catch { /* Storage may be disabled; the list still works for this page. */ }
}

function set(id, patch) {
  const row = row_of(id);
  if (!row) return;
  Object.assign(row, patch);
  if ("status" in patch || "task_id" in patch) remember();
}

/** Start the next queued page-made upload while fewer than three run. */
function pump() {
  while (running < PARALLEL && waiting.length) {
    const job = waiting.shift();
    if (row_of(job.id)?.status !== "queued") continue;
    running += 1;
    execute(job).finally(() => { running -= 1; pump(); });
  }
}

async function execute(job) {
  for (let attempt = 0; ; attempt += 1) {
    const stop = new AbortController();
    set(job.id, { status: "running", error: "", progress: 0, cancel: job.cancellable ? () => stop.abort() : null });
    try {
      const result = await job.run({ signal: stop.signal, progress: (share) => set(job.id, { progress: Math.max(0, Math.min(1, share)) }),
        // Once the browser's part is over, what runs on the computer is followed, not cancelled.
        task: (task_id, source = null) => set(job.id, { task_id, ...(source ? { source } : {}), cancel: null }) });
      set(job.id, { status: "done", progress: 1, cancel: null });
      job.done?.(result, job.id);
      return;
    } catch (failure) {
      if (stop.signal.aborted || failure.cancelled) { set(job.id, { status: "cancelled", cancel: null }); job.failed?.(failure, true, job.id); return; }
      if (attempt < job.retries) { await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS)); continue; }
      set(job.id, { status: "failed", error: failure.message, cancel: null, retry: () => { set(job.id, { status: "queued", retry: null }); queue(job); } });
      job.failed?.(failure, false, job.id);
      return;
    }
  }
}

function queue(job) {
  if (job.parallel) { waiting.push(job); pump(); }
  else execute(job);
}

/**
 * Add a transfer and start it.
 *
 * Args:
 *   name: what the row shows. kind: "drive" (upload to the cloud drive), "project" (large upload into a project),
 *     "prepare" (download preparation), "land" (into a project), "copy" (to the cloud space).
 *   run: async ({ signal, progress(share), task(task_id) }) => result; `task` records a background task to follow
 *     after a reload. options: { parallel (three at a time with automatic retries), retries, browser (made by this
 *     page, so it cannot survive a reload), cancellable (defaults to `browser`), done(result, id),
 *     failed(error, cancelled, id) }. A failed one is left on the list to be tried again; `retry` runs `run` anew.
 * Returns:
 *   The row's ID.
 */
export function add_transfer(name, kind, run, { parallel = false, retries = parallel ? RETRIES : 0, browser = false, cancellable = browser, done, failed } = {}) {
  const id = `transfer-${Date.now()}-${++serial}`;
  transfers.rows.unshift({ id, name, kind, progress: 0, status: "queued", error: "", browser, task_id: "", cancel: null, retry: null });
  remember();
  queue({ id, run, parallel, retries, cancellable, done, failed });
  return id;
}

/** `add_transfer` as a promise: resolves `{ ok, result, error, cancelled, id }` once the transfer is over either way. */
export function transfer(name, kind, run, options = {}) {
  return new Promise((resolve) => {
    add_transfer(name, kind, run, { ...options, done: (result, id) => resolve({ ok: true, result, id }),
      failed: (error, cancelled, id) => resolve({ ok: false, error, cancelled, id }) });
  });
}

/**
 * Do `work` for each item one after another; one failing does not stop or undo the others.
 * Returns the failures as `[{ item, error }]`; `progress` is told the share done after each item.
 */
export async function run_each(items, work, progress = () => {}) {
  const failed = [];
  for (const [index, item] of items.entries()) {
    try { await work(item); } catch (error) { failed.push({ item, error }); }
    progress((index + 1) / items.length);
  }
  return failed;
}

/** Clear finished, cancelled and interrupted rows (failed ones stay until tried again or cleared one by one). */
export function clear_finished() {
  transfers.rows = transfers.rows.filter((row) => row.status === "queued" || row.status === "running" || row.status === "failed");
  remember();
}

export function clear_transfer(id) {
  transfers.rows = transfers.rows.filter((row) => row.id !== id);
  remember();
}

const FOLLOW_POLL_MS = 1000, FOLLOW_LIMIT_MS = 2 * 60 * 60 * 1000;

/**
 * Follow one remembered background task until it is done: a copy the site runs for an attachment is read at that
 * attachment's `cloud-copy` route; any other is a task of the computer, read with `project_cloud_status`.
 */
export async function follow_saved(bridge, item, progress = () => {}) {
  const started = Date.now();
  const copy = item.source?.attachment_id && item.source?.room_id;
  const route = copy ? `/api/rooms/${encodeURIComponent(item.source.room_id)}/attachments/${encodeURIComponent(item.source.attachment_id)}/cloud-copy` : "";
  for (;;) {
    const state = copy ? await bridge.request(route) : await bridge.project_cloud_status(item.task_id);
    if (state.status === "failed") throw new Error(state.error || "failed");
    if (state.status === "completed" || state.kind === "cloud_file") return state;
    progress(Math.min(0.99, Number(state.progress) || 0));
    if (Date.now() - started > FOLLOW_LIMIT_MS) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
  }
}

let resumed = false;
/**
 * After a reload: follow again the background tasks this browser remembered (`follow(item, progress)`, by default
 * `follow_saved` with `bridge`), and mark the page-made transfers that were going as interrupted. Called once, when the
 * workspace opens, so the file tab's count is right before the file page is opened.
 */
export function resume_transfers(bridge, follow = (item, progress) => follow_saved(bridge, item, progress)) {
  if (resumed) return;
  resumed = true;
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); } catch { saved = []; }
  for (const item of Array.isArray(saved) ? saved : []) {
    if (typeof item?.name !== "string") continue;
    if (!item.task_id) {
      transfers.rows.push({ id: `transfer-${Date.now()}-${++serial}`, name: item.name, kind: item.kind, progress: 0, status: "interrupted", error: "", browser: true });
      continue;
    }
    add_transfer(item.name, item.kind, async ({ progress, task }) => { task(item.task_id, item.source || null); return follow(item, progress); });
  }
  remember();
}

/** Whether a transfer this page makes itself is going, which leaving the page would end. */
export function page_transfers_running() {
  return transfers.rows.some((row) => row.browser && (row.status === "queued" || row.status === "running"));
}

/**
 * Take a transfer handed over by the page's classic script (web/app.js, which cannot import this module): the event's
 * detail is `{ name, kind, run, done, failed }` as for `add_transfer`; it is marked `accepted` so the script does not
 * run it itself as well.
 */
export function take_transfer(event) {
  const detail = event?.detail;
  if (!detail || typeof detail.run !== "function" || typeof detail.name !== "string") return;
  detail.accepted = true;
  add_transfer(detail.name, detail.kind || "copy", detail.run, { done: detail.done, failed: detail.failed });
}

if (typeof document !== "undefined") document.addEventListener("discuss:transfer", take_transfer);

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    if (!page_transfers_running()) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

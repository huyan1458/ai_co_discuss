/**
 * One external user's visit on the guest page: reading the invitation from the address, redeeming it, the countdown on
 * the computer's clock and the end. Every request goes through guest-relay.js; once the visit ends (expiry, a refusal
 * saying it ended, or the local timer) the session key is dropped and late answers are ignored (API.md §4).
 */
import { computed, ref, shallowRef } from "vue";
import { clearGuest, guestRequest, redeemGuest, restoreGuest } from "../guest-relay.js";

/** The invitation in the URL fragment (base64url UTF-8 JSON, API.md §4), or null when absent or unreadable. */
export function read_invitation(hash = location.hash) {
  const encoded = hash.replace(/^#/, "");
  if (!encoded) return null;
  try {
    const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
    const invite = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
    return invite?.v === 1 && invite.room && invite.invite_id && invite.code ? invite : false;
  } catch { return false; }
}

// Failures that mean the computer or the site could not be reached this time: retried, the countdown keeps going.
const TRANSIENT = new Set(["timeout", "offline", "pending", "site_refused", "machine_offline"]);
export const is_transient = (error) => !error?.code || TRANSIENT.has(error.code) || error.name === "TimeoutError" || error.name === "TypeError" || error.status >= 500;

/**
 * The visit's state: `phase` is entry → waiting → active → ended; `left_ms` ticks on a monotonic clock anchored to the
 * computer's `server_time`, so changing this device's clock moves nothing.
 */
export function create_visit(invite) {
  // Without an invitation in the address the page first tries to restore this tab's visit (a reload), else it is invalid.
  const phase = ref(invite ? "entry" : "restoring");
  const info = shallowRef(null);
  const end_reason = ref("");
  const offline = ref(false);
  const tick = ref(performance.now());
  let session = null, anchor = { server: Date.now(), local: performance.now() }, timer = 0, end_timer = 0, invite_deadline = 0;
  const server_now = () => anchor.server + (performance.now() - anchor.local);
  const left_ms = computed(() => { tick.value; return info.value?.guest?.expires_at ? info.value.guest.expires_at - server_now() : 0; });

  function accept(data) {
    if (phase.value === "ended" || !data) return;
    if (data.server_time) anchor = { server: data.server_time, local: performance.now() };
    info.value = data;
    clearTimeout(end_timer);
    if (data.phase === "active") {
      phase.value = "active";
      // The page ends itself at the deadline even without the network.
      end_timer = setTimeout(() => end("expired"), Math.max(0, data.guest.expires_at - server_now()));
    } else {
      phase.value = "waiting";
      // Waiting to enter is bounded by the invitation's deadline, which the computer also enforces; offline or not, the
      // page ends there and drops its key.
      if (invite_deadline) end_timer = setTimeout(() => end("invite_expired"), Math.max(0, invite_deadline - server_now()));
    }
  }
  /** Wipe the visit: keys, data and timers; the page shows only the end card from here on. */
  function end(reason) {
    if (phase.value === "ended") return;
    phase.value = "ended";
    end_reason.value = reason || "ended";
    // The kept key and session token go too; a failure here is swept the next time a guest page opens.
    if (session) clearGuest(session).catch(() => {});
    session = null;
    info.value = null;
    clearTimeout(end_timer);
    clearInterval(timer);
  }
  function open(result) {
    session = result.session;
    invite_deadline = result.invite_expires_at || 0;
    accept(result.data);
    timer = setInterval(() => { tick.value = performance.now(); }, 1000);
  }
  async function enter(label) {
    open(await redeemGuest(invite, label));
  }
  /**
   * After a reload: reopen this tab's kept visit and confirm it with the computer at once. A visit that ended while the
   * page was away (expired, disconnected) shows the end card and its key is deleted (guest-relay.js).
   */
  async function restore() {
    let result = null;
    try { result = await restoreGuest(); }
    catch (error) {
      phase.value = error.code === "guest_ended" ? "ended" : "invalid";
      end_reason.value = error.reason || "ended";
      return;
    }
    if (!result) { phase.value = "invalid"; return; }
    open(result);
    await refresh();
  }
  /** One guest route; a refusal saying the visit ended ends it, an unreachable computer only marks the page offline. */
  async function request(method, path, options) {
    if (!session) throw Object.assign(new Error("guest_ended"), { code: "guest_ended" });
    try {
      const data = await guestRequest(session, method, path, options);
      offline.value = false;
      return data;
    } catch (error) {
      if (error.code === "guest_ended") end(error.reason || "ended");
      else if (is_transient(error)) offline.value = true;
      throw error;
    }
  }
  /** Read the session again: waiting turns to active, a longer stay moves the deadline. */
  async function refresh() {
    try { accept(await request("GET", "/session")); } catch { /* request() already marked the page. */ }
  }
  return { phase, info, end_reason, offline, left_ms, enter, restore, request, refresh, end, ended: () => phase.value === "ended" };
}

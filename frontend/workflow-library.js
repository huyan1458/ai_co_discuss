/**
 * The workflow library's shared state: the sidebar's 工作流 list and the workflow page in the middle work on the same
 * workflow, so the selection, the unsaved draft and the confirmations live here, one copy per page.
 * Workflows are keyed by `(scope, project_id, id)` so project workflows and global workflows with the same ID never collide.
 */
import { computed, effectScope, inject, nextTick, ref, watch } from "vue";
import { download_file, workflow_files_from_folder, workflow_files_from_zip, zip_store } from "./workflow-files.js";
import { flow_in_use } from "../runner/workflow_flow.mjs";
import { t } from "./i18n.js";

const COMMANDS_FILE = "commands.json";
const SKILL_OPEN_KEY = "codiscuss.workflow_skill_open";
const STACKED_QUERY = "(max-width: 760px), (pointer: coarse) and (orientation: portrait)";
const NEW_SKILL = "写下主持人怎么组织这个工作流：每一步找哪位成员、交回什么、怎么验收。";
const NEW_SUB_SKILL = "写下主线之外什么时候用这个子工作流，以及主持人怎么组织它：每一步找哪位成员、交回什么、怎么验收。";
const MAX_SUB_WORKFLOWS = 10;
let library = null;

/** Composite key identifying a workflow across global and project scopes. */
export function workflow_key(item) {
  if (!item) return "";
  if (typeof item === "string") return item.startsWith("global:") || item.startsWith("project:") ? item : `global:${item}`;
  return item.scope === "project" ? `project:${item.project_id || ""}:${item.id}` : `global:${item.id}`;
}

/** Parse a composite workflow key back into `{ scope, project_id, id }`. */
function parse_key(key) {
  if (!key) return null;
  if (typeof key === "object") return { scope: key.scope || "global", project_id: key.project_id || "", id: key.id || "" };
  if (key.startsWith("project:")) {
    const [, project_id = "", ...rest] = key.split(":");
    return { scope: "project", project_id, id: rest.join(":") };
  }
  if (key.startsWith("global:")) return { scope: "global", project_id: "", id: key.slice("global:".length) };
  return { scope: "global", project_id: "", id: key };
}

/**
 * Why a listed workflow cannot be used on this computer now, or "": it cannot be read, or some cards name software
 * this computer has not set up (their members could not join). A paused workflow is the user's choice, not a fault.
 */
export function workflow_problem(item) {
  if (item.error) return t("无法读取：{value1}", { value1: item.error });
  if (!item.unavailable?.length) return "";
  const cards = item.unavailable.map((card) => `${card.label}（${card.platform}）`).join("、");
  return t("本机未配置这些卡片的软件：{value1}。可在工作流页的“专家配置”里换用本机已有的软件", { value1: cards });
}

/**
 * How many members a sub-workflow uses: its own cards and the main flow's cards (`main_agents`) placed on its canvas,
 * each once. The parts list and the sub-workflow's node on the main canvas show the same number.
 */
export function sub_member_count(sub, main_agents) {
  const known = new Set([...main_agents, ...sub.agents].map((agent) => agent.card));
  const placed = (sub.flow?.nodes || []).filter((node) => node.type === "card" && known.has(node.card)).map((node) => node.card);
  return new Set([...sub.agents.map((agent) => agent.card), ...placed]).size;
}

/** The shared library, created on first use with the injected discussion context. */
export function use_workflow_library() {
  if (!library) library = effectScope(true).run(() => create_library(inject("discussion")));
  return library;
}

/**
 * A canvas as saved: only nodes of cards (`agents`) and sub-workflows (`subs`, IDs) that exist, and only edges between
 * kept nodes; one with only its start is none. Its steps (`stages`) keep only kept nodes.
 */
function saved_flow(flow, agents, subs = []) {
  const cards = new Set(agents.map((agent) => agent.card));
  const kept = (node) => node.type === "card" ? cards.has(node.card) : node.type !== "sub" || subs.includes(node.sub);
  const nodes = flow_in_use(flow) ? flow.nodes.filter(kept) : null;
  const ids = new Set((nodes || []).map((node) => node.id));
  const stages = (flow?.stages || []).map((stage) => ({ ...stage, nodes: (stage.nodes || []).filter((id) => ids.has(id)) }));
  return nodes ? { nodes, edges: flow.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)), ...(stages.length ? { stages } : {}) } : null;
}

/**
 * What saving would write, the comparison for unsaved changes too. Sub-workflows are saved whole, each with its canvas;
 * a sub-workflow's canvas may show main-flow members, the main canvas the sub-workflows.
 */
function payload(value) {
  // `revision` and scope metadata travel beside the workflow, not inside its saved payload.
  const {
    resources, commands: ignored, flow, directory, sub_workflows, revision: loaded, author, source,
    scope: _scope, project_id: _pid, project_name: _pname, readonly: _ro, needs_trust: _nt, untrusted_reasons: _ur,
    ...fields
  } = value;
  const meta = { ...(author ? { author } : {}), ...(source ? { source } : {}) };
  return {
    ...fields, ...meta, flow: saved_flow(flow, fields.agents, (sub_workflows || []).map((sub) => sub.id)), resources,
    ...(sub_workflows ? { sub_workflows: sub_workflows.map((sub) => ({ ...sub, flow: saved_flow(sub.flow, [...sub.agents, ...fields.agents]) })) } : {}),
  };
}

function create_library({ view, bridge }) {
  const available = computed(() => view.value.launch.available || view.value.launch.remote);
  const current_room_id = computed(() => view.value.room?.id || "");
  const global_workflows = computed(() => (view.value.launch.workflows || []).map((item) => ({ scope: "global", ...item })));
  const project_workflows = computed(() => (view.value.launch.project_workflows || []).map((item) => ({ scope: "project", ...item })));
  const project_roots = computed(() => view.value.launch.project_roots || []);
  const writable_roots = computed(() => project_roots.value.filter((root) => !root.readonly));
  const workflows = computed(() => [...project_workflows.value, ...global_workflows.value]);

  // Whether the middle shows the workflow page instead of the room.
  const page_open = ref(false);
  // The workflow on the canvas: a saved one (`saved_id`, `saved_scope`, `saved_project_id`) or a new/imported draft.
  const draft = ref(null), saved_id = ref(""), saved_scope = ref("global"), saved_project_id = ref("");
  const draft_scope = ref("global"), draft_project_id = ref("");
  const snapshot = ref(""), canvas_key = ref(0);
  const saved_key = computed(() => saved_id.value ? workflow_key({ scope: saved_scope.value, project_id: saved_project_id.value, id: saved_id.value }) : "");
  const active_scope = computed(() => saved_id.value ? saved_scope.value : draft_scope.value);
  const active_project_id = computed(() => saved_id.value ? saved_project_id.value : draft_project_id.value);
  const active_item = computed(() => saved_key.value ? workflows.value.find((item) => workflow_key(item) === saved_key.value) || null : null);
  const draft_readonly = computed(() => Boolean(saved_id.value && (draft.value?.readonly || active_item.value?.readonly)));
  const active_project_name = computed(() => {
    if (active_scope.value !== "project") return "";
    return draft.value?.project_name || active_item.value?.project_name
      || project_roots.value.find((root) => root.id === active_project_id.value)?.name || "";
  });

  // Which canvas of the workflow is shown: "" for its main flow, else a sub-workflow's ID; all of them save together.
  const scope = ref("");
  const subs = computed(() => draft.value?.sub_workflows || []);
  const current = computed(() => (scope.value && subs.value.find((sub) => sub.id === scope.value)) || draft.value);
  // Card IDs are unique across the whole workflow, so each canvas avoids the others' when adding a card.
  const reserved = computed(() => !draft.value ? [] : [draft.value, ...subs.value].filter((part) => part !== current.value)
    .flatMap((part) => part.agents.map((agent) => agent.card)));
  const commands_allowed = ref(false), busy = ref(false);
  const loading = ref(""), failure = ref("");
  const pending_items = ref(new Set());
  let read_version = 0, retry_read = null;
  // Workflows as last read, keyed by composite key: switching shows the copy at once and checks it afterwards.
  const read_cache = new Map();
  // The workflow whose deletion awaits confirmation (its composite key), and the action waiting on "放弃未保存的修改？".
  const deleting = ref(""), leaving = ref(null);
  // Why the open workflow cannot simply be saved: "changed" or "exists".
  const conflict = ref("");
  const deleting_label = computed(() => workflows.value.find((item) => workflow_key(item) === deleting.value)?.label || parse_key(deleting.value)?.id || deleting.value);
  const renaming = ref(""), rename_text = ref("");
  // The hidden file inputs, registered by the workspace that renders them; `skill_request` asks the page to show SKILL.md.
  const inputs = { zip: null, folder: null };
  const skill_request = ref(0);
  // Whether the docked SKILL.md side panel is open (remembered in this browser) and whether the viewport stacks canvas/SKILL.md.
  let saved_skill_open = true;
  try { saved_skill_open = localStorage.getItem(SKILL_OPEN_KEY) !== "0"; } catch { /* storage blocked */ }
  const skill_open = ref(saved_skill_open);
  const stacked_media = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(STACKED_QUERY) : null;
  const stacked = ref(Boolean(stacked_media?.matches));
  stacked_media?.addEventListener("change", (event) => { stacked.value = event.matches; });
  function set_skill_open(open) {
    skill_open.value = Boolean(open);
    try { localStorage.setItem(SKILL_OPEN_KEY, skill_open.value ? "1" : "0"); } catch { /* storage blocked */ }
  }
  // While a freshly mounted canvas fills itself in, nothing counts as unsaved.
  const settling = ref(false);
  const dirty = computed(() => Boolean(draft.value) && !draft_readonly.value && !(saved_id.value && settling.value)
    && (!saved_id.value || JSON.stringify(payload(draft.value)) !== snapshot.value));

  /** Build the scope query/body parameters for a workflow item or composite key. */
  function scope_params(item) {
    const parsed = parse_key(item);
    const wf_scope = parsed?.scope || "global";
    return {
      scope: wf_scope,
      ...(wf_scope === "project" && parsed.project_id ? { project_id: parsed.project_id } : {}),
      ...(current_room_id.value ? { room_id: current_room_id.value } : {}),
    };
  }

  /** Choose where an unsaved draft will be written when saved. */
  function set_draft_target(target_scope, target_project_id = "") {
    if (saved_id.value) return;
    if (target_scope === "project") {
      const root = writable_roots.value.find((item) => item.id === target_project_id) || writable_roots.value[0];
      if (!root) {
        draft_scope.value = "global";
        draft_project_id.value = "";
        return;
      }
      draft_scope.value = "project";
      draft_project_id.value = root.id;
    } else {
      draft_scope.value = "global";
      draft_project_id.value = "";
    }
    conflict.value = "";
  }

  /** Take the comparison for unsaved changes once the canvas just mounted has filled itself in. */
  function settle() {
    const shown = draft.value;
    settling.value = true;
    setTimeout(() => { if (draft.value === shown) snapshot.value = JSON.stringify(payload(shown)); settling.value = false; }, 0);
  }

  /** Put a workflow on the canvas. */
  function show(value, meta = null) {
    conflict.value = "";
    draft.value = { ...value, sub_workflows: value.sub_workflows || [] };
    if (meta && meta.id) {
      saved_id.value = meta.id;
      saved_scope.value = meta.scope || value.scope || "global";
      saved_project_id.value = saved_scope.value === "project" ? (meta.project_id || value.project_id || "") : "";
    } else {
      saved_id.value = "";
      saved_scope.value = "global";
      saved_project_id.value = "";
    }
    // Saving keeps the sub-workflow in view; another workflow starts at its main flow.
    if (!draft.value.sub_workflows.some((sub) => sub.id === scope.value)) scope.value = "";
    commands_allowed.value = false;
    canvas_key.value++;
    // The canvas fills in a start node on mount, so the comparison is taken once it did.
    settle();
  }

  /** A new or imported workflow, not yet saved, shown on the page. */
  function edit_draft(value, target = null) {
    read_version++;
    loading.value = "";
    failure.value = "";
    if (target) set_draft_target(target.scope, target.project_id);
    else if (writable_roots.value.length) set_draft_target("project", writable_roots.value[0].id);
    else set_draft_target("global", "");
    show({ agents: [], ...JSON.parse(JSON.stringify(value)), id: value.id || `workflow-${Date.now().toString(36)}` }, null);
    page_open.value = true;
    if (value.commands?.length) skill_request.value++;
  }

  /** Read a saved workflow from the local service and remember it under its composite key. */
  async function read_saved(item) {
    const parsed = parse_key(item);
    const key = workflow_key(parsed);
    const value = await bridge.local_request("workflows", { action: "get", id: parsed.id, ...scope_params(parsed) });
    const normalized = { scope: parsed.scope, ...(parsed.project_id ? { project_id: parsed.project_id } : {}), ...value };
    read_cache.set(key, JSON.stringify(normalized));
    return normalized;
  }

  /** Open a saved workflow (a copy read before shows at once, then is checked); a broken one shows its error instead. */
  async function open_saved(target) {
    const parsed = parse_key(target);
    const key = parsed?.id ? workflow_key(parsed) : "";
    const version = ++read_version;
    const cached = key && read_cache.get(key);
    failure.value = "";
    loading.value = "";
    if (cached) show(JSON.parse(cached), parsed);
    else {
      draft.value = null;
      saved_id.value = parsed?.id || "";
      saved_scope.value = parsed?.scope || "global";
      saved_project_id.value = parsed?.scope === "project" ? (parsed.project_id || "") : "";
    }
    if (!parsed?.id || workflows.value.find((item) => workflow_key(item) === key)?.error) { draft.value = null; return; }
    if (!cached) loading.value = t("正在读取工作流…");
    retry_read = () => open_saved(parsed);
    try {
      const value = await read_saved(parsed);
      if (version !== read_version) return;
      // A copy that changed on disk meanwhile is replaced, unless the user already started editing it: then they are told.
      if (!cached || (read_cache.get(key) !== cached && !dirty.value)) show(value, parsed);
      else if (read_cache.get(key) !== cached && draft.value?.revision !== value.revision) conflict.value = "changed";
    } catch (error) { if (version === read_version && !cached) failure.value = error.message; }
    finally { if (version === read_version) loading.value = ""; }
  }

  /** Read the library's other workflows in the background, so switching to them shows at once. */
  function prefetch(list) {
    for (const item of list) {
      const key = workflow_key(item);
      if (!item.error && !read_cache.has(key)) read_saved(item).catch(() => {});
    }
  }

  /** Run an action that replaces the canvas or leaves the page, asking first when it holds unsaved changes. */
  function guard(action) {
    if (dirty.value) leaving.value = action;
    else action();
  }

  function discard() {
    const action = leaving.value;
    leaving.value = null;
    action?.();
  }

  /** Show a workflow from the sidebar on the page. Accepts a workflow summary item or composite key. */
  function select(item) {
    const parsed = parse_key(item);
    if (!parsed?.id) return;
    const key = workflow_key(parsed);
    if (page_open.value && saved_key.value === key && draft.value) return;
    if (saved_key.value === key && draft.value) { page_open.value = true; return; }
    // The choice is taken before the page opens, so opening it does not also load the first workflow in the list.
    guard(() => {
      saved_id.value = parsed.id;
      saved_scope.value = parsed.scope;
      saved_project_id.value = parsed.scope === "project" ? parsed.project_id : "";
      page_open.value = true;
      open_saved(parsed);
    });
  }

  /** Leave the page for the room, asking first about unsaved changes; `then` runs once it is left. */
  function close_page(then) {
    if (!page_open.value) { then?.(); return; }
    guard(() => {
      page_open.value = false;
      read_version++;
      loading.value = "";
      // A draft that was dropped does not linger: the next visit reopens the saved workflow.
      if (!saved_id.value) draft.value = null;
      else if (dirty.value) open_saved({ id: saved_id.value, scope: saved_scope.value, project_id: saved_project_id.value });
      then?.();
    });
  }

  const REFRESH_COOLDOWN_MS = 3000;
  let last_reloaded_at = 0;
  let refreshing = null;
  /** Quietly refresh the library from disk after CLI/AI saves without polling while idle. */
  function refresh_list({ force = false } = {}) {
    if (!available.value) return Promise.resolve();
    const now = Date.now();
    if (refreshing || (!force && now - last_reloaded_at < REFRESH_COOLDOWN_MS)) return refreshing || Promise.resolve();
    last_reloaded_at = now;
    refreshing = bridge.reload_workflows().catch(() => {}).finally(() => { refreshing = null; });
    return refreshing;
  }

  // Keep a valid selection when the library changes, and open the first workflow when the page opens empty.
  watch([workflows, page_open], ([list, open]) => {
    if (saved_key.value && !list.some((item) => workflow_key(item) === saved_key.value)) open_saved(open ? list[0] || "" : "");
    else if (open && !draft.value && !loading.value && !failure.value && list.length) open_saved(saved_key.value || list[0]);
    if (open) prefetch(list);
  });
  // If an unsaved draft targets a project root that is no longer in the current room, fall back cleanly.
  watch(writable_roots, (roots) => {
    if (!saved_id.value && draft_scope.value === "project" && !roots.some((root) => root.id === draft_project_id.value)) {
      set_draft_target(roots.length ? "project" : "global", roots[0]?.id || "");
    }
  });
  watch(available, (value) => { if (value) refresh_list({ force: true }); }, { immediate: true });
  watch(page_open, (open) => { if (open) refresh_list(); });
  // Reload workflows whenever the open room or its project directories change.
  watch(() => [current_room_id.value, view.value.launch.room_models?.project_directory || "",
    JSON.stringify(view.value.launch.room_models?.extra_directories || [])],
  (now, before) => { if (available.value && before !== undefined && JSON.stringify(now) !== JSON.stringify(before)) refresh_list({ force: true }); });
  // Software set up or a key saved may make a workflow's cards usable (or not), so the list's health is read again.
  watch(() => JSON.stringify([Object.keys(view.value.launch.saved_profiles || {}), Object.keys(view.value.launch.api_keys || {})]),
    (now, before) => { if (available.value && before !== undefined) refresh_list({ force: true }); });
  // An AI member may have saved a workflow via CLI during a run; reload once the run completes.
  watch(() => (view.value.room?.free?.executions || []).filter((item) => item.status === "completed").map((item) => item.id).join(","),
    (now, before) => { if (available.value && before !== undefined && now !== before) refresh_list(); });
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refresh_list();
    });
  }

  /** Start a blank draft targeting either a writable project root or global. */
  function create_blank(target = null) {
    guard(() => edit_draft({ label: t("未命名工作流"), description: "", skill: NEW_SKILL, agents: [] }, target));
  }

  // Track target scope when importing via the "+" menu.
  let pending_import_target = null;
  function trigger_import(kind, target = null) {
    pending_import_target = target;
    guard(() => inputs[kind]?.click());
  }

  const add_items = computed(() => {
    const roots = writable_roots.value;
    if (!roots.length) {
      return [[
        { label: t("新建"), icon: "i-lucide-plus", onSelect: () => create_blank({ scope: "global" }) },
        { label: t("导入 zip"), icon: "i-lucide-file-archive", onSelect: () => trigger_import("zip", { scope: "global" }) },
        { label: t("导入文件夹"), icon: "i-lucide-folder-input", onSelect: () => trigger_import("folder", { scope: "global" }) },
      ]];
    }
    const create_group = roots.length === 1
      ? [
        { label: t("新建到当前项目（{name}）", { name: roots[0].name }), icon: "i-lucide-folder-plus", onSelect: () => create_blank({ scope: "project", project_id: roots[0].id }) },
        { label: t("新建全局工作流"), icon: "i-lucide-globe", onSelect: () => create_blank({ scope: "global" }) },
      ]
      : [
        ...roots.map((root) => ({ label: t("新建到项目「{name}」", { name: root.name }), icon: "i-lucide-folder-plus", onSelect: () => create_blank({ scope: "project", project_id: root.id }) })),
        { label: t("新建全局工作流"), icon: "i-lucide-globe", onSelect: () => create_blank({ scope: "global" }) },
      ];
    return [
      create_group,
      [
        { label: t("导入 zip"), icon: "i-lucide-file-archive", onSelect: () => trigger_import("zip", { scope: "project", project_id: roots[0].id }) },
        { label: t("导入文件夹"), icon: "i-lucide-folder-input", onSelect: () => trigger_import("folder", { scope: "project", project_id: roots[0].id }) },
      ],
    ];
  });

  /** Read the opened files, let the local service check them, and put the result on the canvas; nothing is saved yet. */
  async function import_files(read) {
    const target = pending_import_target;
    pending_import_target = null;
    const version = ++read_version;
    draft.value = null;
    saved_id.value = "";
    saved_scope.value = "global";
    saved_project_id.value = "";
    loading.value = t("正在导入工作流…");
    failure.value = "";
    retry_read = () => import_files(read);
    page_open.value = true;
    try {
      const value = await bridge.local_request("workflows", { action: "preview", files: await read() });
      if (version !== read_version) return;
      if (value.ignored?.length) bridge.notify("warning", t("已忽略不支持的文件：{value1}", { value1: value.ignored.join("、") }));
      edit_draft(value, target);
    } catch (error) { if (version === read_version) failure.value = error.message; }
    finally { if (version === read_version) loading.value = ""; }
  }

  function on_zip(event) {
    const [file] = event.target.files || [];
    event.target.value = "";
    if (file) import_files(() => workflow_files_from_zip(file));
  }

  function on_folder(event) {
    const files = [...event.target.files || []];
    event.target.value = "";
    if (files.length) import_files(() => workflow_files_from_folder(files));
  }

  /** Show the main flow (`""`) or a sub-workflow; its canvas mounts afresh, fitted to view. */
  function open_scope(id) {
    if (scope.value === id) return;
    const clean = !dirty.value;
    scope.value = id;
    canvas_key.value++;
    // Like opening a workflow, laying out a canvas on mount is no edit: an untouched workflow stays saved.
    if (clean) settle();
  }

  /** Show a sub-workflow from its node on the main canvas; a new one opens at its SKILL.md. */
  function enter_sub(id, fresh) {
    open_scope(id);
    if (fresh) skill_request.value++;
  }

  /**
   * Add an empty sub-workflow to the open workflow, written with the next save, and return its ID (none past the limit).
   * It is shown at once unless `open` is false (the main canvas places its node first, then enters it).
   */
  function add_sub(open = true) {
    if (subs.value.length >= MAX_SUB_WORKFLOWS) { bridge.notify("warning", t("子工作流最多 {value1} 个", { value1: MAX_SUB_WORKFLOWS })); return ""; }
    const taken = new Set(subs.value.map((sub) => sub.id));
    let number = subs.value.length + 1;
    while (taken.has(`part-${number}`)) number++;
    draft.value.sub_workflows = [...subs.value, { id: `part-${number}`, label: t("子工作流 {value1}", { value1: number }), description: "", skill: NEW_SUB_SKILL, agents: [], flow: null }];
    if (open) enter_sub(`part-${number}`, true);
    return `part-${number}`;
  }

  /** Remove a sub-workflow (its folder, scripts included, goes with the next save); the page returns to the main flow. */
  function remove_sub(id) {
    draft.value.sub_workflows = subs.value.filter((sub) => sub.id !== id);
    if (scope.value === id) open_scope("");
  }

  /**
   * Save the workflow as files; the local service checks every field. A saved one keeps its folder's other files and names
   * the revision it was loaded at, so a library changed since refuses it; `overwrite` replaces an entry the user chose to.
   */
  async function save({ overwrite = false } = {}) {
    if (busy.value || !draft.value) return;
    if (draft_readonly.value) { bridge.notify("warning", t("只读项目目录中的工作流不能修改")); return; }
    if (!draft.value.label.trim() || !draft.value.skill.trim()) { open_scope(""); skill_request.value++; bridge.notify("warning", t("请填写名称和 SKILL.md 正文")); return; }
    const unfinished = subs.value.find((sub) => !sub.label.trim() || !sub.description.trim() || !sub.skill.trim());
    if (unfinished) { open_scope(unfinished.id); skill_request.value++; bridge.notify("warning", t("请填写子工作流的名称、一句话描述和 SKILL.md 正文")); return; }
    const { resources, ...edited } = payload(draft.value);
    // An import keeps its commands file only when the user allowed it; the rest of its files come along either way.
    const kept = resources && !commands_allowed.value ? Object.fromEntries(Object.entries(resources).filter(([path]) => path !== COMMANDS_FILE)) : resources;
    const saving = draft.value, saved_snapshot = JSON.stringify(payload(saving));
    const target_scope = active_scope.value;
    const target_project_id = target_scope === "project" ? active_project_id.value : "";
    busy.value = true;
    try {
      const base = saved_id.value && !overwrite ? { base_revision: draft.value.revision } : {};
      const result = await bridge.local_request("workflows", {
        action: "save",
        workflow: saved_id.value ? edited : { ...edited, resources: kept },
        scope: target_scope,
        ...(target_project_id ? { project_id: target_project_id } : {}),
        ...(current_room_id.value ? { room_id: current_room_id.value } : {}),
        ...base,
        ...(overwrite ? { overwrite: true } : {}),
      });
      conflict.value = "";
      bridge.notify("info", t("已保存「{value1}」", { value1: result.label || result.id }));
      const meta = { id: result.id, scope: result.scope || target_scope, project_id: result.project_id || target_project_id };
      const key = workflow_key(meta);
      const normalized = { ...meta, ...result };
      read_cache.set(key, JSON.stringify(normalized));
      if (draft.value === saving) {
        if (JSON.stringify(payload(saving)) === saved_snapshot) show(normalized, meta);
        else {
          saved_id.value = meta.id;
          saved_scope.value = meta.scope;
          saved_project_id.value = meta.scope === "project" ? meta.project_id : "";
          snapshot.value = saved_snapshot;
          saving.revision = result.revision;
        }
      }
      await bridge.reload_workflows();
    } catch (error) {
      if (error.code === "workflow_changed") conflict.value = "changed";
      else if (error.code === "workflow_exists") conflict.value = "exists";
      bridge.notify("error", error.message);
    }
    finally { busy.value = false; }
  }

  /** Read the open workflow again from the library, after asking when the page holds unsaved changes. */
  function reload() {
    const key = saved_key.value;
    if (!key) return;
    guard(() => { conflict.value = ""; read_cache.delete(key); open_saved(key); });
  }

  /** Delete the workflow the user confirmed; when it was the open one, the page moves to the first left. */
  async function remove() {
    const key = deleting.value, label = deleting_label.value;
    const parsed = parse_key(key);
    if (!parsed?.id || pending_items.value.has(key)) return;
    deleting.value = "";
    pending_items.value.add(key);
    try {
      await bridge.local_request("workflows", { action: "delete", id: parsed.id, ...scope_params(parsed) });
      bridge.notify("info", t("已删除「{value1}」", { value1: label }));
      read_cache.delete(key);
      if (key === saved_key.value) {
        read_version++;
        draft.value = null;
        saved_id.value = "";
        saved_scope.value = "global";
        saved_project_id.value = "";
        loading.value = "";
      }
      await bridge.reload_workflows();
    }
    catch (error) { bridge.notify("error", error.message); return; }
    finally { pending_items.value.delete(key); }
  }

  /** Move a workflow between project and global scopes; refuses to overwrite an existing ID in the target scope. */
  async function move_workflow(item, target_scope, target_project_id = "") {
    const key = workflow_key(item);
    if (pending_items.value.has(key)) return;
    pending_items.value.add(key);
    try {
      const result = await bridge.local_request("workflows", {
        action: "move",
        id: item.id,
        ...scope_params(item),
        target_scope,
        ...(target_scope === "project" && target_project_id ? { target_project_id } : {}),
      });
      read_cache.delete(key);
      const next_meta = { id: result.id || item.id, scope: result.scope || target_scope, project_id: result.project_id || target_project_id };
      await bridge.reload_workflows();
      if (result.room_updated || current_room_id.value) bridge.reload_room_models?.().catch(() => {});
      if (saved_key.value === key) {
        saved_id.value = next_meta.id;
        saved_scope.value = next_meta.scope;
        saved_project_id.value = next_meta.scope === "project" ? next_meta.project_id : "";
        open_saved(next_meta);
      }
      bridge.notify("info", target_scope === "global"
        ? t("已将「{value1}」移至全局工作流", { value1: item.label || item.id })
        : t("已将「{value1}」移至项目工作流", { value1: item.label || item.id }));
    } catch (error) { bridge.notify("error", error.message); }
    finally { pending_items.value.delete(key); }
  }

  /** Copy a workflow between project and global scopes, keeping the original untouched. */
  async function copy_workflow(item, target_scope, target_project_id = "", target_name = "") {
    const key = workflow_key(item);
    if (pending_items.value.has(key)) return;
    pending_items.value.add(key);
    try {
      await bridge.local_request("workflows", {
        action: "copy",
        id: item.id,
        ...scope_params(item),
        target_scope,
        ...(target_scope === "project" && target_project_id ? { target_project_id } : {}),
      });
      await bridge.reload_workflows();
      bridge.notify("info", target_scope === "global"
        ? t("已将「{value1}」复制到全局工作流", { value1: item.label || item.id })
        : target_name ? t("已将「{value1}」复制到项目「{value2}」", { value1: item.label || item.id, value2: target_name })
          : t("已将「{value1}」复制到本项目", { value1: item.label || item.id }));
    } catch (error) { bridge.notify("error", error.message); }
    finally { pending_items.value.delete(key); }
  }

  /** An entry's "…" menu, tailored to global, writable project, and read-only project workflows. */
  function item_menu(item) {
    const is_project = item.scope === "project";
    const key = workflow_key(item);
    if (is_project && item.readonly) {
      return [[
        { label: t("导出"), icon: "i-lucide-download", disabled: Boolean(item.error), onSelect: () => export_workflow(item) },
        { label: t("复制到全局"), icon: "i-lucide-copy", disabled: Boolean(item.error), onSelect: () => copy_workflow(item, "global") },
      ]];
    }
    const groups = [[
      { label: t("重命名"), icon: "i-lucide-pencil", disabled: Boolean(item.error), onSelect: () => start_rename(item) },
      { label: item.disabled ? t("启用") : t("停用"), icon: item.disabled ? "i-lucide-circle-play" : "i-lucide-circle-pause", onSelect: () => set_disabled(item, !item.disabled) },
      { label: t("导出"), icon: "i-lucide-download", disabled: Boolean(item.error), onSelect: () => export_workflow(item) },
    ]];
    if (is_project) {
      groups.push([
        { label: t("移至全局"), icon: "i-lucide-arrow-up-right", disabled: Boolean(item.error), onSelect: () => move_workflow(item, "global") },
        { label: t("复制到全局"), icon: "i-lucide-copy", disabled: Boolean(item.error), onSelect: () => copy_workflow(item, "global") },
      ]);
    } else if (writable_roots.value.length === 1) {
      const root = writable_roots.value[0];
      groups.push([
        { label: t("复制到本项目"), icon: "i-lucide-folder-input", disabled: Boolean(item.error), onSelect: () => copy_workflow(item, "project", root.id, root.name) },
      ]);
    } else if (writable_roots.value.length > 1) {
      groups.push(writable_roots.value.map((root) => ({
        label: t("复制到项目「{name}」", { name: root.name }),
        icon: "i-lucide-folder-input",
        disabled: Boolean(item.error),
        onSelect: () => copy_workflow(item, "project", root.id, root.name),
      })));
    }
    groups.push([
      { label: t("删除"), icon: "i-lucide-trash-2", color: "error", onSelect: () => { deleting.value = key; } },
    ]);
    return groups;
  }

  /** Rename in place in the list; the input focuses itself once rendered. */
  function start_rename(item) {
    if (item.readonly) return;
    rename_text.value = item.label;
    renaming.value = workflow_key(item);
    nextTick(() => { const input = document.querySelector("[data-workflow-rename]"); input?.focus(); input?.select(); });
  }

  /** Save the new name; the open workflow's canvas takes it without counting as an unsaved change. */
  async function commit_rename() {
    const key = renaming.value, label = rename_text.value.trim();
    renaming.value = "";
    const parsed = parse_key(key);
    const listed = workflows.value.find((item) => workflow_key(item) === key);
    if (!parsed?.id || !label || pending_items.value.has(key) || label === listed?.label) return;
    pending_items.value.add(key);
    try {
      await bridge.local_request("workflows", { action: "rename", id: parsed.id, label, ...scope_params(parsed) });
      read_saved(parsed).catch(() => read_cache.delete(key));
      if (key === saved_key.value && draft.value) {
        draft.value.label = label;
        snapshot.value = JSON.stringify({ ...JSON.parse(snapshot.value), label });
      }
      await bridge.reload_workflows();
    } catch (error) { bridge.notify("error", error.message); }
    finally { pending_items.value.delete(key); }
  }

  /** Download a saved workflow as `<id>.zip` holding its folder `<id>/`, which 导入 on this page reads back. */
  async function export_workflow(item) {
    try {
      const { id, files, ignored } = await bridge.local_request("workflows", { action: "export", id: item.id, ...scope_params(item) });
      download_file(`${id}.zip`, zip_store(files, id), "application/zip");
      if (ignored?.length) bridge.notify("warning", t("已导出「{value1}」；以下文件不是文本或太大，没有放进压缩包：{value2}", { value1: item.label, value2: ignored.join("、") }));
    } catch (error) { bridge.notify("error", error.message); }
  }

  /** Switch a workflow off (no room may enable or keep using it) or back on. */
  async function set_disabled(item, disabled) {
    const key = workflow_key(item);
    if (pending_items.value.has(key)) return;
    pending_items.value.add(key);
    try {
      await bridge.local_request("workflows", { action: disabled ? "disable" : "enable", id: item.id, ...scope_params(item) });
      bridge.notify("info", disabled ? t("已停用「{value1}」：房间里不能再启用它，已启用的房间改用房间里的设置", { value1: item.label }) : t("已启用「{value1}」", { value1: item.label }));
      await bridge.reload_workflows();
    } catch (error) { bridge.notify("error", error.message); }
    finally { pending_items.value.delete(key); }
  }

  return {
    conflict, reload, refresh_list, available,
    workflows, global_workflows, project_workflows, project_roots, writable_roots,
    page_open, draft, saved_id, saved_scope, saved_project_id, saved_key,
    active_scope, active_project_id, active_project_name, draft_readonly, set_draft_target,
    canvas_key, scope, subs, current, reserved, open_scope, enter_sub, add_sub, remove_sub,
    commands_allowed, busy, loading, failure, pending_items, retry: () => retry_read?.(),
    deleting, deleting_label, leaving, renaming, rename_text, inputs,
    skill_request, skill_open, set_skill_open, stacked, dirty, add_items,
    guard, discard, select, close_page, on_zip, on_folder, save,
    remove, move_workflow, copy_workflow, item_menu, start_rename, commit_rename,
  };
}

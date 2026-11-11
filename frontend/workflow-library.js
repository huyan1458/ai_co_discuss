/**
 * The workflow library's shared state: the sidebar's 工作流 list and the workflow page in the middle work on the same
 * workflow, so the selection, the unsaved draft and the confirmations live here, one copy per page.
 */
import { computed, effectScope, inject, nextTick, ref, watch } from "vue";
import { workflow_files_from_folder, workflow_files_from_zip } from "./workflow-files.js";
import { flow_in_use } from "../runner/workflow_flow.mjs";

const COMMANDS_FILE = "commands.json";
const NEW_SKILL = "写下主持人怎么组织这个工作流：每一步找哪位成员、交回什么、怎么验收。";
const NEW_SUB_SKILL = "写下主线之外什么时候用这个子工作流，以及主持人怎么组织它：每一步找哪位成员、交回什么、怎么验收。";
const MAX_SUB_WORKFLOWS = 10;
let library = null;

/** The shared library, created on first use with the injected discussion context. */
export function use_workflow_library() {
  if (!library) library = effectScope(true).run(() => create_library(inject("discussion")));
  return library;
}

/**
 * A canvas as saved: only nodes of cards (`agents`) and sub-workflows (`subs`, IDs) that exist, and only edges between
 * kept nodes; one with only its start is none.
 */
function saved_flow(flow, agents, subs = []) {
  const cards = new Set(agents.map((agent) => agent.card));
  const kept = (node) => node.type === "card" ? cards.has(node.card) : node.type !== "sub" || subs.includes(node.sub);
  const nodes = flow_in_use(flow) ? flow.nodes.filter(kept) : null;
  const ids = new Set((nodes || []).map((node) => node.id));
  return nodes ? { nodes, edges: flow.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) } : null;
}

/**
 * What saving would write, the comparison for unsaved changes too. Sub-workflows are saved whole, each with its canvas;
 * a sub-workflow's canvas may show main-flow members, the main canvas the sub-workflows.
 */
function payload(value) {
  const { resources, commands: ignored, flow, directory, sub_workflows, ...fields } = value;
  return { ...fields, flow: saved_flow(flow, fields.agents, (sub_workflows || []).map((sub) => sub.id)), resources,
    ...(sub_workflows ? { sub_workflows: sub_workflows.map((sub) => ({ ...sub, flow: saved_flow(sub.flow, [...sub.agents, ...fields.agents]) })) } : {}) };
}

function create_library({ view, bridge, act }) {
  const available = computed(() => view.value.launch.available || view.value.launch.remote);
  const workflows = computed(() => view.value.launch.workflows || []);
  // Whether the middle shows the workflow page instead of the room.
  const page_open = ref(false);
  // The workflow on the canvas: a saved one (`saved_id`) or a new or imported draft; `snapshot` is how it was when loaded.
  const draft = ref(null), saved_id = ref(""), snapshot = ref(""), canvas_key = ref(0);
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
  // Workflows as last read, by ID: switching shows the copy at once (no empty page in between) and checks it afterwards.
  const read_cache = new Map();
  // The workflow whose deletion awaits confirmation (its ID), and the action waiting on "放弃未保存的修改？".
  const deleting = ref(""), leaving = ref(null);
  const deleting_label = computed(() => workflows.value.find((item) => item.id === deleting.value)?.label || deleting.value);
  const renaming = ref(""), rename_text = ref("");
  // The hidden file inputs, registered by the workspace that renders them; `skill_request` asks the page to show SKILL.md.
  const inputs = { zip: null, folder: null };
  const skill_request = ref(0);
  // While a freshly mounted canvas fills itself in, nothing counts as unsaved (the save button would light up for a frame).
  const settling = ref(false);
  const dirty = computed(() => Boolean(draft.value) && !(saved_id.value && settling.value)
    && (!saved_id.value || JSON.stringify(payload(draft.value)) !== snapshot.value));

  /** Take the comparison for unsaved changes once the canvas just mounted has filled itself in. */
  function settle() {
    const shown = draft.value;
    settling.value = true;
    setTimeout(() => { if (draft.value === shown) snapshot.value = JSON.stringify(payload(shown)); settling.value = false; }, 0);
  }

  /** Put a workflow on the canvas. */
  function show(value, id) {
    draft.value = { ...value, sub_workflows: value.sub_workflows || [] };
    saved_id.value = id;
    // Saving keeps the sub-workflow in view; another workflow starts at its main flow.
    if (!draft.value.sub_workflows.some((sub) => sub.id === scope.value)) scope.value = "";
    commands_allowed.value = false;
    canvas_key.value++;
    // The canvas fills in a start node on mount, so the comparison is taken once it did.
    settle();
  }

  /** A new or imported workflow, not yet saved, shown on the page. */
  function edit_draft(value) {
    read_version++;
    loading.value = "";
    failure.value = "";
    show({ agents: [], ...JSON.parse(JSON.stringify(value)), id: value.id || `workflow-${Date.now().toString(36)}` }, "");
    page_open.value = true;
    if (value.commands?.length) skill_request.value++;
  }

  /** Read a saved workflow from the local service and remember it. */
  async function read_saved(id) {
    const value = await bridge.local_request("workflows", { action: "get", id });
    read_cache.set(id, JSON.stringify(value));
    return value;
  }

  /** Open a saved workflow (a copy read before shows at once, then is checked); a broken one shows its error instead. */
  async function open_saved(id) {
    const version = ++read_version;
    const cached = id && read_cache.get(id);
    failure.value = "";
    loading.value = "";
    if (cached) show(JSON.parse(cached), id);
    else { draft.value = null; saved_id.value = id || ""; }
    if (!id || workflows.value.find((item) => item.id === id)?.error) { draft.value = null; return; }
    if (!cached) loading.value = "正在读取工作流…";
    retry_read = () => open_saved(id);
    try {
      const value = await read_saved(id);
      if (version !== read_version) return;
      // A copy that changed on disk meanwhile is replaced, unless the user already started editing it.
      if (!cached || (read_cache.get(id) !== cached && !dirty.value)) show(value, id);
    } catch (error) { if (version === read_version && !cached) failure.value = error.message; }
    finally { if (version === read_version) loading.value = ""; }
  }

  /** Read the library's other workflows in the background, so switching to them shows at once. */
  function prefetch(list) {
    for (const item of list) if (!item.error && !read_cache.has(item.id)) read_saved(item.id).catch(() => {});
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

  /** Show a workflow from the sidebar on the page. */
  function select(id) {
    if (page_open.value && saved_id.value === id && draft.value) return;
    if (saved_id.value === id && draft.value) { page_open.value = true; return; }
    // The choice is taken before the page opens, so opening it does not also load the first workflow in the list.
    guard(() => { saved_id.value = id; page_open.value = true; open_saved(id); });
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
      else if (dirty.value) open_saved(saved_id.value);
      then?.();
    });
  }

  // Keep a valid selection when the library changes, and open the first workflow when the page opens empty.
  watch([workflows, page_open], ([list, open]) => {
    if (saved_id.value && !list.some((item) => item.id === saved_id.value)) open_saved(open ? list[0]?.id || "" : "");
    else if (open && !draft.value && !loading.value && !failure.value && list.length) open_saved(saved_id.value || list[0].id);
    if (open) prefetch(list);
  });
  watch(available, (value) => { if (value) bridge.reload_workflows(); }, { immediate: true });

  const add_items = [[
    { label: "新建", icon: "i-lucide-plus", onSelect: () => guard(() => edit_draft({ label: "未命名工作流", description: "", skill: NEW_SKILL, agents: [] })) },
    { label: "导入 zip", icon: "i-lucide-file-archive", onSelect: () => guard(() => inputs.zip?.click()) },
    { label: "导入文件夹", icon: "i-lucide-folder-input", onSelect: () => guard(() => inputs.folder?.click()) },
  ]];

  /** Read the opened files, let the local service check them, and put the result on the canvas; nothing is saved yet. */
  async function import_files(read) {
    const version = ++read_version;
    draft.value = null;
    saved_id.value = "";
    loading.value = "正在导入工作流…";
    failure.value = "";
    retry_read = () => import_files(read);
    page_open.value = true;
    try {
      const value = await bridge.local_request("workflows", { action: "preview", files: await read() });
      if (version !== read_version) return;
      if (value.ignored?.length) bridge.notify("warning", `已忽略不支持的文件：${value.ignored.join("、")}`);
      edit_draft(value);
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
    if (subs.value.length >= MAX_SUB_WORKFLOWS) { bridge.notify("warning", `子工作流最多 ${MAX_SUB_WORKFLOWS} 个`); return ""; }
    const taken = new Set(subs.value.map((sub) => sub.id));
    let number = subs.value.length + 1;
    while (taken.has(`part-${number}`)) number++;
    draft.value.sub_workflows = [...subs.value, { id: `part-${number}`, label: `子工作流 ${number}`, description: "", skill: NEW_SUB_SKILL, agents: [], flow: null }];
    if (open) enter_sub(`part-${number}`, true);
    return `part-${number}`;
  }

  /** Remove a sub-workflow (its folder, scripts included, goes with the next save); the page returns to the main flow. */
  function remove_sub(id) {
    draft.value.sub_workflows = subs.value.filter((sub) => sub.id !== id);
    if (scope.value === id) open_scope("");
  }

  /** Save the workflow as files; the local service checks every field. A saved one keeps its folder's other files. */
  async function save() {
    if (busy.value || !draft.value) return;
    if (!draft.value.label.trim() || !draft.value.skill.trim()) { open_scope(""); skill_request.value++; bridge.notify("warning", "请填写名称和 SKILL.md 正文"); return; }
    const unfinished = subs.value.find((sub) => !sub.label.trim() || !sub.description.trim() || !sub.skill.trim());
    if (unfinished) { open_scope(unfinished.id); skill_request.value++; bridge.notify("warning", "请填写子工作流的名称、一句话描述和 SKILL.md 正文"); return; }
    const { resources, ...edited } = payload(draft.value);
    // An import keeps its commands file only when the user allowed it; the rest of its files come along either way.
    const kept = resources && !commands_allowed.value ? Object.fromEntries(Object.entries(resources).filter(([path]) => path !== COMMANDS_FILE)) : resources;
    const saving = draft.value, saved_snapshot = JSON.stringify(payload(saving));
    busy.value = true;
    try {
      const result = await bridge.local_request("workflows", { action: "save", workflow: saved_id.value ? edited : { ...edited, resources: kept } });
      bridge.notify("info", `已保存「${result.label || result.id}」`);
      read_cache.set(result.id, JSON.stringify(result));
      if (draft.value === saving) {
        if (JSON.stringify(payload(saving)) === saved_snapshot) show(result, result.id);
        else { saved_id.value = result.id; snapshot.value = saved_snapshot; }
      }
      await bridge.reload_workflows();
    } catch (error) { bridge.notify("error", error.message); }
    finally { busy.value = false; }
  }

  /** Delete the workflow the user confirmed; when it was the open one, the page moves to the first left. */
  async function remove() {
    const id = deleting.value, label = deleting_label.value;
    if (pending_items.value.has(id)) return;
    deleting.value = "";
    pending_items.value.add(id);
    try {
      await bridge.local_request("workflows", { action: "delete", id });
      bridge.notify("info", `已删除「${label}」`);
      read_cache.delete(id);
      if (id === saved_id.value) { read_version++; draft.value = null; saved_id.value = ""; loading.value = ""; }
      await bridge.reload_workflows();
    }
    catch (error) { bridge.notify("error", error.message); return; }
    finally { pending_items.value.delete(id); }
  }

  /** An entry's "…" menu. */
  function item_menu(item) {
    return [[
      { label: "重命名", icon: "i-lucide-pencil", disabled: Boolean(item.error), onSelect: () => start_rename(item) },
      { label: item.disabled ? "启用" : "停用", icon: item.disabled ? "i-lucide-circle-play" : "i-lucide-circle-pause", onSelect: () => set_disabled(item, !item.disabled) },
      { label: "复制文件夹路径", icon: "i-lucide-folder", disabled: !item.directory, onSelect: () => act("copy", item.directory) },
    ], [
      { label: "删除", icon: "i-lucide-trash-2", color: "error", onSelect: () => { deleting.value = item.id; } },
    ]];
  }

  /** Rename in place in the list; the input focuses itself once rendered. */
  function start_rename(item) {
    rename_text.value = item.label;
    renaming.value = item.id;
    nextTick(() => { const input = document.querySelector("[data-workflow-rename]"); input?.focus(); input?.select(); });
  }

  /** Save the new name; the open workflow's canvas takes it without counting as an unsaved change. */
  async function commit_rename() {
    const id = renaming.value, label = rename_text.value.trim();
    renaming.value = "";
    if (!id || !label || pending_items.value.has(id) || label === workflows.value.find((item) => item.id === id)?.label) return;
    pending_items.value.add(id);
    try {
      await bridge.local_request("workflows", { action: "rename", id, label });
      read_saved(id).catch(() => read_cache.delete(id));
      if (id === saved_id.value && draft.value) {
        draft.value.label = label;
        snapshot.value = JSON.stringify({ ...JSON.parse(snapshot.value), label });
      }
      await bridge.reload_workflows();
    } catch (error) { bridge.notify("error", error.message); }
    finally { pending_items.value.delete(id); }
  }

  /** Switch a workflow off (no room may enable or keep using it) or back on. */
  async function set_disabled(item, disabled) {
    if (pending_items.value.has(item.id)) return;
    pending_items.value.add(item.id);
    try {
      await bridge.local_request("workflows", { action: disabled ? "disable" : "enable", id: item.id });
      bridge.notify("info", disabled ? `已停用「${item.label}」：房间里不能再启用它，已启用的房间改用房间里的设置` : `已启用「${item.label}」`);
      await bridge.reload_workflows();
    } catch (error) { bridge.notify("error", error.message); }
    finally { pending_items.value.delete(item.id); }
  }

  return { available, workflows, page_open, draft, saved_id, canvas_key, scope, subs, current, reserved, open_scope, enter_sub, add_sub, remove_sub, commands_allowed, busy, loading, failure, pending_items, retry: () => retry_read?.(), deleting, deleting_label, leaving,
    renaming, rename_text, inputs, skill_request, dirty, add_items, guard, discard, select, close_page, on_zip, on_folder, save,
    remove, item_menu, start_rename, commit_rename };
}

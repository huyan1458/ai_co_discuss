/**
 * The workflow library's shared state: the sidebar's 工作流 list and the workflow page in the middle work on the same
 * workflow, so the selection, the unsaved draft and the confirmations live here, one copy per page.
 */
import { computed, effectScope, inject, nextTick, ref, watch } from "vue";
import { workflow_files_from_folder, workflow_files_from_zip } from "./workflow-files.js";
import { flow_in_use } from "../runner/workflow_flow.mjs";

const COMMANDS_FILE = "commands.json";
const NEW_SKILL = "写下主持人怎么组织这个工作流：每一步找哪位成员、交回什么、怎么验收。";
let library = null;

/** The shared library, created on first use with the injected discussion context. */
export function use_workflow_library() {
  if (!library) library = effectScope(true).run(() => create_library(inject("discussion")));
  return library;
}

/** What saving would write, the comparison for unsaved changes too: a canvas with only its start counts as none. */
function payload(value) {
  const { resources, commands: ignored, flow, directory, ...fields } = value;
  const cards = new Set(fields.agents.map((agent) => agent.card));
  const nodes = flow_in_use(flow) ? flow.nodes.filter((node) => node.type !== "card" || cards.has(node.card)) : null;
  const ids = new Set((nodes || []).map((node) => node.id));
  const saved_flow = nodes ? { nodes, edges: flow.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) } : null;
  return { ...fields, flow: saved_flow, resources };
}

function create_library({ view, bridge, act }) {
  const available = computed(() => view.value.launch.available || view.value.launch.remote);
  const workflows = computed(() => view.value.launch.workflows || []);
  // Whether the middle shows the workflow page instead of the room.
  const page_open = ref(false);
  // The workflow on the canvas: a saved one (`saved_id`) or a new or imported draft; `snapshot` is how it was when loaded.
  const draft = ref(null), saved_id = ref(""), snapshot = ref(""), canvas_key = ref(0);
  const commands_allowed = ref(false), busy = ref(false);
  // The workflow whose deletion awaits confirmation (its ID), and the action waiting on "放弃未保存的修改？".
  const deleting = ref(""), leaving = ref(null);
  const deleting_label = computed(() => workflows.value.find((item) => item.id === deleting.value)?.label || deleting.value);
  const renaming = ref(""), rename_text = ref("");
  // The hidden file inputs, registered by the workspace that renders them; `skill_request` asks the page to show SKILL.md.
  const inputs = { zip: null, folder: null };
  const skill_request = ref(0);
  const dirty = computed(() => Boolean(draft.value) && (!saved_id.value || JSON.stringify(payload(draft.value)) !== snapshot.value));

  /** Put a workflow on the canvas. */
  function show(value, id) {
    draft.value = value;
    saved_id.value = id;
    commands_allowed.value = false;
    canvas_key.value++;
    // The canvas fills in a start node on mount, so the comparison is taken once it did.
    setTimeout(() => { snapshot.value = JSON.stringify(payload(draft.value)); }, 0);
  }

  /** A new or imported workflow, not yet saved, shown on the page. */
  function edit_draft(value) {
    show({ agents: [], ...JSON.parse(JSON.stringify(value)), id: value.id || `workflow-${Date.now().toString(36)}` }, "");
    page_open.value = true;
    if (value.commands?.length) skill_request.value++;
  }

  /** Open a saved workflow; a broken one shows its error instead. */
  async function open_saved(id) {
    if (!id || workflows.value.find((item) => item.id === id)?.error) { draft.value = null; saved_id.value = id || ""; return; }
    busy.value = true;
    try { show(await bridge.local_request("workflows", { action: "get", id }), id); }
    catch (error) { bridge.notify("error", error.message); }
    finally { busy.value = false; }
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
    guard(() => { page_open.value = true; open_saved(id); });
  }

  /** Leave the page for the room, asking first about unsaved changes; `then` runs once it is left. */
  function close_page(then) {
    if (!page_open.value) { then?.(); return; }
    guard(() => {
      page_open.value = false;
      // A draft that was dropped does not linger: the next visit reopens the saved workflow.
      if (!saved_id.value) draft.value = null;
      else if (dirty.value) open_saved(saved_id.value);
      then?.();
    });
  }

  // Keep a valid selection when the library changes, and open the first workflow when the page opens empty.
  watch([workflows, page_open], ([list, open]) => {
    if (open && !draft.value && !saved_id.value && list.length) open_saved(list[0].id);
    else if (saved_id.value && !list.some((item) => item.id === saved_id.value)) open_saved(open ? list[0]?.id || "" : "");
  });
  watch(available, (value) => { if (value) bridge.reload_workflows(); }, { immediate: true });

  const add_items = [[
    { label: "新建", icon: "i-lucide-plus", onSelect: () => guard(() => edit_draft({ label: "未命名工作流", description: "", skill: NEW_SKILL, agents: [] })) },
    { label: "导入 zip", icon: "i-lucide-file-archive", onSelect: () => guard(() => inputs.zip?.click()) },
    { label: "导入文件夹", icon: "i-lucide-folder-input", onSelect: () => guard(() => inputs.folder?.click()) },
  ]];

  /** Read the opened files, let the local service check them, and put the result on the canvas; nothing is saved yet. */
  async function import_files(read) {
    try {
      const value = await bridge.local_request("workflows", { action: "preview", files: await read() });
      if (value.ignored?.length) bridge.notify("warning", `已忽略不支持的文件：${value.ignored.join("、")}`);
      edit_draft(value);
    } catch (error) { bridge.notify("error", error.message); }
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

  /** Save the workflow as files; the local service checks every field. A saved one keeps its folder's other files. */
  async function save() {
    if (!draft.value.label.trim() || !draft.value.skill.trim()) { skill_request.value++; bridge.notify("warning", "请填写名称和 SKILL.md 正文"); return; }
    const { resources, ...edited } = payload(draft.value);
    // An import keeps its commands file only when the user allowed it; the rest of its files come along either way.
    const kept = resources && !commands_allowed.value ? Object.fromEntries(Object.entries(resources).filter(([path]) => path !== COMMANDS_FILE)) : resources;
    busy.value = true;
    try {
      const result = await bridge.local_request("workflows", { action: "save", workflow: saved_id.value ? edited : { ...edited, resources: kept } });
      bridge.notify("info", `已保存「${result.label || result.id}」`);
      await bridge.reload_workflows();
      show(result, result.id);
    } catch (error) { bridge.notify("error", error.message); }
    finally { busy.value = false; }
  }

  /** Delete the workflow the user confirmed; when it was the open one, the page moves to the first left. */
  async function remove() {
    const id = deleting.value, label = deleting_label.value;
    deleting.value = "";
    try { await bridge.local_request("workflows", { action: "delete", id }); }
    catch (error) { bridge.notify("error", error.message); return; }
    bridge.notify("info", `已删除「${label}」`);
    if (id === saved_id.value) { draft.value = null; saved_id.value = ""; }
    await bridge.reload_workflows();
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
    if (!id || !label || label === workflows.value.find((item) => item.id === id)?.label) return;
    try { await bridge.local_request("workflows", { action: "rename", id, label }); }
    catch (error) { bridge.notify("error", error.message); return; }
    if (id === saved_id.value && draft.value) {
      draft.value.label = label;
      snapshot.value = JSON.stringify({ ...JSON.parse(snapshot.value), label });
    }
    await bridge.reload_workflows();
  }

  /** Switch a workflow off (no room may enable or keep using it) or back on. */
  async function set_disabled(item, disabled) {
    try { await bridge.local_request("workflows", { action: disabled ? "disable" : "enable", id: item.id }); }
    catch (error) { bridge.notify("error", error.message); return; }
    bridge.notify("info", disabled ? `已停用「${item.label}」：房间里不能再启用它，已启用的房间改用房间里的设置` : `已启用「${item.label}」`);
    await bridge.reload_workflows();
  }

  return { available, workflows, page_open, draft, saved_id, canvas_key, commands_allowed, busy, deleting, deleting_label, leaving,
    renaming, rename_text, inputs, skill_request, dirty, add_items, guard, discard, select, close_page, on_zip, on_folder, save,
    remove, item_menu, start_rename, commit_rename };
}

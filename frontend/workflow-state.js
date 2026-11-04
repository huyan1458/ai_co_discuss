/**
 * The room's workflow while it is in use, else null. Mirrors `workflow_in_use` in runner/workflows.mjs: a workflow lasts
 * while a member it brought (other than the host) is here, so sending them away or removing them ends it.
 */
export function active_workflow(workflow, members = []) {
  if (!workflow?.enabled) return null;
  const host = members.find((member) => member.role === "host")?.name;
  const brought = Object.values(workflow.members || {}).filter((name) => name !== host);
  return !brought.length || members.some((member) => brought.includes(member.name) && member.status === "active") ? workflow : null;
}

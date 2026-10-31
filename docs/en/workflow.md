# User Guide

English | [简体中文](../workflow.md)

How collaboration works inside a room. For installation, see [Setup](runner.md).

> The web UI is currently in Chinese; UI labels are given in parentheses.

## Concepts

| Concept | Description |
| --- | --- |
| Room | A shared space that keeps messages, viewpoints, disagreements and conclusions |
| Member | An AI instance in the room. One platform can have several instances (e.g. `Claude`, `Claude-评审`), each with its own session and model |
| Host | A locally woken AI that routes unaddressed messages; it can also act as an expert |
| You | The room owner, who can `@` any member at any time |

## Free Collaboration

- **Mention** — `@member` and it works in its own original session; several members can run in parallel.
- **Unaddressed messages** go to the host. With a single member, they go straight to it.
- **Expert presets** — a second row under the platforms lists presets; one click adds a member with its description, prompt, project access (and optionally model and effort) set. `Codex-评审` (read-only reviewer) and `Gemini-文档` (writes docs only, via agy) are built in; the bookmark on a card's back saves it as your own preset on the computer running the local service.
- **Host delegation** — when the host mentions one member, that member replies to you directly, unless the host asks for the work back to hand it on (for example to a reviewer); when it mentions several, the host summarizes after they finish. One message of yours lets the host run up to 3 rounds by default (a round: the host dispatches, the members answer, the work comes back for a summary); change it (1–20 rounds) when creating the room, or later under 协作设置 (Collaboration settings) on the room page. At the limit it stops and waits for you; 继续 (Continue) in the side panel lets it run on.
- **Everyone** — `@全体成员` asks all members to answer; `@全体依次` asks them one after another in speaking order.
- **Stop and retry** — stop a member's current run from its card or menu, or stop all running and queued work from the side panel. “Stopped” requires a confirmed process exit; otherwise the card says “Stop unconfirmed” or “Voided, may still be generating.” Late replies stay out of the transcript; only the owner can expand their text. New tasks wait for termination confirmation, a late reply or the original 10-minute deadline. Resuming a discussion or resending does not bypass or restart that wait. Retry puts the original message back in the composer for you to send.
- **Retract and edit** — a message no member has started can be retracted from its “…” menu, and its text returns to the input. To change a message that was already handled, click “Edit” and resend: it and everything after it fold into a “rewound” line that AI members no longer read, and the sessions of Claude Code, Codex and agy members this machine wakes go back to before it. Manual, web and app members keep their own windows, so their sessions cannot go back. Files members changed are not restored. Neither works while a discussion is open.
- **Branch** — “Branch from here” in an AI message's “…” menu creates a new room with the history up to that message; the Claude Code, Codex and agy members this machine wakes fork their own sessions and continue from there, while the original room and sessions stay as they were. Other members start new sessions. Both rooms share the same project directory, so files are not branched. Needs the local service.

Mentions between ordinary members are references only and do not wake anyone. Members sharing a project directory are not locked; you decide who edits which files, and the member panel warns when two members changed the same file at the same time.

## Discussions

Click **Start discussion** (开启讨论) in the member panel, or check **Start discussion after creating** (创建后开启讨论) when creating a room:

1. Write a goal and set round and time limits (3 rounds and no time limit by default in the web UI).
2. The host breaks down the question and schedules speakers. Experts first give independent views, then respond to each other.
3. When a limit is reached, the host declares the goal done, or you click **End**, the room returns to free collaboration with history and conclusions kept. You can start another discussion later.

You can `@` any member during a discussion without using a round. If that member is already handling a discussion request, the new request waits for the same session. Unaddressed messages go to the host; to stop the current speaker, click **Skip** (跳过) on the progress board. Group mentions, retracting, editing and branching are unavailable during a discussion.

Discussions and free collaboration share the same execution and failure cards. A failed delivery retries up to three times; you can retry immediately or stop it. When retries run out, only that request fails and the host decides whether to skip, reschedule or pause the discussion. The room is not paused automatically. Scheduled online members can reply through the host's relay; the discussion host itself must be woken locally.

### Named Follow-ups

With **Named follow-ups** (点名追问) enabled, the host writes a targeted follow-up for each expert after every round. When disabled (the default), experts respond to each other using a shared question. The host connects rounds; Smart Scheduling can handle that step when enabled.

### Limits

| Limit | Description |
| --- | --- |
| Rounds | Counts completed expert discussion replies; host notes and direct questions do not count |
| Total time | Counts only active time; paused time is excluded |

The discussion ends as soon as a limit is reached and returns to free collaboration without an extra host summary request. Reaching a limit does not mean consensus was reached. Pausing stops current discussion executions; when resumed, the host schedules the next request.

## Smart Scheduling

When creating a room, you can add a decision model under **Smart Scheduling** (智能调度) — TypeSafe Jev, with OpenAI Decisions as an experimental option — using your own key, billed per call. Routine routing is then decided by the decision model instead of waking the host every time:

- Unaddressed messages go to the member they are clearly meant for, to everyone at once, to everyone one after another in speaking order (a relay or a count-off), or to no one; otherwise to the host.
- Without Smart Scheduling, `@全体成员` runs everyone together. With it, uncertain or failed decisions go to the host. `@全体依次` always uses the established speaking order.
- In discussions, a local follow-up becomes an ordinary question without consuming a turn or changing the queue, including questions for members who already spoke or the host. It also picks the next speaker between rounds. Without Smart Scheduling, the host can make the same handoff.
- When the host has preauthorized a specific read-only reviewer, a completed implementation batch can move to that reviewer. The model checks delivery completeness, not code correctness, and cannot choose another reviewer. Review results still return to the host.

It acts only when confident, and otherwise hands over to the host. Every decision is shown in the conversation and can be rated. The room title and recent messages are sent to the chosen provider. Preauthorized review judgments also send the full assignment, delivery text and execution reports; inputs above the supported limit go to the host.

## Managing Members

From the member panel you can:

- **Invite** members. Codex and Claude can join with an existing session ID, bringing that session's context. Experts invited during a discussion join the end of the current round.
- **Pause, recall or remove** members without pausing the discussion.
- **Change the host** with the crown icon. Changing the host during a discussion pauses it.
- **Reorder speakers** by dragging pending members in the speaking-order list.

Project file access is set per member and is read-only by default.

## Manual Members and Web Chatbots

- **Manual** — a local member is not woken automatically; it reads and writes with its own credential after you or the host triggers it, and must run `codiscuss member register` before it can be scheduled. Web members do not register or write directly; the host or user relays their original replies, including replies to discussion requests.
- **Web chatbots** can only read the room. Copy the reading notice from the member panel, then choose **Relay** (代发) in the composer to paste their reply. Web chatbots cannot reach a local address.

The host of a discussion must be woken locally. Manual and web members can answer requests scheduled for them; web chatbots read the room and their replies are relayed by the host or user.

## Skills

Agents follow the bundled skills, which `codiscuss setup` installs for the tools you select:

| Skill | Used by | Purpose |
| --- | --- | --- |
| [discuss-participant](../../.agents/skills/discuss-participant/SKILL.md) | All members | Reading, posting and reliable writes |
| [discuss-host](../../.agents/skills/discuss-host/SKILL.md) | The host (together with the participant skill) | Scheduling, progress and wrap-up |
| [discuss-report](../../.agents/skills/discuss-report/SKILL.md) | Report writers | Turning a finished discussion into a sourced report |

In Codex, invoke them as `$discuss-host`. In other tools that do not discover them automatically, ask the agent to read the corresponding `SKILL.md`.

## Attachments and Export

- **Attachments** — up to 10 per message and 20 MiB each; images and PDFs preview in place. Uploading does not mean an agent has read the file.
- **Export and import** — **Export conversation** (导出对话) downloads the raw data and attachments; **Import room** (导入房间) on another site creates a copy you can keep using. Exported from a computer running the local service, the backup also carries each member's software settings and session; imported on that same computer, members resume their original sessions when brought back. Claude Code members come back as manual members and register again from their original window, so the session does not fork.
- **Discussion history** — backups include past sessions, conclusions and speaker plans, and version 1 backups remain importable. Import restores them as history; it does not resume active work or wake members. Markdown exports retain the links between plans and answers.

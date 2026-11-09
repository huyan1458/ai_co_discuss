# User Guide

English | [简体中文](../workflow.md)

How collaboration works inside a room. For installation, see [Setup](runner.md).

> The web UI is currently in Chinese; UI labels are given in parentheses.

## Concepts

| Concept | Description |
| --- | --- |
| Room | A shared space that keeps messages, viewpoints, disagreements and conclusions |
| Member | An AI instance in the room. One platform can have several instances (e.g. `Claude`, `Claude-review`), each with its own session and model |
| Host | A locally woken AI that routes unaddressed messages; it can also act as an expert |
| You | The room owner, who can `@` any member at any time |

## Free Collaboration

- **Mention** — `@member` and it works in its own original session; several members can run in parallel.
- **Unaddressed messages** go to the host. With a single member, they go straight to it.
- **Expert presets** — a second row under the platforms lists presets; one click adds a member with its description, prompt, project access (and optionally model and effort) set. `Codex-review` (read-only reviewer) and `Gemini-docs` (writes docs only, via agy) are built in; the bookmark on a card's back saves it as your own preset on the computer running the local service.
- **Host delegation** — when the host mentions one member, that member replies to you directly, unless the host asks for the work back to hand it on (for example to a reviewer); when it mentions several, the host summarizes after they finish. One message of yours lets the host run up to 10 rounds by default (a round: the host dispatches, the members answer, the work comes back for a summary); change it (1–100 rounds, or 不限 for unlimited) when creating the room, or later under 协作设置 (Collaboration settings) on the room page. At the limit it stops and waits for you; 继续 (Continue) in the side panel lets it run on. When the host knows up front how many rounds a task needs (say, several episodes in a row), it asks for them at the start: if too few are left it stops at once, the side panel shows its reason, and 批准 (Approve) lets it run through without stopping again. A one-after-another relay counts one round per full pass; members who do not depend on each other (say, reviewers checking different things) can share one step, working at once, and the relay moves on once all of them finish. A relay can also stop at checkpoints for the host to approve before it goes on, or loop over just part of it (write ⇄ review until it passes, then hand to the recorder); a workflow's instructions say when to use which. The host can also send a member along with a dispatch without waiting for it: it starts at the same time, the dispatch comes back without it, and the host is told if it fails.
- **Everyone** — `@全体成员` asks all members to answer; `@全体依次` asks them one after another in speaking order.
- **Stop and retry** — stop a member's current run from its card or menu, or stop all running and queued work from the side panel. “Stopped” requires a confirmed process exit; otherwise the card says “Stop unconfirmed” or “Voided, may still be generating.” Late replies stay out of the transcript; only the owner can expand their text. New tasks wait for termination confirmation, a late reply or the original 10-minute deadline. Resuming a discussion or resending does not bypass or restart that wait. Retry puts the original message back in the composer for you to send.
- **Retract and edit** — a message no member has started can be retracted from its “…” menu, and its text returns to the input. To change a message that was already handled, click “Edit” and resend: it and everything after it fold into a “rewound” line that AI members no longer read, and the sessions of Claude Code, Codex and agy members this machine wakes go back to before it. Manual and app members keep their own windows, so their sessions cannot go back. Files members changed are not restored. Neither works while a discussion is open.
- **Branch** — “Branch from here” in an AI message's “…” menu creates a new room with the history up to that message; the Claude Code, Codex and agy members this machine wakes fork their own sessions and continue from there, while the original room and sessions stay as they were. Other members start new sessions. Both rooms share the same project directory, so files are not branched. Needs the local service.

Mentions between ordinary members are references only and do not wake anyone. Members sharing a project directory are not locked; you decide who edits which files, and the member panel warns when two members changed the same file at the same time.

## Discussions

Click **Start discussion** (开启讨论) in the member panel, choose **Start discussion** under **After creating** (创建后) when creating a room, or send `/discuss <goal>` in the input box (a bare `/discuss` lets the host draw the goal from the recent conversation, and it declines when it cannot; a command start uses the room's saved default limits):

1. Write a goal and set round and time limits. The dialog starts with the room's saved defaults, set when creating the room and editable in **Edit topic** when no discussion is active or paused. Changes in the start dialog apply only to that discussion.
2. The host breaks down the question and schedules speakers. Experts first give independent views, then respond to each other.
3. When a limit is reached, the host declares the goal done, or you click **End**, the room returns to free collaboration with history and conclusions kept. You can start another discussion later.

During a discussion, `/discuss pause`, `/discuss resume` and `/discuss stop` pause, resume or end it. A discussion and a Goal never run at the same time.

You can `@` any member during a discussion without using a round. If that member is already handling a discussion request, the new request waits for the same session. Unaddressed messages go to the host; to stop the current speaker, click the stop button on their working card or **Skip** (跳过) on the progress board; the discussion moves on to the next speaker. Group mentions, retracting, editing and branching are unavailable during a discussion.

Discussions and free collaboration share the same execution and failure cards. A failed delivery retries up to three times; you can retry immediately or stop it. When retries run out, only that request fails and the host decides whether to skip, reschedule or pause the discussion. The room is not paused automatically. Scheduled online members can reply through the host's relay; the discussion host itself must be woken locally.

## Goal

A Goal keeps the host pursuing one objective: when the room goes idle, the local service wakes the host again, until the host confirms the goal is complete or blocked, a budget runs out, or you end it. Rooms without a Goal behave as before: members stop when their work is done and wait for you.

- **Start**: send `/goal <objective>` and the host starts it as written; with a bare `/goal` the host draws the objective from the recent conversation and declines when it cannot. You can also click **Start Goal** (开启 Goal) in the member panel, or choose **Start Goal** under **After creating** (创建后) when creating a room. Typing `/` at the start of the input box lists Goal and Discussion in a **Modes** (模式) group; while one is running, it lists its pause, resume and end commands.
- **Progress**: after the host's dispatched work ends and the room stays idle for 30 seconds (not counting when you just spoke, a member is still working or messages are queued), the host is woken once, shown as "Goal 续跑 #N". If the host then hands out no work (it only answers or asks you), it is not woken again until you reply.
- **Budget**: unlimited by default. Starting or editing a Goal only requires an objective; expand **Advanced settings** (高级设置) to set an optional wake-up count or time limit. At the limit the host wraps up once and the Goal ends. Three failed wake-ups in a row stop it.
- **End**: the host declares it complete after checking the actual results, or blocked when the same obstacle persists for three wake-ups. You can `/goal pause`, `/goal resume`, `/goal clear` or `/goal edit <new objective>` at any time, or use the panel buttons. **Stop all** also pauses the Goal. An end card in the conversation offers **Continue Goal** with the same objective.

A Goal grants no extra permissions: the host stays within members' project access and the chain-round limit, and does not invite members, commit, push or deploy on its own.

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
- While a Goal runs and the room is idle, it judges whether the latest replies are waiting for you (a question, an authorization or decision, or a completion report). When confident, the host is not woken and the room waits for your reply; when unsure or on errors, the host is woken as usual.
- When the host has preauthorized a specific read-only reviewer, a completed implementation batch can move to that reviewer. The model checks delivery completeness, not code correctness, and cannot choose another reviewer. Review results still return to the host.

It acts only when confident, and otherwise hands over to the host. Every decision is shown in the conversation and can be rated. The room title and recent messages are sent to the chosen provider. Preauthorized review judgments also send the full assignment, delivery text and execution reports; inputs above the supported limit go to the host.

## Managing Members

From the member panel you can:

- **Invite** members. Codex and Claude can join with an existing session ID, bringing that session's context. Experts invited during a discussion join the end of the current round.
- **Pause, recall or remove** members without pausing the discussion.
- **Change the host** with the crown icon. Changing the host during a discussion pauses it.
- **Reorder speakers** by dragging pending members in the speaking-order list.

Project file access is set per member and is read-only by default.

## Manual Members

- **Manual** — a local member is not woken automatically; it reads and writes with its own credential after you or the host triggers it, and must run `codiscuss member register` before it can be scheduled.

The host of a discussion must be woken locally. Manual members can answer requests scheduled for them.

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
- **Discussion history** — backups include past sessions, conclusions and speaker plans; early version 1 backups can no longer be imported. Import restores them as history; it does not resume active work or wake members. Markdown exports retain the links between plans and answers.

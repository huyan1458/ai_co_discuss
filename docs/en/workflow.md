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
- **Host delegation** — when the host mentions one member, that member replies to you directly, unless the host asks for the work back to hand it on (for example to a reviewer); when it mentions several, the host summarizes after they finish. One message of yours allows up to 8 dispatches and hand-backs by default; change it (1–50) when creating the room, or later under 协作设置 (Collaboration settings) on the room page.
- **Everyone** — `@全体成员` asks all members to answer; `@全体依次` asks them one after another in speaking order.
- **Stop and retry** — stop a member's current run from its menu; failed runs can be resent with one click.

Mentions between ordinary members are references only and do not wake anyone. Members sharing a project directory are not locked; you decide who edits which files, and the member panel warns when two members changed the same file at the same time.

## Discussions

Click **Start discussion** (开启讨论) in the member panel, or check **Start discussion after creating** (创建后开启讨论) when creating a room:

1. Write a goal and set round and time limits (3 rounds and no time limit by default in the web UI).
2. The host breaks down the question and schedules speakers. Experts first give independent views, then respond to each other.
3. When a limit is reached, the host declares the goal done, or you click **End**, the room returns to free collaboration with history and conclusions kept. You can start another discussion later.

You can `@` any member during a discussion without using a round. Your messages go to the host without interrupting the current speaker; to act immediately, click **Skip** (跳过) on the progress board.

### Named Follow-ups

With **Named follow-ups** (点名追问) enabled, the host writes a targeted follow-up for each expert after every round. When disabled (the default), experts read the previous round and respond to each other directly, and the host only steers.

### Limits

| Limit | Description |
| --- | --- |
| Rounds | One round is one viewpoint from every expert |
| Total time | Counts only active time; paused time is excluded |
| Single run | A run that exceeds it pauses the discussion |

The discussion ends when a limit is reached. Reaching a limit does not mean consensus was reached.

## Smart Scheduling

When creating a room, you can add a decision model under **Smart Scheduling** (智能调度) — TypeSafe Jev, with OpenAI Decisions as an experimental option — using your own key, billed per call. Routine routing is then decided by the decision model instead of waking the host every time:

- Unaddressed messages go to the member they are clearly meant for, to everyone, or to no one; otherwise to the host.
- For `@全体成员`, it decides whether members answer together or in order.
- In discussions, it resumes the queue after an interjection and picks the next speaker between rounds.

It acts only when confident, and otherwise hands over to the host. Every decision is shown in the conversation and can be rated. The room title and recent messages are sent to the chosen provider.

## Managing Members

From the member panel you can:

- **Invite** members. Codex and Claude can join with an existing session ID, bringing that session's context. Experts invited during a discussion join the end of the current round.
- **Pause, recall or remove** members without pausing the discussion.
- **Change the host** with the crown icon. Changing the host during a discussion pauses it.
- **Reorder speakers** by dragging pending members in the speaking-order list.

Project file access is set per member and is read-only by default.

## Manual Members and Web Chatbots

- **Manual** — the member is not woken automatically; it reads and writes with its own credential file, triggered by you or by its tool's scheduler. It must run `codiscuss member register` in its own session before it counts as present.
- **Web chatbots** can only read the room. Copy the reading notice from the member panel, then choose **Relay** (代发) in the composer to paste their reply. Web chatbots cannot reach a local address.

The host of a discussion must be woken locally; web chatbots take part in free collaboration only.

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

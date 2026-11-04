# Setup

English | [简体中文](../runner.md)

The local service wakes each agent in its own session, or calls the model API you configured. The site itself never runs models or stores keys.

## Supported Tools

| Tool | Mode |
| --- | --- |
| Claude Code CLI | Auto |
| Codex CLI (0.163.0+) / Codex App | Auto; the app must stay open |
| Antigravity CLI (`agy`) / Antigravity App | Auto |
| Cursor CLI | Manual |
| Model APIs | Auto, see [API Access](#api-access) |

Install and sign in to each tool before use.

## Installation

Requires Node.js 24+ and Python 3.10+.

```sh
npm install --global ai_co_discuss@latest
codiscuss setup
```

`setup` detects local CLIs, saves their configuration, installs the discussion skills, and starts the local site at `http://127.0.0.1:8765` in your browser. In non-interactive environments use `codiscuss setup --yes`, and `--clients codex,claude` to choose tools. If the result reports pending items, resolve them and run `setup` again.

**Upgrade** — run `codiscuss local stop`, then `npm install --global --prefer-online ai_co_discuss@latest` and `codiscuss setup`.

**Uninstall** — run `codiscuss local stop`, then `npm uninstall --global ai_co_discuss`. Discussion data in `~/.codiscuss` is kept.

## Starting a Room

### From the Web UI

Run `codiscuss local open`, click **New Room** (新建房间), add members and pick a host. If a launch fails, refresh the page to continue the original request without creating a duplicate room.

### Browse Project Files

When a room has a project directory, its **Files** page below **Room** lists that computer's files and folders, sizes and modification times. Click a file to open a floating text preview, with rendered Markdown and static HTML views. Rooms without a project directory show a disabled entry.

Other devices read the same directory over the paired computer's encrypted connection. Previews include up to 128 KB and support UTF-8 and BOM-marked UTF-16. HTML previews display inline styles and embedded images. Access stays within the room's project directory.

### From an AI Chat

In the local agent that should host, invoke `discuss-host` and `discuss-participant` and describe the site, topic, participants and limits. The host skill creates the room with your local configuration, and the current session keeps hosting. `agy` cannot host a fully automatic discussion from its own chat.

### From a Hosted Site

If you deploy the site yourself, run this once on the machine running your agents:

```sh
codiscuss local connect https://your-site
```

It binds this computer to the site with a one-time token: generated automatically on the machine that deployed the site (after `wrangler login`); otherwise run `codiscuss token` there first and add `--setup-key TOKEN`. Each token works once. The hosted site has no accounts or passwords and keeps no rooms: every device pairs with this computer first, then reads and writes its rooms through the relay, which must be deployed first (see "Relay" in the [deployment guide](deployment.md)). Revoke with `codiscuss local disconnect https://your-site`.

### From Other Devices

**Pairing** — each phone, tablet or other computer pairs once, in front of this computer; no account or password. On the local page open Settings → Account → Paired devices and choose "Add device" to show a QR code and a 12-character code (valid 2 minutes, single use). Scan the QR code with the new device, or enter the code in the hosted site's settings, then confirm with the device's own face, fingerprint or PIN, which also creates its passkey. The browser keeps a non-exportable device key; the website accepts only devices in the list the computer signs. Devices can be revoked from the computer or another paired device; clearing browser data removes the key and the device must pair again.

Once paired, the "协作房间" directory lists the rooms on the computer, the same as on the computer itself: send messages and attachments, manage members, export backups, with live updates. Conversations stay on the computer; the website only passes encrypted content. Project paths and keys never leave the computer.

- Nothing is listed while the computer is off or codiscuss is not running; the directory heading says the computer is not connected or offline, and the page connects on its own once the computer is back.
- When the computer does not answer in time, the page reports the result as unconfirmed and never resends on its own; check the room before retrying.

## API Access

Flip a member card to **API**, enter a key and choose a model. Official endpoints are preset for OpenAI, Anthropic, Google Gemini, DeepSeek, Alibaba Cloud Model Studio (Qwen) and xAI (Grok); for OpenRouter and other compatible services, enter the base URL and choose Chat Completions.

API members can act as experts or hosts. They have room tools only and no access to local files. Keys stay on your machine, and calls are billed to your account.

## Smart Scheduling

Choose a provider and enter a key under **Smart Scheduling** (智能调度) when creating a room; the local service must be connected. See the [User Guide](workflow.md#smart-scheduling).

## Permissions

Permissions are set per automatically started CLI member and default to read-only. The four levels are read-only, writable, automatic approval, and unrestricted; unsupported levels are disabled (`agy` does not support automatic approval in the background). Read-only pre-approves room-related `codiscuss` commands and answer drafts; writable allows project edits and commands. Automatic approval delegates decisions to the tool, while unrestricted skips permission prompts. Hover over a level for its exact scope. Codex uses its native sandbox, `agy` uses dedicated project rules, and existing Claude Code grants still apply. Manually started members keep their session's own permissions.

## Local Service

`codiscuss local open` also starts the discussion service. One service hosts all rooms; stopping it pauses the discussions it hosts.

| Action | Command |
| --- | --- |
| Open the local site | `codiscuss local open` |
| Show status | `codiscuss local status` |
| Stop | `codiscuss local stop` |
| Restart the discussion service (picks up new environment variables; run it from a terminal that has them) | `codiscuss service restart` |
| Start at login (Windows) | `codiscuss service autostart on` |

## Command Line

Agents also use `codiscuss` to read and write rooms. `codiscuss --help` lists all commands and `codiscuss schema <command>` shows their fields; both work offline.

Discussion turns and everyday collaboration use the same request and execution flow. Automatic members are woken by the local service; manual members read and answer with their own credential. The discussion host reads the current roster before scheduling speakers.

When a host task includes scheduling suggestions, `state decision ROOM DECISION_ID` retrieves the original judgment. A suggestion marked as unapplied still requires the host's own decision.

Hosts can inspect local read-only reviewer configuration with `codiscuss review roster ROOM`. Currently this includes program-started Codex CLI members only. The command does not dispatch reviews or replace permission checks at delivery.

After reading the roster, an implementation dispatch may include `--next-review NAME --review-scope SCOPE --review-roster REVISION` to bind one reviewer to that batch. The reviewer must not be an implementer in the same batch. After completion, the host reads `review ready ROOM --batch ID`, then uses `review advance ROOM --batch ID --revision REV --submission-id UUID --as HOST` to advance the authorized review. Blocked reviews include a reason. Smart Scheduling can perform this step; without it, or on failed or uncertain judgments, the host handles the handoff.

## Troubleshooting

- **A delivery failed** — the room retries automatically up to three times. You can retry immediately or stop it from the failure card. After three failed attempts, the host receives the failure and decides whether to skip, reschedule or pause the discussion; the room does not pause automatically.
- **Codex says the session is in use** — the chat is still held by Codex App; switch the member to the App from the progress board.
- **Windows reports two data paths** — manage the service from a regular terminal, or set `DISCUSS_SERVICE_HOME`.
- **Uncertain results** — tasks that were delivered but not confirmed are never resent automatically; check the original session and the room first.

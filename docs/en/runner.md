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

**Upgrade** — click **Update** on the **Overview** page of the admin panel. To upgrade by hand, run `codiscuss panel stop` and `codiscuss local stop`, then `npm install --global --prefer-online ai_co_discuss@latest` and `codiscuss setup`.

**Uninstall** — run `codiscuss local stop`, then `npm uninstall --global ai_co_discuss`. Discussion data in `~/.codiscuss` is kept.

## Starting a Room

### From the Web UI

Run `codiscuss local open`, click **New Room** (新建房间), add members and pick a host. If a launch fails, refresh the page to continue the original request without creating a duplicate room.

Without a project folder, the room uses the **draft space**: the service creates a folder for the room there (room name plus a short ID) and uses it as the room's project folder. Files that members create are kept there, the **Files** page can browse them, and members can be given write access. The draft space sits next to the service folder by default (`~/.codiscuss-workspace`). Images drawn in a room are sent as message attachments, and a copy is also saved under `images/` in the project folder when members can write to it or the room uses the draft space.

On Windows, running `codiscuss setup` in a terminal offers **Desktop shortcut** in the install options step: it is checked by default when no shortcut exists yet, and shown as **Regenerate** and unchecked when one does (non-interactive runs don't create it). You can also run `codiscuss launcher` at any time to create or regenerate it. It creates the CoDiscuss program with shortcuts on the desktop and in the Start menu; double-click to start the service and open the site. While the service runs, a CoDiscuss icon sits in the notification area: left-click opens the **admin panel** (or run `codiscuss panel`); right-click opens CoDiscuss, restarts or exits the service. The admin panel has two pages: **Overview** shows the local service status (start, restart, stop), checks for and installs new versions (updating your room skills too), and toggles starting at Windows sign-in; **Accounts** lists accounts on the left, and **Administrator** manages your own Claude Code / Codex / Antigravity sign-ins (sign in, switch method, sign out; a Setup Token is recommended for Claude Code), API keys and installed skills (add more from the skill library). The panel only opens on this computer. The first time, turn on CoDiscuss under Settings → Personalization → Taskbar → Other system tray icons so the icon stays on the taskbar.

Everything in the admin panel can also be done from the command line with `codiscuss admin` (`codiscuss admin --help` lists all commands), which suits managing this computer over SSH. `start`, `stop` (a full exit: panel and icon, sign-in entry, tunnel and the CoDiscuss service; hosted accounts' instances keep running), `restart` and `update` work without the panel running; `start` launches in the signed-in desktop session, so the taskbar icon appears as usual. Other commands go through the running panel, with the same effect as clicking in it, and only this computer's administrators can use them. Creating or deleting the Windows user of an isolated account needs administrator rights: run it in an administrator terminal or an administrator's SSH session, otherwise a confirmation pops up on this computer's desktop. If `account add` fails partway, fix the cause and run the same command again; it continues from the missing steps.

**Administrator entry** on the panel's Overview lists your own two ways in: the local page, and the online site you open from paired devices once it is bound. You can also bind and unbind from the command line: `codiscuss admin site status`, `codiscuss admin site connect <site> [binding token]` and `codiscuss admin site disconnect`. People using hosted accounts sign in online only, through the online site or your own domain under **Hosted account entry**.

To let other people use the AI on this computer through their own accounts, check **Hosting** in setup's install options (or pass `--hosting`; `--no-hosting` turns it off; the choice is remembered). The panel then gains a **Hosted accounts** page:
- Click **New account**, enter a name, and keep the default **Isolated** (it gets its own Windows user; the computer asks once for administrator approval). The wizard installs the programs, room skills, system prompt and bundled workflows it needs, starts its site, and shows the password once.
- Click an account to open its page: sign in to its command-line tools, set API keys, pick skills from the skill library, edit its system prompt, start or stop it, and reset its password.
- Drop skill folders or .zip files into the **Skill library**, then choose on an account's page who gets them.
- When CoDiscuss updates, isolated accounts' programs and skills update with it, and running sites restart.

Personal use doesn't need hosting.

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

Once paired, the "协作房间" directory lists the rooms on the computer, the same as on the computer itself: send messages and attachments, manage members, export backups, with live updates, and issue [external member](#external-members-borrowing-an-ai-from-another-computer) invites. Conversations stay on the computer; the website only passes encrypted content. Project paths and keys never leave the computer.

- Nothing is listed while the computer is off or codiscuss is not running; the directory heading says the computer is not connected or offline, and the page connects on its own once the computer is back.
- When the computer does not answer in time, the page reports the result as unconfirmed and never resends on its own; check the room before retrying.

### External Members: Borrowing an AI from Another Computer

Invite an AI on another computer into your room: it reads only the project files you open to it and answers in the room, while it keeps running on its own computer. Below, "your computer" holds the room and the project, and "the other computer" sends the AI; it works the same between two of your own computers.

**Before you start**: both computers install CoDiscuss and run the local service; your computer is [connected to a hosted site](#from-a-hosted-site) with the relay deployed, and the other side reaches your room through that site's encrypted relay. While your computer is off or codiscuss is not running, the other side gets nothing.

**Invite (your computer)**:
1. In the new-room panel or Invite members, click "External expert +" on the External row (once per expert), then on the card's back select the access, folders and membership duration after check-in.
2. Choose Add a seat awaiting check-in (automatic when creating the room). The seat appears immediately in the right-hand roster; share its link, QR code or pairing code. The link lasts 10 minutes and binds one member; regenerating it invalidates the previous link. Without a connected hosted site, the seat shows that it is waiting for a link and explains why; generate it from the seat menu after connecting. Before check-in, the panel shows the automatic expiry deadline and Remove seat. Usage, read logs and access adjustments appear after check-in.
3. Redemption completes check-in and starts the membership duration, with **no extra approval step**. Pending seats receive no work and do not participate in group replies or discussions; they end automatically after 7 days. An expired link leaves the seat intact.
4. `@` it in the room; its answers appear in the conversation as usual. "Read log and access" in the member menu lists every file it read (recorded by your computer) and lets you extend, downgrade to discussion only, or revoke; revoking takes effect immediately.

**Join (the other computer)**:
1. Open the link and choose "Join with CoDiscuss on this computer" to go to the local page; or choose "+" under "Invited rooms" in the left panel and paste the link or pairing code; or run `codiscuss join <link or code> --adapter TOOL`. A pairing code also needs the inviting site's address.
2. Pick the AI, model and effort, and a trust level:

| Trust level | When named | Local AI |
| --- | --- | --- |
| Default | Woken only after you approve in the right panel each time; declining, or 15 minutes without an answer, shows "Not accepted by the other side" in the room | Limited to CoDiscuss commands, running in an empty temporary folder |
| Full loan | Woken directly, within a wake count and time limit (20 wakes and 1 day by default); once used up it goes back to asking each time | Same as above |
| Trusted computer | Woken directly, no limits; later invites from that computer are accepted at this level | Unrestricted: local files and network tools available |

You can change the level and limits later in the invited room's right panel, or pause or leave; `codiscuss invited` offers the same commands. Trusted computer can be set only on the other computer itself; a paired phone or tablet can choose only Default or Full loan. The local service does the waking, so keep codiscuss running.

**Supported tools**: Default and Full loan need a tool that can be limited to CoDiscuss commands. Claude Code (background runs) supports it, tested on version 2.1.325 (other versions not individually checked), and so do model APIs, backed by unit tests; Codex and Antigravity do not support it and can serve only at the Trusted computer level; desktop apps cannot join as external members.

**What it can read**: files Git tracks in the opened folders (including uncommitted changes, skipping files in `.gitignore`); in a folder without Git, every file except generated folders such as `node_modules`. `.env`-style files, private keys and certificates, credential files, `.git`, and `data/` at the root of an opened folder are never opened; links pointing outside the folder are refused. It can only read: no writing files or running commands, and no private chats, other rooms or local paths. Each read returns at most 128 KiB; by default 4 MiB per hour, 64 MiB in total and 600 reads per hour.

**Keep in mind**:
- What it reads cannot be taken back: it stays in the other AI's session and reaches the other side's model provider; revoking only stops later reads.
- If someone else uses an invite first within its 10 minutes, they become a member, and only revoking after the notice fixes it. Send invites only to people you trust.
- A pairing code carries no key fingerprint for your computer, so the other side cannot check it reached you; prefer the link or QR code.
- At Trusted computer the other AI is unrestricted, and content in your room may lead it to read files on that computer; use it only between your own computers.

## API Access

API members do their room work in [Pi](https://github.com/earendil-works/pi), which codiscuss installs during setup into its service folder. Its version is the one this codiscuss release was tested with and changes only when codiscuss is upgraded (a new version is used only once it starts correctly). To use your own build, point the `CODISCUSS_PI_CLI` environment variable at its `dist/bundle/cli.js`. Pi gets only the room and file tools codiscuss hands it and ignores your own Pi configuration. Each API member keeps its own session, so it remembers earlier work and its session rewinds with the conversation. Several API members can use models from different providers at the same time. Private chats do not go through Pi.

Choose **OpenAI** in the member picker, flip its card, enter your official OpenAI API key and choose a model. Its default endpoint is `https://api.openai.com/v1` with the Responses protocol. Existing Codex cards still support API access.

Choose **自定义 API** (Custom API) for another service, then enter its base URL, API key and full model ID. It defaults to Chat Completions and also supports Responses, Anthropic Messages and Gemini generateContent. Use the name and description button on the card's back to set a display name; add the slot again to configure multiple independent members. Official presets for Anthropic, Google Gemini, DeepSeek, Alibaba Cloud Model Studio (Qwen) and xAI (Grok) remain available.

API members can act as experts or hosts. When the room has a project folder, read-only members read and search its files through file tools the runner provides (secret files such as `.env` and private keys, the `.git` folder and the local service folder are not available); with writable project access they work like Claude Code and Codex, with Pi's own read, edit, write and command line, so they can run tests, builds and git, and can also reach any file your account can on this computer. At both access levels they can search the web and read public pages (search reads the public result pages of 360 Search and Bing and needs no key; local and private network addresses are refused). Whatever they read is sent to the model provider you configured. Keys stay on your machine, and calls are billed to your account. To let an API member see images, turn on image input in its card's API settings (only when the model supports it, otherwise requests fail); without it the member cannot see image content. API members can always read UTF-8 text attachments on demand; PDFs and other files are not readable for them, and their answers say so.

## Smart Scheduling

Choose a provider and enter a key under **Smart Scheduling** (智能调度) when creating a room; the local service must be connected. See the [User Guide](workflow.md#smart-scheduling).

## Permissions

Permissions are set per automatically started CLI member and default to read-only. The four levels are read-only, writable, automatic approval, and unrestricted; unsupported levels are disabled (`agy` does not support automatic approval in the background). Read-only pre-approves room-related `codiscuss` commands and answer drafts; writable allows project edits and commands. Automatic approval delegates decisions to the tool, while unrestricted skips permission prompts. Hover over a level for its exact scope. Codex uses its native sandbox, `agy` uses per-session permission rules, and existing Claude Code grants still apply. Manually started members keep their session's own permissions. When the owner turns on full host control for a room, the host can invite members using software already configured on this computer: project access defaults to read-only and is at most writable, and inviting a member who is away brings it back under its original name.

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

CLI help and command messages follow the system locale: Chinese for locales starting with `zh`, English otherwise. Set `CODISCUSS_LANG=zh-CN` or `CODISCUSS_LANG=en` to override it (for example, `$env:CODISCUSS_LANG="en"` in PowerShell or `CODISCUSS_LANG=en codiscuss --help` in a POSIX shell). Some shared interactive controls and messages supplied by other modules still appear in Chinese. Room read/write commands intended for agents keep their existing language.

Messages generated by a running admin panel use its startup environment. To change those, restart the panel from a terminal with the desired `CODISCUSS_LANG`.

Agents also use `codiscuss` to read and write rooms. `codiscuss --help` lists all commands and `codiscuss schema <command>` shows their fields; both work offline. An AI member that wants to know where it stands runs `codiscuss execution status`: whether its execution can still answer, the requests it must answer with their questions and reading bounds, and whether its own answer has been saved. `message post --help` lists only the options an ordinary member can use; the host's dispatch options (relays, loops, checkpoints, reviews, continuation, round requests) are shown by `--help-host`.

Discussion turns and everyday collaboration use the same request and execution flow. Automatic members are woken by the local service; manual members read and answer with their own credential. The discussion host reads the current roster before scheduling speakers.

When a host task includes scheduling suggestions, `state decision ROOM DECISION_ID` retrieves the original judgment. A suggestion marked as unapplied still requires the host's own decision.

Hosts can inspect local read-only reviewer configuration with `codiscuss review roster ROOM`. Currently this includes program-started Codex CLI members only. The command does not dispatch reviews or replace permission checks at delivery.

After reading the roster, an implementation dispatch may include `--next-review NAME --review-scope SCOPE --review-roster REVISION` to bind one reviewer to that batch. The reviewer must not be an implementer in the same batch. After completion, the host reads `review ready ROOM --batch ID`, then uses `review advance ROOM --batch ID --revision REV --submission-id UUID --as HOST` to advance the authorized review. Blocked reviews include a reason. Smart Scheduling can perform this step; without it, or on failed or uncertain judgments, the host handles the handoff.

## Troubleshooting

- **A delivery failed** — the room retries automatically up to three times. You can retry immediately or stop it from the failure card. After three failed attempts, the host receives the failure and decides whether to skip, reschedule or pause the discussion; the room does not pause automatically.
- **The local runner restarted** — it waits if the original app process is still running. Once that process has ended, it checks the site and the exact delivery record without sending the task again. A confirmed completed turn can have its eligible answer captured automatically; no answer is reported as missing, and uncertain outcomes fail with “Unable to confirm the previous run outcome after restart”. You or the host decide whether to retry.
- **Codex says the session is in use** — the chat is still held by Codex App; switch the member to the App from the progress board.
- **Windows reports two data paths** — manage the service from a regular terminal, or set `DISCUSS_SERVICE_HOME`.
- **Uncertain results** — tasks that were delivered but not confirmed are never resent automatically; check the original session and the room first.

- **Failure advice** — the card keeps the original reason. For exhausted quota, wait for reset or reassign; for expired login, sign in locally; for output limits, shorten or split the output; for failed context compaction, shorten or split the input (the next run starts a new session); for a policy refusal, review the content and service requirements before retrying. Compaction failures and policy refusals neither trigger automatic retries nor place quota holds.

# FAQ and settings index

Find answers to common questions about getting started, troubleshoot a run, or jump to the guide for a setting.

## Ten questions about getting started

### 1. Can I use a web chatbot or Cursor?

The ChatGPT, Claude, and Gemini web apps cannot join a room as members. You can use a model provider's API key (for example OpenAI, DeepSeek, Claude, or Gemini), or install and sign in to a supported local tool such as Claude Code, Codex, or Gemini. Cursor CLI can use an existing manual seat: select “Manual start” on a supported card, then register, check requests, and post answers in the Cursor window. See [manual connections](members.md#manual-connection) and [prerequisites](first-run.md#before-you-start).

### 2. What does it cost?

CoDiscuss itself is free and open source. Local AI tools use your existing subscriptions or account allowances. An online site can run within Cloudflare's free tier. Local read-aloud and dictation incur no usage fee. Providers bill model APIs, smart scheduling, web search, image generation, and cloud speech to the account associated with the key you supply.

### 3. Which operating systems can I use?

Windows, macOS, and Linux support the local site and service, launching local AI tools, model APIs, and access through an online site. Use Node.js 24+ and Python 3.10+. The desktop shortcut, tray icon, startup at sign-in, separate operating-system users for hosted accounts, and entry protection are Windows features. Use `codiscuss` in a terminal on macOS or Linux.

### 4. What should I do first?

Open `http://127.0.0.1:8765`. Choose **New room**, enter a **Topic**, then select **Add AI** and choose a configured member. Check that its card has a crown and choose **Create and connect**. Type `@`, select the member, and send a short test message. A reply in the room confirms the setup works. [Create a room and get a reply](first-run.md#3-create-a-room-and-get-a-reply).

### 5. When should I use a room, a discussion, Goal, or a workflow?

- **Ordinary room.** Mention a member directly or let the host assign work. Members finish their assignments and wait for you.
- **Discussion** (`/discuss`). Set an objective and limits when you want several members to develop independent views and respond to each other's arguments.
- **Goal** (`/goal`). Set an outcome when you want the host to resume work as the room becomes idle, until it finishes, gets blocked, or reaches its budget.
- **Workflow.** Reuse a saved set of roles, member cards, and instructions in another room.

A room can run either a discussion or Goal at a given time. You can use a workflow alongside either one or in an ordinary room.

### 6. How much protection does read-only project access give me?

Project access defaults to read-only. Read-only API file tools restrict access to the project. Codex CLI write restrictions depend on sandbox availability. Existing Claude Code grants and the original project permissions of an `agy` session affect what those tools can do. Codex App, Antigravity App, and manually connected members retain the original tool's permissions. Rewinding the conversation leaves changes to project files in place. [Project permissions by tool](members.md#what-project-permissions-can-enforce).

### 7. How can I limit token and account usage?

Each member receives the current question and a way to read the room, then retrieves the history it needs. To control spending across members, lower the **Assignment round limit** and **API request limit** during room creation or under **Collaboration settings**. Give discussions round and time limits. For Goal, set a continuation limit and time limit under **Advanced settings**.

### 8. Can I keep using my AI tool while it works in a room?

Yes. New room sessions run independently of conversations you open in your IDE or terminal. When you select a CLI session from **History**, the tool copies it to a new session. Subsequent room messages appear in that copy. Codex App uses the selected conversation directly. Avoid issuing instructions to the same App conversation from both places at once.

### 9. Where is my data, and how do I move it to another computer?

The default service directory is `~/.codiscuss`. It holds the website database (`local/discuss.sqlite3`), settings, keys, presets, and workflows. Rooms created without a project folder use `~/.codiscuss-workspace` for their files. Use **Export conversation** or **Export all rooms** to create a room backup ZIP. On the other computer, select **Import rooms…**. To move a workflow, copy its folder from `~/.codiscuss/workflows/`.

### 10. What happens if the computer shuts down, sleeps, or loses internet access?

Shutdown and sleep interrupt local execution. During an internet outage, the local service may keep running, but phones cannot reach it through the online site and tasks requiring a model connection may stall or fail. After the computer and service restart, phones with valid authorization reconnect without pairing again. Interrupted tasks are not automatically rerun. Check the room for answers and failure cards before retrying.

## Troubleshooting

- **A member does not respond or keeps waiting.** Run `codiscuss local status`. If other work is in progress, look for the new message in the queue above the composer. For a stuck room, run `codiscuss room events <ROOM_ID>` to see what happened.
- **Delivery failed.** Read the original cause on the failure card. If sign-in has expired, sign in again in the AI tool or under **Account → CLI sign-ins** in the admin panel, then choose **Retry now**. Delivery can retry automatically up to three times.
- **Quota exhausted.** Wait for the quota to reset, switch the member's model under **Room → Members and settings** in the tabs at the top of the room, or reassign the work.
- **Output limit or context compression failure.** For an output limit, ask for a shorter answer or split the task. For a compression failure, shorten the input. The next run starts a fresh session.
- **Provider policy refusal.** Review the content and the provider's requirements before trying again. Policy refusals and compression failures do not trigger automatic retries.
- **Codex reports that the session is in use.** Codex App may already have the conversation open. Switch the connection to Codex App in the right sidebar or under **Room → Members and settings** in the tabs at the top of the room, or use a fresh session.
- **A run has an unknown outcome after restart.** If the original process has exited, the service checks the records. It collects an eligible answer when it can confirm normal completion. If you see **Unable to confirm the previous run outcome after restart**, check the original conversation before retrying.
- **Windows reports two data directories.** Manage the service from a regular terminal, or set `DISCUSS_SERVICE_HOME` explicitly so both processes use the same directory.

## Settings index

| Section | Controls | Where to learn more |
| --- | --- | --- |
| Account | Set up admin account, Sign in, Sign out | [Python deployment](../deployment.md#python) |
| Account | Display name, Change avatar, Site sessions, Change password | Manage the administrator account on a self-hosted Python site. At `127.0.0.1` you have administrator access automatically. |
| Account → Paired devices | Add device, Temporary device (1 day of access), Allow access without a passkey, Pair this device, Activity, Unpair | [Pair a phone or tablet](remote.md#2-pair-your-phone-or-tablet-while-at-the-computer) |
| Appearance | Channel, Channel · Light | Choose a theme. Changes take effect immediately. |
| Language · 语言 | 简体中文, English | Choose the display language. Changes take effect immediately. |
| Conversation width | Narrow, Default, Wide | Set the width of the conversation for reading. |
| Card text size | Small, Medium, Large | Text size inside message cards. Medium is the default; the choice applies to this device only. |
| Visual effects | Full, Compact | Compact turns off background blur and layered shadows for smoother scrolling on slower devices. |
| Folding long answers | Relaxed, Standard, Eager | How long an answer must be before it folds, and how much stays visible, measured against the screen height. Relaxed is the default; the choice applies to this device only. |
| Room preferences → Host's project access | Read-only, Can write, Automatic, Full access | The project access the first member added to a new room (the host by default) starts with; Read-only by default. If its software doesn't support the chosen level, it stays read-only. Saved in the local service, kept across updates; needs the local service connected. |
| Speech | Text-to-speech service, General voice, voices by platform and for files, Speed, Tone, Voice input, Local process | [Local and cloud speech](voice.md#read-aloud-and-voice-input-local-and-cloud-options) |
| WeChat notifications | Scan to link, Send test, Unlink | [WeChat notifications](voice.md#wechat-notifications) |

The site controls animations for work status, member card flips, and opening, minimizing, or switching the layout of the file preview window. Your system's reduced-motion setting does not change these animations. The hosted sign-in page always plays its brand animation.

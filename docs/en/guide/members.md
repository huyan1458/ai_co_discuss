# Members

Manage room members: invite local apps or model APIs, resume existing sessions, change models and permissions, choose a host, or let an already-open local AI conversation join manually.

On the Room tab you can update several members in succession. Access, model and attendance changes appear immediately. If a save fails, the page restores the previous setting and explains why.

## Invite members

### Steps

1. **Add a local app.** When creating a room, open “Who takes part” and choose a configured app under “Add AI”. In an existing room, select “Invite AI” from the right sidebar or under **Room → Members and settings** in the tabs at the top of the room. Choose one or more members and select “Invite”. You can add several members from the same app. Each has its own session.
2. **Add a role preset.** Choose a preset from “Presets” below “Add AI”. When creating a room with a project or inviting members into a room with project folders, use “Project presets” to choose a preset from the main project or an extra folder. A preset supplies the description, private prompt, project access, and model. A preset member is started by the service (a new or resumed session) and cannot use “Manual start”. Select “Manage” to remove unused presets from a writable location.
3. **Add a model API.** Under “Add AI”, choose Claude, Gemini, DeepSeek, Qwen, Grok, OpenAI, or “Custom”. If a provider offers both a local app and an API, flip the member card and select the API under “Connection”. Official presets fill in the service address. Local API members on unrestricted tasks can read an overview, messages, events and attachments from another room on the same site by room ID.
   An API member can spend up to 45 minutes on a room task. It also stops after 15 minutes without model or tool progress. The execution card shows the reason.
   To troubleshoot, open “Runs” in the room sidebar, choose “Waterfall”, and open “Run diagnostics” for the run. The room service records the last heartbeat, while the member’s software reports the last model or tool activity. Model request retries, adapter restarts, and runner redelivery have separate records. An interjection confirmation time requires a matching receipt from the software. Older runs and software without the relevant data show “Unknown”.
4. **Configure and check the API.** Flip the card using its “Settings” area and fill in “Address”, “Protocol”, “Key”, and “Model”. If the selected model supports images and should read image attachments, enable “Images”. Select the lightning button to check the configuration. “Check passed: the model responded” means it is ready. Select “Done” to return to the front of the card.

### Save and reuse project presets

On the back of a member card, select the bookmark to “Save as preset”. In “Save as expert preset”, under “Save to”, choose “Global” to reuse it across projects or “Current project” to keep it with a project. If several folders are writable, choose one under “Target project”. On a card added from a preset, select “Update preset” to save changes. To edit the skills of a preset that has them, open “Advanced settings” on the card.

A preset from an untrusted project that requests write access is added as read-only by default. Review the requested access before allowing it on the card. You can use presets from read-only project folders and save changes to a writable location.

## Resume an existing session

Use “History” to bring context from an existing local AI conversation into a room. This is supported by Claude Code, Codex, and Gemini (the Antigravity CLI, `agy`).

### Steps

1. Add a member while creating a room or inviting AI, then change the member card’s launch mode to “History”.
2. In the session picker, browse sessions by date, search by keyword, and choose whether to show only sessions for the current project or all sessions. Select a session to preview its latest messages.
3. Select the session with “Resume this session”, then finish creating the room or inviting the member.

### Notes

- For Claude Code, Codex CLI, and `agy`, the local service copies the selected session and continues in the copy. Room messages are kept in that copy.
- Codex App uses the selected conversation directly. It does not create a copy.
- Antigravity CLI keeps the selected session’s original project directory and `agy` permissions. The room’s project permissions do not apply to it.

## Change a model, name, or private prompt

- **Model and reasoning effort.** Set these on the back of a member card when creating a room or inviting a member. In an existing room, open **Room → Members and settings** in the tabs at the top of the room and find the member. Change the model or effort, or refresh the model list. Changes take effect on the next run. For app connections, choose the model and effort in the app itself. Where supported, you can switch between CLI and app connections here. A manually connected member that is now woken by this computer shows “Existing session” next to its connection. It keeps its original session’s project access, but you can still change its model and effort here. While its own window is open, tasks go straight into that window and run with the window’s model; this setting applies once the window is closed. Until a change has been used, the model field shows the model that last ran followed by “(set to …, applies from the next run)” or “(set to …, applies once its own window is closed)”.
- **Display name and role description.** Open the member menu in the right sidebar and select “Name and description”. When adding a member, use the name and description button on the card. On cards that flip, these settings are on the back. Change the room display name and role description. Inside a room there are quicker ways: double-click a member’s name in the right sidebar or on the members and settings page to rename it in place (Enter or clicking elsewhere saves, Esc cancels). Member rows in the right sidebar do not show descriptions: point at a member with the mouse and its member card floats out on the left with the description and an “Edit name and description” button; on a phone or tablet, tap the member row and the menu that opens shows the description at the top. In the editor, click a common kind of work to add it. The host and smart scheduling use the description to route work. You can also save it as the app’s default description.
- **Private prompt.** When creating a room or inviting, flip the member card and select “Expert prompt” on its back. For a member already in the room, point at it in the right sidebar and select “Expert prompt” on the member card that floats out; on a phone or tablet, tap the member row and choose “Expert prompt” in the menu. Write instructions for this member alone, such as “Start with the conclusion”; they apply from its next wake-up. This does not change its permissions. A member from a workflow shows its prompt read-only; change it in the workflow. Manually started and external members have no private prompt.
- **System prompts for all members or one platform.** In **Settings → System prompts**, the “All members” row goes to every member this computer wakes, and each platform row (Claude, Codex, Gemini, DeepSeek and so on) goes to every member on that platform, including preset and workflow experts. They come before the private prompt and apply from the next wake-up. The software’s own CLAUDE.md and AGENTS.md are not changed, so using that software outside CoDiscuss is not affected. From the command line, use `codiscuss launch prompts`.

## Set the host, pause participation, invite back, or remove

The Room tab lists present members first. Members who have stepped away appear in a separate group below, expanded by default. Select its heading to collapse or expand it. Each card still offers actions such as inviting the member back.

To change the default speaking order, drag a present member’s handle and release it at the insertion line. The handle is on the right of the card header on phones and on the left on desktop. With the handle focused, press Up or Down to move the member one place. Press Esc during a drag to cancel.

- **Choose the host.** When creating a room, select the crown on a member card. In an existing room, open the member menu and select “Make host”. Changing the host during a discussion pauses it. The new host's project access is raised to match the previous host: it gets the highest level its own software supports that does not exceed the previous host's (for example, if the previous host had “Automatic” and the new host's software has no such level, it gets “Can write”). Access is only ever raised, a notice in the lower right says what changed, and the previous host keeps its own. Change it back in the member table if that is not what you want.
- **“Leave”.** In the right sidebar, open the member menu and select “Leave”. The member becomes “Away”, stops receiving work, and its pending requests are canceled. Its session is kept.
- **Invite an away member back.** Select “Invite” from that member’s menu, or open “Invite AI”, select the away member, and select “Invite”. The member returns with its existing session.
- **“Remove”.** In the right sidebar, open the member menu and select “Remove” to take the member out of the room. During a discussion, the current host cannot leave or be removed.

## What project permissions can enforce

Project permissions are set per member and default to “read-only”. The available levels are “read-only”, “Can write”, “Automatic”, and “Full access”. Unsupported levels appear disabled.

When a read-only member sends a file or downloads an attachment with CoDiscuss commands, the paths are limited too: files it sends must come from the project, extra folders, drafts, skills or its own runtime folder, and attachments can be saved only in its draft, knowledge or writable extra folders. This applies to every app.

| App or connection | Available levels | What the permission actually enforces |
| --- | --- | --- |
| **Codex CLI** | Read-only, Write, Automatic, Full access | When the native sandbox is available, Read-only blocks writes and Write allows writing in project directories. Reads may reach beyond those directories. |
| **Model API** | read-only, Can write | Both use the tools provided by Pi, the local runtime for API members. Read-only is enforced by the local service: reading is limited to the project, extra folders, drafts and skills, writes are allowed only in the draft folder and writable extra folders, and commands only as CoDiscuss commands. On Windows, Git for Windows is required (Pi runs commands with Git Bash); without it the task shows as not delivered with the reason. Write is not restricted and can reach files available to your local account. Members lent to a room on another computer are confined separately. |
| **Claude Code CLI** | Read-only, Write, Automatic, Full access | Read-only pre-approves the room’s `codiscuss` commands and draft directory. Write permits project edits and commands. Automatic lets the app review actions. Full access skips confirmation. Existing Claude Code grants also apply. |
| **Gemini (Antigravity CLI, `agy`)** | Read-only, Write, Full access | Session-level permission rules control reads and writes. The background connection does not support Automatic. |
| **Codex App, Antigravity App, and manual connections** | Existing app settings | The service cannot enforce permissions outside the app. The task states the requested limits, but the app’s settings determine actual access. |

When a member’s working directory is outside all room project directories, it works in its own directory. Check the member card’s room-directory permission. If it says “read-only (asked in the task only; not enforced)”, the app may still write to a room directory. Actual enforcement depends on the connection, permission level, and sandbox availability.

## Manual connection

Use a manual connection to bring an already-open local AI conversation into a room. The AI must be able to run `codiscuss` in its own window, and its member card must offer “Manual start”. Local cards for Claude, Codex, and Gemini offer this option. Grok’s API card does not offer “Manual start”.

**Using Cursor CLI manually.** Select Cursor in setup to install the participation skills. The website has no dedicated Cursor card. Add a Claude, Codex, or Gemini card, select “Manual start”, set its “Display name” to Cursor, and privately give its start command to the Cursor CLI conversation you want to use. Register there, check for requests, and answer by request ID as described below. Registration checks the seat credential. Renaming the seat changes its display name only. Its platform stays the one you chose, and CoDiscuss does not automatically wake or take over the Cursor conversation. `codiscuss member register` registers an existing invitation. There is no dedicated `member add` command for creating a Cursor identity.

### Steps

1. **Add the member.** In a new room, choose “Manual start” on a supported card under “Who takes part” → “Add AI”. In an existing room, select “Invite AI”, choose the member and “Manual start”, then select “Invite”. The room sidebar shows “Not registered”.
2. **Copy its start instructions.** Use “Copy start command” beside the unregistered notice above the composer or on the invite result page. The button briefly reads “Copied”. The member menu also offers “Copy launch command (with credentials)”.
3. **Register from the original window.** Privately paste the instructions into the AI conversation. It will first run `codiscuss room view`, then `codiscuss member register`. The copied instructions supply the room, identity, and credentials. “Not registered” disappears. An idle manual member appears as “Registered”.
4. **Send it a task.** In the room composer, type `@`, choose the member, and send a question. If the connection requires a manual trigger, return to its registered window and ask it to read its pending room request, complete the work, and post its answer to that request. It uses `codiscuss room view` to read the request and `codiscuss message post --request <request-id>` to bind the answer. If the page says delivery is in progress or retrying, check the execution status before resuming the same session elsewhere.
5. **End participation.** In the right sidebar, open its member menu and select “Leave” to pause participation and cancel pending requests. Select “Bring back” when it should return, then copy a new start instruction to the original window to register it again. Select “Remove” to take it out of the room.

### Notes

- **Keep credentials private.** Start instructions contain private credentials. To avoid pasting them into a chat, use “Download private configuration” in the member menu, save the file locally, then give the AI the “Copy participation instructions” text and the file’s full path. Never post the config file or start instructions in the room.
- **Original-window behavior varies.** Codex can receive work through the App queue. Whether an existing Claude Code window receives work live depends on its session inbox. After an Antigravity CLI session continues in the background, an already-open window may need a restart to show new messages.
- **Permissions and history.** Manual members keep the original session’s model and permissions. Withdrawing or rewinding a message in the web app does not undo project-file changes. Discussions and Goals require a host that the local service can wake automatically.
- **Skip one discussion turn.** While a discussion is active and a turn is assigned, the room owner can select “Skip” in the discussion controls. Directly mentioning a member in a regular room does not show this control.

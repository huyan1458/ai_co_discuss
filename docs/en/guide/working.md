# Working in a Room

Message a member or host, understand main and branch work and assignment labels, manage queued messages, and use private chat, interruptions, stopping, rewind, and answers to member questions.

## Steps

### 1. Message and mention members

- **Mention members.** Type `@` in the composer at the bottom of the page, choose one or more members, enter a task, and press `Enter` to send. Use `Shift+Enter` for a new line. Mentioned members work in parallel. You can also type `@` to find and quote files or folders in a project directory.
- **Use a member’s local skills.** After selecting `@member`, type `/` to find skills installed in that member’s local AI app. Click a result or press `Enter` or `Tab` to insert it into the draft. Typing `/` on its own lists modes, workflows, and platform skills.
- **Send without a mention.** The host routes messages without an `@` mention. If the room has only one member, the message goes directly to it. With smart scheduling enabled, a message clearly addressed to one member may go directly to that member.
- **Ask all members.** Type `@all` to have everyone present answer in parallel. If the room has a host, it first answers on its own like everyone else, then, once all answers are in, sums up where they agree and differ and arranges follow-up work if needed. Type `@all-seq` to have members answer in the order shown in the sidebar’s “Speaking order”.
- **Check the hint before sending.** The line under the composer says what sending will do, given who is busy right now: when the mentioned member is free it reads “Goes to … now, alongside the work in progress (a branch)”; when it is busy it says the message waits in the queue; with nobody mentioned while the room is busy, it suggests mentioning a free member to have it start right away.
- **Reply, search, and filter.** Use “Reply” in a message menu to link a reply to the original. Clicking a `#number` anywhere (in messages, the brief, executions or the event log) jumps to that message in the conversation; click “Back to where you were” to return. At the top of the room, “Search messages” searches the conversation and “Filter messages and cards” filters by author, host, mentions, or card type.

- When you send an image, the page keeps its local preview. The message receipt and member status updates preserve your reading position after sending.
- **Send several messages in a row.** You can send the next message while the previous one still shows “Sending…”. If the room is busy and a message is expected to queue, it appears immediately above the composer. The confirmed queue entry takes its place. The browser submits messages in order and continues if one fails. The failed card keeps the original text and attachments so you can resend or discard it. Sending and network retries continue if you switch rooms. Return to the original room to find its failed cards. Refreshing or closing the page clears unsent messages held by that page.

Once the site returns a message number, known recipients appear below the message. If an automatically connected member is busy and the request must wait for its current task to finish, a one-line notice with a clock shows the member’s name and the queued message number. Hover over the notice to see how long the request has waited. The working card takes its place when the member starts. If smart scheduling needs to choose the recipient, the page shows scheduling progress.

Quick navigation on the left lists messages from users and members. Hover over a mark to preview the message or click to jump to its card. In the right sidebar's “Speaking order”, open a member row's “…” menu or right-click it and choose “Jump to latest message” (on a phone or tablet, tapping the row opens this menu; on a computer, the member card that appears when you hover over the row has the same button) to jump straight to that member's latest message or ongoing work card.

### 2. Understand main lines, branches, and assignment labels

Room work can run on several lines in parallel. Labels at the top of a card show which line the work belongs to and what should happen when it finishes.

- **Main line and branches.** The host’s speaking order, including a sequential handoff, and your `@all-seq` messages are on the **main line**. You or the host directly mentioning a member creates a **branch**. A branch does not use a place in the speaking order and can run alongside the main line.
  - A directly mentioned member starts immediately when idle. If busy, its request waits in the queue until it is free. If one message mentions both idle and busy members, idle members start at once while the busy members’ work waits.
  - When a main-line member’s turn arrives, it waits for that member to finish its active branch work.
  - Your unmentioned messages, `@all`, and `@all-seq` wait until the room is idle, then go out in order. Background work assigned by the host does not hold up your new messages.
- **Where things sit on a card.** Every member card has, from top to bottom: the header, the body, what it delivers (answer summary, attachments, delivered files) and the run’s record (progress notes with step count, file changes, refused operations). File changes list only files the member was recorded writing during that run. Git files in the main project and additional writable projects support diff previews. The execution timeline counts the same files. The left of the header says who: the name, labels, and the model and effort this run used. The right says how this one went: status, time, number and duration, with the duration always last. A coloured status only means something went wrong (red for failed; amber for stopped, voided or skipped), and nothing is shown when all is well; on your own messages, the right shows how each member is handling it. On a phone, the buttons for retracting, editing, private chat and the like sit at the top right of the card, level with the name; the model, status, time, number and duration run from the left under the name. Stop and retry sit at the right end of the line they act on. Project files mentioned in an answer appear as clickable cards once verified as deliverables for that execution; a web page card also has “Open in new tab”, which shows the page whole in an isolated tab: on this computer it opens straight from disk with the images and scripts beside it, at any size; on other devices it is read through the computer, up to 64 MB (the preview window shows pages of the same size).
- **Card labels.** Where the card came from comes first, then where the work goes next. The usual channels (own message, CLI, API) are no longer labelled; only rare sources such as sent on someone’s behalf, proactive messages and auto-captured answers are.
  - “Host” identifies a message from the current host, host notes included.
  - “Main line · step {n}” is a host-arranged order. “Main line · #{n} in turn” is `@all-seq`.
  - “Branch” marks a directly mentioned member’s work that started while another member was working. Mentioning a member in an idle room is not marked. Failed and stopped cards keep these labels.
- **Model and reasoning effort**: a member’s answer card, working card, failed card and stopped card show the model and effort that run actually used (for example `gpt-6.2-sol · medium`) after the name and labels, and so does a run’s detail on the Runs page. It records what was used at the time, so changing the member’s model later does not change older cards; when it cannot be read (an external member, for example) nothing is shown. On a phone, when space runs short only the start of the model ID is cut, keeping its end and the effort.
- **Labels on the host’s work assignments.**
  - “Back to the host when done”: wake the host when all assigned members finish, including failures, so the host can decide what to do next.
  - “Straight to you when done”: give you the member’s answers without returning to the host. Failures still go back to the host.
  - “Background, not handed back”: no one waits for this background work. On success, it is not returned; on failure, the host is notified.
  - “Relay, back to the host at the end”: hand work from one member to the next in order, then return the final result to the host.
  - If an assignment also includes background members, it shows “Also in the background: {value1}”.
- **Continuous assignment limit.** A message can let the host continue for up to 10 rounds by default. At the limit, it stops automatically. Select “Continue” in the sidebar to proceed. If the host requests more rounds in advance, the sidebar shows its reason. Select “Approve” to allow the requested continuation.

### 3. Manage queued messages

New messages wait above the composer while the intended member or room is busy. They are sent when the recipient or room becomes available. Your answers on an answer card work the same way: while the member who asked is still busy, the answer is recorded, but the share for that member waits in the queue, marked “#N is posted; it goes to … once free”.

- **Not waiting.** Select the send button on a queued item (on desktop it shows “Send now”, “Steer”, or “Interrupt and send”; on phones it shows the arrow icon alone); hover over it to see what it will do:
  - The recipient is free: it goes at once.
  - The recipient is working and its software takes interjections: this joins its current turn; it sees it right away and the work done so far stays. A message steered directly into the same task appears indented below the original user message with a “Steer” label. A message that interrupts work first keeps its own card.
  - The recipient is working and cannot take an interjection: its turn is stopped first, and it takes this together with the interrupted work.
  - The recipient can neither take an interjection nor be stopped: selecting it explains why and the message stays queued.
- **Edit or delete.** In a queued, unsent item’s menu, select “Edit message” to return it to the composer for editing, or delete it.
- **Reorder.** Drag queued items. On a phone, press and hold an item to move it.
- **Pause and resume.** Selecting “Stop all” or stopping the service pauses the queue. It shows “Queue paused: you stopped the run”. Select “Continue” to resume. A failed message pauses the queue and shows the reason. Select “Retry”, edit, or delete the message to continue.
- Queuing is always on and has no switch; to have a busy member take a message right away, select the arrow button on the queued item.

### 4. Stop, retry, withdraw, edit, or rewind

- **Stop a run.** Select “Stop” on an in-progress card, or select “Stop” from a member’s menu in the right sidebar, to stop that member’s current run. Select “Stop all” in the sidebar to stop all members and cancel requests not yet delivered. When the local service confirms process exit, the card shows “Stopped”. If it cannot confirm, it shows “Stop unconfirmed”. If an app or manual session cannot be stopped, it shows “The previous run is invalidated but may still be generating”. A late answer does not enter the conversation. The room owner can expand “Unaccepted reply” on the canceled card to inspect it.
- **Retry or resend.** During the delivery-failure countdown, select “Retry now” or “Stop” on the delivery card. On a run-failure card, select “Resend” to put the original user message back in the composer for confirmation and sending. If an operation failed because permission was denied, expand the card’s run report to see whether “Allow and resend” is available.
- **Withdraw a message.** If no member has started work on it, “Withdraw” returns the original text, files and reply to the composer. You can also withdraw the latest message after work has started. This stops that work and rewinds the conversation to the previous message. If the composer is empty, press `Esc` twice to withdraw the most recent message.
- **Edit and rewind.** Select “Edit” on a processed user message, change it, and send again. The message and everything after it are folded under “Rolled back”, so the AI no longer sees them. Before confirming, review how each member session will be handled. Project files already changed by a member remain as they are.

### 5. Private chat and interruptions during a run

Open private chat to see what a member is doing, redirect it midway through a run, or ask it something privately without adding it to the room.

- **Open private chat.** Select “Private chat” in the sidebar, then choose a member at the top. To inspect a specific run, use the chat-bubble icon on its in-progress or answer card.
- **See execution details.** The private-chat page shows execution records received by the local service. Which commands, tool calls, and output are visible depends on the member’s connection. When the local service can read a Codex App member’s session before delivery, its in-progress card shows the private-chat button and the timeline and private-chat view record only the steps and outputs from that room task without pulling in unrelated messages from the same App chat; if the session cannot be read before delivery, it falls back to no progress.
- **Interrupt a run.** While a member works on a room task, enter a message in the private-chat composer, which prompts “Steer the current work…”. Check the page feedback to confirm the addition was delivered or queued. If the connection supports pause and resume, you can pause the run first. The page shows “Paused; send a follow-up to resume this task” Add your instructions and resume it.
- **Chat while idle.** When the member is idle, a private-chat message is only between you and that member. It does not appear in the public room and does not wake other members.

### 6. Answer a member’s question

When a member needs you to make a decision, a question card appears above the composer. Cards are queued in order. Each question has its own page. Recommended options appear first and are preselected.

1. Choose an option, enter any requested details, or skip the question. Select “Submit answer” to return your answer to the member who asked. During a handoff, it goes directly to the next member.
2. If you are unsure, select “Ask the host to discuss and recommend first”. The host’s recommendation updates the card, but waits for your final confirmation. Or choose “Let the host decide”. Decisions that require your authorization, such as permissions, spending, or extra rounds, still require you.
3. Select “Cancel this question” if you no longer want to proceed. Any handoff tied to the question is canceled too.

### 7. Inspect a run and troubleshoot a room

- When a member starts a sub-agent, runs a command in the background, sets up a monitor, or sets a schedule in its own software during a run, the run card lists that background work one line each: its kind, title, and “Running · N minutes”, “Completed”, “Failed”, “Stopped”, or a schedule's frequency and next time. When the member has finished its turn and only waits for that work, the card shows “Waiting for background tasks”. Only Claude Code reports background work for now; of what members' own schedules do when they fire, only the host's reaches the room (see “Scheduled report” below).
- When background work a member left finishes only after the member has answered, what the member delivers next still reaches the room: the card is marked “Follow-up” and responds to the original answer. A regular member's follow-up assigns no work; the host's follow-up may assign work, counted against the original task chain's round limit. A run you stopped gets no follow-up, and neither does a report that only says the background work was stopped or killed, or an intermediate event of a monitor. If the member takes on new work or you chat with it privately in the meantime, background work that has not reported yet is dropped. Only Claude Code supports follow-ups for now.
- When the host uses Claude Code's own schedules in its open window (say, checking a version every 5 minutes) and you have granted the host the “How work proceeds” permission for this room (the same item as timed check-ins), what each due run delivers reaches the room, marked “Scheduled report”. The host may assign work from it; this counts against the round limit of the task chain of its previous work, and going past that limit needs your approval. After you stop the host or select “Stop all”, schedules set before that no longer reach the room until the host sets them again in a later room task; a run with nothing to handle posts nothing. Without that permission, the host's schedules are only shown as well; a regular member's own schedules are only shown on the card, and their results stay out of the room. Schedules in other software or background processes are only shown too.

- Open **Runs** in the tabs at the top of the room and select **Waterfall**. The timeline shows when each member started, how long it ran, and where it spent time waiting. Select a member's name for the run's status, start time, and duration. Select a segment to inspect the recorded details for that phase. On desktop, the phase preview opens down and to the right when space permits, and can open above or to the left near an edge. Idle stretches longer than 5 minutes are collapsed into narrow bands in **Traces**; to review the whole process at its real length, switch to **Concurrency**: at the top, **Running on its own** is the share of the span with a member at work, and **No input needed** is the share of runs started by the host, a relay or a wake-up rather than by your message, and **Longest unattended** is the longest the AI kept going after one of your messages, until the room stopped or you wrote again; one left-to-right axis with nothing collapsed, where the height above shows how many members were running at once (stacked by member color; point at a block for that run's details), idle stretches are labeled with their length, and tasks are shown as bands below. Select a task to view it in **Traces**. Both **Traces** and **Concurrency** share the same zoom and replay controls at the top right: zoom with Ctrl + wheel or the zoom buttons (pinch on phones and tablets), drag to pan when zoomed, and double-click or select **Reset** to restore the full view. Select **Replay** to play back in order (with pause, speed controls and a scrubber), and **End replay** to return to the current state; it also works while a member is still running, playing up to now. With **Follow** on, the view dynamically adjusts its zoom to frame the active runs and keeps the playback line in view; zooming manually locks your zoom level, dragging or selecting **Reset** turns **Follow** off, and selecting **Follow** re-enters dynamic auto-zoom and follow. **Show earlier runs** keeps paging back to the room's first run, and **Show all** lists every run in the room at once.
- To handle a permission denial, return to the conversation and check the run report on its failure card. **Allow and resend** appears when the run did not complete, the report includes a rule that can be allowed, the local service is available, and the original request can be found. Review the rule before selecting it; the original message returns to the composer for you to confirm and send. On a completed reply card, any mid-run denials fold quietly into a count you can expand to inspect, without **Allow and resend**.
- “Run diagnostics” shows the latest heartbeat and model or tool activity, which timeout fired, retry sources, interjection confirmations, and the workflow used at delivery. File attribution shows observed changes and tracked writes separately. Only the owner can see file paths in diagnostics. Fields without evidence show “Unknown”. Run `codiscuss execution view <ROOM_ID> <RUN_ID>` to inspect the same record in a terminal.
- If a member never woke up or an action was rejected, open **Runs → Events**. The **Event log** shows operations in time order, their outcomes, and the resulting state changes. Select a row to inspect its original record and related events. From a terminal on the local computer, run `codiscuss room events <ROOM_ID>` to read the same log.

- To troubleshoot scrolling after sending, quick navigation, run card placement, operation receipts, or annotation inputs, add `scrolldebug` to the room URL (for example, `?room=ROOM_ID&scrolldebug`). Reopen the page, reproduce the issue once, and select **Copy browser debug log** in the upper right. The log includes IDs, states, and browser measurements. It omits message, selection, and comment text. Debugging stays active until you close the tab.

### 8. Deploy a page as a website

A page a member delivers can go to a public address, `https://<id>.bimcanvas.com`, that people without CoDiscuss can open.

1. Under the answer, select the rocket button, “Deploy as website”, on an HTML file card. A whole folder a member prepared with `codiscuss site stage` (such as a built `dist/`) shows as a “Ready to deploy” card; select “Deploy as website” on it.
2. The confirmation lists the file count, size and any files that look like they contain keys or tokens; those are left out by default. Select “Deploy”. The new version goes live only after every file is uploaded; if the upload fails, the live version stays as it was.
3. Once live, the card shows the address to copy or open; its “…” menu renews for 7 days, rolls back to the previous version or revokes the site. “Published” in the sidebar lists every live website.

To have a member put its work online directly, say “deploy” or “publish as a website” in your message; otherwise members only prepare it and upload nothing.

Addresses without an extension (such as `/about`) opened in a browser return the home page for the site's own front-end routing; missing files with an extension return 404. Reference assets with paths starting with `/`.

## Notes

- Local members use `.scratch/<execution ID>` inside their drafts for reproducible test copies. Before cleanup, verify that the run has ended and its deliverables are saved. Review older drafts individually because they may contain the only copy of a file.

- **A regular member’s `@` mention does not assign work.** When members mention one another, it is only a reference and does not wake the other member. When a regular member mentions the host, the host is woken after other room work finishes.
- **Private chat and interruptions have limits.** They accept text only, not attachments or drawings. Manual and external members, and connections without visible output, do not support private chat.
- **When stopping is unconfirmed.** If a card says “Stop unconfirmed” or “The previous run is invalidated but may still be generating”, new messages to that member wait for confirmation, a late answer, or the original 10-minute timeout.
- **Question cards are part of the room record.** People who can read the room can see the questions and answers. Do not enter passwords, API keys, or tokens.
- **During a discussion.** You cannot use `@all`, `@all-seq`, withdraw or edit and rewind a message, or branch.

# Discussions

Start a structured, multi-member discussion around a clear goal. Set round and time limits, ask questions or skip turns as needed, and use the `discuss-report` skill to turn the completed discussion into a report with source messages.

## Steps

### 1. Start a discussion

There are three ways to start:

- **From the sidebar:** Select “Start discussion” in the room’s right sidebar.
- **When creating a room:** Under “How to work (optional)”, choose “Start discussion” under “After creation”, enter the objective and limits, then select “Create and start discussion”.
- **From the composer:** Send `/discuss <discussion goal>`. If you send only `/discuss`, the host derives a goal from recent conversation. If it cannot, it will explain what is missing and will not start.

When starting from the sidebar, fill in these fields in the dialog and select “Start discussion”. The slash command uses the room’s default limits.

1. **Discussion objective.** Describe the question to resolve, the background, or your concerns.
2. **Round limit** and **Time limit.** The dialog fills in the room’s saved defaults. Changes in this dialog apply only to this discussion.
3. **Individual follow-ups** (optional). When enabled, the host asks each member a targeted question at the end of every round. When off (the default), members respond to a shared question and the host bridges the rounds. Smart scheduling can handle the between-round decision when enabled.

After starting, the host breaks down the topic and schedules speaking turns. Members first state their views independently, then respond to one another’s arguments. The right sidebar shows progress and “Speaking order”. Drag members who have not spoken to change their order.

### 2. Ask questions and control progress

- **Ask a member at any time.** Mention any member during a discussion. This does not count toward a discussion round. If that member is still working on its discussion turn, the question waits until the member is free. An unmentioned message goes to the host.
- **Pause and resume.** Use “Pause” or “Continue” in the discussion controls in the right sidebar. You can also send `/discuss pause` or `/discuss resume` in the composer. Pausing stops current discussion runs. Paused time does not count toward the time limit. When resumed, the host schedules the next work.
- **Skip a turn.** To move to the next member, select “Stop” on the current in-progress card or “Skip” in the sidebar’s discussion controls.
- **End the discussion.** A discussion ends when it reaches a round or time limit, the host declares the goal met, or you choose “End” in the sidebar or send `/discuss stop`. You can keep assigning work and reading the message history in the same room. Existing consensus and the host brief are kept, and you can start another discussion at any time.

### 3. Create a report with `discuss-report`

After a discussion ends, or when you have selected a specific message range, use the bundled `discuss-report` skill to produce a standalone Chinese report and archive the source material.

1. **Give the steward a source and scope.** On the Platform steward page, open “Steward configuration,” allow `discuss-report`, and grant write access to the local output folder. Send the request from the terminal. Include the room ID, message range, and output folder. For a local export, give a readable file path in `--note` and omit `--room`.

   `codiscuss steward ask discuss-report --room ROOM --note "Cover messages #100 to #200 and save to D:/work/reports"`

2. **Review the result.** With a room link, the AI reads messages, assignments, and state for the selected range. With local files, it organizes the available contents in those files. It reports the output path, coverage, and unresolved questions.

3. **Find the files.** The report is saved in the local output folder you chose. The default layout is:

   ```text
   <output-folder>/<discussion-date>-<Chinese-topic>/
     讨论报告.md   # Report with relative links to source messages
     原始记录/
       讨论原文.md  # Original discussion in order
       房间快照.json        # Original room metadata and messages, for room sources
   ```

## Notes

- **Host and mode requirements.** A discussion needs a host the local service can wake automatically. A discussion and a Goal cannot run at the same time.
- **How limits are counted.** One round means every participating member has completed one turn. Host explanations and direct `@` questions do not count. Only active time counts toward the time limit. A limit ends the discussion immediately. The host is not woken for an extra summary, and reaching a limit does not mean the members reached consensus.
- **Delivery failures do not stop the whole discussion.** A failed delivery retries automatically up to three times during its countdown. Select “Retry now” or “Stop” if needed. When attempts run out, only that turn ends. The host decides whether to skip, reorder, or pause; the discussion is not paused automatically.
- **Restrictions during a discussion.** You cannot use `@all`, `@all-seq`, withdraw or edit and rewind messages, or branch. You cannot make the current host leave or remove it. Changing the host pauses the discussion.
- **The report does not change the room.** `discuss-report` organizes existing material into your chosen local folder. It does not end an active discussion, turn recommendations into formal decisions, or edit project code.

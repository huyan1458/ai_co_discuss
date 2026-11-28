# MOSS

MOSS (formerly Platform steward) is a local AI that handles platform tasks, answers questions about CoDiscuss, and checks the status of project rooms. Its dedicated conversation keeps your past requests and replies independently of project rooms.

## How to use it

1. The top of the sidebar lists “New room,” “MOSS,” “Workflows,” and “Analytics.” Select “MOSS,” pick an AI app, and select “Start conversation.” When the conversation is first created, MOSS uses “Room overview,” if allowed, to summarize your project rooms, what needs your attention, and any setup gaps it can verify.
2. Type a request such as “Which rooms need me?” or “Why did this run fail?” The room overview includes room links and references. Troubleshooting reads the guide, event records, execution details, and relevant logs. For a room-specific task, include the room link or ID. You can also start a request from the relevant page.
   - **Review dispatches.** In Analytics, select “AI analysis” in the dispatch review section. The button is enabled only when the `dispatch-analysis` skill is available and allowed. The review runs on request only and reports its findings separately from the measured statistics.
   - **Make a room share card.** In the target room’s menu, choose “Share → Make a share card with AI.” The request includes the target room so the steward knows where to find the source material.
   - **Install local speech.** In “Settings → Speech,” select “Ask MOSS to install” for local read-aloud or voice input if it is not installed. Each installation requires confirmation because it changes the computer running the local service.
   - **Set up notifications.** In “Settings → Notifications,” select “Ask MOSS to configure” and confirm. MOSS may change local notification settings. Enter channel credentials yourself in the notification settings.
   - **Deploy or update your own online site.** In the device pairing area of Settings, select “Ask MOSS to deploy.” If source is missing, MOSS asks before cloning the version that matches your installation. It shows the resources and command and waits for confirmation before each Cloudflare write. See [Deployment](../deployment.md).
   - **Analyze CoDiscuss storage.** On the admin panel’s Storage page, select “Ask MOSS to analyze storage,” or run `codiscuss admin storage analyze`. The inventory covers member drafts, run logs, workflow backups, room attachments, and local speech models. It does not scan the entire drive or remove anything without your approval of the specific items.
3. Select “Open MOSS” in the bottom-right notification, or open the conversation from the sidebar. You can see its progress and results and inspect, stop, or retry its runs.

## Where MOSS handles your task

MOSS chooses where to handle a task without asking you to approve the routing. Platform tasks such as installation, setup, and status checks stay in the main conversation. Work that edits project files or needs several AI members goes to a suitable existing project room, or a new one if needed. For other work, say “start a task” or “work on this in the background and get back to me,” and MOSS opens a single-member task room. If you do not ask explicitly, it only opens one when the work needs both a standalone deliverable and a fresh search and cross-check of multiple original sources. If the choice is unclear, MOSS works in the main conversation. If it hands work off, it gives you the room link. To bring the work back, tell MOSS to “do it here.”

- Project rooms use your saved “New room” defaults for the host, members, and host permissions. Member project access is read-only if unset and capped at “Can write.” “Automatic” and “Full access” both become “Can write.” The new host cannot create more rooms. To use a project directory, add it to “Saved projects” and tell MOSS which one to use. Without one, it is still a project room, but uses a draft workspace. A room marked “Task” starts a fresh session with one member using the same AI app and model as MOSS. It can write only to the draft workspace and has no host permissions.
- When asking MOSS to create a room, you can name an existing folder. MOSS can also choose an existing folder if the room clearly belongs there. If it is unsure, the room appears under “Uncategorized.” Rooms are not automatically grouped by project directory. MOSS tells you where it put the room.
- “Allow MOSS to create rooms” is on by default in “MOSS configuration.” Turning it off disables both room creation and cross-room messaging. From the command line, use `codiscuss steward settings --create-rooms off` to turn them off or `--create-rooms on` to turn them back on.
- MOSS can create any number of task or project rooms. Archive them manually, or explicitly ask MOSS to archive a child room it created. Rooms are not archived automatically when work is delivered. To archive other rooms, control runs, change members or permissions, or manage user messages, use the corresponding project room.
- To clear an entry from “Work sent out” in the right sidebar, use the room's archive button and confirm. Archived rooms are hidden by default and can be viewed with “Show archived.”
- Open “Settings” from the MOSS sidebar, edit “Members of rooms MOSS creates” under “New room,” and save. The selection applies to future project rooms. You can also change it on a paired phone or tablet. The setting is saved on the computer running MOSS.

Tasks MOSS sends to its own child rooms appear on the handoff card. “Completed” means the child room returned a result, and the card shows a summary. MOSS reviews every round and reports back briefly when the result passes. If MOSS asks for revisions, the original card goes back to in progress and shows the new result when it arrives. Child rooms ask MOSS for decisions first, and the card shows “Waiting for MOSS.” If MOSS cannot decide within your authorization, it asks you in the main conversation and relays your answer. If a question in the child room is already waiting for your answer, the task card shows “Waiting for you” without sending reminders or marking the task as unreported.

## Choose a MOSS window

- **Steward**: use the website for installation, deployment, platform settings, and proactive reports.
- **Private chat**: your direct messages across linked channels arrive here, and answers go back to the original channel. A quoted reply to a proactive report goes to the Steward window. A quoted reply to another room's notice goes to that room. The Steward and Private chat windows have separate new messages, AI sessions, and settings. Older history stays where it is.
- **Group**: each enabled group has its own window. You can read the record on the website but cannot send a message to the group from it. On a phone, open the window list from the conversation header.

Private chat is read-only by default and can be set to “Automatic” independently. It can create rooms and pass messages between them. Platform skills are not listed, and the CLI blocks platform-changing commands. If you raise access, the local process may still be able to call local interfaces or edit configuration files directly. Use the Steward window for platform changes. Private chat restrictions are not a local sandbox.

There is no separate acknowledgment for successful direct messages. You’ll see a notice if a message is queued, MOSS isn’t configured, or delivery fails. Replies are split to fit the channel’s message limit. Above three messages, MOSS sends an overview and a web link.

New messages wait in the queue while MOSS is busy. If the AI app supports live interjections and the current request came from the same channel, your message can be added to the running task. If MOSS is waiting for you to answer a question, new messages from the website or a notification channel are queued. Answer the question card on the website to let the queue continue, or select “Send now” on a queued message to have MOSS handle that message first. Channel messages cannot answer questions or grant approvals.

## Add MOSS to a group chat

Group windows currently support QQ groups linked through a personal account using OneBot. They receive text and can send images and files. This is an unofficial protocol, and QQ may restrict or ban the account. Enable it only in groups where you have agreed to record messages.

First add the QQ account used by MOSS to the group in QQ. Then choose either way to turn it on:

- **On the website**: select “+” at the bottom of the MOSS window list to see MOSS’s QQ number. Search for the group and confirm the settings. If a group you just joined is missing, refresh the list. The dialog warns you if it can verify that your linked owner account is not a member. If membership cannot be verified, it shows no warning. The option to post an introduction is off by default.
- **In the QQ group**: from the linked owner account, @mention MOSS and write `开始工作` (“start working”). MOSS confirms in the group or explains why it cannot start. Defaults are “Do small things,” 30 wake-ups and 5 delegations per day, with no readable folder or skills selected. The command checks the linked account ID. Other accounts cannot use it, even with the owner's display name.

To stop MOSS, turn off the group in its website settings, or @mention MOSS from the same owner account in QQ and write `停止工作` (“stop working”). MOSS confirms a successful in-group command. It stops receiving and replying to new messages, keeps the existing record, and does not leave the QQ group.

If a configured scheduler request fails, MOSS still handles direct mentions and messages from the owner. Existing limits and permissions apply, and MOSS decides whether to reply. Other messages are recorded without waking MOSS. The group settings show the latest failure.

Use the group settings to change the daily limits, model and effort, description, and speaking style. Group access stays read-only, with one optional read-only folder and your choice of skills. No project folder is attached by default. Check the software note for its file-access limits. Group members cannot grant more access or ask MOSS to read private chats. MOSS asks the owner ordinary questions in the group and takes sensitive matters to private chat. Open the group window on the MOSS page to read messages and see their senders, including messages MOSS did not answer. You cannot post to the group from the website.

When MOSS is waiting for your answer in a group, quote its question or @mention MOSS. With smart routing enabled, a plain message also counts if the decision model recognizes it as your reply. Only the linked owner account can answer. To dismiss the question, open “Settings” → “Chat windows,” expand the group, and select “Clear.” Clearing ends the wait without granting approval.

When smart routing is configured, eligible group messages use a decision-model call. A wake-up also uses quota for the selected model. Without smart routing, only an @mention can wake MOSS, and a wake-up does not guarantee a reply. In that mode, MOSS follows the task policy in its instructions without a decision-model check.

If the group software cannot browse, research is delegated. Work such as reviewing multiple sources or generating files goes to a separate task room. That room can write only to the group's dedicated workspace and does not mount your projects. The result returns to the group window so MOSS can reply in the original group. Each group defaults to five delegated tasks from other members per day. The owner's requests do not count.

## Set up proactive reports

In “MOSS configuration,” open “Proactive reports,” turn on “Let MOSS report proactively,” and save. The switch is off by default. Each report that wakes MOSS uses some of your chosen AI app’s subscription quota. “Active hours” and “Digest time” default to 09:00–22:00 and 21:00 on the computer running MOSS.

- Give MOSS a standing instruction in the conversation, such as “Remind me when a room is waiting for my answer.” MOSS repeats the instruction back after saving it. If you ask for a timed reminder, such as “Remind me after a room has been waiting for two hours,” MOSS will explain that it cannot trigger a reminder based on elapsed time. Remove a duty under “Duties given to MOSS.”
- A room status change can trigger a report during active hours if proactive reporting is on and you have added a duty. New requests for your input take priority. New failures and recently finished work are grouped into the digest. If MOSS is busy, reporting waits until it is idle. The digest runs when there are relevant changes. Elapsed time alone does not trigger another report for a room that is still waiting.
- To mute similar reminders, select “Don't tell me about this” on a report card and add a short reason. Remove the entry under “Muted reminders” to allow those reminders again.
- If nothing remains to report after MOSS checks your duties, muted reminders, and what still needs your attention, it ends without a reply or report card. The wake-up still uses subscription quota.

## Things to know

- Hover over the MOSS avatar to see “MOSS is idle,” “MOSS is working,” or “MOSS is waiting for your reply.” The room directory shows statuses such as “Needs input,” “Run failed,” and “In progress.” Reopening the site still takes you to the last room you had open.
- MOSS can read room status on the same site. Installation, deployment, cleanup, and deletion each require confirmation.
- Select “Settings” in the right sidebar to change the model, effort, “Working directory,” and “Allowed skills.” On a phone, open the sidebar from the header. After saving your skill list, select any new skills you want to use after an upgrade.
- The Steward window handles platform tasks such as speech installation, notification setup, and deployment. Those actions still require confirmation each time. From the command line, use `codiscuss steward ask SKILL --confirm`. Only direct messages from the linked owner account are accepted. Group messages can wake that group's window, not the Steward or Private chat windows.
- Select “Change software” on the app card to switch apps in the same conversation. The messages and conversation link stay the same. If a task is still in progress, it continues and you see “MOSS is working. The software change takes effect once it is idle.” The new app starts a fresh AI session and uses “MOSS” as its display name. “Past conversations” lets you view previously archived conversations or confirm permanent deletion. In the terminal, use `codiscuss steward history` or `codiscuss steward delete ROOM --confirm`.
- See the current session's context usage next to “Fresh start” in the right sidebar. To clear that context, select “Fresh start” and confirm, or run `codiscuss steward renew`. The app, model, conversation history, duties, and settings stay the same. If MOSS is working, it finishes the task before starting the new session.
- Both “Change software” and “Fresh start” add a divider to the conversation when the switch takes effect. The divider names the app used for the new session.
- On the online site or a paired phone or tablet, requests still run on the paired computer. Its local service must be running.
- The “MOSS” section in “Analytics” shows task and project rooms created, work sent to existing rooms, rework, missing reports, work brought back to the main conversation, and run counts and durations. It also shows how often notification channels sent a queued-message acknowledgment.
- For terminal use, see [Command Line](cli.md#platform-steward).

# Platform steward

The platform steward is a local AI for platform tasks. Its dedicated conversation keeps your past requests and replies and is not tied to any project room. The steward does not join project rooms or assign work for their hosts. Its conversation does not appear in the project room directory or count toward room analytics.

## How to use it

1. Before first use, choose an AI app in “Settings → Platform steward.” The app is not selected automatically. You can also set the model, effort, project access, working directory, and allowed skills there.
2. Select “Platform steward” at the bottom of the sidebar and type a request in the conversation, such as “Install local read-aloud.” You do not need to name a skill. The steward reads the allowed, available skills it needs. For a room-specific task, include the room link or ID. You can also start a request from the relevant page.
   - **Review dispatches.** In Analytics, select “AI analysis” in the dispatch review section. The button appears only when the `dispatch-analysis` skill is available and allowed. The review runs on request only and reports its findings separately from the measured statistics.
   - **Make a room share card.** In the target room’s menu, choose “Share → Make a share card with AI.” The request includes the target room so the steward knows where to find the source material.
   - **Install local speech.** In “Settings → Speech,” select “Ask the platform steward to install” for local read-aloud or voice input if it is not installed. Each installation requires confirmation because it changes the computer running the local service.
   - **Set up notifications.** In “Settings → Notifications,” select “Ask the platform steward to configure” and confirm. The steward may change local notification settings. Enter channel credentials yourself in the notification settings.
   - **Deploy or update your own online site.** In the device pairing area of Settings, select “Ask the platform steward to deploy.” If source is missing, the steward asks before cloning the version that matches your installation. It shows the resources and command and waits for confirmation before each Cloudflare write. See [Deployment](../deployment.md).
   - **Analyze CoDiscuss storage.** On the admin panel’s Storage page, select “Ask the platform steward to analyze storage,” or run `codiscuss admin storage analyze`. The inventory covers member drafts, run logs, workflow backups, room attachments, and local speech models. It does not scan the entire drive or remove anything without your approval of the specific items.
3. Use the link in the notification at the bottom right or the sidebar entry to see progress and results. In the conversation, you can inspect, stop, or retry a run.

## Things to know

- Steward skills ship with CoDiscuss and load on request. They are not installed into your AI software. In addition to the web buttons, you can request a discussion report or draft inventory from the command line. You choose the project directory, access level, and allowed skills.
- If you switch the steward to a different AI app, the old room and its conversation are archived. A new conversation starts the next time you open the steward or send a request. Under “Settings → Platform steward,” use “Past conversations” to open the archived conversation in read-only mode or confirm permanent deletion. In the terminal, use `codiscuss steward history` to list them and `codiscuss steward delete ROOM --confirm` to delete a specific old conversation.
- Once you save your list of allowed skills, new steward skills added in later releases are not enabled automatically. To use one, select it in “Settings → Platform steward.”
- On the online site or a paired phone or tablet, requests still run on the paired computer. Its local service must be running.
- For terminal use, see [Command Line](cli.md#platform-steward).

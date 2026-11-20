# Cross-Computer Collaboration with External Members

Invite an AI running on another computer to your room. It can read the project folders you open and reply in the room. Your computer records the files it reads, and you can revoke access at any time. This also works between two of your own computers.

## Requirements

- CoDiscuss and its local service must be running on both computers.
- The computer that owns the room and project must be linked to an online site with relay enabled. See [Phones and Remote Access](remote.md).
- If your computer is off or its local service is stopped, the other computer cannot get room messages or files.

## How to use it

### 1. Send an invitation from the room owner’s computer

1. When creating a room, choose **External expert** in the **Who takes part** section under **External**. In an existing room, select **Invite AI** → **Invite an external expert** in the right sidebar. You can add more than one.
2. On the external expert card, set **They can see** to **Room messages** or **Messages and project**. The latter opens all project folders in this room. The person joining chooses the loan duration.
3. Select **Invite** (or create the room with the seat). The member list shows **Awaiting check-in**, and a notice above the composer asks you to send the invitation link.
4. Select **Copy invitation link**, or open **Invitation details** to show a QR code. Send it to the invitee. The link is valid for 10 minutes and for one member only. Creating a new link invalidates the previous one. An open Invitation details panel refreshes an expired link.
5. Redeeming the link completes check-in. There is no additional approval step. Before check-in, the seat receives no work and does not take part in replies to all members or discussions. An unchecked seat expires after 7 days.

### 2. Lend an AI from the other computer

1. Open the invitation link and select **Join with CoDiscuss on this computer** to open the local site. Or, in **External rooms** in the left sidebar, select **+**, then paste the link, scan its QR code, or choose/paste an image of the code. You can also use the CLI:
   `codiscuss join <invitation-link> --adapter <software> --duration 1h`
   The duration can be 1h, today, or 3d.
2. On the member card, choose a local AI or model API to lend. You can use a new session or resume an existing one. “Manual start” and desktop apps are not supported. Choose the model, effort, dedicated prompt, and these settings. The default is **Room only · Answer at once · 1 hour**.

| Setting | Options |
| --- | --- |
| **When named** | **Answer at once**, with no wake limit, or **Ask me**, which asks you to approve each wake. If you refuse or do not respond within 15 minutes, the other room sees “Not accepted by the other side.” |
| **Local access** | **Room only**, which permits CoDiscuss commands in an empty temporary folder, or **Unrestricted**, which can access files on the lending computer and the network. |
| **Loan duration** | 1 hour, today, or 3 days, up to 3 days. |

3. After joining, the other room appears under **External rooms**. Open it to read the room conversation and recorded local results. Private chats, execution details, room settings, and the file browser are unavailable.

### 3. Renew, pause, leave, or revoke

- **Renew from the lending computer:** Change the loan duration in the external room’s right sidebar. The new duration starts when saved and can also shorten the loan. After natural expiry, select **Renew**, choose a duration, and select **Save** to rejoin. A loan revoked by the room owner cannot be renewed.
- **Pause or leave from the lending computer:** In the external room’s right sidebar, select **Pause** or **Resume**. Use the room menu to **Leave room**. After the room ends, **Delete record** removes it from the local list. Paired phones and tablets can also change these settings.
- **Inspect access and revoke from the room owner’s computer:** In the right sidebar, open the member menu and select **Read log and access**. The same controls appear on the external expert card under **Room → Members and settings** in the left sidebar. Review the files it read, narrow access to **Messages only**, or select **Revoke** to end access. For a seat still awaiting check-in, select “Remove seat”.
- **Invite again:** Ended members appear dimmed below the active list with a reason. If the invitee left or you revoked access, select **Invite back** to make a new link. The member name and history remain.

## What the other computer can and cannot read

- **Readable:** In an open Git folder, tracked files (including uncommitted changes) and new files not excluded by .gitignore. In a non-Git folder, files other than generated folders such as node_modules. Each read is limited to 128 KiB; there is no total count or size limit.
- **Blocked:** .env files, private keys and certificates, credential files, .git, and data/ at the root of an open folder. Links pointing outside the folder are rejected. External members cannot write files, run commands, read private chats or other rooms, or see your local paths.

## Things to keep in mind

- **Room-only access support:** Claude Code CLI, Gemini (Antigravity CLI, command agy), and model APIs support **Room only**. Web search cannot be disabled for agy. Codex CLI supports only **Unrestricted**. Desktop apps cannot join as external members.
- **Use Unrestricted only between computers you trust:** The borrowed AI can access files on its own computer. Room content may lead it to read local files, so use this only between computers you trust completely.
- **Read data cannot be recalled:** Files already read remain in the external AI’s session and may have been sent to its model provider. Revocation prevents future reads.
- **Protect invitation links:** Anyone who redeems the link first becomes a room member. Send it only to the intended person and revoke access if anything looks wrong.

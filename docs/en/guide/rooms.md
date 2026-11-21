# Rooms, Folders, and Creating a Room

Organize rooms and folders in the sidebar, configure room creation, manage project directories and files, send attachments, and export, import, or branch rooms.

## Steps

### 1. Create a room and choose its settings

In the sidebar, select “New room”. To create one inside a folder, select the “+” beside that folder. The form has three sections:

1. **“What to do”**
   - Enter a name in “Topic”.
   - Optionally choose a folder under “Project folder (optional)”. If you do not, the service creates a dedicated folder in the draft workspace (by default, `~/.codiscuss-workspace`). After choosing a primary directory, select “Add another project folder” to add up to eight more.
2. **“Who takes part”**
   - Select “Add AI” to add members. Select the crown on a member card to make it the host.
   - Optionally configure “Smart scheduling”, “Image generation” (add an OpenAI Images card and enter an endpoint, API key, and image model), and “Web search” (enter a DeepSeek API key shared across rooms).
3. **“How to work (optional)”**
   - Optionally enable “Full host control”. This lets the host manage members, retry or interrupt work, start discussions and Goals, and save workflows. To allow only part of it, expand “Items” and tick just the ones you need.
   - Under “After creation”, choose “Off”, “Start discussion”, or “Start Goal”.
4. **“Advanced settings”** lets you set the “Assignment round limit” (10 by default, from 1 to 100 or unlimited) and “API request limit”.
5. Select “Create and connect”, “Create room” for an all-manual setup, “Create and start discussion”, or “Create and start Goal”, as applicable.

Room name, project directory, and members are chosen for each room. Smart scheduling, collaboration settings, discussion and Goal limits, and continuous host-turn limits remember the last selection, even if you cancel room creation. If startup fails, a failed item remains in the sidebar. Select “Retry” in its menu to continue the same request without creating a duplicate room.

You can also send a message from the blank home page to create a room and send its first task. The web app picks the first configured AI that it can wake automatically as the room’s only member and host. The first line of your message becomes the room name. If you attach files without text, the first filename is used. The new room inherits the folder’s default project directory when one is set; otherwise it uses the draft workspace.

### 2. Organize the sidebar, folders, and archives

- **Sort rooms.** Open the directory options in the top-right corner. Choose “Manual order” (drag items or use the arrow keys) or “Recent activity”.
- **Folders.** Select “New folder” to group rooms by project. A folder can have a default project directory, which is used for new rooms created inside it. Its menu offers “Edit”, “Move up”, “Move down”, “Archive folder”, and “Remove folder”. You can remove just the folder or delete its rooms as well.
- **Room actions.** Open a room’s menu to “Rename”, “Edit topic”, “Move to folder”, “Copy reading link”, “Refresh messages”, “Archive room”, or “Delete permanently”. “Edit topic” and “Refresh messages” apply to the currently open room.
- **Restore or clear archived rooms.** Open “Archived”. Filter by keyword or whether rooms contain messages. Select “Restore” to return a room to the active list. To delete one permanently, select “Delete for good” and confirm. “Delete all” applies to the current filtered results.

### 3. Set project directories and browse project files

- **Add or remove directories.** A room supports one primary directory and up to eight additional directories. After creating a room, open the “Room” tab at the top of the room and find “Project folder”. Add or remove additional directories there. Changes apply from each member’s next run and do not interrupt a session. A primary directory cannot be changed after it is set. If the room was created without one, you can set it once in the same section. Members can access all room directories subject to their individual project permissions.
- **Open Files.** In the tabs at the top of the room, select “Files” to browse directories, file sizes, and modification times. Switch between the primary and additional directories at the top. A project directory is required.
- **Preview files.** Select a file to open its floating preview. Supported previews include plain text, code, rendered Markdown, static HTML with a source view, zoomable and rotatable images, audio and video with speed and full-screen controls, CSV tables, subtitle timelines (SRT, VTT, ASS, LRC), read-only Word, Excel, PowerPoint and PDF, and Premiere project XML. Relative project images in Markdown display inline.
- **Tabs, split view, and collapse.** Open multiple files and switch between tabs. Use the preview controls to split the view on the right or use “File location” to return to the containing folder. HTML previews also offer “Open in new tab”. Select “Collapse” in the title bar to keep the preview as a floating button in the corner. It restores the same file and scroll position when you return to the room. Close it to clear the preview.
- **Quote and annotate.** Select text in a Markdown preview or a member’s answer and choose “Add to conversation”. Enter a note and press Enter. The source is marked with a number and the composer shows the number of notes. Sending the message adds a file path and line number, the member and message ID, or for a message attachment its message ID and attachment ID. An `@` inside a quote does not wake a member.
- **Manage project files.** Select “Project” at the start of the path bar to open your projects and drafts. Use the top controls to create folders and upload files (up to 20 MB each). File menus offer “Download”, “Rename”, “Copy”, “Cut”, and “Delete”. Paste into the destination folder. Deleted files and replaced versions go to “Recycle bin” for 30 days, where they can be restored. In source view, the pencil button edits text files up to 1 MB. Project and draft roots, and folders currently used as room project directories, cannot be renamed, moved, or deleted.

### 4. Send and view attachments

- **Attach files.** Paste or drag files into the composer, or use the paperclip button at the bottom-left. Each message can contain up to 10 files, 20 MiB each. Thumbnails appear above the composer. A placeholder such as `[Image #1]` or `[File #2]` is inserted at the cursor. Removing the thumbnail or deleting its placeholder with Backspace removes both.
- **View attachments.** After sending a message, select its placeholder or attachment card. Images can be enlarged full-screen, zoomed, rotated, and saved. Audio and video play in the message. Documents and code open in the file preview.
- **Expand HTML in a message.** On desktop, select “Expand in message” next to a member's `.html` attachment to use the self-contained page below the card. One page can be expanded at a time. For files over 2 MiB, open the file preview to view their source. On a phone, select the attachment card to open the full-screen preview.
- **Member access to attachments.** For supported automatic runs, the local service downloads the file and passes its information to the receiving member. Claude Code and Codex CLI can view images directly. For API members, enable “Images” on the member card to view images. UTF-8 text attachments can be read on request. Members will say when they cannot read a format such as PDF.

### 5. Export, import, and branch rooms

- **Export a backup.** A room’s “Export conversation” menu item creates a ZIP containing the room’s messages, discussion history, and attachments. Use a folder menu to “Export folder”, or directory options to “Export all rooms”. Export on the computer running the local service. The archive includes member software settings and session identifiers. The original software’s session history must still be present on that computer to resume a session.
- **Share as a web page.** In a room’s menu, select “Share as web page…”. The room is read and cleaned first; the confirmation lists what is included and left out, and anything that looks like a key, a folder on this computer or contact details, with its message number and nearby text. After checking, choose one:
  - “Download web page” gives you a single `.html` file that opens in any browser. Once sent, it cannot expire or be taken back.
  - “Publish link” uploads it to the official share site and copies the link. Choose whether it expires in 1, 3 or 7 days; it is deleted when it expires. The room’s menu then offers “Copy share link” and “Revoke share link”, and “Share as web page…” again offers “Update link”, which also restarts the lifetime. Only the browser that published the link can update or revoke it. Rooms over 5 MB after cleaning need the web page file instead.

  Either way, readers see the room’s **Messages** and **Runs** views from the beginning, as they look here: cards, run details and the run replay open, but nothing can be sent or changed, and the page shows the room as it was when it was made. Private chats, the event log, scheduling decisions, refused actions, queued messages, attachments, paths on this computer, session IDs and credentials are left out, as are retracted or rewound messages; failure reasons read only “Run failed”, and the room’s project folders are rewritten in message text as paths inside the project. The rest of the message text is shared as written, so check it before sending.
- **Import rooms.** In directory options or a folder menu, select “Import rooms…” and choose a ZIP. Review the preview and confirm the rooms to import. A room marked “Already exists; skipped” is left as is. On the same computer, invite members back to resume their sessions. Claude Code members switch to manual connection on import. Re-register them from their original window to avoid splitting the session. Imported discussion history is kept, but discussions are not restarted and members are not woken automatically.
- **Branch from a message.** In an AI message menu, select “Branch from here” to create a room containing the history through that message. Connections that support session branching resume from the branched session in the new room. The original room is kept.
- **Let the host create rooms.** With “Create rooms” ticked in “Host permissions”, the host can move part of the work into a new room. Members use only software configured on this computer, with read-only project access by default and at most write. The project folder must be the original room’s folder or a folder inside it. Unless you name another host, the new room is hosted by the same expert as the original host. Each room gets a “Linked room” card; select “Open room” to go to the other one. The new room takes your default host permissions, except that it cannot create rooms. A room can create a limited number of rooms (3 by default, adjustable in “Host permissions”). The hosts of two linked rooms can speak in each other’s room; those messages are labelled “From host … of room "…"” and wake the other room like your own messages. There is no limit by default. To cap it, set “Linked-room message limit” under “Advanced settings” in the new-room form (it applies to every linked room on this computer); counting from your last message in either room, messages beyond it are refused until you send a message.

## Notes

- **Notice when a room goes idle.** When all work in any room ends (it changes from "Running" to idle), the page shows "\"Room name\" is now idle" in the lower-right corner. The page must be open.
- **Shared directories are not locked.** If members edit the same project file at once, the page shows a conflict notification while the room is open. It is not added to the message history and does not wake the host.
- **Preview and transfer limits.** Text previews show at most the first 128 KB. When another device accesses media and documents through the computer, each file is limited to 64 MB. The web app first attempts to compress videos larger than 3 MiB. Links pointing outside a project directory appear disabled and are rejected.
- **A branch does not copy project files.** Branched and original rooms share the same project directory. Branching requires a connection to the local service.
- **An attachment is not necessarily read.** Sending a file to the room does not mean a member has read it. Private chat and in-progress interruptions do not support attachments.
- **Backup compatibility.** Version 1 room archives can no longer be imported.

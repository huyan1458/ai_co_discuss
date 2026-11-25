# Changelog

This changelog records major changes by npm package version. Entries before 0.5.0 cover selected milestones. The Chinese edition is available in `CHANGELOG.zh-CN.md`. The version number at the top left of the website links to the changelog.

## 0.5.26 (2026-11-24 20:25)

- Fixed: When the website or the local service stalled briefly, members' work in progress was wrongly marked as failed.
- Changed: Several program notices to the host in a row now share one card instead of flooding the room.
- Changed: In rooms where the host changed partway, each message shows the host at that time.

## 0.5.25 (2026-11-24 10:58)

- Changed: When the host is woken automatically after a failed run, the failed card stays visible with the new run right below it.
- Changed: Simplified the workflow editor header on narrow screens and mobile file preview layout, standardizing phones on portrait.

## 0.5.24 (2026-11-24 09:41)

- New: Bundled workflows add task-dispatch and update flowcharts across the other built-in workflows.
- Changed: Uploaded attachments left unsent for over 24 hours are cleaned up automatically; sent and queued attachments are kept.
- Fixed: On phones, tapping the attach button with the keyboard open misplaced the picker, and archiving a room now keeps the sidebar open.
- Fixed: Editing and saving a workflow canvas from a paired phone or tablet preserves companion templates and scripts on the computer.

## 0.5.23 (2026-11-24 08:11)

- Fixed: Member drafts could fill the C: drive. Dispatching now pauses when local data (excluding speech models) exceeds 10 GiB, drafts exceed 3 GiB, or the system drive runs low.
- New: The "Storage" tab in the management panel shows usage and clears temporary files; if a room is blocked, clean up with `$codiscuss-draft-cleanup` outside the room, then click "Retry".
- New: Speech models and hosted accounts' project data can live on another drive.
- New: Save members as project presets, and click a member in "Speaking order" to jump to their latest message.


## 0.5.22 (2026-11-24 00:12)

- New: Child rooms created by the host group under their parent room, collapse and expand, and auto-expand on activity.
- New: Drag to reorder saved projects in the project manager, and double-click a room name in the desktop sidebar to rename it.
- Changed: Changelog timestamps now show the exact minute, with key milestone releases before 0.5.0 added.
- Changed: Switching back to a recent room keeps members' model and effort visible right away, and loading videos match the current theme.

## 0.5.21 (2026-11-23 22:55)

- New: Bundled workflows add tri-model-dev and update flowcharts across the other built-in workflows.
- New: Workflows support optional "Author" and "Source" fields, and the description wraps cleanly and can be edited above the body.
- Fixed: Dated time labels overlapped or clipped on phones in the timeline, and replay now scrolls to follow the active run.
- Changed: Project files delivered in answers reserve their card space while verifying, stopping messages below from jumping when scrolling or switching rooms.

## 0.5.20 (2026-11-23 20:48)

- New: Customize share cards by editing text, picking a room image, or using "Upload cover" with cropping; updates keep your cover.
- New: Antigravity automatically retries up to 3 times in the same session after mid-run network drops, with a "Retry now" option.
- New: Run details add "Run diagnostics" for progress, retries and file attribution, and API members now have time limits so runs do not hang.
- Changed: Timeline replay now auto-zooms to follow the playback line when "Follow" is on, with a unified zoom and replay bar.
- Changed: Interjected messages now nest under the original message; revoking or renewing a shared link updates the list immediately.

## 0.5.19 (2026-11-23 16:46)

- Fixed: Background share uploads failed immediately on brief network drops instead of retrying automatically.
- Fixed: After a share failed, its card under "Shared" still showed upload progress and pushed buttons off screen.
- Changed: Unticking attachments while sharing updates the selected count and size live, with a single scroll list and no extra sort buttons.

## 0.5.18 (2026-11-23 10:00)

- New: Sharing prepares and uploads in the background even if you lock or leave the page, and "Filter files" supports preview and sorting.
- New: The workflow canvas adds "User" and "Branch" nodes to mark where you step in and where flows split.
- Changed: Reorder speaking order by dragging in the "Room" tab, edit multiple members in a row, and find paused members grouped below.
- Changed: Previewing a ZIP archive now lists its contents first and loads a file only when you click it, so large archives open faster.
- Changed: Sent images keep their local preview and scroll position, and denied operations on finished answers are folded by default.

## 0.5.17 (2026-11-23 07:41)

- New: Pick attachments by type or with "Choose files" when sharing; share links now carry up to 300 MB (100 MB per file).
- Fixed: On phones, the replay toolbar buttons and time marks crowded into each other.
- Changed: When a phone or tablet asks for a folder the computer has not opened to it, it now says why and how to allow it on the computer.
- Changed: A small arrow after the version number at the top left shows it opens the changelog.

## 0.5.16 (2026-11-23 04:20)

- Fixed: "Deploy as website" always failed when a member published, and was refused on computers with sign-in protection.
- Fixed: Work you leave for after a discussion is now picked up by the host once the discussion ends.
- Changed: Website cards under answers look like a small browser window, showing the address, version and expiry at a glance.

## 0.5.15 (2026-11-23 02:40)

- New: Pages members make can go to a public address with "Deploy as website", live for 7 days and renewable.
- New: "Busy & idle" view on the Runs page replays the whole session at its real length, with pinch zoom on phones and tablets.
- New: Members can put small interactive pages right inside their answers.
- New: Click the version number at the top left to read the "Changelog".
- Changed: Rooms with many messages open faster and scroll more smoothly.

## 0.5.14 (2026-11-22 23:16)

- Fixed: Scrolling and clicking the message navigation lagged badly in rooms with many messages.
- Changed: While smart scheduling decides who answers, the card just says "Smart scheduling analyzing"; if it fails, it explains why and hands over to the host.
- Changed: Project files and attachments delivered in answers now look the same, so they are easier to find.

## 0.5.13 (2026-11-22 21:30)

- Fixed: In rooms with many messages, the page froze for a second or two now and then while a member was working.
- Fixed: A destroyed room's file preview window stayed on screen.

## 0.5.12 (2026-11-22 20:26)

- Changed: Documents, spreadsheets, images, web pages and other finished work from members are sent as attachments by default, previewable right in the card.
- Changed: "Full host control" moved into "Advanced settings" when creating a room.
- Fixed: On an unstable network, Antigravity wrongly asked to sign in again and the work failed.

## 0.5.11 (2026-11-22 19:14)

- New: Share links can carry attachments (up to 100 MB), including project files members delivered.
- New: Set the project access the host gets by default in new rooms.
- New: Before destroying a room, "Export package" keeps a copy of its messages, private chats and attachments.

## 0.5.10 (2026-11-22 16:36)

- New: An imported expert that needs software or a model this computer lacks is marked as unable to run, with how to fix it.

## 0.5.9 (2026-11-22 08:50)

- New: Experts in a workflow can carry their own skills, and can be imported, exported or saved as presets on their own.
- Changed: Destroying a room needs two confirmations; a shared room's link must be revoked first.
- Fixed: With many rooms, updating got stuck at "The local service has not stopped".

## 0.5.8 (2026-11-22 06:20)

- New: Preview which files are inside a zip archive.
- New: Opening "Runs" on a shared page replays the session from the start.
- Changed: A workflow changed elsewhere is no longer overwritten; you are asked to "Reload".
- Fixed: Share links already sent kept showing the old interface.

## 0.5.7 (2026-11-22 03:26)

- Changed: Web demos members make can be viewed right in their answers on phones too.
- Changed: "Host permissions" save automatically when ticked.
- Fixed: On phones, scrolling down after opening a scheduling card pulled the page back.

## 0.5.6 (2026-11-22 01:15)

- New: "Destroy room" also removes members' AI conversations and drafts, and a room can destroy itself after 1, 7 or 30 idle days.
- New: Download a whole project folder as a zip.
- Changed: New messages queue automatically while a member is busy; no need to turn queueing on.

## 0.5.5 (2026-11-21 21:09)

- Changed: A message not yet picked up says why, such as a member out of quota and when it should be back.
- Changed: Folded long answers keep more of their opening.
- Fixed: The workflow canvas and expert settings were laid out wrongly on phones.

## 0.5.4 (2026-11-21 12:02)

- New: "Shared" on the left gathers your share links to renew or revoke them, and can make a share card image with a QR code.
- New: Web demos a member refers to in an answer show right in the text and can be used there.

## 0.5.3 (2026-11-21 08:27)

- New: "Share" downloads a room as a file or publishes a read-only link valid for 1–7 days, leaving out private chats and details of your computer.
- New: Tick only some parts of "Full host control"; the host can also split work into a new room.
- New: Member cards show the model and reasoning effort used.
- New: Keep sending while the last message is still on its way; a failed message can be "Resend".
- Changed: The "Room", "Files" and "Runs" tabs moved to the top of the room.

## 0.5.2 (2026-11-20 11:06)

- Fixed: Returning to a room after creating a new one lost the file preview, expanded cards and unsent drafts.

## 0.5.1 (2026-11-20 10:23)

- Fixed: Smart scheduling cards showed member IDs instead of names.

## 0.5.0 (2026-11-20 09:03)

- Changed: Cards of members at work match answered cards, showing the start time and time spent.
- Fixed: On iPhone and iPad, the file picker for attachments opened in the wrong place.

## 0.4.98 (2026-11-20 02:30)

- New: Manage project files right in the web app—create folders, upload, rename, copy, move and edit text files, with a 30-day "Trash".

## 0.4.82 (2026-11-18 18:28)

- New: Type `#` in the composer to mention project files or folders directly in your messages.
- New: Model API members can turn on web search to look up online information while answering.
- New: Large video attachments compress automatically with upload progress, and image and file previews support pinch zoom.

## 0.4.67 (2026-11-16 07:14)

- New: Invite external members so an AI on another computer can collaborate within the folders you share.
- New: Member answers show the list of files changed in that run with diffs so you can see every edit at a glance.

## 0.4.54 (2026-11-15 02:15)

- New: Switch the interface between Simplified Chinese and English.
- New: Members pop up a question card when blocked on your decision, with optional WeChat alerts and direct replies on timeout.
- New: Browse and resume existing local sessions via "Past sessions" when adding members.

## 0.4.19 (2026-11-11 01:25)

- New: Configure an image generation service in settings so room members can create and deliver images directly.
- New: Preview Word, Excel, PowerPoint, PDF, audio and video right in the app, and let model API members view image attachments.

## 0.4.5 (2026-11-09 20:53)

- New: Install local offline voice input and local text-to-speech without cloud voice API keys.

## 0.4.0 (2026-11-09 08:27)

- New: Visual workflow canvas with draggable nodes, links and auto-arrange.
- New: First built-in room workflows (such as story-serial, decision-council and trpg-classic) ready to install and reuse.

## 0.3.72 (2026-11-06 03:23)

- New: "Private chat" tab to talk with one member directly, pause its work, or inspect what it is doing.
- New: Highlight text in Markdown previews or answers to add excerpts and comments directly to your next message.

## 0.3.57 (2026-11-04 20:09)

- New: "Files" tab and floating preview to browse project folders, code, Markdown and images right in the room.

## 0.3.49 (2026-11-04 00:58)

- New: "Goal" mode lets the host keep driving work toward a clear goal and budget until finished.
- New: Pair phones and tablets securely by QR code to use your computer's rooms and AIs remotely.

## 0.3.42 (2026-11-03 17:45)

- New: Save and enable reusable multi-AI room workflows inside a room.
- New: Enable "Full host control" per room so the host can manage members and runs on its own.

## 0.3.27 (2026-11-02 21:38)

- New: Voice input and spoken answers, plus message queuing when members are busy.

## 0.3.0 (2026-10-29 09:25)

- New: Withdraw pending messages or edit and rewind later messages, automatically rewinding each AI's session.
- New: "Branch from here" on any AI answer to start a new room forked from that point in each member's session.
- New: "Runs" timeline showing when each member started and how long each stage took.

## 0.2.49 (2026-10-25 00:39)

- New: Unified collaborative rooms where multi-round "Discussion" can be started and ended anytime without leaving the room.
- New: Optional "Smart scheduling" model to decide which member or host should handle unmentioned messages.

## 0.2.17 (2026-10-21 22:20)

- New: Add model API members directly (Claude, Gemini, OpenAI, DeepSeek, Qwen, Grok and custom APIs).
- New: Export and import room backups, and set read-only or write project access per member.

## 0.2.0 (2026-10-20 20:02)

- New: Multi-AI collaborative rooms with a host, `@` mentions for parallel work, and multiple instances of the same AI platform.
- New: Send image and file attachments in messages with live room updates.

## 0.1.0 (2026-10-19 06:56)

- New: First installable release connecting local AI apps such as Claude Code, Codex and Antigravity to collaborate and discuss in one shared room.

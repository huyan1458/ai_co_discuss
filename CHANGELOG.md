# Changelog

Versions match the npm package. Recorded from 0.5.0 on, listing only the changes you will notice. The Chinese version is `CHANGELOG.zh-CN.md`; on the website, click the version number at the top left to read it.

## 0.5.21 (2026-11-23)

- New: Bundled workflows add tri-model-dev and update flowcharts across the other built-in workflows.
- New: Workflows support optional "Author" and "Source" fields, and the description wraps cleanly and can be edited above the body.
- Fixed: Dated time labels overlapped or clipped on phones in the timeline, and replay now scrolls to follow the active run.
- Changed: Project files delivered in answers reserve their card space while verifying, stopping messages below from jumping when scrolling or switching rooms.

## 0.5.20 (2026-11-23)

- New: Customize share cards by editing text, picking a room image, or using "Upload cover" with cropping; updates keep your cover.
- New: Antigravity automatically retries up to 3 times in the same session after mid-run network drops, with a "Retry now" option.
- New: Run details add "Run diagnostics" for progress, retries and file attribution, and API members now have time limits so runs do not hang.
- Changed: Timeline replay now auto-zooms to follow the playback line when "Follow" is on, with a unified zoom and replay bar.
- Changed: Interjected messages now nest under the original message; revoking or renewing a shared link updates the list immediately.

## 0.5.19 (2026-11-23)

- Fixed: Background share uploads failed immediately on brief network drops instead of retrying automatically.
- Fixed: After a share failed, its card under "Shared" still showed upload progress and pushed buttons off screen.
- Changed: Unticking attachments while sharing updates the selected count and size live, with a single scroll list and no extra sort buttons.

## 0.5.18 (2026-11-23)

- New: Sharing prepares and uploads in the background even if you lock or leave the page, and "Filter files" supports preview and sorting.
- New: The workflow canvas adds "User" and "Branch" nodes to mark where you step in and where flows split.
- Changed: Reorder speaking order by dragging in the "Room" tab, edit multiple members in a row, and find paused members grouped below.
- Changed: Previewing a ZIP archive now lists its contents first and loads a file only when you click it, so large archives open faster.
- Changed: Sent images keep their local preview and scroll position, and denied operations on finished answers are folded by default.

## 0.5.17 (2026-11-23)

- New: Pick attachments by type or with "Choose files" when sharing; share links now carry up to 300 MB (100 MB per file).
- Fixed: On phones, the replay toolbar buttons and time marks crowded into each other.
- Changed: When a phone or tablet asks for a folder the computer has not opened to it, it now says why and how to allow it on the computer.
- Changed: A small arrow after the version number at the top left shows it opens the changelog.

## 0.5.16 (2026-11-23)

- Fixed: "Deploy as website" always failed when a member published, and was refused on computers with sign-in protection.
- Fixed: Work you leave for after a discussion is now picked up by the host once the discussion ends.
- Changed: Website cards under answers look like a small browser window, showing the address, version and expiry at a glance.

## 0.5.15 (2026-11-23)

- New: Pages members make can go to a public address with "Deploy as website", live for 7 days and renewable.
- New: "Busy & idle" view on the Runs page replays the whole session at its real length, with pinch zoom on phones and tablets.
- New: Members can put small interactive pages right inside their answers.
- New: Click the version number at the top left to read the "Changelog".
- Changed: Rooms with many messages open faster and scroll more smoothly.

## 0.5.14 (2026-11-23)

- Fixed: Scrolling and clicking the message navigation lagged badly in rooms with many messages.
- Changed: While smart scheduling decides who answers, the card just says "Smart scheduling analyzing"; if it fails, it explains why and hands over to the host.
- Changed: Project files and attachments delivered in answers now look the same, so they are easier to find.

## 0.5.13 (2026-11-23)

- Fixed: In rooms with many messages, the page froze for a second or two now and then while a member was working.
- Fixed: A destroyed room's file preview window stayed on screen.

## 0.5.12 (2026-11-23)

- Changed: Documents, spreadsheets, images, web pages and other finished work from members are sent as attachments by default, previewable right in the card.
- Changed: "Full host control" moved into "Advanced settings" when creating a room.
- Fixed: On an unstable network, Antigravity wrongly asked to sign in again and the work failed.

## 0.5.11 (2026-11-23)

- New: Share links can carry attachments (up to 100 MB), including project files members delivered.
- New: Set the project access the host gets by default in new rooms.
- New: Before destroying a room, "Export package" keeps a copy of its messages, private chats and attachments.

## 0.5.10 (2026-11-22)

- New: An imported expert that needs software or a model this computer lacks is marked as unable to run, with how to fix it.

## 0.5.9 (2026-11-22)

- New: Experts in a workflow can carry their own skills, and can be imported, exported or saved as presets on their own.
- Changed: Destroying a room needs two confirmations; a shared room's link must be revoked first.
- Fixed: With many rooms, updating got stuck at "The local service has not stopped".

## 0.5.8 (2026-11-22)

- New: Preview which files are inside a zip archive.
- New: Opening "Runs" on a shared page replays the session from the start.
- Changed: A workflow changed elsewhere is no longer overwritten; you are asked to "Reload".
- Fixed: Share links already sent kept showing the old interface.

## 0.5.7 (2026-11-22)

- Changed: Web demos members make can be viewed right in their answers on phones too.
- Changed: "Host permissions" save automatically when ticked.
- Fixed: On phones, scrolling down after opening a scheduling card pulled the page back.

## 0.5.6 (2026-11-22)

- New: "Destroy room" also removes members' AI conversations and drafts, and a room can destroy itself after 1, 7 or 30 idle days.
- New: Download a whole project folder as a zip.
- Changed: New messages queue automatically while a member is busy; no need to turn queueing on.

## 0.5.5 (2026-11-21)

- Changed: A message not yet picked up says why, such as a member out of quota and when it should be back.
- Changed: Folded long answers keep more of their opening.
- Fixed: The workflow canvas and expert settings were laid out wrongly on phones.

## 0.5.4 (2026-11-21)

- New: "Shared" on the left gathers your share links to renew or revoke them, and can make a share card image with a QR code.
- New: Web demos a member refers to in an answer show right in the text and can be used there.
- New: Hosted accounts show why the relay dropped and offer "Reconnect now"; an unresponsive instance restarts by itself.

## 0.5.3 (2026-11-21)

- New: "Share" downloads a room as a file or publishes a read-only link valid for 1–7 days, leaving out private chats and details of your computer.
- New: Tick only some parts of "Full host control"; the host can also split work into a new room.
- New: Member cards show the model and reasoning effort used.
- New: Keep sending while the last message is still on its way; a failed message can be "Resend".
- Changed: The "Room", "Files" and "Runs" tabs moved to the top of the room.

## 0.5.2 (2026-11-20)

- Fixed: Returning to a room after creating a new one lost the file preview, expanded cards and unsent drafts.

## 0.5.1 (2026-11-20)

- Fixed: Smart scheduling cards showed member IDs instead of names.

## 0.5.0 (2026-11-20)

- Changed: Cards of members at work match answered cards, showing the start time and time spent.
- Fixed: On iPhone and iPad, the file picker for attachments opened in the wrong place.

# Management Panel and Hosted Accounts

Use the local management panel or the corresponding codiscuss admin commands to start, stop, and update CoDiscuss, manage AI sign-ins and API keys, and let family or coworkers use AI on this computer through hosted accounts.

## Opening the management panel and its pages

- **Open on Windows:** During codiscuss setup, select the option to create a CoDiscuss shortcut, or run codiscuss launcher later. Open the desktop shortcut. The CoDiscuss icon appears in the system tray. On first use, enable it under Windows Settings → Personalization → Taskbar → “其他系统托盘图标”. Left-click the tray icon to open the management panel, or run codiscuss panel in a terminal. Right-click to open the site, restart, or stop the service. The panel is available on this computer only.
- **Overview:**
  - **This computer:** Check the CoDiscuss service status, start, restart, stop, or select **Open site**. When hosting is enabled, this page also shows **Program copies** used by isolated accounts.
  - **This computer / Self-hosted relay:** View the local and linked online site addresses. Select **Bind**, **Unbind**, or **Generate access code**.
    During an outage, the page shows one offline notice per computer and reports when the connection returns. Unsent messages for the same room share a notice and can each be retried.

    **Self-hosted relay** and `codiscuss admin status` show **Relay connected** after a heartbeat reply on the current connection, explain disconnects, retries or consecutive HTTP failures, and show **Status unknown** if the service is stopped or its observations are stale. After 3 minutes without heartbeat confirmation, the service rebuilds that site’s connection. Select **Reconnect now** or run `codiscuss admin site reconnect` to request it immediately.

    To pair through your reverse proxy, choose **Other access addresses** on the same row and add its HTTPS origin. See [Reverse proxy on your own domain](remote.md#reverse-proxy-on-your-own-domain).

    On the right of Overview → This computer → Self-hosted relay, pick the region in the Relay region dropdown. The default is Asia Pacific. This setting applies to administrator access, hosted account sign-in through the relay, and external expert invitations. Automatic creates the object near the first party to connect, usually the computer’s network exit. Its location stays fixed after creation. Other values are location hints. After the service syncs the change, the computer and paired devices reconnect automatically. Run `codiscuss admin site region` to inspect the setting or `codiscuss admin site region weur` to select Western Europe.
  - **Hosted account entry** (shown when hosting is enabled): Start or stop the **Sign-in entry**, enable **Self-hosted relay**, or configure the **Cloudflare Tunnel**.
  - **Settings:** View the installed version, select **Check for updates** or **Update and restart** (which also updates room skills and isolated accounts), enable **Start when signing in to Windows**, and change the panel language.
- **Storage:**
  - View local `.codiscuss` data usage against the 10 GiB limit (excluding speech models), total drafts against 3 GiB (1 GiB per room), **Room records & attachments (`local/`)**, disk free space and safety reserve, per-room and per-member breakdowns, and any unreadable entries. Local TTS and STT models are listed separately and excluded from the 10 GiB cap (covering both legacy and custom model paths, including when the service home itself is a symlink or junction).
  - When `.codiscuss` data reaches the 8 GiB warning threshold, the **Storage** tab shows a warning dot and displays a notice; exceeding a limit or dropping below the disk safety reserve pauses new runs. The total is split into five named directories and Other. **Safe cleanup** removes registered failed scratch, speech cache entries, empty orphan directories, stale launches containing only setup records, and local execution files more than 24 hours after completion. After clearing the speech cache, replaying old content with cloud speech synthesizes it again and incurs a new charge. **Deep repair** estimates space before you select and confirm deletion of finished logs, including the last day.
  - **Room attachments** lists each room's sent, not-yet-cleared attachments, largest first. Select **Manage attachments** to expand the same attachment manager as on the room page (see “Storage and limits” in [Managing rooms](rooms.md)).
  - Select “Ask the platform steward to analyze storage,” or run `codiscuss admin storage analyze`, to inventory this account’s member drafts, run logs, workflow backups, room attachments, and local speech models. View the result in the [platform steward](steward.md) conversation. The inventory does not scan the whole drive or delete anything. Approve specific items before cleanup.
  - **Recovery and limits:** If a computer-wide limit blocks the steward, use the management panel to identify what is taking up space and free space first. Room records are never deleted automatically. Attachments can be cleared separately, and you can export a backup before destroying an old room. Unreadable sandbox folders are excluded from quota totals and shown as an unreadable count. Limits are enforced by periodic sampling (disk space every 2s and folder size every 30s while runs are active), not a filesystem write-layer hard quota, so they cannot guarantee the disk will never fill.
  During active runs, the service checks free space on its own volume every two seconds. While part of the 10 GiB budget remains, a drop in free space as large as that remainder triggers an early scan. When a run ends, the service updates that member’s draft usage. A manual retry after cleanup rechecks the limit that blocked the run. If a machine-wide limit was exceeded, the service measures machine-wide usage again. If another program writes to the volume, runs continue when measured usage is within limits and the unreadable count is stable. If an early scan finds more unreadable entries, dispatch pauses and the service requests stops for stoppable runs. Dispatch resumes when a later scan finds a stable count, usage within limits and enough free disk space. The low-disk reserve applies independently. At 80% of the room draft limit, new runs without confirmed stop support are paused. Writes can continue between and during scans, and ongoing unstoppable runs can keep writing. Project files, system temporary files and third-party AI data outside the service directory are excluded. Follow the cleanup instructions on the failed run’s card, then select “Retry” on that card from the computer or a paired device.
- **Account:**
  - **Local account** is listed by default. When hosting is enabled, the page also lists **Hosted accounts** and a **New account** button.
  - Select the administrator or a hosted account to manage its **CLI sign-ins** (Claude Code, Codex, and Gemini status, sign-in method, or sign-out; Setup Token is recommended for Claude Code), **API keys**, **Skills** (select from **Skill library** or import a ZIP/folder), **bundled workflows**, and **system prompt** (editable for hosted accounts: sent to every member CoDiscuss wakes for that account, ahead of what the account’s user writes in **Settings → System prompts**; the user cannot change it on the website or with commands (it is kept in the account’s own service folder, so this is not tamper-proof); CLAUDE.md and AGENTS.md are not written. Set the administrator’s own in **Settings** on the website). Updating the program leaves installed workflows unchanged; the workflows section works like the update check on the overview page. A tag next to the title shows **Up to date** or how many workflows can be synced; the button in the top-right corner is **Check shipped workflows** while everything matches, and turns blue as **Sync to latest** once something differs. After you confirm, it installs the missing ones and replaces those that differ (each replaced copy is first backed up to `backups/workflows` in that account's service folder, and changes made there are replaced too).

## Hosted accounts for other people

When creating an account, fill in **Project data directory (optional)** or run `codiscuss admin account add alice --project-data-root "D:\CoDiscussData\alice"`. The parent must exist. CoDiscuss creates the account directory with `projects`, `workspace` for rooms without a project, and `drafts` for member drafts. Configuration, credentials, room databases and attachments stay in the account's service directory. Leave the field empty for the default layout.

Choose a different name when creating a hosted account, as `cloud` is reserved for cloud storage.

On the Storage page set the attachment limit to a whole number from 1 to 90 MiB (default 50). Run `codiscuss admin storage attachment-limit 75` to set it, or omit the number to read it. For a self-hosted Python site, put the integer (for example `75`) in `attachment-limit.json` beside the database, or point `DISCUSS_ATTACHMENT_POLICY_FILE` to the file.

**Cloud space (object storage):** Each account has one cloud space on the resource center's object storage, managed by CoDiscuss. Attachments larger than the “Cloud space threshold” (up to 2 GiB each) are kept there; others stay on the computer as ordinary attachments. Large files that you or hosted clients send, and large deliverables from members, are kept there and can be taken from the room even when you are away. It is also the account's cloud drive: files can be uploaded straight into it under “Cloud space” on the Files page of the room website (see [Rooms](rooms.md)). There are no folders.

Set it up under “Cloud space (object storage)” on the Storage page:

- **Resource center address and key:** enter the “Resource center address” first, then the “Object storage key”. It saves when you leave the field or press Enter. Each account uses its own key, kept in that account's key store like its API keys. A saved key is never shown again, and a new address needs the key entered again.
- **Retention days:** The default of 0 disables deletion based on retention days. Set 1 to 30 to remove files that many days after upload completes, at which point their cards show “Deleted from cloud space”. Regular cleanup removes attachments that are neither sent nor queued after 24 hours, even if the upload has finished.
- **Space quota (MiB):** 10240 (10 GiB) by default. Once full, new large uploads are refused with the space used and the quota, until old files are deleted. The administrator can set it for each hosted account; hosted accounts cannot change their own.
- **Cloud space threshold (MiB):** 20 by default, at most the attachment limit. When the threshold is below the attachment limit, files between the two (20 to 50 MB by default) also go to the cloud space: they have no preview or player in the message, members are not given them automatically when woken, and videos are no longer compressed in the browser, keeping their original quality. To avoid this change, set the threshold equal to the attachment limit.
- **Manage cloud space:** lists every file in the chosen account's cloud space, with the space used and the quota at the top: large attachments, and files saved with “Save to cloud space” from attachments or Files, each with its name, size, time and source (room, message or project path). You can download them, select them to delete, or select “Share” to create or revoke share links for the account's files (the same rules as “Cloud space” on the Files page; see [Rooms](rooms.md)). After a large attachment is deleted its message stays, and its card shows “Deleted from cloud space”. The account itself manages the same list under “Cloud space” on the Files page of the room website (see [Rooms](rooms.md)).
- **Use the administrator's cloud space** (hosted accounts only): when on, the account keeps no key of its own. This computer signs the account's uploads, downloads and deletions, only within the account's own folder, and enforces its space quota, so AI in the hosted account cannot read the key. The administrator's local service must keep running; when it is not, the cloud space is unavailable. From the command line, use `codiscuss admin storage object --account NAME --use-admin`. Note:
  - In this mode, turn off versioning on the resource center's bucket. Otherwise deleted files keep old versions that still take space, and the space quota cannot be counted correctly.
  - When replacing the administrator's key at the same resource center address, use a new key for the original storage directory. CoDiscuss keeps each hosted account's existing usage.
  - Switching between an own key and “Use the administrator's cloud space” does not move existing files to the other side, and they can no longer be viewed or deleted here afterwards. Before switching, download the files you need and delete the ones you no longer want.
- “Test connection” checks it works. “Clear” only removes the configuration; the key stays in the key store, and you can delete it under the account's API keys.

With hosting on, switch accounts above the fields to set up and manage a hosted account's cloud space. Hosted accounts can also enter their own key and change the retention days and threshold under “Settings → Account → Cloud space (object storage)” in the room website. They manage their files under “Cloud space” on the Files page. When an admin supplied the key, the page shows “Provided by admin”. Their interface does not show the key, but AI members in their account can read that account's key file; give each account its own key.

From the command line:

- `codiscuss admin storage object` shows the status.
- `--url URL --key-file FILE` saves. The key is read from a file or standard input, never from the command line.
- `--test` tests the connection, and `--clear` clears it.
- `--retention-days N` (0 to 30, 0 for no automatic deletion), `--quota-mib N` and `--threshold-mib N` set the retention days, space quota and threshold.
- Add `--account NAME` for a hosted account, or omit it for the administrator.
- Use `codiscuss admin storage object list` to list cloud files or `link ID` to get a temporary download link. `delete ID` moves a drive file to trash. Add `--purge` to delete it permanently. Room attachments and temporary transfers are always deleted immediately. Use `trash` to list trash, `restore ID` to restore a file, or `restore ID --folder` to restore a folder. All these commands accept `--account NAME`.
- Use `codiscuss admin storage object share ID [--days N]` to create a public link to one file, `shares ID` to list link status and expiry, or `revoke-share ID SHARE_ID` to revoke a link. All three accept `--account NAME`. The full link appears only when created. It expires after 7 days by default, or up to 30 days.

Note:

- The web page uploads files straight to the bucket, so the bucket's CORS settings must allow the addresses you open the page from (the local address and the online site). Otherwise uploads report that object storage cannot be reached.
- Each account's AI can read only that account's key. If several accounts get the same resource center key, their AI still reads one key that can see the whole folder. Full isolation needs the resource center to issue a separate key for each account.
- After clearing, files over the threshold can no longer be uploaded, and attachments already in the cloud space cannot be downloaded.
- Automatic and manual deletion are carried out by the website on this computer. Do not set an automatic deletion rule on this folder, or it will delete files that need to be kept long term. Files left behind after CoDiscuss is uninstalled or an account is deleted are cleaned up by the administrator in the resource center.
- For a self-hosted Python site, put two files beside the database, with the same address in both:
  - `api-keys/<UUID>.json`, containing `{"base_url": "resource center address", "api_key": "key"}`;
  - `object-storage-settings.json`, containing `{"base_url": "resource center address", "api_key_ref": "<UUID>"}`, optionally with `retention_days`, `quota_mib` and `object_threshold_mib` (0, 10240 and 20 when omitted).

Storage accounting includes service data and member drafts. Projects and workspaces are outside the draft quota. When the directories use different volumes, each must meet its own free-space reserve. The management panel and steward inventory use the account’s configured draft location. Cross-volume project storage and **Restrict other drives** are mutually exclusive. The isolated Windows account needs access to the project volume.

On Windows, open the panel from the tray. On macOS and Linux, use the command-line panel controls below. Most personal setups do not need hosting. Enable it when family or coworkers need to sign in from a browser outside your network and use the AI on this computer.

### Set it up

1. **Enable hosting:** Run codiscuss setup --hosting, or select hosting during codiscuss setup. Turn it off with --no-hosting. The choice is remembered.
2. **Create an account and isolate it:** In the panel, go to **Accounts** → **New account** and enter an account name. On Windows, **Isolation** is selected by default. This creates a separate Windows user and prompts for administrator approval. The setup installs a program copy, room skills, system prompt, and bundled workflows, then starts the account’s site. The password is shown once, so save it before closing.
   - **Why isolate:** Without isolation, the hosted account runs as your Windows user. Its AI can read your personal files, and the account shares your sign-ins and skills. Isolation gives it a separate Windows user, sign-ins, and folders.
   - **Entry protection:** This is enabled by default on the hosted account details page and is available on Windows only. It restricts site access to users authenticated by the sign-in entry and that account’s own AI, blocking direct access by other local programs.
3. **Configure remote access** using either or both options:
   - **Self-hosted relay, without your own domain:** Follow the [deployment guide](../deployment.md#entry-for-hosted-accounts-optional) to deploy the entry Worker. On the deployment computer, generate an access code under **Overview** → **This computer** → **Self-hosted relay**. On this computer, bind the self-hosted relay and turn on **Self-hosted relay** under **Hosted account entry**. You can also run codiscuss admin entry join <access-code>.
   - **Cloudflare Tunnel:** Under **Hosted account entry** → **Cloudflare Tunnel**, authorize a Cloudflare tunnel and connect a domain hosted on Cloudflare. The CLI equivalent is `codiscuss admin entry tunnel <domain>`. After changing proxy or network settings, click **Reconnect** or run `codiscuss admin entry tunnel reconnect` to use the new route. Access may pause briefly while signed-in customers keep their sessions.
4. **Manage the account:** Start or stop its instance, enable, disable or remove the account, reset its password, and provide API keys. Users see **Provided by admin** for administrator-provided keys and cannot view or change them. To invite external experts, the account needs an online relay. The panel checks instances requested to run every minute and restarts them if their port refuses connections, up to 3 times in 10 minutes. After repeated failures, the account row shows the last error. Check `codiscuss admin status` for the latest attempt and start the instance manually after fixing the cause to resume recovery.

### Move an existing account’s project data to another drive

Finish the account’s running tasks and close external programs writing its files. In the account detail view enter a new absolute path under an existing administrator-controlled directory and choose **Stop instance and move data**. From the CLI run `codiscuss admin account migrate-data <account> --project-data-root <new-directory>`. The target volume needs space for a complete copy and the isolated account needs access to it.

The move covers projects, room workspaces and member drafts. It stops the instance, verifies each file with SHA-256 and creates junctions so existing rooms can use their original paths. Start the instance manually afterward. After a rolled-back copy failure, choose a fresh destination. If the panel was interrupted, retry with the same destination. Links and special files stop the copy. Cross-drive storage and the option to restrict other drives are mutually exclusive. Choose an allowed volume when drive restrictions are active.

Backups still use space on the original volume, outside the directories counted toward the runtime quota. In the account details choose **View migration backups** to see each registered path and its current file byte count and allocated disk space. Choose **Release migration backup** and confirm to stop the instance and remove the selected backup after verification. You can add, edit or delete files in the active project or drafts after migration. Release requires the original destination directory, the old junction pointing to it, and a backup matching the migration receipt. A failed check keeps the backup in place. Confirm the same item again after an interruption. Older directories without verification records require manual review. In the CLI, run `codiscuss admin account migration-backups <account>`, then `codiscuss admin account release-backup <account> <migration-id> <kind> --confirm`.

### macOS and Linux

macOS and Linux have a management-panel service and code paths for non-isolated accounts. Start the background panel with codiscuss panel start, then create one with codiscuss admin account add <name> --no-isolate. The instance runs as the service’s operating-system user, so accounts do not have OS-level isolation. The complete workflow from account creation to external sign-in has not yet been tested on those systems. Separate Windows users, entry protection, the tray icon, and startup at Windows sign-in are Windows features.

## Manage over SSH with codiscuss admin

Every command in the table is prefixed by codiscuss admin and returns JSON. These commands are useful for managing the computer over SSH. Only the local administrator can use them.

| Task | Commands |
| --- | --- |
| Start, exit, restart, or update (panel need not be running) | `codiscuss admin start`, `stop`, `restart`, `update [check]` |
| Check status, control service, configure sign-in startup | `status [--full]`, `service start\|stop\|restart`, `autostart on\|off` |
| Inspect storage usage and clear temporary run files | `storage`, `storage clean`, `storage repair` (preview), `storage repair logs --confirm` |
| Ask the platform steward to analyze storage | `codiscuss admin storage analyze` |
| View and clear attachments by room | `codiscuss admin storage attachments` (usage per room), `storage attachments ROOM` (list files), `storage attachments ROOM clear ID... --confirm` |
| Bind/unbind the self-hosted relay and create access code | `site status`, `site connect <access-code\|site>`, `site disconnect`, `entry code` |
| Manage sign-in entry and tunnel | `entry start\|stop`, `entry join <access-code>`, `entry open\|close relay\|tunnel`, `entry tunnel <domain>`, `entry tunnel reconnect` |
| Manage hosted account lifecycle | `account list`, `account add <name>`, `account start\|stop\|disable\|enable\|remove\|password <name>`, `account isolate\|protect <name>` |
| Manage sign-ins, keys, skills, workflows, and prompts | `login status <target>`, `key add <target> --base-url … --key …`, `skill install <target> <skill>`, `workflow install <target>`, `workflow update <target>`, `prompt set <target> --file …` |

Use owner as <target> for the administrator, or use a hosted account name. If account add fails partway, fix the issue and run the same command again to resume the missing steps.

## Things to keep in mind

- **admin stop leaves hosted instances running:** codiscuss admin stop exits the panel, tray icon, sign-in entry, tunnel, and administrator service. Already running hosted-account instances continue. To stop one, run codiscuss admin account stop <name>.
- **Administrator approval:** Create or delete isolated Windows users from an administrator terminal or administrator SSH session. Otherwise, approve the UAC prompt on the computer.
- **Panel-only actions:** Select **Initialize again** for an existing hosted account’s AI environment or change the management panel language in the panel.
- **Remote traffic:** When hosted accounts connect through the self-hosted relay or a Cloudflare Tunnel, login and session protection run on your computer, while traffic passes through Cloudflare and counts toward Workers usage.

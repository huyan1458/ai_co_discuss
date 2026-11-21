# Management Panel and Hosted Accounts

Use the local management panel or the corresponding codiscuss admin commands to start, stop, and update CoDiscuss, manage AI sign-ins and API keys, and let family or coworkers use AI on this computer through hosted accounts.

## Opening the management panel and its pages

- **Open on Windows:** During codiscuss setup, select the option to create a CoDiscuss shortcut, or run codiscuss launcher later. Open the desktop shortcut. The CoDiscuss icon appears in the system tray. On first use, enable it under Windows Settings → Personalization → Taskbar → “其他系统托盘图标”. Left-click the tray icon to open the management panel, or run codiscuss panel in a terminal. Right-click to open the site, restart, or stop the service. The panel is available on this computer only.
- **Overview:**
  - **This computer:** Check the CoDiscuss service status, start, restart, stop, or select **Open site**. When hosting is enabled, this page also shows **Program copies** used by isolated accounts.
  - **Administrator entry / Online site:** View the local and linked online site addresses. Select **Bind**, **Unbind**, or **Generate access code**.
    **Online site** and `codiscuss admin status` show **Relay connected** after a heartbeat reply on the current connection, explain disconnects, retries or consecutive HTTP failures, and show **Status unknown** if the service is stopped or its observations are stale. After 3 minutes without heartbeat confirmation, the service rebuilds that site’s connection. Select **Reconnect now** or run `codiscuss admin site reconnect` to request it immediately.
  - **Hosted account entry** (shown when hosting is enabled): Start or stop the **Sign-in entry**, enable **Through the online site**, or configure your **Own domain** using Cloudflare Tunnel.
  - **Settings:** View the installed version, select **Check for updates** or **Update and restart** (which also updates room skills and isolated accounts), enable **Start when signing in to Windows**, and change the panel language.
- **Account:**
  - **Local account** is listed by default. When hosting is enabled, the page also lists **Hosted accounts** and a **New account** button.
  - Select the administrator or a hosted account to manage its **CLI sign-ins** (Claude Code, Codex, and Gemini status, sign-in method, or sign-out; Setup Token is recommended for Claude Code), **API keys**, **Skills** (select from **Skill library** or import a ZIP/folder), **bundled workflows**, and **system prompt**. Updating the program leaves installed workflows unchanged; the workflows section always shows **Check** and **Sync to latest**. **Check** compares the library with the bundled versions and lists missing workflows and those that differ; **Sync to latest** installs the missing ones and replaces those that differ (each replaced copy is first backed up to `backups/workflows` in that account's service folder, and changes made there are replaced too). It is greyed out when everything matches.

## Hosted accounts for other people

On Windows, open the panel from the tray. On macOS and Linux, use the command-line panel controls below. Most personal setups do not need hosting. Enable it when family or coworkers need to sign in from a browser outside your network and use the AI on this computer.

### Set it up

1. **Enable hosting:** Run codiscuss setup --hosting, or select hosting during codiscuss setup. Turn it off with --no-hosting. The choice is remembered.
2. **Create an account and isolate it:** In the panel, go to **Accounts** → **New account** and enter an account name. On Windows, **Isolation** is selected by default. This creates a separate Windows user and prompts for administrator approval. The setup installs a program copy, room skills, system prompt, and bundled workflows, then starts the account’s site. The password is shown once, so save it before closing.
   - **Why isolate:** Without isolation, the hosted account runs as your Windows user. Its AI can read your personal files, and the account shares your sign-ins and skills. Isolation gives it a separate Windows user, sign-ins, and folders.
   - **Entry protection:** This is enabled by default on the hosted account details page and is available on Windows only. It restricts site access to users authenticated by the sign-in entry and that account’s own AI, blocking direct access by other local programs.
3. **Configure remote access** using either or both options:
   - **Through the online site, without your own domain:** Follow the [deployment guide](../deployment.md#entry-for-hosted-accounts-optional) to deploy the entry Worker. On the deployment computer, generate an access code under **Overview** → **This computer** → **Online site**. On this computer, bind the online site and turn on **Through the online site** under **Hosted account entry**. You can also run codiscuss admin entry join <access-code>.
   - **Own domain:** Under **Hosted account entry** → **Own domain**, authorize a Cloudflare tunnel and connect a domain hosted on Cloudflare. The CLI equivalent is codiscuss admin entry tunnel <domain>.
4. **Manage the account:** Start or stop its instance, enable, disable or remove the account, reset its password, and provide API keys. Users see **Provided by admin** for administrator-provided keys and cannot view or change them. To invite external experts, the account needs an online relay. The panel checks instances requested to run every minute and restarts them if their port refuses connections, up to 3 times in 10 minutes. After repeated failures, the account row shows the last error. Check `codiscuss admin status` for the latest attempt and start the instance manually after fixing the cause to resume recovery.

### macOS and Linux

macOS and Linux have a management-panel service and code paths for non-isolated accounts. Start the background panel with codiscuss panel start, then create one with codiscuss admin account add <name> --no-isolate. The instance runs as the service’s operating-system user, so accounts do not have OS-level isolation. The complete workflow from account creation to external sign-in has not yet been tested on those systems. Separate Windows users, entry protection, the tray icon, and startup at Windows sign-in are Windows features.

## Manage over SSH with codiscuss admin

Every command in the table is prefixed by codiscuss admin and returns JSON. These commands are useful for managing the computer over SSH. Only the local administrator can use them.

| Task | Commands |
| --- | --- |
| Start, exit, restart, or update (panel need not be running) | `codiscuss admin start`, `stop`, `restart`, `update [check]` |
| Check status, control service, configure sign-in startup | `status [--full]`, `service start\|stop\|restart`, `autostart on\|off` |
| Link/unlink online site and create access code | `site status`, `site connect <access-code\|site>`, `site disconnect`, `entry code` |
| Manage sign-in entry and tunnel | `entry start\|stop`, `entry join <access-code>`, `entry open\|close relay\|tunnel`, `entry tunnel <domain>` |
| Manage hosted account lifecycle | `account list`, `account add <name>`, `account start\|stop\|disable\|enable\|remove\|password <name>`, `account isolate\|protect <name>` |
| Manage sign-ins, keys, skills, workflows, and prompts | `login status <target>`, `key add <target> --base-url … --key …`, `skill install <target> <skill>`, `workflow install <target>`, `workflow update <target>`, `prompt set <target> --file …` |

Use owner as <target> for the administrator, or use a hosted account name. If account add fails partway, fix the issue and run the same command again to resume the missing steps.

## Things to keep in mind

- **admin stop leaves hosted instances running:** codiscuss admin stop exits the panel, tray icon, sign-in entry, tunnel, and administrator service. Already running hosted-account instances continue. To stop one, run codiscuss admin account stop <name>.
- **Administrator approval:** Create or delete isolated Windows users from an administrator terminal or administrator SSH session. Otherwise, approve the UAC prompt on the computer.
- **Panel-only actions:** Select **Initialize again** for an existing hosted account’s AI environment or change the management panel language in the panel.
- **Remote traffic:** When hosted accounts connect through the online site or a Cloudflare Tunnel, login and session protection run on your computer, while traffic passes through Cloudflare and counts toward Workers usage.

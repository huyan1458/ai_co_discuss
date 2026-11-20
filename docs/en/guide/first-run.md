# Your first room

Create a room and send a member a short message. When its reply appears in the conversation, your setup is working.

## Before you start

- **Cost.** CoDiscuss is free and open source. Local AI tools use your existing account, subscription, or usage allowance. Providers bill for model APIs, smart scheduling, image generation, web search, and cloud speech. Local speech uses no cloud speech credits.
- **System.** Install Node.js 24 or later and Python 3.10 or later. The `local` commands below start the website on Windows, macOS, and Linux. On a headless computer, no browser opens automatically. The admin panel desktop window, tray icon, CoDiscuss shortcut, automatic startup at sign-in, and hosted-account entry protection are Windows features.
- **Data.** By default the room database is `~/.codiscuss/local/discuss.sqlite3`. Configuration, member credentials, and saved API keys are in `~/.codiscuss`. If you leave the project folder blank, each room gets its own scratch folder under `~/.codiscuss-workspace`. Uninstalling the npm package preserves this data.
- **Shutdown or sleep.** Paired devices lose access and the local service cannot deliver new tasks. Once the computer and service are back online, devices with valid authorization reconnect. Check the room for replies or failure cards before retrying work.
- **If you only use a web chatbot.** The ChatGPT, Claude, and Gemini web apps cannot join a room as members. Use a signed-in local AI tool or obtain a model provider's API key. Other local AI tools that can run CoDiscuss commands may be able to [connect manually](members.md#manual-connection).

## 1. Check that one AI is ready

Check your account outside CoDiscuss using a tool you already have.

- **Claude Code CLI.** Run `claude auth status` in a terminal. If you choose Setup Token in the CoDiscuss admin panel, run `claude setup-token` on a computer signed in to Claude and enter the token in the panel.
- **Codex CLI or Codex App.** Use CLI version 0.163.0 or later. Check its sign-in with `codex login status`. For App access, open a signed-in window and leave it running.
- **Gemini (Antigravity CLI or Antigravity App).** Open the tool you intend to connect, sign in when prompted, and send a message to check that it replies. The CLI command is `agy`.

For a model API, have your key ready. The installer installs Pi, the local runtime that calls model APIs and runs tasks for API members. You'll choose the model when you create the room.

## 2. Install CoDiscuss and open the local site

Run these commands in order:

```sh
npm install --global ai_co_discuss@latest
codiscuss setup
```

Confirm the detected tools and install their skills. Interactive setup on Windows also offers **Create CoDiscuss shortcut**. By default, setup opens `http://127.0.0.1:8765`. If only the terminal output appears, open the local address it prints. If setup reports **Configuration needs attention**, follow the instructions for the affected item and rerun `codiscuss setup`.

Later, use `codiscuss local open` to open the site, `codiscuss local status` to check it, and `codiscuss local stop` to stop the site and its managed services.

## 3. Create a room and get a reply

1. Select **New room** in the left sidebar. Under **What to do**, enter a **Topic**, such as “First test”. You can leave **Project folder (optional)** blank.
2. Under **Who takes part**, choose **Add AI** and select a configured platform. Its member card appears below. One member is enough for this test.
3. For an API member such as OpenAI, select **Settings** on the front of the card. Check **Address** and **Protocol**, enter the **Key**, select a **Model**, and choose **Done**.
4. The crown marks the host. To change hosts, select **Make host** on the desired card. For your first room, under **How to work (optional)** set **After creation** to **Off**.
5. Select **Create and connect**. The right sidebar lists the members. If all members start manually, the button reads **Create room**. [Register a manual member](members.md#manual-connection) before sending work.
6. Type `@` in the composer, select the member, and write “Reply with one sentence to confirm you received this.” Choose **Send**. The card shows the processing status, followed by the member's reply in the conversation.

## 4. Create a room from an existing Claude Code or Codex conversation

For this example, start the local site and configure both Claude Code and Codex. Open the **project conversation** you want to host the discussion and send this request:

> Use the discuss-host and discuss-participant skills to create a room called “Cache design review” at http://127.0.0.1:8765 and start a discussion immediately. Host it in this session and invite the other configured tool. If you're Claude Code, invite Codex. If you're Codex, invite Claude Code. Use the current project folder for a read-only review. Leave the files untouched. Identify one cache invalidation risk and one way to test for it. Limit the discussion to three rounds and 60 minutes. Give me the room name and reading link when it's ready.

In Codex, you can invoke the skills by name with `$discuss-host` and `$discuss-participant`. The AI runs `codiscuss launch start --file …` and handles the session ID and launch file. Open the local site and select “Cache design review” in the left sidebar to see the discussion. To create an ordinary room, ask it to create the room without starting a discussion and omit the discussion goal and limits.

## Things to check

- Check project access on each member card before assigning work. Automatically launched CLI and API members that support access controls usually default to read-only. Manual connections retain the original window's permissions. Available levels vary by tool.
- Running `codiscuss` by itself starts the service in the foreground. Use `codiscuss local open` to open the website.
- Gemini's Antigravity CLI cannot start a fully automatic discussion hosted in its current CLI conversation. Create it from the website instead.
- The default local address works only on this computer. For access away from home, bind the computer to an online site, then pair your phone or tablet while you're at the computer.

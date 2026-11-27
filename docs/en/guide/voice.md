# Voice and notifications

Listen to AI replies and project files, dictate messages with a microphone, and receive WeChat notifications when a Goal needs your confirmation or a member asks you a question.

## Read aloud and voice input: local and cloud options

Choose services separately for “Read aloud” and “Voice input” under “Settings → Speech.” Each service keeps its own key and voice settings when you switch away and back.

| Option | Services | Requirements and cost |
| --- | --- | --- |
| **Local text to speech** | “Local” (Qwen3-TTS; four optional VoxCPM2 voices) | Free and requires no API key. Uses about 3.5 GB of disk space and at least 4 GB of GPU memory when using a GPU. VoxCPM2 adds about 4.5 GB of disk space and needs an 8 GB GPU. Supported on Windows (NVIDIA, or AMD/Intel discrete GPU with Vulkan), Apple Silicon macOS (Metal), and Linux x64 (Vulkan or CPU). CPU-only generation can take ten seconds or more per segment. Speed controls are unavailable. The service starts on demand and exits after five idle minutes to release GPU memory. |
| **Cloud text to speech** | Volcengine (Doubao Speech Synthesis 2.0), Alibaba Cloud Bailian (CosyVoice), Azure (Neural voices; enter a region), and OpenAI (gpt-4o-mini-tts, scheduled to retire 2027-01-06) | Enter a provider API key. OpenAI can reuse a key already saved locally. Charges follow your provider account; local GPU memory is not used. Speed controls are available. Volcengine, OpenAI, and local Qwen3-TTS support tone instructions. |
| **Local speech recognition** | “Local” (CrispASR + Qwen3-ASR) | Free and requires no API key. Uses about 1.7 GB of disk space and 2.5 GB of GPU memory at runtime. Running local speech recognition and text to speech together can leave little memory on an 8 GB GPU. Supports Windows, Apple Silicon macOS, and Linux x64. CPU-only recognition is available and takes about as long as the recording. The service starts on demand and exits after five idle minutes. |
| **Cloud speech recognition** | Volcengine (File Speech Recognition 2.0) and OpenAI (gpt-transcribe, scheduled to retire 2027-02-26) | Enter the provider API key. Charges follow your provider account. |

### Install local text to speech and speech recognition

If the local service you want is not installed, select “Ask the platform steward to install” for it in “Settings → Speech.” The installation changes your computer. Confirm to proceed, then follow progress in the [platform steward](steward.md) conversation. The setup skills ship with CoDiscuss and do not need to be installed into your AI software. To add the VoxCPM2 model, run `codiscuss steward ask local-tts-setup --confirm --note "Also install the VoxCPM2 model"`.

Before downloading, choose a parent folder for the models. The default is `.codiscuss-models` in your user home. Read-aloud uses the `yovoice/` subfolder and recognition uses `crispasr/`. You can place them on different drives. On Windows, if C: has less than 30 GiB free and another drive has enough space, the AI suggests that drive. Existing installations continue using their original folders after an upgrade.

The AI checks GPU, disk space, and CoDiscuss version, reports expected resource use, downloads the engine and model, saves a local token, and verifies the installation. Then refresh the page and select “Local” under “Settings → Speech.” If you just upgraded and the new option is missing, run `codiscuss service restart` to restart the discussion service, the local background program that wakes AI members and handles tasks. The local site serves the room pages separately. Refresh the page afterward.

### Use read aloud and voice input

1. **Choose voices:** Under “Settings → Speech,” choose and preview a general voice. You can also choose separate voices for AI platforms such as Claude, Codex, and Gemini, and for project files.
2. **Read replies and turn on speech broadcast:**
   - To read one message, choose “Read aloud” in its toolbar. On a phone, find it in the “…” menu. Select text and choose “Listen here” to start there. When it finishes, playback continues with later messages and skips code blocks. The current sentence is highlighted. Click it to pause or resume. At the bottom, choose “Follow” to scroll with playback or “Exit” to stop.
   - To read replies automatically, click the speaker icon at the bottom-right of the composer (**Turn on speech broadcast**). New replies are read as a summary: short answers are read in full, and longer answers start with the first paragraph. Failures, authorization requests, and discussion endings are announced too. Playback continues when the screen is locked or you switch apps. Headphone controls are supported. Cached passages can be replayed without calling the speech service again.
3. **Read project files:** Open a Markdown file on the Files page and click “Read aloud” in the preview title bar. The opening YAML metadata is skipped. Playback continues while the preview is minimized. Switching to source, changing files, or closing the preview stops it.
4. **Dictate text:** Click or hold the microphone button at the bottom-right of the composer. Click again or release to transcribe into the draft. Each recording can last up to five minutes. The browser asks for microphone access the first time.
5. **Stop a stuck local process:** If a crash leaves a voice process using GPU memory, open “Settings → Speech.” Find “Local process,” check its process name and PID, and click the power button to stop it.

## WeChat notifications

WeChat notifications use Tencent’s iLink bot channel with your **personal WeChat account**. Your computer’s local service sends and receives text messages. WeChat login credentials stay on this computer.

### Set up WeChat

1. Open “Settings → Notifications” on the local site and click “Scan to link” under “WeChat.”
2. Scan the code with your personal WeChat account and confirm the login.
3. **Send a test message:** After scanning, send any message from your phone to the newly bound bot so it can establish the conversation.
4. Return to the site and click “Send test.” Linking is complete when the site says “Test notification sent” and you receive the test in WeChat. Click “Unlink” if you no longer need it.

### Notifications and replies

- **Goal awaiting confirmation for three minutes:** If the host marks Goal as “Awaiting your confirmation” and you do not reply in the room for three minutes, the local service sends a WeChat reminder. When the computer is bound to an online site, the message includes a room link. A direct reply goes to the room associated with the most recent notification. If several rooms are waiting, reply to the notification for the room you mean.
- **A member’s question waiting for three minutes:** Whether or not Goal is active, the service sends the question and numbered options after a question card has waited three minutes. Recommended options are marked “(recommended).”
  - Reply with an option number. For multiple selections, separate numbers with spaces or commas. For several questions, answer in order, for example 1 2. You can also reply with text that exactly matches an option. The answer goes directly to the member who asked.
  - Other text goes to the host, who interprets it or asks you a follow-up in the room.
  - If the question was answered, canceled, or updated, WeChat explains why and does not submit a stale answer.
- **When a notification cannot be sent:** If the room is waiting for your answer or Goal confirmation and the latest WeChat notification failed, a dashed line above the question card on the Messages page gives the reason and how to fix it. “Settings → Notifications” also shows the time and reason of the failure. The most common cause is not having messaged the bot in WeChat for a long time, after which WeChat stops accepting notifications; send the bot any message in WeChat to restore it.

## Other notification channels: Telegram, Discord, QQ, Feishu

For guided setup, select “Ask the platform steward to configure” in “Settings → Notifications” and confirm, then continue in the [platform steward](steward.md) conversation. Enter channel credentials yourself in the web settings.

Besides WeChat, “Settings → Notifications” can connect Telegram, Discord, a QQ official bot and a Feishu custom app bot. You can connect several, then enable and order them in the channel list at the top of the Notifications section: the first enabled channel is the “Primary” one. A reminder goes out on it first and, if it cannot send (not ready or the send fails), on the next channel in order; each reminder is sent once. A reply on any linked channel goes back to the room, with the same rules as WeChat (quoting a notification sends the reply to that notification’s room; replying to a question notification with an option number answers it). The local service connects to these channels directly, with no public address and no other software to install.

1. Create your own bot on the platform and get its credentials: for Telegram, send `/newbot` to @BotFather for a Bot Token; for Discord, create an application in the Developer Portal, turn on the Message Content Intent and install the bot in a server you manage; for QQ, get the AppID and AppSecret from the QQ Open Platform; for Feishu, create a custom app, enable the bot capability and private-chat permissions, and choose the long connection for event subscription.
2. Enter the credentials under that channel in “Settings → Notifications” and select “Save and verify.” The page shows a bind code valid for 10 minutes.
3. Send the bind code to the bot in a private chat. Only the first account that sends the right code is linked as you; after that the bot only handles your private messages.
4. Once it shows “Linked,” select “Send test” to confirm you receive it.

Note: whether a QQ official bot may message you first depends on the permissions the platform grants; “Send test” tells you. Credentials stay on this computer.

**QQ (personal account)**: another way to connect QQ. You run a program such as NapCat, SnowLuma or LLOneBot that logs in a QQ account (a dedicated spare account is best) and serves a OneBot 11 interface; enter its address (such as `ws://127.0.0.1:3001`) and access token under “QQ (personal account),” then send the bind code to that account in a private chat from your own QQ. It is an ordinary QQ user, so it can message you at any time; but it uses an unofficial protocol, the login may expire and need a new scan, the account may be restricted, and running the QQ client takes a few hundred MB of memory.

## Things to know

- **The local service must be online:** Read aloud, voice input, and WeChat notifications run through the local service. If the computer is off or the service is stopped, paired devices cannot use them.
- **Expired WeChat login:** If the login expires after a long period without use, open “Settings → Notifications” and, under “WeChat,” click “Scan to link” again.
- **Speech recognition can mishear identifiers:** Local Qwen3-ASR handles mixed Chinese and English, punctuation, and capitalization well. It may misrecognize letter-by-letter abbreviations such as N-P-M or code identifiers. Review the draft before sending.

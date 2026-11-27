<div align="center">

# AI CoDiscuss

**One room for all your AI agents.**

Bring Claude Code, Codex, Antigravity and model APIs into a shared room —<br>
each keeps its own session, tools and account — then delegate by mention or run structured discussions.

[Quick Start](#quick-start) · [User Guide](docs/en/guide/README.md) · [How It Works](#how-it-works) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/huyan1458/ai_co_discuss/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/huyan1458/ai_co_discuss/actions/workflows/ci.yml)
[![npm](https://img.shields.io/badge/npm-ai__co__discuss-CB3837?logo=npm)](https://www.npmjs.com/package/ai_co_discuss)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933?logo=nodedotjs&logoColor=white)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<a href=".github/assets/promo.mp4"><img src=".github/assets/promo.webp" alt="AI CoDiscuss intro: several AI agents are mentioned in one room, work in parallel and reach a sourced conclusion" width="900"></a>

<sub>Click the animation for the full video with sound</sub>

</div>

## Why AI CoDiscuss

Most multi-agent frameworks spin up fresh agents inside their own runtime. AI CoDiscuss takes the opposite approach: it connects the AI tools you **already use** — with their existing sessions, project context, permissions and subscriptions — and gives them a shared room with a durable record of messages, viewpoints, disagreements and conclusions.

## What It Does

The [User Guide](docs/en/guide/README.md) covers each of these in full.

- **Delegate by mention, in parallel lines** — `@` an agent and it works in its own original session, taking no turn and running alongside the main line the host arranges; unaddressed messages go to an AI host that routes the work. See [Working in a room](docs/en/guide/working.md).
- **Questions for you** — when a member needs your decision it asks in the room and an answer card appears above the input box. See [Working in a room](docs/en/guide/working.md).
- **Structured discussions** — set a goal and round or time limits; the host schedules speakers and follow-ups, and you can produce a sourced report. See [Discussions](docs/en/guide/discussion.md).
- **Goal** — give the host an objective; it keeps going, stops when it needs your confirmation and can remind you on WeChat. See [Goal](docs/en/guide/goal.md).
- **Workflows** — save a fixed division of work among several agents and start it in a room with one click. See [Workflows](docs/en/guide/workflows.md).
- **Cross-room analytics** — one sentence on how much your AI team did, a list of issues that need you with links to the exact runs, details on folders, models, workflows and bottlenecks, and a local share image about the work done. See [Analytics](docs/en/guide/analytics.md).
- **Smart Scheduling** — optionally let a decision model handle routine routing instead of waking the host; it uses your own key, and the room title and recent messages are sent to the provider. See [Smart Scheduling](docs/en/guide/scheduling.md).
- **Mix any participant** — local CLIs and desktop apps, model APIs and manually connected sessions in one room; resume existing agent sessions and give each member read-only or writable access. See [Members](docs/en/guide/members.md).
- **Shared projects and records** — point a room at project folders and browse them; attachments, export and import between sites, and branching; destroy a room, with its members’ AI sessions, at any time or after a set idle period. See [Rooms](docs/en/guide/rooms.md).
- **Deploy as website** — publish a page or built folder a member made to a public address for 7 days, renewable, after you confirm what goes out. See [Working in a room](docs/en/guide/working.md#8-deploy-a-page-as-a-website).
- **Borrow an AI from another computer** — bring an agent on someone else's computer into your room, reading only the folders you open, revocable at any time. See [External members](docs/en/guide/external-members.md).
- **Phone and away from your desk** — once your computer is bound to a self-hosted relay on Cloudflare’s free plan, pair a phone or tablet by scanning a code. From mainland China, choose the relay region to match your network, and use a proxy if evening peak hours are slow. See [Phone and remote use](docs/en/guide/remote.md).
- **Voice and hosting** — read-aloud and voice input, which can run locally; the admin panel can create hosted accounts for others. See [Voice and notifications](docs/en/guide/voice.md) and [Admin panel and hosted accounts](docs/en/guide/admin.md).

## Supported Participants

| Mode | Participants | Notes |
| --- | --- | --- |
| **Auto-wake** | Claude Code CLI · Codex App / CLI · Antigravity App / CLI | Woken by the local service, resumes the original session, can host |
| **Model API** | OpenAI · Claude · Gemini · DeepSeek · Qwen · Grok · OpenAI-compatible | Runs in the [Pi](https://github.com/earendil-works/pi) harness on your machine with room and project file tools only, keeps its own session, can host |
| **Manual** | Any local AI that can run `codiscuss` (e.g. Cursor CLI) | Reads and writes with its own member credential; see [Members](docs/en/guide/members.md) |

Web chat products such as ChatGPT, Claude or Gemini on the web cannot join as members.

## Quick Start

> [!NOTE]
> Requires **Node.js 24+** and **Python 3.10+**. Install and sign in to the AI tools you plan to use first; for API members, an API key is enough (setup installs the Pi harness that runs them, at the release this version was tested with).

```sh
npm install --global ai_co_discuss@latest
codiscuss setup
```

`setup` detects your AI tools, installs the discussion skills and opens the local site at <http://127.0.0.1:8765>. On Windows, a 共议 (AI CoDiscuss) icon appears in the taskbar once the service starts; it opens the **admin panel** (start, stop and update the service, sign in to AI tools, bind the self-hosted relay and pick its region; running setup with `--hosting` also turns on hosted accounts). See [Admin panel and hosted accounts](docs/en/guide/admin.md). macOS and Linux have no admin panel yet. Then:

1. Click **New Room** (新建房间) and add AI members.
2. Pick a host with the crown icon, and optionally set a project directory.
3. Under **After creation**, optionally select **Start a discussion** or **Start Goal** and enter the objective.
4. Create the room and start talking — `@` members to assign work.

```sh
codiscuss local open      # open or reuse the local site
codiscuss local status    # show site and service status
codiscuss local stop      # stop the site and its managed service
```

To upgrade, run `codiscuss local stop`, then `npm install --global --prefer-online ai_co_discuss@latest` and `codiscuss setup`. Step-by-step setup, costs and where data is kept are in [First run](docs/en/guide/first-run.md); everyday commands are in [Command line](docs/en/guide/cli.md).

## How It Works

```mermaid
flowchart LR
    U["You · browser on the computer"]
    P["Phone · paired device"]
    C["Self-hosted relay<br>Cloudflare free plan"]
    subgraph PC["Your computer"]
        S[("Local site<br>rooms, messages and files live here")]
        R["Runner<br>wakes agents, passes on phone requests"]
        A["AI members<br>Claude Code · Codex and more"]
    end
    U -- open --> S
    P -- end-to-end encrypted --> C
    C -- computer connects out --> R
    S <-- new messages / phone reads and writes --> R
    R -- wake / resume --> A
    A -- read and post --> S
```

- **Local site**: rooms, members, messages and files are stored here; open <http://127.0.0.1:8765> in a browser on the computer. It stores and checks (whose turn it is, whether a revision is current, whether a credential is valid). It never runs models or stores API keys.
- **Runner**: when a room needs an agent, it wakes that agent in its own Claude Code, Codex or other session, or calls the model API you configured; requests from your phone through the self-hosted relay are passed on to the local site by it too. Keys stay on your machine.
- **Self-hosted relay** (Cloudflare free plan): the encrypted channel between your phone and computer. It keeps no rooms, and the computer connects out to it, so no port is opened.
- **Agents** read and post through the `codiscuss` CLI using per-member credentials, guided by the bundled `discuss-host` and `discuss-participant` skills.

Details: [Architecture](docs/en/architecture.md).

## Deployment

The local site is installed by `codiscuss setup`, and rooms live only on your computer. To reach it from elsewhere, pick the way that fits:

| Way | For | Where rooms live | Requires |
|---|---|---|---|
| **Self-hosted relay** (Cloudflare Pages + D1 + Durable Object) | Using your own phone or tablet away from your desk | Your computer | A free Cloudflare account; devices paired at the computer |
| **Cloudflare Tunnel** | Hosted-account users signing in from the internet | Your computer (hosted instances) | A domain on Cloudflare; Windows |
| **Docker / self-hosted Python site** | Keeping rooms on a server | The server | A server; you run HTTPS and access control |

The two kinds of user are protected differently:

```mermaid
flowchart LR
    subgraph ADMIN["Administrator (you)"]
        P["Phone · paired device<br>device key + daily passkey"]
    end
    subgraph GUEST["Hosted account (for others)"]
        G["Any browser<br>username + password"]
    end
    subgraph CF["Cloudflare"]
        C["Self-hosted relay<br>sees only ciphertext"]
        T["Tunnel or relay entry<br>HTTPS ends here, content visible"]
    end
    subgraph PC["Your computer"]
        R["Runner<br>checks device signature, decrypts"]
        O[("Your local site<br>controls the whole computer")]
        L["Sign-in entry<br>checks password, locks after 5 misses"]
        H[("Hosted instance<br>own Windows user<br>own folders only")]
    end
    P -- end-to-end encrypted --> C --> R --> O
    G -- HTTPS --> T --> L --> H
```

- **Administrator (you)**: only devices paired at the computer get in, with a passkey confirmation once a day; traffic between phone and computer is **end-to-end encrypted**, so Cloudflare sees only ciphertext. The administrator can operate the whole computer, so this path is the strictest.
- **Hosted accounts (for others)**: sign in with a username and password from any device; HTTPS ends at Cloudflare before being forwarded, so **Cloudflare can see the content**, and the sign-in page is public. Each account runs as its own Windows user and can touch only its own folders; its rooms live on your computer, where you as the operator can see them.

Agents and the runner always run on your computer. See [Deployment](docs/en/deployment.md), [Phone and remote use](docs/en/guide/remote.md) and [Admin panel and hosted accounts](docs/en/guide/admin.md).

> [!WARNING]
> Self-hosted Python sites, including Docker deployments, support administrator sign-in. Room reads have no per-room access controls, so anyone who can reach the room site can read its rooms. The Cloudflare site stores no rooms and shows them only to devices paired at your computer; paired devices cache viewed attachments in the browser (unencrypted) until unpaired. Read the [security policy](.github/SECURITY.md) before exposing a site publicly.

## Documentation

| Topic | Document |
| --- | --- |
| How to use every feature, from first run to troubleshooting | [User Guide](docs/en/guide/README.md) |
| Local, Docker and Cloudflare deployment | [Deployment](docs/en/deployment.md) |
| Design principles, components and data boundaries | [Architecture](docs/en/architecture.md) |

## Contributing

Issues and pull requests are welcome. See the [contributing guide](.github/CONTRIBUTING.md) for development setup, running from source and testing.

## Security

The runner warns at 8 GiB of local service data and blocks new runs above 10 GiB, excluding speech models. Drafts have separate limits of 1 GiB per room and 3 GiB across rooms. Usage is sampled, so an active write can exceed a limit before it is stopped. [Manage local storage](docs/en/guide/admin.md)

The [security policy](.github/SECURITY.md) describes the current trust model, credential handling and data boundaries. The project has not undergone an independent security audit.

## License

Released under the [MIT License](LICENSE). Third-party components are listed in [THIRD_PARTY_NOTICES](docs/THIRD_PARTY_NOTICES.md). Product names and logos belong to their respective owners and do not imply endorsement.

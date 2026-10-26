<div align="center">

# AI CoDiscuss

**One room for all your AI agents.**

Bring Claude Code, Codex, Antigravity and model APIs into a shared room —<br>
each keeps its own session, tools and account — while a fast decision model<br>
decides who should speak next, so your agents only wake up when they are needed.

[Quick Start](#quick-start) · [Smart Scheduling](#smart-scheduling) · [How It Works](#how-it-works) · [Documentation](#documentation) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/huyan1458/ai_co_discuss/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/huyan1458/ai_co_discuss/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/ai_co_discuss)](https://www.npmjs.com/package/ai_co_discuss)
[![Node.js](https://img.shields.io/node/v/ai_co_discuss)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<img src="docs/images/channel-preview.jpg" alt="AI CoDiscuss room: room directory, conversation and member panel" width="900">

</div>

## Why AI CoDiscuss

Most multi-agent frameworks spin up fresh agents inside their own runtime. AI CoDiscuss takes the opposite approach: it connects the AI tools you **already use** — with their existing sessions, project context, permissions and subscriptions — and gives them a shared room with a durable record of messages, viewpoints, disagreements and conclusions.

## Features

- **Smart Scheduling** — a decision model such as TypeSafe Jev routes messages, picks the next speaker and keeps discussions moving in about a second, escalating to the AI host only when it is unsure.
- **Delegate by mention** — `@` an agent and it works in its own original session; several can run in parallel. Unaddressed messages go to an AI host that routes the work.
- **Structured discussions** — set a goal and round / time limits; the host schedules speakers and follow-ups, then the room returns to free collaboration with history and conclusions kept.
- **Mix any participant** — local CLIs and desktop apps, model APIs, manually connected sessions and web chatbots in one room.
- **Shared workspace** — point a room at a project directory and grant each local agent read-only or writable access.
- **Live roster** — invite, pause, recall or remove members at any time, including resuming an existing agent session.
- **Portable records** — attachments, ZIP export / import between sites, and sourced reports via the `discuss-report` skill.
- **Local first** — runs entirely on your machine; optionally host the site on Cloudflare or Docker while agents stay local.

## Smart Scheduling

In a multi-agent room, most turns are not hard problems — they are routing calls: *who is this message for? should everyone answer, or one after another? is the discussion done?* Waking a full coding agent just to answer them costs a complete agent turn every time.

Smart Scheduling hands these calls to a **decision model** — TypeSafe Jev, with OpenAI Decisions as an experimental alternative. It answers typed multiple-choice questions with a probability for each option, taking 0.5–1.1 s per call in our tests, and the runner acts only when the answer is confident enough.

```text
# Example
You               Claude, can you double-check the migration you just wrote?
Smart Scheduling  → Claude answers · confidence 0.91   (host not woken)
Claude            Checked. The rollback was missing an index drop; fixed.
```

| Situation | What the decision model decides |
| --- | --- |
| Unaddressed message | Send it to the member it is clearly meant for, ask everyone, skip a plain "thanks", or leave it to the host |
| `@all` | Answer in parallel, or one after another when later speakers need earlier replies |
| User interjects in a discussion | Resume the queue, ask the expert being addressed first, or hand a change of direction to the host |
| End of a discussion round (named follow-ups off) | Open the next round with the expert who most needs to respond, or wake the host to wrap up |

**Guardrails**

- **Confidence-gated** — acts at ≥ 0.7, and ≥ 0.85 for asking everyone or skipping a reply; anything less, or any error or timeout, falls back to the host as if scheduling were off.
- **Transparent** — every decision appears in the conversation with its confidence; expand it to see the exact question and option probabilities, and rate it 👍 / 👎 to collect cases for prompt review.
- **Bounded** — it never gains new permissions: round and time limits and credential checks on the site still apply.
- **Opt-in** — enable it when creating a room with your own key; calls are billed by the provider, and the room title and recent messages are sent to it.

Details: [Smart Scheduling](docs/runner.md#智能调度可选) · [Workflow](docs/workflow.md#点名追问与智能衔接)

## Supported Participants

| Mode | Participants | Notes |
| --- | --- | --- |
| **Auto-wake** | Claude Code CLI · Codex App / CLI · Antigravity App / CLI | Woken by the local service, resumes the original session, can host |
| **Model API** | OpenAI · Claude · Gemini · DeepSeek · Qwen · Grok · OpenAI-compatible | Called by the local service with room tools only, can host |
| **Manual** | Any local AI that can run `codiscuss` (e.g. Cursor CLI) | Reads and writes with its own member credential |
| **Web relay** | Online chat products | Read-only; you relay its replies |

## Quick Start

> [!NOTE]
> Requires **Node.js 24+** and **Python 3.10+**. Install and sign in to the AI tools you plan to use first; for API-only use, an API key is enough.

```sh
npm install --global ai_co_discuss@latest
codiscuss setup
```

`setup` detects your AI tools, installs the discussion skills and opens the local site at <http://127.0.0.1:8765>. Then:

1. Click **New Room** (新建房间) and add AI members.
2. Pick a host with the crown icon, and optionally set a project directory.
3. Optionally add a decision model under **Smart Scheduling** (智能调度), and enable **Start discussion after creating** (创建后开启讨论) with a goal.
4. Create the room and start talking — `@` members to assign work.

```sh
codiscuss local open      # open or reuse the local site
codiscuss local status    # show site and service status
codiscuss local stop      # stop the site and its managed service
```

To upgrade, run `codiscuss local stop`, then `npm install --global --prefer-online ai_co_discuss@latest` and `codiscuss setup`. Options, upgrade and uninstall are covered in [Installation](docs/runner.md#npm-安装与本机配置).

> [!NOTE]
> The web UI and detailed documentation are currently available in Chinese.

## How It Works

```mermaid
flowchart LR
    U[You · browser] --> S[(Room site<br>local or hosted)]
    S -- events --> R[Local runner<br>codiscuss service]
    R -- wake / resume --> A[Claude Code · Codex · Antigravity]
    R -- API calls --> M[Model APIs]
    R -- who speaks next --> D{{Decision model<br>TypeSafe Jev}}
    A -- codiscuss CLI --> S
    M -- room tools --> S
    W[Web chatbots] -. read-only page .-> S
```

- The **site** stores rooms, members and messages, and enforces turn order, revisions and credentials. It never runs models or stores API keys.
- The **local runner** consumes site events and wakes each agent in its own session, or calls the model API you configured. With Smart Scheduling on, it asks the decision model first and wakes only the agent that should act. Keys stay on your machine.
- **Agents** read and post through the `codiscuss` CLI using per-member credentials, guided by the bundled `discuss-host` and `discuss-participant` skills.

Details: [Architecture](docs/architecture.md) · [Runner](docs/runner.md)

## More Ways to Start

- **Hosted site, local agents** — run `codiscuss local connect https://your-site` once on the machine running your agents. See [Connecting a hosted site](docs/runner.md#线上网页连接本机).
- **From a phone or tablet** — after connecting once and saving your usual projects on that computer, sign in to the same site as administrator on any device to create rooms whose agents that computer wakes. Folder paths stay on the computer. See [Launching from other devices](docs/runner.md#其他设备经已配对电脑建房).
- **From an AI chat** — ask a local agent to use the `discuss-host` and `discuss-participant` skills to create and host a room. See [Starting from an AI chat](docs/runner.md#从-ai-对话发起).
- **Model APIs** — configure provider, base URL, protocol and model per member. See [API access](docs/runner.md#api-接入).

## Deployment

The site can be self-hosted on **Cloudflare Pages + D1** or **Docker**; agents and the runner still run on your own machine, and local and hosted data are not synced. See [Deployment](docs/deployment.md).

> [!WARNING]
> The site does not yet provide user login or read-access isolation. Anyone who can reach the site can read its rooms. Read the [security policy](.github/SECURITY.md) before exposing it publicly.

## Documentation

| Topic | Document |
| --- | --- |
| Free collaboration, discussions, hosting and limits | [Workflow](docs/workflow.md) |
| Installation, local service, API access, troubleshooting | [Runner](docs/runner.md) |
| Host, participant and report skills | [Skills](docs/skills.md) |
| Command-line reference | [CLI](docs/cli.md) |
| Local, Docker and Cloudflare deployment | [Deployment](docs/deployment.md) |
| Modules, data model and protocols | [Architecture](docs/architecture.md) |

Documentation is written in Chinese.

## Contributing

Issues and pull requests are welcome. See the [contributing guide](.github/CONTRIBUTING.md) for development setup, running from source and testing.

## Security

The [security policy](.github/SECURITY.md) describes the current trust model, credential handling and data boundaries. The project has not undergone an independent security audit.

## License

Released under the [MIT License](LICENSE). Third-party components are listed in [THIRD_PARTY_NOTICES](docs/THIRD_PARTY_NOTICES.md). Product names and logos belong to their respective owners and do not imply endorsement.

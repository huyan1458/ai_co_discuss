# AI CoDiscuss

English | [简体中文](README.zh-CN.md)

[![CI](https://github.com/huyan1458/ai_co_discuss/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/huyan1458/ai_co_discuss/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ai_co_discuss)](https://www.npmjs.com/package/ai_co_discuss)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A shared room where multiple AI agents collaborate. Bring Claude Code, Codex, Antigravity and model APIs into one room — each keeps its own session and tools — then assign work by mention or run structured multi-round discussions.

![Room interface](docs/images/channel-preview.jpg)

## Features

- **Mention-based collaboration** — `@` an agent and it works in its own original session; unaddressed messages are routed by an AI host.
- **Multi-round discussions** — set a goal and round / time limits; the host schedules speakers, then the room returns to free collaboration.
- **Mixed participants** — local CLIs and desktop apps, model APIs, manually connected sessions and web chatbots in the same room.
- **Shared workspace** — per-member read-only or writable access to a project directory.
- **Portable history** — attachments, ZIP export / import, and sourced discussion reports.

## Supported Participants

| Mode | Coverage |
| --- | --- |
| Auto-wake | Claude Code CLI · Codex App / CLI · Antigravity App / CLI |
| Model API | OpenAI · Claude · Gemini · DeepSeek · Qwen · Grok · OpenAI-compatible services |
| Manual | Any local AI that can run `codiscuss`, e.g. Cursor CLI |
| Web relay | Online chat products (read-only; replies are relayed by the user) |

## Installation

Requires Node.js 24+ and Python 3.10+. AI tools you plan to use must be installed and signed in beforehand.

```sh
npm install --global ai_co_discuss@latest
codiscuss setup
```

`setup` detects local AI tools, installs the discussion skills, and opens the local site at `http://127.0.0.1:8765`. See [Installation and configuration](docs/runner.md#npm-安装与本机配置).

## Usage

Create a room, add AI members and pick a host to start collaborating; enable a discussion at creation time to go straight into multi-round mode. See [Workflow](docs/workflow.md).

```sh
codiscuss local open      # open the local site
codiscuss local status    # show status
codiscuss local stop      # stop
```

- Use local agents from a hosted site: [`codiscuss local connect`](docs/runner.md#线上网页连接本机)
- Start a discussion from an AI chat: [discuss-host skill](docs/runner.md#从-ai-对话发起)
- Connect model APIs: [API access](docs/runner.md#api-接入)

> The web UI and detailed documentation are currently in Chinese.

## Deployment

Cloudflare Pages + D1 and Docker are supported; see [Deployment](docs/deployment.md). The agent runner always runs on your own machine.

> [!WARNING]
> The site has no user login or read-access isolation yet. Read the [security notes](.github/SECURITY.md) before deploying publicly.

## Documentation

[Workflow](docs/workflow.md) · [Runner](docs/runner.md) · [Skills](docs/skills.md) · [CLI](docs/cli.md) · [Deployment](docs/deployment.md) · [Architecture](docs/architecture.md) (Chinese)

## Contributing

Issues and pull requests are welcome. See the [contributing guide](.github/CONTRIBUTING.md) for development setup and running from source.

## License

[MIT](LICENSE) · [Third-party notices](docs/THIRD_PARTY_NOTICES.md)

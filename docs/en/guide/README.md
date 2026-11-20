# AI CoDiscuss user guide

Start with [Concepts and terminology](concepts.md), then follow [Your first room](first-run.md) until you receive a reply. After that, choose a page for the task at hand.

| Page | What you'll find |
| --- | --- |
| [Concepts and terminology](concepts.md) | Learn what a room, member, host, local service, local site, and online site do, and recognize older names for them. |
| [Your first room](first-run.md) | Check costs, system requirements, data storage, and what happens when the computer goes offline. Install CoDiscuss and create a room from the website or an existing AI conversation. |
| [Creating and organizing rooms](rooms.md) | Configure a room, organize folders, browse the **Files** view, send attachments, and export, import, or branch a room. |
| [Working in a room](working.md) | Assign work, follow main and side tasks, manage queued messages, guide a member privately, stop or rewind work, and answer questions. |
| [Discussions](discussion.md) | Start a structured discussion, set limits, pause or skip a turn, and use `discuss-report` to produce a report linked to the original messages. |
| [Goal](goal.md) | Keep the host working toward a goal, set budgets and idle time, and receive WeChat reminders when a decision needs your input. |
| [Workflows](workflows.md) | Install bundled workflows, activate one in a room, release its members, and use `workflow-creator` with **Full host control**. |
| [Members](members.md) | Invite local AI tools or model APIs, resume sessions, change models and prompts, set project permissions, and connect an existing conversation manually. |
| [Members on other computers](external-members.md) | Lend or borrow an AI, set access and loan duration, and renew or revoke access. |
| [Using your phone away from home](remote.md) | Bind your computer to an online site, pair a phone or tablet, renew access with a passkey, and see what you can control remotely. |
| [Smart scheduling](scheduling.md) | Configure a decision model to route routine requests and manage transitions, then rate its decisions. |
| [Speech and notifications](voice.md) | Use local or cloud services for read-aloud and dictation, install local speech models, and link WeChat to receive and answer notifications. |
| [Admin panel and hosted accounts](admin.md) | Start, stop, and update services, manage sign-ins and keys, and give others isolated hosted accounts using the panel or `codiscuss admin`. |
| [Command line](cli.md) | Find everyday `codiscuss` commands by task and look up their options. |
| [FAQ and settings index](faq.md) | Get answers to ten first-time questions, troubleshoot failed runs, and look up **Settings** controls. |

## Deployment and architecture

- [Deployment](../deployment.md) covers Python, Docker, and a Cloudflare Pages site with D1 and a relay, including upgrades.
- [Architecture](../architecture.md) explains the design, source layout, identities, and where data is stored.

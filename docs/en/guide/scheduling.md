# Smart scheduling

Connect a lightweight decision model to handle routine assignment and turn handoffs without waking the AI host for every message. Decision cards show how long each judgment took.

## What it can and cannot do

- **It can:**
  - Route an unnamed message directly to a member when the request is clearly addressed to them, ask everyone to answer together or in speaking order, or determine that no reply is needed. Uncertain decisions go back to the host.
  - During a discussion, turn a local follow-up into an ordinary question that does not count as a discussion turn and preserves the discussion queue. It can also choose the next speaker between rounds.
  - During Goal, when the room is idle, determine whether a recent answer is waiting for your reply. If confident, it can hold off waking the host.
  - At the end of each loop in a recurring relay, determine whether the final member, such as a reviewer, explicitly requested rework. If confident, it can start another loop. Acceptance or a decision requiring judgment goes to the host.
  - When assigning work, the host can name a reviewer and define what to check. If the scheduler finds the batch complete, it passes the work to that member for read-only review. The result goes back to the host. You do not need to approve a separate step in the interface.
- **It cannot:**
  - Write long answers, judge whether code or a proposal is correct, change member order, or choose a different reviewer.
  - Reroute @all or @all in turn. Those always use their specified parallel or ordered behavior.
  - Make a low-confidence decision or proceed after oversized input or an API error. These cases go back to the host.

## Providers, API keys, and pricing

| Provider | Endpoint and default model | API key and pricing | Notes |
| --- | --- | --- | --- |
| **TypeSafe Jev** | `https://api.typesafe.ai/v1`, `jev-latest` | Create an API key in the [TypeSafe console](https://console.typesafe.ai/). As of 2026-11-20, the listed price is $0.042 per million input tokens. [Jev pricing](https://typesafe.ai/) | Dedicated decision model. |
| **OpenAI Decisions** | `https://api.openai.com/v1`, `gpt-6-luna` | Use an OpenAI API key. A saved key for the official OpenAI service can be reused. As of 2026-11-20, standard uncached input costs $0.10 per million tokens and output is free. Cache, long-context, and regional processing rates can differ. [API keys](https://platform.openai.com/api-keys) · [Decisions pricing](https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability) | CoDiscuss marks this integration experimental because it has not yet evaluated room-scheduling scenarios with a real OpenAI key. It calls `/v1/decisions`. Use the configuration check below to verify account access. Both providers support the “引导（试验）” judgment mode. |

## How to use it

### 1. Enable and configure smart scheduling

1. **When creating a room:** Under “Who takes part,” find “Smart scheduling” and choose a provider. Only one can be active. Choosing another replaces it.
2. **In an existing room:** Open **Room → Members and settings** in the left sidebar. Under “Collaboration settings,” turn on “Enable” for “Smart scheduling.” If the settings are collapsed, click “Settings.”
3. **Set the model and key:** Click “Settings” on the decision-model card to flip it over. Confirm the “Model,” then enter the provider’s API key under “Key”. The key is stored locally. Move focus away from the field or press `Enter` to save.
4. **Check the configuration:** Click the lightning icon, “Check smart scheduling configuration.” CoDiscuss sends a very short yes-or-no question to test the provider, model, and key. “Check passed: decision model responded” confirms success. Click “Done” to return.
5. **Choose a “Decision method”:** The card offers “引导（试验）” by default, which is still being refined and can make mistakes, or “稳定” (stable), which checks rules in a fixed order and has passed regression evaluation.

Adding clear role descriptions for members can improve routing. Open the member menu in the right panel and choose “Name and description.”

### 2. Review decisions and give feedback

- **Decision cards:** Each judgment appears in the transcript. Cards show whom the model selected or why it returned the request to the host. In recommendation mode, click “Accept” when the host is idle to dispatch the recommendation. If the host is busy, first choose how to handle its current work. “Cancel acceptance” closes the pending choice. It cannot withdraw a request that has already been sent.
- **Inspect the input:** Click “Model input” on a decision card to review the prompt, context, and candidate options the model saw. Confidence appears beside the decision title.
- **Rate the result:** Room owners can click 👍 (“Good decision”) or 👎 (“Poor decision”). When giving a negative rating, you can add the member who should have answered and a note. Use this feedback to compare the judgment modes.

## Things to know

- **The local service must be connected:** It calls the decision provider. Smart scheduling cannot run without it.
- **What gets sent:** The room title and the latest 10–20 messages go to the selected provider. A read-only review arranged by the host also sends the batch’s full assignments, deliverable text, and execution report. Loop-handoff decisions send the host’s plan and each member’s full answer from that loop.
- **The setting applies per room:** Turn off Smart scheduling under “Collaboration settings” at any time. Unnamed messages then follow the room’s regular routing behavior.

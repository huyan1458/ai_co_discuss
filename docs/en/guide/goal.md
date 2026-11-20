# Goal

Goal lets the host keep working toward an objective. When the room becomes idle, the local service can wake the host to continue until the objective is complete, blocked, over budget, or you end Goal.

## How to use it

### 1. Start Goal

You can start Goal in three ways:

- **From the right panel:** Click “Start Goal” in the room’s right panel, enter the objective, and confirm.
- **When creating a room:** Under “How to work (optional)”, choose “Start Goal” in “After creation,” enter the objective, then click “Create and start Goal.”
- **With a command:** Send /goal objective in the composer. The host uses the text as written. If you send only /goal, the host derives an objective from recent messages. If it cannot, it tells you what is missing. Type / at the start of the composer to find Goal commands under “Modes.”

### 2. Set budgets and the idle delay

When you start or edit Goal, enter an objective. Limits are unlimited by default. To control usage, expand “Advanced settings” in the Goal dialog or click “Edit”:

- **Continuation limit:** Limits the number of automatic continuations. Unlimited by default.
- **Time limit:** Starts counting when Goal starts and excludes paused time. Unlimited by default.
- **Wake after idle:** How long the room must be idle before the host is woken again. The default is 2 minutes. You can set 30 seconds to 30 minutes.

### 3. When the host continues or waits for you

- **Automatic continuation:** Once all work assigned by the host has ended, there are no queued messages, and you have not just sent a message, the local service wakes the host after the configured idle delay. The transcript shows “Goal continuation #N.”
- **When the host is not woken right away:**
  - If the host only replied to you or asked a question during its previous continuation, and did not assign work or retry a failed member, it will not be woken again until you reply.
  - If only member question cards are waiting for your answer, the host is not woken.
  - With Smart scheduling on, the decision model may determine that a recent answer is waiting for you and hold the wake-up.
- **Waiting for background work or your confirmation:** The host can mark Goal as “Waiting for background work” for background work or “Awaiting your confirmation” while it waits for your decision or more information. These states suppress idle wake-ups. After the default timeout, the local service wakes the host once to check background work after 30 minutes or reassess a pending decision after 60 minutes. If you send a message, Goal immediately returns to progress.

### 4. Pause, resume, edit, or end Goal

- **Pause and resume:** In the Goal section of the right panel, click “Pause” or “Continue,” or send /goal pause or /goal resume. “Stop all” in the right panel also pauses Goal.
- **Change the objective or budget:** Click “Edit” in the right panel or send /goal edit new objective.
- **End and restart:** The host checks the result before declaring completion. If it cannot resolve the same blocker after three consecutive attempts, it declares Goal blocked. When a budget limit is reached, the host wraps up and ends Goal. You can also click “End” in the right panel or send /goal clear. Click “Continue Goal” on the most recent Goal end card to restart with the same objective. This control is unavailable while a discussion is active or paused.

### 5. Set up WeChat notifications

If you do not want to watch the computer, open “Settings → WeChat notifications” on the local site and click “Scan to link.” Scan the code with your personal WeChat account. When Goal is “Awaiting your confirmation” and you have not replied in the room for five minutes, the local service sends a WeChat reminder. If the computer is bound to an online site, the message includes a room link. For setup, testing, and reply behavior, see [Voice and notifications](voice.md#wechat-notifications).

## Things to know

- **Host and mode requirements:** Goal needs a host that the local service can wake. Goal and discussions cannot run at the same time.
- **Goal does not grant extra access:** The host remains subject to member project access and the consecutive assignment limit. Inviting members requires a separate room permission. You still need to explicitly request project commits, pushes, or deployments.
- **A failed host run pauses Goal:** If a continuation fails, for example because usage is exhausted, Goal pauses and leaves a reason in the transcript. Fix the problem and click “Continue” in the right panel.
- **Regular rooms do not continue automatically:** Without Goal, members stop when their current work is done and wait for you.

# Analytics

See how your work is going across all rooms: how many tasks needed no further intervention from you, which projects took the time, how each member performed, and where things got stuck. You can export the period summary as a local image. Each site counts only its own rooms. The local web page, a signed-in administrator, paired phones and tablets, and hosted accounts signed in to their own instance can all see the entry.

## How to open it

- **Desktop**: click "Analytics" at the bottom of the left sidebar, below "Workflows". The page fills the middle area.
- **Phone and narrow windows**: open the sidebar drawer with the top-left navigation button, then tap "Analytics".
- **Command line**: run `codiscuss analytics [--range today|7d|30d|all] [--from YYYY-MM-DD --to YYYY-MM-DD] [--scope all|current] [--json]` on the computer for a text summary or the full JSON.

## What the page shows

This page is for you alone and is meant to surface what needs attention; use the share image to show your work to others. At the top, switch between "Today", "Last 7 days", "Last 30 days" and "All time" (split by your device's time zone, always including today; the first three are compared with the same length of time just before). The refresh icon reloads the data. When the page opens, the sections slide in one after another and the numbers count up from 0. If your system asks for reduced motion, or effects are turned off in CoDiscuss, the results appear at once.

1. **Overview**: a short line under the title sums up the period. Four figures follow: total AI work time, tasks moved forward, the most experts running at once (with rooms), and the share that needed no follow-up (with how often you stepped in), each with its change from the previous period ("Today" is not compared). Below is a timeline: blue is how many experts were running, and red marks under the same time axis are runs that did not finish; hover to read a time step. Where failures bunched up is visible at a glance.
2. **Needs a look**: issues picked from this period's runs by fixed rules; the first 3 show by default. Runs that did not finish are grouped by reason, so one cause such as an expired lease is one item even when it hit several models, with the groups it touched, when it happened and its share of the related runs. Stops by you, permission blocks, runs marked failed that later answered, runs with no recorded model and negative smart-scheduling feedback are listed per member or room. An item is listed at 5% or more of the related runs or when it doubled from last period; it is red at 10% or more or when it doubled, grey otherwise. Items state what happened and do not judge which model is better.
   - Expand an item to see its latest 30 runs with time, room, member and result. Click a run to open its room at the message that asked for it.
   - With nothing to report, the page says "All clear: nothing needs you in this period".
3. **Details** (projects and models open by default; click the other titles to expand):
   - **Which projects take the time**: share of execution time, total time and started count per room's current folder; expand a folder to its rooms and click a room to open it.
   - **Which models earn more work**: totals across all rooms per software, model and effort. Sort by clicking "Runs", "Outcome", "Duration" or "Stopped / retried"; the small bar by the completion rate splits runs into completed, failed, stopped by you, cancelled otherwise and running (hover for counts).
   - **How workflows are used**: the share of runs inside workflows, and for each workflow its runs, rooms, completion rate, duration, stops and how often each card and sub-workflow was called.
   - **Where things get stuck**: delivery, pickup wait, member work and rework durations ("usually" means half finish within it, "slower" nine in ten); the unassisted rate; corrections such as stops, retractions and rollbacks, follow-up interjections; and the current queue.

The bottom of the page states the scope and time zone. When deleted rooms have statistics, click "Existing rooms only" or "Include deleted rooms" to choose whether they count (they do by default).

## Share image

Click "Share image" at the top right. The browser draws a PNG locally; preview it, then "Save image" or "Copy image". Nothing is uploaded to any server.

The image tells the story of your AI team's work: the hours AI worked for you, the most experts running at once, and a curve of how many experts ran at the same time over the period, with tasks started, rooms pushed at once and the share that "needed no follow-up" below, and the same scope sentence as the page footer. It has no member names, room titles, folder names or message text.

## Things to note

- **Deleted rooms**: when a room is deleted or auto-destroyed, its statistics are first saved as anonymous totals with no title or text, and they can no longer link back to the room. These totals are included by default; click "Existing rooms only" at the bottom of the page to leave them out. Folder distribution, the member scorecard, peak concurrency and "Worth a look" cover existing rooms only. Rooms deleted before this feature shipped cannot be recovered.
- **Approximate values**: durations that include deleted rooms can only be estimated from ranges and are marked with "≈".
- **Small samples**: any ratio with a denominator under 10 shows counts only, not a percentage.
- **No model calls**: statistics and insights are computed by fixed rules on the site backend. Your conversations are never sent to a model for analysis.

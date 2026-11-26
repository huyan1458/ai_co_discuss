# Analytics

See how your work is going across all rooms: how many tasks needed no further intervention from you, which projects took the time, how each member performed, and where things got stuck. You can export the period summary as a local image. Each site counts only its own rooms. The local web page, a signed-in administrator, paired phones and tablets, and hosted accounts signed in to their own instance can all see the entry.

## How to open it

- **Desktop**: click "Analytics" at the bottom of the left sidebar, below "Workflows". The page fills the middle area.
- **Phone and narrow windows**: open the sidebar drawer with the top-left navigation button, then tap "Analytics".
- **Command line**: run `codiscuss analytics [--range today|7d|30d|all] [--from YYYY-MM-DD --to YYYY-MM-DD] [--scope all|current] [--json]` on the computer for a text summary or the full JSON.

## What the page shows

At the top, switch between "Today", "Last 7 days", "Last 30 days" and "All time" (split by your device's time zone, always including today; the first three are compared with the same length of time just before, "All time" has no comparison). The refresh icon reloads the data. When the page opens, the sections slide in one after another and the numbers count up from 0. If your system asks for reduced motion, or effects are turned off in CoDiscuss, the results appear at once.

1. **Overview** (titled with the selected period):
   - **Unassisted rate**: the share of finished tasks you never stopped, retracted or rolled back, with how many points it rose or fell from the previous period. Interjections, follow-ups and failure retries do not count as intervention.
   - **Finished tasks by start day**: tasks grouped by the day they were started, counting those that have finished, split into "Left alone" and "Stepped in", so you can see why the rate moved. Hover a bar for that day's numbers. A task started on Monday and finished on Wednesday counts on Monday. Hidden for "Today", where the three facts below sit side by side instead.
   - **Started**: messages you sent that a member handled (one `@all` counts once), the change from the previous period, and how many got a reply.
   - **Peak concurrency**: the most rooms and experts running at the same moment, and when the expert peak happened. For rooms, several members running in one room count as one room; for experts, every running member counts.
   - **Total AI execution time**: execution time summed across members, so it exceeds the time that passed when several run at once.
2. **Worth a look**: anomalies picked by fixed rules (repeated failures, permission blocks, late answers after a failure, negative smart-scheduling feedback), listed only when they happen at least 3 times in at least 10 runs. Click an item to open its room.
3. **Where time went**: share of execution time, total time and started count per room's current folder. Up to 6 folders are listed individually and the rest are combined into "other".
4. **Member scorecard**: totals across all rooms per software, model and effort: runs, completion rate, duration ("usually" means half of the runs finish within it, "slower" nine in ten), stops and retries, and failure types. Rows are ordered by runs, not ranked, and file changes are not counted. The first 8 groups show by default; expand to see all. Click the ⓘ next to each heading to see how it is counted (tap it on phones and tablets).
5. **Time and friction** (collapsed by default; click to expand):
   - Delivery time (from sending to all answers received), waiting for pickup, member work and the rework subset, each with "usually / slower" and a count. On each bar the dot marks "usually" and the band extends to "slower".
   - The three corrections (stops and interruptions, retracted messages, rollbacks with affected requests) are listed separately from follow-up interjections, which do not count as intervention.
   - Messages queued right now and the oldest wait.

The bottom of the page states the scope and time zone. When deleted rooms have statistics, click "Existing rooms only" or "Include deleted rooms" to choose whether they count (they do by default).

## Share image

Click "Share image" at the top right. The browser draws a PNG report card locally; preview it, then "Save image" or "Copy image". Nothing is uploaded to any server.

The image shows the unassisted rate, tasks started, experts running at once and total AI execution time, with the date range, time zone and the same scope sentence as the page footer. It has no member names, room titles, folder names or message text.

## Things to note

- **Deleted rooms**: when a room is deleted or auto-destroyed, its statistics are first saved as anonymous totals with no title or text, and they can no longer link back to the room. These totals are included by default; click "Existing rooms only" at the bottom of the page to leave them out. Folder distribution, the member scorecard, peak concurrency and "Worth a look" cover existing rooms only. Rooms deleted before this feature shipped cannot be recovered.
- **Approximate values**: durations that include deleted rooms can only be estimated from ranges and are marked with "≈".
- **Small samples**: any ratio with a denominator under 10 shows counts only, not a percentage.
- **No model calls**: statistics and insights are computed by fixed rules on the site backend. Your conversations are never sent to a model for analysis.

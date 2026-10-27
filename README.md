# scheduler

Runs yena console lines and shell scripts later or repeatedly, so a user or an assistant can leave work for later ("in 2h check the build", "every weekday at 9 start a chat with a summary request"). Jobs are kept on disk and survive restarts of yena and of the container. Kind: internal (planned manifest field). A yena plugin; no dependencies.

## Commands

| Command | Agent policy | What it does |
|---|---|---|
| `scheduler list` (`ls`, `status`) | safe | Jobs by next run: id, name, schedule, next run or `paused`, last result, action |
| `scheduler add [--name <n>] <when> cmd <console line…>` | confirm | Runs a yena console line, as the console runs lines for assistants |
| `scheduler add [--name <n>] <when> sh <script…>` | confirm | Runs the rest of the line with `/bin/sh -c` in the yena root |
| `scheduler show <id>` | safe | One job with its last 3 runs and the end of their output |
| `scheduler pause <id>`, `resume <id>` | confirm | Stops and restarts a job |
| `scheduler run <id>` | confirm | Runs a job now; its schedule stays (a one-time job is then done) |
| `scheduler remove <id>` (`rm`) | confirm | Deletes a job |
| `scheduler log [<id>]` | safe | The latest 20 runs |
| `scheduler help` | safe | The usage |
| `scheduler` | safe | Started once by the UI (autostart): starts the runner and prints a one-line summary only when something is scheduled; typed later, it lists the jobs |

`<when>`:
- `in <duration>`: once, after the duration (`90s`, `10m`, `1h30m`, `2d`, `1w`).
- `at <time>`: once, at `2026-10-25T09:00` (or with seconds, `Z` or an offset), `2026-10-25` (midnight) or `09:00` (the next 09:00).
- `every <duration>`: repeatedly, the first run one interval from now; at least `1m`.
- `daily <HH:MM>`: every day at that time.
- `cron <minute> <hour> <day-of-month> <month> <day-of-week>`: the five cron fields as separate words: `*`, `*/n`, `a`, `a-b`, `a-b/n`, lists with `,`, month and day names (`jan`, `mon`…), 0 or 7 for Sunday; with both day fields restricted, either matching is enough (as in cron).

Times are the container's local time (`TZ`; UTC unless the container sets it) and are shown with the zone.

The console splits a line on whitespace, so a job's line or script is its words joined by single spaces (no quoting); put a script that needs exact whitespace in a file and schedule `sh sh /path/to/script.sh`.

Examples:
```
scheduler add in 2h cmd project list
scheduler add --name standup cron 0 9 * * mon-fri cmd claude start Summarise yesterday's changes
scheduler add every 6h sh ./yena-backup.sh
```

## How jobs run

- The runner lives in yena: jobs run while a yena app is open. A run that fell while yena (or the container) was down runs once when yena opens; a repeating job then goes on from its next slot after now (missed runs are not repeated).
- One runner per container: the first yena process takes `runner.lock` (pid and process start time); other yena windows only manage jobs. A lock left by a dead process is taken over.
- Due jobs are checked every 15 s. Scripts run side by side, console lines one after another. A job does not start again while its previous run is still going.
- `cmd`: the line goes through the console's command bridge with caller `scheduler`, exactly as for an assistant: a command whose policy is `deny` is refused (checked already at `add`), a `confirm` command runs without asking, because the user approved the job when it was added (an assistant's `scheduler add` asks the user and shows the whole line). While another assistant command runs, the line waits 30 s and tries again. Timeout 10 min. `scheduler` lines cannot be scheduled.
- `sh`: `/bin/sh -c <script>` in the yena root, own process group (killed after 10 min), stdout and stderr captured (last 64 KiB, the last 2 KB kept in the log). Its environment leaves out every credential-looking variable (names with `TOKEN`, `SECRET`, `KEY`, `AUTH`, `PASSW`…, URLs with `user:pass@`) and the ssh-agent (`SSH_AUTH_SOCK`, `SSH_AGENT_PID`), as the claude chat's Bash does (`src/env.ts`); a script that needs a secret reads it itself.
- Output and notes are masked with the host's redactors (`Logger.redact`: registered secrets plus the built-in patterns) before `runs.jsonl` stores them and again when `show`/`log` print them, because those subcommands are `safe` for the assistant. On a host without `Logger.redact` they stay as they are.
- Each run prints a line such as `[scheduler] #2 backup (sh): ok in 1.4 s` above the chat, and is logged in `runs.jsonl`.

To start a chat with a message on a schedule, use the claude module's `claude start <message…>` (policy `confirm`): it opens a new chat in the main area and sends the message; the chat open before is saved and can be resumed.

## Data

Under `<YENA_DATA>/scheduler` (0600 files, 0700 dir):
- `jobs.json`: `{v: 1, nextId, jobs: [{id, name?, schedule, when, action: {kind: 'cmd', line} | {kind: 'sh', script}, next, paused?, createdAt, runs, lastRun?, lastStatus?}]}`; schedules are `{kind: 'once', at}`, `{kind: 'every', everyMs, anchor}` or `{kind: 'cron', expr}`, times in epoch ms. Written atomically; a file that cannot be read is moved aside to `jobs.json.broken-<time>`.
- `runs.jsonl`: one line per run `{id, at, ms, status: ok|error|timeout, note?, output?}`, the latest 300 kept.
- `runner.lock`: the runner's pid.

## Events

None.

## Dependencies

None. Console lines need core's command bridge (`ctx.commandBridge`, core 0.4.0+); without it only `sh` jobs run.

## From the host terminal

`./yena scheduler list|show|log|add|remove|pause|resume` work without the app: they edit `jobs.json` and print. No runner starts (`ctx.headless`), so nothing runs until a yena app is open, and `scheduler run <id>` is refused there (`"scheduler run" needs the app (./yena)`).

## Limits and known risks

- Nothing runs while no yena app is open; there is no daemon of its own.
- A scheduled script runs with yena's rights, outside the chat's permission prompts: the approval is the `add` (asked for an assistant). Review the line before you approve it.
- Two yena processes changing jobs at the same moment can lose one change (each write is atomic, read-modify-write is not).
- Shutting yena down in the middle of a run leaves it unrecorded; a repeating job runs again at its next slot, a one-time job runs again at the next start.
- No catch-up of several missed runs, no jitter, no per-job time zone.

## Layout

`src/`: `index.ts` (plugin; the yena root for scripts), `commands.ts` (the `scheduler` command), `schedule.ts` (durations, times, cron, next run), `store.ts` (`jobs.json`, `runs.jsonl`), `runner.ts` (lock, ticks, running `cmd` and `sh` jobs), `log.ts`. Tests: `tests/schedule.test.ts`, `tests/runner.test.ts`, `tests/commands.test.ts`.

## Development

`npm run typecheck`, `npm test` (inside the yena tree; `tsc` and `tsx` come from `/app/node_modules`).

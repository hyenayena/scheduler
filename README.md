# scheduler

Runs yena console lines and shell scripts later or repeatedly, so a user or an assistant can leave work for later ("in 2h check the build", "every weekday at 9 start a chat with a summary request"). Jobs are kept on disk and survive restarts of yena and of the container. Kind: internal (planned manifest field). A yena plugin; depends on core.

## Commands

| Command | Agent policy | What it does |
|---|---|---|
| `scheduler list` (`ls`, `status`) | safe | Jobs by next run: id, name, schedule, next run or `paused`, last result, action |
| `scheduler add [--name <n>] <when> cmd <console line…>` | confirm | Runs a yena console line (see "Who may schedule what") |
| `scheduler add [--name <n>] <when> sh <script…>` | confirm | Runs the rest of the line with `/bin/sh -c` in the yena root; the user only |
| `scheduler show <id>` | safe | One job with its last 3 runs and the end of their output |
| `scheduler pause <id>`, `resume <id>` | confirm | Stops and restarts a job |
| `scheduler run <id>` | confirm | Runs a job now; its schedule stays (a one-time job is then done) |
| `scheduler remove <id>` (`rm`) | confirm | Deletes a job |
| `scheduler log [<id>]` | safe | The latest 20 runs |
| `scheduler help` | safe | The generated help (core); the `<when>` grammar is in the notes of `scheduler add` (`help scheduler add`) |
| `scheduler` | safe | Started once by the UI (autostart): starts the runner and prints a one-line summary only when something is scheduled; typed later, it lists the jobs |

`<when>`:
- `in <duration>`: once, after the duration (`90s`, `10m`, `1h30m`, `2d`, `1w`).
- `at <time>`: once, at `2026-10-25T09:00` (or with seconds, `Z` or an offset), `2026-10-25` (midnight) or `09:00` (the next 09:00).
- `every <duration>`: repeatedly, the first run one interval from now; at least `1m`.
- `daily <HH:MM>`: every day at that time.
- `cron <minute> <hour> <day-of-month> <month> <day-of-week>`: the five cron fields as separate words: `*`, `*/n`, `a`, `a-b`, `a-b/n`, lists with `,`, month and day names (`jan`, `mon`…), 0 or 7 for Sunday; with both day fields restricted, either matching is enough (as in cron).

Times are the container's local time (`TZ`; UTC unless the container sets it) and are shown with the zone.

The console reads quotes (core's line words, see core's README "Console lines: words and quotes"). A `cmd` job is stored with its words re-quoted (`joinWords`), so quoted arguments keep their spaces. A `sh` job is shell text: one word is used verbatim, so quote the whole script (`sh "echo 'a b' | wc -l"`); several words are joined with spaces and a word holding whitespace or an empty one is single-quoted. Put a script that needs exact whitespace in a file and schedule `sh sh /path/to/script.sh`.

Examples:
```
scheduler add in 2h cmd project list
scheduler add --name standup cron 0 9 * * mon-fri cmd chat start Summarise yesterday's changes
scheduler add every 6h sh ./yena-backup.sh
```

## How jobs run

- The runner lives in yena: jobs run while a yena app is open. A run that fell while yena (or the container) was down runs once when yena opens; a repeating job then goes on from its next slot after now (missed runs are not repeated).
- One runner per container: the first yena process takes `runner.lock` (pid and process start time); other yena windows only manage jobs. A lock left by a dead process is taken over.
- Due jobs are checked every 15 s. Scripts run side by side, console lines one after another. A job does not start again while its previous run is still going.
- `cmd`: the line goes through the console's command bridge with caller `scheduler`. A `deny` command is refused. For a job added by the user, a `confirm` command runs without asking (the user approved it at `add`). For an assistant's or a legacy job, `confirm` is not pre-approved: the bridge runs only `safe` commands and declines the rest. A refused or declined run is recorded as `refused` with the bridge's reason. While another assistant command runs, the line waits 30 s and tries again. Timeout 10 min.
- `sh`: runs only for jobs added by the user; an assistant's or legacy `sh` job never runs: the run is `refused`, a repeating job is paused, a one-time job ends, and the notice says so. `/bin/sh -c <script>` in the yena root (`host.build.root.path`, else the process cwd), own process group (killed after 10 min), stdout and stderr captured (last 64 KiB, the last 2 KB kept in the log). Its environment leaves out every credential-looking variable (names with `TOKEN`, `SECRET`, `KEY`, `AUTH`, `PASSW`…, URLs with `user:pass@`) and the ssh-agent (`SSH_AUTH_SOCK`, `SSH_AGENT_PID`), as the claude chat's Bash does (`src/env.ts`); a script that needs a secret reads it itself.
- Output and notes are masked with the host's redactors (`Logger.redact`: registered secrets plus the built-in patterns) before `runs.jsonl` stores them and again when `show`/`log` print them, because those subcommands are `safe` for the assistant. On a host without `Logger.redact` they stay as they are.
- Each run prints a line such as `[scheduler] #2 backup (sh): ok in 1.4 s` above the chat, and is logged in `runs.jsonl`.

### Who may schedule what

The origin is `user` unless `ctx.signal` is set, which only core's assistant bridge does (the UI and the headless run leave it unset).
- `scheduler` lines can never be scheduled. The full nested path is resolved with core's `resolveCommandLine` against the bridge's catalog, so `claude auth login` is judged as that command, not as `claude`. An unknown command is refused.
- `deny` commands are refused for everyone.
- An assistant may add only `safe` `cmd` lines and no `sh` jobs; anything else is refused with a message asking the user to add the job.
- The user may add any non-`deny` line. Without a bridge, or with an empty catalog (agent commands off), the user's line is checked only for `scheduler` (run time enforces the rest) and an assistant's is refused.
- Every refusal happens before anything is written.

To start a chat with a message on a schedule, use the chat module's `chat start <message…>` (policy `confirm`): it opens a new chat in the main area and sends the message; the chat open before is saved and can be resumed. A scheduled chat runs only on an API key account (claude 0.21.0+, chat 0.4.0+): without one the job fails with the reason and no chat opens. Do not run Claude Code itself from an `sh` job on a subscription (e.g. `modules/claude/bin/claude -p …`): the credential variables are left out, but Claude Code still finds its own login in its config dir. Anthropic's Consumer Terms (§3) allow automated access only through an API key, so a scripted Claude Code run must use one (`ANTHROPIC_API_KEY` set in the script, read from your own secret store).

## Data

Under `<YENA_DATA>/scheduler` (0600 files, 0700 dir):
- `jobs.json`: `{v: 1, nextId, jobs: [{id, name?, by: user|assistant|legacy, schedule, when, action: {kind: 'cmd', line} | {kind: 'sh', script}, next, paused?, createdAt, runs, lastRun?, lastStatus?}]}`; schedules are `{kind: 'once', at}`, `{kind: 'every', everyMs, anchor}` or `{kind: 'cron', expr}`, times in epoch ms. Written atomically; a file that cannot be read is moved aside to `jobs.json.broken-<time>`.
- `runs.jsonl`: one line per run `{id, at, ms, status: ok|error|timeout|refused, note?, output?}`, the latest 300 kept.
- `runner.lock`: the runner's pid.

Migration: a stored job without a valid `by` (every job from before 0.3.0) is read as `legacy` and treated like an assistant's job; recreate it with `scheduler add` as the user to restore its pre-approval. `list` and `show` tag assistant and legacy jobs, and run logs carry `by`.

## Events

None.

## Dependencies

`core`, statically, only through `src/deps/core.ts` (re-exports `resolveCommandLine` from core's kit `text.ts`). Console lines need core's command bridge (`ctx.commandBridge`, core 0.4.0+); without it only `sh` jobs run.

## From the host terminal

`./yena scheduler list|show|log|add|remove|pause|resume` work without the app: they edit `jobs.json` and print. No runner starts (`ctx.headless`), so nothing runs until a yena app is open, and `scheduler run <id>` is refused there (`"scheduler run" needs the app (./yena)`).

## Limits and known risks

- Nothing runs while no yena app is open; there is no daemon of its own.
- A scheduled script runs with yena's rights, outside the chat's permission prompts: a user's job runs unattended and pre-approved, even for `confirm` commands: the approval is the `add`. An assistant can add only `safe` lines, but until `scheduler add` is asked about every time (`askEveryTime`, ISO-0, not shipped), a user can still "always allow" it in the chat; that now only lets the assistant schedule `safe` lines.
- The kit resolves at most 8 subcommand levels at `add` (the bridge has no limit; run time still enforces).
- The env scrub (`src/env.ts`) is still a copy of claude's.
- Two yena processes changing jobs at the same moment can lose one change (each write is atomic, read-modify-write is not).
- Shutting yena down in the middle of a run leaves it unrecorded; a repeating job runs again at its next slot, a one-time job runs again at the next start.
- No catch-up of several missed runs, no jitter, no per-job time zone.

## Layout

`src/`: `deps/core.ts` (adapter for core's kit), `index.ts` (plugin; the cwd for scripts), `commands.ts` (the `scheduler` command), `schedule.ts` (durations, times, cron, next run), `store.ts` (`jobs.json`, `runs.jsonl`), `runner.ts` (lock, ticks, running `cmd` and `sh` jobs), `log.ts`. Tests: `tests/schedule.test.ts`, `tests/runner.test.ts`, `tests/commands.test.ts`, `tests/store.test.ts`, `tests/bypass.test.ts` (adversarial cases).

## Development

`npm run typecheck`, `npm test` (inside the yena tree; `tsc` and `tsx` come from `/app/node_modules`).

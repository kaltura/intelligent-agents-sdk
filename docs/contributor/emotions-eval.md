> **Contributor doc.** For people changing the SDK, not for app builders. Public in this repository, not published on the docs site. [Index](README.md).

# Avatar emotions eval

Live eval for avatar emotions ([Limited Availability](limited-availability.md)). **Employee or certified partner only.** The model output is not deterministic, so the eval runs every scenario many times and reports rates with 95% intervals, not single pass or fail results.

## Run

```bash
TARGET=<name> node scripts/live-eval-emotions.mjs            # 8 trials per scenario, about 250 turns, about 4 minutes
TARGET=<name> node scripts/live-eval-emotions.mjs --trials 3 --scenarios joy,sarcasm --open
node scripts/live-eval-emotions.mjs --dry-run                # recorded fixture, no network, no TARGET
node scripts/live-eval-emotions.mjs --from out/x/emotions-eval-<stamp>.json   # rebuild the report
```

`TARGET` is required and has no default. The run creates one throwaway agent, reads its replies and deletes it on exit, also on Ctrl-C.

| Flag | Default | Meaning |
|---|---|---|
| `--trials` | 8 | Runs per scenario |
| `--scenarios` | all | Comma list of scenario ids |
| `--paths` | all four | `on`, `off`, `avatar-off`, `send` |
| `--concurrency` | 4 | Turns in flight |
| `--rate` | 80 | Most turns started per minute. The server allows 100 per minute and answers `rate_limited` above that |
| `--max-turns` | 400 | Turn budget. Whole trials are dropped, latest first. The report shows a banner when the plan was cut |
| `--turn-timeout` | 90 | Seconds before a turn is aborted. The abort closes the connection and the turn stops. The eval passes the abort signal to the stream that `send` uses |
| `--out` | `out/emotions-eval` | Output folder (git-ignored) |
| `--strict` | off | Exit 2 on PASS WITH WARNINGS |
| `--expand` | off | Open every turn list (for printing) |
| `--experiences` | off | Leave widgets on. By default the agent speaks only, so replies can carry an emotion |
| `--open` | off | Open the HTML report when done |

Every turn is written to `emotions-eval-<stamp>.json`. The report `emotions-eval-<stamp>.html` is built from that file only, so `--from` gives the same page.

## Paths

| Path | What it checks |
|---|---|
| `on` | Stream with `avatar` and `avatar_emotions` on. The main path |
| `off` | Stream with emotions off. Leakage check and latency baseline |
| `avatar-off` | `avatar` off, emotions on. Must be refused or inert |
| `send` | The aggregate `conversations.send` call |

The socket path is not covered. The SDK socket client sends a fixed capabilities map and cannot request emotions.

The offline parser checks run in every report: unknown label, non-string label, absent metadata, `collectConverse`, order, duplicate and missing labels, and a spoken `[emotion: ...]` tag.

## Read the report

| Section | What it tells you |
|---|---|
| Banner | The verdict and exit code |
| Insights | Rules over the numbers. PROBLEM, WATCH or NOTE |
| Hard dimensions | Must be 100%. Shows violations out of checked turns |
| Quality dimensions | Rates with 95% intervals against a target |
| Scenario by label | Heatmap of how often each label appeared. An outlined cell with ✓ is an accepted label |
| Expected-emotion rate | Bar per scenario with an interval whisker and the target line |
| Latency | Emotions on vs off, paired by scenario, trial and turn. The 95% interval is of the median per-pair difference |
| Turns by scenario | The real turns: path, prompt, each segment with its label and text. Weak and flaky scenarios start open |

The page has no script and makes no request. Status uses an icon and a word, not colour alone.

## Verdict

| Verdict | Exit | When |
|---|---|---|
| FAIL | 1 | A hard dimension has a violation, or turns were tried for a hard dimension and none was usable (an outage) |
| INCOMPLETE | 3 | A hard dimension has no data (for example its path was left out of `--paths`), or the run was stopped early (Ctrl-C) and no hard dimension failed |
| Second Ctrl-C | 130 | Cleans up and quits at once. No report is written |
| SOFT FAIL | 2 | Every hard dimension passes, and a quality dimension is confidently below target |
| PASS WITH WARNINGS | 0 (2 with `--strict`) | A quality dimension is undecided at this sample size |
| PASS | 0 | Everything is on the good side |
| Usage or run error | 4 | Bad flag, missing `TARGET`, read error |

A rate is judged by its Wilson 95% interval. PASS means the whole interval is on the good side of the target. FAIL means it is wholly on the bad side. UNDECIDED means it crosses the target: run more trials.

## Metrics

Hard dimensions:

| Name | Violation |
|---|---|
| leakage | A chunk carries an emotion with emotions off |
| validity | An emotion value outside `neutral`, `happy`, `sad`, `surprise` |
| placement | An emotion on a chunk that is not an avatar segment start |
| avatarOff | An emotion with `avatar` off |
| parser | An offline SDK parser check fails |

With zero violations the report shows the 95% upper bound of the true rate. A small run proves little.

Quality dimensions (targets live in `THRESHOLDS` in `scripts/lib/emotion-eval/analyze.mjs`):

| Name | Meaning | Target |
|---|---|---|
| coverage | Turns with at least one emotion | at least 80% |
| match | Of turns with a label, those whose label is in the scenario's accepted set | at least 70% |
| avatarChunks | Turns answered as avatar speech, not plain text | at least 90% |
| neutralFalsePositive | Neutral-topic turns that got a non-neutral label | at most 20% |
| emptyText | Turns with no spoken text | at most 5% |
| errors | Turns that failed, or ended with an error chunk | at most 5% |
| repeatedLabel | Two segments in a row with the same label | at most 10% |
| sendCoverage | Coverage on the `send` path | at least 70% |
| latency | Median total time, on minus off, upper end of the interval | at most 1500 ms |

The per-scenario status in the report uses the same 70% target but a wider base: all scored turns of the scenario, where a turn with no label counts as a miss. Per scenario the report also shows pass^3 (the chance that three runs in a row all show an accepted emotion, from the per-trial rate), a flaky mark for mixed results, and the label counts. The JSON analysis also holds segment density (labeled segments per avatar segment).

A turn the server refused for rate limiting is retried after the wait it asks for. If it still fails, it is counted as throttled and left out of every metric. An insight names the count.

## Scenarios

Defined in `scripts/lib/emotion-eval/scenarios.mjs`. Each has a `why` line and an accepted label set, with `accept: null` where the turn tests something else. The sets are judgments: sadness accepts `sad` and `neutral`, because a calm tone is a fair way to answer grief. Change a set there, with the reason.

Covered: joy, sadness, anger, surprise, fear, neutral fact, mixed, sarcasm, joke, greeting, short reply, long reply, tool call, Spanish, Japanese, Hebrew (right to left) and French cases, an empty user turn, a prompt injection that asks for a fake tag, repeated same-emotion turns and a topic shift in one thread.

## Test it offline

`test/unit/emotion-eval-*.test.js` cover the stats, the analysis, the report (escaping, CSP, empty and partial input), the runner with a fake client, and the command line, including `--dry-run`. The fixture is `scripts/lib/emotion-eval/fixtures/sample-results.json`. No test needs a network or credentials.

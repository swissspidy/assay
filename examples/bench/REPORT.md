# Model bench

2 models × 2 tasks × 1 run; checks scored on 5 held-out labelled runs.

| Model | Mode | Compiled | Stress ok | Bal. acc | False success | Turns | Tokens in | Tokens out | Cost | Time |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| anthropic:claude-opus-5-5 | tools | 100% | 100% | 1.000 | 0% | 3.5 | 49.0k | 662 | $0.1219 | — |
| ./models/copycat.ts | json | 100% | 100% | 1.000 | 0% | **2.0** | **12.5k** | **255** | — | 432 ms |

Best in column in **bold**. Compiled: tasks compiled. Stress ok: compiled check sets with no stress-test problems. Bal. acc, False success: the compiled checks on held-out labelled runs (False success: incorrect runs judged success). Turns, Tokens, Cost and Time (wall time of a compile) are per task.

## Tasks

| Task | File | Compiled from | Held-out runs |
|---|---|---|--:|
| 01-newsletter | tasks/01-newsletter.task.json | subscribed | 3 |
| 02-add-blue-mug | tasks/02-add-blue-mug.task.json | added-blue-mug | 2 |

## Per task

| Model | Task | Result | Stress | Held-out correct | Turns | Tokens in / out | Cost | Time |
|---|---|---|---|--:|--:|--:|--:|--:|
| anthropic:claude-opus-5-5 | 01-newsletter | compiled | ok (mutants 2/2, variants 9/9) | 3/3 | 3 | 39.5k / 631 | $0.1196 | — |
| anthropic:claude-opus-5-5 | 02-add-blue-mug | compiled | ok (mutants 2/2, variants 11/11) | 2/2 | 4 | 58.4k / 692 | $0.1242 | — |
| ./models/copycat.ts | 01-newsletter | compiled | ok (mutants 5/5, variants 9/9) | 3/3 | 2 | 12.6k / 373 | — | 429 ms |
| ./models/copycat.ts | 02-add-blue-mug | compiled | ok (mutants 1/1, variants 11/11) | 2/2 | 2 | 12.5k / 137 | — | 435 ms |

## Notes

- Replayed from cassettes: anthropic:claude-opus-5-5, ./models/copycat.ts.
- Cost —: no price listed for fixture:copycat.
- Time —: not recorded for anthropic:claude-opus-5-5 (replayed without timings).

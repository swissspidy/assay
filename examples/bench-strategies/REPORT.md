# Model bench

1 model × 3 discovery strategies (model, mine-first, mine-only) × 3 tasks × 1 run; checks scored on 10 held-out labelled runs.

| Model | Discovery | Mode | Compiled | Req. mined | Req. discovered | No discovery | Stress ok | Bal. acc | False success | Turns | Tokens in | Tokens out | Cost | Time |
|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| anthropic:claude-opus-5-5 | model | tools | **100%** | 0% | 100% | 0% | 100% | 1.000 | 0% | 3.7 | 54.0k | 1.1k | $0.1349 | — |
| anthropic:claude-opus-5-5 | mine-first | tools | **100%** | 50% | 50% | 33% | 100% | 1.000 | 0% | 3.0 | 44.5k | 1.1k | $0.1087 | 12.6 s |
| none | mine-only | — | 33% | 17% | 0% | 33% | 100% | 1.000 | 0% | **0.0** | **0** | **0** | **$0.0000** | — |

Best in column in **bold**. Compiled: tasks compiled. Stress ok: compiled check sets with no stress-test problems. Bal. acc, False success: the compiled checks on held-out labelled runs (False success: incorrect runs judged success). Turns, Tokens, Cost and Time (wall time of a compile) are per task. Discovery: how checks were found (ADR 0020); the mine-only row runs no model (deterministic rubric, mining alone). Compiled is the accept rate: tasks whose checks passed the acceptance gate. Req. mined, Req. discovered: the rubrics' requirements covered by mined checks and by checks the discovery agent wrote. No discovery: tasks compiled with no discovery-agent turn.

## Tasks

| Task | File | Compiled from | Held-out runs |
|---|---|---|--:|
| 01-newsletter | tasks/01-newsletter.task.json | subscribed | 3 |
| 02-add-blue-mug | tasks/02-add-blue-mug.task.json | added-blue-mug | 2 |
| 07-express-order | tasks/07-express-order.task.json | express-order | 5 |

## Per task

| Model | Discovery | Task | Result | Stress | Held-out correct | Requirements | Turns | Tokens in / out | Cost | Time |
|---|---|---|---|---|--:|---|--:|--:|--:|--:|
| anthropic:claude-opus-5-5 | model | 01-newsletter | compiled | ok (mutants 2/2, variants 9/9) | 3/3 | 0 mined, 2 discovered of 2 | 3 | 39.5k / 631 | $0.1196 | — |
| anthropic:claude-opus-5-5 | model | 02-add-blue-mug | compiled | ok (mutants 2/2, variants 11/11) | 2/2 | 0 mined, 1 discovered of 1 | 4 | 58.4k / 692 | $0.1242 | — |
| anthropic:claude-opus-5-5 | model | 07-express-order | compiled | ok (mutants 16/16, variants 10/10) | 5/5 | 0 mined, 5 discovered of 5 | 4 | 64.0k / 2.0k | $0.1610 | — |
| anthropic:claude-opus-5-5 | mine-first | 01-newsletter | compiled | ok (mutants 2/2, variants 9/9) | 3/3 | 0 mined, 2 discovered of 2 | 3 | 42.6k / 909 | $0.1380 | 12.3 s |
| anthropic:claude-opus-5-5 | mine-first | 02-add-blue-mug | compiled | ok (mutants 1/1, variants 11/11) | 2/2 | 1 mined, 0 discovered of 1 | 1 | 1.1k / 111 | $0.0078 | 2.3 s |
| anthropic:claude-opus-5-5 | mine-first | 07-express-order | compiled | ok (mutants 17/17, variants 10/10) | 5/5 | 3 mined, 2 discovered of 5 | 5 | 89.8k / 2.2k | $0.1802 | 23.2 s |
| none | mine-only | 01-newsletter | not compiled | — | — | 0 mined, 0 discovered of 2 | 0 | 0 / 0 | $0.0000 | — |
| none | mine-only | 02-add-blue-mug | compiled | ok (mutants 1/1, variants 11/11) | 2/2 | 1 mined, 0 discovered of 1 | 0 | 0 / 0 | $0.0000 | — |
| none | mine-only | 07-express-order | not compiled | — | — | 0 mined, 0 discovered of 3 | 0 | 0 / 0 | $0.0000 | — |

## Prices

USD per million tokens, by precedence: a `--prices` file, then `bench.prices`, then the built-in list.

| Model | Source | Listed as | Input | Output | Cache read | Cache write |
|---|---|---|--:|--:|--:|--:|
| anthropic:claude-opus-5-5@high | default | claude-opus-5-5 | $4 | $20 | $0.2 | $5 |

## Notes

- mine-only · 01-newsletter: not compiled: Mining did not cover every requirement: R1 "the newsletter subscription is saved": 4 candidate(s) survived, but none settles it: the best (R1-mined-1, probe) does not account for "subscription"; R2 "the newsletter checkbox in the preferences is checked": 5 candidate(s) survived, but none settles it: the best (R2-mined-5, a11y) does not account for "preferences"
- mine-only · 07-express-order: not compiled: Mining did not cover every requirement: R3 "the order confirmation is shown": 4 candidate(s) survived, but none settles it: the best (R3-mined-3, a11y) only shows that something is present or that a request was sent, and no incorrect reference fails it
- Replayed from cassettes: anthropic:claude-opus-5-5 · model, anthropic:claude-opus-5-5 · mine-first.
- mine-only: no model, so no turns, tokens or cost; Time — (mining time is left out, so the report replays byte for byte).
- Time —: not recorded for anthropic:claude-opus-5-5 · model (replayed without timings).

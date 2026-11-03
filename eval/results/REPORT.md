# Evaluation: compiled checks vs. LLM judge vs. agentic verifier

Generated 2026-11-03T01:50:06.537Z · check sets: **handwritten** · 123 labelled runs over 30 tasks (60 correct, 63 incorrect) in 3 apps.

Positive = the run really completed the task. TPR = correct runs judged success; TNR = incorrect runs judged not success (an abstain counts as not success). The agent always reports success, as agents usually do.

| System | Balanced accuracy | TPR | TNR | Abstain rate | Cost / run | Latency (median / p95) |
|---|---|---|---|---|---|---|
| checks | 1.000 | 1.000 | 1.000 | 0.000 | $0.0000 | 122 µs / 1.8 ms |
| checks+escalation | 1.000 | 1.000 | 1.000 | 0.000 | $0.0000 | 62 µs / 144 µs |
| llm-judge | not measured | | | | | |
| agentic-verifier | not measured | | | | | |

## Correct verdicts by run kind

| Kind | Runs | checks | checks+escalation | llm-judge | agentic-verifier |
|---|---|---|---|---|---|
| no-op | 8 | 8/8 | 8/8 | n/a | n/a |
| correct | 60 | 60/60 | 60/60 | n/a | n/a |
| undone | 3 | 3/3 | 3/3 | n/a | n/a |
| wrong-item | 28 | 28/28 | 28/28 | n/a | n/a |
| partial | 13 | 13/13 | 13/13 | n/a | n/a |
| over-completion | 3 | 3/3 | 3/3 | n/a | n/a |
| adversarial | 8 | 8/8 | 8/8 | n/a | n/a |

## Notes

- **llm-judge**: not measured (no ANTHROPIC_API_KEY and no recorded cassettes).
- **agentic-verifier**: not measured (no ANTHROPIC_API_KEY and no recorded cassettes).
- **Caveat:** these are the handwritten check sets, written by the same author as the labelled runs, so the checks rows are an upper bound and partly circular. The real measure is `--checks compiled` (checks compiled by the model from one correct run per task; all other runs held out).
- Model latency is only measured when recording; replayed runs show none.
- Checks-only latency is in-process evaluation of a captured snapshot (no model). Capture itself takes about 20-60 ms per page and is shared by every system.
- The LLM judge sees the final page as an accessibility outline plus visible text (no screenshots, no network or backend access).
- The agentic verifier explores the captured snapshot (accessibility tree, network log, storage, probe results) without live access.
- Checks gave the labelled verdict on every run.

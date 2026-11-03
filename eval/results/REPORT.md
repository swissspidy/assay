# Evaluation: handwritten checks (model baselines not measured yet)

Generated 2026-11-03T22:13:45.138Z · check sets: **handwritten** · 123 labelled runs over 30 tasks (60 correct, 63 incorrect) in 3 apps.

Positive = the run really completed the task. TPR = correct runs judged success; TNR = incorrect runs judged not success (an abstain counts as not success). The agent always reports success, as agents usually do.

| System | Balanced accuracy | TPR | TNR | Abstain rate | Cost / run | Latency (median / p95) |
|---|---|---|---|---|---|---|
| checks | 1.000 | 1.000 | 1.000 | 0.000 | $0.0000 | 129 µs / 2.2 ms |
| checks+escalation | 1.000 | 1.000 | 1.000 | 0.000 | $0.0000 | 79 µs / 182 µs |
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

- **llm-judge**: not measured (123/123 runs: no recorded cassette).
- **agentic-verifier**: not measured (123/123 runs: no recorded cassette).
- **Caveat:** these are the handwritten check sets, written by the same author as the labelled runs, so the checks rows are an upper bound and partly circular. The real measure is `--checks compiled` (checks compiled by the model from one correct run per task; all other runs held out).
- The LLM judge is shown the agent's report, as typical LLM judges are; Assay's checks never see it, and the agentic verifier gets it marked as context, not evidence.
- Model latency is only measured when recording; replayed runs show none.
- Checks-only latency is in-process evaluation of a captured snapshot (no model). Capture itself takes about 20-60 ms per page and is shared by every system.
- The LLM judge sees the final page as an accessibility outline plus visible text (no screenshots, no network or backend access).
- The agentic verifier explores the captured snapshot (accessibility tree, network log, storage, probe results) without live access.
- Checks gave the labelled verdict on every run.

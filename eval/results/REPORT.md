# Evaluation: handwritten checks vs. model baselines

Generated 2026-11-04T09:49:03.224Z · check sets: **handwritten** · 123 labelled runs over 30 tasks (60 correct, 63 incorrect) in 3 apps.

Positive = the run really completed the task. TPR = correct runs judged success; TNR = incorrect runs judged not success (an abstain counts as not success). The agent always reports success, as agents usually do.

| System | Balanced accuracy | TPR | TNR | Abstain rate | Cost / run | Latency (median / p95) |
|---|---|---|---|---|---|---|
| checks | 1.000 | 1.000 | 1.000 | 0.000 | $0.0000 | 290 µs / 4.7 ms |
| checks+escalation | 1.000 | 1.000 | 1.000 | 0.000 | $0.0000 | 191 µs / 355 µs |
| llm-judge | 0.944 | 0.967 | 0.921 | 0.000 | $0.0117 | 4.3 s / 10.0 s |
| agentic-verifier | 0.984 | 0.983 | 0.984 | 0.000 | $0.0244 | 7.8 s / 14.3 s |

## Correct verdicts by run kind

| Kind | Runs | checks | checks+escalation | llm-judge | agentic-verifier |
|---|---|---|---|---|---|
| no-op | 8 | 8/8 | 8/8 | 8/8 | 8/8 |
| correct | 60 | 60/60 | 60/60 | 58/60 | 59/60 |
| undone | 3 | 3/3 | 3/3 | 3/3 | 3/3 |
| wrong-item | 28 | 28/28 | 28/28 | 27/28 | 28/28 |
| partial | 13 | 13/13 | 13/13 | 12/13 | 12/13 |
| over-completion | 3 | 3/3 | 3/3 | 3/3 | 3/3 |
| adversarial | 8 | 8/8 | 8/8 | 5/8 | 8/8 |

## Notes

- **llm-judge** used anthropic:claude-opus-5-5@high.
- **agentic-verifier** used anthropic:claude-opus-5-5@high.
- **Caveat:** these are the handwritten check sets, written by the same author as the labelled runs, so the checks rows are an upper bound and partly circular. The real measure is `--checks compiled` (checks compiled by the model from one correct run per task; all other runs held out).
- The LLM judge is shown the agent's report, as typical LLM judges are; Assay's checks never see it, and the agentic verifier gets it marked as context, not evidence.
- Model latency is only measured when recording; replayed runs show none.
- Checks-only latency is in-process evaluation of a captured snapshot (no model). Capture itself takes about 20-60 ms per page and is shared by every system.
- The LLM judge sees the final page as an accessibility outline plus visible text (no screenshots, no network or backend access).
- The agentic verifier explores the captured snapshot (accessibility tree, network log, storage, probe results) without live access.
- Checks gave the labelled verdict on every run.

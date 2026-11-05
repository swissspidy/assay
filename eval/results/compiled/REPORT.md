# Evaluation: compiled checks vs. model baselines

Generated 2026-11-05T07:14:54.940Z · check sets: **compiled** · 96 labelled runs over 30 tasks (30 correct, 66 incorrect) in 3 apps.

Positive = the run really completed the task. TPR = correct runs judged success; TNR = incorrect runs judged not success (an abstain counts as not success). The agent always reports success, as agents usually do.

| System | Balanced accuracy | TPR | TNR | Abstain rate | Cost / run | Latency (median / p95) |
|---|---|---|---|---|---|---|
| checks | 1.000 | 1.000 | 1.000 | 0.000 | $0.0000 | 317 µs / 5.7 ms |
| checks+escalation | 1.000 | 1.000 | 1.000 | 0.000 | $0.0000 | 249 µs / 881 µs |
| llm-judge | 0.906 | 0.933 | 0.879 | 0.000 | $0.0119 | n/a (replayed) / n/a (replayed) (0 of 96 runs timed) |
| agentic-verifier | 0.976 | 0.967 | 0.985 | 0.000 | $0.0272 | 8.4 s / 15.5 s |

## Correct verdicts by run kind

| Kind | Runs | checks | checks+escalation | llm-judge | agentic-verifier |
|---|---|---|---|---|---|
| no-op | 8 | 8/8 | 8/8 | 8/8 | 8/8 |
| correct | 30 | 30/30 | 30/30 | 28/30 | 29/30 |
| undone | 3 | 3/3 | 3/3 | 3/3 | 3/3 |
| wrong-item | 28 | 28/28 | 28/28 | 27/28 | 28/28 |
| partial | 14 | 14/14 | 14/14 | 12/14 | 13/14 |
| over-completion | 5 | 5/5 | 5/5 | 3/5 | 5/5 |
| adversarial | 8 | 8/8 | 8/8 | 5/8 | 8/8 |

## Notes

- **llm-judge** used anthropic:claude-opus-5-5@high (replay).
- **agentic-verifier** used anthropic:claude-opus-5-5@high.
- Compiled check sets: each was compiled from one correct run per task. Those 30 runs are left out for every system, so all scored runs are held out.
- The LLM judge is shown the agent's report, as typical LLM judges are; Assay's checks never see it, and the agentic verifier gets it marked as context, not evidence.
- Model latency is only measured when recording; replayed runs show none.
- Checks-only latency is in-process evaluation of a captured snapshot (no model). Capture itself takes about 20-60 ms per page and is shared by every system.
- The LLM judge sees the final page as an accessibility outline plus visible text (no screenshots, no network or backend access).
- The agentic verifier explores the captured snapshot (accessibility tree, network log, storage, probe results) without live access.
- Checks gave the labelled verdict on every run.

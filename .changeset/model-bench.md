---
'@swissspidy/assay': minor
---

`assay bench` compares models on your own tasks: it compiles each task with each model (`--model`, repeatable: a `'provider:model'` string or a module exporting a model or adapter; or `bench.models` in `assay.config.ts`), stress-tests the check sets and scores them on the task's held-out labelled runs. One row per model: tasks compiled, check sets with no stress problems, balanced accuracy and false successes, and turns, tokens, cost and time per task, with the best value per column marked. `--runs N` gives mean and spread, `--task <glob>` filters, `--escalate` also tries each model as the verifier, `--json` and `--out report.md` write the full result. A model that errors shows it in its row while the others continue, and Ctrl-C prints what finished. `--record` writes cassettes per model under `assay-bench/` that replay offline (`ASSAY_MODEL_MODE=replay`), byte for byte. `priceFor` (in `@swissspidy/assay/eval`) looks up a model id's price.

```sh
assay bench -m anthropic:claude-opus-5-5 -m openai:gpt-5 -m ./my-adapter.ts --out bench.md
```

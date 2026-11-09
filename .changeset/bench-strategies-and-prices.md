---
'@swissspidy/assay': minor
---

`assay bench --discovery model,mine-first,mine-only` (or `bench.discovery`) compares the discovery strategies of the mining-first compiler side by side for each model: turns, tokens and cost, plus requirements mined vs. discovered, tasks compiled with no discovery turn, and the accept rate. `mine-only` runs no model and gets one row with zero cost. `mine-first` cassettes live under `<task>/mine-first/`, so existing cassettes, and the default bench's output, are unchanged. Model prices can be overridden and extended with `bench.prices` and `--prices <file.json>` (`{ "provider:model": { input, output, cacheRead?, cacheWrite? } }` in USD per million tokens; flag > config > built-in, validated), and the report says where each price came from, or `price unknown`, never $0.

```sh
assay bench --discovery model,mine-first,mine-only --prices prices.json --out bench.md
```

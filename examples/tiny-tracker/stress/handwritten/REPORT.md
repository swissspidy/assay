# Stress test: handwritten tiny-tracker checks

| Task | Variants accepted | Mutants rejected (fail / abstain) | Over-constrained | Weak | Missed |
|---|---|---|---|---|---|
| tiny-tracker/create-bug | 20/20 | 12/12 (12 / 0) | – | – | 0 |
| tiny-tracker/create-high-priority | 20/20 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/close-issue | 20/20 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/reopen-issue | 20/20 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/assign-bob | 20/20 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/add-feature-label | 20/20 | 8/8 (8 / 0) | – | – | 0 |
| tiny-tracker/comment | 20/20 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/rename | 20/20 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/unassign | 20/20 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/filter-open-bugs | 20/20 | 12/12 (12 / 0) | – | – | 0 |
| **tiny-tracker** | **200/200** | **60/60** (60 / 0) | | | 0 |

## tiny-tracker/create-bug v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **12/12** (100%; 12 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 12/12
## tiny-tracker/create-high-priority v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/close-issue v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/reopen-issue v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/assign-bob v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/add-feature-label v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **8/8** (100%; 8 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 8/8
## tiny-tracker/comment v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/rename v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/unassign v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/filter-open-bugs v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **12/12** (100%; 12 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 12/12

**Advisories**
- filtered-by-url/claims-only (the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable)
- filtered/claims-only (the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable)

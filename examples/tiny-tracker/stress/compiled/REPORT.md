# Stress test: compiled tiny-tracker checks

| Task | Variants accepted | Mutants rejected (fail / abstain) | Over-constrained | Weak | Missed |
|---|---|---|---|---|---|
| tiny-tracker/01-create-bug | 20/20 | 12/12 (12 / 0) | – | – | 0 |
| tiny-tracker/02-create-high-priority | 20/20 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/03-close-issue | 20/20 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/04-reopen-issue | 20/20 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/05-assign-bob | 20/20 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/06-add-feature-label | 20/20 | 8/8 (8 / 0) | – | – | 0 |
| tiny-tracker/07-comment | 20/20 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/08-rename | 20/20 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/09-unassign | 20/20 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/10-filter-open-bugs | 20/20 | 10/10 (10 / 0) | – | – | 0 |
| **tiny-tracker** | **200/200** | **58/58** (58 / 0) | | | 0 |

## tiny-tracker/01-create-bug v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **12/12** (100%; 12 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 12/12
## tiny-tracker/02-create-high-priority v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/03-close-issue v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/04-reopen-issue v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/05-assign-bob v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/06-add-feature-label v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **8/8** (100%; 8 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 8/8
## tiny-tracker/07-comment v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/08-rename v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/09-unassign v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/10-filter-open-bugs v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **10/10** (100%; 10 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 10/10

**Advisories**
- filtered-by-url/claims-only (the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable)
- filtered/claims-only (the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable)

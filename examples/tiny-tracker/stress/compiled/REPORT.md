# Stress test: compiled tiny-tracker checks

| Task | Variants accepted | Mutants rejected (fail / abstain) | Over-constrained | Weak | Missed |
|---|---|---|---|---|---|
| tiny-tracker/01-create-bug | 22/22 | 12/12 (12 / 0) | – | – | 0 |
| tiny-tracker/02-create-high-priority | 22/22 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/03-close-issue | 22/22 | 6/6 (6 / 0) | – | – | 0 |
| tiny-tracker/04-reopen-issue | 22/22 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/05-assign-bob | 22/22 | 6/6 (6 / 0) | – | – | 0 |
| tiny-tracker/06-add-feature-label | 22/22 | 10/10 (10 / 0) | – | – | 0 |
| tiny-tracker/07-comment | 22/22 | 6/6 (6 / 0) | – | – | 0 |
| tiny-tracker/08-rename | 22/22 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/09-unassign | 22/22 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/10-filter-open-bugs | 20/20 | 28/28 (28 / 0) | – | – | 0 |
| **tiny-tracker** | **218/218** | **84/84** (84 / 0) | | | 0 |

## tiny-tracker/01-create-bug v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **12/12** (100%; 12 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 12/12
## tiny-tracker/02-create-high-priority v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/03-close-issue v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **6/6** (100%; 6 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 6/6
## tiny-tracker/04-reopen-issue v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/05-assign-bob v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **6/6** (100%; 6 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 6/6
## tiny-tracker/06-add-feature-label v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **10/10** (100%; 10 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 10/10
## tiny-tracker/07-comment v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **6/6** (100%; 6 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 6/6
## tiny-tracker/08-rename v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/09-unassign v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/10-filter-open-bugs v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **28/28** (100%; 28 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 28/28

**Advisories**
- filtered-by-url/claims-only (the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable)
- filtered/claims-only (the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable)

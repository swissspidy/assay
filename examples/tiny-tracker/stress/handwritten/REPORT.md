# Stress test: handwritten tiny-tracker checks

| Task | Variants accepted | Mutants rejected (fail / abstain) | Over-constrained | Weak | Missed |
|---|---|---|---|---|---|
| tiny-tracker/create-bug | 22/22 | 12/12 (12 / 0) | – | – | 0 |
| tiny-tracker/create-high-priority | 22/22 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/close-issue | 22/22 | 6/6 (6 / 0) | – | – | 0 |
| tiny-tracker/reopen-issue | 22/22 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/assign-bob | 22/22 | 6/6 (6 / 0) | – | – | 0 |
| tiny-tracker/add-feature-label | 22/22 | 10/10 (10 / 0) | – | – | 0 |
| tiny-tracker/comment | 22/22 | 6/6 (6 / 0) | – | – | 0 |
| tiny-tracker/rename | 22/22 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/unassign | 22/22 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/filter-open-bugs | 20/20 | 26/26 (26 / 0) | – | – | 0 |
| **tiny-tracker** | **218/218** | **82/82** (82 / 0) | | | 0 |

## tiny-tracker/create-bug v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **12/12** (100%; 12 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 12/12
## tiny-tracker/create-high-priority v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/close-issue v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **6/6** (100%; 6 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 6/6
## tiny-tracker/reopen-issue v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/assign-bob v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **6/6** (100%; 6 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 6/6
## tiny-tracker/add-feature-label v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **10/10** (100%; 10 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 10/10
## tiny-tracker/comment v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **6/6** (100%; 6 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 6/6
## tiny-tracker/rename v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/unassign v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/filter-open-bugs v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **26/26** (100%; 26 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 26/26

**Advisories**
- filtered-by-url/claims-only (the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable)
- filtered/claims-only (the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable)

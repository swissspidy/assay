# Stress test: compiled tiny-tracker checks

| Task | Variants accepted | Mutants rejected (fail / abstain) | Over-constrained | Weak | Missed |
|---|---|---|---|---|---|
| tiny-tracker/01-create-bug | 22/22 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/02-create-high-priority | 22/22 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/03-close-issue | 22/22 | 8/8 (8 / 0) | – | – | 0 |
| tiny-tracker/04-reopen-issue | 22/22 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/05-assign-bob | 22/22 | 8/8 (8 / 0) | – | – | 0 |
| tiny-tracker/06-add-feature-label | 24/24 | 20/20 (20 / 0) | – | – | 0 |
| tiny-tracker/07-comment | 22/22 | 10/10 (10 / 0) | – | – | 0 |
| tiny-tracker/08-rename | 22/22 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/09-unassign | 22/22 | 4/4 (4 / 0) | – | – | 0 |
| tiny-tracker/10-filter-open-bugs | 20/20 | 16/16 (16 / 0) | – | – | 0 |
| **tiny-tracker** | **220/220** | **82/82** (82 / 0) | | | 0 |

## tiny-tracker/01-create-bug v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/02-create-high-priority v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/03-close-issue v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **8/8** (100%; 8 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 8/8
## tiny-tracker/04-reopen-issue v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-tracker/05-assign-bob v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **8/8** (100%; 8 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 8/8
## tiny-tracker/06-add-feature-label v1

- Valid variants accepted: **24/24** (100%)
- Mutants rejected: **20/20** (100%; 20 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 20/20
## tiny-tracker/07-comment v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **10/10** (100%; 10 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 10/10
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
- Mutants rejected: **16/16** (100%; 16 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 16/16

**Advisories**
- filtered-by-url/claims-only (the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable)
- filtered/claims-only (the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable)

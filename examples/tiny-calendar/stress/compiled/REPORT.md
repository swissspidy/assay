# Stress test: compiled tiny-calendar checks

| Task | Variants accepted | Mutants rejected (fail / abstain) | Over-constrained | Weak | Missed |
|---|---|---|---|---|---|
| tiny-calendar/01-lunch | 28/28 | 26/26 (16 / 10) | – | – | 0 |
| tiny-calendar/02-reminder | 22/22 | 8/8 (8 / 0) | – | – | 0 |
| tiny-calendar/03-rsvp | 22/22 | 4/4 (4 / 0) | – | – | 0 |
| tiny-calendar/04-move-dentist | 22/22 | 10/10 (10 / 0) | – | – | 0 |
| tiny-calendar/05-delete-standup | 24/24 | 14/14 (14 / 0) | – | – | 0 |
| tiny-calendar/06-location | 22/22 | 4/4 (4 / 0) | – | – | 0 |
| tiny-calendar/07-timezone | 20/20 | 2/2 (2 / 0) | – | – | 0 |
| tiny-calendar/08-week-start | 18/18 | 4/4 (4 / 0) | – | – | 0 |
| tiny-calendar/09-rename-dentist | 22/22 | 8/8 (8 / 0) | – | – | 0 |
| tiny-calendar/10-workshop | 22/22 | 6/6 (6 / 0) | – | – | 0 |
| **tiny-calendar** | **222/222** | **86/86** (76 / 10) | | | 0 |

## tiny-calendar/01-lunch v1

- Valid variants accepted: **28/28** (100%)
- Mutants rejected: **26/26** (100%; 16 by fail, 10 by abstain)
- Mutants with a success claim added still rejected: 26/26
## tiny-calendar/02-reminder v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **8/8** (100%; 8 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 8/8
## tiny-calendar/03-rsvp v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-calendar/04-move-dentist v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **10/10** (100%; 10 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 10/10
## tiny-calendar/05-delete-standup v1

- Valid variants accepted: **24/24** (100%)
- Mutants rejected: **14/14** (100%; 14 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 14/14

**Checks without a targeted mutant**
- R1-standup-gone
## tiny-calendar/06-location v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-calendar/07-timezone v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **2/2** (100%; 2 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 2/2
## tiny-calendar/08-week-start v1

- Valid variants accepted: **18/18** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-calendar/09-rename-dentist v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **8/8** (100%; 8 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 8/8
## tiny-calendar/10-workshop v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **6/6** (100%; 6 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 6/6

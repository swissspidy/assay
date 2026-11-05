# Stress test: compiled tiny-shop checks

| Task | Variants accepted | Mutants rejected (fail / abstain) | Over-constrained | Weak | Missed |
|---|---|---|---|---|---|
| tiny-shop/01-newsletter | 18/18 | 12/12 (12 / 0) | – | – | 0 |
| tiny-shop/02-add-blue-mug | 22/22 | 4/4 (4 / 0) | – | – | 0 |
| tiny-shop/03-cart-two-mugs | 24/24 | 28/28 (28 / 0) | – | – | 0 |
| tiny-shop/04-remove-red-mug | 23/23 | 29/29 (29 / 0) | – | r2-others-kept | 0 |
| tiny-shop/05-set-quantity | 22/22 | 20/20 (18 / 2) | – | – | 0 |
| tiny-shop/06-cart-total | 30/30 | 34/34 (34 / 0) | – | – | 0 |
| tiny-shop/07-express-order | 20/20 | 36/36 (36 / 0) | – | – | 0 |
| tiny-shop/08-delivery-date | 36/36 | 50/50 (50 / 0) | – | – | 0 |
| tiny-shop/09-gift-wrap | 20/20 | 12/12 (12 / 0) | – | – | 0 |
| tiny-shop/10-dark-german | 16/16 | 12/12 (12 / 0) | – | – | 0 |
| **tiny-shop** | **231/231** | **237/237** (235 / 2) | | | 0 |

## tiny-shop/01-newsletter v1

- Valid variants accepted: **18/18** (100%)
- Mutants rejected: **12/12** (100%; 12 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 12/12
## tiny-shop/02-add-blue-mug v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-shop/03-cart-two-mugs v1

- Valid variants accepted: **24/24** (100%)
- Mutants rejected: **28/28** (100%; 28 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 28/28
## tiny-shop/04-remove-red-mug v1

- Valid variants accepted: **23/23** (100%)
- Mutants rejected: **29/29** (100%; 29 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 29/29

**Weak checks (pass although their own evidence was broken)**
- r2-others-kept: removed-red-mug-keeping-teapot/r2-others-kept:baseline:no-op (probe cart at /items is what it was before the task); removed-red-mug/r2-others-kept:baseline:no-op (probe cart at /items is what it was before the task)

**Checks without a targeted mutant**
- r1-no-red-mug
## tiny-shop/05-set-quantity v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **20/20** (100%; 18 by fail, 2 by abstain)
- Mutants with a success claim added still rejected: 20/20
## tiny-shop/06-cart-total v1

- Valid variants accepted: **30/30** (100%)
- Mutants rejected: **34/34** (100%; 34 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 34/34
## tiny-shop/07-express-order v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **36/36** (100%; 36 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 36/36
## tiny-shop/08-delivery-date v1

- Valid variants accepted: **36/36** (100%)
- Mutants rejected: **50/50** (100%; 50 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 50/50
## tiny-shop/09-gift-wrap v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **12/12** (100%; 12 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 12/12
## tiny-shop/10-dark-german v1

- Valid variants accepted: **16/16** (100%)
- Mutants rejected: **12/12** (100%; 12 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 12/12

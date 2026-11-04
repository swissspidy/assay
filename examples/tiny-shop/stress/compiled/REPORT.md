# Stress test: compiled tiny-shop checks

| Task | Variants accepted | Mutants rejected (fail / abstain) | Over-constrained | Weak | Missed |
|---|---|---|---|---|---|
| tiny-shop/01-newsletter | 18/18 | 4/4 (4 / 0) | – | – | 0 |
| tiny-shop/02-add-blue-mug | 22/22 | 2/2 (2 / 0) | – | – | 0 |
| tiny-shop/03-cart-two-mugs | 24/24 | 14/14 (14 / 0) | – | – | 0 |
| tiny-shop/04-remove-red-mug | 23/23 | 6/6 (6 / 0) | – | – | 0 |
| tiny-shop/05-set-quantity | 22/22 | 4/4 (4 / 0) | – | – | 0 |
| tiny-shop/06-cart-total | 30/30 | 30/30 (30 / 0) | – | – | 0 |
| tiny-shop/07-express-order | 20/20 | 52/52 (52 / 0) | – | – | 0 |
| tiny-shop/08-delivery-date | 28/28 | 36/36 (36 / 0) | – | – | 0 |
| tiny-shop/09-gift-wrap | 20/20 | 20/20 (20 / 0) | – | – | 0 |
| tiny-shop/10-dark-german | 16/16 | 12/12 (12 / 0) | – | – | 0 |
| **tiny-shop** | **223/223** | **180/180** (180 / 0) | | | 0 |

## tiny-shop/01-newsletter v1

- Valid variants accepted: **18/18** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-shop/02-add-blue-mug v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **2/2** (100%; 2 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 2/2
## tiny-shop/03-cart-two-mugs v1

- Valid variants accepted: **24/24** (100%)
- Mutants rejected: **14/14** (100%; 14 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 14/14
## tiny-shop/04-remove-red-mug v1

- Valid variants accepted: **23/23** (100%)
- Mutants rejected: **6/6** (100%; 6 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 6/6

**Checks without a targeted mutant**
- r1-probe-no-red-mug
## tiny-shop/05-set-quantity v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-shop/06-cart-total v1

- Valid variants accepted: **30/30** (100%)
- Mutants rejected: **30/30** (100%; 30 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 30/30
## tiny-shop/07-express-order v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **52/52** (100%; 52 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 52/52
## tiny-shop/08-delivery-date v1

- Valid variants accepted: **28/28** (100%)
- Mutants rejected: **36/36** (100%; 36 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 36/36
## tiny-shop/09-gift-wrap v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **20/20** (100%; 20 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 20/20
## tiny-shop/10-dark-german v1

- Valid variants accepted: **16/16** (100%)
- Mutants rejected: **12/12** (100%; 12 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 12/12

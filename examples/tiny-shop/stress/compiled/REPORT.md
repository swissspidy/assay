# Stress test: compiled tiny-shop checks

| Task | Variants accepted | Mutants rejected (fail / abstain) | Over-constrained | Weak | Missed |
|---|---|---|---|---|---|
| tiny-shop/01-newsletter | 18/18 | 4/4 (4 / 0) | – | – | 0 |
| tiny-shop/02-add-blue-mug | 22/22 | 6/6 (6 / 0) | – | – | 0 |
| tiny-shop/03-cart-two-mugs | 24/24 | 28/28 (28 / 0) | – | – | 0 |
| tiny-shop/04-remove-red-mug | 23/23 | 27/27 (27 / 0) | – | – | 0 |
| tiny-shop/05-set-quantity | 22/22 | 14/14 (12 / 2) | – | – | 0 |
| tiny-shop/06-cart-total | 30/30 | 38/38 (38 / 0) | – | – | 0 |
| tiny-shop/07-express-order | 20/20 | 32/32 (32 / 0) | – | – | 0 |
| tiny-shop/08-delivery-date | 36/36 | 54/54 (46 / 8) | – | – | 0 |
| tiny-shop/09-gift-wrap | 20/20 | 12/12 (12 / 0) | – | – | 0 |
| tiny-shop/10-dark-german | 16/16 | 12/12 (12 / 0) | – | – | 0 |
| **tiny-shop** | **231/231** | **227/227** (217 / 10) | | | 0 |

## tiny-shop/01-newsletter v1

- Valid variants accepted: **18/18** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-shop/02-add-blue-mug v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **6/6** (100%; 6 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 6/6
## tiny-shop/03-cart-two-mugs v1

- Valid variants accepted: **24/24** (100%)
- Mutants rejected: **28/28** (100%; 28 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 28/28
## tiny-shop/04-remove-red-mug v1

- Valid variants accepted: **23/23** (100%)
- Mutants rejected: **27/27** (100%; 27 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 27/27

**Checks without a targeted mutant**
- r1-no-red-mug
## tiny-shop/05-set-quantity v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **14/14** (100%; 12 by fail, 2 by abstain)
- Mutants with a success claim added still rejected: 14/14
## tiny-shop/06-cart-total v1

- Valid variants accepted: **30/30** (100%)
- Mutants rejected: **38/38** (100%; 38 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 38/38
## tiny-shop/07-express-order v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **32/32** (100%; 32 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 32/32
## tiny-shop/08-delivery-date v1

- Valid variants accepted: **36/36** (100%)
- Mutants rejected: **54/54** (100%; 46 by fail, 8 by abstain)
- Mutants with a success claim added still rejected: 54/54
## tiny-shop/09-gift-wrap v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **12/12** (100%; 12 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 12/12
## tiny-shop/10-dark-german v1

- Valid variants accepted: **16/16** (100%)
- Mutants rejected: **12/12** (100%; 12 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 12/12

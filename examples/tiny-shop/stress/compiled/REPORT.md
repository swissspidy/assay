# Stress test: compiled tiny-shop checks

| Task | Variants accepted | Mutants rejected (fail / abstain) | Over-constrained | Weak | Missed |
|---|---|---|---|---|---|
| tiny-shop/01-newsletter | 18/18 | 12/12 (12 / 0) | – | – | 0 |
| tiny-shop/02-add-blue-mug | 22/22 | 2/2 (2 / 0) | – | – | 0 |
| tiny-shop/03-cart-two-mugs | 24/24 | 14/14 (14 / 0) | – | – | 0 |
| tiny-shop/04-remove-red-mug | 23/23 | 4/4 (4 / 0) | – | – | 0 |
| tiny-shop/05-set-quantity | 22/22 | 4/4 (4 / 0) | – | – | 0 |
| tiny-shop/06-cart-total | 30/30 | 28/28 (28 / 0) | – | – | 0 |
| tiny-shop/07-express-order | 20/20 | 16/16 (16 / 0) | – | – | 0 |
| tiny-shop/08-delivery-date | 18/20 | 26/26 (26 / 0) | – | – | 0 |
| tiny-shop/09-gift-wrap | 20/20 | 10/10 (10 / 0) | – | – | 0 |
| tiny-shop/10-dark-german | 16/16 | 12/12 (12 / 0) | – | – | 0 |
| **tiny-shop** | **213/215** | **128/128** (128 / 0) | | | 0 |

## tiny-shop/01-newsletter v1

- Valid variants accepted: **18/18** (100%)
- Mutants rejected: **12/12** (100%; 12 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 12/12
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
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4

**Checks without a targeted mutant**
- r1-probe-no-red-mug
## tiny-shop/05-set-quantity v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 4/4
## tiny-shop/06-cart-total v1

- Valid variants accepted: **30/30** (100%)
- Mutants rejected: **28/28** (100%; 28 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 28/28
## tiny-shop/07-express-order v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **16/16** (100%; 16 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 16/16
## tiny-shop/08-delivery-date v1

- Valid variants accepted: **18/20** (90%)
- Mutants rejected: **26/26** (100%; 26 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 26/26

**Fragile checks (abstain on a valid variant)**
- R1-confirmation-delivery-date: express-order/spacing (non-breaking and doubled spaces in visible text); express-two-items/spacing (non-breaking and doubled spaces in visible text)
## tiny-shop/09-gift-wrap v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **10/10** (100%; 10 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 10/10
## tiny-shop/10-dark-german v1

- Valid variants accepted: **16/16** (100%)
- Mutants rejected: **12/12** (100%; 12 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 12/12

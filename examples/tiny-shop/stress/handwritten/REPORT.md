# Stress test: handwritten tiny-shop checks

| Task | Variants accepted | Mutants rejected (fail / abstain) | Over-constrained | Weak | Missed |
|---|---|---|---|---|---|
| tiny-shop/newsletter | 18/18 | 10/10 (10 / 0) | – | – | 0 |
| tiny-shop/add-blue-mug | 22/22 | 2/2 (2 / 0) | – | – | 0 |
| tiny-shop/cart-two-mugs | 24/24 | 8/8 (8 / 0) | – | – | 0 |
| tiny-shop/remove-red-mug | 23/23 | 6/6 (6 / 0) | – | – | 0 |
| tiny-shop/set-quantity | 22/22 | 6/6 (6 / 0) | – | – | 0 |
| tiny-shop/cart-total | 30/30 | 14/14 (14 / 0) | – | – | 0 |
| tiny-shop/express-order | 20/20 | 14/14 (14 / 0) | – | – | 0 |
| tiny-shop/delivery-date | 28/28 | 8/8 (8 / 0) | – | – | 0 |
| tiny-shop/gift-wrap | 20/20 | 10/10 (10 / 0) | – | – | 0 |
| tiny-shop/dark-german | 16/16 | 10/10 (10 / 0) | – | – | 0 |
| **tiny-shop** | **223/223** | **88/88** (88 / 0) | | | 0 |

## tiny-shop/newsletter v1

- Valid variants accepted: **18/18** (100%)
- Mutants rejected: **10/10** (100%; 10 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 10/10
## tiny-shop/add-blue-mug v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **2/2** (100%; 2 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 2/2
## tiny-shop/cart-two-mugs v1

- Valid variants accepted: **24/24** (100%)
- Mutants rejected: **8/8** (100%; 8 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 8/8

**Advisories**
- both-mugs-and-teapot/claims-only (the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable)
- both-mugs/claims-only (the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable)
## tiny-shop/remove-red-mug v1

- Valid variants accepted: **23/23** (100%)
- Mutants rejected: **6/6** (100%; 6 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 6/6
## tiny-shop/set-quantity v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **6/6** (100%; 6 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 6/6

**Advisories**
- quantity-2-then-3/claims-only (the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable)
- quantity-3/claims-only (the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable)
## tiny-shop/cart-total v1

- Valid variants accepted: **30/30** (100%)
- Mutants rejected: **14/14** (100%; 14 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 14/14

**Advisories**
- blue-and-red/claims-only (the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable)
- red-then-blue/claims-only (the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable)
## tiny-shop/express-order v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **14/14** (100%; 14 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 14/14
## tiny-shop/delivery-date v1

- Valid variants accepted: **28/28** (100%)
- Mutants rejected: **8/8** (100%; 8 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 8/8
## tiny-shop/gift-wrap v1

- Valid variants accepted: **20/20** (100%)
- Mutants rejected: **10/10** (100%; 10 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 10/10
## tiny-shop/dark-german v1

- Valid variants accepted: **16/16** (100%)
- Mutants rejected: **10/10** (100%; 10 by fail, 0 by abstain)
- Mutants with a success claim added still rejected: 10/10

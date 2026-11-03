# Stress test: handwritten Tiny Shop checks

| Task                     | Variants accepted | Mutants rejected (fail / abstain) | Over-constrained | Weak | Missed |
| ------------------------ | ----------------- | --------------------------------- | ---------------- | ---- | ------ |
| tiny-shop/newsletter     | 12/12             | 16/16 (16 / 0)                    | –                | –    | 0      |
| tiny-shop/add-blue-mug   | 14/14             | 4/4 (4 / 0)                       | –                | –    | 0      |
| tiny-shop/cart-two-mugs  | 16/16             | 8/8 (8 / 0)                       | –                | –    | 0      |
| tiny-shop/remove-red-mug | 15/15             | 12/12 (12 / 0)                    | –                | –    | 0      |
| tiny-shop/set-quantity   | 14/14             | 8/8 (8 / 0)                       | –                | –    | 0      |
| tiny-shop/cart-total     | 22/22             | 8/8 (8 / 0)                       | –                | –    | 0      |
| tiny-shop/express-order  | 12/12             | 18/18 (18 / 0)                    | –                | –    | 0      |
| tiny-shop/delivery-date  | 18/18             | 12/12 (12 / 0)                    | –                | –    | 0      |
| tiny-shop/gift-wrap      | 12/12             | 16/16 (16 / 0)                    | –                | –    | 0      |
| tiny-shop/dark-german    | 12/12             | 16/16 (16 / 0)                    | –                | –    | 0      |
| **Total**                | **147/147**       | **118/118** (118 / 0)             |                  |      |        |

## tiny-shop/newsletter v1

- Valid variants accepted: **12/12** (100%)
- Mutants rejected: **16/16** (100%; 16 by fail, 0 by abstain)

## tiny-shop/add-blue-mug v1

- Valid variants accepted: **14/14** (100%)
- Mutants rejected: **4/4** (100%; 4 by fail, 0 by abstain)

## tiny-shop/cart-two-mugs v1

- Valid variants accepted: **16/16** (100%)
- Mutants rejected: **8/8** (100%; 8 by fail, 0 by abstain)

**Advisories**

- both-mugs-and-teapot/claims-only: the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable
- both-mugs/claims-only: the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable

## tiny-shop/remove-red-mug v1

- Valid variants accepted: **15/15** (100%)
- Mutants rejected: **12/12** (100%; 12 by fail, 0 by abstain)

## tiny-shop/set-quantity v1

- Valid variants accepted: **14/14** (100%)
- Mutants rejected: **8/8** (100%; 8 by fail, 0 by abstain)

**Advisories**

- quantity-2-then-3/claims-only: the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable
- quantity-3/claims-only: the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable

## tiny-shop/cart-total v1

- Valid variants accepted: **22/22** (100%)
- Mutants rejected: **8/8** (100%; 8 by fail, 0 by abstain)

**Advisories**

- blue-and-red/claims-only: the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable
- red-then-blue/claims-only: the page looks exactly like success, but no state-changing request was sent, storage is empty and the backend is unreachable

## tiny-shop/express-order v1

- Valid variants accepted: **12/12** (100%)
- Mutants rejected: **18/18** (100%; 18 by fail, 0 by abstain)

## tiny-shop/delivery-date v1

- Valid variants accepted: **18/18** (100%)
- Mutants rejected: **12/12** (100%; 12 by fail, 0 by abstain)

## tiny-shop/gift-wrap v1

- Valid variants accepted: **12/12** (100%)
- Mutants rejected: **16/16** (100%; 16 by fail, 0 by abstain)

## tiny-shop/dark-german v1

- Valid variants accepted: **12/12** (100%)
- Mutants rejected: **16/16** (100%; 16 by fail, 0 by abstain)

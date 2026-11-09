# Agent regression gate

**Gate failed (blocking: 02-add-blue-mug). 1 regressed, 1 improved, 1 new, 1 unchanged.**

Baseline: `baseline` (6 runs). Candidate: `candidate` (7 runs). A task or requirement regressed when fewer candidate runs passed than the baseline's pass rate predicts, and improved when more did; abstain counts as not passing.

| | Task | Change | Success | Requirements |
|---|---|---|--:|---|
| ✘ | 02-add-blue-mug | regressed | 2/2 → 1/2 | R1 2/2 → 1/2 |
| ✔ | 07-express-order | improved | 1/2 → 2/2 | R2 1/2 → 2/2 |
| + | 09-gift-wrap | new | — → 1/1 | — |
| · | 01-newsletter | unchanged | 2/2 → 2/2 |  |

## Regressions

### 02-add-blue-mug: R1 The cart contains a Blue Mug (hard)

Baseline: 2 of 2 passed. Candidate: 1 of 2 passed, 1 failed.

In `candidate/02-add-blue-mug/run-2.json` (FAIL):

- **C1** The backend cart (probe 'cart') has a line item named Blue Mug.
  - Expected: `backend probe cart at /items, {"schema":{"type":"array","contains":{"type":"object","required":["name"],"properties":{"name":{"const":"Blue Mug"}}}}}`
  - Found: `probe cart at /items = [{"sku":"MUG-RED","name":"Red Mug","qty":1,"price":9.5,"lineTotal":9.5}]`
  - Result: fail: schema mismatch: data must contain at least 1 valid item(s)
  - Baseline found: `probe cart at /items = [{"sku":"MUG-BLUE","name":"Blue Mug","qty":1,"price":12,"lineTotal":12}]` in `baseline/02-add-blue-mug/run-1.json`

## Tasks on one side

- `09-gift-wrap`: new, 1 of 1 candidate run succeeded.

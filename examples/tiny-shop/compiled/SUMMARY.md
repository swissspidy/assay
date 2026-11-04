# Compiled tiny-shop checks

Each task was compiled from its instruction, its "Then" clauses and one correct reference run.
The remaining labelled runs were held out; the last column counts how many the compiled checks judge correctly.

| Task | Requirements | Checks | Evidence per requirement | Held-out runs correct |
|---|---|---|---|---|
| 01-newsletter | 2 | 3 | R1:probe+network, R2:a11y | 3/3 |
| 02-add-blue-mug | 1 | 1 | R1:probe | 2/2 |
| 03-cart-two-mugs | 3 | 5 | R1:a11y+probe, R2:a11y+probe, R3:url | 2/2 |
| 04-remove-red-mug | 2 | 3 | R1:probe+a11y, R2:probe | 3/3 |
| 05-set-quantity | 1 | 2 | R1:probe+a11y | 2/2 |
| 06-cart-total | 4 | 4 | R1:probe+a11y, R2:probe, R3:probe, R4:url | 2/2 |
| 07-express-order | 5 | 6 | R1:network+probe, R2:probe, R3:url+a11y, R4:probe, R5:probe | 4/4 |
| 08-delivery-date | 3 | 5 | R1:text, R2:network+probe, R3:network+probe | 3/3 |
| 09-gift-wrap | 2 | 4 | R1:probe+network, R2:network+probe | 3/3 |
| 10-dark-german | 2 | 2 | R1:storage, R2:storage | 3/3 |

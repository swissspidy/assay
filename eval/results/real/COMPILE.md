# Compiled real-app check sets

Each task was compiled from its instruction and its scripted correct runs: `reference`, plus `reference-<route>` where the task has a second UI route (ADR 0011). All other runs are held out. Stress: valid variants accepted and near-miss mutants rejected (ADR 0003) on the references. Requirements marked † have only route evidence (requests or the URL; ADR 0011).

| App | Task | References | Requirements | Checks | Evidence per requirement | Stress | Held-out runs correct | Compile cost |
|---|---|---|---|---|---|---|---|---|
| gitea | g01-create-issue | 1 | 3 | 3 | R1:probe, R2:probe, R3:probe | 10/10 valid, 37/37 mutants | 4/4 | $0.179 |
| gitea | g02-close-issue | 2 | 1 | 1 | R1:probe | 20/20 valid, 10/10 mutants | 4/4 | $0.147 |
| gitea | g03-comment | 1 | 1 | 1 | R1:probe | 10/10 valid, 4/4 mutants | 4/4 | $0.153 |
| gitea | g04-assign | 1 | 1 | 1 | R1:probe | 10/10 valid, 5/5 mutants | 4/4 | $0.147 |
| gitea | g05-milestone | 1 | 2 | 2 | R1:probe, R2:probe | 10/10 valid, 4/4 mutants | 4/4 | $0.141 |
| gitea | g06-relabel | 1 | 2 | 3 | R1:probe, R2:probe | 10/10 valid, 4/4 mutants; untested: r1-other-labels-kept | 4/4 | $0.182 |
| gitea | g07-star | 1 | 1 | 2 | R1:probe | 11/11 valid, 10/10 mutants | 4/4 | $0.138 |
| gitea | g08-new-repo | 1 | 3 | 4 | R1:probe, R2:probe, R3:probe+network | 11/11 valid, 11/11 mutants | 4/4 | $0.170 |
| gitea | g09-filter-bugs | 1 | 3 | 6 | R1:url+a11y, R2:url+a11y, R3:url+a11y | 9/9 valid, 7/7 mutants; untested: r2-no-closed-issues, r3-no-nonbug-issues | 4/4 | $0.203 |
| gitea | g10-reopen-milestone | 1 | 2 | 2 | R1:probe, R2:probe | 10/10 valid, 4/4 mutants | 4/4 | $0.140 |
| gitea | g11-repo-description | 1 | 1 | 1 | R1:probe | 12/12 valid, 4/4 mutants | 4/4 | $0.145 |
| gitea | g12-answer-and-close | 1 | 2 | 2 | R1:probe, R2:probe | 10/10 valid, 3/3 mutants | 4/4 | $0.142 |
| gitea | g13-assign-open-bugs | 1 | 1 | 2 | R1:probe | 10/10 valid, 15/15 mutants | 4/4 | $0.177 |
| gitea | g14-move-milestone | 1 | 2 | 2 | R1:probe, R2:probe | 10/10 valid, 15/15 mutants | 4/4 | $0.164 |
| wordpress | w01-publish-draft | 2 | 1 | 1 | R1:probe | 22/22 valid, 4/4 mutants | 4/4 | $0.146 |
| wordpress | w02-category | 1 | 2 | 2 | R1:probe, R2:probe | 12/12 valid, 7/7 mutants | 4/4 | $0.144 |
| wordpress | w03-approve-comment | 1 | 1 | 1 | R1:probe | 12/12 valid, 4/4 mutants | 4/4 | $0.146 |
| wordpress | w04-spam-comment | 1 | 1 | 1 | R1:probe | 12/12 valid, 2/2 mutants | 4/4 | $0.144 |
| wordpress | w05-site-title | 1 | 1 | 1 | R1:probe | 11/11 valid, 1/1 mutants | 4/4 | $0.132 |
| wordpress | w06-new-post | 1 | 4 | 4 | R1:probe, R2:probe, R3:probe, R4:probe | 11/11 valid, 5/5 mutants | 4/4 | $0.187 |
| wordpress | w07-trash-post | 2 | 1 | 1 | R1:probe | 24/24 valid, 6/6 mutants | 4/4 | $0.147 |
| wordpress | w08-recategorize | 1 | 3 | 3 | R1:probe, R2:probe, R3:probe | 12/12 valid, 17/17 mutants | 4/4 | $0.177 |
| wordpress | w09-new-user | 1 | 3 | 3 | R1:probe, R2:probe, R3:probe | 12/12 valid, 7/7 mutants | 4/4 | $0.148 |
| wordpress | w10-add-tag | 2 | 1 | 2 | R1:probe | 23/23 valid, 22/22 mutants | 4/4 | $0.142 |
| wordpress | w11-posts-per-page | 1 | 1 | 1 | R1:probe | 11/11 valid, 3/3 mutants | 4/4 | $0.134 |
| wordpress | w12-filter-drafts | 1 | 1 | 3 | R1:url+a11y | 12/12 valid, 14/14 mutants; weak: rows-are-drafts | 4/4 | $0.209 |
| wordpress | w13-reply-comment | 2 | 2 | 3 | R1:probe+network, R2:probe | 23/23 valid, 8/8 mutants | 4/4 | $0.217 |
| wordpress | w14-community-category | 1 | 3 | 3 | R1:probe, R2:probe, R3:probe | 12/12 valid, 19/19 mutants | 4/4 | $0.214 |
| wordpress | w15-schedule-post | 2 | 2 | 2 | R1:probe, R2:network† | 22/22 valid, 4/4 mutants | 4/4 | $0.220 |
| prestashop | s01-add-cushions | 1 | 1 | 2 | R1:probe | 11/11 valid, 4/4 mutants | 4/4 | $0.192 |
| prestashop | s02-tshirt-variant | 1 | 3 | 3 | R1:probe, R2:probe, R3:probe | 11/11 valid, 6/6 mutants | 4/4 | $0.173 |
| prestashop | s03-remove-poster | 1 | 2 | 2 | R1:probe, R2:probe | 11/11 valid, 19/19 mutants; untested: R1-no-poster-in-cart | 5/5 | $0.164 |
| prestashop | s04-checkout | 1 | 4 | 4 | R1:probe, R2:probe, R3:probe, R4:probe | 13/13 valid, 4/4 mutants | 4/4 | $0.277 |
| prestashop | s05-new-address | 1 | 8 | 8 | R1:probe, R2:probe, R3:probe, R4:probe, R5:probe, R6:probe, R7:probe, R8:probe | 11/11 valid, 37/37 mutants | 4/4 | $0.185 |
| prestashop | s06-wishlist | 1 | 1 | 2 | R1:probe | 11/11 valid, 1/1 mutants; untested: wishlist-kept-others | 4/4 | $0.142 |
| prestashop | s07-newsletter-off | 1 | 1 | 1 | R1:probe | 11/11 valid, 2/2 mutants | 4/4 | $0.147 |
| prestashop | s08-mugs-by-price | 1 | 2 | 3 | R1:url+a11y, R2:url+a11y | 10/10 valid, 16/17 mutants; weak: r1-mugs-listed | 4/4 | $0.203 |
| prestashop | s09-mug-quantity | 2 | 1 | 1 | R1:probe | 22/22 valid, 10/10 mutants | 4/4 | $0.158 |
| prestashop | s10-voucher | 1 | 1 | 1 | R1:probe | 11/11 valid, 2/2 mutants | 4/4 | $0.139 |
| prestashop | s11-admin-price | 1 | 1 | 1 | R1:probe | 10/10 valid, 6/6 mutants | 4/4 | $0.154 |
| prestashop | s12-admin-order-shipped | 1 | 1 | 1 | R1:probe | 11/11 valid, 4/4 mutants | 4/4 | $0.139 |
| prestashop | s13-all-posters | 1 | 2 | 3 | R1:probe, R2:probe | 11/11 valid, 15/15 mutants; untested: r2-quantity-one | 4/4 | $0.215 |
| prestashop | s14-address-phone | 1 | 1 | 1 | R1:probe | 11/11 valid, 4/4 mutants | 4/4 | $0.169 |
| prestashop | s15-admin-cart-rule | 1 | 3 | 3 | R1:network†, R2:network†, R3:network† | 11/11 valid, 10/10 mutants | 4/4 | $0.244 |

Compiled 44/44 tasks; model cost as recorded: $7.44.

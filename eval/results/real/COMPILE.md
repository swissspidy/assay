# Compiled real-app check sets

Each task was compiled from its instruction and one scripted correct run (`reference`); all other runs are held out. Stress: valid variants accepted and near-miss mutants rejected (ADR 0003) on the reference.

| App | Task | Requirements | Checks | Evidence per requirement | Stress | Held-out runs correct | Compile cost |
|---|---|---|---|---|---|---|---|
| gitea | g01-create-issue | 3 | 5 | R1:probe+network, R2:probe, R3:probe | 10/10 valid, 6/6 mutants | 4/4 | $0.151 |
| gitea | g02-close-issue | 1 | 1 | R1:probe | 10/10 valid, 1/1 mutants | 4/4 | $0.134 |
| gitea | g03-comment | 1 | 1 | R1:probe+network | 10/10 valid, 6/6 mutants | 4/4 | $0.142 |
| gitea | g04-assign | 1 | 1 | R1:probe | 10/10 valid, 1/1 mutants | 4/4 | $0.129 |
| gitea | g05-milestone | 2 | 2 | R1:probe, R2:probe | 10/10 valid, 4/4 mutants | 4/4 | $0.128 |
| gitea | g06-relabel | 2 | 2 | R1:probe, R2:probe | 10/10 valid, 2/2 mutants | 4/4 | $0.150 |
| gitea | g07-star | 1 | 1 | R1:probe | 11/11 valid, 2/2 mutants | 4/4 | $0.119 |
| gitea | g08-new-repo | 3 | 3 | R1:probe, R2:probe, R3:probe | 11/11 valid, 6/6 mutants | 4/4 | $0.139 |
| gitea | g09-filter-bugs | 3 | 5 | R1:url, R2:url+a11y, R3:url+a11y | 9/9 valid, 10/10 mutants | 4/4 | $0.220 |
| gitea | g10-reopen-milestone | 2 | 2 | R1:probe, R2:probe | 10/10 valid, 2/2 mutants | 4/4 | $0.124 |
| gitea | g11-repo-description | 1 | 1 | R1:probe | 12/12 valid, 2/2 mutants | 4/4 | $0.128 |
| gitea | g12-answer-and-close | 2 | 2 | R1:probe, R2:probe | 10/10 valid, 4/4 mutants | 4/4 | $0.131 |
| gitea | g13-assign-open-bugs | 1 | 2 | R1:probe | 10/10 valid, 9/9 mutants; untested: R1-no-unassigned-open-bugs-left | 4/4 | $0.203 |
| gitea | g14-move-milestone | 2 | 2 | R1:probe, R2:probe | 10/10 valid, 11/11 mutants | 4/4 | $0.165 |
| wordpress | w01-publish-draft | 1 | 2 | R1:probe | 12/12 valid, 8/8 mutants | 4/4 | $0.144 |
| wordpress | w02-category | 2 | 2 | R1:probe, R2:probe | 12/12 valid, 4/4 mutants | 4/4 | $0.125 |
| wordpress | w03-approve-comment | 1 | 1 | R1:probe | 12/12 valid, 4/4 mutants | 4/4 | $0.128 |
| wordpress | w04-spam-comment | 1 | 1 | R1:probe | 12/12 valid, 1/1 mutants | 4/4 | $0.144 |
| wordpress | w05-site-title | 1 | 1 | R1:probe | 11/11 valid, 1/1 mutants | 4/4 | $0.118 |
| wordpress | w06-new-post | 4 | 4 | R1:probe, R2:probe, R3:probe, R4:probe | 11/11 valid, 5/5 mutants | 4/4 | $0.163 |
| wordpress | w07-trash-post | 1 | 1 | R1:probe | 12/12 valid, 1/1 mutants | 4/4 | $0.131 |
| wordpress | w08-recategorize | 3 | 3 | R1:probe, R2:probe, R3:probe | 12/12 valid, 10/10 mutants | 4/4 | $0.166 |
| wordpress | w09-new-user | 3 | 3 | R1:probe, R2:probe, R3:probe | 12/12 valid, 6/6 mutants | 4/4 | $0.131 |
| wordpress | w10-add-tag | 1 | 1 | R1:probe | 12/12 valid, 1/1 mutants | 3/4 (wrong: perturbed-replaced-tags) | $0.119 |
| wordpress | w11-posts-per-page | 1 | 1 | R1:probe | 11/11 valid, 3/3 mutants | 4/4 | $0.128 |
| wordpress | w12-filter-drafts | 1 | 3 | R1:url+a11y | 12/12 valid, 9/9 mutants; untested: r1-no-published-listed | 4/4 | $0.199 |
| wordpress | w13-reply-comment | 2 | 4 | R1:network+probe, R2:network+probe | 12/12 valid, 18/18 mutants | 3/4 (wrong: agent-haiku-1) | $0.154 |
| wordpress | w14-community-category | 3 | 3 | R1:probe, R2:probe, R3:probe | 12/12 valid, 20/20 mutants; weak: events-posts-keep-events | 4/4 | $0.191 |
| wordpress | w15-schedule-post | 2 | 2 | R1:probe, R2:network+a11y | 12/12 valid, 2/2 mutants | 1/4 (wrong: agent-haiku-1, agent-haiku-2, agent-sonnet-1) | $0.189 |
| prestashop | s01-add-cushions | 1 | 1 | R1:probe | 11/11 valid, 2/2 mutants | 4/4 | $0.142 |
| prestashop | s02-tshirt-variant | 3 | 3 | R1:probe, R2:probe, R3:probe | 11/11 valid, 6/6 mutants | 4/4 | $0.138 |
| prestashop | s03-remove-poster | 2 | 2 | R1:probe, R2:probe | 11/11 valid, 15/15 mutants | 5/5 | $0.151 |
| prestashop | s04-checkout | 4 | 7 | R1:probe+network, R2:probe, R3:probe, R4:probe+network | 12/12 valid, 8/8 mutants; untested: R1-cart-emptied | 4/4 | $0.268 |
| prestashop | s05-new-address | 8 | 8 | R1:probe, R2:probe, R3:probe, R4:probe, R5:probe, R6:probe, R7:probe, R8:probe | 11/11 valid, 29/29 mutants | 4/4 | $0.243 |
| prestashop | s06-wishlist | 1 | 1 | R1:probe | 11/11 valid, 1/1 mutants | 4/4 | $0.122 |
| prestashop | s07-newsletter-off | 1 | 1 | R1:probe | 11/11 valid, 1/1 mutants | 4/4 | $0.120 |
| prestashop | s08-mugs-by-price | 2 | 4 | R1:url+a11y, R2:url+a11y | 10/10 valid, 6/8 mutants; weak: R1-mug-products-listed | 4/4 | $0.164 |
| prestashop | s09-mug-quantity | 1 | 1 | R1:probe | 11/11 valid, 3/3 mutants | 4/4 | $0.126 |
| prestashop | s10-voucher | 1 | 1 | R1:probe | 11/11 valid, 2/2 mutants | 4/4 | $0.122 |
| prestashop | s11-admin-price | 1 | 1 | R1:probe | 10/10 valid, 1/1 mutants | 4/4 | $0.125 |
| prestashop | s12-admin-order-shipped | 1 | 1 | R1:probe | 11/11 valid, 3/3 mutants | 4/4 | $0.142 |
| prestashop | s13-all-posters | 2 | 2 | R1:probe, R2:probe | 11/11 valid, 15/15 mutants | 4/4 | $0.186 |
| prestashop | s14-address-phone | 1 | 1 | R1:probe | 11/11 valid, 2/2 mutants | 4/4 | $0.137 |
| prestashop | s15-admin-cart-rule | 3 | 4 | R1:network+a11y, R2:network, R3:network | 11/11 valid, 20/20 mutants | 4/4 | $0.186 |

Compiled 44/44 tasks; model cost as recorded: $6.67.

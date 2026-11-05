# Evaluation: compiled checks vs. model baselines

Generated 2026-11-05T13:19:56.459Z · dataset: **real apps** (ADR 0009) · check sets: **compiled** · 177 labelled runs over 44 tasks (129 correct, 48 incorrect) in 3 apps.

Positive = the run really completed the task. TPR = correct runs judged success; TNR = incorrect runs judged not success (an abstain counts as not success). The agent always reports success, as agents usually do.

| System | Balanced accuracy | TPR | TNR | Abstain rate | Cost / run | Latency (median / p95) |
|---|---|---|---|---|---|---|
| checks | 0.974 | 0.969 | 0.979 | 0.017 | $0.0000 | 1.3 ms / 6.3 ms |
| checks+escalation | 0.986 | 0.992 | 0.979 | 0.000 | $0.0007 | 749 µs / 3.7 ms (174 of 177 runs timed) |
| llm-judge | 0.942 | 0.946 | 0.938 | 0.000 | $0.0238 | n/a (replayed) / n/a (replayed) (0 of 177 runs timed) |
| agentic-verifier | 0.990 | 1.000 | 0.979 | 0.000 | $0.0467 | n/a (replayed) / n/a (replayed) (0 of 177 runs timed) |

## Correct verdicts by run kind

| Kind | Runs | checks | checks+escalation | llm-judge | agentic-verifier |
|---|---|---|---|---|---|
| agent: correct | 129 | 125/129 | 128/129 | 122/129 | 129/129 |
| perturbed: wrong-item | 29 | 29/29 | 29/29 | 28/29 | 29/29 |
| perturbed: partial | 13 | 13/13 | 13/13 | 13/13 | 13/13 |
| perturbed: over-completion | 2 | 1/2 | 1/2 | 0/2 | 1/2 |
| agent: incorrect | 3 | 3/3 | 3/3 | 3/3 | 3/3 |
| perturbed: no-op | 1 | 1/1 | 1/1 | 1/1 | 1/1 |

## Notes

- **checks+escalation** used anthropic:claude-opus-5-5@high (replay).
- **llm-judge** used anthropic:claude-opus-5-5@high (replay).
- **agentic-verifier** used anthropic:claude-opus-5-5@high (replay).
- Compiled check sets: each was compiled from one correct run per task. Those 44 runs are left out for every system, so all scored runs are held out.
- The LLM judge is shown the agent's report, as typical LLM judges are; Assay's checks never see it, and the agentic verifier gets it marked as context, not evidence.
- Model latency is only measured when recording; replayed runs show none.
- Checks-only latency is in-process evaluation of a captured snapshot (no model). Capture itself takes about 20-60 ms per page and is shared by every system.
- The LLM judge sees the final page as an accessibility outline plus visible text (no screenshots, no network or backend access).
- The agentic verifier explores the captured snapshot (accessibility tree, network log, storage, probe results) without live access.
- Checks wrong on: wordpress/w10-add-tag/perturbed-replaced-tags (success), wordpress/w13-reply-comment/agent-haiku-1 (fail), wordpress/w15-schedule-post/agent-haiku-1 (abstain), wordpress/w15-schedule-post/agent-haiku-2 (abstain), wordpress/w15-schedule-post/agent-sonnet-1 (abstain).

## Misjudged runs

### checks (5)

| Run | Kind | Label (oracle) | Verdict | Why |
|---|---|---|---|---|
| wordpress/w10-add-tag/perturbed-replaced-tags | perturbed: over-completion | fail: tags are [testing] | success | all hard requirements passed |
| wordpress/w13-reply-comment/agent-haiku-1 | agent: correct | success: replied to Priya | fail | R1 fail: r1-reply-request fail: 0 request(s) match POST, path /wp-admin/admin-ajax.php, status at least 200 and fewer than 300, request body matching schema (expected at least 1) \| R2 fail: r2-reply-text-request fail: 0 request(s) match POST, path /wp-admin/admin-ajax.php, status at least 200 and fewer than 300, request body matching schema (expected at least 1) |
| wordpress/w15-schedule-post/agent-haiku-1 | agent: correct | success: scheduled for 2027-01-05 09:00 | abstain | R2 abstain: r2-date-0905 abstain (subcheck_abstained): anyOf: [abstain] no request matches POST, request body matching schema \| [abstain] Anchor not found: row named containing "“Roadmap 2027” (Edit)" within table |
| wordpress/w15-schedule-post/agent-haiku-2 | agent: correct | success: scheduled for 2027-01-05 09:00 | abstain | R2 abstain: r2-date-0905 abstain (subcheck_abstained): anyOf: [abstain] no request matches POST, request body matching schema \| [abstain] Anchor not found: row named containing "“Roadmap 2027” (Edit)" within table |
| wordpress/w15-schedule-post/agent-sonnet-1 | agent: correct | success: scheduled for 2027-01-05 09:00 | abstain | R2 abstain: r2-date-0905 abstain (subcheck_abstained): anyOf: [abstain] no request matches POST, request body matching schema \| [abstain] Anchor not found: row named containing "“Roadmap 2027” (Edit)" within table |

### checks+escalation (2)

| Run | Kind | Label (oracle) | Verdict | Why |
|---|---|---|---|---|
| wordpress/w10-add-tag/perturbed-replaced-tags | perturbed: over-completion | fail: tags are [testing] | success | all hard requirements passed |
| wordpress/w13-reply-comment/agent-haiku-1 | agent: correct | success: replied to Priya | fail | R1 fail: r1-reply-request fail: 0 request(s) match POST, path /wp-admin/admin-ajax.php, status at least 200 and fewer than 300, request body matching schema (expected at least 1) \| R2 fail: r2-reply-text-request fail: 0 request(s) match POST, path /wp-admin/admin-ajax.php, status at least 200 and fewer than 300, request body matching schema (expected at least 1) |

### llm-judge (10)

| Run | Kind | Label (oracle) | Verdict | Why |
|---|---|---|---|---|
| gitea/g13-assign-open-bugs/agent-haiku-1 | agent: correct | success: all five open unassigned bugs assigned to dave | fail | The final page shows only issue #1, "Crash when uploading empty file", which has the bug label and was just assigned to dave by alice. The task covers every open, unassigned bug in acme/webapp, and the repo has 12 open issues. Nothing on this page shows whether other open bugs exist or whether they were assigned to dave. The agent's report ("I completed the task as requested") is generic and does… |
| gitea/g13-assign-open-bugs/agent-haiku-2 | agent: correct | success: all five open unassigned bugs assigned to dave | fail | The final page only shows open issues filtered to assignee=dave: five open bug issues (#12, #10, #4, #3, #1), each with only dave as assignee. That doesn't show the task was done correctly. The repo has 12 open issues, and the agent never displayed a view of open bugs with no assignee (e.g., labels=1 with assignee=-1) to confirm that none are left unassigned. From this page alone, we also can't t… |
| gitea/g14-move-milestone/agent-haiku-1 | agent: correct | success: v1.2 holds the open v1.1 issues | fail | The final page shows that milestone "v1.2" exists (milestone id 3) in acme/webapp. It has 2 open issues, #7 "Upgrade to Node 24" and #2 "Add CSV export", and 0 closed issues. So the milestone was created and at least some issues were moved into it. The task, though, asks for every open v1.1 issue to be moved, and nothing on the page shows that v1.1 now has zero open issues. The page never shows v… |
| gitea/g14-move-milestone/agent-haiku-2 | agent: correct | success: v1.2 holds the open v1.1 issues | fail | The final page shows that milestone "v1.2" (milestone 3) exists in acme/webapp. It has 2 open issues (#7 "Upgrade to Node 24" and #2 "Add CSV export") and 0 closed issues, so the milestone was created and no closed issues were moved into it. But the page doesn't show milestone v1.1, so there's no proof that these two issues came from v1.1 or that v1.1 now has no open issues left. The repo has 12 … |
| prestashop/s03-remove-poster/perturbed-poster-and-notebook | perturbed: over-completion | fail: cart is [1x Brown bear notebook; 1x Mug The best is yet to come] | success | The final cart page has two products: "Mug The best is yet to come" (qty 1, €11.90) and "Brown bear notebook" (Ruled, qty 1, €12.90). The total is €24.80 and the header reads Cart (2). No poster is in the cart, so the poster was removed. The other items are still there with plausible quantities, and nothing suggests anything else was deleted or changed. The page doesn't show the cart's starting c… |
| prestashop/s14-address-phone/agent-haiku-1 | agent: correct | success: phone updated | fail | The final page is still the "Update your address" form for "My address" (id_address=7), and its Phone field shows 305-555-0199. That proves the value was typed into the form, not that it was saved. When a PrestaShop address update succeeds, the store normally redirects to the Addresses list and shows an "Address successfully updated" message. Neither appears here. Nothing else on the page shows t… |
| prestashop/s15-admin-cart-rule/agent-haiku-2 | agent: correct | success: 15% order discount WINTER15 | fail | The final page shows a "Successful creation" message, and the Cart Rules list now has a new rule (ID 2) named WINTER15 with code WINTER15. That covers the code part of the task. The page does not show the discount itself, though. The list has no column for discount type or value, and nothing visible confirms that the rule takes 15 percent off the whole order, rather than a fixed amount, free ship… |
| prestashop/s15-admin-cart-rule/agent-sonnet-1 | agent: correct | success: 15% order discount WINTER15 | fail | The final page shows a "Successful creation" message, and the Cart Rules list now has a new rule (ID 2) with the name WINTER15 and the code WINTER15. So the code exists. The core of the task, though, is that it gives 15% off the whole order, and nothing on the page confirms that. The list doesn't show the discount type or value, and the agent didn't open the rule's Actions tab to check it. Presta… |
| prestashop/s15-admin-cart-rule/perturbed-5-percent | perturbed: wrong-item | fail: percent is 5.00 | success | The final page is the Cart Rules list showing the "Successful creation" message for new cart rule ID 2. The rule is named "Winter 15% off" and has code WINTER15, so the code was created in the back office. The list doesn't show the discount action, so I couldn't directly confirm a 15% reduction on the whole order. Still, the rule's name says "15% off", and PrestaShop won't save a cart rule unless… |
| wordpress/w10-add-tag/perturbed-replaced-tags | perturbed: over-completion | fail: tags are [testing] | success | The final Posts list shows the post "Flaky tests and how to avoid them" with the tag "testing" in its Tags column, so the task's outcome is met. The post is still Published, still in the Tutorials category, and its comments look intact. No other post has gained a "testing" tag, and the other tags ("community" on the Events posts, "release" on the release notes) look consistent and plausible, so t… |

### agentic-verifier (1)

| Run | Kind | Label (oracle) | Verdict | Why |
|---|---|---|---|---|
| wordpress/w10-add-tag/perturbed-replaced-tags | perturbed: over-completion | fail: tags are [testing] | success | R1 pass: The agent sent a Quick Edit inline-save for post_ID 6 ("Flaky tests and how to avoid them") with tax_input[post_tag]="testing". The server's response row includes the tag-testing class (observation 4). The post-task probe shows that post 6 now has tags ["testing"], and its category (Tutorials) and publish status are still the same (observation 1). |

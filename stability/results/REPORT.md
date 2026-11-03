# Stability run

Generated 2026-11-03T01:46:26.476Z · check sets: **handwritten** · 123 scenarios per UI variant.

| UI variant | Correct verdict | Abstain (escalates) | Broken (wrong verdict) | Runs with anchor drift |
| ---------- | --------------- | ------------------- | ---------------------- | ---------------------- |
| baseline   | 123/123         | 0                   | 0                      | 0                      |
| redesign   | 116/123         | 7                   | 0                      | 11                     |

## Per task (redesign)

| App           | Task                    | Correct | Abstain | Broken | Drift |
| ------------- | ----------------------- | ------- | ------- | ------ | ----- |
| tiny-shop     | 01-newsletter           | 2/4     | 2       | 0      | 0     |
| tiny-shop     | 02-add-blue-mug         | 3/3     | 0       | 0      | 0     |
| tiny-shop     | 03-cart-two-mugs        | 3/3     | 0       | 0      | 3     |
| tiny-shop     | 04-remove-red-mug       | 2/4     | 2       | 0      | 0     |
| tiny-shop     | 05-set-quantity         | 3/3     | 0       | 0      | 0     |
| tiny-shop     | 06-cart-total           | 3/3     | 0       | 0      | 3     |
| tiny-shop     | 07-express-order        | 5/5     | 0       | 0      | 0     |
| tiny-shop     | 08-delivery-date        | 1/4     | 3       | 0      | 0     |
| tiny-shop     | 09-gift-wrap            | 4/4     | 0       | 0      | 0     |
| tiny-shop     | 10-dark-german          | 4/4     | 0       | 0      | 0     |
| tiny-tracker  | 01-create-bug           | 5/5     | 0       | 0      | 0     |
| tiny-tracker  | 02-create-high-priority | 4/4     | 0       | 0      | 0     |
| tiny-tracker  | 03-close-issue          | 5/5     | 0       | 0      | 0     |
| tiny-tracker  | 04-reopen-issue         | 4/4     | 0       | 0      | 0     |
| tiny-tracker  | 05-assign-bob           | 4/4     | 0       | 0      | 0     |
| tiny-tracker  | 06-add-feature-label    | 4/4     | 0       | 0      | 0     |
| tiny-tracker  | 07-comment              | 5/5     | 0       | 0      | 0     |
| tiny-tracker  | 08-rename               | 4/4     | 0       | 0      | 0     |
| tiny-tracker  | 09-unassign             | 4/4     | 0       | 0      | 0     |
| tiny-tracker  | 10-filter-open-bugs     | 5/5     | 0       | 0      | 5     |
| tiny-calendar | 01-lunch                | 5/5     | 0       | 0      | 0     |
| tiny-calendar | 02-reminder             | 4/4     | 0       | 0      | 0     |
| tiny-calendar | 03-rsvp                 | 4/4     | 0       | 0      | 0     |
| tiny-calendar | 04-move-dentist         | 4/4     | 0       | 0      | 0     |
| tiny-calendar | 05-delete-standup       | 5/5     | 0       | 0      | 0     |
| tiny-calendar | 06-location             | 4/4     | 0       | 0      | 0     |
| tiny-calendar | 07-timezone             | 4/4     | 0       | 0      | 0     |
| tiny-calendar | 08-week-start           | 4/4     | 0       | 0      | 0     |
| tiny-calendar | 09-rename-dentist       | 4/4     | 0       | 0      | 0     |
| tiny-calendar | 10-workshop             | 4/4     | 0       | 0      | 0     |

## Not correct

- redesign tiny-shop/01-newsletter/subscribed: expected success, got abstain
- redesign tiny-shop/01-newsletter/subscribed-and-dark-theme: expected success, got abstain
- redesign tiny-shop/04-remove-red-mug/removed-red-mug: expected success, got abstain
- redesign tiny-shop/04-remove-red-mug/removed-red-mug-keeping-teapot: expected success, got abstain
- redesign tiny-shop/08-delivery-date/express-order: expected success, got abstain
- redesign tiny-shop/08-delivery-date/express-two-items: expected success, got abstain
- redesign tiny-shop/08-delivery-date/standard-order: expected fail, got abstain

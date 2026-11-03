# Stability run

Generated 2026-11-03T22:16:03.896Z · check sets: **handwritten** (written for v1) · 123 scenarios per variant.

Correct = the expected verdict for that version. Abstain = the checks could not decide and would escalate (safe). Broken = a wrong decided verdict. Agent error = the scripted agent could not finish on that UI, so nothing was judged.

| Variant | Releases | Correct | Abstain | Broken | Agent error | Runs with anchor drift | Regression runs caught |
|---|---|---|---|---|---|---|---|
| v1 | as recorded | 123/123 | 0 | 0 | 0 | 0 | – |
| v2 | copy | 116/123 | 7 | 0 | 0 | 11 | – |
| v3 | layout | 116/123 | 7 | 0 | 0 | 11 | – |
| v4 | api | 116/123 | 7 | 0 | 0 | 11 | – |
| v5 | regression | 118/123 | 5 | 0 | 0 | 11 | 6/6 |
| regression | regression only (on v1) | 123/123 | 0 | 0 | 0 | 0 | 6/6 |

## Releases

- **tiny-shop**: v2 copy: Renamed labels and headings: Cart becomes Shopping basket, Place order becomes Buy now, new newsletter and delivery wording. v3 layout: Extra wrapper around the content and a recommendations panel that lists products and prices outside the main content. v4 api: Every record in API responses gains updatedAt and etag fields. v5 regression: Bug: saving settings echoes the newsletter choice but does not store it.
- **tiny-tracker**: v2 copy: Renamed headings and buttons: Issues becomes All issues, Close issue becomes Resolve, Save labels becomes Apply labels. v3 layout: Extra wrapper around the content and a panel of recently viewed issues outside the main content. v4 api: Every record in API responses gains updatedAt and etag fields. v5 regression: Bug: saving labels silently drops the feature label.
- **tiny-calendar**: v2 copy: Renamed headings and buttons: Upcoming events becomes Your schedule, Save changes becomes Update event. v3 layout: British date format (en-GB), an extra wrapper and a panel of suggested events outside the main content. v4 api: Every record in API responses gains updatedAt and etag fields. v5 regression: Bug: creating an event echoes the reminder in the response but does not store it.

## Per task

| Task | v1 | v2 | v3 | v4 | v5 | regression |
|---|---|---|---|---|---|---|
| tiny-shop/01-newsletter | 4/4 | 2/4 (2 abstain) | 2/4 (2 abstain) | 2/4 (2 abstain) | 4/4 | 4/4 |
| tiny-shop/02-add-blue-mug | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| tiny-shop/03-cart-two-mugs | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| tiny-shop/04-remove-red-mug | 4/4 | 2/4 (2 abstain) | 2/4 (2 abstain) | 2/4 (2 abstain) | 2/4 (2 abstain) | 4/4 |
| tiny-shop/05-set-quantity | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| tiny-shop/06-cart-total | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| tiny-shop/07-express-order | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| tiny-shop/08-delivery-date | 4/4 | 1/4 (3 abstain) | 1/4 (3 abstain) | 1/4 (3 abstain) | 1/4 (3 abstain) | 4/4 |
| tiny-shop/09-gift-wrap | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |
| tiny-shop/10-dark-german | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |
| tiny-tracker/01-create-bug | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| tiny-tracker/02-create-high-priority | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |
| tiny-tracker/03-close-issue | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| tiny-tracker/04-reopen-issue | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |
| tiny-tracker/05-assign-bob | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |
| tiny-tracker/06-add-feature-label | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |
| tiny-tracker/07-comment | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| tiny-tracker/08-rename | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |
| tiny-tracker/09-unassign | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |
| tiny-tracker/10-filter-open-bugs | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| tiny-calendar/01-lunch | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| tiny-calendar/02-reminder | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |
| tiny-calendar/03-rsvp | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |
| tiny-calendar/04-move-dentist | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |
| tiny-calendar/05-delete-standup | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| tiny-calendar/06-location | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |
| tiny-calendar/07-timezone | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |
| tiny-calendar/08-week-start | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |
| tiny-calendar/09-rename-dentist | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |
| tiny-calendar/10-workshop | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 | 4/4 |

## Not correct

- v2 tiny-shop/01-newsletter/subscribed: expected success, got abstain
- v2 tiny-shop/01-newsletter/subscribed-and-dark-theme: expected success, got abstain
- v2 tiny-shop/04-remove-red-mug/removed-red-mug: expected success, got abstain
- v2 tiny-shop/04-remove-red-mug/removed-red-mug-keeping-teapot: expected success, got abstain
- v2 tiny-shop/08-delivery-date/express-order: expected success, got abstain
- v2 tiny-shop/08-delivery-date/express-two-items: expected success, got abstain
- v2 tiny-shop/08-delivery-date/standard-order: expected fail, got abstain
- v3 tiny-shop/01-newsletter/subscribed: expected success, got abstain
- v3 tiny-shop/01-newsletter/subscribed-and-dark-theme: expected success, got abstain
- v3 tiny-shop/04-remove-red-mug/removed-red-mug: expected success, got abstain
- v3 tiny-shop/04-remove-red-mug/removed-red-mug-keeping-teapot: expected success, got abstain
- v3 tiny-shop/08-delivery-date/express-order: expected success, got abstain
- v3 tiny-shop/08-delivery-date/express-two-items: expected success, got abstain
- v3 tiny-shop/08-delivery-date/standard-order: expected fail, got abstain
- v4 tiny-shop/01-newsletter/subscribed: expected success, got abstain
- v4 tiny-shop/01-newsletter/subscribed-and-dark-theme: expected success, got abstain
- v4 tiny-shop/04-remove-red-mug/removed-red-mug: expected success, got abstain
- v4 tiny-shop/04-remove-red-mug/removed-red-mug-keeping-teapot: expected success, got abstain
- v4 tiny-shop/08-delivery-date/express-order: expected success, got abstain
- v4 tiny-shop/08-delivery-date/express-two-items: expected success, got abstain
- v4 tiny-shop/08-delivery-date/standard-order: expected fail, got abstain
- v5 tiny-shop/04-remove-red-mug/removed-red-mug: expected success, got abstain
- v5 tiny-shop/04-remove-red-mug/removed-red-mug-keeping-teapot: expected success, got abstain
- v5 tiny-shop/08-delivery-date/express-order: expected success, got abstain
- v5 tiny-shop/08-delivery-date/express-two-items: expected success, got abstain
- v5 tiny-shop/08-delivery-date/standard-order: expected fail, got abstain

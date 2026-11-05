# ADR 0012: Frames, open pages and form bodies in snapshots

- Status: Accepted
- Date: 2026-11-05
- Scope: snapshot capture and format (`assay.snapshot/v1`), check DSL (`page`), runtime, stress
  testing, compiler prompt

## Context

ADR 0001 limited snapshots to the main frame of one page and parsed only JSON and URL-encoded
request bodies. The real-app evaluation (ADR 0009) measured what that misses:

- **Iframes.** The WordPress block editor's canvas is an iframe. Capture recorded it as an empty
  `iframe` node: in all 16 runs that end in the editor, the post's title and body were missing from
  the tree and the body from the text.
- **Multipart bodies.** Gitea submits its forms as `multipart/form-data`; 26 runs carry those bodies
  as raw strings, which a `requestBody` schema cannot match field by field. Chromium also leaves an
  upload with a file out of the request's post data entirely.
- **Several pages.** A task that ends in a popup or a new tab (a receipt, an OAuth window) had only
  the page passed to `captureSnapshot`.
- **Shadow DOM** was not exercised by the three apps.

The fix had to be compatible: snapshots already stored (examples, `eval/real/runs`) must load and
evaluate exactly as before, and check sets must keep their meaning.

## Decision

### 1. Frames: content under the iframe node, transparent to locators

Capture fills each `iframe` node of the aria snapshot with the accessibility tree of its frame, same
origin or not (Playwright reads cross-origin frames), recursively up to 4 levels and 32 frames per
page:

```jsonc
{ "role": "iframe", "name": "Editor canvas", "url": "https://cms.test/canvas",
  "children": [ { "role": "textbox", "name": "Add title", "value": "Roadmap 2027" }, … ] }
```

- `name` is the iframe's accessible name (`aria-labelledby`, `aria-label`, `title`); Playwright's
  snapshot drops it. `url` is the frame document's URL (for a link, `url` stays its target). The
  WordPress canvas is a `blob:` URL, so address it by name.
- Each frame's text follows the page's in `text`, a frame before the frames inside it (`innerText`
  never includes frame content).
- **Pairing.** Frame elements are listed in CSS order (`iframe, frame`, through open shadow roots),
  and only those the tree shows are kept: Playwright itself decides, since the aria snapshot of a
  hidden element is empty. If the count differs from the tree's iframe nodes (the page changed in
  between), no frame is attached and every iframe node is marked `props.frame: "unavailable"`. So
  is a frame that cannot be read or is over the limits. An empty iframe node without the marker
  is an empty frame, or a snapshot from before this change. A `contains`, `each` or text source
  scoped to an unavailable iframe abstains (`evidence_unavailable`) instead of searching an empty
  node. The accessible name resolves `aria-labelledby` in the iframe's own root (a shadow root).
- **Form state.** Values and states inside frames come from the same aria snapshot. Playwright gives
  values only to inputs and textareas, so the text of a `role="textbox"` contenteditable element (the
  block editor's title) becomes the value of the textbox node with its name, when exactly one such
  element and one value-less node share that name.
- `captureSnapshot(page, { frames: false })` keeps the old capture.

**Addressing: transparent descent, with the iframe as an ordinary scope.** Locators, `within`,
`landmark`, scopes, records and derived text all see frame content as part of the tree, so no DSL
change was needed. A check that must stay inside one frame scopes to it:
`{"scope": {"role": "iframe", "name": "Editor canvas"}, …}` or `within` the same. The rejected
alternative was an explicit frame scope that hides frame content unless named. It would make every
existing locator ignore frames (so the WordPress checks would still need a new construct), and a
check could not say "this field, wherever the editor renders it". The cost of transparency is that
an unscoped locator now also matches inside frames: an ad frame can make an unscoped anchor
ambiguous (abstain), which is the existing advice to scope `contains` anyway, and the stress test
now checks it (§4).

### 2. Shadow DOM

Playwright's aria snapshot walks open shadow roots, with slotted content where its slot is, and
nested roots. Tests with custom elements confirm it; nothing was added. **Closed shadow roots are
not captured**: neither page scripts nor Playwright can enter them, and the component's host
element shows up without that content. What a closed component shows can only be checked through
probes and the network.

### 3. Form bodies: parsed fields, raw kept, files by metadata

`multipart/form-data` request bodies are parsed (RFC 7578) into the same object form as URL-encoded
ones: field → string, a repeated field → array in order. A file becomes
`{"filename", "type", "size"}`; its content is never stored. `requestBodyRaw` keeps the body as
sent for both form encodings, with file contents left out; checks do not read it, but records and
the verifier can. The body limit applies to the text kept, not to file content. A multipart body that
does not parse is not kept at all, since its text could hold a file's bytes; it is marked unavailable.
Truncation of the request and the response body is recorded apart (`requestBodyTruncated`,
`responseBodyTruncated`, with `bodyTruncated` set for older readers), so a cut response no longer
leaves a request body check undecided; an entry with neither reads `bodyTruncated` as before.

Chromium does not report an upload's body at all. The page tap (ADR 0001 §1) also reports the
fields of multipart `FormData` the page sends, through a form submission (`formdata` event; Chromium
fires it twice per submission, so identical reports from one form within a second count once),
`fetch` (`init.body`, or a `Request` built with one, read from a copy) or `XMLHttpRequest`. Report ids
are unique per document, so one frame's `fetch` superseding its own report never hides another's.
As for response bodies, a report only fills a request the browser
reported, and only when the multipart requests to that method and URL from that frame pair one to
one with identical reports; otherwise the body stays unavailable. A body that was sent but not read
is marked `requestBodyUnavailable` (multipart only: a POST may set a JSON content type and send no
body), and `requestBody` matching on it is `unknown` (abstain) instead
of `no` (fail). Under `onMissing: "abstain"` (ADR 0011) that stays `value_unavailable`, not
`route_missing`: the request shows the route was taken, only its body could not be read.

### 4. Open pages: the active page by default, others by a `page` assertion

`captureSnapshot` records the context's other open pages as `pages: [{url, title, a11y, text}]` (in
opening order, frames included; a page that cannot be read within 5 s in all is `unavailable`, keeping its URL and, when it could
be read, its title, so a `page` assertion that selects it by title abstains as unreadable). The
snapshot's own `page`, `a11y` and `text` describe the **active page**: the page passed in, or a
popup or tab it opened (directly or through another popup) that opened or navigated more
recently, as the recorder saw it. Pages opened with `context.newPage()` (by the test, a sign-in
helper) never take over. Without a recorder there is no activity to compare, and the page passed in
is active. `pages: false` captures that page alone, as before. Storage stays the active page's
origin; cookies are context-wide as before.

A check reads another page with one new assertion kind:

```jsonc
{
  "kind": "page",
  "match": { "url": { "path": "/receipt" }, "title": "Receipt" },
  "assert": { "kind": "state", "target": { "role": "status" }, "expect": { "text": { "contains": "Paid" } } },
}
```

- `match` takes a `UrlMatch` and/or a title `TextMatch` and selects among all open pages, the active
  one included. Selecting the page is an anchor: no page matches → `anchor_missing`, several →
  `anchor_ambiguous`, an unreadable page → `evidence_unavailable`. All abstain.
- The nested assertion reads that page's tree, text and URL. Only what a page shows may be read
  inside: the validator rejects request assertions and network, storage and probe sources there,
  `page` inside `each`, and `page` inside `page`.
- Route evidence (ADR 0011): a `url` check inside a `page` assertion is route evidence, so
  `onMissing` applies to it, and with `onMissing: "abstain"` a page the run never opened is a
  route not taken (`route_missing`) rather than a missing anchor. Inside an `anyOf` over routes it
  then gives way to the route the run took. A `page` assertion never counts as showing that
  something is missing, since a missing page abstains.
- Why a wrapper and not a `page` field on every source and target: one place selects the page, so
  an assertion cannot mix pages by accident, and every existing kind works inside unchanged. A
  presence requirement ("a receipt opened") is better checked on the network or a probe, since a
  missing page abstains.

### 5. Stress testing

- `frame:unloaded` (mutant): a captured frame that never loaded, emptied and marked unavailable,
  its text removed. Generated for checks that read the frame: their result changes, or one of their
  iframe locators matches it; an anyOf reads it only when every alternative does. A check scoped to
  the unloaded frame abstains; an absence check reaching into it through `within` is flagged weak.
  Also made on the page a `page` assertion selects. Frame text is removed by its last occurrence
  (frame text follows the page's); a frame string that is not in the frame's `innerText` but is
  in the page's can take the page's copy instead, which can only hide a weakness, not report one.
- `page` assertions: the nested assertion's mutants are made on the page it selects, plus
  `page:closed` for a page other than the active one.
- `extra-frame` and `extra-page` (valid variants): an unrelated ad frame with its own content, put
  outside existing frames on every open page whose frames were captured, and an unrelated extra tab
  of the site. A page selected by its origin alone becomes ambiguous and is
  flagged fragile.
- Parsed form fields are objects, so the existing request body schema and pointer mutants cover
  them.

The new variants and mutants apply only to snapshots with captured frames or several pages, so the
stress reports of the example apps are unchanged.

### 6. Compiler

The discovery prompt gets a short section on frames, other pages and form bodies, and the submit
tools offer the `page` assertion, only when a reference holds frame content, other pages or a
parsed form body, like the baseline section. Prompts and tool schemas for other
references are byte-identical, so recorded compiles still replay. The outline lists other open
pages after the active page's tree.

### Versioning

The schema stays `assay.snapshot/v1`, as for the baseline (ADR 0001 §1.1). Every addition is
optional and left out when empty: `pages`, an iframe node's children, `name` and `url`,
`props.frame`, `requestBodyRaw`, `requestBodyUnavailable`. A snapshot stored before this change
has none of them and evaluates exactly as before; `loadSnapshot` validates `pages` when present.
A reader that predates this change still evaluates new snapshots the same way for frames
(transparent descent needs no reader support), ignores `pages`, and rejects check sets that use
`page`, so no reader evaluates a `page` assertion as the active page. A context with one page and
no frames gives the same capture as before (verified: the example apps' tests, stress reports and
the compile, eval and real-app eval replays are unchanged).

## Consequences

- The block editor is now checkable from the page: on a WordPress 6.6 instance, a snapshot after
  typing a post holds `iframe "Editor canvas" › textbox "Add title"` with its value and the
  paragraph block, and checks scoped to the canvas pass. Gitea's form fields can be matched with
  `requestBody` schemas. Neither is re-measured on `eval/real`, whose runs were captured before
  this change and are not recaptured.
- Capture does more work on pages with frames (one aria snapshot and one evaluation per frame and
  one per frame element) and per extra open page. Pages without frames add one cheap lookup at most.
- An unscoped locator can now match inside a frame. Checks compiled for frameless pages are
  unaffected; on pages with frames, scope to a landmark or the iframe.
- The active-page rule follows observed activity. An agent that switches back to an earlier tab
  without navigating it is not seen to; such a run should be verified with `pages: false` on the
  right page, or with a `page` assertion.
- Frame pairing assumes the aria snapshot lists iframes in DOM order. `aria-owns` and slot
  reordering of iframes can break that silently; it was not observed.
- The page tap now also wraps form submission and `FormData` sends, another (transparent)
  instrumentation of the page under test.

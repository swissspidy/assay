# ADR 0009: Evaluation on real web apps

- Status: Accepted
- Date: 2026-11-05

## Context

Every result so far (ADR 0005) comes from three small first-party apps (Tiny Shop, Tiny Tracker,
Tiny Calendar) with scripted runs. Compiled checks scored 1.000 balanced accuracy there, the LLM
judge 0.906 and the agentic verifier 0.959. Those apps were written with the checks in mind:
small accessibility trees, JSON APIs that echo what they store, and runs whose mistakes were
designed. The question this ADR answers is whether compiled checks hold up on real applications,
with runs produced by an actual browser agent.

## Decision

### Apps

Three open-source apps run locally in Docker with seeded data, chosen to resemble WebArena's
targets and to start reliably in a few minutes without internet access:

| App                                                                   | Image                                                                 | Stands in for                                  | Start                                 | Reset between runs                        |
| --------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------- | ----------------------------------------- |
| Gitea 1.22.6 (forge: repositories, issues, labels, milestones)        | `gitea/gitea:1.22.6`, SQLite                                          | WebArena GitLab                                | seconds; seeded through the admin API | restore a copy of `/data`, restart (~5 s) |
| WordPress 6.6 (CMS admin, block editor, comments, users, settings)    | `wordpress:6.6-apache` + `mariadb:11.4`, WP-CLI                       | a CMS / admin panel                            | ~20 s; seeded with `wp eval-file`     | restore a database dump (~1 s)            |
| PrestaShop 8.1.7 (storefront as a customer, back office as the admin) | `prestashop/prestashop:8.1.7-apache` + `mariadb:11.4`, demo catalogue | WebArena shopping (Magento) and shopping admin | ~30 s install, then a committed image | restore a database dump (~3 s)            |

What was tried:

- Public demo sites are blocked by the network policy (`demo.opencart.com` returns 403), and they
  cannot be reset, so they could not give reproducible starting states anyway.
- Docker works in the container, and Docker Hub pulls do. GitLab CE (WebArena's forge) needs several
  GB of RAM and minutes to boot; Gitea gives the same kind of UI (issues, labels, milestones,
  assignees, repository settings) in one small container. The WebArena Magento images are tens of
  GB and hosted outside Docker Hub; they were not attempted.
- PrestaShop's installer downloads language packs from `i18n.prestashop-project.org`. The container
  has no internet, so the installer failed. The packs are fetched once on the host (that host is
  reachable through the proxy) and a pre-install script (`eval/real/apps/shop/pre-install.sh`) makes
  the installer copy them instead. Mail is switched off in the seed, since a status change otherwise
  reports a mail error.
- WordPress blocks outgoing HTTP (`WP_HTTP_BLOCK_EXTERNAL`) so the dashboard does not wait on
  feeds and update checks. The block editor's welcome guide is dismissed in the seed, as for anyone
  who has used it before.

All app code is unmodified. Only data is seeded.

### Tasks

Each app has 14–15 tasks (`eval/real/apps/<app>.ts`), each with a natural-language instruction and no
"Then" clauses (WebArena intents have none either, so the compiler derives the rubric itself). Most
are single actions (create an issue with a label, publish a draft, add two cushions to the cart).
Three per app are multi-step: answer and close an issue, assign every unassigned open bug, move a
milestone's open issues; create a category and add two posts to it, reply to a specific comment,
schedule a post; add every framed poster, edit an address, create a discount code in the back
office. One task per app is a view task ("show me the open bugs", "show me the draft posts",
"show me the mugs, cheapest first"). Four tasks start from a set-up state (a filled cart), so
baselines matter.

Every task has:

- a **scripted reference solution** in Playwright, through the UI. The compiler gets the task text
  and this one run only (`reference`), so every other run is held out;
- one or two **scripted near misses** (`perturbed-*`): the wrong item, a partial completion, an
  over-completion, a no-op;
- an **oracle** over the app's backend (SQL against the database, or the admin API), written
  before any run was labelled. It also checks "nothing else changed" where a task implies it
  (other issues keep their state, other comments their status). For view tasks the oracle reads the
  final URL. Its decision and the facts it read are stored in every run file.

`node eval/real/collect.ts <app> --check-oracles` self-tests the oracles: each must fail on the
seeded state, pass after the reference script and fail after every perturbation. All of them do.

### Runs and labels

`eval/real/collect.ts` produces every run the same way: reset the app, sign in on a fresh browser
context, attach the evidence recorder, run the task's setup, capture a baseline (always, for every
task), then the reference, a perturbation or the agent acts, and the final snapshot is captured with
the app's probes. The oracle then labels the run.

The **browser agent** (`eval/real/lib/agent.ts`) is deliberately plain: Claude through the AI SDK
adapter (ADR 0007) on Assay's own tool loop, acting by aria refs (`page.ariaSnapshot({ mode: 'ai' })`,
which includes iframes) with goto, click, fill, select, check, press, back, wait and finish. Earlier
snapshots are shortened before each request so the context stays small. It ran
`claude-sonnet-5-5` once and `claude-haiku-5-5` twice per task, both at effort `low`. Every turn is
recorded to a cassette (`eval/real/cassettes/agent/`). Those are transcripts for audit: a live app
cannot be replayed, so the evaluation replays from the stored snapshots instead.

**Probes** are the backend reads a test author would write for each app, the same set for every
task: Gitea `issues`, `issueComments`, `milestones`, `aliceRepos`, `aliceStarred` (admin API);
WordPress `posts`, `comments`, `categories`, `settings`, `users` (REST API with an application
password); PrestaShop `cart`, `orders`, `addresses`, `wishlist`, `account`, `catalog` (SQL). The
oracle reads the same backends but with task-specific predicates, which the compiler never sees.
Checks that read probes therefore read the kind of state the oracle decides on; that is how Assay is
meant to be deployed, and it is why the results report how much of the check set rests on probes.

Every label is the oracle's. No run was relabelled by hand. Two oracle conventions are judgment
calls, stated here so they can be disputed:

- **Unrequested changes fail** (as in ADR 0005): replacing a post's existing tag while adding the
  requested one (`w10/perturbed-replaced-tags`) and creating an issue with extra labels are labelled
  incorrect, although the literal request was met. One labelled run depends on this.
- **An infeasible task is a failure.** `s07-newsletter-off` cannot be done without the account
  password: PrestaShop's identity form requires it, and the agent is not given it. All three agent
  runs are labelled fail by the oracle, which is right whatever the cause. One Haiku run nonetheless
  reported "you are unsubscribed", a natural false success claim.

The view tasks' oracles read the URL. An agent that showed the same rows another way (a different
filter UI) would be labelled fail. No agent run did; all reached the URLs the oracles accept.

### Evaluation

`node scripts/eval.ts --dataset real` runs the same four systems as ADR 0005 (checks,
checks+escalation, LLM judge, agentic verifier) on every held-out run, with the same prompts,
models (`claude-opus-5-5` at effort `high`) and metrics. Cassettes are under `eval/cassettes/real/`,
results in `eval/results/real/` (`REPORT.md`, `results.json`), the compile summary in
`eval/results/real/COMPILE.md`. Run files are gzipped JSON (`eval/real/runs/<app>/<task>/<run>.json.gz`).
CI replays the evaluation keylessly in the "Stability and evaluation" job; it starts no app and no
browser.

## Results

Recorded on 2026-11-05.

### Dataset

- 44 tasks (Gitea 14, WordPress 15, PrestaShop 15) and 221 runs: 44 references (training, never
  scored), 45 scripted near misses and 132 agent runs. That leaves 177 held-out runs: 129 correct,
  48 incorrect.
- **The agents almost never failed.** Sonnet solved 43/44 tasks (5.7 turns, $0.108 per run) and
  Haiku 86/88 (7.8 turns, $0.010 per run). The three failures are all on the infeasible `s07`. The
  first 35 tasks were mostly single actions, and every agent run on them except `s07` succeeded. The 9
  multi-step tasks added after that were also all solved. So the negatives are almost entirely the
  scripted near misses (45 of 48), and the TNR below measures near misses, not agents' own mistakes.
  This is the dataset's main weakness (see Consequences).
- **Compiling:** all 44 tasks compiled from the reference alone, in two to six discovery turns,
  for $6.67 in total ($0.15 per task). The 100 checks read probes (85 `value` checks on a probe),
  requests (10), the URL (9), the accessibility tree (13) and no free text. For 39 of 44 tasks,
  every requirement has a probe check. The exceptions are the three view tasks, `w15`, and `s15`
  (there is no probe for cart rules). Stress on the references: every valid variant accepted.
  All mutants rejected except two of eight on `s08-mugs-by-price`, whose `contains` check on the
  product list is weak. One more check was flagged weak (`w14`) and three untested.

### Evaluation (177 held-out runs: 129 correct, 48 incorrect)

| System            | Balanced accuracy | TPR   | TNR   | Abstain rate | Cost / run | Latency (median / p95) |
| ----------------- | ----------------- | ----- | ----- | ------------ | ---------- | ---------------------- |
| checks            | 0.974             | 0.969 | 0.979 | 0.017        | $0         | 1.6 ms / 8.7 ms        |
| checks+escalation | 0.986             | 0.992 | 0.979 | 0.000        | $0.0007    | 1.1 ms / 5.1 ms        |
| llm-judge         | 0.942             | 0.946 | 0.938 | 0.000        | $0.0238    | 4.8 s / 9.7 s          |
| agentic-verifier  | 0.990             | 1.000 | 0.979 | 0.000        | $0.0467    | 11.3 s / 25.7 s        |

Latencies are from the live recording; replays show none. On the toy apps the order was checks
(1.000) > verifier (0.959) > judge (0.906). Here the verifier is slightly ahead of the checks: it
explores the same probes, but is not tied to one reference's path.

### Every misjudged run

**Compiled checks (5 wrong; 2 after escalation).** All five are in WordPress:

| Run                                                                  | Label   | Checks   | Cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------- | ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `w15-schedule-post/agent-sonnet-1`, `agent-haiku-1`, `agent-haiku-2` | success | abstain  | **Probe gap, plus a single reference's path.** The `posts` probe has no date field, so the compiler had no backend evidence for "January 5, 2027 at 9:00". It used the reference's Quick Edit form POST (`aa`, `mm`, `jj`, `hh`, `mn`), or as an `anyOf` fallback the post-list row ("Scheduled 2027/01/05 at 9:00 am"). All three agents scheduled through the block editor instead, which saves through the REST API (`POST /wp-json/wp/v2/posts/12` with a `date` field) and ends on the editor page, so neither branch can be read. Abstain, and escalation decided all three correctly. |
| `w13-reply-comment/agent-haiku-1`                                    | success | **fail** | **A single reference's path, with a decided failure.** The `comments` probe has no `parent` field, so "reply to Priya" is only observable in the reference's request: the admin's AJAX `replyto-comment` call. The agent replied through the public comment form on the post (`wp-comments-post.php?replytocom=6`), a valid way to do it. A request check that matches no request **fails** rather than abstains (a required request that was not sent is an observed absence), so this does not escalate under the default policy. It is the only decided false negative.                   |
| `w10-add-tag/perturbed-replaced-tags`                                | fail    | success  | **Compiler policy: no implied preservation.** The near miss replaced the seeded tag `performance` with `testing`. The rubric prompt adds a preservation requirement only when the text states one ("keep everything else"), so the only check is "the post's tags contain testing". The labelling convention (and ADR 0005's) counts the removed tag as an unrequested change. Every system except the oracle accepted this run.                                                                                                                                                             |

None of the five comes from a missing DSL construct. The fixes are a probe field (`date`,
`parent`), more than one reference path, and a decision on implied preservation. None comes from a
snapshot gap either, because the checks read probes. The gaps below exist, though; this check set
simply never depended on them.

**LLM judge (10 wrong).** Seven correct runs rejected. On `g13` and `g14` (two runs each) the final
page did not show every issue the agent had changed. On `s15` (two runs) the cart-rule list does
not show the percentage. On `s14` the final page was still the address form, though the edit was
saved. Three incorrect runs accepted: both over-completions (`s03` also lowered the notebook
quantity; `w10` replaced a tag) and `s15/perturbed-5-percent`, whose list page looks like success.
The judge sees only the final page, and real apps often do not show the outcome there.

**Agentic verifier (1 wrong):** `w10/perturbed-replaced-tags`, for the same reason as the checks: it
read the probe, saw `testing` among the tags and did not treat the removed tag as a violation.

### Snapshot gaps observed

Measured over all 221 runs (`eval/real/runs`):

- **Iframes.** The block editor's canvas is an iframe. Assay's capture (`locator('body').ariaSnapshot()`)
  records it as an empty `iframe` node: in all 16 WordPress runs that end in the editor, the post's
  title field and body are missing from the accessibility tree, and the body is missing from the
  page text. The agent's own view (`ariaSnapshot({ mode: 'ai' })`) includes the iframe. No compiled
  check needed the canvas, because the `posts` probe has the post. A deployment without that probe
  could not check the post body from the page at all.
- **Multipart bodies.** Gitea submits its forms as `multipart/form-data`. The recorder parses JSON
  and URL-encoded bodies only, so 26 Gitea runs carry such bodies as raw strings, which a
  `requestBody` schema cannot match field by field. The compiler's two Gitea request checks match on method, path and
  status only.
- **Unavailable response bodies:** 7 across all runs (the page navigated before the body was read).
  None was evidence for a check.
- No shadow DOM was involved: none of the three apps renders its UI in shadow roots.

### What it cost

Live model spend, as recorded: agent runs $5.66 (Sonnet $4.76, Haiku $0.89), compiling $6.67,
evaluation $12.60 (judge $4.21, verifier $8.26, escalation $0.12). Total about $24.9. The
evaluation replays keylessly in 2 s and gives identical verdicts and costs.

## Consequences

- **On real apps, compiled checks are good but no longer perfect: 0.974 balanced accuracy, 0.986
  with escalation.** That is still ahead of the LLM judge (0.942) at no model cost, and close to the
  verifier (0.990). Every error is in one app (WordPress), where a task can be done through two
  different UIs: the classic admin (Quick Edit, AJAX) and the block editor or the public site (REST,
  form posts). Gitea and PrestaShop have mostly one path per task.
- **What to build next, in order of evidence:**
  1. **Reference diversity.** Two of the three causes are path dependence: one scripted reference
     shows one way to do the task, and when the probes lack a field, the compiler can only check
     that path's request or page. Compiling from a second correct run on another path (or asking
     the compiler for path-independent evidence when the only evidence is a request) would have
     fixed `w13` and `w15`.
  2. **A request check that matches nothing should be able to abstain**, or escalate by default,
     when it is the only evidence for a requirement. `w13` is a decided false negative that
     escalation never sees. `onFail: "escalate"` (ADR 0004) exists, but the compiler does not set it.
  3. **Probe coverage review.** Both path-dependent cases trace back to a missing probe field. A
     compile warning for "this requirement has no probe or network evidence that is independent of
     the reference's UI path" would point the test author at the probe to extend.
  4. **Implied preservation** ("add X" keeps what is there) is a policy decision. Either the rubric
     derives it, which risks over-constraint, or the labelling convention changes. Both the
     checks and the verifier currently read "add" literally.
  5. **Snapshot coverage:** iframe content (ADR 0001's capture uses the default aria mode) and
     multipart request bodies. Neither caused an error here, because probes covered them, but both
     are blind spots for page- and network-only checks.
- **The dataset needs harder or more varied runs.** 129 of 132 agent runs were correct, so the
  48 negatives are mostly scripted near misses. Next: tasks agents actually fail (long horizons,
  ambiguous references, error recovery), several runs at higher temperature or with injected UI
  faults, and a page-only (no probes) compile, to measure checks where snapshot gaps matter.
- **Probes and oracle read the same backends.** That is the intended deployment, but it means the
  checks' agreement with the oracle partly reflects good probes. The probes were written once per
  app, before any run, and not tuned per task. Their gaps (no post date, no comment parent, no cart
  rules in PrestaShop) are left as they were.
- **Reproducing:** CI replays from the committed snapshots and cassettes. Re-collecting needs Docker
  and the three images, the PrestaShop language pack host, and an API key for agent runs. Agent
  runs are not deterministic, so a re-collection gives a different dataset, to be recompiled and
  re-evaluated, not replayed.

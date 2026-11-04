# Contributing

## Setup

Node.js 24 or later (see `.nvmrc`).

```sh
npm install
npx playwright install --with-deps chromium
npm run check        # format, lint, typecheck, build and tests: what CI runs
npm run test:pack    # the package as installed (needs the npm registry)
```

## Changesets

A pull request that changes what the package does (its API, the check DSL, verdicts, records,
reports) adds a changeset:

```sh
npm run changeset
```

Pick the bump: patch for a fix, minor for a feature. Assay is 0.x, so a breaking change is a minor
too. Then write the changelog entry for someone who uses the package: what changed for them, not how.
Commit the file it writes in [`.changeset/`](.changeset/README.md). A change to tests, docs, CI,
examples or scripts only needs none.

The Release workflow gathers the changesets on `main` into a "Version packages" pull request. Merging
it stages that version on npm with npm's trusted publishing and provenance, then tags it and creates
its GitHub release. The version goes public once a maintainer approves the staged publish on
npmjs.com. Any other push to `main` only updates the "Version packages" pull request
([ADR 0006](docs/adr/0006-npm-package-and-releases.md)).

## Architecture decision records

Write an ADR ([`docs/adr`](docs/adr)) when a change makes a decision someone would later ask "why?"
about: a change to the check DSL or the snapshot or record formats, the trust boundary (what counts
as evidence), escalation, or how releases work. Number it after the last one.

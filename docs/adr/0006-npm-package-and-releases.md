# ADR 0006: The npm package and releases

- Status: Accepted
- Date: 2026-11-04

## Context

Assay ran from a checkout only. Its build (`dist/`, compiled with tsrs) already had the shape of a
package: two entry points, the library (`.`) and the Playwright fixture (`./playwright`), with type
declarations. There was no way to publish it, no changelog and no release history. The name `assay`
on npm belongs to an unrelated package.

## Decision

- **The package is `@swissspidy/assay`**, published with public access and npm provenance
  (`publishConfig`). Imports are `@swissspidy/assay` and `@swissspidy/assay/playwright`.
  (Later, the library was split into focused entry points: `.` for verification, records and
  locking, `./playwright`, `./compiler`, `./stress`, `./models` for the agent loop, cassettes and
  the Anthropic adapter, `./ai-sdk` (ADR 0007) and `./eval`.)
- **It ships `dist/` and `docs/`**, plus `package.json`, `README.md`, `LICENSE` and `CHANGELOG.md`.
  `npm pack` builds `dist/` first (`prepack`); `dist/` is not committed. `docs/` is shipped because
  the README links to the ADRs. Examples, tests, scripts and the evaluation data stay in the
  repository.
- **The snapshot capturer id reads the package version** from `package.json`, so a release bump keeps
  it current in every snapshot and outcome record.
- **CI tests the package as installed** (`tests/pack/install.test.ts`, `npm run test:pack`). It packs
  the package and checks the file list. It installs the tarball into an empty project, then validates
  and evaluates a real check set through the installed library (a correct run gives success, a wrong
  one fail). It loads every entry point and typechecks a TypeScript consumer against the
  installed declarations. CI runs it on every change, and the release runs it before packing.
- **Releases use Changesets and npm's trusted publishing** (`.github/workflows/release.yml`), as
  `swissspidy/playwright-webmcp` does:
  - Pull requests that change what the package does add a changeset. On `main`, Changesets keeps a
    "Version packages" pull request that bumps `package.json` and writes `CHANGELOG.md`. Its pushes
    start no workflow, so the release workflow starts CI on that branch with `workflow_dispatch`.
  - A push to `main` is a release when the version in `package.json` has no tag (the version pull
    request was just merged). Then the workflow runs everything CI does, builds and packs the
    package, tests the tarball as installed, stages it on npm, and tags the version and creates its GitHub release from its
    changelog section. A version already on npm (published by hand) is only tagged. Every other push
    only updates the version pull request.
  - The tag decides, not npm: a staged version is not on npm until it is approved, and npm will not
    stage the same version twice, so a gate on npm would retry staging, and fail, on every push
    while a version waits for approval.
  - npm accepts the workflow's OIDC token, so the repository stores no npm token. The trusted
    publisher only allows staged publishes: a version goes public once a maintainer approves it with
    2FA, on npmjs.com (Staged Packages) or with `npm stage approve <stage-id>`.
  - The tag and the GitHub release come with the stage, before the approval. To reject a staged
    version, reject the stage and delete its tag and release; the next push stages it again. An
    earlier version of this ADR held the release back as a draft until the approval; that needed a
    state machine, a daily run to notice approvals, and a second job, for a case that a maintainer
    handles by hand anyway.
- **Only the publishing job can request that token, and it installs nothing.** It publishes the
  tarball that the pack job built, tested and packed, so no dependency's install script or test code
  runs where it could publish. The Changesets job, which can push and open pull requests, installs
  with `--ignore-scripts`. No release job uses a dependency or browser cache. The publishing job runs
  in the `npm` environment, which the trusted publisher names. It skips `npm stage publish` when the
  version is already on npm, so a version published by hand only gets its tag and release. The
  pack job runs the full CI suite before packing, since nothing requires `ci.yml` to pass on `main`.
- **zizmor checks the workflows** (`.github/workflows/zizmor.yml`) on every change to `.github/`.

## Consequences

- One-time setup on npm and GitHub (the trusted publisher after the first, hand-published version):
  - On npmjs.com, add a trusted publisher for `@swissspidy/assay`: repository `swissspidy/assay`,
    workflow `release.yml`, environment `npm`, staged publishes only.
  - In the repository settings, create the `npm` environment.
  - Allow GitHub Actions to create pull requests (Settings → Actions → General).
- `0.1.0`, the version in `package.json` when this lands, has no tag, so every push to `main`
  tries to release it until the setup is done. npm only lets a trusted publisher be added to a package
  that exists, so the first version is published by hand (`npm publish --access public`, without
  provenance); the next push then tags it and creates its release. Later versions come from
  changesets.
- The Anthropic adapter's declarations name `@anthropic-ai/sdk`, an optional peer dependency. Since
  the adapter moved to `@swissspidy/assay/models`, only that entry point does: a TypeScript consumer
  of the other entry points needs no `skipLibCheck`, and the package test checks one with it off.
  A consumer of `/models` without the SDK installed still needs it.
- The version stays 0.x while the check DSL and the record format may still change; a breaking change
  is a minor bump.

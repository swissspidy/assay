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
- **It ships `dist/` and `docs/`**, plus `package.json`, `README.md`, `LICENSE` and `CHANGELOG.md`.
  `npm pack` builds `dist/` first (`prepack`); `dist/` is not committed. `docs/` is shipped because
  the README links to the ADRs. Examples, tests, scripts and the evaluation data stay in the
  repository.
- **The snapshot capturer id reads the package version** from `package.json`, so a release bump keeps
  it current in every snapshot and outcome record.
- **CI tests the package as installed** (`tests/pack/install.test.ts`, `npm run test:pack`). It packs
  the package and checks the file list. It installs the tarball into an empty project, then validates
  and evaluates a real check set through the installed library (a correct run gives success, a wrong
  one fail). It loads the Playwright entry point and typechecks a TypeScript consumer against the
  installed declarations. CI runs it on every change, and the release runs it before packing.
- **Releases use Changesets and npm's trusted publishing** (`.github/workflows/release.yml`), as
  `swissspidy/sandburg` does:
  - Pull requests that change what the package does add a changeset. On `main`, Changesets keeps a
    "Version packages" pull request that bumps `package.json` and writes `CHANGELOG.md`. Its pushes
    start no workflow, so the release workflow starts CI on that branch with `workflow_dispatch`.
  - Each run works out where `main`'s version stands. **Tagged**: nothing to do. **Neither on npm
    nor drafted** (the version pull request was just merged): test and pack the package, stage the
    tarball on npm, and create a draft GitHub release from its changelog section. A draft has no
    tag. **Drafted but not on npm**: waiting for approval. **On npm but not tagged** (a maintainer
    approved it): publish the draft, which creates the tag.
  - So nothing is tagged or announced before npm has the version. In sandburg the tag and release
    follow staging directly; a rejected stage then left a tag that stopped the version from ever
    being staged again. Here, rejecting the stage and deleting the draft lets the next run stage it
    again. The workflow also runs daily and by hand, so an approval is picked up without a push.
  - npm accepts the workflow's OIDC token, so the repository stores no npm token. The trusted
    publisher only allows staged publishes: a version goes public once a maintainer approves it with
    2FA, on npmjs.com (Staged Packages) or with `npm stage approve <stage-id>`.
- **Only the publishing job can request that token, and it installs nothing.** It publishes the
  tarball that the pack job built, tested and packed, so no dependency's install script or test code
  runs where it could publish. The Changesets job, which can push and open pull requests, installs
  with `--ignore-scripts`. No release job uses a dependency or browser cache. The publishing job runs
  in the `npm` environment, which the trusted publisher names. It skips `npm stage publish` when the
  version is already on npm, so a run that failed after publishing can be re-run for its tag and
  release.
- **zizmor checks the workflows** (`.github/workflows/zizmor.yml`) on every change to `.github/`.

## Consequences

- One-time setup on npm and GitHub, before the first release:
  - On npmjs.com, add a trusted publisher for `@swissspidy/assay`: repository `swissspidy/assay`,
    workflow `release.yml`, environment `npm`, staged publishes only.
  - In the repository settings, create the `npm` environment.
  - Allow GitHub Actions to create pull requests (Settings → Actions → General).
- `0.1.0`, the version in `package.json` when this lands, has no tag, so the first push to `main`
  after the setup stages it. Later versions come from changesets.
- The Anthropic adapter's declarations name `@anthropic-ai/sdk`, an optional peer dependency. A
  TypeScript consumer that has not installed it needs `skipLibCheck` (the usual default, and what
  `tsc --init` writes). Removing the SDK from the public types would mean declaring its message types
  ourselves, which is left for when the adapter's API settles.
- The version stays 0.x while the check DSL and the record format may still change; a breaking change
  is a minor bump.

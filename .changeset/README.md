# Changesets

A pull request that changes what the package does adds a changeset: run `npm run changeset`, pick
the bump (patch, minor or major; Assay is 0.x, so a breaking change is a minor) and describe the
change for the changelog. Commit the file it writes here.

The Release workflow collects the changesets on `main` into a "Version packages" pull request, which
bumps `package.json` and writes `CHANGELOG.md`. Merging that pull request stages the new version on
npm with a draft GitHub release; approving the staged version on npm tags it and publishes the release ([ADR 0006](../docs/adr/0006-npm-package-and-releases.md)).

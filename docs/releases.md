# Releases

Release-please opens one release PR with independently versioned Moor, CLI, and MCP
changes. Merge it after CI passes to create tags and publish the affected artifacts.
Conventional `fix:` and `feat:` commits determine version bumps and changelogs.
Generated changelogs are excluded from formatting checks; release-please owns their format.

- Moor keeps `v*` tags and publishes the server and respawner images at the same SHA
  and version.
- CLI keeps `cli-v*` tags and publishes `@moor-sh/cli`.
- MCP keeps `mcp-v*` tags and publishes `@moor-sh/mcp`.
- The private contract has internal `contract-v*` tags and changelogs, but no npm
  release. The built-in `node-workspace` plugin uses the clients' development
  dependencies to patch-bump them when the bundled contract changes.

Contract-only changes produce client patch releases, with dependency notes linking
to the contract version. For changes that add or break public client behavior,
include the corresponding client changes in the same `feat:` or breaking commit
so the clients receive the appropriate minor or major bump. Review the proposed
versions before merging.

The root package uses an empty `package-name` in the release configuration so
server-only release PRs retain an empty branch component matching their unprefixed
`v*` tags. This does not change the name in `package.json`.

The manifest starts at the existing published versions. `bootstrap-sha` bounds the
initial history for the previously untagged contract; remove it after its first
release. Normal releases then use each component's latest tag.

## One-time setup

Add the repository Actions secret `RELEASE_PLEASE_TOKEN`: a fine-grained GitHub PAT
scoped to `caiopizzol/moor` with **Contents: read and write** and **Pull requests:
read and write**. This lets release PRs trigger the required CI and review checks.
The default `GITHUB_TOKEN` suppresses those workflow triggers. Keep the existing
`NPM_TOKEN` for npm publishing; image publishing uses `GITHUB_TOKEN`.

## Failed publishing

Use **Re-run failed jobs** on the original release workflow run. Those jobs retain
the release SHA and version outputs. Starting a new workflow run does not recreate
an existing release and therefore does not retry its publishing jobs.

See the [release-please manifest documentation](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md#node-workspace)
and [Action credential requirements](https://github.com/googleapis/release-please-action#other-actions-on-release-please-prs).

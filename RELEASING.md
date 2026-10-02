# Releases

## First publication

1. Add a granular npm token with permission to publish `@wileai/pi-codex-connector` in the `@wileai` scope as the repository Actions secret `NPM_TOKEN`: https://github.com/wileai/pi-codex-connectors/settings/secrets/actions/new. Enable bypass 2FA for unattended publication if required by the account. Never put the token in source, an issue, or chat.
2. Alternatively run `gh secret set NPM_TOKEN --repo wileai/pi-codex-connectors` and paste at its hidden prompt.
3. Merge the release workflow and package metadata into `main`. Complete the checks below, then publish a GitHub release tagged `v0.1.1` from that commit. The workflow publishes the first npm version.
4. Verify `npm view @wileai/pi-codex-connector version dist-tags repository` and install with `pi install npm:@wileai/pi-codex-connector` in a clean Pi profile. Check https://pi.dev/packages?name=%40wileai%2Fpi-codex-connector after npm indexing; eligibility does not guarantee immediate listing.

## Tokenless subsequent releases

After the package exists, configure its npm Settings → Trusted Publisher:

- Provider: GitHub Actions
- Organization: `wileai`
- Repository: `pi-codex-connectors`
- Workflow filename: `publish.yml`
- Environment: leave blank
- Allow direct `npm publish`

The workflow has OIDC permission and a supported npm version. Verify a subsequent release works with OIDC, then delete `NPM_TOKEN` from GitHub and revoke the bootstrap token. See https://docs.npmjs.com/trusted-publishers/.

## Every release

1. Run `make setup`, `npm run check`, `make test`, `npm audit`, and `npm run check:package`. Live scenarios require a locally signed-in Codex account with GitHub connected; public CI deliberately has no connector credentials and does not run these scenarios. Review source and package files for secrets before release.
2. Run `npm version patch --no-git-tag-version` (or `minor` / `major`), updating both manifests. Commit the reviewed files and merge to `main` normally. Never force-push or reuse a published npm version.
3. Create and publish a GitHub release with a tag exactly matching `v<package.json version>` on that commit. A draft does not publish to npm. For prereleases, use a version such as `0.2.0-beta.1` and check GitHub's prerelease checkbox; those publish to `next`, leaving `latest` unchanged.
4. Confirm the publish workflow succeeded and the npm version is available. A failed workflow is not a published release. Fix a credentials-only failure and rerun the failed job; if package contents must change, publish a new version and release.

Users with the unpinned source `npm:@wileai/pi-codex-connector` run `pi update npm:@wileai/pi-codex-connector` (or `pi update --extensions` on current Pi), then restart Pi. Pinned versions stay pinned. npm publication makes updates available; it does not push code into running sessions.

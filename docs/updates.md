# Auto-update

Nimble Newt updates itself from GitHub Releases using the Tauri updater plugin.

## How it works

- On start and then every 6 hours, the app fetches
  `https://github.com/Ferdinand99/Nimble-Newt/releases/latest/download/latest.json`.
- If `latest.json` lists a newer version for the current platform, the app offers to download and install it. The release notes shown come from `notes` in `latest.json`.
- Automatic checks can be turned off in Settings. **Check for Updates…** in the menu always checks on demand.
- The update signature is **always** verified against the public key embedded in the app (`plugins.updater.pubkey`). An update with a missing or wrong signature is rejected.
- Unsaved tabs survive the restart after an update because the session is stored and restored on the next launch.

Only published (non-draft) releases are visible at `releases/latest`. The release workflow keeps a release as a draft until `latest.json` and the signatures are attached, then publishes it.

### `latest.json`

Generated and uploaded by `tauri-action` (`uploadUpdaterJson: true`):

```json
{
  "version": "0.2.0",
  "notes": "Release body (changelog from release-please)",
  "pub_date": "2026-01-01T00:00:00Z",
  "platforms": {
    "windows-x86_64": { "signature": "<contents of .sig>", "url": "https://github.com/.../Nimble.Newt_0.2.0_x64-setup.exe" },
    "darwin-aarch64": { "signature": "...", "url": "https://github.com/.../Nimble.Newt_universal.app.tar.gz" },
    "darwin-x86_64":  { "signature": "...", "url": "https://github.com/.../Nimble.Newt_universal.app.tar.gz" }
  }
}
```

## One-time owner setup

Do this **before merging the first release PR**.

1. Generate a key pair (choose a password when asked):

   ```sh
   npm run tauri signer generate -- -w ~/.tauri/nimble-newt.key
   ```

   This writes `~/.tauri/nimble-newt.key` (private) and `~/.tauri/nimble-newt.key.pub` (public).

2. Put the **public** key into `src-tauri/tauri.conf.json`, replacing the placeholder
   `REPLACE_WITH_PUBLIC_KEY_SEE_docs/updates.md` in `plugins.updater.pubkey`. Use the full content of `nimble-newt.key.pub` (a single base64 line). Commit this.

3. Add two GitHub repository secrets (Settings → Secrets and variables → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY`: the full content of `~/.tauri/nimble-newt.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the password from step 1 (empty if none)

4. Back up the private key and password somewhere safe (password manager).

**Never commit the private key.**

### Losing or rotating the key

Installed apps only accept updates signed with the key matching the public key they were built with. If the private key is lost or replaced, existing installs can **never** update automatically: users must download and install a new version manually, which carries the new public key. Rotate only if the key is compromised, and announce the manual re-install.

## CI without secrets

The normal CI workflow (`ci.yml`) builds installers on all platforms with
`--config '{"bundle":{"createUpdaterArtifacts":false}}'`, so it stays green without a signing key. Those builds are for testing only and cannot be used for updates.

## Release workflow without secrets

`release-please.yml` creates a draft release, then a `preflight` job fails with a clear message if `TAURI_SIGNING_PRIVATE_KEY` is empty or `plugins.updater.pubkey` still starts with `REPLACE_WITH`. Nothing is built or published, and the release stays a draft. A final `publish` job only publishes the draft when it has `latest.json` and at least one `.sig` asset.

### Recovering from a failed release

The tag and draft release already exist, and the merged release PR is labelled `autorelease: tagged`. After fixing the problem on `main`:

1. Delete the draft release and the tag: `gh release delete vX.Y.Z --cleanup-tag` (find the draft in the Releases page if `gh` cannot see it).
2. On the merged release PR, replace the label `autorelease: tagged` with `autorelease: pending`.
3. Re-run the latest `Release` workflow run on `main` (or push any commit to `main`). release-please recreates the draft and the build runs again.

If only a build job failed (for example a flaky runner) and the preflight passed, use "Re-run failed jobs" on the workflow run instead.

## Testing an update locally

1. Generate a throwaway key pair as above and put its public key in `tauri.conf.json` (do not commit).
2. Set `TAURI_SIGNING_PRIVATE_KEY` (key content) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, then build the old version (e.g. `0.1.0`) with `npm run tauri build` and install it.
3. Bump `version` in `tauri.conf.json` to `0.1.1`, build again. Note the updater bundle (`.exe`/`.msi` on Windows, `.app.tar.gz` on macOS) and its `.sig` file in `target/release/bundle/`.
4. Create a `latest.json` next to the new bundle, with `version`, `notes`, and for your platform the `url` (e.g. `http://localhost:8080/<file>`) and `signature` (the content of the `.sig` file).
5. Serve it: `npx http-server -p 8080 <dir>` (or `python3 -m http.server 8080`).
6. Temporarily change `plugins.updater.endpoints` in the **old** build's config to `http://localhost:8080/latest.json` (plain HTTP is only allowed with `"dangerousInsecureTransportProtocol": true` under `plugins.updater`), rebuild the old version, install it and use **Check for Updates…**.

## Troubleshooting

Automatic checks only show an error for an invalid signature; other problems are logged and the app tries again later. **Check for Updates…** always reports the outcome.

| In-app message | Cause | Fix |
|---|---|---|
| “Couldn't reach the update server. Check your internet connection.” | No internet, proxy/firewall, or GitHub unreachable | Check connection and retry; the app keeps working normally |
| “The update's signature is invalid, so it was not installed.” | The release was signed with a different key than the one embedded in the app, or the file was altered/corrupted | Verify `pubkey` in `tauri.conf.json` matches the signing key; if the key changed, users must reinstall manually |
| “Updates aren't set up in this build.” | `plugins.updater.pubkey` is still the `REPLACE_WITH…` placeholder in this build | Follow the owner setup above and rebuild |
| “The update information was unreadable.” | `latest.json` missing, not valid JSON, or has no entry for this platform (also happens while no non-draft release exists) | Check that the latest published release has `latest.json` with the right `platforms` keys |
| “You're up to date (version X).” | Nothing newer is published | None |

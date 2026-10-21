# Code signing and notarization (optional)

This is independent from [update signing](updates.md). Update signing (Tauri key pair) is mandatory for auto-update; code signing only removes OS warnings. The release workflow signs whatever certificates it finds in repository secrets and silently builds unsigned otherwise (secrets are checked in guarded steps of `.github/workflows/release-please.yml`). CI builds (`ci.yml`) are never signed.

## Unsigned builds: what users see

- **macOS (Gatekeeper):** "Nimble Newt cannot be opened because the developer cannot be verified" (or "is damaged"). Users can right-click the app → Open → Open, or go to System Settings → Privacy & Security → "Open Anyway". If it reports "damaged": `xattr -dr com.apple.quarantine "/Applications/Nimble Newt.app"`.
- **Windows (SmartScreen):** "Windows protected your PC". Users click **More info** → **Run anyway**. With a certificate, reputation builds up over time for the publisher instead of starting over with every new file; since 2024 EV certificates no longer get it immediately either.

Auto-updates still work for unsigned builds (they are verified with the Tauri update key).

## macOS

Requires an Apple Developer Program membership.

Secrets:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the exported **Developer ID Application** certificate (`.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | password chosen when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |

Notarization (primary: App Store Connect API key):

| Secret | Value |
|---|---|
| `APPLE_API_ISSUER` | Issuer ID (App Store Connect → Users and Access → Integrations) |
| `APPLE_API_KEY` | Key ID of the API key |
| `APPLE_API_KEY_CONTENT` | full text of the downloaded `AuthKey_XXXX.p8` file |

The workflow writes `APPLE_API_KEY_CONTENT` to a temporary file and points `APPLE_API_KEY_PATH` at it.

Alternative (used only when the API key secrets are not all set): `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password from appleid.apple.com), `APPLE_TEAM_ID`.

Creating the certificate: in Xcode (Settings → Accounts → Manage Certificates) or the Apple developer portal, create a "Developer ID Application" certificate, then in Keychain Access export it (certificate with its private key) as `.p12`. Find the identity with `security find-identity -v -p codesigning`.

Base64 (single line):

```sh
base64 -i certificate.p12 | tr -d '\n' | pbcopy      # macOS
base64 -w0 certificate.p12                            # Linux
```

If the certificate is present but no notarization credentials are, the app is signed but not notarized (Gatekeeper still warns).

Checking the setup: the **macOS signing check** workflow (`.github/workflows/macos-signing.yml`, Actions → Run workflow) builds, signs and notarizes the app with these secrets and verifies the signature, hardened runtime, Gatekeeper acceptance and stapled ticket, without publishing anything. Run it after renewing the certificate or the API key.

The identity contains your name; if it has non-ASCII letters (æ, ø, å), do not type it on a Git Bash command line, which mangles them. Read it from the certificate instead:

```sh
openssl x509 -in devid.pem -noout -subject -nameopt RFC2253,-esc_msb \
  | sed -n 's/.*CN=\([^,]*\).*/\1/p' | tr -d '\n' > identity.txt
gh secret set APPLE_SIGNING_IDENTITY < identity.txt
```

## Windows

| Secret | Value |
|---|---|
| `WINDOWS_CERTIFICATE` | base64 of the code signing certificate `.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | password of the `.pfx` |

Base64 in PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx")) | Set-Clipboard`

The workflow imports the PFX into the runner's certificate store, then writes a temporary Tauri config override (passed with `--config`) that sets `bundle.windows.certificateThumbprint` to the imported certificate's thumbprint, `digestAlgorithm` to `sha256` and `timestampUrl` to `http://timestamp.digicert.com`. Change the timestamp URL in the workflow if you prefer another RFC 3161 server. The `.pfx` file is deleted right after import.

Note: since June 2023 publicly trusted code signing keys must live on hardware (HSM/token) or a cloud service, so a downloadable `.pfx` is mainly available from older certificates or some resellers. Alternatives:

- **Azure Trusted Signing (Artifact Signing):** cheap, no hardware; needs a custom `bundle.windows.signCommand` in the Tauri config calling the signing client instead of the PFX steps.
- **OV/EV certificate in a cloud HSM (e.g. DigiCert KeyLocker, SSL.com eSigner):** also integrated via `signCommand`.
- **SignPath Foundation:** free signing for open source projects (the publisher shown is "SignPath Foundation"); signing requests are approved per release.

These alternatives are not wired up in the workflow.

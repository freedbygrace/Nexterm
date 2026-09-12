# 🚀 Releases & Images

This fork builds everything from GitHub Actions with the repository's own `GITHUB_TOKEN`. No extra secrets are
required to cut a release; signing keys and mirrors are optional.

## Container images

Images are published to the GitHub Container Registry under the repository owner:

| Image | Purpose |
| :-- | :-- |
| `ghcr.io/<owner>/nexterm/server` | API server + web client |
| `ghcr.io/<owner>/nexterm/engine` | connection engine (SSH, RDP, VNC, ...) |
| `ghcr.io/<owner>/nexterm/aio` | server and engine in one container |

Tags: `latest` and the version (for example `1.3.0-BETA`) for every release, plus `development` rebuilt from every
commit on `main`. Multi-arch manifests cover `linux/amd64` and `linux/arm64`.

```yaml
services:
  nexterm:
    image: ghcr.io/<owner>/nexterm/aio:latest
    ports: ["6989:6989"]
    volumes: ["./data:/app/data"]
    environment:
      ENCRYPTION_KEY: <64 hex characters>
```

Packages are private by default on GHCR; make them public in the package settings or log in with a token that has
`read:packages`.

## Cutting a release

1. Merge `development` into `main` and make sure the **CI** workflow is green (server boot + migrations, client
   build, CLI build, mobile analyze).
2. Push a tag `vX.Y.Z` or `vX.Y.Z-BETA` on `main`. The **Release** workflow then:
   - creates a draft release,
   - builds the CLI, standalone server, engine, connector (Windows/macOS/Linux) and mobile apps, and attaches the
     binaries, `.deb`, `.rpm`, `.apk` and unsigned `.ipa` files,
   - builds and pushes the container images above,
   - commits the version bump to `main` and publishes the release notes.
3. If any build fails the draft release and the tag are removed again; fix and re-tag.

### Optional secrets

| Secret | Effect when set |
| :-- | :-- |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD`, `ANDROID_KEY_ALIAS` | release-signed APKs (otherwise debug-signed) |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | signed connector updater artifacts |

The Buildkite APT/RPM mirror only runs on the upstream repository; forks ship `.deb` and `.rpm` as release assets.

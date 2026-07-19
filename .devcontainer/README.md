# Optional development container

The optional container is a reproducibility aid added after the native Windows workflow stabilized, as required by [ADR 0005](../docs/adr/0005-native-first-development-container.md). Native Windows remains the primary workflow, and the container does not replace the dedicated browser-assurance job.

`.devcontainer/devcontainer.json` uses the official Dev Containers JavaScript and Node.js 22 Bookworm image pinned to the immutable multi-platform manifest digest `sha256:0d29e5fdc64f8397cd502223e0c4679f1e60877ca0fd2db4f2e2e0028e4271af`. The image is intentionally JavaScript-specific, so the configuration adds the official Python feature at version 1.8.0, installs Python 3.12 without optional global Python tools, and records the feature digest in `.devcontainer/devcontainer-lock.json`. Its `postCreateCommand` installs pnpm 11.9.0 and then runs `pnpm install --frozen-lockfile`. The container runs as the non-root `node` user and forwards only ports 4173 for Vite and 8080 for the synthetic WebSocket simulator.

The required `development-container` job in `.github/workflows/ci.yml` uses the digest-pinned configuration, never pushes an image, and is configured to run:

```powershell
pnpm validate
pnpm build
pnpm build:offline
```

The job's result feeds the aggregate `CI required` check. Browser and accessibility assurance remains in the dedicated Chromium job. The container configuration contains no project credentials or user data. To run the browser suite interactively inside it, install Chromium with `pnpm exec playwright install --with-deps chromium`, then run `pnpm test:e2e`.

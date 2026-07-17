# Development container gate

The optional v2.1 development container is intentionally not configured yet.

Per [ADR 0005](../docs/adr/0005-native-first-development-container.md), add `devcontainer.json` and its pinned base image only after the following commands pass in the native Windows environment and in CI:

```powershell
pnpm install --frozen-lockfile
pnpm validate
pnpm test:coverage
pnpm build
pnpm build:offline
pnpm test:e2e
```

When that gate is met, the container must run the same lockfile and commands, publish no ports except the local development and simulator ports, run as a non-root user, and contain no credentials or user data.

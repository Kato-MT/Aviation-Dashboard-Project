# Security policy

## Supported versions

Security fixes are applied to the latest stable release line. Pre-release branches and historical v1 files are provided without a support guarantee.

| Version              | Supported   |
| -------------------- | ----------- |
| Latest stable `2.x`  | Yes         |
| Pre-release branches | Best effort |
| `1.x`                | No          |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's **Security** tab and select **Report a vulnerability** to start a private advisory. Include:

- affected version or commit;
- reproduction steps and a minimal synthetic fixture;
- impact and the boundary crossed;
- browser, operating system, and relevant configuration;
- any suggested mitigation.

Do not include personal, proprietary, controlled, or operational data. The maintainers will acknowledge a complete report when it is reviewed, coordinate remediation privately, and credit the reporter if requested and appropriate.

## Security boundaries

- The workbench treats uploaded files and WebSocket messages as hostile input.
- Uploaded source records remain local to the browser unless the user explicitly exports them.
- Verification exports omit source records by default.
- No credential, secret, or private endpoint belongs in source control, fixtures, screenshots, issues, logs, or reports.
- The simulator binds to a local interface by default and emits synthetic data only.
- The application is not a safety, maintenance, certification, or operational decision system.

See [docs/threat-model.md](docs/threat-model.md) for the full model and [docs/limitations.md](docs/limitations.md) for non-security boundaries.

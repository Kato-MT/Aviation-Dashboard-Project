# Contributing

Thank you for improving Flight Diagnostics Workbench. Changes should remain small, reproducible, and supported by synthetic fixtures.

## Ground rules

- Keep the project employer-neutral and organization-neutral.
- Use only synthetic, unclassified demonstration data.
- Do not add real platform identifiers, operational data, certification claims, or proprietary thresholds.
- Do not weaken validation, evidence, accessibility, or reproducibility to simplify a feature.
- Deterministic rules remain authoritative. Experimental model results must be clearly separated.
- Never commit secrets, uploaded user data, local SQLite databases, generated caches, or dependency directories.

## Local setup

```powershell
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install --frozen-lockfile
pnpm validate
pnpm build
pnpm build:offline
```

Python tooling uses the version and dependencies documented beside each tool. Create a local virtual environment and do not commit it.

## Change process

1. Open or select a focused issue.
2. Create a branch such as `feat/versioned-json-adapter` or `fix/blank-value-validation`.
3. Add or update a stable requirement in `requirements/requirements.md`.
4. Add test cases to `requirements/traceability.json` and implement the linked tests.
5. Run the relevant commands, including failure-path tests.
6. Update documentation and `CHANGELOG.md` when behavior changes.
7. Open a draft pull request with the verification evidence.

Use conventional commits, for example:

```text
feat(diagnostics): add frozen-sensor evidence
fix(adapter): quarantine whitespace-only values
test(verification): cover newly introduced findings
docs(threat-model): document export boundary
```

## Pull request gates

A change is ready for review only when:

- requirements traceability is complete;
- formatting, linting, type checking, and tests pass;
- core branch coverage satisfies the repository threshold;
- normal and offline builds succeed;
- browser, keyboard, accessibility, and responsive checks pass when UI behavior changes;
- dependency review finds no high or critical known vulnerability introduced by the change;
- no serious or critical automated accessibility issue remains;
- the pull request explains unverified or deferred work without presenting it as complete.

Do not merge a release pull request until every required branch check has reported success on the exact commit.

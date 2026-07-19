# Mutation testing

StrykerJS changes small pieces of the deterministic core and checks whether the test suite detects each change. This provides a stronger signal than line coverage alone because a test can execute a line without asserting its behavior.

## Configuration

- Scope: adapters, core rules, and deterministic fault injection
- Runner: Vitest
- Checker: TypeScript
- Break threshold: 60 percent
- Command: `pnpm mutation`
- Detailed local report: `reports/mutation/mutation.html`, intentionally ignored because it is a generated 1.2 MiB artifact
- Compact evidence: [`artifacts/mutation-summary.json`](../artifacts/mutation-summary.json)

The plugins are listed explicitly in `stryker.config.json` because pnpm's dependency layout prevents reliable automatic discovery, as documented in the [official Stryker troubleshooting guide](https://stryker-mutator.io/docs/stryker-js/troubleshooting/).

## Measured working-tree result

The July 19, 2026 local run instrumented 1,803 mutants. Of the 1,113 valid mutants, 698 were killed, 6 timed out, 373 survived, and 36 had no coverage. The measured mutation score was 63.25 percent, which passed the declared 60 percent break threshold.

This is working-tree evidence. The compact artifact records the tool versions, counts, duration, full-report hash, limitations, and source status. A tagged release must rerun the command before presenting the score as release evidence.

## Interpretation

The result confirms that the tests reject a majority of valid behavioral changes. Surviving mutants are useful backlog items for strengthening precise assertions, especially around error-message text, copied metadata, and boundary math. Mutation results supplement the golden regression and branch-coverage gates. They do not replace them.

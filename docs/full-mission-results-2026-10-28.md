# Full-mission result, October 28, 2026

The frozen alert-persistence experiment did not produce an improved policy. The current advisory model has a substantial nominal-mission false-alarm problem on this synthetic mission matrix. No candidate was integrated into the application.

## Measured final results

| Metric                         |   Original advisory model | Deterministic shared-window reference |
| ------------------------------ | ------------------------: | ------------------------------------: |
| Active-fault detections        | 2,519 / 3,200 (78.71875%) |               2,516 / 3,200 (78.625%) |
| Missed active faults           |                       681 |                                   684 |
| Nominal missions with an alarm |                   80 / 80 |                               39 / 80 |
| Median detection delay         |                  3,000 ms |                              1,000 ms |
| p95 detection delay            |                 15,000 ms |                             13,000 ms |
| Model abstention fraction      |                   55.406% |                        Not applicable |

Delay summaries include only detected cases. A detection requires a new alarm within the inclusive active-fault interval. The reference uses the same post-warmup window as the model; rule alarms beginning before index 39 are not counted as new detections. These metrics are not directly comparable to the older selected-window F1 because their populations, denominators, and scoring rules differ.

The original model's seed-cluster bootstrap recall interval is 77.875% to 79.5%. Every nominal seed had an alarm, so nominal false-alarm resampling gives a degenerate 100% interval. This does not establish certainty about a population rate. All results are synthetic and are not operational performance estimates.

## Development decision

Development used 40 separate seeds and 1,640 missions. Nominal-mission false-alarm incidence was 40/40 for every tested streak length. Active recall was 78.3125%, 77.625%, 76.625%, and 72.5% for streaks of one, two, three, and five respectively. The five-window policy exceeded both the overall and per-family recall-loss limits. The two- and three-window policies passed the tradeoff limits but did not improve the primary false-alarm metric. The shortest-streak tie rule retained the original policy.

The final 80 seeds and 3,280 missions evaluated that frozen choice. No new policy was selected or tuned after final results were observed. Reproduction after report-only fixes matched all per-mission result hashes and decisions exactly. Repeated runs are not additional observations.

## Replay evidence

- `13101:fuel-leak:default`, final: onset 82; rules alert at 83; the model's first qualifying new alert is at 94. Earlier model alarms do not earn active-fault detection credit.
- `13101:nominal:default`, final: no injected fault; model alarm episodes start at 39, 57, 75, 96, and 105.
- `12101:cross-sensor-decoupling:default`, development: active interval 93 through 120; the original model alerts at 105 through 107. A five-window streak suppresses that detection but retains all three earlier false-alarm episodes.

See [the evaluation workflow](full-mission-evaluation.md) for replay commands and frozen protocol details. Generated JSON/HTML reports and manifests are local artifacts under `reports/mission-evaluation/`; they are not committed as source or published releases.

## Provenance and verification

- Executable source commit: `be164c3b528e5fd5e236b005801e72d0ac29f4c2`.
- Source-file manifest hash: `16a1b394a1d29d509932835f2c9ff26c2b9816b8b98eac35afce1b1bbbe81a81`.
- Registered model hash: `4cdea6792b8d302a8cc0197caccbb4498b18d136b1c2ed93fe798d66a82633af`.
- Final per-mission results hash: `481b691f6e4dfc08cd05274abd7db74f95bf386b94194afb37213186801d7316`.
- Selection frozen at `2026-10-28T21:29:34.126Z`, before the final reproduction began.
- Node 24.18.0, pnpm 11.9.0, and Python 3.12.14 on Windows.

All 477 TypeScript tests and 42 Python tests passed; aggregate branch coverage was 91.52%. Lint, typecheck, traceability, normal build, and offline build passed. The production-preview browser suite passed 49 tests with one existing mobile-only skip. Report-only fixes received focused tests, lint, and type checks. Final report/replay browser inspections found no script errors, network requests, serious/critical accessibility violations, or mobile overflow. Three exact replays, cached final resumption, and the post-final development lock were verified.

Two limitations remain in the generic local check wrappers: the initial Vite development server hung before page load, so browser verification used the actual production build through preview; the blanket formatter encountered two unchanged untracked notes, while source/tests/tools/docs/requirements/configuration formatting passed. No source or acceptance checks were weakened to hide these conditions. Hosted CI and release publication were outside this local sprint.

The next research priority is diagnosing the false alarms across nominal mission transitions and evaluating any future model change on fresh, prospectively reserved seeds. This experiment does not establish that a persistence filter is sufficient.

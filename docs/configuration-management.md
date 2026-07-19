# Configuration management

## Controlled items

The following items are version-controlled configuration, not informal UI settings:

| Item               | Identifier                                  | Change rule                                                |
| ------------------ | ------------------------------------------- | ---------------------------------------------------------- |
| Application        | semantic version                            | Update for every release                                   |
| Canonical schema   | schema version                              | Reject unsupported major versions                          |
| Adapter            | adapter ID and version                      | Preserve explicit field and unit mappings                  |
| Detection profile  | profile ID and version                      | Review rule parameters and expected channels               |
| Deterministic rule | stable rule ID                              | Do not reuse an ID for different semantics                 |
| Streaming protocol | protocol version                            | Reject incompatible major versions                         |
| Model registry     | registry schema and entry ID                | Require compatible identities and explicit user selection  |
| Model artifact     | model ID, version, artifact and config hash | Keep disabled unless evaluation gates pass                 |
| Temporal scenario  | scenario ID, generator version, seed        | Preserve lifecycle labels and synthetic boundary           |
| Campaign           | spec/result schema and replay hash          | Preserve matrix inputs, progress outcomes, and metrics     |
| Phase state        | transition rule ID and configuration        | Record hysteresis and confirmation evidence                |
| Database schema    | migration version                           | Apply ordered migrations inside a transaction              |
| Report format      | report schema version                       | Maintain backward-readable release fixtures when practical |

Every bundled profile, threshold, fault scenario, and dataset is synthetic and unclassified.

## Versioning policy

- **Major:** incompatible public contract, schema, protocol, or report change.
- **Minor:** backward-compatible capability, new profile, rule, adapter, or report field.
- **Patch:** compatible defect or documentation correction.

Rule IDs remain stable even when their display labels change. A semantic rule change requires either a new rule ID or a profile major-version change with a documented migration.

## Provenance record

Every completed analysis records:

- application version and commit when available;
- adapter ID and version;
- schema version;
- profile ID and version;
- SHA-256 input hash;
- accepted and quarantined counts;
- validation results and findings;
- comparison result when a candidate exists;
- injected scenario and seed when applicable;
- model artifact version and enabled state when evaluated;
- registry compatibility reasons, artifact and configuration identities, cadence, and window when a learned model is considered;
- temporal scenario, seed, phase transitions, fault lifecycle, sensor-fusion residuals, uncertainty, and detector agreement when an investigation runs;
- campaign specification hash, case matrix, completion and failure counts, expected/missing/unexpected comparisons, grouped metrics, calibration, abstention, and bootstrap configuration when a campaign runs.

Source data is excluded from normal evidence exports.

## Change control

1. Link the change to an issue and stable requirement ID.
2. Update configuration and fixtures in one focused branch.
3. Add positive, negative, boundary, and regression tests.
4. Update traceability and affected architecture or user documentation.
5. Run native validation before depending on the optional development container.
6. Review the exact diff and lockfile.
7. Merge only after required checks pass on the exact commit.
8. Tag from protected `main`, then build and attest release artifacts in CI.

## Baseline control

The original repository head is preserved as `v1.0.0`. The included CSV compatibility baseline has:

- 85 accepted records;
- 5 overspeed findings;
- 3 rapid-descent findings;
- 1 fuel-change finding;
- SHA-256 `b3b50781afde9b3895707109e40e86b2fae82ed8e38cc4e964d9cb2de327b700`.

Any change to the fixture or its expected compatibility result must be explicit, reviewed, and released as a breaking baseline change. Generated synthetic profiles use separate versioned fixtures.

## Repository protection target

After the first successful CI run, protect `main` with:

- pull requests required;
- at least one approval for release changes;
- conversation resolution required;
- required checks from CI, CodeQL, and dependency review;
- branches required to be current before merge;
- force pushes and deletions disabled;
- administrators included unless an emergency procedure is documented.

Exact check names must be selected from a successful run. Do not configure guessed check names.

## Generated files

Release outputs, coverage, local databases, virtual environments, model-training caches, dependency directories, browser reports, and benchmark scratch data are generated artifacts. They are ignored locally unless a release process deliberately publishes an evidence artifact.

import { useEffect, useRef, useState } from 'react';
import {
  BUNDLED_MAP_SUMMARY,
  BUNDLED_SCHEMA_IDENTITIES,
  DEFAULT_RELEASE_GATES,
} from '../../evidence/catalog';
import type {
  EvidenceBuildIdentity,
  EvidenceOperations,
  EvidenceOperationsLoader,
  MapEvidenceSummary,
  ReleaseGateEvidence,
} from '../../evidence/types';
import type {
  OperationsAdmissionWindow,
  OperationsAggregateWindow,
  OperationsClassification,
  RegionOperations,
} from '../../operations/contract';
import './evidence.css';

type HealthState =
  | { kind: 'unchecked' }
  | { kind: 'checking' }
  | { kind: 'available'; value: EvidenceOperations }
  | { kind: 'failed'; reason: 'request' | 'identity-mismatch' };

export interface EvidenceAppProps {
  buildIdentity: Readonly<EvidenceBuildIdentity>;
  mapSummary?: Readonly<MapEvidenceSummary>;
  releaseGates?: readonly Readonly<ReleaseGateEvidence>[];
  loadOperations?: EvidenceOperationsLoader;
  staticOnly?: boolean;
}

const numberFormat = new Intl.NumberFormat('en-US');
const bytesFormat = new Intl.NumberFormat('en-US', {
  style: 'unit',
  unit: 'megabyte',
  unitDisplay: 'short',
  maximumFractionDigits: 1,
});

function formatBytes(bytes: number): string {
  return `${bytesFormat.format(bytes / 1_000_000)} (${numberFormat.format(bytes)} bytes)`;
}

function statusLabel(value: string): string {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function ReasonCodes({
  value,
  label,
}: {
  value: Readonly<OperationsClassification<string>>;
  label: string;
}) {
  return (
    <span className="evidence-reason-codes" aria-label={`${label} reason codes`}>
      {value.reasonCodes.join(', ')}
    </span>
  );
}

function StatusValue({
  value,
  label,
}: {
  value: Readonly<OperationsClassification<string>>;
  label: string;
}) {
  return (
    <span className="evidence-classification">
      <span className="evidence-status" data-status={value.state}>
        {statusLabel(value.state)}
      </span>
      <ReasonCodes value={value} label={label} />
    </span>
  );
}

function AggregateWindowEvidence({
  title,
  value,
}: {
  title: string;
  value: Readonly<OperationsAggregateWindow>;
}) {
  return (
    <article className="evidence-counter-window">
      <h4>{title}</h4>
      <p>
        Window starts <time dateTime={value.startedAt}>{value.startedAt}</time>.
      </p>
      <div className="evidence-counter-groups">
        <dl>
          <div>
            <dt>Provider accounting</dt>
            <dd>{statusLabel(value.provider.accounting)}</dd>
          </div>
          <div>
            <dt>Polls</dt>
            <dd>{numberFormat.format(value.provider.pollCount)}</dd>
          </div>
          <div>
            <dt>Successes</dt>
            <dd>{numberFormat.format(value.provider.successCount)}</dd>
          </div>
          <div>
            <dt>Failures</dt>
            <dd>{numberFormat.format(value.provider.failureCount)}</dd>
          </div>
          <div>
            <dt>Rate limits</dt>
            <dd>{numberFormat.format(value.provider.rateLimitCount)}</dd>
          </div>
        </dl>
        <dl>
          <div>
            <dt>Validation accounting</dt>
            <dd>{statusLabel(value.validation.accounting)}</dd>
          </div>
          <div>
            <dt>Accepted snapshots</dt>
            <dd>{numberFormat.format(value.validation.acceptedSnapshotCount)}</dd>
          </div>
          <div>
            <dt>Rejected snapshots</dt>
            <dd>{numberFormat.format(value.validation.rejectedSnapshotCount)}</dd>
          </div>
          <div>
            <dt>Invalid fields</dt>
            <dd>{numberFormat.format(value.validation.invalidFieldCount)}</dd>
          </div>
        </dl>
        <dl>
          <div>
            <dt>Delivery accounting</dt>
            <dd>{statusLabel(value.delivery.accounting)}</dd>
          </div>
          <div>
            <dt>Acknowledgments</dt>
            <dd>{numberFormat.format(value.delivery.acknowledgmentCount)}</dd>
          </div>
          <div>
            <dt>Timeouts</dt>
            <dd>{numberFormat.format(value.delivery.timeoutCount)}</dd>
          </div>
          <div>
            <dt>Send failures</dt>
            <dd>{numberFormat.format(value.delivery.sendFailureCount)}</dd>
          </div>
          <div>
            <dt>Invalid controls</dt>
            <dd>{numberFormat.format(value.delivery.invalidControlCount)}</dd>
          </div>
          <div>
            <dt>Hibernation losses</dt>
            <dd>{numberFormat.format(value.delivery.hibernationLossCount)}</dd>
          </div>
        </dl>
      </div>
    </article>
  );
}

function AdmissionWindowEvidence({
  title,
  value,
}: {
  title: string;
  value: Readonly<OperationsAdmissionWindow>;
}) {
  return (
    <article className="evidence-counter-window">
      <h4>{title}</h4>
      <p>
        Window starts <time dateTime={value.startedAt}>{value.startedAt}</time>.
      </p>
      <dl>
        <div>
          <dt>Accounting</dt>
          <dd>{statusLabel(value.counters.accounting)}</dd>
        </div>
        <div>
          <dt>Accepted</dt>
          <dd>{numberFormat.format(value.counters.acceptedCount)}</dd>
        </div>
        <div>
          <dt>Rate-limit rejections</dt>
          <dd>{numberFormat.format(value.counters.rateLimitRejectionCount)}</dd>
        </div>
        <div>
          <dt>Capacity rejections</dt>
          <dd>{numberFormat.format(value.counters.capacityRejectionCount)}</dd>
        </div>
      </dl>
    </article>
  );
}

function RegionWindowEvidence({ region }: { region: Readonly<RegionOperations> }) {
  return (
    <details className="evidence-region-counters">
      <summary>{statusLabel(region.regionId)} aggregate counters</summary>
      {region.windows ? (
        <div className="evidence-window-grid">
          <AggregateWindowEvidence title="Current hour" value={region.windows.currentHour} />
          <AggregateWindowEvidence
            title="Trailing 24 complete hours"
            value={region.windows.trailing24Hours}
          />
        </div>
      ) : (
        <p>No aggregate counter window was available for this regional read.</p>
      )}
    </details>
  );
}

function HealthEvidence({ state }: { state: HealthState }) {
  if (state.kind === 'unchecked') {
    return (
      <div className="evidence-health-state" data-health-state="unchecked">
        <strong>Not checked</strong>
        <p>No operational request has been made. All static evidence below is already available.</p>
      </div>
    );
  }
  if (state.kind === 'checking') {
    return (
      <div className="evidence-health-state" data-health-state="checking" role="status">
        <strong>Checking once</strong>
        <p>Requesting one bounded operations.v1 projection. No observation feed is being opened.</p>
      </div>
    );
  }
  if (state.kind === 'failed') {
    return (
      <div className="evidence-health-state" data-health-state="failed" role="alert">
        <strong>Operational health unavailable</strong>
        <p>
          {state.reason === 'identity-mismatch'
            ? 'The response did not match this build identity and was rejected.'
            : 'The one-time check was unavailable, invalid, or timed out.'}{' '}
          Static build, license, and limitation evidence is unaffected.
        </p>
      </div>
    );
  }
  const { value } = state;
  return (
    <div className="evidence-health-result" data-health-state="available">
      <p className="evidence-health-announcement" role="status">
        Operational evidence received. Application state is {statusLabel(value.application.state)}.
      </p>
      <div className="evidence-health-summary">
        <div>
          <span>Application</span>
          <StatusValue value={value.application} label="Application" />
        </div>
        <div>
          <span>Service source</span>
          <strong>{value.identity.source.label}</strong>
        </div>
        <div>
          <span>Mode</span>
          <strong>{statusLabel(value.identity.source.mode)}</strong>
        </div>
        <div>
          <span>Service build</span>
          <strong>{value.identity.applicationVersion}</strong>
        </div>
        <div>
          <span>Release identity</span>
          <strong>{value.identity.releaseSha}</strong>
        </div>
        <div>
          <span>Policy identity</span>
          <strong className="evidence-policy-id">{value.identity.policyId}</strong>
        </div>
        <div>
          <span>Admission</span>
          <StatusValue value={value.admission} label="Admission" />
        </div>
        <div>
          <span>Admission scope</span>
          <strong>{statusLabel(value.admission.scope)}</strong>
        </div>
      </div>
      <p className="evidence-checked-at">
        The exact bounded projection was checked at{' '}
        <time dateTime={value.checkedAt}>{value.checkedAt}</time>.
      </p>
      <div
        className="evidence-table-scroll"
        role="region"
        aria-label="Regional aggregate service status"
        tabIndex={0}
      >
        <table className="evidence-health-table">
          <caption>Regional operational classifications from the explicit health check</caption>
          <thead>
            <tr>
              <th scope="col">Region</th>
              <th scope="col">Read</th>
              <th scope="col">Provider</th>
              <th scope="col">Freshness</th>
              <th scope="col">Observation age</th>
              <th scope="col">Delivery</th>
            </tr>
          </thead>
          <tbody>
            {value.regions.map((region) => (
              <tr key={region.regionId}>
                <th scope="row">{region.regionId}</th>
                <td>
                  <StatusValue value={region.availability} label={`${region.regionId} read`} />
                </td>
                <td>
                  <StatusValue value={region.provider} label={`${region.regionId} provider`} />
                </td>
                <td>
                  <StatusValue value={region.freshness} label={`${region.regionId} freshness`} />
                </td>
                <td>
                  {region.freshness.observationAgeSeconds === null
                    ? 'Not available'
                    : `${numberFormat.format(region.freshness.observationAgeSeconds)} seconds`}
                </td>
                <td>
                  <StatusValue value={region.delivery} label={`${region.regionId} delivery`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="evidence-operations-details">
        <h3>Bounded regional and admission counters</h3>
        <p>
          These windows are operational summaries, not billing records and not aircraft-level
          evidence.
        </p>
        {value.regions.map((region) => (
          <RegionWindowEvidence key={region.regionId} region={region} />
        ))}
        <details className="evidence-region-counters">
          <summary>Worker-isolate admission counters</summary>
          <div className="evidence-window-grid">
            <AdmissionWindowEvidence
              title="Current hour"
              value={value.admission.windows.currentHour}
            />
            <AdmissionWindowEvidence
              title="Trailing 24 complete hours"
              value={value.admission.windows.trailing24Hours}
            />
          </div>
        </details>
      </div>
      <div className="evidence-operations-limitations" role="note">
        <h3>What this check cannot prove</h3>
        <ul>
          <li>Scope is three fixed Georgia regions.</li>
          <li>
            Operational aggregate retention is bounded to {value.limitations.retentionDays} days.
          </li>
          <li>Delivery and trailing windows are best-effort summaries.</li>
          <li>Admission applies to one Worker isolate, not the deployment or account.</li>
          <li>No global availability percentage or platform-processing assurance is provided.</li>
        </ul>
      </div>
    </div>
  );
}

export function EvidenceApp({
  buildIdentity,
  mapSummary = BUNDLED_MAP_SUMMARY,
  releaseGates = DEFAULT_RELEASE_GATES,
  loadOperations,
  staticOnly = false,
}: EvidenceAppProps) {
  const [health, setHealth] = useState<HealthState>({ kind: 'unchecked' });
  const mounted = useRef(false);
  const activeRequest = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeRequest.current?.abort();
      activeRequest.current = undefined;
    };
  }, []);

  const checkHealth = () => {
    if (staticOnly || !loadOperations) return;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setHealth({ kind: 'checking' });
    void loadOperations(controller.signal).then(
      (value) => {
        if (mounted.current && activeRequest.current === controller) {
          const identityMatches =
            value.identity.applicationVersion === buildIdentity.applicationVersion &&
            value.identity.releaseSha === buildIdentity.releaseSha;
          setHealth(
            identityMatches
              ? { kind: 'available', value }
              : { kind: 'failed', reason: 'identity-mismatch' },
          );
          activeRequest.current = undefined;
        }
      },
      () => {
        if (mounted.current && activeRequest.current === controller) {
          setHealth({ kind: 'failed', reason: 'request' });
          activeRequest.current = undefined;
        }
      },
    );
  };

  const exactRelease = buildIdentity.releaseStatus === 'exact-release';
  return (
    <main id="evidence-main" className="evidence-page" tabIndex={-1}>
      <aside
        className="evidence-release-banner"
        data-release-status={buildIdentity.releaseStatus}
        role="status"
      >
        <strong>
          {exactRelease ? 'Exact release identity supplied' : 'Unreleased development build'}
        </strong>
        <span>
          {buildIdentity.applicationVersion} · {buildIdentity.releaseSha}
        </span>
        <p>
          {exactRelease
            ? 'This view identifies the supplied release artifact. Its gate ledger still determines which claims are supported.'
            : 'No published v3 release, production deployment, or real-provider success is claimed.'}
        </p>
      </aside>

      <header className="evidence-introduction">
        <p className="section-label">Engineering evidence</p>
        <h1>What this build is, what it uses, and what remains open</h1>
        <p>
          {staticOnly
            ? 'Read the chain in order, or jump to a specific proof boundary. This self-contained offline package exposes static evidence only and cannot request service health.'
            : 'Read the chain in order, or jump to a specific proof boundary. Static evidence works without a network connection. Operational health runs only after the explicit button below.'}
        </p>
      </header>

      <nav className="evidence-chain" aria-label="Evidence chain">
        <ol>
          <li>
            <a href="#evidence-build">Build identity</a>
          </li>
          <li>
            <a href="#evidence-source">Source and health</a>
          </li>
          <li>
            <a href="#evidence-map">Map and licenses</a>
          </li>
          <li>
            <a href="#evidence-boundaries">Privacy and limitations</a>
          </li>
          <li>
            <a href="#evidence-gates">Release gates</a>
          </li>
        </ol>
      </nav>

      <div className="evidence-layout">
        <section
          id="evidence-build"
          className="evidence-section"
          aria-labelledby="evidence-build-title"
        >
          <div className="evidence-section-heading">
            <p className="section-label">01 · Identity</p>
            <h2 id="evidence-build-title">Bundled build and schema identity</h2>
            <p>These values describe this browser candidate, not a deployed environment.</p>
          </div>
          <dl className="evidence-definition-grid">
            <div>
              <dt>Application</dt>
              <dd>{buildIdentity.applicationVersion}</dd>
            </div>
            <div>
              <dt>Release identity</dt>
              <dd>{buildIdentity.releaseSha}</dd>
            </div>
            <div>
              <dt>Build target</dt>
              <dd>{buildIdentity.buildTarget}</dd>
            </div>
            <div>
              <dt>Release status</dt>
              <dd>{exactRelease ? 'Exact release' : 'Unreleased development preview'}</dd>
            </div>
          </dl>
          <div className="evidence-schema-list" aria-labelledby="schema-identities-title">
            <h3 id="schema-identities-title">Bundled contracts</h3>
            <ul>
              {BUNDLED_SCHEMA_IDENTITIES.map((identity) => (
                <li key={identity}>
                  <code>{identity}</code>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section
          id="evidence-source"
          className="evidence-section"
          aria-labelledby="evidence-source-title"
        >
          <div className="evidence-section-heading">
            <p className="section-label">02 · Runtime boundary</p>
            <h2 id="evidence-source-title">Source and bounded operational health</h2>
            <p>
              {staticOnly
                ? 'The Evidence route never opens an observation stream. This offline package contains no service-health request capability.'
                : 'The Evidence route never opens an observation stream. This optional request reads one bounded same-origin operations.v1 projection and does not start provider polling.'}
            </p>
          </div>
          {staticOnly ? (
            <div
              className="evidence-health-state"
              data-health-state="static-only"
              role="note"
              aria-label="Offline service health"
            >
              <strong>Service health is unavailable in this package</strong>
              <p>
                No health request can be made from this self-contained offline package. Static
                build, license, limitation, and release-gate evidence remains available.
              </p>
            </div>
          ) : (
            <>
              <div className="evidence-health-actions">
                <button type="button" onClick={checkHealth} disabled={health.kind === 'checking'}>
                  {health.kind === 'checking'
                    ? 'Checking service health'
                    : 'Check service health once'}
                </button>
                <span>Manual action · one bounded request · no polling</span>
              </div>
              <HealthEvidence state={health} />
            </>
          )}
          <div className="evidence-callout">
            <strong>Provider status remains separately gated.</strong>
            <p>
              ADSB.lol is the reviewed technical candidate. Its public data is documented under ODbL
              1.0, but current terms, production coordination, and an approved request budget must
              be rechecked before release. A failed health check never switches this route into
              replay.
            </p>
          </div>
        </section>

        <section
          id="evidence-map"
          className="evidence-section"
          aria-labelledby="evidence-map-title"
        >
          <div className="evidence-section-heading">
            <p className="section-label">03 · Provenance</p>
            <h2 id="evidence-map-title">Regional map identity and licenses</h2>
            <p>
              This bounded summary is projected from the map manifest. The 776-entry asset allowlist
              is deliberately not bundled into this view.
            </p>
          </div>
          <dl className="evidence-definition-grid evidence-map-identity">
            <div>
              <dt>Map ID</dt>
              <dd>{mapSummary.mapId}</dd>
            </div>
            <div>
              <dt>Manifest schema</dt>
              <dd>{mapSummary.manifestSchemaVersion}</dd>
            </div>
            <div>
              <dt>Source date</dt>
              <dd>{mapSummary.sourceDate}</dd>
            </div>
            <div>
              <dt>Source tileset</dt>
              <dd>Protomaps {mapSummary.tilesetVersion}</dd>
            </div>
            <div>
              <dt>OSM replication time</dt>
              <dd>
                <time dateTime={mapSummary.osmReplicationTime}>
                  {mapSummary.osmReplicationTime}
                </time>
              </dd>
            </div>
            <div>
              <dt>Regional bounds</dt>
              <dd>{mapSummary.bounds.join(', ')}</dd>
            </div>
            <div>
              <dt>Zoom range</dt>
              <dd>
                {mapSummary.minZoom} to {mapSummary.maxZoom}
              </dd>
            </div>
            <div>
              <dt>Prepared assets</dt>
              <dd>
                {numberFormat.format(mapSummary.assetCount)} entries ·{' '}
                {formatBytes(mapSummary.totalBytes)}
              </dd>
            </div>
            <div>
              <dt>Addressed tiles</dt>
              <dd>{numberFormat.format(mapSummary.addressedTiles)}</dd>
            </div>
            <div>
              <dt>Preparation versions</dt>
              <dd>
                PMTiles CLI {mapSummary.cliVersion} · style {mapSummary.styleVersion}
              </dd>
            </div>
            <div className="evidence-wide-definition">
              <dt>Prepared source archive</dt>
              <dd>
                <code>{mapSummary.sourceUrl}</code>
              </dd>
            </div>
            <div className="evidence-wide-definition">
              <dt>Style and asset commits</dt>
              <dd>
                <code>{mapSummary.styleCommit}</code> · <code>{mapSummary.assetsCommit}</code>
              </dd>
            </div>
            <div className="evidence-wide-definition">
              <dt>Basemap SHA-256</dt>
              <dd>
                <code>{mapSummary.basemapSha256}</code>
              </dd>
            </div>
          </dl>

          <div
            className="evidence-table-scroll"
            role="region"
            aria-label="Source and asset license obligations"
            tabIndex={0}
          >
            <table className="evidence-license-table">
              <caption>Source, map, rendering, and font license obligations</caption>
              <thead>
                <tr>
                  <th scope="col">Asset or data</th>
                  <th scope="col">License</th>
                  <th scope="col">Evidence boundary</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Application source</th>
                  <td>MIT</td>
                  <td>The repository code license does not cover provider or map data.</td>
                </tr>
                <tr>
                  <th scope="row">ADSB.lol public API data candidate</th>
                  <td>
                    <a href="https://api.adsb.lol/docs">ODbL 1.0 documentation</a>
                  </td>
                  <td>Current terms and production coordination remain release gates.</td>
                </tr>
                <tr>
                  <th scope="row">Protomaps basemap and OpenStreetMap-derived data</th>
                  <td>
                    ODbL ·{' '}
                    <a href="https://www.openstreetmap.org/copyright">
                      © OpenStreetMap contributors
                    </a>
                  </td>
                  <td>Geographic context only, not an aviation navigation chart.</td>
                </tr>
                <tr>
                  <th scope="row">ESA WorldCover landcover</th>
                  <td>
                    <a href="https://esa-worldcover.org/en/data-access">CC BY 4.0</a>
                  </td>
                  <td>Bundled through the prepared basemap data license.</td>
                </tr>
                <tr>
                  <th scope="row">Map renderer, PMTiles, style, and sprites</th>
                  <td>BSD-3-Clause · CC0 · MIT</td>
                  <td>Exact prepared versions are pinned by the map manifest.</td>
                </tr>
                <tr>
                  <th scope="row">Inter, JetBrains Mono, and map Noto Sans glyphs</th>
                  <td>SIL Open Font License 1.1</td>
                  <td>Application fonts and prepared map glyph licenses remain distinct assets.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section
          id="evidence-boundaries"
          className="evidence-section"
          aria-labelledby="evidence-boundaries-title"
        >
          <div className="evidence-section-heading">
            <p className="section-label">04 · Boundaries</p>
            <h2 id="evidence-boundaries-title">Privacy, retention, and interpretation limits</h2>
            <p>These are product constraints, not optional disclaimers.</p>
          </div>
          <div className="evidence-boundary-grid">
            <article>
              <h3>Session-only observation detail</h3>
              <p>
                Aircraft identifiers, callsigns, positions, and browser trails are not persisted by
                the application server. Shared service storage is limited to control state and
                aggregate hourly metrics. Infrastructure account logs remain a separate platform
                policy boundary.
              </p>
            </article>
            <article>
              <h3>Public surveillance, not aircraft health</h3>
              <p>
                Missing, delayed, duplicated, or inaccurate observations cannot establish a fault,
                safety condition, affiliation, ownership, route, destination, or intent.
              </p>
            </article>
            <article>
              <h3>Regional observation scope</h3>
              <p>
                The three Georgia presets are product and abuse-control boundaries. This interface
                does not add military-only filters, owner lookup, persistent watchlists, or
                nationwide tracking.
              </p>
            </article>
            <article>
              <h3>Educational, non-operational system</h3>
              <p>
                This workbench is not approved for air-traffic, navigation, flight, maintenance,
                dispatch, safety, certification, or other operational decisions.
              </p>
            </article>
          </div>
        </section>

        <section
          id="evidence-gates"
          className="evidence-section"
          aria-labelledby="evidence-gates-title"
        >
          <div className="evidence-section-heading">
            <p className="section-label">05 · Release truth</p>
            <h2 id="evidence-gates-title">Implementation, execution, and release gate ledger</h2>
            <p>
              Implemented code, an executed local check, and an approved release are different
              facts. This static ledger does not query CI, GitHub, Cloudflare, or a provider
              account.
            </p>
          </div>
          <div
            className="evidence-table-scroll"
            role="region"
            aria-label="Implementation, execution, and release gate ledger"
            tabIndex={0}
          >
            <table className="evidence-gate-table">
              <caption>
                Development gate ledger with explicit current and historical boundaries
              </caption>
              <thead>
                <tr>
                  <th scope="col">Gate</th>
                  <th scope="col">Implementation</th>
                  <th scope="col">Execution</th>
                  <th scope="col">Release</th>
                  <th scope="col">Evidence and remaining boundary</th>
                </tr>
              </thead>
              <tbody>
                {releaseGates.map((gate) => (
                  <tr key={gate.id}>
                    <th scope="row">{gate.gate}</th>
                    <td>
                      <span className="evidence-status" data-status={gate.implementation}>
                        {statusLabel(gate.implementation)}
                      </span>
                    </td>
                    <td>
                      <span className="evidence-status" data-status={gate.execution}>
                        {statusLabel(gate.execution)}
                      </span>
                    </td>
                    <td>
                      <span className="evidence-status" data-status={gate.release}>
                        {statusLabel(gate.release)}
                      </span>
                    </td>
                    <td>{gate.evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}

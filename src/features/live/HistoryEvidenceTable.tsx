import type { HistoryReceiptRow } from '../../live/historyPresentation';

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function Timestamp({ value }: { value: string }) {
  return <time dateTime={value}>{value.replace('T', ' ').replace('Z', ' UTC')}</time>;
}

function optionalMeasurement(value: number | undefined, unit: string): string {
  return value === undefined ? 'Unknown' : `${number.format(value)} ${unit}`;
}

interface Props {
  rows: readonly HistoryReceiptRow[];
  selectedSequence: number | undefined;
  onSelectSequence(sequence: number): void;
}

/** Complete text equivalent for the two live session charts. */
export function HistoryEvidenceTable({ rows, selectedSequence, onSelectSequence }: Props) {
  if (rows.length === 0) return <p>No retained receipt evidence is available for this track.</p>;
  return (
    <section className="history-evidence" aria-labelledby="history-evidence-title">
      <div className="investigation-section-heading">
        <h3 id="history-evidence-title">Receipt evidence table</h3>
        <span>{rows.length} retained</span>
      </div>
      <p className="muted">
        Every row is one backend receipt. Position and measurements keep their own source times.
      </p>
      <div
        className="history-table-scroll"
        role="region"
        aria-label="Retained receipt evidence"
        tabIndex={0}
      >
        <table className="history-table" role="table">
          <caption className="sr-only">
            Retained session receipts with independent position and measurement evidence.
          </caption>
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader">
                Receipt
              </th>
              <th scope="col" role="columnheader">
                Delivery times
              </th>
              <th scope="col" role="columnheader">
                Position evidence
              </th>
              <th scope="col" role="columnheader">
                Measurement evidence
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {[...rows].reverse().map((row) => (
              <tr key={row.sequence} role="row" data-selected={row.sequence === selectedSequence}>
                <th scope="row" role="rowheader">
                  <button
                    type="button"
                    className="receipt-link"
                    aria-pressed={row.sequence === selectedSequence}
                    onClick={() => onSelectSequence(row.sequence)}
                  >
                    #{row.sequence}
                  </button>
                </th>
                <td role="cell">
                  <span className="mobile-cell-label" aria-hidden="true">
                    Delivery times
                  </span>
                  <div className="history-cell-content">
                    <span>Backend</span>
                    <Timestamp value={row.receivedAt} />
                    <span>Provider snapshot</span>
                    <Timestamp value={row.providerGeneratedAt} />
                  </div>
                </td>
                <td role="cell">
                  <span className="mobile-cell-label" aria-hidden="true">
                    Position evidence
                  </span>
                  <div className="history-cell-content">
                    {row.positionObservedAt ? (
                      <>
                        <Timestamp value={row.positionObservedAt} />
                        <strong>
                          {row.latitude?.toFixed(4)}, {row.longitude?.toFixed(4)}
                        </strong>
                        {row.positionBreakBefore && <span>Position segment begins here</span>}
                      </>
                    ) : (
                      <span>Not present in this receipt</span>
                    )}
                  </div>
                </td>
                <td role="cell">
                  <span className="mobile-cell-label" aria-hidden="true">
                    Measurement evidence
                  </span>
                  <div className="history-cell-content">
                    {row.measurementObservedAt ? (
                      <>
                        <Timestamp value={row.measurementObservedAt} />
                        <strong>
                          {optionalMeasurement(row.barometricAltitudeFeet, 'ft')} ·{' '}
                          {optionalMeasurement(row.groundSpeedKnots, 'kt')}
                        </strong>
                        {row.measurementBreakBefore && <span>Measurement segment begins here</span>}
                      </>
                    ) : (
                      <span>Not present in this receipt</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

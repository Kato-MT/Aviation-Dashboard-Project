import { useId } from 'react';
import type { LiveQualityEvent } from '../../live/types';

const MAX_VISIBLE_EVENTS = 5;

const qualityKindLabels: Readonly<Record<LiveQualityEvent['kind'], string>> = {
  'stale-contact': 'Stale contact',
  'stale-position': 'Stale position',
  'missing-position': 'Missing position',
  'provider-time-regression': 'Provider time regression',
  'time-uncertain': 'Time uncertain',
  'upstream-degraded': 'Upstream degraded',
};

interface Props {
  events: readonly LiveQualityEvent[];
}

function eventTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function readableTimestamp(value: string): string {
  return value.replace('T', ' ').replace('Z', ' UTC');
}

/** A bounded, text-complete record of quality transitions in the current regional session. */
export function SessionQualityLedger({ events }: Props) {
  const titleId = useId();
  const visibleEvents = events
    .map((event, inputIndex) => ({ event, inputIndex }))
    .sort((left, right) => {
      const timeDifference = eventTime(right.event.timestamp) - eventTime(left.event.timestamp);
      return timeDifference || right.inputIndex - left.inputIndex;
    })
    .slice(0, MAX_VISIBLE_EVENTS);

  return (
    <section className="session-quality-ledger" aria-labelledby={titleId}>
      <div className="investigation-section-heading">
        <h3 id={titleId}>Regional session quality</h3>
        <span>{visibleEvents.length} latest</span>
      </div>
      <p className="muted quality-ledger-boundary">
        These events describe the quality of data received in this regional browser session. They do
        not describe aircraft condition, maintenance, or safety.
      </p>

      {visibleEvents.length === 0 ? (
        <p className="quality-ledger-empty">
          No quality transitions recorded in this browser session.
        </p>
      ) : (
        <ol className="quality-event-list" aria-label="Latest regional session quality events">
          {visibleEvents.map(({ event, inputIndex }) => (
            <li
              className="quality-event"
              data-quality-kind={event.kind}
              key={`${event.code}:${event.timestamp}:${event.aircraftId ?? 'regional'}:${inputIndex}`}
            >
              <div className="quality-event-heading">
                <span className="quality-event-kind">{qualityKindLabels[event.kind]}</span>
                <code>{event.code}</code>
              </div>
              <p>{event.message}</p>
              <div className="quality-event-metadata">
                <span>Region {event.regionId}</span>
                {event.aircraftId && <span>Aircraft {event.aircraftId.toUpperCase()}</span>}
                <span>
                  Recorded{' '}
                  <time dateTime={event.timestamp}>{readableTimestamp(event.timestamp)}</time>
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

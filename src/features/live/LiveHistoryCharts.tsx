import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { SessionSeries } from '../../live/historyPresentation';
import type { LiveChartRenderer } from './liveChartRenderer';

type RendererModule = Pick<typeof import('./liveChartRenderer'), 'createLiveChartRenderer'>;
const defaultLoadRenderer = () => import('./liveChartRenderer');
export const CHART_LOAD_TIMEOUT_MS = 15_000;
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

interface Props {
  altitude: SessionSeries;
  speed: SessionSeries;
  selectedSequence: number | undefined;
  selectedMeasurementObservedAt?: string | undefined;
  onSelectSequence(sequence: number): void;
  loadRenderer?: () => Promise<RendererModule>;
}

export function LiveHistoryCharts({
  altitude,
  speed,
  selectedSequence,
  selectedMeasurementObservedAt,
  onSelectSequence,
  loadRenderer = defaultLoadRenderer,
}: Props) {
  const altitudeCanvas = useRef<HTMLCanvasElement>(null);
  const speedCanvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<LiveChartRenderer | undefined>(undefined);
  const loadDeadline = useRef<number | undefined>(undefined);
  const latest = useRef({ altitude, speed, selectedSequence, selectedMeasurementObservedAt });
  const latestSelect = useRef(onSelectSequence);
  latest.current = { altitude, speed, selectedSequence, selectedMeasurementObservedAt };
  latestSelect.current = onSelectSequence;
  const instructionsId = useId();
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [attempt, setAttempt] = useState(0);
  const selectableSequences = useMemo(
    () =>
      [
        ...altitude.segments.flatMap((segment) => segment.map(({ sequence }) => sequence)),
        ...speed.segments.flatMap((segment) => segment.map(({ sequence }) => sequence)),
      ]
        .filter((sequence, index, values) => values.indexOf(sequence) === index)
        .sort((left, right) => left - right),
    [altitude, speed],
  );
  const selectedAltitude = useMemo(
    () =>
      altitude.segments
        .flatMap((segment) => segment)
        .find((point) => point.sequence === selectedSequence),
    [altitude, selectedSequence],
  );
  const selectedSpeed = useMemo(
    () =>
      speed.segments
        .flatMap((segment) => segment)
        .find((point) => point.sequence === selectedSequence),
    [speed, selectedSequence],
  );
  const selectedTime =
    selectedMeasurementObservedAt ?? selectedAltitude?.observedAt ?? selectedSpeed?.observedAt;
  useEffect(() => {
    let active = true;
    let owned: LiveChartRenderer | undefined;
    const release = () => {
      const previous = owned;
      owned = undefined;
      if (renderer.current === previous) renderer.current = undefined;
      previous?.destroy();
    };
    const clearDeadline = () => {
      if (loadDeadline.current === undefined) return;
      window.clearTimeout(loadDeadline.current);
      loadDeadline.current = undefined;
    };
    const fail = () => {
      if (!active) return;
      active = false;
      clearDeadline();
      setStatus('unavailable');
      queueMicrotask(release);
    };
    loadDeadline.current = window.setTimeout(fail, CHART_LOAD_TIMEOUT_MS);
    setStatus('loading');
    void Promise.resolve()
      .then(loadRenderer)
      .then(({ createLiveChartRenderer }) => {
        if (!active || !altitudeCanvas.current || !speedCanvas.current) return;
        try {
          owned = createLiveChartRenderer(
            { altitude: altitudeCanvas.current, speed: speedCanvas.current },
            (sequence) => latestSelect.current(sequence),
          );
          owned.setSeries(latest.current.altitude, latest.current.speed);
          owned.setSelection(
            latest.current.selectedSequence,
            latest.current.selectedMeasurementObservedAt,
          );
          if (active) {
            clearDeadline();
            renderer.current = owned;
            setStatus('ready');
          } else release();
        } catch {
          fail();
        }
      }, fail);
    return () => {
      active = false;
      clearDeadline();
      release();
    };
  }, [attempt, loadRenderer]);
  useEffect(() => {
    try {
      renderer.current?.setSeries(altitude, speed);
      renderer.current?.setSelection(
        latest.current.selectedSequence,
        latest.current.selectedMeasurementObservedAt,
      );
    } catch {
      renderer.current?.destroy();
      renderer.current = undefined;
      setStatus('unavailable');
    }
  }, [altitude, speed]);
  useEffect(() => {
    try {
      renderer.current?.setSelection(selectedSequence, selectedMeasurementObservedAt);
    } catch {
      renderer.current?.destroy();
      renderer.current = undefined;
      setStatus('unavailable');
    }
  }, [selectedSequence, selectedMeasurementObservedAt]);
  const navigate = (direction: 'previous' | 'next' | 'first' | 'last') => {
    if (selectableSequences.length === 0) return;
    const current = selectedSequence ?? selectableSequences.at(-1)!;
    const target =
      direction === 'first'
        ? selectableSequences[0]
        : direction === 'last'
          ? selectableSequences.at(-1)
          : direction === 'previous'
            ? ([...selectableSequences].reverse().find((sequence) => sequence < current) ??
              selectableSequences[0])
            : (selectableSequences.find((sequence) => sequence > current) ??
              selectableSequences.at(-1));
    if (target !== undefined) onSelectSequence(target);
  };
  if (status === 'unavailable')
    return (
      <section className="live-chart-fallback" role="status">
        <h3>Session charts unavailable</h3>
        <p>The exact receipt timeline and evidence table remain available.</p>
        <button
          type="button"
          onClick={() => {
            setStatus('loading');
            setAttempt((value) => value + 1);
          }}
        >
          Retry session charts
        </button>
      </section>
    );
  return (
    <section
      className="live-history-charts"
      aria-label="Selected aircraft session charts"
      aria-describedby={instructionsId}
      tabIndex={selectableSequences.length > 0 ? 0 : -1}
      onKeyDown={(event) => {
        const action =
          event.key === 'ArrowLeft'
            ? 'previous'
            : event.key === 'ArrowRight'
              ? 'next'
              : event.key === 'Home'
                ? 'first'
                : event.key === 'End'
                  ? 'last'
                  : undefined;
        if (!action) return;
        event.preventDefault();
        navigate(action);
      }}
    >
      <p id={instructionsId} className="sr-only">
        Use Left and Right Arrow, Home, or End to select an exact retained measurement receipt. The
        evidence table provides the same values as text.
      </p>
      <p className="sr-only" aria-live="polite">
        {selectedSequence === undefined
          ? 'No exact receipt selected.'
          : `Receipt ${selectedSequence}. Measurement time ${selectedTime ?? 'unknown'}. Barometric altitude ${selectedAltitude ? `${selectedAltitude.value} feet` : 'unavailable'}. Ground speed ${selectedSpeed ? `${selectedSpeed.value} knots` : 'unavailable'}.`}
      </p>
      {status === 'loading' && <p role="status">Loading session charts.</p>}
      <div className="live-history-chart">
        <h3>
          Barometric altitude <span>feet</span>
        </h3>
        <div className="live-chart-canvas">
          <canvas
            ref={altitudeCanvas}
            role="img"
            aria-label={`Barometric altitude session chart with ${altitude.pointCount} received measurement points.`}
          />
        </div>
        {selectedSequence !== undefined && (
          <p className="chart-selection-value">
            Receipt #{selectedSequence}:{' '}
            {selectedAltitude
              ? `${number.format(selectedAltitude.value)} ft at ${selectedAltitude.observedAt}`
              : 'No barometric altitude value in this receipt.'}
          </p>
        )}
        {altitude.pointCount === 0 && <p>No retained barometric altitude measurements.</p>}
      </div>
      <div className="live-history-chart">
        <h3>
          Ground speed <span>knots</span>
        </h3>
        <div className="live-chart-canvas">
          <canvas
            ref={speedCanvas}
            role="img"
            aria-label={`Ground-speed session chart with ${speed.pointCount} received measurement points.`}
          />
        </div>
        {selectedSequence !== undefined && (
          <p className="chart-selection-value">
            Receipt #{selectedSequence}:{' '}
            {selectedSpeed
              ? `${number.format(selectedSpeed.value)} kt at ${selectedSpeed.observedAt}`
              : 'No ground-speed value in this receipt.'}
          </p>
        )}
        {speed.pointCount === 0 && <p>No retained ground-speed measurements.</p>}
      </div>
    </section>
  );
}

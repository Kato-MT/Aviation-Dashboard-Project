import { useEffect, useId, useRef, useState } from 'react';
import {
  InvestigationChartRenderer,
  type InvestigationComparisonWaveform,
  type InvestigationOverlayVisibility,
  type InvestigationSeries,
} from '../../ui/investigationCharts';

export interface InvestigationChartsProps {
  series: InvestigationSeries;
  overlays?: Partial<InvestigationOverlayVisibility> | undefined;
  comparison?: InvestigationComparisonWaveform | undefined;
  sampleIndex: number;
  onSeek: (sampleIndex: number) => void;
}

function closeRenderer(renderer: InvestigationChartRenderer | undefined): void {
  try {
    renderer?.destroy();
  } catch (error) {
    // Cleanup cannot recover in place, but the failure remains observable for diagnostics.
    console.error('Investigation chart cleanup failed.', error);
  }
}

/**
 * Owns the imperative Chart.js renderer for the React investigation surface.
 * Evidence data and the selected sample remain owned by the parent session.
 */
export function InvestigationCharts({
  series,
  overlays,
  comparison,
  sampleIndex,
  onSeek,
}: InvestigationChartsProps) {
  const reactId = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const stateCanvasId = `lab-investigation-state-chart-${reactId}`;
  const residualCanvasId = `lab-investigation-residual-chart-${reactId}`;
  const stateCanvas = useRef<HTMLCanvasElement>(null);
  const residualCanvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<InvestigationChartRenderer | undefined>(undefined);
  const latestOnSeek = useRef(onSeek);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    latestOnSeek.current = onSeek;
  }, [onSeek]);

  useEffect(() => {
    if (!stateCanvas.current || !residualCanvas.current) return;
    let owned: InvestigationChartRenderer | undefined;
    try {
      owned = new InvestigationChartRenderer({
        stateCanvasId,
        residualCanvasId,
        theme: 'light',
        onSeek: (nextSampleIndex) => latestOnSeek.current(nextSampleIndex),
      });
      renderer.current = owned;
    } catch {
      closeRenderer(owned);
      setFailed(true);
    }
    return () => {
      if (renderer.current === owned) renderer.current = undefined;
      closeRenderer(owned);
    };
  }, [attempt, residualCanvasId, stateCanvasId]);

  useEffect(() => {
    const owned = renderer.current;
    if (!owned) return;
    try {
      owned.render(series, { overlays, comparison });
    } catch {
      if (renderer.current === owned) renderer.current = undefined;
      closeRenderer(owned);
      setFailed(true);
    }
  }, [attempt, comparison, overlays, series]);

  useEffect(() => {
    const owned = renderer.current;
    if (!owned) return;
    try {
      owned.setCursor(sampleIndex);
    } catch {
      if (renderer.current === owned) renderer.current = undefined;
      closeRenderer(owned);
      setFailed(true);
    }
  }, [attempt, sampleIndex, series]);

  if (failed) {
    return (
      <section className="lab-chart-fallback" role="alert" aria-live="assertive">
        <h2>Investigation charts unavailable</h2>
        <p>The selected sample, evidence tables, and exports remain available.</p>
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            setAttempt((value) => value + 1);
          }}
        >
          Retry investigation charts
        </button>
      </section>
    );
  }

  return (
    <section className="lab-charts lab-investigation-charts" aria-label="Investigation charts">
      <div className="lab-chart lab-investigation-state-chart">
        <h3>
          Observed and predicted state <span>linked sample comparison</span>
        </h3>
        <div className="lab-chart-canvas">
          <canvas
            ref={stateCanvas}
            id={stateCanvasId}
            aria-label="Investigation observed and predicted state chart. Use arrow keys to change the linked sample."
            role="img"
          />
        </div>
      </div>
      <div className="lab-chart lab-investigation-residual-chart">
        <h3>
          Normalized sensor residual <span>linked sample evidence</span>
        </h3>
        <div className="lab-chart-canvas">
          <canvas
            ref={residualCanvas}
            id={residualCanvasId}
            aria-label="Investigation normalized sensor residual chart. Use arrow keys to change the linked sample."
            role="img"
          />
        </div>
      </div>
    </section>
  );
}

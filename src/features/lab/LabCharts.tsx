import { useEffect, useRef, useState } from 'react';
import type { Finding, TelemetrySample } from '../../core';
import { TelemetryCharts } from '../../ui/charts';

interface Props {
  samples: readonly TelemetrySample[];
  findings: readonly Finding[];
  cursor: number;
}

export function LabCharts({ samples, findings, cursor }: Props) {
  const altitude = useRef<HTMLCanvasElement>(null);
  const speed = useRef<HTMLCanvasElement>(null);
  const fuel = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<TelemetryCharts | undefined>(undefined);
  const latest = useRef({ samples, findings, cursor });
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    latest.current = { samples, findings, cursor };
  }, [samples, findings, cursor]);
  useEffect(() => {
    if (!altitude.current || !speed.current || !fuel.current) return;
    let owned: TelemetryCharts | undefined;
    try {
      owned = new TelemetryCharts(
        { altitude: altitude.current, speed: speed.current, fuel: fuel.current },
        'light',
      );
      owned.setRun(latest.current.samples, latest.current.findings);
      owned.setCursor(latest.current.cursor);
      renderer.current = owned;
    } catch {
      owned?.destroy();
      setFailed(true);
    }
    return () => {
      if (renderer.current === owned) renderer.current = undefined;
      owned?.destroy();
    };
  }, [attempt]);
  useEffect(() => {
    try {
      renderer.current?.setRun(samples, findings);
      renderer.current?.setCursor(latest.current.cursor);
    } catch {
      renderer.current?.destroy();
      renderer.current = undefined;
      setFailed(true);
    }
  }, [samples, findings]);
  useEffect(() => {
    try {
      renderer.current?.setCursor(cursor);
    } catch {
      renderer.current?.destroy();
      renderer.current = undefined;
      setFailed(true);
    }
  }, [cursor]);
  if (failed)
    return (
      <section className="lab-chart-fallback" role="status">
        <h2>Charts unavailable</h2>
        <p>The selected sample, findings and exports remain available.</p>
        <button
          type="button"
          onClick={() => {
            setFailed(false);
            setAttempt((value) => value + 1);
          }}
        >
          Retry charts
        </button>
      </section>
    );
  return (
    <section className="lab-charts" aria-label="Synthetic telemetry charts">
      <div className="lab-chart">
        <h3>
          Altitude <span>feet</span>
        </h3>
        <div className="lab-chart-canvas">
          <canvas
            ref={altitude}
            aria-label="Synthetic altitude samples. Exact selected values appear above."
            role="img"
          />
        </div>
      </div>
      <div className="lab-chart">
        <h3>
          Airspeed <span>knots</span>
        </h3>
        <div className="lab-chart-canvas">
          <canvas
            ref={speed}
            aria-label="Synthetic airspeed samples. Exact selected values appear above."
            role="img"
          />
        </div>
      </div>
      <div className="lab-chart">
        <h3>
          Fuel <span>percent</span>
        </h3>
        <div className="lab-chart-canvas">
          <canvas
            ref={fuel}
            aria-label="Synthetic fuel samples. Exact selected values appear above."
            role="img"
          />
        </div>
      </div>
    </section>
  );
}

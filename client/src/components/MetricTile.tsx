import type React from 'react';

export function MetricTile({ label, value, detail, progress, accent }: { label: string; value: string; detail?: string; progress: number; accent: string }) {
  const clampedProgress = Math.max(0, Math.min(100, Math.round(progress)));

  return (
    <div className={`metric-tile ${accent}`}>
      <GaugeArc progress={clampedProgress} size="large">
        <strong className="metric-value">{value}</strong>
      </GaugeArc>
      <span className="metric-label">{label}</span>
      {detail && <small className="metric-detail">{detail}</small>}
    </div>
  );
}

function GaugeArc({ children, progress, size }: { children: React.ReactNode; progress: number; size: 'large' }) {
  const clampedProgress = Math.max(0, Math.min(100, Math.round(progress)));

  return (
    <span className={`gauge-arc ${size}`} style={{ '--gauge-progress': clampedProgress } as React.CSSProperties}>
      <svg viewBox="0 0 160 94" aria-hidden="true">
        <path className="gauge-track" d="M 27 80 A 53 53 0 0 1 133 80" pathLength="100" />
        <path className="gauge-fill" d="M 27 80 A 53 53 0 0 1 133 80" pathLength="100" />
      </svg>
      <span className="gauge-center">{children}</span>
    </span>
  );
}

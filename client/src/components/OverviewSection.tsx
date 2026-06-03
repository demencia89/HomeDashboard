import type React from 'react';
import { ArrowDown, ArrowUp, EyeOff } from 'lucide-react';

export function OverviewSection({
  title,
  tools,
  children,
  canMoveUp,
  canMoveDown,
  onHide,
  onMoveUp,
  onMoveDown,
}: {
  title: string;
  tools?: React.ReactNode;
  children: React.ReactNode;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onHide: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  return (
    <section className="overview-section">
      <div className="overview-section-heading">
        <h3>{title}</h3>
        <div className="overview-section-actions">
          {tools}
          <button type="button" className="section-icon-button" title={`Move ${title} up`} onClick={onMoveUp} disabled={!canMoveUp}>
            <ArrowUp size={14} />
          </button>
          <button type="button" className="section-icon-button" title={`Move ${title} down`} onClick={onMoveDown} disabled={!canMoveDown}>
            <ArrowDown size={14} />
          </button>
          <button type="button" className="section-icon-button" title={`Hide ${title}`} onClick={onHide}>
            <EyeOff size={14} />
          </button>
        </div>
      </div>
      {children}
    </section>
  );
}



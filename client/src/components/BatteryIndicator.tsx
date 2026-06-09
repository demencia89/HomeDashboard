import { Battery, BatteryCharging } from 'lucide-react';
import type { BatteryMetric } from '../types';

function hasBatteryMetric(battery: BatteryMetric | null | undefined): battery is BatteryMetric {
  return typeof battery?.percentage === 'number' && Number.isFinite(battery.percentage);
}

function formatBatteryPercentage(battery: BatteryMetric | null | undefined): string {
  if (!hasBatteryMetric(battery)) {
    return '--';
  }

  return `${Math.round(clampBatteryPercentage(battery.percentage))}%`;
}

function batteryStateClass(battery: BatteryMetric | null | undefined): 'charging' | 'full' | 'low' | 'critical' | 'normal' {
  if (!hasBatteryMetric(battery)) {
    return 'normal';
  }

  const status = battery.status.toLowerCase();
  const percentage = clampBatteryPercentage(battery.percentage);

  if (status === 'charging') {
    return 'charging';
  }

  if (status === 'full') {
    return 'full';
  }

  if (percentage <= 10) {
    return 'critical';
  }

  if (percentage <= 25) {
    return 'low';
  }

  return 'normal';
}

export function BatteryPill({ battery, className = '' }: { battery: BatteryMetric | null | undefined; className?: string }) {
  if (!hasBatteryMetric(battery)) {
    return null;
  }

  const state = batteryStateClass(battery);
  const Icon = state === 'charging' ? BatteryCharging : Battery;
  const title = `${battery.label}: ${formatBatteryPercentage(battery)} ${formatBatteryStatus(battery.status)}`;

  return (
    <span className={['battery-pill', state, className].filter(Boolean).join(' ')} title={title} aria-label={title}>
      <Icon size={13} />
      <span>{formatBatteryPercentage(battery)}</span>
    </span>
  );
}

function formatBatteryStatus(status: string): string {
  const normalized = status.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return 'Unknown';
  }

  return normalized
    .split(' ')
    .map((word) => word ? `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}` : '')
    .join(' ');
}

function clampBatteryPercentage(value: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
}

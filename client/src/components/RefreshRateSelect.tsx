import type { RefreshRate } from '../types';
import { refreshRateOptions } from '../constants';

export function RefreshRateSelect({ value, onChange }: { value: RefreshRate; onChange: (value: RefreshRate) => void }) {
  return (
    <label className="refresh-picker" title="Automatic refresh rate">
      <select
        className="refresh-rate"
        aria-label="Automatic refresh rate"
        value={value}
        onChange={(event) => onChange(Number(event.target.value) as RefreshRate)}
      >
        {refreshRateOptions.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

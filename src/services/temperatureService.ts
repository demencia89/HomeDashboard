import { execFile } from 'node:child_process';
import type { ConnectConfig } from 'ssh2';
import type { KeyStore } from '../storage/key-store.js';
import type { ServerProfileStore } from './sshConnection.js';
import { execSshCommand, normalizeSshError, resolveSshTarget, ServerNotFoundError, shellQuote, withSshClient } from './sshConnection.js';

export interface TemperatureSnapshot {
  ok: boolean;
  collectedAt: string;
  readings: TemperatureReading[];
  summary: TemperatureSummary;
  error?: string;
}

export interface TemperatureReading {
  source: string;
  label: string;
  celsius: number;
  maxCelsius?: number;
  criticalCelsius?: number;
  status?: string;
  path?: string;
}

export interface TemperatureSummary {
  count: number;
  hottest?: TemperatureReading;
  averageCelsius?: number;
}

const TEMPERATURE_TIMEOUT_MS = 8_000;
const TEMPERATURE_MAX_BUFFER_BYTES = 512 * 1024;

export function buildRawTemperatureCommand(): string {
  return `
export LC_ALL=C LANG=C
for input in /sys/class/hwmon/hwmon*/temp*_input; do
  [ -r "$input" ] || continue
  dir="\${input%/*}"
  sensor="\${input##*/}"
  index="\${sensor#temp}"
  index="\${index%_input}"
  name="$(cat "$dir/name" 2>/dev/null || printf '%s' "\${dir##*/}")"
  label="$(cat "$dir/temp\${index}_label" 2>/dev/null || printf '%s' "$name")"
  value="$(cat "$input" 2>/dev/null || true)"
  max="$(cat "$dir/temp\${index}_max" 2>/dev/null || true)"
  crit="$(cat "$dir/temp\${index}_crit" 2>/dev/null || true)"
  alarm="$(cat "$dir/temp\${index}_crit_alarm" "$dir/temp\${index}_alarm" 2>/dev/null | sed -n '1p' || true)"
  [ -n "$value" ] && printf 'hwmon\\t%s %s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$name" "$label" "$value" "$max" "$crit" "$alarm" "$input"
done

for zone in /sys/class/thermal/thermal_zone*; do
  [ -r "$zone/temp" ] || continue
  label="$(cat "$zone/type" 2>/dev/null || printf '%s' "\${zone##*/}")"
  value="$(cat "$zone/temp" 2>/dev/null || true)"
  mode="$(cat "$zone/mode" 2>/dev/null || true)"
  policy="$(cat "$zone/policy" 2>/dev/null || true)"
  status="$mode"
  [ -n "$policy" ] && status="\${status:+$status, }$policy"
  [ -n "$value" ] && printf 'thermal\\t%s\\t%s\\t\\t\\t%s\\t%s/temp\\n' "$label" "$value" "$status" "$zone"
done

for supply in /sys/class/power_supply/*; do
  [ -d "$supply" ] || continue
  supply_name="\${supply##*/}"
  for file in temp temp_ambient temp_alert_min temp_alert_max; do
    [ -r "$supply/$file" ] || continue
    value="$(cat "$supply/$file" 2>/dev/null || true)"
    [ -n "$value" ] && printf 'power\\t%s %s\\t%s\\t\\t\\t\\t%s/%s\\n' "$supply_name" "$file" "$value" "$supply" "$file"
  done
done

if command -v vcgencmd >/dev/null 2>&1; then
  vcgencmd measure_temp 2>/dev/null | sed -n "s/^temp=\\([0-9.]*\\).*$/raspberry-pi\\tvcgencmd temp\\t\\1\\t\\t\\t\\tvcgencmd/p"
fi
`.trim();
}

export function buildTemperatureCommand(): string {
  return `/bin/sh -lc ${shellQuote(buildRawTemperatureCommand())}`;
}

export async function getTemperatureSnapshot(store: ServerProfileStore, keyStore: KeyStore, serverId: string): Promise<TemperatureSnapshot> {
  try {
    const target = await resolveSshTarget(store, keyStore, serverId);
    const raw = target.isLocal
      ? await getLocalTemperatureOutput()
      : await getRemoteTemperatureOutput(target.connectConfig);
    const readings = parseTemperatureReadings(raw);

    return {
      ok: true,
      collectedAt: new Date().toISOString(),
      readings,
      summary: summarizeTemperatures(readings),
    };
  } catch (error) {
    if (error instanceof ServerNotFoundError) {
      throw error;
    }

    return {
      ok: false,
      collectedAt: new Date().toISOString(),
      readings: [],
      summary: summarizeTemperatures([]),
      error: error instanceof Error ? normalizeSshError(error.message) : 'Unable to read temperature sensors.',
    };
  }
}

export function parseTemperatureReadings(raw: string): TemperatureReading[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const columns = line.split('\t');
      const [source = 'sensor', label = 'temperature', value = '', max = '', critical = '', status = '', path = ''] = columns.length === 2
        ? ['sensor', columns[0], columns[1], '', '', '', '']
        : columns;
      const celsius = parseTemperatureValue(value);

      if (!Number.isFinite(celsius) || celsius < -100 || celsius > 200) {
        return [];
      }

      const reading: TemperatureReading = {
        source: normalizeText(source, 'sensor'),
        label: normalizeText(label, 'temperature'),
        celsius: roundTo(celsius, 1),
      };
      const maxCelsius = parseTemperatureValue(max);
      const criticalCelsius = parseTemperatureValue(critical);

      if (Number.isFinite(maxCelsius)) {
        reading.maxCelsius = roundTo(maxCelsius, 1);
      }

      if (Number.isFinite(criticalCelsius)) {
        reading.criticalCelsius = roundTo(criticalCelsius, 1);
      }

      if (status.trim()) {
        reading.status = status.trim() === '1' ? 'alarm' : status.trim() === '0' ? 'normal' : normalizeText(status, 'status');
      }

      if (path.trim()) {
        reading.path = path.trim();
      }

      return [reading];
    })
    .sort((a, b) => b.celsius - a.celsius || a.source.localeCompare(b.source) || a.label.localeCompare(b.label));
}

function getRemoteTemperatureOutput(connectConfig: ConnectConfig): Promise<string> {
  return withSshClient(connectConfig, async (client) => {
    const result = await execSshCommand(client, buildTemperatureCommand(), {
      timeoutMs: TEMPERATURE_TIMEOUT_MS,
      label: 'Temperature snapshot',
    });

    return combineOutput(result.stdout, result.stderr);
  });
}

function getLocalTemperatureOutput(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/sh',
      ['-lc', buildRawTemperatureCommand()],
      { timeout: TEMPERATURE_TIMEOUT_MS, maxBuffer: TEMPERATURE_MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || stdout || error.message));
          return;
        }

        resolve(combineOutput(stdout, stderr));
      },
    );
  });
}

function summarizeTemperatures(readings: TemperatureReading[]): TemperatureSummary {
  if (!readings.length) {
    return { count: 0 };
  }

  const hottest = readings.reduce((current, reading) => reading.celsius > current.celsius ? reading : current, readings[0]);
  const total = readings.reduce((sum, reading) => sum + reading.celsius, 0);

  return {
    count: readings.length,
    hottest,
    averageCelsius: roundTo(total / readings.length, 1),
  };
}

function parseTemperatureValue(raw: string): number {
  const value = Number.parseFloat(raw);

  if (!Number.isFinite(value)) {
    return Number.NaN;
  }

  if (Math.abs(value) >= 1_000) {
    return value / 1_000;
  }

  if (Math.abs(value) > 200 && Math.abs(value) < 1_000) {
    return value / 10;
  }

  return value;
}

function normalizeText(value: string, fallback: string): string {
  return value.replace(/\s+/g, ' ').trim() || fallback;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function combineOutput(stdout: string, stderr: string): string {
  return `${stdout}${stderr}`.trimEnd();
}

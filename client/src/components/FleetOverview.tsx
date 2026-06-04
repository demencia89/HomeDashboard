import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, Clock, ExternalLink, HardDrive, Network, RefreshCw, Thermometer, X, XCircle } from 'lucide-react';
import type { FleetMetricMode, RefreshRate, ServerProfile, SystemMetrics, TemperatureReading, TemperatureSnapshot } from '../types';
import { findDiskByMount } from '../lib/disks';
import { createDragPreview, type DragPreviewHandle } from '../lib/dragPreview';
import { formatBytes } from '../lib/format';
import { isValidTerminalDimensions } from '../lib/terminal';
import { buildWebSocketUrl } from '../lib/websocket';
import { RefreshRateSelect } from './RefreshRateSelect';
import { MetricTile } from './MetricTile';
import { ServerIconBadge } from './ServerIcon';

type XTerm = import('@xterm/xterm').Terminal;
type FitAddon = import('@xterm/addon-fit').FitAddon;

export interface NethogsDialogState {
  server: ServerProfile;
}

export interface TemperatureDialogState {
  server: ServerProfile;
}

export function FleetOverview({
  servers,
  cachedMetrics,
  refreshRate,
  metricMode,
  preferredTemperatureByServer,
  defaultDiskMountByServer,
  onRefreshRateChange,
  onMetricModeChange,
  onPreferredTemperatureChange,
  onSelect,
  onRefreshMetrics,
  onReorder,
}: {
  servers: ServerProfile[];
  cachedMetrics: Record<string, SystemMetrics>;
  refreshRate: RefreshRate;
  metricMode: FleetMetricMode;
  preferredTemperatureByServer: Record<string, string>;
  defaultDiskMountByServer: Record<string, string>;
  onRefreshRateChange: (value: RefreshRate) => void;
  onMetricModeChange: (value: FleetMetricMode) => void;
  onPreferredTemperatureChange: (value: Record<string, string>) => void;
  onSelect: (server: ServerProfile) => void;
  onRefreshMetrics: (serverIds: string[]) => Promise<void>;
  onReorder: (serverIds: string[]) => void;
}) {
  const [manualLoading, setManualLoading] = useState(false);
  const [nethogsDialog, setNethogsDialog] = useState<NethogsDialogState | undefined>();
  const [temperatureDialog, setTemperatureDialog] = useState<TemperatureDialogState | undefined>();
  const [draggedServerId, setDraggedServerId] = useState('');
  const [dragOverServerId, setDragOverServerId] = useState('');
  const [temperatureOverrideByServer, setTemperatureOverrideByServer] = useState<Record<string, TemperatureReading>>({});
  const suppressCardClickRef = useRef(false);
  const lastDragTargetRef = useRef('');
  const dragPreviewRef = useRef<DragPreviewHandle | undefined>(undefined);

  const setTemperatureOverride = useCallback((serverId: string, reading: TemperatureReading | undefined) => {
    setTemperatureOverrideByServer((current) => {
      const next = { ...current };

      if (reading) {
        next[serverId] = reading;
      } else {
        delete next[serverId];
      }

      return next;
    });
  }, []);

  const refreshTemperatureOverrides = useCallback(async () => {
    if (!servers.length) {
      return;
    }

    await Promise.all(servers.map(async (server) => {
      const selectedTemperatureKey = preferredTemperatureByServer[server.id];

      if (!selectedTemperatureKey) {
        setTemperatureOverride(server.id, undefined);
        return;
      }

      try {
        const snapshot = await fetchTemperatureSnapshot(server.id);
        setTemperatureOverride(server.id, findTemperatureReading(snapshot.readings, selectedTemperatureKey));
      } catch {
        setTemperatureOverride(server.id, undefined);
      }
    }));
  }, [preferredTemperatureByServer, servers, setTemperatureOverride]);

  useEffect(() => {
    void refreshTemperatureOverrides();
  }, [refreshTemperatureOverrides]);

  const refreshFleetMetrics = useCallback(async () => {
    if (!servers.length) {
      return;
    }

    setManualLoading(true);

    try {
      await Promise.all([
        onRefreshMetrics(servers.map((server) => server.id)),
        refreshTemperatureOverrides(),
      ]);
    } finally {
      setManualLoading(false);
    }
  }, [onRefreshMetrics, refreshTemperatureOverrides, servers]);

  const closeNethogsDialog = useCallback(() => {
    setNethogsDialog(undefined);
  }, []);

  const closeTemperatureDialog = useCallback(() => {
    setTemperatureDialog(undefined);
  }, []);

  useEffect(() => {
    if (!nethogsDialog && !temperatureDialog) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeTemperatureDialog();
        closeNethogsDialog();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeNethogsDialog, closeTemperatureDialog, nethogsDialog, temperatureDialog]);

  const openNethogsDialog = useCallback((server: ServerProfile) => {
    setNethogsDialog({ server });
  }, []);

  const openTemperatureDialog = useCallback((server: ServerProfile) => {
    setTemperatureDialog({ server });
  }, []);

  const selectTemperatureReading = useCallback((server: ServerProfile, reading: TemperatureReading) => {
    const key = temperatureReadingKey(reading);

    onPreferredTemperatureChange({ ...preferredTemperatureByServer, [server.id]: key });
    setTemperatureOverride(server.id, reading);
  }, [onPreferredTemperatureChange, preferredTemperatureByServer, setTemperatureOverride]);

  const handleServerDragStart = useCallback((event: React.DragEvent<HTMLElement>, serverId: string) => {
    setDraggedServerId(serverId);
    suppressCardClickRef.current = true;
    lastDragTargetRef.current = '';
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', serverId);
    dragPreviewRef.current = createDragPreview(event);
  }, []);

  const handleServerDragOver = useCallback((event: React.DragEvent<HTMLElement>, serverId: string) => {
    const sourceId = draggedServerId || event.dataTransfer.getData('text/plain');

    if (!sourceId || sourceId === serverId) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    dragPreviewRef.current?.move(event);
    setDragOverServerId(serverId);

    if (lastDragTargetRef.current === serverId) {
      return;
    }

    lastDragTargetRef.current = serverId;
    const nextOrder = servers.map((server) => server.id);
    const sourceIndex = nextOrder.indexOf(sourceId);
    const targetIndex = nextOrder.indexOf(serverId);

    if (sourceIndex === -1 || targetIndex === -1) {
      return;
    }

    const [movedId] = nextOrder.splice(sourceIndex, 1);
    nextOrder.splice(targetIndex, 0, movedId);
    onReorder(nextOrder);
  }, [draggedServerId, onReorder, servers]);

  const handleServerDrop = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDraggedServerId('');
    setDragOverServerId('');
    lastDragTargetRef.current = '';
  }, []);

  const handleServerDrag = useCallback((event: React.DragEvent<HTMLElement>) => {
    dragPreviewRef.current?.move(event);
  }, []);

  const handleServerDragEnd = useCallback((event: React.DragEvent<HTMLElement>) => {
    dragPreviewRef.current?.finish(event.currentTarget);
    dragPreviewRef.current = undefined;
    setDraggedServerId('');
    setDragOverServerId('');
    lastDragTargetRef.current = '';
    window.setTimeout(() => {
      suppressCardClickRef.current = false;
    }, 0);
  }, []);

  if (!servers.length) {
    return (
      <div className="fleet-overview">
        <div className="empty-state">No servers saved.</div>
      </div>
    );
  }

  return (
    <div className="fleet-overview">
      <div className="fleet-header">
        <div>
          <h2>Server Fleet</h2>
          <span>{servers.length} configured endpoint{servers.length === 1 ? '' : 's'}</span>
        </div>
        <div className="refresh-controls">
          <button className="command refresh-command" onClick={() => void refreshFleetMetrics()} disabled={manualLoading}>
            <RefreshCw size={16} aria-hidden="true" className={manualLoading ? 'spin-icon' : undefined} /> Refresh
          </button>
          <RefreshRateSelect value={refreshRate} onChange={onRefreshRateChange} />
          <div className="segmented compact metric-mode-toggle" role="group" aria-label="Fleet metric display">
            <button type="button" className={metricMode === 'bars' ? 'active' : ''} onClick={() => onMetricModeChange('bars')}>Bars</button>
            <button type="button" className={metricMode === 'gauges' ? 'active' : ''} onClick={() => onMetricModeChange('gauges')}>Gauges</button>
          </div>
        </div>
      </div>
      <div className="fleet-grid">
        {servers.map((server, index) => (
          <FleetCard
            key={server.id}
            server={server}
            index={index}
            metrics={cachedMetrics[server.id]}
            metricMode={metricMode}
            defaultDiskMount={defaultDiskMountByServer[server.id]}
            selectedTemperature={temperatureOverrideByServer[server.id]}
            dragging={draggedServerId === server.id}
            dragOver={dragOverServerId === server.id}
            transitionName={viewTransitionName('fleet-server', server.id)}
            onDragStart={(event) => handleServerDragStart(event, server.id)}
            onDrag={handleServerDrag}
            onDragOver={(event) => handleServerDragOver(event, server.id)}
            onDrop={handleServerDrop}
            onDragEnd={handleServerDragEnd}
            onSelect={() => {
              if (!suppressCardClickRef.current) {
                onSelect(server);
              }
            }}
            onOpenTemperatureInfo={() => void openTemperatureDialog(server)}
            onOpenNetworkInfo={() => void openNethogsDialog(server)}
          />
        ))}
      </div>
      {nethogsDialog && (
        <NethogsDialog
          state={nethogsDialog}
          onClose={closeNethogsDialog}
        />
      )}
      {temperatureDialog && (
        <TemperatureDialog
          state={temperatureDialog}
          selectedKey={preferredTemperatureByServer[temperatureDialog.server.id]}
          onSelectReading={selectTemperatureReading}
          onClose={closeTemperatureDialog}
        />
      )}
    </div>
  );
}

function FleetCard({
  server,
  index,
  metrics,
  metricMode,
  defaultDiskMount,
  selectedTemperature,
  dragging,
  dragOver,
  transitionName,
  onDragStart,
  onDrag,
  onDragOver,
  onDrop,
  onDragEnd,
  onSelect,
  onOpenTemperatureInfo,
  onOpenNetworkInfo,
}: {
  server: ServerProfile;
  index: number;
  metrics?: SystemMetrics;
  metricMode: FleetMetricMode;
  defaultDiskMount?: string;
  selectedTemperature?: TemperatureReading;
  dragging: boolean;
  dragOver: boolean;
  transitionName: string;
  onDragStart: (event: React.DragEvent<HTMLElement>) => void;
  onDrag: (event: React.DragEvent<HTMLElement>) => void;
  onDragOver: (event: React.DragEvent<HTMLElement>) => void;
  onDrop: (event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: (event: React.DragEvent<HTMLElement>) => void;
  onSelect: () => void;
  onOpenTemperatureInfo: () => void;
  onOpenNetworkInfo: () => void;
}) {
  const onlineMetrics = metrics?.online === true ? metrics : undefined;
  const memoryPercentage = onlineMetrics && onlineMetrics.memory.total > 0 ? Math.round((onlineMetrics.memory.used / onlineMetrics.memory.total) * 100) : 0;
  const selectedDisk = findDiskByMount(onlineMetrics?.disk ?? [], defaultDiskMount) ?? onlineMetrics?.disk[0];
  const diskPercentage = selectedDisk?.percentage ?? 0;
  const onlineState = metrics?.online === true ? 'online' : metrics?.online === false ? 'offline' : 'unknown';
  const diskIo = onlineMetrics?.diskIo;
  const network = onlineMetrics?.network;
  const displayedTemperature = onlineMetrics ? selectedTemperature ?? onlineMetrics.temperature : undefined;

  return (
    <article
      className={`fleet-card ${dragging ? 'dragging' : ''} ${dragOver ? 'drag-over' : ''}`}
      role="button"
      tabIndex={0}
      draggable
      aria-label={`Open ${server.alias}`}
      onDragStart={onDragStart}
      onDrag={onDrag}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={{ '--card-delay': `${Math.min(index, 10) * 34}ms`, viewTransitionName: dragging ? 'none' : transitionName } as React.CSSProperties}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) {
          return;
        }

        event.preventDefault();
        onSelect();
      }}
    >
      <div className="fleet-card-top">
        <span className={`status-orb ${onlineState}`} />
        <ServerIconBadge server={server} className="fleet-server-icon" />
        <div>
          <strong>{server.alias}</strong>
          <small>{server.username}@{server.host}:{server.port}</small>
        </div>
        <span className="fleet-card-meta">
          <span className="fleet-uptime" title="Uptime">
            <Clock size={13} />
            <span>{formatUptime(onlineMetrics?.uptimeSeconds)}</span>
          </span>
          <span className="server-auth">{server.authMethod === 'privateKey' ? 'key' : 'pwd'}</span>
        </span>
      </div>
      {metricMode === 'gauges' ? (
        <div className="fleet-card-gauges">
          <MetricTile label="CPU" value={onlineMetrics ? `${Math.round(onlineMetrics.cpuUsage)}%` : '--'} progress={onlineMetrics?.cpuUsage ?? 0} accent="teal" />
          <MetricTile label="MEM" value={onlineMetrics ? `${memoryPercentage}%` : '--'} progress={memoryPercentage} accent="blue" />
          <MetricTile label="DSK" value={selectedDisk ? `${diskPercentage}%` : '--'} progress={diskPercentage} accent="amber" />
        </div>
      ) : (
        <div className="fleet-card-stats">
          <MiniStat label="CPU" value={onlineMetrics ? `${Math.round(onlineMetrics.cpuUsage)}%` : '--'} progress={onlineMetrics?.cpuUsage ?? 0} accent="cpu" />
          <MiniStat label="MEM" value={onlineMetrics ? `${memoryPercentage}%` : '--'} progress={memoryPercentage} accent="memory" />
          <MiniStat label="DSK" value={selectedDisk ? `${diskPercentage}%` : '--'} progress={diskPercentage} accent="disk" />
        </div>
      )}
      <div className="fleet-card-details compact">
        <CompactMetric
          icon={<Thermometer size={15} />}
          iconClassName="temp"
          value={formatTemperature(displayedTemperature?.celsius)}
          actionIcon={<ExternalLink size={11} />}
          title={displayedTemperature?.label ? `Show temperature sensors. Current: ${displayedTemperature.label}` : 'Show temperature sensors'}
          onClick={onOpenTemperatureInfo}
        />
        <CompactMetric
          icon={<HardDrive size={15} />}
          iconClassName="disk"
          value={[
            <DiskRateLine key="read" direction="read" bytesPerSecond={diskIo?.readBytesPerSecond} />,
            <DiskRateLine key="write" direction="write" bytesPerSecond={diskIo?.writeBytesPerSecond} />,
          ]}
          title="Disk I/O"
        />
        <CompactMetric
          icon={<Network size={15} />}
          iconClassName="network"
          value={[
            <NetworkRateLine key="download" direction="download" bytesPerSecond={network?.receiveBytesPerSecond} />,
            <NetworkRateLine key="upload" direction="upload" bytesPerSecond={network?.transmitBytesPerSecond} />,
          ]}
          actionIcon={<ExternalLink size={11} />}
          title="Show nethogs network processes"
          onClick={onOpenNetworkInfo}
        />
      </div>
      {metrics?.error && <span className="fleet-error">{metrics.error}</span>}
    </article>
  );
}

function viewTransitionName(prefix: string, value: string): string {
  return `${prefix}-${value.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function MiniStat({ label, value, progress, accent }: { label: string; value: string; progress: number; accent: 'cpu' | 'memory' | 'disk' }) {
  const clampedProgress = Math.max(0, Math.min(100, Math.round(progress)));

  return (
    <span className={`mini-stat mini-stat-${accent}`} style={{ '--mini-progress': `${clampedProgress}%` } as React.CSSProperties}>
      <span className="mini-stat-head">
        <span>{label}</span>
        <strong>{value}</strong>
      </span>
      <span className="mini-stat-track" aria-hidden="true">
        <span className="mini-stat-fill" />
      </span>
    </span>
  );
}

export function CompactMetric({
  icon,
  iconClassName,
  value,
  actionIcon,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  iconClassName: string;
  value: React.ReactNode | React.ReactNode[];
  actionIcon?: React.ReactNode;
  title: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className={`compact-metric-icon ${iconClassName}`}>{icon}</span>
      <span className="compact-metric-value">
        {Array.isArray(value) ? value.map((line, index) => <span key={index}>{line}</span>) : value}
      </span>
      {actionIcon && <span className="compact-metric-action">{actionIcon}</span>}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={`compact-metric compact-metric-${iconClassName} compact-metric-button`}
        title={title}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
      >
        {content}
      </button>
    );
  }

  return (
    <span className={`compact-metric compact-metric-${iconClassName}`} title={title}>
      {content}
    </span>
  );
}

export function TemperatureDialog({
  state,
  selectedKey,
  onSelectReading,
  onClose,
}: {
  state: TemperatureDialogState;
  selectedKey?: string;
  onSelectReading: (server: ServerProfile, reading: TemperatureReading) => void;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<TemperatureSnapshot | undefined>();
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  const loadTemperatures = useCallback(async () => {
    setLoading(true);
    setMessage('');

    try {
      const nextSnapshot = await fetchTemperatureSnapshot(state.server.id);
      setSnapshot(nextSnapshot);

      if (selectedKey) {
        const selectedReading = findTemperatureReading(nextSnapshot.readings, selectedKey);
        if (selectedReading) {
          onSelectReading(state.server, selectedReading);
        }
      }

      if (!nextSnapshot.ok && nextSnapshot.error) {
        setMessage(nextSnapshot.error);
      }
    } catch (error) {
      setSnapshot(undefined);
      setMessage(error instanceof Error ? error.message : 'Unable to read temperature sensors.');
    } finally {
      setLoading(false);
    }
  }, [onSelectReading, selectedKey, state.server]);

  useEffect(() => {
    void loadTemperatures();
  }, [loadTemperatures]);

  const readings = snapshot?.readings ?? [];
  const selectedReading = selectedKey ? findTemperatureReading(readings, selectedKey) : undefined;

  return (
    <div className="temperature-modal-backdrop" onClick={onClose}>
      <section
        className="temperature-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="temperature-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="temperature-modal-heading">
          <div>
            <h3 id="temperature-title">{state.server.alias} Temperatures</h3>
            <span>{temperatureSummaryText(snapshot)}</span>
          </div>
          <div className="temperature-modal-actions">
            <span className={selectedReading ? 'badge good' : 'badge neutral'}>{selectedReading ? 'Card sensor set' : 'Default sensor'}</span>
            <button type="button" className="icon-command temperature-close-command" title="Close temperatures" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>

        {snapshot?.summary.hottest && (
          <div className="temperature-summary">
            <span>
              <strong>Hottest</strong>
              {snapshot.summary.hottest.label} · {formatTemperature(snapshot.summary.hottest.celsius)}
            </span>
            <span>
              <strong>Average</strong>
              {formatTemperature(snapshot.summary.averageCelsius)}
            </span>
            <span>
              <strong>Readings</strong>
              {snapshot.summary.count}
            </span>
          </div>
        )}

        {message && <p className="temperature-message">{message}</p>}

        {loading && !snapshot ? (
          <div className="temperature-loading">
            <RefreshCw size={15} className="spin-icon" /> Loading temperature sensors...
          </div>
        ) : readings.length ? (
          <div className="temperature-table" role="table" aria-label="Temperature sensors">
            <div className="temperature-row header" role="row">
              <span>Show</span>
              <span>Sensor</span>
              <span>Current</span>
              <span>Max</span>
              <span>Critical</span>
              <span>Status</span>
              <span>Source</span>
            </div>
            {readings.map((reading) => {
              const key = temperatureReadingKey(reading);
              const selected = selectedKey === key;

              return (
                <button
                  key={key}
                  type="button"
                  className={selected ? 'temperature-row selected' : 'temperature-row'}
                  role="row"
                  title={`Show ${reading.label} on this server card`}
                  onClick={() => onSelectReading(state.server, reading)}
                >
                  <span className="temperature-choice">{selected && <CheckCircle2 size={15} />}</span>
                  <span>
                    <strong>{reading.label}</strong>
                    {reading.path && <small>{reading.path}</small>}
                  </span>
                  <span>{formatTemperature(reading.celsius)}</span>
                  <span>{formatTemperature(reading.maxCelsius)}</span>
                  <span>{formatTemperature(reading.criticalCelsius)}</span>
                  <span>{reading.status ?? '--'}</span>
                  <span>{reading.source}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="temperature-empty">
            No temperature sensors were reported by this server.
          </div>
        )}
      </section>
    </div>
  );
}

export function NethogsDialog({ state, onClose }: { state: NethogsDialogState; onClose: () => void }) {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<XTerm | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const resizeObserver = useRef<ResizeObserver | null>(null);
  const [connected, setConnected] = useState(false);

  const disconnect = useCallback(() => {
    resizeObserver.current?.disconnect();
    resizeObserver.current = null;
    socket.current?.close();
    socket.current = null;
    terminal.current?.dispose();
    terminal.current = null;
    fitAddon.current = null;
    setConnected(false);
  }, []);

  const sendResize = useCallback(() => {
    const dimensions = fitAddon.current?.proposeDimensions();

    if (isValidTerminalDimensions(dimensions) && socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify({ type: 'resize', cols: dimensions.cols, rows: dimensions.rows }));
    }
  }, []);

  const fitTerminal = useCallback(() => {
    if (!terminal.current || !fitAddon.current) {
      return;
    }

    requestAnimationFrame(() => {
      fitAddon.current?.fit();
      sendResize();
      terminal.current?.focus();
    });
  }, [sendResize]);

  const connect = useCallback(() => {
    if (!terminalRef.current) {
      return;
    }

    void (async () => {
      disconnect();
      const [{ Terminal, FitAddon }] = await Promise.all([import('../lib/xterm')]);

      if (!terminalRef.current) {
        return;
      }

      const term = new Terminal({
        cursorBlink: false,
        convertEol: false,
        fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, monospace',
        fontSize: 13,
        scrollback: 1000,
        theme: {
          background: '#211818',
          foreground: '#f3eeee',
          cursor: '#f4f4f5',
          selectionBackground: '#6f4b3d',
        },
      });
      const fit = new FitAddon();
      const url = await buildWebSocketUrl(`/api/servers/${state.server.id}/nethogs-shell`);
      const ws = new WebSocket(url);
      const target = terminalRef.current;
      const observer = new ResizeObserver(() => {
        if (target.offsetParent === null) {
          return;
        }

        fit.fit();
        const dimensions = fit.proposeDimensions();
        if (isValidTerminalDimensions(dimensions) && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: dimensions.cols, rows: dimensions.rows }));
        }
      });

      terminal.current = term;
      fitAddon.current = fit;
      socket.current = ws;
      resizeObserver.current = observer;
      term.loadAddon(fit);
      term.open(target);
      term.writeln('Connecting to NetHogs...');
      observer.observe(target);
      fitTerminal();

      ws.addEventListener('open', () => {
        setConnected(true);
        fitTerminal();
      });
      ws.addEventListener('message', async (event) => writeNethogsTerminalMessage(term, typeof event.data === 'string' ? event.data : await event.data.text()));
      ws.addEventListener('close', () => {
        observer.disconnect();
        if (socket.current === ws) {
          socket.current = null;
        }
        setConnected(false);
      });
      ws.addEventListener('error', () => {
        term.writeln('\r\nNetHogs connection failed.');
        setConnected(false);
      });
      term.onData((data) => ws.readyState === WebSocket.OPEN && ws.send(data));
    })();
  }, [disconnect, fitTerminal, state.server.id]);

  useEffect(() => {
    connect();
    return disconnect;
  }, [connect, disconnect]);

  return (
    <div className="nethogs-modal-backdrop" onClick={onClose}>
      <section
        className="nethogs-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nethogs-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="nethogs-modal-heading">
          <div>
            <h3 id="nethogs-title">{state.server.alias} Network</h3>
            <span>Interactive NetHogs session</span>
          </div>
          <div className="nethogs-modal-actions">
            <span className={connected ? 'badge good' : 'badge neutral'}>{connected ? 'Connected' : 'Disconnected'}</span>
            <button type="button" className="command compact-command" onClick={connect}>
              <RefreshCw size={14} /> Reconnect
            </button>
            <button type="button" className="icon-command" title="Close nethogs" onClick={onClose}>
              <XCircle size={15} />
            </button>
          </div>
        </div>
        <div className="nethogs-terminal-surface" ref={terminalRef} />
      </section>
    </div>
  );
}

export function formatTemperature(celsius: number | undefined): string {
  if (typeof celsius !== 'number' || !Number.isFinite(celsius)) {
    return '--';
  }

  return `${Math.round(celsius)} °C`;
}

function formatUptime(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return '--';
  }

  const totalMinutes = Math.floor(seconds / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${Math.max(1, minutes)}m`;
}

export function formatRate(bytesPerSecond: number | undefined): string {
  if (typeof bytesPerSecond !== 'number' || !Number.isFinite(bytesPerSecond)) {
    return '--';
  }

  return `${formatBytes(Math.max(0, bytesPerSecond))}/s`;
}

export function DiskRateLine({
  direction,
  bytesPerSecond,
}: {
  direction: 'read' | 'write';
  bytesPerSecond: number | undefined;
}) {
  return (
    <span className="disk-rate-line" title={direction === 'read' ? 'Disk read' : 'Disk write'}>
      <span>{direction === 'read' ? 'R' : 'W'}</span>
      <span>{formatRate(bytesPerSecond)}</span>
    </span>
  );
}

export function DiskRatePair({
  readBytesPerSecond,
  writeBytesPerSecond,
}: {
  readBytesPerSecond: number | undefined;
  writeBytesPerSecond: number | undefined;
}) {
  return (
    <span className="disk-rate-pair">
      <DiskRateLine direction="read" bytesPerSecond={readBytesPerSecond} />
      <DiskRateLine direction="write" bytesPerSecond={writeBytesPerSecond} />
    </span>
  );
}

export function NetworkRateLine({
  direction,
  bytesPerSecond,
}: {
  direction: 'download' | 'upload';
  bytesPerSecond: number | undefined;
}) {
  const Icon = direction === 'download' ? ArrowDown : ArrowUp;

  return (
    <span className="network-rate-line" title={direction === 'download' ? 'Download' : 'Upload'}>
      <Icon size={12} />
      <span>{formatMegabytesRate(bytesPerSecond)}</span>
    </span>
  );
}

export function NetworkRatePair({
  receiveBytesPerSecond,
  transmitBytesPerSecond,
}: {
  receiveBytesPerSecond: number | undefined;
  transmitBytesPerSecond: number | undefined;
}) {
  return (
    <span className="network-rate-pair">
      <NetworkRateLine direction="download" bytesPerSecond={receiveBytesPerSecond} />
      <NetworkRateLine direction="upload" bytesPerSecond={transmitBytesPerSecond} />
    </span>
  );
}

function formatMegabytesRate(bytesPerSecond: number | undefined): string {
  if (typeof bytesPerSecond !== 'number' || !Number.isFinite(bytesPerSecond)) {
    return '--MB/s';
  }

  return `${(Math.max(0, bytesPerSecond) / 1024 / 1024).toFixed(2)}MB/s`;
}

function writeNethogsTerminalMessage(term: XTerm, message: string): void {
  const cleanedMessage = cleanNethogsTerminalMessage(message);

  if (!cleanedMessage) {
    return;
  }

  if (!cleanedMessage.startsWith('{')) {
    term.write(cleanedMessage);
    return;
  }

  try {
    const parsed = JSON.parse(cleanedMessage) as { type?: string; message?: string };

    if (parsed.type === 'error' && parsed.message) {
      term.writeln(`\r\n${parsed.message}`);
      return;
    }
  } catch {
    // Fall through and write the raw payload.
  }

  term.write(cleanedMessage);
}

function cleanNethogsTerminalMessage(message: string): string {
  return message
    .split(/\r?\n/)
    .filter((line) => !(line.includes('/etc/profile.d/activate_display.sh') && line.includes('[[: not found')))
    .join('\r\n');
}

export async function fetchTemperatureSnapshot(serverId: string): Promise<TemperatureSnapshot> {
  const response = await fetch(`/api/servers/${serverId}/temperature`);
  const body = (await response.json()) as TemperatureSnapshot | { message?: string };

  if (!response.ok) {
    throw new Error('message' in body && body.message ? body.message : 'Unable to read temperature sensors.');
  }

  return body as TemperatureSnapshot;
}

export function temperatureReadingKey(reading: TemperatureReading): string {
  return JSON.stringify([reading.source, reading.label, reading.path ?? '']);
}

export function findTemperatureReading(readings: TemperatureReading[], key: string | undefined): TemperatureReading | undefined {
  if (!key) {
    return undefined;
  }

  return readings.find((reading) => temperatureReadingKey(reading) === key);
}

function temperatureSummaryText(snapshot: TemperatureSnapshot | undefined): string {
  if (!snapshot) {
    return 'Collecting every available sensor reading';
  }

  if (!snapshot.summary.count) {
    return 'No sensors reported';
  }

  return `Collected ${snapshot.summary.count} sensor reading${snapshot.summary.count === 1 ? '' : 's'} at ${formatTime(snapshot.collectedAt)}`;
}

function formatTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

import { useCallback, useMemo, useState } from 'react';
import { Eye, XCircle } from 'lucide-react';
import { overviewSectionLabels } from '../constants';
import type { OverviewSectionId, OverviewSectionPreferences, ProcessMetric, ServerProfile, SystemMetrics } from '../types';
import { findDiskByMount, isUserMountedDisk } from '../lib/disks';
import { formatFilesystemSize, formatProcessMemory } from '../lib/format';
import { moveSectionId, normalizeOverviewSectionPreferences, updateServerSectionPreferences } from '../lib/overviewSections';
import { removeRecordKey } from '../lib/records';
import { MetricTile } from './MetricTile';
import { OverviewSection } from './OverviewSection';

export function Overview({
  server,
  metrics,
  onKillProcess,
  userMountsOnlyByServer,
  defaultDiskMountByServer,
  sectionPreferencesByServer,
  onUserMountsOnlyByServerChange,
  onDefaultDiskMountByServerChange,
  onSectionPreferencesByServerChange,
}: {
  server?: ServerProfile;
  metrics?: SystemMetrics;
  onKillProcess: (pid: number) => Promise<void>;
  userMountsOnlyByServer: Record<string, boolean>;
  defaultDiskMountByServer: Record<string, string>;
  sectionPreferencesByServer: Record<string, OverviewSectionPreferences>;
  onUserMountsOnlyByServerChange: (value: Record<string, boolean>) => void;
  onDefaultDiskMountByServerChange: (value: Record<string, string>) => void;
  onSectionPreferencesByServerChange: (value: Record<string, OverviewSectionPreferences>) => void;
}) {
  const [processSort, setProcessSort] = useState<'cpu' | 'memory'>('cpu');
  const userMountsOnly = server ? userMountsOnlyByServer[server.id] === true : false;
  const memoryPercentage = metrics && metrics.memory.total > 0 ? Math.round((metrics.memory.used / metrics.memory.total) * 100) : 0;
  const disks = metrics?.disk ?? [];
  const selectedDefaultDiskMount = server ? defaultDiskMountByServer[server.id] : undefined;
  const primaryDisk = findDiskByMount(disks, selectedDefaultDiskMount) ?? disks[0];
  const diskPercentage = primaryDisk?.percentage ?? 0;
  const diskDetail = primaryDisk ? `${primaryDisk.mount} ${formatFilesystemSize(primaryDisk.used)} / ${formatFilesystemSize(primaryDisk.total)}` : 'No disk data';
  const visibleDisks = userMountsOnly ? disks.filter(isUserMountedDisk) : disks;
  const normalizedSections = useMemo(() => {
    return normalizeOverviewSectionPreferences(server ? sectionPreferencesByServer[server.id] : undefined);
  }, [sectionPreferencesByServer, server]);
  const hiddenSectionSet = new Set(normalizedSections.hidden);
  const visibleSectionIds = normalizedSections.order.filter((sectionId) => !hiddenSectionSet.has(sectionId));
  const hiddenSectionIds = normalizedSections.order.filter((sectionId) => hiddenSectionSet.has(sectionId));
  const topProcesses = useMemo(() => {
    return [...(metrics?.processes ?? [])]
      .sort((a, b) => (processSort === 'cpu' ? b.cpu - a.cpu : b.memory - a.memory))
      .slice(0, 5);
  }, [metrics?.processes, processSort]);

  const setUserMountsOnlyForServer = useCallback((enabled: boolean) => {
    if (!server) {
      return;
    }

    onUserMountsOnlyByServerChange(enabled
      ? { ...userMountsOnlyByServer, [server.id]: true }
      : removeRecordKey(userMountsOnlyByServer, server.id));
  }, [onUserMountsOnlyByServerChange, server, userMountsOnlyByServer]);

  const setDefaultDiskMount = useCallback((mount: string, enabled: boolean) => {
    if (!server) {
      return;
    }

    if (enabled) {
      onDefaultDiskMountByServerChange({ ...defaultDiskMountByServer, [server.id]: mount });
      return;
    }

    if (defaultDiskMountByServer[server.id] === mount) {
      onDefaultDiskMountByServerChange(removeRecordKey(defaultDiskMountByServer, server.id));
    }
  }, [defaultDiskMountByServer, onDefaultDiskMountByServerChange, server]);

  const hideOverviewSection = useCallback((sectionId: OverviewSectionId) => {
    if (!server) {
      return;
    }

    onSectionPreferencesByServerChange(updateServerSectionPreferences(sectionPreferencesByServer, server.id, (preferences) => ({
      ...preferences,
      hidden: [...preferences.hidden, sectionId],
    })));
  }, [onSectionPreferencesByServerChange, sectionPreferencesByServer, server]);

  const showOverviewSection = useCallback((sectionId: OverviewSectionId) => {
    if (!server) {
      return;
    }

    onSectionPreferencesByServerChange(updateServerSectionPreferences(sectionPreferencesByServer, server.id, (preferences) => ({
      ...preferences,
      hidden: preferences.hidden.filter((hiddenSectionId) => hiddenSectionId !== sectionId),
    })));
  }, [onSectionPreferencesByServerChange, sectionPreferencesByServer, server]);

  const moveOverviewSection = useCallback((sectionId: OverviewSectionId, direction: -1 | 1) => {
    if (!server) {
      return;
    }

    onSectionPreferencesByServerChange(updateServerSectionPreferences(sectionPreferencesByServer, server.id, (preferences) => ({
      ...preferences,
      order: moveSectionId(preferences.order, sectionId, direction),
    })));
  }, [onSectionPreferencesByServerChange, sectionPreferencesByServer, server]);

  if (!server) {
    return <div className="empty-state">No server selected.</div>;
  }

  const renderOverviewSection = (sectionId: OverviewSectionId, index: number) => {
    const canMoveUp = index > 0;
    const canMoveDown = index < visibleSectionIds.length - 1;

    if (sectionId === 'filesystems') {
      return (
        <OverviewSection
          key={sectionId}
          title={overviewSectionLabels[sectionId]}
          tools={(
            <label className="check-control">
              <input type="checkbox" checked={userMountsOnly} onChange={(event) => setUserMountsOnlyForServer(event.target.checked)} />
              Only user-mounted drives
            </label>
          )}
          onHide={() => hideOverviewSection(sectionId)}
          onMoveUp={() => moveOverviewSection(sectionId, -1)}
          onMoveDown={() => moveOverviewSection(sectionId, 1)}
          canMoveUp={canMoveUp}
          canMoveDown={canMoveDown}
        >
          {visibleDisks.length ? visibleDisks.map((disk) => {
            const diskUsagePercent = clampPercentage(disk.percentage);
            const diskUsageState = getDiskUsageState(diskUsagePercent);

            return (
              <div className={selectedDefaultDiskMount === disk.mount ? 'disk-row selected-default' : 'disk-row'} key={`${disk.mount}-${disk.total}`}>
                <span>{disk.mount}</span>
                <div
                  className={`disk-usage-bar ${diskUsageState}`}
                  role="progressbar"
                  aria-label={`${disk.mount} disk usage`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={diskUsagePercent}
                >
                  <span style={{ width: `${diskUsagePercent}%` }} />
                  <strong>{disk.percentage}%</strong>
                </div>
                <small>{formatFilesystemSize(disk.used)} / {formatFilesystemSize(disk.total)}</small>
                <label className="check-control disk-default">
                  <input
                    type="checkbox"
                    checked={selectedDefaultDiskMount === disk.mount}
                    onChange={(event) => setDefaultDiskMount(disk.mount, event.target.checked)}
                  />
                  Make default
                </label>
              </div>
            );
          }) : <p className="empty-state compact-empty">{disks.length ? 'No user-mounted filesystem data.' : 'No filesystem data.'}</p>}
        </OverviewSection>
      );
    }

    if (sectionId === 'processes') {
      return (
        <OverviewSection
          key={sectionId}
          title={overviewSectionLabels[sectionId]}
          tools={(
            <div className="segmented compact" role="group" aria-label="Process sort">
              <button type="button" className={processSort === 'cpu' ? 'active' : ''} onClick={() => setProcessSort('cpu')}>CPU</button>
              <button type="button" className={processSort === 'memory' ? 'active' : ''} onClick={() => setProcessSort('memory')}>Memory</button>
            </div>
          )}
          onHide={() => hideOverviewSection(sectionId)}
          onMoveUp={() => moveOverviewSection(sectionId, -1)}
          onMoveDown={() => moveOverviewSection(sectionId, 1)}
          canMoveUp={canMoveUp}
          canMoveDown={canMoveDown}
        >
          {topProcesses.length ? (
            <div className="process-table">
              <div className="process-row header"><span>PID</span><span>Command</span><span>CPU</span><span>Memory</span></div>
              {topProcesses.map((process) => (
                <div className="process-row" key={`${process.pid}-${process.command}`}>
                  <span>{process.pid}</span>
                  <span title={process.command}>{process.command}</span>
                  <strong>{process.cpu.toFixed(1)}%</strong>
                  <span className="process-memory-cell">
                    <strong>{formatProcessMemory(process.memory)}</strong>
                    <button
                      className="process-kill"
                      title={`Kill ${process.command}`}
                      onClick={() => void confirmAndKillProcess(process, onKillProcess)}
                    >
                      <XCircle size={15} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty-state compact-empty">No process data.</p>
          )}
        </OverviewSection>
      );
    }

    return null;
  };

  return (
    <div className="overview">
      <div className="metric-grid">
        <MetricTile label="CPU Load" value={`${Math.round(metrics?.cpuUsage ?? 0)}%`} progress={metrics?.cpuUsage ?? 0} accent="teal" />
        <MetricTile label="Memory Used" value={`${memoryPercentage}%`} detail={`${metrics?.memory.used ?? 0} / ${metrics?.memory.total ?? 0} MB`} progress={memoryPercentage} accent="blue" />
        <MetricTile label="Disk Usage" value={`${diskPercentage}%`} detail={diskDetail} progress={diskPercentage} accent="amber" />
      </div>
      {hiddenSectionIds.length > 0 && (
        <div className="overview-layout-toolbar">
          <span>Hidden sections</span>
          {hiddenSectionIds.map((sectionId) => (
            <button type="button" className="command compact-command" key={sectionId} onClick={() => showOverviewSection(sectionId)}>
              <Eye size={14} /> {overviewSectionLabels[sectionId]}
            </button>
          ))}
        </div>
      )}
      <div className="overview-sections">
        {visibleSectionIds.map(renderOverviewSection)}
      </div>
    </div>
  );
}

async function confirmAndKillProcess(process: ProcessMetric, onKillProcess: (pid: number) => Promise<void>): Promise<void> {
  if (!window.confirm(`Kill process ${process.pid} (${process.command})?`)) {
    return;
  }

  await onKillProcess(process.pid);
}

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
}

function getDiskUsageState(percentage: number): 'ok' | 'warning' | 'danger' {
  if (percentage >= 90) {
    return 'danger';
  }

  if (percentage >= 80) {
    return 'warning';
  }

  return 'ok';
}

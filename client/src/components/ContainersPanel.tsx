import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Edit3, ExternalLink, Eye, EyeOff, FileText, Image, LayoutGrid, List, MoreHorizontal, Play, RefreshCw, Save, Settings, Square, XCircle } from 'lucide-react';
import type { ContainerComposeState, ContainerLogsState, ContainerMetric, ContainerPreferences, ContainerViewMode, DockerContainerAction, ServerProfile, SystemMetrics } from '../types';
import { getContainerCompose, getContainerLogs, saveContainerCompose } from '../lib/api';
import { canControlContainer, confirmContainerAction, containerActionPastTense, containerOverrideKey, containerStateRank, containerUrl, normalizeContainerIconOverride, normalizeContainerUrlOverride, openContainerUrl } from '../lib/containers';
import { createDragPreview, type DragPreviewHandle } from '../lib/dragPreview';
import { removeRecordKey } from '../lib/records';
import { runLayoutTransition } from '../lib/viewTransition';
import { ComposeSettingsEditor } from './ComposeSettingsEditor';
import { ServerIconBadge } from './ServerIcon';

interface ContainerEntry {
  server: ServerProfile;
  container: ContainerMetric;
}

const ALL_CONTAINERS_ORDER_CONTEXT_KEY = 'all';

export function ContainersPanel({
  server,
  metrics,
  onRefreshMetrics,
  onControlContainer,
  preferences,
  onPreferencesChange,
}: {
  server?: ServerProfile;
  metrics?: SystemMetrics;
  onRefreshMetrics: () => void;
  onControlContainer: (containerId: string, action: DockerContainerAction) => Promise<void>;
  preferences: ContainerPreferences;
  onPreferencesChange: (update: (current: ContainerPreferences) => ContainerPreferences) => void;
}) {
  const dockerContainers = useMemo(() => {
    return [...(metrics?.containers ?? [])].sort((a, b) => containerStateRank(a.state) - containerStateRank(b.state) || a.name.localeCompare(b.name));
  }, [metrics?.containers]);

  const setContainerUrlOverride = useCallback((container: ContainerMetric, value: string | undefined) => {
    if (!server) {
      return;
    }

    const key = containerOverrideKey(server.id, container.name);
    onPreferencesChange((current) => ({
      ...current,
      urlOverrides: value ? { ...current.urlOverrides, [key]: value } : removeRecordKey(current.urlOverrides, key),
    }));
  }, [onPreferencesChange, server]);

  const setContainerIconOverride = useCallback((container: ContainerMetric, value: string | undefined) => {
    if (!server) {
      return;
    }

    const key = containerOverrideKey(server.id, container.name);
    onPreferencesChange((current) => ({
      ...current,
      iconOverrides: value ? { ...current.iconOverrides, [key]: value } : removeRecordKey(current.iconOverrides, key),
    }));
  }, [onPreferencesChange, server]);

  const setContainerAppHidden = useCallback((container: ContainerMetric, hidden: boolean) => {
    if (!server) {
      return;
    }

    const key = containerOverrideKey(server.id, container.name);
    onPreferencesChange((current) => ({
      ...current,
      hiddenByContainer: hidden ? { ...current.hiddenByContainer, [key]: true } : removeRecordKey(current.hiddenByContainer, key),
    }));
  }, [onPreferencesChange, server]);

  if (!server) {
    return <div className="empty-state">No server selected.</div>;
  }

  const containerEntries = dockerContainers.map((container) => ({ server, container }));
  const orderContextKey = containerOrderContextKey(server.id);
  const containerError = metrics?.containerError;

  return (
    <div className="containers-panel">
      <div className="panel-toolbar">
        <div>
          <h3>Containers</h3>
          <span>{dockerContainers.length} container{dockerContainers.length === 1 ? '' : 's'}</span>
        </div>
        <div className="refresh-controls">
          <div className="segmented compact container-view-toggle" role="group" aria-label="Container view">
            <button type="button" className={preferences.viewMode === 'table' ? 'active' : ''} title="Table view" onClick={() => onPreferencesChange((current) => ({ ...current, viewMode: 'table' }))}>
              <List size={14} /> List
            </button>
            <button type="button" className={preferences.viewMode === 'apps' ? 'active' : ''} title="App icon view" onClick={() => onPreferencesChange((current) => ({ ...current, viewMode: 'apps' }))}>
              <LayoutGrid size={14} /> Apps
            </button>
          </div>
          <button className="command" onClick={onRefreshMetrics}><RefreshCw size={16} /> Refresh</button>
        </div>
      </div>
      {containerError && <p className="message container-message">{containerError}</p>}
      <ContainerListing
        entries={containerEntries}
        viewMode={preferences.viewMode}
        urlOverrides={preferences.urlOverrides}
        iconOverrides={preferences.iconOverrides}
        hiddenAppContainers={preferences.hiddenByContainer}
        orderContextKey={orderContextKey}
        orderByContext={preferences.appOrderByContext}
        onOrderChange={(nextOrder) => runLayoutTransition(() => onPreferencesChange((current) => ({ ...current, appOrderByContext: { ...current.appOrderByContext, [orderContextKey]: nextOrder } })))}
        onSetUrlOverride={(entry, value) => setContainerUrlOverride(entry.container, value)}
        onSetIconOverride={(entry, value) => setContainerIconOverride(entry.container, value)}
        onSetAppHidden={(entry, hidden) => setContainerAppHidden(entry.container, hidden)}
        onControlContainer={(_entry, containerId, action) => onControlContainer(containerId, action)}
        onComposeApplied={onRefreshMetrics}
        emptyMessage={containerError ? 'Docker container data is unavailable for this server.' : undefined}
      />
    </div>
  );
}

export function AllContainersPanel({
  servers,
  cachedMetrics,
  onRefreshMetrics,
  onBack,
  onControlContainer,
  preferences,
  onPreferencesChange,
}: {
  servers: ServerProfile[];
  cachedMetrics: Record<string, SystemMetrics>;
  onRefreshMetrics: (serverIds: string[]) => Promise<void>;
  onBack: () => void;
  onControlContainer: (server: ServerProfile, containerId: string, action: DockerContainerAction) => Promise<void>;
  preferences: ContainerPreferences;
  onPreferencesChange: (update: (current: ContainerPreferences) => ContainerPreferences) => void;
}) {
  const [manualLoading, setManualLoading] = useState(false);
  const [message, setMessage] = useState('');

  const entries = useMemo(() => {
    return servers
      .flatMap((server) => (cachedMetrics[server.id]?.containers ?? []).map((container) => ({ server, container })))
      .sort((a, b) =>
        a.server.alias.localeCompare(b.server.alias)
        || containerStateRank(a.container.state) - containerStateRank(b.container.state)
        || a.container.name.localeCompare(b.container.name),
      );
  }, [cachedMetrics, servers]);
  const containerErrors = useMemo(() => {
    return servers.flatMap((server) => {
      const containerError = cachedMetrics[server.id]?.containerError;
      return containerError ? [{ server, message: containerError }] : [];
    });
  }, [cachedMetrics, servers]);

  const refreshAllMetrics = useCallback(async () => {
    if (!servers.length) {
      return;
    }

    setManualLoading(true);
    setMessage('');

    try {
      await onRefreshMetrics(servers.map((server) => server.id));
    } catch {
      setMessage('Unable to refresh container data.');
    } finally {
      setManualLoading(false);
    }
  }, [onRefreshMetrics, servers]);

  const setContainerUrlOverride = useCallback((entry: ContainerEntry, value: string | undefined) => {
    const key = containerOverrideKey(entry.server.id, entry.container.name);
    onPreferencesChange((current) => ({
      ...current,
      urlOverrides: value ? { ...current.urlOverrides, [key]: value } : removeRecordKey(current.urlOverrides, key),
    }));
  }, [onPreferencesChange]);

  const setContainerIconOverride = useCallback((entry: ContainerEntry, value: string | undefined) => {
    const key = containerOverrideKey(entry.server.id, entry.container.name);
    onPreferencesChange((current) => ({
      ...current,
      iconOverrides: value ? { ...current.iconOverrides, [key]: value } : removeRecordKey(current.iconOverrides, key),
    }));
  }, [onPreferencesChange]);

  const setContainerAppHidden = useCallback((entry: ContainerEntry, hidden: boolean) => {
    const key = containerOverrideKey(entry.server.id, entry.container.name);
    onPreferencesChange((current) => ({
      ...current,
      hiddenByContainer: hidden ? { ...current.hiddenByContainer, [key]: true } : removeRecordKey(current.hiddenByContainer, key),
    }));
  }, [onPreferencesChange]);

  return (
    <div className="containers-panel all-containers-panel">
      <div className="fleet-header">
        <div className="header-title-with-back">
          <button type="button" className="icon-command header-back-command" title="Back to fleet overview" aria-label="Back to fleet overview" onClick={onBack}>
            <ArrowLeft size={16} />
          </button>
          <div>
            <h2>Container Fleet</h2>
            <span>{entries.length} container{entries.length === 1 ? '' : 's'} across {servers.length} server{servers.length === 1 ? '' : 's'}</span>
          </div>
        </div>
        <div className="refresh-controls">
          <button className="command" onClick={() => void refreshAllMetrics()} disabled={manualLoading}>
            <RefreshCw size={16} className={manualLoading ? 'spin-icon' : undefined} /> Refresh
          </button>
          <div className="segmented compact container-view-toggle" role="group" aria-label="Container view">
            <button type="button" className={preferences.viewMode === 'table' ? 'active' : ''} title="List view" onClick={() => onPreferencesChange((current) => ({ ...current, viewMode: 'table' }))}>
              <List size={14} /> List
            </button>
            <button type="button" className={preferences.viewMode === 'apps' ? 'active' : ''} title="App icon view" onClick={() => onPreferencesChange((current) => ({ ...current, viewMode: 'apps' }))}>
              <LayoutGrid size={14} /> Apps
            </button>
          </div>
        </div>
      </div>
      {message && <p className="message container-message">{message}</p>}
      {containerErrors.map(({ server, message: containerError }) => (
        <p className="message container-message" key={server.id}>
          <strong>{server.alias}:</strong> {containerError}
        </p>
      ))}
      <ContainerListing
        entries={entries}
        viewMode={preferences.viewMode}
        urlOverrides={preferences.urlOverrides}
        iconOverrides={preferences.iconOverrides}
        hiddenAppContainers={preferences.hiddenByContainer}
        orderContextKey={ALL_CONTAINERS_ORDER_CONTEXT_KEY}
        orderByContext={preferences.appOrderByContext}
        onOrderChange={(nextOrder) => runLayoutTransition(() => onPreferencesChange((current) => ({ ...current, appOrderByContext: { ...current.appOrderByContext, [ALL_CONTAINERS_ORDER_CONTEXT_KEY]: nextOrder } })))}
        showServer
        emptyMessage={servers.length ? (containerErrors.length ? 'Docker container data is unavailable for one or more servers.' : 'No Docker container data loaded yet.') : 'No servers configured.'}
        onSetUrlOverride={setContainerUrlOverride}
        onSetIconOverride={setContainerIconOverride}
        onSetAppHidden={setContainerAppHidden}
        onControlContainer={(entry, containerId, action) => onControlContainer(entry.server, containerId, action)}
        onComposeApplied={() => void refreshAllMetrics()}
      />
    </div>
  );
}

function ContainerListing({
  entries,
  viewMode,
  urlOverrides,
  iconOverrides,
  hiddenAppContainers,
  orderContextKey,
  orderByContext,
  onOrderChange,
  showServer = false,
  emptyMessage = 'No Docker container data.',
  onSetUrlOverride,
  onSetIconOverride,
  onSetAppHidden,
  onControlContainer,
  onComposeApplied,
}: {
  entries: ContainerEntry[];
  viewMode: ContainerViewMode;
  urlOverrides: Record<string, string>;
  iconOverrides: Record<string, string>;
  hiddenAppContainers: Record<string, boolean>;
  orderContextKey: string;
  orderByContext: Record<string, string[]>;
  onOrderChange: (nextOrder: string[]) => void;
  showServer?: boolean;
  emptyMessage?: string;
  onSetUrlOverride: (entry: ContainerEntry, value: string | undefined) => void;
  onSetIconOverride: (entry: ContainerEntry, value: string | undefined) => void;
  onSetAppHidden: (entry: ContainerEntry, hidden: boolean) => void;
  onControlContainer: (entry: ContainerEntry, containerId: string, action: DockerContainerAction) => Promise<void>;
  onComposeApplied: (entry: ContainerEntry) => void;
}) {
  const [pendingActions, setPendingActions] = useState<Record<string, DockerContainerAction>>({});
  const [pendingLogsId, setPendingLogsId] = useState('');
  const [logsState, setLogsState] = useState<ContainerLogsState | undefined>();
  const [composeState, setComposeState] = useState<ContainerComposeState | undefined>();
  const [message, setMessage] = useState('');
  const [openMenuId, setOpenMenuId] = useState('');
  const [draggedKey, setDraggedKey] = useState('');
  const [dragOverKey, setDragOverKey] = useState('');
  const suppressClickRef = useRef(false);
  const lastDragTargetRef = useRef('');
  const dragPreviewRef = useRef<DragPreviewHandle | undefined>(undefined);
  const orderedAppEntries = useMemo(() => orderContainerEntries(entries, orderByContext[orderContextKey] ?? []), [entries, orderByContext, orderContextKey]);
  const visibleAppEntries = useMemo(() => {
    return orderedAppEntries.filter((entry) => !hiddenAppContainers[containerAppVisibilityKey(entry)]);
  }, [hiddenAppContainers, orderedAppEntries]);

  const handleContainerAction = useCallback(async (entry: ContainerEntry, action: DockerContainerAction) => {
    const { container } = entry;
    const key = containerEntryKey(entry);

    if (!confirmContainerAction(container, action)) {
      return;
    }

    setPendingActions((current) => ({ ...current, [key]: action }));
    setMessage('');

    try {
      await onControlContainer(entry, container.id, action);
      setMessage(`${container.name} ${containerActionPastTense(action)}.`);
      setOpenMenuId('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to control Docker container.');
    } finally {
      setPendingActions((current) => removeRecordKey(current, key));
    }
  }, [onControlContainer]);

  const handleContainerLogs = useCallback(async (entry: ContainerEntry) => {
    const { server, container } = entry;
    const key = containerEntryKey(entry);

    setPendingLogsId(key);
    setMessage('');

    try {
      const logs = await getContainerLogs(server.id, container.id);
      setLogsState({
        serverId: server.id,
        containerId: container.id,
        containerName: showServer ? `${container.name} on ${server.alias}` : container.name,
        logs: logs || 'No logs returned.',
      });
      setOpenMenuId('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to read Docker container logs.');
    } finally {
      setPendingLogsId('');
    }
  }, [showServer]);

  const handleComposeSettings = useCallback(async (entry: ContainerEntry) => {
    const { server, container } = entry;

    setOpenMenuId('');
    setComposeState({
      serverId: server.id,
      containerId: container.id,
      containerName: container.name,
      serverAlias: server.alias,
      loading: true,
      saving: false,
      content: '',
      originalContent: '',
    });

    try {
      const response = await getContainerCompose(server.id, container.id);
      const content = response.content ?? '';
      setComposeState({
        serverId: server.id,
        containerId: container.id,
        containerName: container.name,
        serverAlias: server.alias,
        loading: false,
        saving: false,
        content,
        originalContent: content,
        composeFile: response.composeFile,
        workingDir: response.workingDir,
        project: response.project,
        service: response.service,
      });
    } catch (error) {
      setComposeState((current) => current ? {
        ...current,
        loading: false,
        saving: false,
        error: error instanceof Error ? error.message : 'Unable to read Docker Compose file.',
      } : undefined);
    }
  }, []);

  const saveComposeSettings = useCallback(async () => {
    if (!composeState || composeState.loading || composeState.saving) {
      return;
    }

    if (!composeState.content.trim()) {
      setComposeState((current) => current ? { ...current, error: 'Docker Compose content cannot be empty.', message: undefined } : undefined);
      return;
    }

    setComposeState((current) => current ? { ...current, saving: true, error: undefined, message: undefined } : undefined);

    try {
      const response = await saveContainerCompose(composeState.serverId, composeState.containerId, composeState.content);
      setComposeState((current) => current ? {
        ...current,
        saving: false,
        originalContent: current.content,
        composeFile: response.composeFile ?? current.composeFile,
        workingDir: response.workingDir ?? current.workingDir,
        project: response.project ?? current.project,
        service: response.service ?? current.service,
        message: response.output ? 'Compose file saved and applied.' : 'Compose file saved.',
      } : undefined);

      const entry = entries.find((candidate) => candidate.server.id === composeState.serverId && candidate.container.id === composeState.containerId);
      if (entry) {
        onComposeApplied(entry);
      }
    } catch (error) {
      setComposeState((current) => current ? {
        ...current,
        saving: false,
        error: error instanceof Error ? error.message : 'Unable to update Docker Compose file.',
      } : undefined);
    }
  }, [composeState, entries, onComposeApplied]);

  const handleContainerUrlOverride = useCallback((entry: ContainerEntry, currentUrl: string | undefined) => {
    const { container } = entry;
    const rawValue = window.prompt(`URL for ${container.name}. Leave blank to remove.`, currentUrl ?? '');

    if (rawValue === null) {
      return;
    }

    const normalizedUrl = normalizeContainerUrlOverride(rawValue);

    if (rawValue.trim() && !normalizedUrl) {
      window.alert('Enter a valid http:// or https:// URL.');
      return;
    }

    onSetUrlOverride(entry, normalizedUrl);
    setMessage(normalizedUrl ? `${container.name} URL saved.` : `${container.name} URL removed.`);
    setOpenMenuId('');
  }, [onSetUrlOverride]);

  const handleContainerIconOverride = useCallback((entry: ContainerEntry, currentIcon: string | undefined) => {
    const { container } = entry;
    const rawValue = window.prompt(`Icon URL for ${container.name}. Leave blank to remove.`, currentIcon ?? '');

    if (rawValue === null) {
      return;
    }

    const normalizedIcon = normalizeContainerIconOverride(rawValue);

    if (rawValue.trim() && !normalizedIcon) {
      window.alert('Enter a valid http:// or https:// icon URL.');
      return;
    }

    onSetIconOverride(entry, normalizedIcon);
    setMessage(normalizedIcon ? `${container.name} icon saved.` : `${container.name} icon removed.`);
    setOpenMenuId('');
  }, [onSetIconOverride]);

  const handleContainerAppVisibility = useCallback((entry: ContainerEntry, hidden: boolean) => {
    onSetAppHidden(entry, hidden);
    setMessage(`${entry.container.name} ${hidden ? 'hidden from' : 'shown in'} app view.`);
  }, [onSetAppHidden]);

  useEffect(() => {
    if (!openMenuId) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;

      if (!(target instanceof Element)) {
        return;
      }

      if (target.closest('.container-app-menu, .container-app-menu-button')) {
        return;
      }

      setOpenMenuId('');
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenuId('');
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenuId]);

  const handleDragStart = useCallback((event: React.DragEvent<HTMLElement>, key: string) => {
    setDraggedKey(key);
    suppressClickRef.current = true;
    lastDragTargetRef.current = '';
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', key);
    dragPreviewRef.current = createDragPreview(event);
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLElement>, key: string) => {
    const sourceKey = draggedKey || event.dataTransfer.getData('text/plain');

    if (!sourceKey || sourceKey === key) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    dragPreviewRef.current?.move(event);
    setDragOverKey(key);

    if (lastDragTargetRef.current === key) {
      return;
    }

    lastDragTargetRef.current = key;
    const currentOrder = orderedAppEntries.map(containerAppOrderKey);
    const sourceIndex = currentOrder.indexOf(sourceKey);
    const targetIndex = currentOrder.indexOf(key);

    if (sourceIndex === -1 || targetIndex === -1) {
      return;
    }

    const nextOrder = [...currentOrder];
    const [movedKey] = nextOrder.splice(sourceIndex, 1);
    nextOrder.splice(targetIndex, 0, movedKey);
    onOrderChange(nextOrder);
  }, [draggedKey, onOrderChange, orderedAppEntries]);

  const handleDrop = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDraggedKey('');
    setDragOverKey('');
    lastDragTargetRef.current = '';
  }, []);

  const handleDrag = useCallback((event: React.DragEvent<HTMLElement>) => {
    dragPreviewRef.current?.move(event);
  }, []);

  const handleDragEnd = useCallback((event: React.DragEvent<HTMLElement>) => {
    dragPreviewRef.current?.finish(event.currentTarget);
    dragPreviewRef.current = undefined;
    setDraggedKey('');
    setDragOverKey('');
    lastDragTargetRef.current = '';
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  }, []);

  if (!entries.length) {
    return <div className="empty-state panel-empty">{emptyMessage}</div>;
  }

  return (
    <>
      {message && <p className="message container-message">{message}</p>}
      {viewMode === 'apps' ? (
        visibleAppEntries.length ? (
          <div className={`container-app-grid ${showServer ? 'all-container-app-grid' : ''}`}>
            {visibleAppEntries.map((entry) => {
              const { server, container } = entry;
              const key = containerEntryKey(entry);
              const orderKey = containerAppOrderKey(entry);
              const overrideUrl = urlOverrides[containerOverrideKey(server.id, container.name)];
              const overrideIcon = iconOverrides[containerOverrideKey(server.id, container.name)];
              const inferredUrl = containerUrl(server, container);
              const url = overrideUrl ?? inferredUrl;
              const pendingAction = pendingActions[key];
              const logsPending = pendingLogsId === key;
              const actionDisabled = Boolean(pendingAction);
              const menuOpen = openMenuId === key;
              const hasComposeSettings = Boolean(container.composeConfigFiles?.length);

	              return (
                <article
                  className={`container-app-card ${showServer ? 'with-server' : ''} ${menuOpen ? 'menu-open' : ''} ${draggedKey === orderKey ? 'dragging' : ''} ${dragOverKey === orderKey ? 'drag-over' : ''}`}
                  key={key}
                  draggable
                  onDragStart={(event) => handleDragStart(event, orderKey)}
                  onDrag={handleDrag}
                  onDragOver={(event) => handleDragOver(event, orderKey)}
                  onDrop={handleDrop}
                  onDragEnd={handleDragEnd}
                  style={{
                    '--container-accent': containerAccent(container.name),
                    viewTransitionName: draggedKey === orderKey ? 'none' : viewTransitionName('container-app', key),
                  } as React.CSSProperties}
                >
                  <button
                    type="button"
                    className={url ? 'container-app-launch' : 'container-app-launch disabled'}
                    title={url ? `Open ${container.name}` : `${container.name} has no inferred URL`}
                    onClick={() => {
                      if (suppressClickRef.current) {
                        return;
                      }

                      if (url) {
                        openContainerUrl(server, container, overrideUrl);
                      }
                    }}
                  >
                    <span className="container-app-icon-wrap">
                      {showServer && <ServerIconBadge server={server} size={13} className="container-app-server-badge" />}
                      <span className={`container-app-icon ${container.state}`}>
                        {overrideIcon ? (
                          <img src={overrideIcon} alt="" loading="lazy" draggable={false} />
                        ) : (
                          <span>{containerInitials(container.name)}</span>
                        )}
                      </span>
                    </span>
                    <strong>{container.name}</strong>
                    {!showServer && <small>{container.image}</small>}
                  </button>
                  <button
                    type="button"
                    className="container-app-menu-button"
                    title={`Manage ${container.name}`}
                    aria-expanded={menuOpen}
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuId(menuOpen ? '' : key);
                    }}
                  >
                    <MoreHorizontal size={18} />
                  </button>
                  {menuOpen && (
                    <div className="container-app-menu">
                      <button type="button" disabled={!url} onClick={() => url && openContainerUrl(server, container, overrideUrl)}>
                        <ExternalLink size={14} /> Open
                      </button>
                      <button type="button" disabled={!hasComposeSettings} onClick={() => void handleComposeSettings(entry)}>
                        <Settings size={14} /> Settings
                      </button>
                      <button type="button" disabled={logsPending} onClick={() => void handleContainerLogs(entry)}>
                        {logsPending ? <RefreshCw size={14} className="spin-icon" /> : <FileText size={14} />} Logs
                      </button>
                      <button type="button" onClick={() => handleContainerUrlOverride(entry, overrideUrl)}>
                        <Edit3 size={14} /> URL
                      </button>
                      <button type="button" onClick={() => handleContainerIconOverride(entry, overrideIcon)}>
                        <Image size={14} /> Icon
                      </button>
                      <span className="container-app-menu-divider" />
                      <button type="button" disabled={actionDisabled || !canControlContainer(container, 'start')} onClick={() => void handleContainerAction(entry, 'start')}>
                        {pendingAction === 'start' ? <RefreshCw size={14} className="spin-icon" /> : <Play size={14} />} Start
                      </button>
                      <button type="button" disabled={actionDisabled || !canControlContainer(container, 'restart')} onClick={() => void handleContainerAction(entry, 'restart')}>
                        <RefreshCw size={14} className={pendingAction === 'restart' ? 'spin-icon' : undefined} /> Restart
                      </button>
                      <button type="button" className="danger-menu-item" disabled={actionDisabled || !canControlContainer(container, 'stop')} onClick={() => void handleContainerAction(entry, 'stop')}>
                        {pendingAction === 'stop' ? <RefreshCw size={14} className="spin-icon" /> : <Square size={14} />} Stop
                      </button>
                    </div>
                  )}
                  <span className={`container-app-status ${container.state}`}>{container.state}</span>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-state panel-empty">All containers are hidden from app view.</div>
        )
      ) : (
        <div className="container-table">
          <div className={`container-row header ${showServer ? 'with-server' : ''}`}>
            {showServer && <span>Server</span>}<span>Name</span><span>Image</span><span>Status</span><span>Actions</span>
          </div>
          {entries.map((entry) => {
            const { server, container } = entry;
            const key = containerEntryKey(entry);
            const overrideUrl = urlOverrides[containerOverrideKey(server.id, container.name)];
            const inferredUrl = containerUrl(server, container);
            const url = overrideUrl ?? inferredUrl;
            const showUrlOverrideControl = !inferredUrl;
            const pendingAction = pendingActions[key];
            const logsPending = pendingLogsId === key;
            const actionDisabled = Boolean(pendingAction);
            const hasComposeSettings = Boolean(container.composeConfigFiles?.length);
            const hiddenFromApps = Boolean(hiddenAppContainers[containerAppVisibilityKey(entry)]);

            return (
              <div className={`container-row ${showServer ? 'with-server' : ''}`} key={key}>
                {showServer && <span className="container-server-cell" title={`${server.username}@${server.host}:${server.port}`}>{server.alias}</span>}
                <span className="container-name-cell">
                  {showUrlOverrideControl && (
                    <button
                      type="button"
                      className={`container-action url container-url-edit ${overrideUrl ? 'configured' : ''}`}
                      title={overrideUrl ? `Edit URL: ${overrideUrl}` : `Set URL for ${container.name}`}
                      onClick={() => handleContainerUrlOverride(entry, overrideUrl)}
                    >
                      <Edit3 size={14} />
                    </button>
                  )}
                  {url ? (
                    <button
                      type="button"
                      className="container-name-link"
                      title={url}
                      onClick={() => openContainerUrl(server, container, overrideUrl)}
                    >
                      {container.name}
                    </button>
                  ) : (
                    <span className="container-name" title={`${container.name} (${container.id})`}>{container.name}</span>
                  )}
                </span>
                <span title={container.image}>{container.image}</span>
                <strong className={`container-status ${container.state}`}>{container.status}</strong>
                <span className="container-actions">
                  <button
                    type="button"
                    className={`container-action app-visibility ${hiddenFromApps ? 'hidden' : ''}`}
                    title={hiddenFromApps ? `Show ${container.name} in app view` : `Hide ${container.name} from app view`}
                    aria-pressed={hiddenFromApps}
                    onClick={() => handleContainerAppVisibility(entry, !hiddenFromApps)}
                  >
                    {hiddenFromApps ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                  <button
                    type="button"
                    className="container-action app-visibility"
                    title={hasComposeSettings ? `Edit Compose settings for ${container.name}` : `${container.name} has no discoverable Compose file`}
                    disabled={!hasComposeSettings}
                    onClick={() => void handleComposeSettings(entry)}
                  >
                    <Settings size={14} />
                  </button>
                  <button
                    type="button"
                    className={`container-action app-visibility ${logsPending ? 'pending' : ''}`}
                    title={`Show logs for ${container.name}`}
                    disabled={logsPending}
                    onClick={() => void handleContainerLogs(entry)}
                  >
                    {logsPending ? <RefreshCw size={14} className="spin-icon" /> : <FileText size={14} />}
                  </button>
                  <button
                    type="button"
                    className={`container-action start ${pendingAction === 'start' ? 'pending' : ''}`}
                    title={`Start ${container.name}`}
                    disabled={actionDisabled || !canControlContainer(container, 'start')}
                    onClick={() => void handleContainerAction(entry, 'start')}
                  >
                    {pendingAction === 'start' ? <RefreshCw size={14} className="spin-icon" /> : <Play size={14} />}
                  </button>
                  <button
                    type="button"
                    className={`container-action stop ${pendingAction === 'stop' ? 'pending' : ''}`}
                    title={`Stop ${container.name}`}
                    disabled={actionDisabled || !canControlContainer(container, 'stop')}
                    onClick={() => void handleContainerAction(entry, 'stop')}
                  >
                    {pendingAction === 'stop' ? <RefreshCw size={14} className="spin-icon" /> : <Square size={14} />}
                  </button>
                  <button
                    type="button"
                    className={`container-action restart ${pendingAction === 'restart' ? 'pending' : ''}`}
                    title={`Reset ${container.name}`}
                    disabled={actionDisabled || !canControlContainer(container, 'restart')}
                    onClick={() => void handleContainerAction(entry, 'restart')}
                  >
                    <RefreshCw size={14} className={pendingAction === 'restart' ? 'spin-icon' : undefined} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {logsState && (
        <section className="container-logs-panel">
          <div className="container-logs-heading">
            <div>
              <h4>{logsState.containerName} Logs</h4>
              <span>Last 200 lines</span>
            </div>
            <div className="container-logs-actions">
              <button
                type="button"
                className="command compact-command"
                disabled={pendingLogsId === logsState.serverId + ':' + logsState.containerId}
                onClick={() => {
                  const entry = entries.find((candidate) => candidate.server.id === logsState.serverId && candidate.container.id === logsState.containerId);

                  if (entry) {
                    void handleContainerLogs(entry);
                  }
                }}
              >
                <RefreshCw size={14} /> Refresh
              </button>
              <button type="button" className="icon-command" title="Close logs" onClick={() => setLogsState(undefined)}>
                <XCircle size={15} />
              </button>
            </div>
          </div>
          <pre>{logsState.logs}</pre>
        </section>
      )}
      {composeState && (
        <div className="compose-modal-backdrop" onClick={() => !composeState.saving && setComposeState(undefined)}>
          <section className="compose-modal" role="dialog" aria-modal="true" aria-label={`${composeState.containerName} settings`} onClick={(event) => event.stopPropagation()}>
            <div className="compose-modal-heading">
              <div>
                <h3>{composeState.containerName} Settings</h3>
                <span>{composeState.composeFile ?? `${composeState.serverAlias} Docker Compose`}</span>
              </div>
              <div className="compose-modal-actions">
                <button
                  type="button"
                  className="command compact-command"
                  disabled={composeState.loading || composeState.saving}
                  onClick={() => {
                    const entry = entries.find((candidate) => candidate.server.id === composeState.serverId && candidate.container.id === composeState.containerId);
                    if (entry) {
                      void handleComposeSettings(entry);
                    }
                  }}
                >
                  <RefreshCw size={14} /> Reload
                </button>
                <button
                  type="button"
                  className="command compact-command"
                  disabled={composeState.loading || composeState.saving || composeState.content === composeState.originalContent}
                  onClick={() => void saveComposeSettings()}
                >
                  {composeState.saving ? <RefreshCw size={14} className="spin-icon" /> : <Save size={14} />} Save & Apply
                </button>
                <button type="button" className="icon-command" title="Close settings" disabled={composeState.saving} onClick={() => setComposeState(undefined)}>
                  <XCircle size={15} />
                </button>
              </div>
            </div>
            <div className="compose-meta">
              {composeState.project && <span><strong>Project</strong>{composeState.project}</span>}
              {composeState.service && <span><strong>Service</strong>{composeState.service}</span>}
              {composeState.workingDir && <span><strong>Working dir</strong>{composeState.workingDir}</span>}
            </div>
            {composeState.error && <p className="compose-message error">{composeState.error}</p>}
            {composeState.message && <p className="compose-message">{composeState.message}</p>}
            {composeState.loading ? (
              <div className="compose-loading"><RefreshCw size={16} className="spin-icon" /> Loading compose file...</div>
            ) : (
              <ComposeSettingsEditor
                content={composeState.content}
                serviceName={composeState.service}
                onChange={(content) => setComposeState((current) => current ? { ...current, content, error: undefined, message: undefined } : undefined)}
              />
            )}
          </section>
        </div>
      )}
    </>
  );
}

function containerInitials(name: string): string {
  const words = name
    .replace(/[-_.]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length > 1) {
    return words.slice(0, 2).map((word) => word[0]).join('').toUpperCase();
  }

  return (words[0] ?? name).slice(0, 2).toUpperCase();
}

function containerAccent(name: string): string {
  const palette = ['#8ab4ff', '#5eead4', '#86efac', '#fbbf24', '#fda4af', '#c4b5fd', '#67e8f9', '#f0abfc'];
  let hash = 0;

  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return palette[hash % palette.length];
}

function containerEntryKey(entry: ContainerEntry): string {
  return entry.server.id + ':' + entry.container.id;
}

function containerAppOrderKey(entry: ContainerEntry): string {
  if (entry.container.composeProject && entry.container.composeService) {
    return entry.server.id + ':compose:' + entry.container.composeProject + '/' + entry.container.composeService;
  }

  return entry.server.id + ':name:' + entry.container.name;
}

function containerAppVisibilityKey(entry: ContainerEntry): string {
  return containerOverrideKey(entry.server.id, entry.container.name);
}

function containerOrderContextKey(serverId: string): string {
  return 'server:' + serverId;
}

function orderContainerEntries(entries: ContainerEntry[], order: string[]): ContainerEntry[] {
  if (!order.length) {
    return entries;
  }

  const entriesByStableKey = new Map(entries.map((entry) => [containerAppOrderKey(entry), entry]));
  const entriesByLegacyKey = new Map(entries.map((entry) => [containerEntryKey(entry), entry]));
  const orderedKeys = new Set<string>();
  const orderedEntries: ContainerEntry[] = [];

  for (const key of order) {
    const entry = entriesByStableKey.get(key) ?? entriesByLegacyKey.get(key);
    const stableKey = entry ? containerAppOrderKey(entry) : '';

    if (entry && !orderedKeys.has(stableKey)) {
      orderedEntries.push(entry);
      orderedKeys.add(stableKey);
    }
  }

  const unorderedEntries = entries.filter((entry) => !orderedKeys.has(containerAppOrderKey(entry)));

  return [...orderedEntries, ...unorderedEntries];
}

function viewTransitionName(prefix: string, value: string): string {
  return `${prefix}-${value.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

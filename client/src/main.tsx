import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowLeft,
  BellRing,
  Container,
  Edit3,
  ExternalLink,
  Folder,
  HardDrive,
  Image,
  Monitor,
  Network,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Server,
  TerminalSquare,
  Thermometer,
  Trash2,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import './styles.css';
import { emptyForm, METRICS_SESSION_KEY, SERVER_VIEW_SESSION_KEY } from './constants';
import type { ActiveView, AppPreferences, AppTheme, AppVersionInfo, AppWallpaperInfo, ContainerPreferences, RefreshRate, ServerFormState, ServerProfile, SystemMetrics, TemperatureReading } from './types';
import { buildPayload, controlContainer, fetchAppVersion, fetchAppWallpaper, killProcess, saveAppWallpaper } from './lib/api';
import { isActiveView, mergeMetricsSnapshot, normalizeServerOrder, orderServers, parseMetricsStreamMessage, viewTransitionName, viewUsesMetrics } from './lib/appState';
import { removeRecordKey } from './lib/records';
import { readSessionRecord, writeSessionRecord } from './lib/storage';
import {
  APP_THEME_LABELS,
  APP_THEMES_ORDER,
  defaultAppPreferences,
  fetchPreferences,
  normalizeAppPreferences,
  savePreferences,
  updateContainerPreferences,
} from './lib/preferences';
import { runLayoutTransition } from './lib/viewTransition';
import { buildWebSocketUrl } from './lib/websocket';
import { registerServiceWorker } from './lib/pwa';
import { AllContainersPanel, ContainersPanel } from './components/ContainersPanel';
import { FilesPanel } from './components/FilesPanel';
import { BatteryPill } from './components/BatteryIndicator';
import {
  CompactMetric,
  DiskRatePair,
  fetchTemperatureSnapshot,
  findTemperatureReading,
  FleetOverview,
  formatTemperature,
  NethogsDialog,
  NetworkRatePair,
  temperatureReadingKey,
  TemperatureDialog,
} from './components/FleetOverview';
import { Overview } from './components/Overview';
import { RefreshRateSelect } from './components/RefreshRateSelect';
import { ServerForm } from './components/ServerForm';
import { ServerIconBadge } from './components/ServerIcon';
import { ServicesPanel } from './components/ServicesPanel';
import { TerminalSessions } from './components/TerminalPanel';
import { VncPanel } from './components/VncPanel';

const DISMISSED_UPDATE_VERSION_KEY = 'homedashboard.dismissedUpdateVersion';

registerServiceWorker();

function App() {
  const [servers, setServers] = useState<ServerProfile[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [metricsByServer, setMetricsByServer] = useState<Record<string, SystemMetrics>>(() => readSessionRecord<SystemMetrics>(METRICS_SESSION_KEY));
  const [refreshingMetricsByServer, setRefreshingMetricsByServer] = useState<Record<string, boolean>>({});
  const [serverViewByServer, setServerViewByServer] = useState<Record<string, ActiveView>>(() => readSessionServerViews());
  const [form, setForm] = useState<ServerFormState>(emptyForm);
  const [editing, setEditing] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>('overview');
  const [preferences, setPreferences] = useState<AppPreferences>(() => defaultAppPreferences());
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [appVersion, setAppVersion] = useState<AppVersionInfo | undefined>();
  const [appWallpaper, setAppWallpaper] = useState<AppWallpaperInfo>({ exists: false });
  const [wallpaperUploading, setWallpaperUploading] = useState(false);
  const [dismissedUpdateVersion, setDismissedUpdateVersion] = useState(() => readDismissedUpdateVersion());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const lastSavedPreferencesRef = useRef('');
  const metricsSocketRef = useRef<WebSocket | null>(null);

  const orderedServers = useMemo(() => orderServers(servers, preferences.serverOrder), [preferences.serverOrder, servers]);
  const selectedServer = useMemo(() => orderedServers.find((server) => server.id === selectedId), [orderedServers, selectedId]);
  const selectedMetrics = selectedId ? metricsByServer[selectedId] : undefined;
  const fleetWallpaperActive = !selectedServer && Boolean(appWallpaper.url) && (activeView === 'overview' || activeView === 'containers');
  const mainPanelClassName = fleetWallpaperActive ? 'main-panel wallpaper-board has-wallpaper' : 'main-panel';
  const mainPanelStyle = fleetWallpaperActive ? ({ backgroundImage: `url("${appWallpaper.url}")` } as React.CSSProperties) : undefined;
  const allContainerCount = useMemo(() => {
    return orderedServers.reduce((total, server) => total + (metricsByServer[server.id]?.containers.length ?? 0), 0);
  }, [metricsByServer, orderedServers]);
  const fleetOnlineState = useMemo((): 'online' | 'offline' | 'warning' | 'unknown' => {
    if (!orderedServers.length) {
      return 'unknown';
    }

    const serverStates = orderedServers.map((server) => metricsByServer[server.id]?.online);

    if (serverStates.every((online) => online === false)) {
      return 'offline';
    }

    if (serverStates.some((online) => online === false)) {
      return 'warning';
    }

    if (serverStates.some((online) => online === true)) {
      return 'online';
    }

    return 'unknown';
  }, [metricsByServer, orderedServers]);

  const loadServers = useCallback(async () => {
    const response = await fetch('/api/servers');
    const data = (await response.json()) as ServerProfile[];
    setServers(data);
    setPreferences((current) => ({
      ...current,
      serverOrder: normalizeServerOrder(data, current.serverOrder),
    }));
    setSelectedId((current) => (data.some((server) => server.id === current) ? current : ''));
  }, []);

  const loadMetrics = useCallback(async (serverId: string) => {
    setRefreshingMetricsByServer((current) => ({ ...current, [serverId]: true }));

    try {
      const response = await fetch(`/api/servers/${serverId}/metrics?refresh=true`);
      const body = (await response.json()) as SystemMetrics & { message?: string };

      if (!response.ok) {
        throw new Error(body.message ?? 'Unable to load metrics.');
      }

      setMetricsByServer((current) => ({ ...current, [serverId]: mergeMetricsSnapshot(current[serverId], body) }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to load metrics.');
    } finally {
      setRefreshingMetricsByServer((current) => removeRecordKey(current, serverId));
    }
  }, []);

  const loadMetricsForServers = useCallback(async (serverIds: string[]) => {
    const uniqueServerIds = serverIds.filter((serverId, index) => Boolean(serverId) && serverIds.indexOf(serverId) === index);

    if (!uniqueServerIds.length) {
      return;
    }

    await Promise.all(uniqueServerIds.map((serverId) => loadMetrics(serverId)));
  }, [loadMetrics]);

  const updatePreferences = useCallback((update: (current: AppPreferences) => AppPreferences) => {
    setPreferences((current) => normalizeAppPreferences(update(current)));
  }, []);

  const updateContainerPreferencesState = useCallback((update: (current: ContainerPreferences) => ContainerPreferences) => {
    updatePreferences((current) => updateContainerPreferences(current, update));
  }, [updatePreferences]);

  const setPreferenceField = useCallback(function <Key extends keyof AppPreferences>(key: Key, value: AppPreferences[Key]) {
    updatePreferences((current) => ({ ...current, [key]: value }));
  }, [updatePreferences]);

  useEffect(() => {
    let cancelled = false;

    void fetchAppVersion()
      .then((versionInfo) => {
        if (!cancelled) {
          setAppVersion(versionInfo);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAppVersion(undefined);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void fetchAppWallpaper()
      .then((wallpaper) => {
        if (!cancelled) {
          setAppWallpaper(wallpaper);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAppWallpaper({ exists: false });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const uploadWallpaper = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) {
      window.alert('Choose an image file.');
      return;
    }

    setWallpaperUploading(true);

    try {
      const dataUrl = await readFileAsDataUrl(file);
      const wallpaper = await saveAppWallpaper(dataUrl);
      setAppWallpaper(wallpaper);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Unable to upload wallpaper.');
    } finally {
      setWallpaperUploading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void fetchPreferences()
      .then((serverPreferences) => {
        if (cancelled) {
          return;
        }

        lastSavedPreferencesRef.current = JSON.stringify(serverPreferences);
        setPreferences(serverPreferences);
        setPreferencesLoaded(true);
      })
      .catch((error) => {
        if (!cancelled) {
          setPreferencesLoaded(true);
          setMessage(error instanceof Error ? error.message : 'Unable to load preferences.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void loadServers().catch((error) => setMessage(error.message));
  }, [loadServers]);

  useEffect(() => {
    writeSessionRecord(METRICS_SESSION_KEY, metricsByServer);
  }, [metricsByServer]);

  useEffect(() => {
    writeSessionRecord(SERVER_VIEW_SESSION_KEY, serverViewByServer);
  }, [serverViewByServer]);

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme;
  }, [preferences.theme]);

  useEffect(() => {
    if (!preferencesLoaded) {
      return;
    }

    const serialized = JSON.stringify(preferences);

    if (serialized === lastSavedPreferencesRef.current) {
      return;
    }

    const timeout = window.setTimeout(() => {
      void savePreferences(preferences)
        .then((savedPreferences) => {
          lastSavedPreferencesRef.current = JSON.stringify(savedPreferences);
        })
        .catch((error) => {
          setMessage(error instanceof Error ? error.message : 'Unable to save preferences.');
        });
    }, 500);

    return () => window.clearTimeout(timeout);
  }, [preferences, preferencesLoaded]);

  const activeMetricServerIds = useMemo(() => {
    if (selectedId) {
      return viewUsesMetrics(activeView) ? [selectedId] : [];
    }

    if (viewUsesMetrics(activeView)) {
      return orderedServers.map((server) => server.id);
    }

    return [];
  }, [activeView, orderedServers, selectedId]);
  const metricsStreamRefreshRate = selectedId ? preferences.serverRefreshRate : preferences.fleetRefreshRate;

  useEffect(() => {
    const serverIds = activeMetricServerIds;

    if (!serverIds.length) {
      metricsSocketRef.current?.close();
      metricsSocketRef.current = null;
      return;
    }

    let cancelled = false;
    let reconnectTimer: number | undefined;

    const connect = () => {
      if (cancelled) {
        return;
      }

      void buildWebSocketUrl('/api/metrics/stream')
        .then((url) => {
          if (cancelled) {
            return;
          }

          const socket = new WebSocket(url);
          metricsSocketRef.current = socket;

          socket.addEventListener('open', () => {
            socket.send(JSON.stringify({ type: 'subscribe', serverIds, intervalMs: metricsStreamRefreshRate }));
          });

          socket.addEventListener('message', (event) => {
            const message = parseMetricsStreamMessage(event.data);

            if (message?.type !== 'metrics:update') {
              return;
            }

            setMetricsByServer((current) => ({ ...current, [message.serverId]: mergeMetricsSnapshot(current[message.serverId], message.metrics) }));
          });

          socket.addEventListener('close', () => {
            if (metricsSocketRef.current === socket) {
              metricsSocketRef.current = null;
            }

            if (!cancelled) {
              reconnectTimer = window.setTimeout(connect, 2000);
            }
          });

          socket.addEventListener('error', () => {
            socket.close();
          });
        })
        .catch(() => {
          if (!cancelled) {
            reconnectTimer = window.setTimeout(connect, 2000);
          }
        });
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      metricsSocketRef.current?.close();
      metricsSocketRef.current = null;
    };
  }, [activeMetricServerIds, metricsStreamRefreshRate]);

  const startCreate = () => {
    setEditing(false);
    setSelectedId('');
    setForm(emptyForm);
    setProfileOpen(true);
    setMessage('');
  };

  const loadIntoForm = (server: ServerProfile) => {
    setSelectedId(server.id);
    setEditing(true);
    setForm({
      alias: server.alias,
      host: server.host,
      port: String(server.port),
      username: server.username,
      authMethod: server.authMethod,
      password: '',
      privateKeyName: server.privateKeyName ?? '',
      privateKey: '',
      serverIcon: server.serverIcon ?? '',
      serverIconColor: server.serverIconColor ?? '',
    });
  };

  const startEdit = () => {
    if (selectedServer) {
      if (profileOpen && editing) {
        setProfileOpen(false);
        return;
      }

      loadIntoForm(selectedServer);
      setProfileOpen(true);
    }
  };

  const showFleet = () => {
    setSelectedId('');
    setEditing(false);
    setForm(emptyForm);
    setProfileOpen(false);
    setActiveView('overview');
    setMessage('');
  };

  const showAllContainers = () => {
    setSelectedId('');
    setEditing(false);
    setForm(emptyForm);
    setProfileOpen(false);
    setActiveView('containers');
    setMessage('');
  };

  const selectServer = (server: ServerProfile) => {
    loadIntoForm(server);
    setActiveView(serverViewByServer[server.id] ?? 'overview');
  };

  const selectServerView = (view: ActiveView) => {
    setActiveView(view);
    if (selectedId) {
      setServerViewByServer((current) => ({ ...current, [selectedId]: view }));
    }
  };

  const reorderServers = useCallback((nextOrder: string[]) => {
    runLayoutTransition(() => setPreferenceField('serverOrder', normalizeServerOrder(servers, nextOrder)));
  }, [servers, setPreferenceField]);

  const saveServer = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');

    try {
      const payload = buildPayload(form);
      const url = editing && selectedServer ? `/api/servers/${selectedServer.id}` : '/api/servers';
      const response = await fetch(url, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => undefined);

      if (!response.ok) {
        throw new Error(body?.message ?? 'Unable to save server.');
      }

      const saved = body as ServerProfile;
      await loadServers();
      setSelectedId(saved.id);
      setEditing(true);
      setForm((current) => ({ ...current, password: '', privateKey: '' }));
      setMessage('Server saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to save server.');
    } finally {
      setBusy(false);
    }
  };

  const deleteServer = async () => {
    if (!selectedServer) {
      return;
    }

    if (!window.confirm(`Delete ${selectedServer.alias}? This removes the saved server profile from HomeDashboard.`)) {
      return;
    }

    setBusy(true);
    setMessage('');

    try {
      const response = await fetch(`/api/servers/${selectedServer.id}`, { method: 'DELETE' });

      if (!response.ok) {
        throw new Error('Unable to delete server.');
      }

      setMetricsByServer((current) => removeRecordKey(current, selectedServer.id));
      setServerViewByServer((current) => removeRecordKey(current, selectedServer.id));
      updatePreferences((current) => ({
        ...current,
        userMountsOnlyByServer: removeRecordKey(current.userMountsOnlyByServer, selectedServer.id),
        defaultDiskMountByServer: removeRecordKey(current.defaultDiskMountByServer, selectedServer.id),
        overviewSectionsByServer: removeRecordKey(current.overviewSectionsByServer, selectedServer.id),
        defaultTemperatureReadingByServer: removeRecordKey(current.defaultTemperatureReadingByServer, selectedServer.id),
      }));
      await loadServers();
      startCreate();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to delete server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className={preferences.sidebarCollapsed ? 'app-shell sidebar-collapsed' : 'app-shell'}>
      <button
        type="button"
        className="sidebar-restore-tab"
        title="Show sidebar"
        aria-label="Show sidebar"
        aria-hidden={!preferences.sidebarCollapsed}
        tabIndex={preferences.sidebarCollapsed ? 0 : -1}
        onClick={() => setPreferenceField('sidebarCollapsed', false)}
      >
        <PanelLeftOpen size={17} />
      </button>
      <aside className="sidebar">
        <button type="button" className="sidebar-collapse-tab" title="Hide sidebar" aria-label="Hide sidebar" onClick={() => setPreferenceField('sidebarCollapsed', true)}>
          <PanelLeftClose size={16} />
        </button>
        <div className="brand">
          <div className="brand-identity">
            <span className="brand-mark"><Server size={22} /></span>
            <div>
              <strong>HomeDashboard</strong>
              <span>Infrastructure Control</span>
            </div>
          </div>
        </div>
        <label className="theme-picker" title="Theme">
          <Palette size={16} />
          <select value={preferences.theme} onChange={(event) => setPreferenceField('theme', event.target.value as AppTheme)} aria-label="Theme">
            {APP_THEMES_ORDER.map((appTheme) => (
              <option key={appTheme} value={appTheme}>{APP_THEME_LABELS[appTheme]}</option>
            ))}
          </select>
        </label>
        <button className="command full" onClick={startCreate}>
          <Plus size={16} /> New Server
        </button>
        <button className={!selectedId && activeView === 'overview' ? 'fleet-row active' : 'fleet-row'} onClick={showFleet}>
          <span className={`server-dot ${fleetOnlineState}`} />
          <span>
            <strong>All Servers</strong>
            <small>Fleet overview</small>
          </span>
          <span className="server-auth">{orderedServers.length}</span>
        </button>
        <button className={!selectedId && activeView === 'containers' ? 'fleet-row active' : 'fleet-row'} onClick={showAllContainers}>
          <span className={`server-dot ${fleetOnlineState}`} />
          <span>
            <strong>All Containers</strong>
            <small>Container fleet</small>
          </span>
          <span className="server-auth">{allContainerCount}</span>
        </button>
        <div className="server-list-header">
          <span>Servers</span>
          <strong>{orderedServers.length}</strong>
        </div>
        <nav className="server-list">
          {orderedServers.map((server) => {
            const serverMetrics = metricsByServer[server.id];
            const serverOnlineState = serverMetrics?.online === true ? 'online' : serverMetrics?.online === false ? 'offline' : 'unknown';

            return (
              <button
                key={server.id}
                className={server.id === selectedId ? 'server-row active' : 'server-row'}
                style={{ viewTransitionName: viewTransitionName('sidebar-server', server.id) } as React.CSSProperties}
                onClick={() => selectServer(server)}
              >
                <span className={`server-dot ${serverOnlineState}`} />
                <ServerIconBadge server={server} className="sidebar-server-icon" />
                <span className="server-info">
                  <strong>{server.alias}</strong>
                  <small>{server.username}@{server.host}:{server.port}</small>
                </span>
                <span className="server-row-badges">
                  <BatteryPill battery={serverMetrics?.battery} className="sidebar-battery-pill" />
                  <span className="server-auth">{server.authMethod === 'privateKey' ? 'key' : 'pwd'}</span>
                </span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <UpdateNotice
            versionInfo={appVersion}
            dismissedVersion={dismissedUpdateVersion}
            onDismiss={(version) => {
              writeDismissedUpdateVersion(version);
              setDismissedUpdateVersion(version);
            }}
          />
          <AppVersionFooter versionInfo={appVersion} />
        </div>
      </aside>

      <section className={selectedServer ? 'workspace' : 'workspace fleet-workspace'}>
        {selectedServer && (
        <SelectedServerHeader
          server={selectedServer}
          metrics={selectedMetrics}
          refreshRate={preferences.serverRefreshRate}
          showMetricControls={viewUsesMetrics(activeView)}
          onRefreshRateChange={(value) => setPreferenceField('serverRefreshRate', value)}
          preferredTemperatureByServer={preferences.defaultTemperatureReadingByServer}
          onPreferredTemperatureChange={(value) => setPreferenceField('defaultTemperatureReadingByServer', value)}
          onRefreshMetrics={() => void loadMetrics(selectedServer.id)}
          metricsRefreshing={Boolean(refreshingMetricsByServer[selectedServer.id])}
          onBack={showFleet}
          onEdit={startEdit}
          onDelete={() => void deleteServer()}
          busy={busy}
        />
        )}

        <div className={profileOpen ? 'content-grid with-profile' : 'content-grid'}>
          <section className={mainPanelClassName} style={mainPanelStyle}>
            {selectedServer && (
            <div className="tabs">
              <button className={activeView === 'overview' ? 'active' : ''} onClick={() => selectServerView('overview')}>
                <Activity size={16} /> Overview
              </button>
              <button className={activeView === 'files' ? 'active' : ''} onClick={() => selectServerView('files')} disabled={!selectedServer}>
                <Folder size={16} /> Files
              </button>
              <button className={activeView === 'terminal' ? 'active' : ''} onClick={() => selectServerView('terminal')} disabled={!selectedServer}>
                <TerminalSquare size={16} /> Terminal
              </button>
              <button className={activeView === 'vnc' ? 'active' : ''} onClick={() => selectServerView('vnc')} disabled={!selectedServer}>
                <Monitor size={16} /> VNC
              </button>
              <button className={activeView === 'services' ? 'active' : ''} onClick={() => selectServerView('services')} disabled={!selectedServer}>
                <Wrench size={16} /> Services
              </button>
              <button className={activeView === 'containers' ? 'active' : ''} onClick={() => selectServerView('containers')} disabled={!selectedServer}>
                <Container size={16} /> Containers
              </button>
            </div>
            )}

            <div className={activeView === 'overview' ? 'view-pane' : 'view-pane hidden'}>
              {selectedServer ? (
                <Overview
                  server={selectedServer}
                  metrics={selectedMetrics}
                  onKillProcess={async (pid) => {
                    if (!selectedServer) {
                      return;
                    }

                    await killProcess(selectedServer.id, pid);
                    await loadMetrics(selectedServer.id);
                  }}
                  userMountsOnlyByServer={preferences.userMountsOnlyByServer}
                  defaultDiskMountByServer={preferences.defaultDiskMountByServer}
                  sectionPreferencesByServer={preferences.overviewSectionsByServer}
                  onUserMountsOnlyByServerChange={(value) => setPreferenceField('userMountsOnlyByServer', value)}
                  onDefaultDiskMountByServerChange={(value) => setPreferenceField('defaultDiskMountByServer', value)}
                  onSectionPreferencesByServerChange={(value) => setPreferenceField('overviewSectionsByServer', value)}
                />
              ) : (
                <FleetOverview
                  servers={orderedServers}
                  cachedMetrics={metricsByServer}
                  refreshRate={preferences.fleetRefreshRate}
                  metricMode={preferences.fleetMetricMode}
                  preferredTemperatureByServer={preferences.defaultTemperatureReadingByServer}
                  defaultDiskMountByServer={preferences.defaultDiskMountByServer}
                  onRefreshRateChange={(value) => setPreferenceField('fleetRefreshRate', value)}
                  onMetricModeChange={(value) => setPreferenceField('fleetMetricMode', value)}
                  onPreferredTemperatureChange={(value) => setPreferenceField('defaultTemperatureReadingByServer', value)}
                  onSelect={selectServer}
                  onRefreshMetrics={loadMetricsForServers}
                  onReorder={reorderServers}
                />
              )}
            </div>
            <div className={activeView === 'files' ? 'view-pane' : 'view-pane hidden'}>
              <FilesPanel server={selectedServer} visible={activeView === 'files'} />
            </div>
            <TerminalSessions servers={orderedServers} activeServerId={selectedId} visible={activeView === 'terminal'} />
            <div className={activeView === 'vnc' ? 'view-pane' : 'view-pane hidden'}>
              <VncPanel server={selectedServer} visible={activeView === 'vnc'} />
            </div>
            <div className={activeView === 'services' ? 'view-pane' : 'view-pane hidden'}>
              <ServicesPanel server={selectedServer} visible={activeView === 'services'} />
            </div>
            <div className={activeView === 'containers' ? 'view-pane' : 'view-pane hidden'}>
              {activeView === 'containers' && (selectedServer ? (
                <ContainersPanel
                  server={selectedServer}
                  metrics={selectedMetrics}
                  onRefreshMetrics={() => selectedServer && void loadMetrics(selectedServer.id)}
                  onControlContainer={async (containerId, action) => {
                    if (!selectedServer) {
                      return;
                    }

                    await controlContainer(selectedServer.id, containerId, action);
                    await loadMetrics(selectedServer.id);
                  }}
                  preferences={preferences.containers}
                  onPreferencesChange={updateContainerPreferencesState}
                />
              ) : (
                <AllContainersPanel
                  servers={orderedServers}
                  cachedMetrics={metricsByServer}
                  onRefreshMetrics={loadMetricsForServers}
                  onBack={showFleet}
                  onControlContainer={async (server, containerId, action) => {
                    await controlContainer(server.id, containerId, action);
                    await loadMetrics(server.id);
                  }}
                  preferences={preferences.containers}
                  onPreferencesChange={updateContainerPreferencesState}
                />
              ))}
            </div>
          </section>

          {profileOpen && (
            <section className="profile-panel">
              <div className="panel-heading">
                <h2>{editing ? 'Server Profile' : 'New Server'}</h2>
                <button className="icon-command" type="button" onClick={() => setProfileOpen(false)} title="Close profile">
                  <XCircle size={16} />
                </button>
              </div>
              <ServerForm form={form} setForm={setForm} busy={busy} editing={editing} onSubmit={saveServer} />
              {message && <p className="message">{message}</p>}
            </section>
          )}
        </div>
        {!selectedServer && (activeView === 'overview' || activeView === 'containers') && (
          <WallpaperUploadControl uploading={wallpaperUploading} onUpload={(file) => void uploadWallpaper(file)} />
        )}
      </section>
    </main>
  );
}

function WallpaperUploadControl({ uploading, onUpload }: { uploading: boolean; onUpload: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="wallpaper-upload-input"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';

          if (file) {
            onUpload(file);
          }
        }}
      />
      <button
        type="button"
        className="wallpaper-upload-fab"
        title="Upload wallpaper"
        aria-label="Upload wallpaper"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? <RefreshCw size={20} className="spin-icon" /> : <Image size={21} />}
      </button>
    </>
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Unable to read image file.'));
      }
    });
    reader.addEventListener('error', () => reject(new Error('Unable to read image file.')));
    reader.readAsDataURL(file);
  });
}

function UpdateNotice({
  versionInfo,
  dismissedVersion,
  onDismiss,
}: {
  versionInfo?: AppVersionInfo;
  dismissedVersion: string;
  onDismiss: (version: string) => void;
}) {
  const update = versionInfo?.update;
  const latestVersion = update?.latestVersion ?? '';
  const currentVersion = versionInfo?.currentVersion ?? '';

  if (!update?.available || !latestVersion || dismissedVersion === latestVersion) {
    return null;
  }

  const openUpdate = () => {
    if (update.releaseUrl && update.releaseUrl !== '#') {
      window.open(update.releaseUrl, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <section className="update-notice" aria-live="polite" aria-label="Update available">
      <div className="update-notice-heading">
        <span className="update-notice-icon"><BellRing size={15} /></span>
        <div>
          <strong>Update available</strong>
          <span>{currentVersion} to {latestVersion}</span>
        </div>
        <button type="button" className="update-dismiss" title="Dismiss update" aria-label="Dismiss update" onClick={() => onDismiss(latestVersion)}>
          <X size={14} />
        </button>
      </div>
      <button type="button" className="update-action" onClick={openUpdate}>
        <ExternalLink size={15} /> Release notes
      </button>
    </section>
  );
}

function AppVersionFooter({ versionInfo }: { versionInfo?: AppVersionInfo }) {
  const revision = versionInfo?.revision ? versionInfo.revision.slice(0, 7) : undefined;

  return (
    <div className="app-version">
      <span>Version</span>
      <strong>{versionInfo?.currentVersion ?? '...'}</strong>
      {revision && <code>{revision}</code>}
    </div>
  );
}

function readDismissedUpdateVersion(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  try {
    return window.localStorage.getItem(DISMISSED_UPDATE_VERSION_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeDismissedUpdateVersion(version: string): void {
  try {
    window.localStorage.setItem(DISMISSED_UPDATE_VERSION_KEY, version);
  } catch {
    // Update dismissal is best-effort; the notice can still be dismissed in memory.
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {parseVncPopoutServerId() ? <VncPopoutApp serverId={parseVncPopoutServerId()!} /> : <App />}
  </React.StrictMode>,
);

function readSessionServerViews(): Record<string, ActiveView> {
  return Object.fromEntries(
    Object.entries(readSessionRecord<unknown>(SERVER_VIEW_SESSION_KEY))
      .filter((entry): entry is [string, ActiveView] => Boolean(entry[0].trim()) && isActiveView(entry[1])),
  );
}

function VncPopoutApp({ serverId }: { serverId: string }) {
  const [server, setServer] = useState<ServerProfile | undefined>();
  const params = new URLSearchParams(window.location.search);
  const initialHost = params.get('host') ?? undefined;
  const initialPort = params.get('port') ?? undefined;
  const initialMagnified = params.get('follow') !== 'fit';

  useEffect(() => {
    let cancelled = false;

    void fetchPreferences()
      .then((preferences) => {
        if (!cancelled) {
          document.documentElement.dataset.theme = preferences.theme;
        }
      })
      .catch(() => {
        if (!cancelled) {
          document.documentElement.dataset.theme = defaultAppPreferences().theme;
        }
      });

    void fetch('/api/servers')
      .then(async (response) => {
        const body = (await response.json()) as ServerProfile[];

        if (!response.ok) {
          throw new Error('Unable to load servers.');
        }

        const selectedServer = body.find((candidate) => candidate.id === serverId);

        if (!selectedServer) {
          throw new Error('Server was not found.');
        }

        if (!cancelled) {
          document.title = `${selectedServer.alias} VNC`;
          setServer(selectedServer);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setServer(undefined);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [serverId]);

  return (
    <main className="vnc-popout-shell">
      {server ? <VncPanel server={server} visible popout initialHost={initialHost} initialPort={initialPort} initialMagnified={initialMagnified} /> : null}
    </main>
  );
}

function parseVncPopoutServerId(): string | undefined {
  const match = /^\/vnc-popout\/([^/?#]+)\/?$/.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function SelectedServerHeader({
  server,
  metrics,
  refreshRate,
  showMetricControls,
  preferredTemperatureByServer,
  onRefreshRateChange,
  onPreferredTemperatureChange,
  onRefreshMetrics,
  metricsRefreshing,
  onBack,
  onEdit,
  onDelete,
  busy,
}: {
  server: ServerProfile;
  metrics?: SystemMetrics;
  refreshRate: RefreshRate;
  showMetricControls: boolean;
  preferredTemperatureByServer: Record<string, string>;
  onRefreshRateChange: (value: RefreshRate) => void;
  onPreferredTemperatureChange: (value: Record<string, string>) => void;
  onRefreshMetrics: () => void;
  metricsRefreshing: boolean;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const [temperatureOverride, setTemperatureOverride] = useState<TemperatureReading | undefined>();
  const [temperatureDialogOpen, setTemperatureDialogOpen] = useState(false);
  const [nethogsDialogOpen, setNethogsDialogOpen] = useState(false);
  const selectedTemperatureKey = preferredTemperatureByServer[server.id];
  const displayedTemperature = temperatureOverride ?? metrics?.temperature;
  const onlineState = metrics?.online === true ? 'online' : metrics?.online === false ? 'offline' : 'unknown';
  const metricRefreshLabel = onlineState === 'offline' ? 'Retry' : 'Metrics';
  const metricRefreshTitle = onlineState === 'offline' ? 'Retry metrics using a fresh SSH connection' : 'Refresh metrics';

  useEffect(() => {
    if (!selectedTemperatureKey) {
      setTemperatureOverride(undefined);
      return;
    }

    let cancelled = false;

    void fetchTemperatureSnapshot(server.id)
      .then((snapshot) => {
        if (!cancelled) {
          setTemperatureOverride(findTemperatureReading(snapshot.readings, selectedTemperatureKey));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTemperatureOverride(undefined);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedTemperatureKey, server.id]);

  useEffect(() => {
    if (!temperatureDialogOpen && !nethogsDialogOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setTemperatureDialogOpen(false);
        setNethogsDialogOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nethogsDialogOpen, temperatureDialogOpen]);

  const selectTemperatureReading = useCallback((targetServer: ServerProfile, reading: TemperatureReading) => {
    const key = temperatureReadingKey(reading);

    onPreferredTemperatureChange({ ...preferredTemperatureByServer, [targetServer.id]: key });
    setTemperatureOverride(reading);
  }, [onPreferredTemperatureChange, preferredTemperatureByServer]);

  return (
    <>
      <header className={`topbar server-topbar ${onlineState}`}>
        <div className="server-topbar-primary">
          <button type="button" className="icon-command header-back-command" title="Back to fleet overview" aria-label="Back to fleet overview" onClick={onBack}>
            <ArrowLeft size={16} />
          </button>
          <span className="server-identity-visual">
            <ServerIconBadge server={server} className="hero-server-icon" size={22} />
            <span className={`status-orb ${onlineState}`} />
          </span>
          <div className="server-topbar-title">
            <small>Active server</small>
            <h1>{server.alias}</h1>
            <p>{server.username}@{server.host}:{server.port}</p>
          </div>
        </div>
        <div className="server-topbar-metrics" aria-label="Active server quick metrics">
          <div className="server-topbar-metric-row">
            <CompactMetric
              icon={<Thermometer size={15} />}
              iconClassName="temp"
              value={formatTemperature(displayedTemperature?.celsius)}
              actionIcon={<ExternalLink size={11} />}
              title={displayedTemperature?.label ? `Show temperature sensors. Current: ${displayedTemperature.label}` : 'Show temperature sensors'}
              onClick={() => setTemperatureDialogOpen(true)}
            />
            <BatteryPill battery={metrics?.battery} className="server-topbar-battery-pill" />
          </div>
          <CompactMetric
            icon={<HardDrive size={15} />}
            iconClassName="disk"
            value={<DiskRatePair readBytesPerSecond={metrics?.diskIo?.readBytesPerSecond} writeBytesPerSecond={metrics?.diskIo?.writeBytesPerSecond} />}
            title="Disk I/O"
          />
          <CompactMetric
            icon={<Network size={15} />}
            iconClassName="network"
            value={<NetworkRatePair receiveBytesPerSecond={metrics?.network?.receiveBytesPerSecond} transmitBytesPerSecond={metrics?.network?.transmitBytesPerSecond} />}
            actionIcon={<ExternalLink size={11} />}
            title="Show nethogs network processes"
            onClick={() => setNethogsDialogOpen(true)}
          />
        </div>
        <div className="server-topbar-controls">
          {showMetricControls && (
            <div className="refresh-controls">
              <button
                className={`command refresh-command ${onlineState === 'offline' ? 'offline-retry-command' : ''}`}
                onClick={onRefreshMetrics}
                disabled={metricsRefreshing}
                title={metricRefreshTitle}
              >
                <RefreshCw size={16} aria-hidden="true" className={metricsRefreshing ? 'spin-icon' : undefined} /> {metricRefreshLabel}
              </button>
              <RefreshRateSelect value={refreshRate} onChange={onRefreshRateChange} />
            </div>
          )}
          <div className="actions server-topbar-actions">
            <button className="command" onClick={onEdit}>
              <Edit3 size={16} /> Edit
            </button>
            <button className="danger" onClick={onDelete} disabled={busy}>
              <Trash2 size={16} /> Delete
            </button>
          </div>
        </div>
      </header>
      {temperatureDialogOpen && (
        <TemperatureDialog
          state={{ server }}
          selectedKey={selectedTemperatureKey}
          onSelectReading={selectTemperatureReading}
          onClose={() => setTemperatureDialogOpen(false)}
        />
      )}
      {nethogsDialogOpen && (
        <NethogsDialog
          state={{ server }}
          onClose={() => setNethogsDialogOpen(false)}
        />
      )}
    </>
  );
}

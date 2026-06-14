import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type MutableRefObject, type RefObject } from 'react';
import { CircleHelp, ExternalLink, Keyboard, Maximize2, Minimize2, MousePointer2, Power, RefreshCw, ZoomIn, ZoomOut } from 'lucide-react';
import type RFB from '@novnc/novnc';
import type { ServerProfile, SystemdServiceAction, VncServiceCandidate, VncStatusResponse } from '../types';
import { controlSystemdService, controlVncService, getVncStatus } from '../lib/api';
import { buildWebSocketUrl } from '../lib/websocket';
import {
  connectionButtonLabel,
  connectionLabel,
  healthChipClass,
  listenerLabel,
  prioritizeVncServices,
  serviceActionPastTense,
  serviceDisplayName,
  serviceKey,
  type VncConnectionState,
} from '../lib/vnc';
import { SystemServicesHelpDialog } from './ServicesPanel';

type VncViewerMode = 'fit' | 'native-follow' | 'height-follow';
type ViewportRfb = RFB & {
  clipViewport: boolean;
  dragViewport: boolean;
  scaleViewport: boolean;
};
type ScalableRfb = ViewportRfb & {
  _display?: {
    width: number;
    height: number;
    scale: number;
  };
};

export function VncPanel({
  server,
  visible,
  popout = false,
  initialHost,
  initialPort,
  initialMagnified = true,
}: {
  server?: ServerProfile;
  visible: boolean;
  popout?: boolean;
  initialHost?: string;
  initialPort?: string;
  initialMagnified?: boolean;
}) {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const viewerShellRef = useRef<HTMLElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const popoutAutoConnectAttemptedRef = useRef(false);
  const heightFitFrameRef = useRef(0);
  const heightFitTimeoutsRef = useRef<number[]>([]);
  const [status, setStatus] = useState<VncStatusResponse | undefined>();
  const [loadedServerId, setLoadedServerId] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [host, setHost] = useState(initialHost || '127.0.0.1');
  const [port, setPort] = useState(initialPort || '5900');
  const [hostEdited, setHostEdited] = useState(Boolean(initialHost || initialPort));
  const [password, setPassword] = useState('');
  const [viewOnly, setViewOnly] = useState(true);
  const [connectionState, setConnectionState] = useState<VncConnectionState>('idle');
  const [lastDisconnectUnexpected, setLastDisconnectUnexpected] = useState(false);
  const [viewerFullscreen, setViewerFullscreen] = useState(false);
  const [viewerMagnified, setViewerMagnified] = useState(initialMagnified);
  const [selectedServiceKey, setSelectedServiceKey] = useState('');
  const [pendingServiceAction, setPendingServiceAction] = useState<SystemdServiceAction | ''>('');
  const [selectedGraphicalServiceKey, setSelectedGraphicalServiceKey] = useState('');
  const [pendingGraphicalServiceAction, setPendingGraphicalServiceAction] = useState<SystemdServiceAction | ''>('');
  const [systemServicesHelpOpen, setSystemServicesHelpOpen] = useState(false);
  const connected = connectionState === 'connected';
  const viewerMode: VncViewerMode = popout && viewerMagnified ? 'height-follow' : viewerMagnified ? 'native-follow' : 'fit';

  const disconnectVnc = useCallback(() => {
    const rfb = rfbRef.current;

    if (!rfb) {
      setConnectionState('idle');
      return;
    }

    setConnectionState('disconnecting');
    rfb.disconnect();
  }, []);

  const loadStatus = useCallback(async () => {
    if (!server) {
      return;
    }

    setLoading(true);
    setMessage('');

    try {
      const nextStatus = await getVncStatus(server.id);
      setStatus(nextStatus);
      setLoadedServerId(server.id);

      if (!hostEdited) {
        setHost(nextStatus.preferredHost);
        setPort(String(nextStatus.preferredPort));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to read VNC status.');
    } finally {
      setLoading(false);
    }
  }, [hostEdited, server]);

  useEffect(() => {
    if (visible && server && loadedServerId !== server.id) {
      void loadStatus();
    }
  }, [loadStatus, loadedServerId, server, visible]);

  useEffect(() => {
    setStatus(undefined);
    setLoadedServerId('');
    setMessage('');
    setLastDisconnectUnexpected(false);
    setHost(initialHost || '127.0.0.1');
    setPort(initialPort || '5900');
    setHostEdited(Boolean(initialHost || initialPort));
    setPassword('');
    setViewOnly(true);
    setViewerMagnified(initialMagnified);
    setSelectedServiceKey('');
    setPendingServiceAction('');
    setSelectedGraphicalServiceKey('');
    setPendingGraphicalServiceAction('');
    popoutAutoConnectAttemptedRef.current = false;
    disconnectVnc();
  }, [disconnectVnc, initialHost, initialMagnified, initialPort, server?.id]);

  useEffect(() => {
    rfbRef.current && (rfbRef.current.viewOnly = viewOnly);
  }, [viewOnly]);

  useEffect(() => {
    const vncServices = prioritizeVncServices(filterMaskedServices(status?.services ?? []));

    if (!vncServices.length) {
      if (selectedServiceKey) {
        setSelectedServiceKey('');
      }
      return;
    }

    if (vncServices.some((service) => serviceKey(service) === selectedServiceKey)) {
      return;
    }

    const activeService = vncServices.find((service) => service.activeState === 'active');
    setSelectedServiceKey(serviceKey(activeService ?? vncServices[0]));
  }, [selectedServiceKey, status]);

  useEffect(() => {
    const graphicalServices = prioritizeGraphicalServices(filterMaskedServices(status?.graphicalServices ?? []));

    if (!graphicalServices.length) {
      if (selectedGraphicalServiceKey) {
        setSelectedGraphicalServiceKey('');
      }
      return;
    }

    if (graphicalServices.some((service) => serviceKey(service) === selectedGraphicalServiceKey)) {
      return;
    }

    const activeService = graphicalServices.find((service) => service.activeState === 'active');
    setSelectedGraphicalServiceKey(serviceKey(activeService ?? graphicalServices[0]));
  }, [selectedGraphicalServiceKey, status]);

  useEffect(() => {
    if (!visible) {
      disconnectVnc();
    }
  }, [disconnectVnc, visible]);

  useEffect(() => {
    return () => {
      cancelVncHeightFitPasses(heightFitFrameRef, heightFitTimeoutsRef);
      rfbRef.current?.disconnect();
      rfbRef.current = null;
    };
  }, []);

  useEffect(() => {
    const updateFullscreenState = () => {
      setViewerFullscreen(Boolean(viewerShellRef.current && document.fullscreenElement === viewerShellRef.current));
    };

    document.addEventListener('fullscreenchange', updateFullscreenState);
    return () => document.removeEventListener('fullscreenchange', updateFullscreenState);
  }, []);

  const toggleViewerFullscreen = useCallback(async () => {
    const shell = viewerShellRef.current;

    if (!shell) {
      return;
    }

    try {
      if (document.fullscreenElement === shell) {
        await document.exitFullscreen();
      } else {
        await shell.requestFullscreen();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to toggle fullscreen.');
    }
  }, []);

  const toggleRemoteInput = useCallback(() => {
    setViewOnly((current) => {
      const next = !current;

      if (!next) {
        window.setTimeout(() => rfbRef.current?.focus(), 0);
      }

      return next;
    });
  }, []);

  useEffect(() => {
    const rfb = rfbRef.current;

    if (!rfb) {
      return;
    }

    applyVncViewerScale(rfb, viewerMode, viewerRef.current);

    if (viewerMagnified) {
      window.requestAnimationFrame(() => {
        applyVncViewerScale(rfb, viewerMode, viewerRef.current);
        centerVncScrollHost(viewerRef.current, viewerMode);
      });
    }
  }, [connected, viewerFullscreen, viewerMagnified, viewerMode]);

  useEffect(() => {
    if (!viewerMagnified || !viewerShellRef.current) {
      return;
    }

    let frame = 0;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (rfbRef.current) {
          applyVncViewerMode(rfbRef.current, viewerMode, viewerRef.current);
        }
      });
    });

    observer.observe(viewerShellRef.current);
    if (viewerRef.current) {
      observer.observe(viewerRef.current);
    }

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [viewerMagnified, viewerMode]);

  useEffect(() => {
    if (viewerMode !== 'height-follow' || !connected) {
      return;
    }

    const applyHeightFit = () => {
      if (rfbRef.current) {
        applyVncViewerMode(rfbRef.current, viewerMode, viewerRef.current);
      }
    };

    applyHeightFit();
    window.addEventListener('resize', applyHeightFit);
    scheduleVncHeightFitPasses(rfbRef, viewerRef, heightFitFrameRef, heightFitTimeoutsRef);

    return () => {
      window.removeEventListener('resize', applyHeightFit);
      cancelVncHeightFitPasses(heightFitFrameRef, heightFitTimeoutsRef);
    };
  }, [connected, viewerMode]);

  const connectVnc = useCallback(async () => {
    if (!server || !viewerRef.current || connectionState === 'connecting' || connectionState === 'connected') {
      return;
    }

    const portNumber = Number(port);

    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      setMessage('VNC port must be between 1 and 65535.');
      return;
    }

    rfbRef.current?.disconnect();
    viewerRef.current.replaceChildren();
    setMessage('');
    setLastDisconnectUnexpected(false);
    setConnectionState('connecting');

    let rfb: RFB;

    try {
      const [{ default: RfbClient }, url] = await Promise.all([
        import('@novnc/novnc'),
        buildWebSocketUrl(`/api/servers/${server.id}/vnc/socket`, {
          host: host.trim() || '127.0.0.1',
          port: portNumber,
        }),
      ]);
      rfb = new RfbClient(viewerRef.current, url, {
        credentials: password ? { password } : undefined,
      });
    } catch (error) {
      setConnectionState('idle');
      setMessage(error instanceof Error ? error.message : 'Unable to load VNC client.');
      return;
    }

    applyVncViewerScale(rfb, viewerMode, viewerRef.current);
    rfb.resizeSession = false;
    rfb.viewOnly = viewOnly;
    rfbRef.current = rfb;

    rfb.addEventListener('connect', () => {
      setConnectionState('connected');
      setMessage('VNC connected.');
      applyVncViewerMode(rfb, viewerMode, viewerRef.current);
      if (viewerMode === 'height-follow') {
        scheduleVncHeightFitPasses(rfbRef, viewerRef, heightFitFrameRef, heightFitTimeoutsRef);
      }
      rfb.focus();
    });

    rfb.addEventListener('disconnect', (event) => {
      if (rfbRef.current === rfb) {
        rfbRef.current = null;
      }

      cancelVncHeightFitPasses(heightFitFrameRef, heightFitTimeoutsRef);
      setConnectionState('idle');

      if (!event.detail.clean) {
        setLastDisconnectUnexpected(true);
        setMessage('VNC disconnected unexpectedly.');
      }
    });

    rfb.addEventListener('credentialsrequired', () => {
      if (password) {
        rfb.sendCredentials({ password });
        return;
      }

      setMessage('VNC password required.');
      rfb.disconnect();
    });

    rfb.addEventListener('securityfailure', (event) => {
      setMessage(event.detail.reason ? `VNC security failure: ${event.detail.reason}` : 'VNC security failure.');
    });
  }, [connectionState, host, password, port, server, viewOnly, viewerMode]);

  useEffect(() => {
    if (!popout || !visible || !server || connectionState !== 'idle' || popoutAutoConnectAttemptedRef.current) {
      return;
    }

    const hasExplicitTarget = Boolean(initialHost || initialPort);

    if (!hasExplicitTarget && loadedServerId !== server.id) {
      return;
    }

    if (!hasExplicitTarget) {
      const vncServices = prioritizeVncServices(status?.services ?? []);
      const activeService = vncServices.find((service) => service.activeState === 'active');
      const ready = (status?.listeners ?? []).length > 0 && (!vncServices.length || Boolean(activeService));

      if (!ready) {
        return;
      }
    }

    popoutAutoConnectAttemptedRef.current = true;
    const timeout = window.setTimeout(() => void connectVnc(), 80);
    return () => window.clearTimeout(timeout);
  }, [connectVnc, connectionState, initialHost, initialPort, loadedServerId, popout, server, status, visible]);

  const handleViewerPointerFollow = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!viewerMagnified || !connected) {
      return;
    }

    panVncScrollHostTowardPointer(viewerRef.current, event.clientX, event.clientY, viewerMode);
  }, [connected, viewerMagnified, viewerMode]);

  const handleServiceToggle = useCallback(async (service: VncServiceCandidate) => {
    if (!server || pendingServiceAction) {
      return;
    }

    const action: SystemdServiceAction = service.activeState === 'active' ? 'stop' : 'start';

    if (!confirmServiceToggle(service, action)) {
      return;
    }

    setPendingServiceAction(action);
    setMessage('');

    try {
      await controlVncService(server.id, service.name, action, service.scope);
      setMessage(`${serviceDisplayName(service)} ${serviceActionPastTense(action)}.`);
      await loadStatus();

      if (action === 'stop' && connected) {
        disconnectVnc();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Unable to ${action} ${serviceDisplayName(service)}.`);
    } finally {
      setPendingServiceAction('');
    }
  }, [connected, disconnectVnc, loadStatus, pendingServiceAction, server]);

  const handleGraphicalServiceToggle = useCallback(async (service: VncServiceCandidate) => {
    if (!server || pendingGraphicalServiceAction) {
      return;
    }

    const action: SystemdServiceAction = service.activeState === 'active' ? 'stop' : 'start';

    if (!confirmServiceToggle(service, action)) {
      return;
    }

    setPendingGraphicalServiceAction(action);
    setMessage('');

    try {
      await controlSystemdService(server.id, service.name, action, service.scope);
      setMessage(`${serviceDisplayName(service)} ${serviceActionPastTense(action)}.`);
      await loadStatus();

      if (action === 'stop' && connected) {
        disconnectVnc();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Unable to ${action} ${serviceDisplayName(service)}.`);
    } finally {
      setPendingGraphicalServiceAction('');
    }
  }, [connected, disconnectVnc, loadStatus, pendingGraphicalServiceAction, server]);

  if (!server) {
    return <div className="empty-state">No server selected.</div>;
  }

  const services = filterMaskedServices(status?.services ?? []);
  const vncServices = prioritizeVncServices(services);
  const graphicalServices = prioritizeGraphicalServices(filterMaskedServices(status?.graphicalServices ?? []));
  const listeners = status?.listeners ?? [];
  const selectedService = vncServices.find((service) => serviceKey(service) === selectedServiceKey)
    ?? vncServices.find((service) => service.activeState === 'active')
    ?? vncServices[0];
  const selectedGraphicalService = graphicalServices.find((service) => serviceKey(service) === selectedGraphicalServiceKey)
    ?? graphicalServices.find((service) => service.activeState === 'active')
    ?? graphicalServices[0];
  const selectedServiceReady = !selectedService || selectedService.activeState === 'active';
  const vncReady = listeners.length > 0 && selectedServiceReady;
  const serviceActionTitle = selectedService?.activeState === 'active' ? 'Stop service' : 'Start service';
  const graphicalServiceActionTitle = selectedGraphicalService?.activeState === 'active' ? 'Stop service' : 'Start service';
  const targetLabel = `${host || '127.0.0.1'}:${port || '5900'}`;
  const connectionActionDisabled = connectionState === 'disconnecting' || (!connected && !vncReady);
  const connectionActionReady = vncReady && connectionState === 'idle';

  const handleConnectionAction = () => {
    if (connected) {
      disconnectVnc();
      return;
    }

    void connectVnc();
  };

  const openPopout = () => {
    if (!server) {
      return;
    }

    const params = new URLSearchParams();

    if (host.trim()) {
      params.set('host', host.trim());
    }

    if (port.trim()) {
      params.set('port', port.trim());
    }

    if (viewerMagnified) {
      params.set('follow', 'height');
    }

    const query = params.toString();
    const url = `/vnc-popout/${encodeURIComponent(server.id)}${query ? `?${query}` : ''}`;
    const popoutWindow = window.open(url, `homedashboard-vnc-${server.id}`, 'popup,width=1280,height=820,resizable=yes,scrollbars=no');

    if (!popoutWindow) {
      setMessage('Unable to open pop-out. Check this browser’s pop-up settings.');
      return;
    }

    disconnectVnc();
  };

  if (popout) {
    return (
      <div className="vnc-popout-viewer-only">
        <section className={`vnc-viewer-shell vnc-viewer-popout-only ${viewerMode === 'height-follow' ? 'height-follow' : ''} ${viewerMagnified ? 'magnified' : ''}`} ref={viewerShellRef}>
          <div className="vnc-viewer-surface" onMouseMoveCapture={handleViewerPointerFollow}>
            <div className="vnc-viewer-mount" ref={viewerRef} />
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="vnc-panel">
      <div className="panel-toolbar">
        <div>
          <h3>VNC</h3>
        </div>
        <div className="refresh-controls">
          <button type="button" className="command" onClick={() => void loadStatus()} disabled={loading} title="Refresh VNC status">
            <RefreshCw size={16} className={loading ? 'spin-icon' : undefined} /> Refresh
          </button>
          <button type="button" className="icon-command" title="System services setup" aria-label="System services setup" onClick={() => setSystemServicesHelpOpen(true)}>
            <CircleHelp size={16} />
          </button>
          <button
            type="button"
            className={`vnc-connect-button ${connectionActionReady ? 'ready' : ''} ${connected ? 'connected' : ''} ${connectionState === 'disconnecting' ? 'disconnecting' : ''}`}
            disabled={connectionActionDisabled}
            onClick={handleConnectionAction}
          >
            {connectionState === 'connecting' || connectionState === 'disconnecting' ? <RefreshCw size={18} className="spin-icon" /> : <Power size={18} />}
            {connectionButtonLabel(connectionState, lastDisconnectUnexpected)}
          </button>
        </div>
      </div>

      {message && <p className="message container-message">{message}</p>}
      {systemServicesHelpOpen && (
        <SystemServicesHelpDialog onClose={() => setSystemServicesHelpOpen(false)} />
      )}

      <div className="vnc-health-row">
        {selectedService ? (
          <button
            type="button"
            className={healthChipClass(selectedService.activeState === 'active', true)}
            title={pendingServiceAction ? 'Updating service' : serviceActionTitle}
            onClick={() => void handleServiceToggle(selectedService)}
            disabled={Boolean(pendingServiceAction)}
          >
            {pendingServiceAction ? `${pendingServiceAction === 'start' ? 'Starting' : 'Stopping'}...` : `${serviceDisplayName(selectedService)} ${selectedService.activeState}`}
          </button>
        ) : (
          <span className={healthChipClass(false, false)}>No service detected</span>
        )}
        {vncServices.length > 1 && (
          <select
            className="vnc-service-select"
            value={selectedService ? serviceKey(selectedService) : ''}
            onChange={(event) => setSelectedServiceKey(event.target.value)}
            aria-label="Select VNC service"
          >
            {vncServices.map((service) => (
              <option key={serviceKey(service)} value={serviceKey(service)}>
                {serviceDisplayName(service)}
              </option>
            ))}
          </select>
        )}
        {selectedGraphicalService ? (
          <button
            type="button"
            className={healthChipClass(selectedGraphicalService.activeState === 'active', true)}
            title={pendingGraphicalServiceAction ? 'Updating service' : graphicalServiceActionTitle}
            onClick={() => void handleGraphicalServiceToggle(selectedGraphicalService)}
            disabled={Boolean(pendingGraphicalServiceAction)}
          >
            {pendingGraphicalServiceAction ? `${pendingGraphicalServiceAction === 'start' ? 'Starting' : 'Stopping'}...` : `${serviceDisplayName(selectedGraphicalService)} ${selectedGraphicalService.activeState}`}
          </button>
        ) : (
          <span className={healthChipClass(false, false)}>No graphical service detected</span>
        )}
        {graphicalServices.length > 1 && (
          <select
            className="vnc-service-select"
            value={selectedGraphicalService ? serviceKey(selectedGraphicalService) : ''}
            onChange={(event) => setSelectedGraphicalServiceKey(event.target.value)}
            aria-label="Select graphical interface service"
          >
            {graphicalServices.map((service) => (
              <option key={serviceKey(service)} value={serviceKey(service)}>
                {serviceDisplayName(service)}
              </option>
            ))}
          </select>
        )}
        <span className={healthChipClass(listeners.length > 0, true)}>{listeners.length ? `Listener ${listenerLabel(listeners[0])}` : 'No listener detected'}</span>
        <span className={healthChipClass(connected, true)}>{connectionLabel(connectionState)}</span>
      </div>

      <section className={`vnc-viewer-shell ${viewerMagnified ? 'magnified' : ''}`} ref={viewerShellRef}>
        <div className="vnc-viewer-toolbar">
          <strong>{server.alias}</strong>
          <div className="vnc-viewer-toolbar-actions">
            <span>{targetLabel}</span>
            <button
              type="button"
              className={`container-action restart ${viewerMagnified ? 'active' : ''}`}
              title={viewerMagnified ? 'Disable magnified view' : 'Magnified follow view'}
              aria-label={viewerMagnified ? 'Disable magnified view' : 'Enable magnified follow view'}
              onClick={() => setViewerMagnified((current) => !current)}
            >
              {viewerMagnified ? <ZoomOut size={14} /> : <ZoomIn size={14} />}
            </button>
            {!popout && (
              <button type="button" className="container-action restart" title="Pop out VNC" onClick={openPopout}>
                <ExternalLink size={14} />
              </button>
            )}
            <button
              type="button"
              className={`container-action restart vnc-input-toggle ${viewOnly ? '' : 'active'}`}
              title={viewOnly ? 'Enable remote input' : 'Disable remote input'}
              aria-label={viewOnly ? 'Enable remote input' : 'Disable remote input'}
              onClick={toggleRemoteInput}
              disabled={!connected}
            >
              <MousePointer2 size={14} />
              <span>{viewOnly ? 'Input off' : 'Input on'}</span>
            </button>
            <button type="button" className="container-action restart" title="Send Ctrl Alt Del" onClick={() => rfbRef.current?.sendCtrlAltDel()} disabled={!connected || viewOnly}>
              <Keyboard size={14} />
            </button>
            <button type="button" className="container-action restart" title={viewerFullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={() => void toggleViewerFullscreen()}>
              {viewerFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </div>
        </div>
        <div className="vnc-viewer-surface" onMouseMoveCapture={handleViewerPointerFollow}>
          <div className="vnc-viewer-mount" ref={viewerRef} />
          {!connected && (
            <div className="vnc-viewer-overlay">
              {connectionState === 'connecting' ? 'Connecting...' : vncReady ? 'Ready' : 'Waiting for VNC'}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function applyVncViewerScale(rfb: RFB, mode: VncViewerMode, viewer: HTMLDivElement | null): void {
  const viewportRfb = rfb as ScalableRfb;

  if (mode !== 'fit') {
    viewportRfb.dragViewport = false;
    viewportRfb.clipViewport = false;
    viewportRfb.scaleViewport = false;

    if (mode === 'height-follow') {
      applyVncHeightFitScale(viewportRfb, viewer);
    }

    return;
  }

  viewportRfb.dragViewport = false;
  viewportRfb.clipViewport = false;
  viewportRfb.scaleViewport = true;
}

function applyVncViewerMode(rfb: RFB, mode: VncViewerMode, viewer: HTMLDivElement | null): void {
  applyVncViewerScale(rfb, mode, viewer);
  centerVncScrollHost(viewer, mode);
}

function applyVncHeightFitScale(rfb: ScalableRfb, viewer: HTMLDivElement | null): void {
  const display = rfb._display;
  const surface = viewer?.closest('.vnc-viewer-surface');

  if (!display || !display.height || !(surface instanceof HTMLElement)) {
    return;
  }

  const nextScale = surface.clientHeight / display.height;

  if (Number.isFinite(nextScale) && nextScale > 0) {
    display.scale = nextScale;
  }
}

function scheduleVncHeightFitPasses(
  rfbRef: RefObject<RFB | null>,
  viewerRef: RefObject<HTMLDivElement | null>,
  frameRef: MutableRefObject<number>,
  timeoutsRef: MutableRefObject<number[]>,
): void {
  cancelVncHeightFitPasses(frameRef, timeoutsRef);

  const apply = () => {
    if (rfbRef.current) {
      applyVncViewerMode(rfbRef.current, 'height-follow', viewerRef.current);
    }
  };

  let framesRemaining = 16;
  const tick = () => {
    apply();
    framesRemaining -= 1;

    if (framesRemaining > 0) {
      frameRef.current = window.requestAnimationFrame(tick);
    }
  };

  frameRef.current = window.requestAnimationFrame(tick);
  timeoutsRef.current = [120, 300, 700, 1400].map((delay) => window.setTimeout(apply, delay));
}

function cancelVncHeightFitPasses(
  frameRef: MutableRefObject<number>,
  timeoutsRef: MutableRefObject<number[]>,
): void {
  if (frameRef.current) {
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
  }

  timeoutsRef.current.forEach((timeout) => window.clearTimeout(timeout));
  timeoutsRef.current = [];
}

function prioritizeGraphicalServices(services: VncServiceCandidate[]): VncServiceCandidate[] {
  return [...services].sort((a, b) => graphicalServicePriority(a) - graphicalServicePriority(b)
    || serviceStateRank(a) - serviceStateRank(b)
    || a.name.localeCompare(b.name)
    || a.scope.localeCompare(b.scope));
}

function filterMaskedServices(services: VncServiceCandidate[]): VncServiceCandidate[] {
  return services.filter((service) => service.unitFileState !== 'masked');
}

function graphicalServicePriority(service: VncServiceCandidate): number {
  const name = service.name.toLowerCase();

  if (name.includes('display-manager')) {
    return 0;
  }

  if (/^(sddm|gdm|gdm3|lightdm|greetd|ly|lxdm|xdm)\.service$/.test(name)) {
    return 1;
  }

  if (service.scope === 'user') {
    return 2;
  }

  return 3;
}

function serviceStateRank(service: VncServiceCandidate): number {
  if (service.activeState === 'active') {
    return 0;
  }

  if (service.activeState === 'activating' || service.activeState === 'deactivating') {
    return 1;
  }

  if (service.activeState === 'failed') {
    return 2;
  }

  return 3;
}

function confirmServiceToggle(service: VncServiceCandidate, action: SystemdServiceAction): boolean {
  const label = `${action[0].toUpperCase()}${action.slice(1)}`;
  return window.confirm(`${label} ${serviceDisplayName(service)}?`);
}

function centerVncScrollHost(viewer: HTMLDivElement | null, mode: VncViewerMode): void {
  const scrollHost = getVncScrollHost(viewer);

  if (!scrollHost) {
    return;
  }

  const top = mode === 'height-follow' ? 0 : Math.max(0, (scrollHost.scrollHeight - scrollHost.clientHeight) / 2);

  scrollHost.scrollTo({
    left: Math.max(0, (scrollHost.scrollWidth - scrollHost.clientWidth) / 2),
    top,
  });
}

function panVncScrollHostTowardPointer(viewer: HTMLDivElement | null, clientX: number, clientY: number, mode: VncViewerMode): void {
  const scrollHost = getVncScrollHost(viewer);

  if (!scrollHost) {
    return;
  }

  const maxLeft = Math.max(0, scrollHost.scrollWidth - scrollHost.clientWidth);
  const maxTop = Math.max(0, scrollHost.scrollHeight - scrollHost.clientHeight);

  if (!maxLeft && !maxTop) {
    return;
  }

  const rect = scrollHost.getBoundingClientRect();
  const xRatio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
  const yRatio = clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1);
  const nextLeft = clamp(maxLeft * xRatio, 0, maxLeft);
  const nextTop = mode === 'height-follow' ? 0 : clamp(maxTop * yRatio, 0, maxTop);

  if (nextLeft !== scrollHost.scrollLeft || nextTop !== scrollHost.scrollTop) {
    scrollHost.scrollTo({ left: nextLeft, top: nextTop });
  }
}

function getVncScrollHost(viewer: HTMLDivElement | null): HTMLElement | undefined {
  const noVncScreen = viewer?.firstElementChild;

  if (noVncScreen instanceof HTMLElement) {
    return noVncScreen;
  }

  const surface = viewer?.closest('.vnc-viewer-surface');
  return surface instanceof HTMLElement ? surface : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

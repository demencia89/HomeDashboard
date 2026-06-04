import { useCallback, useEffect, useRef, useState } from 'react';
import { Cable, XCircle } from 'lucide-react';
import type { ServerProfile } from '../types';
import { isValidTerminalDimensions } from '../lib/terminal';
import { buildWebSocketUrl } from '../lib/websocket';

type XTerm = import('@xterm/xterm').Terminal;
type FitAddon = import('@xterm/addon-fit').FitAddon;

const MIN_TERMINAL_SURFACE_HEIGHT = 360;
const TERMINAL_VIEWPORT_BOTTOM_GUTTER = 20;

export function TerminalSessions({ servers, activeServerId, visible }: { servers: ServerProfile[]; activeServerId: string; visible: boolean }) {
  const activeServer = servers.find((server) => server.id === activeServerId);

  if (!servers.length) {
    return <div className={visible ? 'view-pane' : 'view-pane hidden'}><div className="empty-state">No server selected.</div></div>;
  }

  return (
    <div className={visible ? 'view-pane terminal-stack' : 'view-pane terminal-stack hidden'}>
      {visible && !activeServer && <div className="empty-state">No server selected.</div>}
      {servers.map((server) => (
        <TerminalPanel
          key={server.id}
          server={server}
          visible={visible && server.id === activeServerId}
          autoConnect={visible && server.id === activeServerId}
        />
      ))}
    </div>
  );
}

function TerminalPanel({ server, visible, autoConnect }: { server: ServerProfile; visible: boolean; autoConnect: boolean }) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const terminal = useRef<XTerm | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const resizeObserver = useRef<ResizeObserver | null>(null);
  const [connected, setConnected] = useState(false);
  const [surfaceHeight, setSurfaceHeight] = useState(MIN_TERMINAL_SURFACE_HEIGHT);

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

  const fitTerminal = useCallback((focus = false) => {
    if (!visible || !terminal.current || !fitAddon.current) {
      return;
    }

    requestAnimationFrame(() => {
      fitAddon.current?.fit();
      sendResize();
      if (focus) {
        terminal.current?.focus();
      }
    });
  }, [sendResize, visible]);

  const syncSurfaceHeight = useCallback(() => {
    if (!visible || !terminalRef.current) {
      return;
    }

    const rect = terminalRef.current.getBoundingClientRect();
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const nextHeight = Math.max(
      MIN_TERMINAL_SURFACE_HEIGHT,
      Math.floor(viewportHeight - rect.top - TERMINAL_VIEWPORT_BOTTOM_GUTTER),
    );

    setSurfaceHeight((current) => (current === nextHeight ? current : nextHeight));
    fitTerminal();
  }, [fitTerminal, visible]);

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
        cursorBlink: true,
        convertEol: true,
        fontFamily: 'JetBrains Mono, SFMono-Regular, Consolas, monospace',
        fontSize: 13,
        theme: { background: '#101418', foreground: '#d7dde5', cursor: '#64d2ff', selectionBackground: '#2d4f67' },
      });
      const fit = new FitAddon();
      const url = await buildWebSocketUrl(`/api/servers/${server.id}/shell`);
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
      observer.observe(target);
      syncSurfaceHeight();
      fitTerminal(true);

      ws.addEventListener('open', () => {
        setConnected(true);
        syncSurfaceHeight();
        fitTerminal(true);
      });
      ws.addEventListener('message', async (event) => term.write(typeof event.data === 'string' ? event.data : await event.data.text()));
      ws.addEventListener('close', () => {
        observer.disconnect();
        if (socket.current === ws) {
          socket.current = null;
        }
        setConnected(false);
      });
      ws.addEventListener('error', () => setConnected(false));
      term.onData((data) => ws.readyState === WebSocket.OPEN && ws.send(data));
    })();
  }, [disconnect, fitTerminal, server.id, syncSurfaceHeight]);

  useEffect(() => disconnect, [disconnect]);

  useEffect(() => {
    if (!autoConnect) {
      return;
    }

    if (!terminal.current || !socket.current) {
      connect();
      return;
    }

    syncSurfaceHeight();
    fitTerminal(true);
  }, [autoConnect, connect, fitTerminal, syncSurfaceHeight]);

  useEffect(() => {
    if (!visible) {
      return;
    }

    let frame = 0;
    const scheduleSync = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(syncSurfaceHeight);
    };
    const observer = new ResizeObserver(scheduleSync);

    if (panelRef.current) {
      observer.observe(panelRef.current);
    }

    window.addEventListener('resize', scheduleSync);
    window.visualViewport?.addEventListener('resize', scheduleSync);
    scheduleSync();

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', scheduleSync);
      window.visualViewport?.removeEventListener('resize', scheduleSync);
    };
  }, [syncSurfaceHeight, visible]);

  return (
    <div className={visible ? 'terminal-panel' : 'terminal-panel hidden'} ref={panelRef} aria-hidden={!visible}>
      <div className="toolbar">
        <button className="command" onClick={connect} disabled={connected}><Cable size={16} /> Connect</button>
        <button className="danger" onClick={disconnect} disabled={!connected}><XCircle size={16} /> Disconnect</button>
        <span className={connected ? 'badge good' : 'badge neutral'}>{connected ? 'Connected' : 'Disconnected'}</span>
        <span className="terminal-server-label">{server.alias}</span>
      </div>
      <div className="terminal-surface" ref={terminalRef} style={{ height: surfaceHeight }} />
    </div>
  );
}

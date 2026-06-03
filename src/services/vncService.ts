import { execFile } from 'node:child_process';
import type { ConnectConfig } from 'ssh2';
import type { KeyStore } from '../storage/key-store.js';
import type { ServerProfileStore } from './sshConnection.js';
import { execSshCommand, normalizeSshError, resolveSshTarget, shellQuote, SSH_READY_TIMEOUT_MS, withSshClient } from './sshConnection.js';
import type { SystemdServiceAction } from './systemdService.js';
import { buildSystemdActionCommand } from './systemdService.js';

export interface VncServiceCandidate {
  name: string;
  scope: 'system' | 'user';
  loadState: string;
  activeState: string;
  subState: string;
  unitFileState: string;
  description: string;
}

export interface VncListener {
  host: string;
  port: number;
  process: string;
}

export interface VncStatusResult {
  ok: boolean;
  services: VncServiceCandidate[];
  graphicalServices: VncServiceCandidate[];
  listeners: VncListener[];
  preferredHost: string;
  preferredPort: number;
  error?: string;
}

export interface VncActionResult {
  ok: boolean;
  action: SystemdServiceAction;
  serviceName: string;
  error?: string;
}

const VNC_STATUS_TIMEOUT_MS = SSH_READY_TIMEOUT_MS * 4;
const VNC_ACTION_TIMEOUT_MS = SSH_READY_TIMEOUT_MS * 4;
const VNC_STATUS_MAX_BUFFER_BYTES = 512 * 1024;

const VNC_STATUS_COMMAND = `
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
services=""
systemctl_bin="$(command -v systemctl 2>/dev/null || true)"
service_pattern='(^|[-@_.])(vnc|x11vnc|tigervnc|wayvnc|krfb|vino|gnome-remote-desktop)([-@_.]|\\.service$)'
graphical_service_pattern='(^|[-@_.])(display-manager|gdm|gdm3|sddm|lightdm|lxdm|xdm|ly|greetd|cosmic-greeter|cosmic-session|hyprland|sway|niri|wayfire|river|labwc|cage|weston|kwin_wayland|plasma-kwin_wayland)([-@_.]|\\.service$)'
if [ -n "$systemctl_bin" ]; then
  units="$(
    {
      "$systemctl_bin" list-unit-files --type=service --no-legend --no-pager 2>/dev/null | awk '{ print $1 }'
      "$systemctl_bin" list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null | awk '{ print $1 }'
    } | grep -Ei "$service_pattern" | awk 'NF && !seen[$1]++'
  )"
  if [ -n "$units" ]; then
    printf '%s\\n' "$units" | xargs "$systemctl_bin" show --no-pager -p Id -p LoadState -p ActiveState -p SubState -p UnitFileState -p Description 2>/dev/null | awk -F= '
      function reset() { id = ""; load = ""; active = ""; substate = ""; unitfile = ""; description = "" }
      function emit() {
        if (id ~ /\\.service$/) {
          printf "SERVICE\\tsystem\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n", id, load ? load : "unknown", active ? active : "unknown", substate ? substate : "unknown", unitfile ? unitfile : "unknown", description ? description : id
        }
        reset()
      }
      BEGIN { reset() }
      /^$/ { emit(); next }
      $1 == "Id" { id = substr($0, index($0, "=") + 1); next }
      $1 == "LoadState" { load = substr($0, index($0, "=") + 1); next }
      $1 == "ActiveState" { active = substr($0, index($0, "=") + 1); next }
      $1 == "SubState" { substate = substr($0, index($0, "=") + 1); next }
      $1 == "UnitFileState" { unitfile = substr($0, index($0, "=") + 1); next }
      $1 == "Description" { description = substr($0, index($0, "=") + 1); next }
      END { emit() }
    '
  fi
  graphical_units="$(
    {
      "$systemctl_bin" list-unit-files --type=service --no-legend --no-pager 2>/dev/null | awk '{ print $1 }'
      "$systemctl_bin" list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null | awk '{ print $1 }'
    } | grep -Ei "$graphical_service_pattern" | grep -Evi "$service_pattern" | awk 'NF && !seen[$1]++'
  )"
  if [ -n "$graphical_units" ]; then
    printf '%s\\n' "$graphical_units" | xargs "$systemctl_bin" show --no-pager -p Id -p LoadState -p ActiveState -p SubState -p UnitFileState -p Description 2>/dev/null | awk -F= '
      function reset() { id = ""; load = ""; active = ""; substate = ""; unitfile = ""; description = "" }
      function emit() {
        if (id ~ /\\.service$/) {
          printf "GRAPHICAL_SERVICE\\tsystem\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n", id, load ? load : "unknown", active ? active : "unknown", substate ? substate : "unknown", unitfile ? unitfile : "unknown", description ? description : id
        }
        reset()
      }
      BEGIN { reset() }
      /^$/ { emit(); next }
      $1 == "Id" { id = substr($0, index($0, "=") + 1); next }
      $1 == "LoadState" { load = substr($0, index($0, "=") + 1); next }
      $1 == "ActiveState" { active = substr($0, index($0, "=") + 1); next }
      $1 == "SubState" { substate = substr($0, index($0, "=") + 1); next }
      $1 == "UnitFileState" { unitfile = substr($0, index($0, "=") + 1); next }
      $1 == "Description" { description = substr($0, index($0, "=") + 1); next }
      END { emit() }
    '
  fi
fi

if [ -S "/run/user/$(id -u)/bus" ] && [ -n "$systemctl_bin" ]; then
  export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="\${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
  user_units="$(
    {
      "$systemctl_bin" --user list-unit-files --type=service --no-legend --no-pager 2>/dev/null | awk '{ print $1 }'
      "$systemctl_bin" --user list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null | awk '{ print $1 }'
    } | grep -Ei "$service_pattern" | awk 'NF && !seen[$1]++'
  )"
  if [ -n "$user_units" ]; then
    printf '%s\\n' "$user_units" | xargs "$systemctl_bin" --user show --no-pager -p Id -p LoadState -p ActiveState -p SubState -p UnitFileState -p Description 2>/dev/null | awk -F= '
      function reset() { id = ""; load = ""; active = ""; substate = ""; unitfile = ""; description = "" }
      function emit() {
        if (id ~ /\\.service$/) {
          printf "SERVICE\\tuser\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n", id, load ? load : "unknown", active ? active : "unknown", substate ? substate : "unknown", unitfile ? unitfile : "unknown", description ? description : id
        }
        reset()
      }
      BEGIN { reset() }
      /^$/ { emit(); next }
      $1 == "Id" { id = substr($0, index($0, "=") + 1); next }
      $1 == "LoadState" { load = substr($0, index($0, "=") + 1); next }
      $1 == "ActiveState" { active = substr($0, index($0, "=") + 1); next }
      $1 == "SubState" { substate = substr($0, index($0, "=") + 1); next }
      $1 == "UnitFileState" { unitfile = substr($0, index($0, "=") + 1); next }
      $1 == "Description" { description = substr($0, index($0, "=") + 1); next }
      END { emit() }
    '
  fi
  user_graphical_units="$(
    {
      "$systemctl_bin" --user list-unit-files --type=service --no-legend --no-pager 2>/dev/null | awk '{ print $1 }'
      "$systemctl_bin" --user list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null | awk '{ print $1 }'
    } | grep -Ei "$graphical_service_pattern" | grep -Evi "$service_pattern" | awk 'NF && !seen[$1]++'
  )"
  if [ -n "$user_graphical_units" ]; then
    printf '%s\\n' "$user_graphical_units" | xargs "$systemctl_bin" --user show --no-pager -p Id -p LoadState -p ActiveState -p SubState -p UnitFileState -p Description 2>/dev/null | awk -F= '
      function reset() { id = ""; load = ""; active = ""; substate = ""; unitfile = ""; description = "" }
      function emit() {
        if (id ~ /\\.service$/) {
          printf "GRAPHICAL_SERVICE\\tuser\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n", id, load ? load : "unknown", active ? active : "unknown", substate ? substate : "unknown", unitfile ? unitfile : "unknown", description ? description : id
        }
        reset()
      }
      BEGIN { reset() }
      /^$/ { emit(); next }
      $1 == "Id" { id = substr($0, index($0, "=") + 1); next }
      $1 == "LoadState" { load = substr($0, index($0, "=") + 1); next }
      $1 == "ActiveState" { active = substr($0, index($0, "=") + 1); next }
      $1 == "SubState" { substate = substr($0, index($0, "=") + 1); next }
      $1 == "UnitFileState" { unitfile = substr($0, index($0, "=") + 1); next }
      $1 == "Description" { description = substr($0, index($0, "=") + 1); next }
      END { emit() }
    '
  fi
fi

if command -v ss >/dev/null 2>&1; then
  ss -ltnp 2>/dev/null | awk '
    /:59[0-9][0-9][[:space:]]/ {
      local = $4
      process = $0
      sub(/^.*users:\\(\\("/, "", process)
      sub(/".*$/, "", process)
      if (process == $0) process = ""
      port = local
      sub(/^.*:/, "", port)
      host = local
      sub(/:[0-9]+$/, "", host)
      gsub(/^\\[|\\]$/, "", host)
      if (host == "*" || host == "0.0.0.0" || host == "::") host = "127.0.0.1"
      printf "LISTENER\\t%s\\t%s\\t%s\\n", host, port, process
    }
  '
elif command -v netstat >/dev/null 2>&1; then
  netstat -ltnp 2>/dev/null | awk '
    /:59[0-9][0-9][[:space:]]/ {
      local = $4
      process = $7
      sub(/^.*\\//, "", process)
      port = local
      sub(/^.*:/, "", port)
      host = local
      sub(/:[0-9]+$/, "", host)
      if (host == "*" || host == "0.0.0.0" || host == "::") host = "127.0.0.1"
      printf "LISTENER\\t%s\\t%s\\t%s\\n", host, port, process
    }
  '
fi
`.trim();

export async function getVncStatus(
  store: ServerProfileStore,
  keyStore: KeyStore,
  serverId: string,
): Promise<VncStatusResult> {
  try {
    const target = await resolveSshTarget(store, keyStore, serverId);
    const raw = target.isLocal
      ? await getLocalVncStatus()
      : await getRemoteVncStatus(target.connectConfig);
    const parsed = parseVncStatus(raw);

    return {
      ok: true,
      ...parsed,
    };
  } catch (error) {
    return {
      ok: false,
      services: [],
      graphicalServices: [],
      listeners: [],
      preferredHost: '127.0.0.1',
      preferredPort: 5900,
      error: error instanceof Error ? normalizeSshError(error.message) : 'Unable to read VNC status.',
    };
  }
}

export async function controlVncService(
  store: ServerProfileStore,
  keyStore: KeyStore,
  serverId: string,
  serviceName: string,
  action: SystemdServiceAction,
  scope: 'system' | 'user' = 'system',
): Promise<VncActionResult> {
  if (!isVncServiceName(serviceName)) {
    throw new Error('serviceName must be a valid VNC service unit name.');
  }

  try {
    const target = await resolveSshTarget(store, keyStore, serverId);
    const command = scope === 'user' ? buildUserSystemdActionCommand(serviceName, action) : buildSystemdActionCommand(serviceName, action);

    if (target.isLocal) {
      await controlLocalVncService(command);
    } else {
      await withSshClient(target.connectConfig, async (client) => {
        await execSshCommand(client, `/bin/sh -lc ${shellQuote(command)}`, {
          timeoutMs: VNC_ACTION_TIMEOUT_MS,
          label: `VNC ${action}`,
        });
      });
    }

    return { ok: true, action, serviceName };
  } catch (error) {
    return {
      ok: false,
      action,
      serviceName,
      error: error instanceof Error ? normalizeSshError(error.message) : 'Unable to control VNC service.',
    };
  }
}

export function parseVncStatus(raw: string): Pick<VncStatusResult, 'services' | 'graphicalServices' | 'listeners' | 'preferredHost' | 'preferredPort'> {
  const services: VncServiceCandidate[] = [];
  const graphicalServices: VncServiceCandidate[] = [];
  const listeners: VncListener[] = [];

  for (const line of raw.split('\n')) {
    const parts = line.split('\t');

    if (parts[0] === 'SERVICE') {
      const hasScope = parts[1] === 'system' || parts[1] === 'user';
      const scope: 'system' | 'user' = parts[1] === 'user' ? 'user' : 'system';
      const offset = hasScope ? 2 : 1;
      const [name, loadState, activeState, subState, unitFileState, description = name] = parts.slice(offset);

      if (isVncServiceName(name)) {
        services.push({
          name,
          scope,
          loadState: loadState || 'unknown',
          activeState: activeState || 'unknown',
          subState: subState || 'unknown',
          unitFileState: unitFileState || 'unknown',
          description: description || name,
        });
      }
    }

    if (parts[0] === 'GRAPHICAL_SERVICE') {
      const hasScope = parts[1] === 'system' || parts[1] === 'user';
      const scope: 'system' | 'user' = parts[1] === 'user' ? 'user' : 'system';
      const offset = hasScope ? 2 : 1;
      const [name, loadState, activeState, subState, unitFileState, description = name] = parts.slice(offset);

      if (isVncServiceName(name)) {
        graphicalServices.push({
          name,
          scope,
          loadState: loadState || 'unknown',
          activeState: activeState || 'unknown',
          subState: subState || 'unknown',
          unitFileState: unitFileState || 'unknown',
          description: description || name,
        });
      }
    }

    if (parts[0] === 'LISTENER') {
      const [, host, portValue, process = ''] = parts;
      const port = Number(portValue);

      if (Number.isInteger(port) && port >= 5900 && port <= 5999) {
        listeners.push({
          host: host || '127.0.0.1',
          port,
          process,
        });
      }
    }
  }

  services.sort((a, b) => serviceSortRank(a) - serviceSortRank(b) || a.name.localeCompare(b.name));
  graphicalServices.sort((a, b) => serviceSortRank(a) - serviceSortRank(b) || a.name.localeCompare(b.name));
  listeners.sort((a, b) => a.port - b.port || a.host.localeCompare(b.host));

  const preferredListener = listeners[0];

  return {
    services,
    graphicalServices,
    listeners,
    preferredHost: preferredListener?.host || '127.0.0.1',
    preferredPort: preferredListener?.port || 5900,
  };
}

function getRemoteVncStatus(connectConfig: ConnectConfig): Promise<string> {
  return withSshClient(connectConfig, async (client) => {
    const result = await execSshCommand(client, `/bin/sh -lc ${shellQuote(VNC_STATUS_COMMAND)}`, {
      timeoutMs: VNC_STATUS_TIMEOUT_MS,
      label: 'VNC status',
    });

    return result.stdout;
  });
}

function getLocalVncStatus(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/sh',
      ['-lc', VNC_STATUS_COMMAND],
      { timeout: VNC_STATUS_TIMEOUT_MS, maxBuffer: VNC_STATUS_MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || stdout || error.message));
          return;
        }

        resolve(stdout);
      },
    );
  });
}

function controlLocalVncService(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/bin/sh', ['-lc', command], { timeout: VNC_ACTION_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }

      resolve();
    });
  });
}

function buildUserSystemdActionCommand(serviceName: string, action: SystemdServiceAction): string {
  if (!isVncServiceName(serviceName) || !serviceName.endsWith('.service')) {
    throw new Error('serviceName must be a valid user service unit name.');
  }

  const quotedServiceName = shellQuote(serviceName);

  return [
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    'export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"',
    `systemctl --user ${action} ${quotedServiceName}`,
  ].join('; ');
}

function serviceSortRank(service: VncServiceCandidate): number {
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

function isVncServiceName(serviceName: string | undefined): serviceName is string {
  return Boolean(
    serviceName
      && !serviceName.toLowerCase().startsWith('rpi-connect')
      && /^[A-Za-z0-9_.@:+-]+(?:\.service)?$/.test(serviceName),
  );
}

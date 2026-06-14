import { execFile } from 'node:child_process';
import type { ConnectConfig } from 'ssh2';
import type { KeyStore } from '../storage/key-store.js';
import type { ServerProfileStore } from './sshConnection.js';
import { execSshCommand, normalizeSshError, resolveSshTarget, shellQuote, SSH_READY_TIMEOUT_MS, withSshClient } from './sshConnection.js';

export interface VncSetupInfo {
  ok: boolean;
  supported: boolean;
  backend: VncSetupBackend;
  packageManager: VncPackageManager;
  serviceName: string;
  sessionType: string;
  desktop: string;
  commands: VncSetupCommands;
  notes: string[];
  error?: string;
}

export interface VncSetupCommands {
  install: string;
  service: string;
  full: string;
}

export interface VncInstallResult {
  ok: boolean;
  output: string;
  error?: string;
}

type VncPackageManager = 'apt' | 'dnf' | 'yum' | 'pacman' | 'apk' | 'unsupported';
type VncSetupBackend = 'wayvnc' | 'x11vnc';

interface VncSetupDetection {
  packageManager: VncPackageManager;
  hasSystemd: boolean;
  sessionType: string;
  desktop: string;
  hasWaylandSocket: boolean;
  compositor: string;
}

const VNC_SETUP_TIMEOUT_MS = SSH_READY_TIMEOUT_MS * 60;
const VNC_SETUP_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const X11VNC_SERVICE_NAME = 'x11vnc.service';
const WAYVNC_SERVICE_NAME = 'wayvnc.service';
const VNC_SETUP_DETECTION_COMMAND = `
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
pm="unsupported"
if command -v apt-get >/dev/null 2>&1; then
  pm="apt"
elif command -v dnf >/dev/null 2>&1; then
  pm="dnf"
elif command -v yum >/dev/null 2>&1; then
  pm="yum"
elif command -v pacman >/dev/null 2>&1; then
  pm="pacman"
elif command -v apk >/dev/null 2>&1; then
  pm="apk"
fi
if command -v systemctl >/dev/null 2>&1; then
  systemd="yes"
else
  systemd="no"
fi
session_type="\${XDG_SESSION_TYPE:-}"
desktop="\${XDG_CURRENT_DESKTOP:-}"
if command -v loginctl >/dev/null 2>&1; then
  current_user="$(id -un)"
  session_id="$(loginctl list-sessions --no-legend 2>/dev/null | awk -v user="$current_user" '$3 == user { print $1; exit }')"
  if [ -n "$session_id" ]; then
    session_type="\${session_type:-$(loginctl show-session "$session_id" -p Type --value 2>/dev/null || true)}"
    desktop="\${desktop:-$(loginctl show-session "$session_id" -p Desktop --value 2>/dev/null || true)}"
  fi
fi
wayland_socket="no"
for socket in "/run/user/$(id -u)"/wayland-*; do
  if [ -S "$socket" ]; then
    wayland_socket="yes"
    break
  fi
done
compositor=""
for candidate in Hyprland sway river wayfire labwc niri; do
  if pgrep -xu "$(id -u)" "$candidate" >/dev/null 2>&1; then
    compositor="$candidate"
    break
  fi
done
if [ -z "$compositor" ] && pgrep -xu "$(id -u)" gnome-shell >/dev/null 2>&1; then
  compositor="gnome-shell"
fi
if [ -z "$compositor" ] && pgrep -xu "$(id -u)" kwin_wayland >/dev/null 2>&1; then
  compositor="kwin_wayland"
fi
printf 'PM\\t%s\\nSYSTEMD\\t%s\\nSESSION\\t%s\\nDESKTOP\\t%s\\nWAYLAND_SOCKET\\t%s\\nCOMPOSITOR\\t%s\\n' "$pm" "$systemd" "$session_type" "$desktop" "$wayland_socket" "$compositor"
`.trim();

const X11VNC_SYSTEMD_UNIT = `[Unit]
Description=x11vnc loopback desktop sharing
After=graphical.target display-manager.service
Wants=graphical.target

[Service]
Type=simple
ExecStart=/usr/bin/x11vnc -display :0 -auth guess -localhost -forever -shared -rfbport 5900 -noxdamage -repeat
Restart=on-failure
RestartSec=2

[Install]
WantedBy=graphical.target
`;

const WAYVNC_USER_UNIT = `[Unit]
Description=wayvnc loopback desktop sharing
After=graphical-session.target
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart=%h/.local/bin/homedashboard-wayvnc
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;

const WAYVNC_LAUNCHER = `#!/bin/sh
set -e
export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
reported_wait="no"
while [ -z "\${WAYLAND_DISPLAY:-}" ]; do
  for socket in "$XDG_RUNTIME_DIR"/wayland-*; do
    [ -S "$socket" ] || continue
    export WAYLAND_DISPLAY="\${socket##*/}"
    break
  done

  if [ -n "\${WAYLAND_DISPLAY:-}" ]; then
    break
  fi

  if [ "$reported_wait" = "no" ]; then
    printf '%s\\n' 'Waiting for a Wayland desktop socket. Log in to the Wayland desktop first.' >&2
    reported_wait="yes"
  fi

  sleep 2
done
exec /usr/bin/wayvnc -r -R 127.0.0.1 5900
`;

export async function getVncSetupInfo(
  store: ServerProfileStore,
  keyStore: KeyStore,
  serverId: string,
): Promise<VncSetupInfo> {
  try {
    const target = await resolveSshTarget(store, keyStore, serverId);
    const raw = target.isLocal
      ? await detectLocalVncSetup()
      : await detectRemoteVncSetup(target.connectConfig);
    return buildVncSetupInfo(parseVncSetupDetection(raw));
  } catch (error) {
    return {
      ok: false,
      supported: false,
      backend: 'x11vnc',
      packageManager: 'unsupported',
      serviceName: X11VNC_SERVICE_NAME,
      sessionType: '',
      desktop: '',
      commands: buildVncSetupCommands('unsupported', 'x11vnc'),
      notes: ['Unable to detect package manager and systemd support.'],
      error: error instanceof Error ? normalizeSshError(error.message) : 'Unable to read VNC setup options.',
    };
  }
}

export async function installVnc(
  store: ServerProfileStore,
  keyStore: KeyStore,
  serverId: string,
): Promise<VncInstallResult> {
  try {
    const target = await resolveSshTarget(store, keyStore, serverId);
    const raw = target.isLocal
      ? await detectLocalVncSetup()
      : await detectRemoteVncSetup(target.connectConfig);
    const info = buildVncSetupInfo(parseVncSetupDetection(raw));

    if (!info.supported) {
      return {
        ok: false,
        output: '',
        error: unsupportedInstallMessage(info.packageManager),
      };
    }

    const output = target.isLocal
      ? await installLocalVnc(info.commands.full)
      : await installRemoteVnc(target.connectConfig, info.commands.full);

    return {
      ok: true,
      output,
    };
  } catch (error) {
    return {
      ok: false,
      output: '',
      error: error instanceof Error ? normalizeSshError(error.message) : 'Unable to install VNC.',
    };
  }
}

export function buildVncSetupInfo(detection: VncSetupDetection): VncSetupInfo {
  const backend = chooseVncBackend(detection);
  const commands = buildVncSetupCommands(detection.packageManager, backend);
  const notes = backend === 'wayvnc'
    ? [
      'Installs wayvnc and binds it to 127.0.0.1:5900 for the dashboard SSH tunnel.',
      'Designed for wlroots Wayland compositors such as Hyprland, Sway, river, wayfire, labwc, and niri.',
      'wayvnc must run as the desktop user. The setup installs a user systemd service and a launcher that finds the active Wayland socket.',
      'The install button uses sudo -n for package installation, so it requires passwordless sudo. If that fails, copy the commands and run them in a terminal.',
    ]
    : [
      'Installs x11vnc and binds it to 127.0.0.1:5900 for the dashboard SSH tunnel.',
      'Works with an existing X11 desktop session on display :0; native Wayland sessions should use wayvnc or the desktop environment remote-desktop service instead.',
      'The install button uses sudo -n, so it requires passwordless sudo. If that fails, copy the commands and run them in a terminal.',
    ];

  if (!detection.hasSystemd) {
    notes.push('systemd was not detected, so automatic service installation is not supported.');
  }

  if (detection.packageManager === 'unsupported') {
    notes.push('No supported package manager was detected.');
  }

  if (detection.packageManager === 'apk') {
    notes.push('Alpine/apk package installation can be shown, but this setup does not install an OpenRC service.');
  }

  if (backend === 'wayvnc' && isKnownNonWlrootsWayland(detection.compositor, detection.desktop)) {
    notes.push('This looks like GNOME or KDE Wayland, where wayvnc usually cannot capture the desktop. Use the desktop environment remote-desktop service instead.');
  } else if (backend === 'wayvnc' && !isWlrootsCompositor(detection.compositor, detection.desktop)) {
    notes.push('Wayland was detected, but the compositor is not confirmed as wlroots. GNOME and KDE Wayland usually need their own remote-desktop services instead of wayvnc.');
  }

  const supported = detection.hasSystemd
    && detection.packageManager !== 'unsupported'
    && detection.packageManager !== 'apk'
    && !(backend === 'wayvnc' && isKnownNonWlrootsWayland(detection.compositor, detection.desktop));

  return {
    ok: true,
    supported,
    backend,
    packageManager: detection.packageManager,
    serviceName: backend === 'wayvnc' ? WAYVNC_SERVICE_NAME : X11VNC_SERVICE_NAME,
    sessionType: detection.sessionType,
    desktop: detection.desktop || detection.compositor,
    commands,
    notes,
  };
}

export function buildVncSetupCommands(packageManager: VncPackageManager, backend: VncSetupBackend = 'x11vnc'): VncSetupCommands {
  const install = packageInstallCommand(packageManager, backend);
  const service = backend === 'wayvnc' ? buildWayvncServiceCommand() : buildX11VncServiceCommand();

  return {
    install,
    service,
    full: [
      'set -e',
      install,
      service,
    ].join('\n'),
  };
}

function parseVncSetupDetection(raw: string): VncSetupDetection {
  let packageManager: VncPackageManager = 'unsupported';
  let hasSystemd = false;
  let sessionType = '';
  let desktop = '';
  let hasWaylandSocket = false;
  let compositor = '';

  for (const line of raw.split('\n')) {
    const [key, value] = line.split('\t');

    if (key === 'PM' && isVncPackageManager(value)) {
      packageManager = value;
    }

    if (key === 'SYSTEMD') {
      hasSystemd = value === 'yes';
    }

    if (key === 'SESSION') {
      sessionType = value ?? '';
    }

    if (key === 'DESKTOP') {
      desktop = value ?? '';
    }

    if (key === 'WAYLAND_SOCKET') {
      hasWaylandSocket = value === 'yes';
    }

    if (key === 'COMPOSITOR') {
      compositor = value ?? '';
    }
  }

  return {
    packageManager,
    hasSystemd,
    sessionType,
    desktop,
    hasWaylandSocket,
    compositor,
  };
}

function packageInstallCommand(packageManager: VncPackageManager, backend: VncSetupBackend): string {
  const packageName = backend === 'wayvnc' ? 'wayvnc' : 'x11vnc';
  const binaryName = packageName;
  const alreadyInstalledCheck = `if command -v ${binaryName} >/dev/null 2>&1; then\n  printf '%s\\n' '${binaryName} already installed.'\nelse`;
  const endInstallCheck = 'fi';
  let installCommand: string;

  switch (packageManager) {
    case 'apt':
      installCommand = `  export DEBIAN_FRONTEND=noninteractive\n  sudo -n apt-get update\n  sudo -n apt-get install -y ${packageName}`;
      break;
    case 'dnf':
      installCommand = `  sudo -n dnf install -y ${packageName}`;
      break;
    case 'yum':
      installCommand = `  sudo -n yum install -y ${packageName}`;
      break;
    case 'pacman':
      installCommand = `  sudo -n pacman -Sy --noconfirm ${packageName}`;
      break;
    case 'apk':
      installCommand = `  sudo -n apk add ${packageName}`;
      break;
    case 'unsupported':
      return `# Install ${packageName} with this server package manager, then install the service below.`;
  }

  return [alreadyInstalledCheck, installCommand, endInstallCheck].join('\n');
}

function unsupportedInstallMessage(packageManager: VncPackageManager): string {
  if (packageManager === 'apk') {
    return 'apk was detected, but automatic service setup is only implemented for systemd servers.';
  }

  return 'Automatic VNC install is not supported on this server. Copy the commands and adapt them manually.';
}

function chooseVncBackend(detection: VncSetupDetection): VncSetupBackend {
  const normalizedSession = detection.sessionType.toLowerCase();
  const normalizedDesktop = detection.desktop.toLowerCase();
  const normalizedCompositor = detection.compositor.toLowerCase();

  if (
    detection.hasWaylandSocket ||
    normalizedSession === 'wayland' ||
    normalizedDesktop.includes('hyprland') ||
    normalizedDesktop.includes('sway') ||
    normalizedCompositor === 'hyprland' ||
    normalizedCompositor === 'sway'
  ) {
    return 'wayvnc';
  }

  return 'x11vnc';
}

function isWlrootsCompositor(compositor: string, desktop: string): boolean {
  const normalized = `${compositor} ${desktop}`.toLowerCase();
  return ['hyprland', 'sway', 'river', 'wayfire', 'labwc', 'niri'].some((name) => normalized.includes(name));
}

function isKnownNonWlrootsWayland(compositor: string, desktop: string): boolean {
  const normalized = `${compositor} ${desktop}`.toLowerCase();
  return normalized.includes('gnome-shell') || normalized.includes('gnome') || normalized.includes('kwin_wayland') || normalized.includes('kde');
}

function buildX11VncServiceCommand(): string {
  return [
    `cat <<'UNIT' | sudo -n tee /etc/systemd/system/${X11VNC_SERVICE_NAME} >/dev/null`,
    X11VNC_SYSTEMD_UNIT.trimEnd(),
    'UNIT',
    'sudo -n systemctl daemon-reload',
    `sudo -n systemctl enable --now ${X11VNC_SERVICE_NAME}`,
    `systemctl --no-pager --full status ${X11VNC_SERVICE_NAME} || true`,
  ].join('\n');
}

function buildWayvncServiceCommand(): string {
  return [
    'mkdir -p "$HOME/.local/bin" "$HOME/.config/systemd/user"',
    "cat <<'SCRIPT' > \"$HOME/.local/bin/homedashboard-wayvnc\"",
    WAYVNC_LAUNCHER.trimEnd(),
    'SCRIPT',
    'chmod 700 "$HOME/.local/bin/homedashboard-wayvnc"',
    `cat <<'UNIT' > "$HOME/.config/systemd/user/${WAYVNC_SERVICE_NAME}"`,
    WAYVNC_USER_UNIT.trimEnd(),
    'UNIT',
    'sudo -n loginctl enable-linger "$(id -un)" 2>/dev/null || true',
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    'export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"',
    'systemctl --user daemon-reload',
    `systemctl --user enable --now ${WAYVNC_SERVICE_NAME}`,
    `systemctl --user --no-pager --full status ${WAYVNC_SERVICE_NAME} || true`,
  ].join('\n');
}

function detectRemoteVncSetup(connectConfig: ConnectConfig): Promise<string> {
  return withSshClient(connectConfig, async (client) => {
    const result = await execSshCommand(client, `/bin/sh -lc ${shellQuote(VNC_SETUP_DETECTION_COMMAND)}`, {
      timeoutMs: VNC_SETUP_TIMEOUT_MS,
      label: 'VNC setup detection',
    });

    return result.stdout;
  });
}

function detectLocalVncSetup(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/sh',
      ['-lc', VNC_SETUP_DETECTION_COMMAND],
      { timeout: VNC_SETUP_TIMEOUT_MS, maxBuffer: VNC_SETUP_MAX_BUFFER_BYTES },
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

function installRemoteVnc(connectConfig: ConnectConfig, command: string): Promise<string> {
  return withSshClient(connectConfig, async (client) => {
    const result = await execSshCommand(client, `/bin/sh -lc ${shellQuote(command)}`, {
      timeoutMs: VNC_SETUP_TIMEOUT_MS,
      label: 'VNC install',
    });

    return [result.stdout, result.stderr].filter(Boolean).join('\n');
  });
}

function installLocalVnc(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/sh',
      ['-lc', command],
      { timeout: VNC_SETUP_TIMEOUT_MS, maxBuffer: VNC_SETUP_MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || stdout || error.message));
          return;
        }

        resolve([stdout, stderr].filter(Boolean).join('\n'));
      },
    );
  });
}

function isVncPackageManager(value: string | undefined): value is VncPackageManager {
  return value === 'apt' || value === 'dnf' || value === 'yum' || value === 'pacman' || value === 'apk' || value === 'unsupported';
}

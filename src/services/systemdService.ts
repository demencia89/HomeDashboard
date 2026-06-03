import { execFile } from 'node:child_process';
import type { ConnectConfig } from 'ssh2';
import type { KeyStore } from '../storage/key-store.js';
import type { ServerProfileStore } from './sshConnection.js';
import { execSshCommand, normalizeSshError, resolveSshTarget, shellQuote, SSH_READY_TIMEOUT_MS, withSshClient } from './sshConnection.js';

export type SystemdServiceAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable';
export type SystemdServiceScope = 'system' | 'user';

export interface SystemdServiceUnit {
  name: string;
  scope: SystemdServiceScope;
  loadState: string;
  activeState: string;
  subState: string;
  unitFileState: string;
  description: string;
}

export interface SystemdServicesResult {
  ok: boolean;
  services: SystemdServiceUnit[];
  error?: string;
}

export interface SystemdServiceActionResult {
  ok: boolean;
  action: SystemdServiceAction;
  serviceName: string;
  scope: SystemdServiceScope;
  error?: string;
}

const SYSTEMD_ACTION_TIMEOUT_MS = SSH_READY_TIMEOUT_MS * 4;
const SYSTEMD_LIST_TIMEOUT_MS = SSH_READY_TIMEOUT_MS * 4;
const SYSTEMD_LIST_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const SYSTEMD_LIST_CACHE_MS = 30_000;
const UNIT_FILES_MARKER = '---UNIT-FILES---';
const PASSWORDLESS_SUDO_REQUIRED_MESSAGE = 'Passwordless sudo is required to control system systemd services.';
const systemdServiceListCache = new Map<string, { expiresAt: number; result: SystemdServicesResult }>();
const systemdServiceListInFlight = new Map<string, Promise<SystemdServicesResult>>();

const SYSTEMD_SERVICES_COMMAND = `
systemctl_bin="$(command -v systemctl 2>/dev/null || true)"
if [ -z "$systemctl_bin" ]; then
  for candidate in /usr/bin/systemctl /bin/systemctl /usr/sbin/systemctl /sbin/systemctl; do
    if [ -x "$candidate" ]; then
      systemctl_bin="$candidate"
      break
    fi
  done
fi
if [ -n "$systemctl_bin" ]; then
  units="$(
    {
      "$systemctl_bin" list-unit-files --type=service --no-legend --no-pager 2>/dev/null | awk '{ print $1 }'
      "$systemctl_bin" list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null | awk '{ print $1 }'
    } | awk 'NF && $1 !~ /@\\.service$/ && !seen[$1]++'
  )"
  if [ -n "$units" ]; then
    printf '%s\\n' "$units" | xargs "$systemctl_bin" show --no-pager -p Id -p LoadState -p ActiveState -p SubState -p Description 2>/dev/null | awk -F= '
      function reset() {
        id = ""; load = ""; active = ""; substate = ""; description = ""
      }
      function emit() {
        if (id ~ /\\.service$/) {
          printf "%s\\t%s\\t%s\\t%s\\t%s\\n", id, load ? load : "unknown", active ? active : "unknown", substate ? substate : "unknown", description ? description : id
        }
        reset()
      }
      BEGIN { reset() }
      /^$/ { emit(); next }
      $1 == "Id" { id = substr($0, index($0, "=") + 1); next }
      $1 == "LoadState" { load = substr($0, index($0, "=") + 1); next }
      $1 == "ActiveState" { active = substr($0, index($0, "=") + 1); next }
      $1 == "SubState" { substate = substr($0, index($0, "=") + 1); next }
      $1 == "Description" { description = substr($0, index($0, "=") + 1); next }
      END { emit() }
    '
  fi
  printf '%s\\n' '${UNIT_FILES_MARKER}'
  "$systemctl_bin" list-unit-files --type=service --no-legend --no-pager 2>/dev/null | awk '{
    printf "%s\\t%s\\n", $1, $2
  }'
else
  init_script_state() {
    script="$1"
    name="$2"

    for pidfile in $(grep -Eo '(/var/run|/run)/[A-Za-z0-9_./-]+\\.pid' "$script" 2>/dev/null | sort -u); do
      [ -r "$pidfile" ] || continue
      pid="$(cat "$pidfile" 2>/dev/null | awk 'NR == 1 { print $1 }')"
      case "$pid" in
        ''|*[!0-9]*) ;;
        *) kill -0 "$pid" 2>/dev/null && return 0 ;;
      esac
    done

    for candidate in $(
      {
        grep -Eo 'start-stop-daemon[^\n]*(--exec|-x)[[:space:]]+[A-Za-z0-9_./-]+' "$script" 2>/dev/null | awk '{ print $NF }'
        grep -Eo 'start-stop-daemon[^\n]*-n[[:space:]]+[A-Za-z0-9_.-]+' "$script" 2>/dev/null | awk '{ print $NF }'
        grep -Eo 'pidof[[:space:]]+[A-Za-z0-9_.-]+' "$script" 2>/dev/null | awk '{ print $2 }'
        grep -Eo 'killall[[:space:]]+(-[0-9]+[[:space:]]+)?[A-Za-z0-9_.-]+' "$script" 2>/dev/null | awk '{ print $NF }'
        printf '%s\\n' "$name" | sed -E 's/^S[0-9]+//; s/\\.sh$//'
      } | sed -E 's#.*/##' | awk 'NF && !seen[$1]++'
    ); do
      pidof "$candidate" >/dev/null 2>&1 && return 0
    done

    return 1
  }

  init_script_startup_state() {
    script="$1"
    name="$2"
    dir="\${script%/*}"

    case "$dir:$name" in
      /etc/init.d:S[0-9][0-9]*)
        printf '%s\\n' 'enabled'
        return
        ;;
      /etc/init.d:K[0-9][0-9]*)
        printf '%s\\n' 'disabled'
        return
        ;;
      /etc/init.d:*)
        printf '%s\\n' 'manual'
        return
        ;;
    esac

    if [ "$dir" = '/userdata/system/services' ] || [ "$dir" = '/usr/share/batocera/services' ]; then
      if command -v batocera-settings-get >/dev/null 2>&1; then
        enabled_services="$(batocera-settings-get system.services 2>/dev/null || true)"
        for enabled_service in $enabled_services; do
          [ "$enabled_service" = "$name" ] && {
            printf '%s\\n' 'enabled'
            return
          }
        done
        printf '%s\\n' 'disabled'
        return
      fi
    fi

    printf '%s\\n' 'init.d'
  }

  for dir in /etc/init.d /userdata/system/services; do
    [ -d "$dir" ] || continue
    for script in "$dir"/*; do
      [ -f "$script" ] && [ -x "$script" ] || continue
      name="\${script##*/}"
      case "$name" in
        rcK|rcS) continue ;;
      esac
      if init_script_state "$script" "$name"; then
        printf '%s\\tloaded\\tactive\\trunning\\t%s\\n' "$name" "$script"
      else
        printf '%s\\tloaded\\tavailable\\tinit.d\\t%s\\n' "$name" "$script"
      fi
    done
  done | sort -u
  printf '%s\\n' '${UNIT_FILES_MARKER}'
  for dir in /etc/init.d /userdata/system/services; do
    [ -d "$dir" ] || continue
    for script in "$dir"/*; do
      [ -f "$script" ] && [ -x "$script" ] || continue
      name="\${script##*/}"
      case "$name" in
        rcK|rcS) continue ;;
      esac
      printf '%s\\t%s\\n' "$name" "$(init_script_startup_state "$script" "$name")"
    done
  done | sort -u
fi
`.trim();

const SYSTEMD_USER_SERVICES_COMMAND = `
systemctl_bin="$(command -v systemctl 2>/dev/null || true)"
if [ -z "$systemctl_bin" ]; then
  for candidate in /usr/bin/systemctl /bin/systemctl /usr/sbin/systemctl /sbin/systemctl; do
    if [ -x "$candidate" ]; then
      systemctl_bin="$candidate"
      break
    fi
  done
fi
if [ -n "$systemctl_bin" ] && [ -S "/run/user/$(id -u)/bus" ]; then
  export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  export DBUS_SESSION_BUS_ADDRESS="\${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
  units="$(
    {
      "$systemctl_bin" --user list-unit-files --type=service --no-legend --no-pager 2>/dev/null | awk '{ print $1 }'
      "$systemctl_bin" --user list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null | awk '{ print $1 }'
    } | awk 'NF && $1 !~ /@\\.service$/ && !seen[$1]++'
  )"
  if [ -n "$units" ]; then
    printf '%s\\n' "$units" | xargs "$systemctl_bin" --user show --no-pager -p Id -p LoadState -p ActiveState -p SubState -p Description 2>/dev/null | awk -F= '
      function reset() {
        id = ""; load = ""; active = ""; substate = ""; description = ""
      }
      function emit() {
        if (id ~ /\\.service$/) {
          printf "%s\\t%s\\t%s\\t%s\\t%s\\n", id, load ? load : "unknown", active ? active : "unknown", substate ? substate : "unknown", description ? description : id
        }
        reset()
      }
      BEGIN { reset() }
      /^$/ { emit(); next }
      $1 == "Id" { id = substr($0, index($0, "=") + 1); next }
      $1 == "LoadState" { load = substr($0, index($0, "=") + 1); next }
      $1 == "ActiveState" { active = substr($0, index($0, "=") + 1); next }
      $1 == "SubState" { substate = substr($0, index($0, "=") + 1); next }
      $1 == "Description" { description = substr($0, index($0, "=") + 1); next }
      END { emit() }
    '
  fi
  printf '%s\\n' '${UNIT_FILES_MARKER}'
  "$systemctl_bin" --user list-unit-files --type=service --no-legend --no-pager 2>/dev/null | awk '{
    printf "%s\\t%s\\n", $1, $2
  }'
else
  printf '%s\\n' '${UNIT_FILES_MARKER}'
fi
true
`.trim();

export async function listSystemdServices(
  store: ServerProfileStore,
  keyStore: KeyStore,
  serverId: string,
  includeUserServices = false,
  forceRefresh = false,
): Promise<SystemdServicesResult> {
  const cacheKey = systemdServiceListCacheKey(serverId, includeUserServices);

  if (!forceRefresh) {
    const cached = systemdServiceListCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    const inFlight = systemdServiceListInFlight.get(cacheKey);

    if (inFlight) {
      return inFlight;
    }
  }

  const loadPromise = listSystemdServicesUncached(store, keyStore, serverId, includeUserServices)
    .then((result) => {
      if (result.ok) {
        systemdServiceListCache.set(cacheKey, {
          expiresAt: Date.now() + SYSTEMD_LIST_CACHE_MS,
          result,
        });
      }

      return result;
    })
    .finally(() => {
      systemdServiceListInFlight.delete(cacheKey);
    });

  systemdServiceListInFlight.set(cacheKey, loadPromise);
  return loadPromise;
}

async function listSystemdServicesUncached(
  store: ServerProfileStore,
  keyStore: KeyStore,
  serverId: string,
  includeUserServices: boolean,
): Promise<SystemdServicesResult> {
  try {
    const target = await resolveSshTarget(store, keyStore, serverId);
    const { systemRaw, userRaw } = target.isLocal
      ? await listLocalSystemdServiceGroups(includeUserServices)
      : await listRemoteSystemdServiceGroups(target.connectConfig, includeUserServices);
    const systemServices = parseSystemdServices(systemRaw, 'system');
    const userServices = userRaw ? parseSystemdServices(userRaw, 'user') : [];

    return {
      ok: true,
      services: [...systemServices, ...userServices].sort(compareServices),
    };
  } catch (error) {
    const fallback = readCachedServiceList(serverId, includeUserServices) ?? (includeUserServices ? readCachedServiceList(serverId, false) : undefined);

    if (fallback) {
      return fallback;
    }

    return {
      ok: false,
      services: [],
      error: error instanceof Error ? normalizeSshError(error.message) : 'Unable to list systemd services.',
    };
  }
}

export async function controlSystemdService(
  store: ServerProfileStore,
  keyStore: KeyStore,
  serverId: string,
  serviceName: string,
  action: SystemdServiceAction,
  scope: SystemdServiceScope = 'system',
): Promise<SystemdServiceActionResult> {
  const target = normalizeSystemdServiceTarget(serviceName, scope);

  serviceName = target.serviceName;
  scope = target.scope;

  assertValidServiceName(serviceName);
  assertValidSystemdAction(action);
  assertValidSystemdScope(scope);

  try {
    const target = await resolveSshTarget(store, keyStore, serverId);

    if (target.isLocal) {
      await controlLocalSystemdService(serviceName, action, scope);
    } else {
      await controlRemoteSystemdService(target.connectConfig, serviceName, action, scope);
    }

    invalidateSystemdServiceListCache(serverId);
    return { ok: true, action, serviceName, scope };
  } catch (error) {
    invalidateSystemdServiceListCache(serverId);

    return {
      ok: false,
      action,
      serviceName,
      scope,
      error: error instanceof Error ? normalizeSystemdControlError(error.message) : 'Unable to control systemd service.',
    };
  }
}

function systemdServiceListCacheKey(serverId: string, includeUserServices: boolean): string {
  return `${serverId}:${includeUserServices ? 'with-user' : 'system'}`;
}

function invalidateSystemdServiceListCache(serverId: string): void {
  systemdServiceListCache.delete(systemdServiceListCacheKey(serverId, false));
  systemdServiceListCache.delete(systemdServiceListCacheKey(serverId, true));
}

function normalizeSystemdServiceTarget(serviceName: string, scope: SystemdServiceScope): { serviceName: string; scope: SystemdServiceScope } {
  if (serviceName.startsWith('user:')) {
    return {
      serviceName: serviceName.slice('user:'.length),
      scope: 'user',
    };
  }

  if (serviceName.startsWith('system:')) {
    return {
      serviceName: serviceName.slice('system:'.length),
      scope: 'system',
    };
  }

  return { serviceName, scope };
}

function readCachedServiceList(serverId: string, includeUserServices: boolean): SystemdServicesResult | undefined {
  const cached = systemdServiceListCache.get(systemdServiceListCacheKey(serverId, includeUserServices));

  if (!cached || !cached.result.ok) {
    return undefined;
  }

  return cached.result;
}

export function parseSystemdServices(raw: string, scope: SystemdServiceScope = 'system'): SystemdServiceUnit[] {
  const [unitOutput = '', unitFileOutput = ''] = raw.split(UNIT_FILES_MARKER);
  const unitFileStates = parseUnitFileStates(unitFileOutput);
  const services = new Map<string, SystemdServiceUnit>();

  for (const line of unitOutput.split('\n')) {
    const [name, loadState, activeState, subState, description = ''] = line.split('\t');

    if (!isValidServiceName(name)) {
      continue;
    }

    services.set(name, {
      name,
      scope,
      loadState: loadState || 'unknown',
      activeState: activeState || 'unknown',
      subState: subState || 'unknown',
      unitFileState: unitFileStates.get(name) ?? 'unknown',
      description: description || name,
    });
  }

  for (const [name, unitFileState] of unitFileStates) {
    if (services.has(name)) {
      continue;
    }

    services.set(name, {
      name,
      scope,
      loadState: 'not-loaded',
      activeState: 'inactive',
      subState: 'dead',
      unitFileState,
      description: name,
    });
  }

  return [...services.values()].sort(compareServices);
}

export function isSystemdServiceAction(value: string): value is SystemdServiceAction {
  return value === 'start' || value === 'stop' || value === 'restart' || value === 'enable' || value === 'disable';
}

export function buildSystemdActionCommand(serviceName: string, action: SystemdServiceAction, scope: SystemdServiceScope = 'system'): string {
  const target = normalizeSystemdServiceTarget(serviceName, scope);

  serviceName = target.serviceName;
  scope = target.scope;

  assertValidServiceName(serviceName);
  assertValidSystemdAction(action);
  assertValidSystemdScope(scope);

  if (scope === 'user') {
    return buildUserSystemdActionCommand(serviceName, action);
  }

  const quotedServiceName = shellQuote(serviceName);
  const quotedAction = shellQuote(action);

  if (serviceName.endsWith('.service')) {
    return [
      `systemctl ${action} ${quotedServiceName}`,
      `sudo -n systemctl ${action} ${quotedServiceName}`,
      `{ printf '%s\\n' ${shellQuote(PASSWORDLESS_SUDO_REQUIRED_MESSAGE)} >&2; exit 1; }`,
    ].join(' || ');
  }

  return [
    `case ${quotedAction} in start|stop|restart) ;; *) printf '%s\\n' 'Only start, stop, and restart are supported for init scripts.' >&2; exit 2 ;; esac`,
    `for dir in /etc/init.d /userdata/system/services; do script="$dir"/${quotedServiceName}; if [ -x "$script" ]; then exec "$script" ${quotedAction}; fi; done`,
    `printf '%s\\n' 'Init script not found.' >&2; exit 127`,
  ].join('; ');
}

function buildUserSystemdActionCommand(serviceName: string, action: SystemdServiceAction): string {
  if (!serviceName.endsWith('.service')) {
    throw new Error('User service actions require a systemd .service unit name.');
  }

  const quotedServiceName = shellQuote(serviceName);
  const quotedAction = shellQuote(action);

  return [
    'systemctl_bin="$(command -v systemctl 2>/dev/null || true)"',
    '[ -n "$systemctl_bin" ] || { printf \'%s\\n\' \'systemctl was not found.\' >&2; exit 127; }',
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    '[ -S "$XDG_RUNTIME_DIR/bus" ] || { printf \'%s\\n\' \'User systemd bus is not available for this SSH user.\' >&2; exit 125; }',
    'export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"',
    `"$systemctl_bin" --user ${quotedAction} ${quotedServiceName}`,
  ].join('; ');
}

function listRemoteSystemdServiceGroups(connectConfig: ConnectConfig, includeUserServices: boolean): Promise<{ systemRaw: string; userRaw: string }> {
  return withSshClient(connectConfig, async (client) => {
    const systemResult = await execSshCommand(client, `/bin/sh -lc ${shellQuote(SYSTEMD_SERVICES_COMMAND)}`, {
      timeoutMs: SYSTEMD_LIST_TIMEOUT_MS,
      label: 'Systemd service list',
    });

    let userRaw = '';

    if (includeUserServices) {
      try {
        const userResult = await execSshCommand(client, `/bin/sh -lc ${shellQuote(SYSTEMD_USER_SERVICES_COMMAND)}`, {
          timeoutMs: SYSTEMD_LIST_TIMEOUT_MS,
          label: 'User systemd service list',
        });
        userRaw = userResult.stdout;
      } catch {
        userRaw = '';
      }
    }

    return { systemRaw: systemResult.stdout, userRaw };
  });
}

async function listLocalSystemdServiceGroups(includeUserServices: boolean): Promise<{ systemRaw: string; userRaw: string }> {
  const systemRaw = await listLocalSystemdServices(SYSTEMD_SERVICES_COMMAND);
  let userRaw = '';

  if (includeUserServices) {
    try {
      userRaw = await listLocalSystemdServices(SYSTEMD_USER_SERVICES_COMMAND);
    } catch {
      userRaw = '';
    }
  }

  return { systemRaw, userRaw };
}

function listLocalSystemdServices(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/sh',
      ['-lc', command],
      { timeout: SYSTEMD_LIST_TIMEOUT_MS, maxBuffer: SYSTEMD_LIST_MAX_BUFFER_BYTES },
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

async function controlRemoteSystemdService(connectConfig: ConnectConfig, serviceName: string, action: SystemdServiceAction, scope: SystemdServiceScope): Promise<void> {
  await withSshClient(connectConfig, async (client) => {
    await execSshCommand(client, buildSystemdActionCommand(serviceName, action, scope), {
      timeoutMs: SYSTEMD_ACTION_TIMEOUT_MS,
      label: `Systemd ${action}`,
    });
  });
}

function controlLocalSystemdService(serviceName: string, action: SystemdServiceAction, scope: SystemdServiceScope): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/bin/sh', ['-lc', buildSystemdActionCommand(serviceName, action, scope)], { timeout: SYSTEMD_ACTION_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }

      resolve();
    });
  });
}

function normalizeSystemdControlError(message: string): string {
  if (message.includes(PASSWORDLESS_SUDO_REQUIRED_MESSAGE)) {
    return PASSWORDLESS_SUDO_REQUIRED_MESSAGE;
  }

  return normalizeSshError(message);
}

function parseUnitFileStates(unitFileOutput: string): Map<string, string> {
  const states = new Map<string, string>();

  for (const line of unitFileOutput.split('\n')) {
    const [name, state] = line.trim().split(/\s+/);

    if (isValidServiceName(name)) {
      states.set(name, state || 'unknown');
    }
  }

  return states;
}

function compareServices(a: SystemdServiceUnit, b: SystemdServiceUnit): number {
  return serviceSortRank(a) - serviceSortRank(b)
    || a.name.localeCompare(b.name)
    || a.scope.localeCompare(b.scope);
}

function serviceSortRank(service: SystemdServiceUnit): number {
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

function assertValidSystemdScope(scope: string): asserts scope is SystemdServiceScope {
  if (scope !== 'system' && scope !== 'user') {
    throw new Error('scope must be system or user.');
  }
}

function assertValidSystemdAction(action: string): asserts action is SystemdServiceAction {
  if (!isSystemdServiceAction(action)) {
    throw new Error('action must be start, stop, restart, enable, or disable.');
  }
}

function assertValidServiceName(serviceName: string): void {
  if (!isValidServiceName(serviceName)) {
    throw new Error('serviceName must be a valid systemd service unit name.');
  }
}

function isValidServiceName(serviceName: string | undefined): serviceName is string {
  return Boolean(serviceName && /^[A-Za-z0-9_.@:+-]+(?:\.service)?$/.test(serviceName));
}

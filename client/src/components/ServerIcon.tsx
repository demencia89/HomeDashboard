import { Box, CircuitBoard, Cloud, Container, Cpu, Database, Gauge, Globe2, HardDrive, House, Laptop, MemoryStick, Microchip, Monitor, Network, Package, RadioTower, Router, Server, ServerCog, Shield, Smartphone, Terminal, Wifi } from 'lucide-react';
import type React from 'react';
import type { ServerIconColorId, ServerIconId, ServerProfile } from '../types';

export const SERVER_ICON_OPTIONS: { id: '' | ServerIconId; label: string }[] = [
  { id: '', label: 'Auto' },
  { id: 'circuit-board', label: 'Board' },
  { id: 'smartphone', label: 'Phone' },
  { id: 'monitor', label: 'Desktop' },
  { id: 'laptop', label: 'Laptop' },
  { id: 'cpu', label: 'Compute' },
  { id: 'memory', label: 'Memory' },
  { id: 'hard-drive', label: 'Storage' },
  { id: 'database', label: 'Database' },
  { id: 'container', label: 'Container' },
  { id: 'box', label: 'Box' },
  { id: 'router', label: 'Router' },
  { id: 'wifi', label: 'Wi-Fi' },
  { id: 'radio-tower', label: 'Radio' },
  { id: 'network', label: 'Network' },
  { id: 'shield', label: 'Security' },
  { id: 'gauge', label: 'Monitor' },
  { id: 'home', label: 'Home' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'globe', label: 'Globe' },
  { id: 'microchip', label: 'Microchip' },
  { id: 'server-cog', label: 'Server tools' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'package', label: 'Package' },
];

export const SERVER_ICON_COLOR_OPTIONS: { id: '' | ServerIconColorId; label: string; color: string }[] = [
  { id: '', label: 'Default', color: '#b8c7e6' },
  { id: 'sky', label: 'Sky', color: '#8ab4ff' },
  { id: 'teal', label: 'Teal', color: '#5eead4' },
  { id: 'green', label: 'Green', color: '#86efac' },
  { id: 'amber', label: 'Amber', color: '#fbbf24' },
  { id: 'rose', label: 'Rose', color: '#fda4af' },
  { id: 'violet', label: 'Violet', color: '#c4b5fd' },
  { id: 'cyan', label: 'Cyan', color: '#67e8f9' },
];

export function ServerIconBadge({
  server,
  size = 17,
  className = '',
}: {
  server: Pick<ServerProfile, 'alias' | 'host' | 'serverIcon' | 'serverIconColor'>;
  size?: number;
  className?: string;
}) {
  const iconId = resolveServerIcon(server);
  const Icon = iconComponentFor(iconId);
  const colorId = server.serverIconColor ?? '';
  const color = SERVER_ICON_COLOR_OPTIONS.find((option) => option.id === colorId)?.color;

  return (
    <span
      className={`server-icon-badge server-icon-${iconId}${colorId ? ` server-icon-color-${colorId}` : ''}${className ? ` ${className}` : ''}`}
      style={color ? { '--server-icon-color': color } as React.CSSProperties : undefined}
      title={SERVER_ICON_OPTIONS.find((option) => option.id === iconId)?.label ?? 'Server'}
    >
      <Icon size={size} strokeWidth={2.15} />
    </span>
  );
}

export function ServerIconGlyph({ iconId, size = 16 }: { iconId: '' | ServerIconId; size?: number }) {
  const Icon = iconComponentFor(iconId || 'server');

  return <Icon size={size} strokeWidth={2.15} />;
}

function resolveServerIcon(server: Pick<ServerProfile, 'alias' | 'host' | 'serverIcon'>): ServerIconId {
  if (server.serverIcon) {
    return server.serverIcon;
  }

  const normalized = `${server.alias} ${server.host}`.toLowerCase();

  if (/(raspberry|raspi|\brpi\b|\bpi[ -]?\d*\b)/.test(normalized)) {
    return 'circuit-board';
  }

  if (/(phone|android|pixel|mobile)/.test(normalized)) {
    return 'smartphone';
  }

  if (/(laptop|notebook)/.test(normalized)) {
    return 'laptop';
  }

  if (/(desktop|workstation|pc|cachy|arch)/.test(normalized)) {
    return 'monitor';
  }

  if (/(firewall|security|vpn|proxy)/.test(normalized)) {
    return 'shield';
  }

  if (/(router|gateway)/.test(normalized)) {
    return 'router';
  }

  if (/(wifi|wireless|ap\b|access point|radio)/.test(normalized)) {
    return 'wifi';
  }

  if (/(switch|network)/.test(normalized)) {
    return 'network';
  }

  if (/(nas|storage|backup|disk)/.test(normalized)) {
    return 'hard-drive';
  }

  if (/(db|database|postgres|mysql|mariadb|redis|mongo)/.test(normalized)) {
    return 'database';
  }

  if (/(docker|container|compose|podman)/.test(normalized)) {
    return 'container';
  }

  if (/(home|assistant|casaos|dashboard)/.test(normalized)) {
    return 'home';
  }

  if (/(vps|cloud|instance)/.test(normalized)) {
    return 'cloud';
  }

  return 'server';
}

function iconComponentFor(iconId: ServerIconId) {
  switch (iconId) {
    case 'circuit-board':
      return CircuitBoard;
    case 'smartphone':
      return Smartphone;
    case 'monitor':
      return Monitor;
    case 'laptop':
      return Laptop;
    case 'cpu':
      return Cpu;
    case 'memory':
      return MemoryStick;
    case 'hard-drive':
      return HardDrive;
    case 'database':
      return Database;
    case 'container':
      return Container;
    case 'box':
      return Box;
    case 'router':
      return Router;
    case 'wifi':
      return Wifi;
    case 'radio-tower':
      return RadioTower;
    case 'network':
      return Network;
    case 'shield':
      return Shield;
    case 'gauge':
      return Gauge;
    case 'home':
      return House;
    case 'cloud':
      return Cloud;
    case 'globe':
      return Globe2;
    case 'microchip':
      return Microchip;
    case 'server-cog':
      return ServerCog;
    case 'terminal':
      return Terminal;
    case 'package':
      return Package;
    case 'server':
    default:
      return Server;
  }
}

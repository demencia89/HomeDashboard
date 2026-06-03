export function StatusBadge({ online, error }: { online?: boolean; error?: string }) {
  if (online === undefined) {
    return <span className="badge neutral">Unknown</span>;
  }

  return <span className={online ? 'badge good' : 'badge bad'}>{online ? 'Online' : error ?? 'Offline'}</span>;
}



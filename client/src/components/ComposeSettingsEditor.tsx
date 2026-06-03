import { useEffect, useMemo, useState } from 'react';
import { Code2, Plus, Settings2, Trash2 } from 'lucide-react';
import type { ComposeKeyValue, ComposeMount, ComposePort, EditableComposeService } from '../lib/compose';
import { parseDockerCompose, updateDockerComposeService } from '../lib/compose';

interface ComposeSettingsEditorProps {
  content: string;
  serviceName?: string;
  onChange: (content: string) => void;
}

type ComposeEditorMode = 'settings' | 'raw';

const RESTART_POLICIES = ['', 'no', 'always', 'unless-stopped', 'on-failure'];
const NETWORK_MODES = ['', 'bridge', 'host', 'none'];
const PORT_PROTOCOLS = ['TCP', 'UDP'];

export function ComposeSettingsEditor({ content, serviceName, onChange }: ComposeSettingsEditorProps) {
  const [mode, setMode] = useState<ComposeEditorMode>('settings');
  const [selectedServiceName, setSelectedServiceName] = useState(serviceName ?? '');
  const parsed = useMemo(() => parseDockerCompose(content), [content]);

  useEffect(() => {
    if (!parsed.ok) {
      return;
    }

    const preferredService = serviceName && parsed.services.some((service) => service.name === serviceName) ? serviceName : parsed.services[0]?.name ?? '';

    if (!selectedServiceName || !parsed.services.some((service) => service.name === selectedServiceName)) {
      setSelectedServiceName(preferredService);
    }
  }, [parsed, selectedServiceName, serviceName]);

  if (!parsed.ok) {
    return (
      <div className="compose-workbench">
        <p className="compose-form-note">{parsed.error} The raw compose file is still editable.</p>
        <textarea className="compose-editor" spellCheck={false} value={content} onChange={(event) => onChange(event.target.value)} />
      </div>
    );
  }

  const selectedService = parsed.services.find((service) => service.name === selectedServiceName) ?? parsed.services[0];

  if (!selectedService) {
    return (
      <div className="compose-workbench">
        <p className="compose-form-note">No editable services found in this compose file.</p>
        <textarea className="compose-editor" spellCheck={false} value={content} onChange={(event) => onChange(event.target.value)} />
      </div>
    );
  }

  const patchSelectedService = (patch: Partial<EditableComposeService>) => {
    onChange(updateDockerComposeService(content, selectedService.name, { ...selectedService, ...patch }));
  };

  return (
    <div className="compose-workbench">
      <div className="compose-editor-toolbar">
        <div className="segmented compact compose-editor-mode" role="group" aria-label="Compose editor mode">
          <button type="button" className={mode === 'settings' ? 'active' : ''} title="Settings form" onClick={() => setMode('settings')}>
            <Settings2 size={14} /> Settings
          </button>
          <button type="button" className={mode === 'raw' ? 'active' : ''} title="Raw compose file" onClick={() => setMode('raw')}>
            <Code2 size={14} /> Raw
          </button>
        </div>
        {parsed.services.length > 1 && (
          <label className="compose-service-picker">
            <span>Service</span>
            <select value={selectedService.name} onChange={(event) => setSelectedServiceName(event.target.value)}>
              {parsed.services.map((service) => <option key={service.name} value={service.name}>{service.name}</option>)}
            </select>
          </label>
        )}
      </div>
      {mode === 'raw' ? (
        <textarea className="compose-editor" spellCheck={false} value={content} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <ComposeServiceForm service={selectedService} onChange={patchSelectedService} />
      )}
    </div>
  );
}

function ComposeServiceForm({ service, onChange }: { service: EditableComposeService; onChange: (patch: Partial<EditableComposeService>) => void }) {
  return (
    <div className="compose-form">
      <section className="compose-form-section">
        <div className="compose-two-column">
          <label>
            <span>Docker Image</span>
            <input value={service.imageRepository} onChange={(event) => onChange({ imageRepository: event.target.value })} placeholder="ghcr.io/example/app" />
          </label>
          <label>
            <span>Tag</span>
            <input value={service.imageTag} onChange={(event) => onChange({ imageTag: event.target.value })} placeholder="latest" />
          </label>
        </div>
        <div className="compose-two-column">
          <label>
            <span>Service</span>
            <input value={service.name} readOnly />
          </label>
          <label>
            <span>Container Name</span>
            <input value={service.containerName} onChange={(event) => onChange({ containerName: event.target.value })} placeholder={service.name} />
          </label>
        </div>
        <div className="compose-two-column">
          <label>
            <span>Network</span>
            <select value={service.networkMode} onChange={(event) => onChange({ networkMode: event.target.value })}>
              {NETWORK_MODES.map((value) => <option key={value || 'default'} value={value}>{value || 'Compose default'}</option>)}
              {!NETWORK_MODES.includes(service.networkMode) && <option value={service.networkMode}>{service.networkMode}</option>}
            </select>
          </label>
          <label>
            <span>Restart Policy</span>
            <select value={service.restart} onChange={(event) => onChange({ restart: event.target.value })}>
              {RESTART_POLICIES.map((value) => <option key={value || 'default'} value={value}>{value || 'Compose default'}</option>)}
              {!RESTART_POLICIES.includes(service.restart) && <option value={service.restart}>{service.restart}</option>}
            </select>
          </label>
        </div>
      </section>

      <ComposePorts ports={service.ports} onChange={(ports) => onChange({ ports })} />
      <ComposeMounts title="Volumes" mounts={service.volumes} hostLabel="Host" containerLabel="Container" onChange={(volumes) => onChange({ volumes })} />
      <ComposeEnvironment environment={service.environment} onChange={(environment) => onChange({ environment })} />
      <ComposeMounts title="Devices" mounts={service.devices} hostLabel="Host" containerLabel="Container" onChange={(devices) => onChange({ devices })} />
      <ComposeList title="Container Command" values={service.command} placeholder="Command or argument" onChange={(command) => onChange({ command })} />

      <section className="compose-form-section">
        <div className="compose-form-section-heading">
          <h4>Runtime</h4>
        </div>
        <div className="compose-runtime-grid">
          <label className="compose-switch">
            <input type="checkbox" checked={service.privileged} onChange={(event) => onChange({ privileged: event.target.checked })} />
            <span>Privileged</span>
          </label>
          <label>
            <span>Memory Limit</span>
            <input value={service.memLimit} onChange={(event) => onChange({ memLimit: event.target.value })} placeholder="512m" />
          </label>
          <label>
            <span>CPU Shares</span>
            <input value={service.cpuShares} onChange={(event) => onChange({ cpuShares: event.target.value })} placeholder="1024" inputMode="numeric" />
          </label>
        </div>
      </section>

      <ComposeList title="Container Capabilities" values={service.capAdd} placeholder="NET_ADMIN" onChange={(capAdd) => onChange({ capAdd })} />
    </div>
  );
}

function ComposePorts({ ports, onChange }: { ports: ComposePort[]; onChange: (ports: ComposePort[]) => void }) {
  const rows = ports.length ? ports : [emptyPort()];

  return (
    <section className="compose-form-section">
      <ListHeading title="Ports" onAdd={() => onChange([...ports, emptyPort()])} />
      <div className="compose-grid-labels compose-port-grid">
        <span>Host</span>
        <span>Container</span>
        <span>Protocol</span>
        <span />
      </div>
      {rows.map((port, index) => (
        <div className="compose-port-row compose-port-grid" key={index}>
          <input value={port.host} onChange={(event) => onChange(replaceAt(rows, index, { ...port, host: event.target.value }))} placeholder="8100" inputMode="numeric" />
          <input value={port.container} onChange={(event) => onChange(replaceAt(rows, index, { ...port, container: event.target.value }))} placeholder="8080" inputMode="numeric" />
          <select value={port.protocol || 'TCP'} onChange={(event) => onChange(replaceAt(rows, index, { ...port, protocol: event.target.value }))}>
            {PORT_PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}
          </select>
          <RemoveRowButton disabled={!ports.length} onClick={() => onChange(removeAt(rows, index))} />
        </div>
      ))}
    </section>
  );
}

function ComposeMounts({
  title,
  mounts,
  hostLabel,
  containerLabel,
  onChange,
}: {
  title: string;
  mounts: ComposeMount[];
  hostLabel: string;
  containerLabel: string;
  onChange: (mounts: ComposeMount[]) => void;
}) {
  const rows = mounts.length ? mounts : [emptyMount()];

  return (
    <section className="compose-form-section">
      <ListHeading title={title} onAdd={() => onChange([...mounts, emptyMount()])} />
      <div className="compose-grid-labels compose-mount-grid">
        <span>{hostLabel}</span>
        <span>{containerLabel}</span>
        <span>Mode</span>
        <span />
      </div>
      {rows.map((mount, index) => (
        <div className="compose-mount-row compose-mount-grid" key={index}>
          <input value={mount.host} onChange={(event) => onChange(replaceAt(rows, index, { ...mount, host: event.target.value }))} placeholder="/DATA/AppData/app" />
          <input value={mount.container} onChange={(event) => onChange(replaceAt(rows, index, { ...mount, container: event.target.value }))} placeholder="/config" />
          <input value={mount.mode} onChange={(event) => onChange(replaceAt(rows, index, { ...mount, mode: event.target.value }))} placeholder="rw" />
          <RemoveRowButton disabled={!mounts.length} onClick={() => onChange(removeAt(rows, index))} />
        </div>
      ))}
    </section>
  );
}

function ComposeEnvironment({ environment, onChange }: { environment: ComposeKeyValue[]; onChange: (environment: ComposeKeyValue[]) => void }) {
  const rows = environment.length ? environment : [emptyKeyValue()];

  return (
    <section className="compose-form-section">
      <ListHeading title="Environment Variables" onAdd={() => onChange([...environment, emptyKeyValue()])} />
      <div className="compose-grid-labels compose-key-value-grid">
        <span>Key</span>
        <span>Value</span>
        <span />
      </div>
      {rows.map((entry, index) => (
        <div className="compose-key-value-row compose-key-value-grid" key={index}>
          <input value={entry.key} onChange={(event) => onChange(replaceAt(rows, index, { ...entry, key: event.target.value }))} placeholder="KEY" />
          <input value={entry.value} onChange={(event) => onChange(replaceAt(rows, index, { ...entry, value: event.target.value }))} placeholder="value" />
          <RemoveRowButton disabled={!environment.length} onClick={() => onChange(removeAt(rows, index))} />
        </div>
      ))}
    </section>
  );
}

function ComposeList({
  title,
  values,
  placeholder,
  onChange,
}: {
  title: string;
  values: string[];
  placeholder: string;
  onChange: (values: string[]) => void;
}) {
  const rows = values.length ? values : [''];

  return (
    <section className="compose-form-section">
      <ListHeading title={title} onAdd={() => onChange([...values, ''])} />
      {rows.map((value, index) => (
        <div className="compose-list-row" key={index}>
          <input value={value} onChange={(event) => onChange(replaceAt(rows, index, event.target.value))} placeholder={placeholder} />
          <RemoveRowButton disabled={!values.length} onClick={() => onChange(removeAt(rows, index))} />
        </div>
      ))}
    </section>
  );
}

function ListHeading({ title, onAdd }: { title: string; onAdd: () => void }) {
  return (
    <div className="compose-form-section-heading">
      <h4>{title}</h4>
      <button type="button" className="command compact-command" onClick={onAdd}>
        <Plus size={14} /> Add
      </button>
    </div>
  );
}

function RemoveRowButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" className="compose-remove-row" title="Remove row" disabled={disabled} onClick={onClick}>
      <Trash2 size={14} />
    </button>
  );
}

function replaceAt<T>(values: T[], index: number, value: T): T[] {
  return values.map((current, currentIndex) => currentIndex === index ? value : current);
}

function removeAt<T>(values: T[], index: number): T[] {
  return values.filter((_, currentIndex) => currentIndex !== index);
}

function emptyPort(): ComposePort {
  return { host: '', container: '', protocol: 'TCP' };
}

function emptyMount(): ComposeMount {
  return { host: '', container: '', mode: '' };
}

function emptyKeyValue(): ComposeKeyValue {
  return { key: '', value: '' };
}

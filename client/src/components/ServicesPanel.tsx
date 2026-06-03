import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, CircleHelp, Play, RefreshCw, Square, XCircle } from 'lucide-react';
import type { ServerProfile, SystemdServiceAction, SystemdServiceUnit } from '../types';
import { controlSystemdService, listSystemdServices } from '../lib/api';
import { removeRecordKey } from '../lib/records';

type ServiceActionFeedback = {
  tone: 'success' | 'error';
  message: string;
};

export function ServicesPanel({
  server,
  visible,
}: {
  server?: ServerProfile;
  visible: boolean;
}) {
  const [servicesByServer, setServicesByServer] = useState<Record<string, SystemdServiceUnit[]>>({});
  const [loadedServerIds, setLoadedServerIds] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [pendingActions, setPendingActions] = useState<Record<string, SystemdServiceAction>>({});
  const [actionFeedbacks, setActionFeedbacks] = useState<Record<string, ServiceActionFeedback>>({});
  const [query, setQuery] = useState('');
  const [showSystemServices, setShowSystemServices] = useState(false);
  const [message, setMessage] = useState('');
  const [systemServicesHelpOpen, setSystemServicesHelpOpen] = useState(false);
  const servicesCacheKey = server ? serviceCacheKey(server.id) : '';
  const allServices = servicesCacheKey ? servicesByServer[servicesCacheKey] ?? [] : [];
  const visibleServices = useMemo(() => {
    return showSystemServices ? allServices : allServices.filter((service) => service.scope === 'user');
  }, [allServices, showSystemServices]);

  const loadServices = useCallback(async (forceRefresh = false) => {
    if (!server || !servicesCacheKey) {
      return;
    }

    setLoading(true);
    setMessage('');

    try {
      const loadedServices = await listSystemdServices(server.id, true, forceRefresh);
      setServicesByServer((current) => ({ ...current, [servicesCacheKey]: loadedServices }));
      setLoadedServerIds((current) => ({ ...current, [servicesCacheKey]: true }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to list systemd services.');
    } finally {
      setLoading(false);
    }
  }, [server, servicesCacheKey]);

  useEffect(() => {
    if (visible && servicesCacheKey && !loadedServerIds[servicesCacheKey]) {
      void loadServices();
    }
  }, [loadServices, loadedServerIds, servicesCacheKey, visible]);

  const filteredServices = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) {
      return visibleServices;
    }

    return visibleServices.filter((service) => {
      return service.name.toLowerCase().includes(normalizedQuery)
        || service.scope.toLowerCase().includes(normalizedQuery)
        || service.description.toLowerCase().includes(normalizedQuery)
        || service.activeState.toLowerCase().includes(normalizedQuery)
        || service.unitFileState.toLowerCase().includes(normalizedQuery);
    });
  }, [query, visibleServices]);

  const handleServiceAction = useCallback(async (service: SystemdServiceUnit, action: SystemdServiceAction) => {
    if (!confirmServiceAction(service, action)) {
      return;
    }

    const pendingKey = serviceKey(service);
    setPendingActions((current) => ({ ...current, [pendingKey]: action }));
    setActionFeedbacks((current) => removeRecordKey(current, pendingKey));
    setMessage('');

    try {
      if (!server) {
        return;
      }

      await controlSystemdService(server.id, service.name, action, service.scope);
      setActionFeedbacks((current) => ({
        ...current,
        [pendingKey]: {
          tone: 'success',
          message: `${serviceDisplayName(service)} ${serviceActionPastTense(action)}.`,
        },
      }));
      await loadServices(true);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unable to control systemd service.';
      setActionFeedbacks((current) => ({
        ...current,
        [pendingKey]: {
          tone: 'error',
          message: `Failed to ${action} ${serviceDisplayName(service)}: ${detail}`,
        },
      }));
    } finally {
      setPendingActions((current) => removeRecordKey(current, pendingKey));
    }
  }, [loadServices, server]);

  if (!server) {
    return <div className="empty-state">No server selected.</div>;
  }

  return (
    <div className="services-panel">
      <div className="panel-toolbar">
        <div>
          <h3>Services</h3>
          <span>{filteredServices.length} of {visibleServices.length} service{visibleServices.length === 1 ? '' : 's'}</span>
        </div>
        <div className="refresh-controls">
          <label className="check-control">
            <input type="checkbox" checked={showSystemServices} onChange={(event) => setShowSystemServices(event.target.checked)} />
            Show system services
          </label>
          <button type="button" className="icon-command" title="System services setup" aria-label="System services setup" onClick={() => setSystemServicesHelpOpen(true)}>
            <CircleHelp size={16} />
          </button>
          <input className="search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter services" />
          <button className="command" onClick={() => void loadServices(true)} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'spin-icon' : undefined} /> Refresh
          </button>
        </div>
      </div>
      {message && <p className="message container-message">{message}</p>}
      <ServiceTable
        services={filteredServices}
        pendingActions={pendingActions}
        actionFeedbacks={actionFeedbacks}
        emptyMessage={loading ? 'Loading services...' : query.trim() ? 'No services match this filter.' : showSystemServices ? 'No systemd services found.' : 'No user services found.'}
        onServiceAction={handleServiceAction}
      />
      {systemServicesHelpOpen && (
        <SystemServicesHelpDialog onClose={() => setSystemServicesHelpOpen(false)} />
      )}
    </div>
  );
}

function ServiceTable({
  services,
  pendingActions,
  actionFeedbacks,
  emptyMessage,
  onServiceAction,
}: {
  services: SystemdServiceUnit[];
  pendingActions: Record<string, SystemdServiceAction>;
  actionFeedbacks: Record<string, ServiceActionFeedback>;
  emptyMessage: string;
  onServiceAction: (service: SystemdServiceUnit, action: SystemdServiceAction) => Promise<void>;
}) {
  if (!services.length) {
    return <div className="empty-state panel-empty">{emptyMessage}</div>;
  }

  return (
    <div className="service-table">
      <div className="service-row header"><span>Name</span><span>State</span><span>Startup</span><span>Description</span><span>Actions</span></div>
      {services.map((service) => {
        const pendingKey = serviceKey(service);
        const pendingAction = pendingActions[pendingKey];
        const actionFeedback = actionFeedbacks[pendingKey];
        const actionDisabled = Boolean(pendingAction);

        return (
          <div className="service-entry" key={pendingKey}>
            <div className="service-row">
              <span className="service-name" title={`${service.scope}: ${service.name}`}>{serviceDisplayName(service)}</span>
              <strong className={`service-status ${statusClassName(service.activeState)}`}>{service.activeState} / {service.subState}</strong>
              <span className={`service-enabled ${enabledClassName(service.unitFileState)}`}>{service.unitFileState}</span>
              <small title={service.description}>{service.description}</small>
              <span className="service-actions">
                <button
                  type="button"
                  className={`container-action start ${pendingAction === 'start' ? 'pending' : ''}`}
                  title={`Start ${serviceDisplayName(service)}`}
                  disabled={actionDisabled || service.activeState === 'active'}
                  onClick={() => void onServiceAction(service, 'start')}
                >
                  {pendingAction === 'start' ? <RefreshCw size={14} className="spin-icon" /> : <Play size={14} />}
                </button>
                <button
                  type="button"
                  className={`container-action stop ${pendingAction === 'stop' ? 'pending' : ''}`}
                  title={`Stop ${serviceDisplayName(service)}`}
                  disabled={actionDisabled || (service.unitFileState !== 'init.d' && service.activeState !== 'active')}
                  onClick={() => void onServiceAction(service, 'stop')}
                >
                  {pendingAction === 'stop' ? <RefreshCw size={14} className="spin-icon" /> : <Square size={14} />}
                </button>
                <button
                  type="button"
                  className={`container-action restart ${pendingAction === 'restart' ? 'pending' : ''}`}
                  title={`Restart ${serviceDisplayName(service)}`}
                  disabled={actionDisabled || service.loadState === 'not-loaded'}
                  onClick={() => void onServiceAction(service, 'restart')}
                >
                  <RefreshCw size={14} className={pendingAction === 'restart' ? 'spin-icon' : undefined} />
                </button>
                <button
                  type="button"
                  className={`container-action enable ${pendingAction === 'enable' ? 'pending' : ''}`}
                  title={`Enable ${serviceDisplayName(service)}`}
                  disabled={actionDisabled || !canEnableService(service)}
                  onClick={() => void onServiceAction(service, 'enable')}
                >
                  {pendingAction === 'enable' ? <RefreshCw size={14} className="spin-icon" /> : <CheckCircle2 size={14} />}
                </button>
                <button
                  type="button"
                  className={`container-action disable ${pendingAction === 'disable' ? 'pending' : ''}`}
                  title={`Disable ${serviceDisplayName(service)}`}
                  disabled={actionDisabled || !canDisableService(service)}
                  onClick={() => void onServiceAction(service, 'disable')}
                >
                  {pendingAction === 'disable' ? <RefreshCw size={14} className="spin-icon" /> : <XCircle size={14} />}
                </button>
              </span>
            </div>
            {actionFeedback && (
              <div className={`service-action-feedback ${actionFeedback.tone}`} role="status" aria-live="polite">
                {actionFeedback.message}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SystemServicesHelpDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  return (
    <div className="service-help-modal-backdrop" onClick={onClose}>
      <section className="service-help-modal" role="dialog" aria-modal="true" aria-label="System services setup" onClick={(event) => event.stopPropagation()}>
        <div className="service-help-modal-heading">
          <div>
            <h3>System services setup</h3>
            <span>Grant only the exact service actions this dashboard should run.</span>
          </div>
          <button className="icon-command" type="button" onClick={onClose} title="Close">
            <XCircle size={16} />
          </button>
        </div>
        <pre>{SYSTEM_SERVICE_SUDOERS_SNIPPET}</pre>
        <div className="service-help-modal-actions">
          <button type="button" className="primary" onClick={onClose}>Done</button>
        </div>
      </section>
    </div>
  );
}

function canEnableService(service: SystemdServiceUnit): boolean {
  return service.name.endsWith('.service') && service.unitFileState === 'disabled';
}

function canDisableService(service: SystemdServiceUnit): boolean {
  return service.name.endsWith('.service') && service.unitFileState === 'enabled';
}

function serviceCacheKey(serverId: string): string {
  return `${serverId}:with-user`;
}

function serviceKey(service: Pick<SystemdServiceUnit, 'name' | 'scope'>): string {
  return `${service.scope}:${service.name}`;
}

function serviceDisplayName(service: Pick<SystemdServiceUnit, 'name' | 'scope'>): string {
  return `${service.scope === 'user' ? 'user:' : ''}${service.name}`;
}

function confirmServiceAction(service: SystemdServiceUnit, action: SystemdServiceAction): boolean {
  if (action === 'start' || action === 'enable') {
    return true;
  }

  return window.confirm(`${action[0].toUpperCase()}${action.slice(1)} ${serviceDisplayName(service)}?`);
}

function serviceActionPastTense(action: SystemdServiceAction): string {
  if (action === 'start') {
    return 'started';
  }

  if (action === 'stop') {
    return 'stopped';
  }

  if (action === 'restart') {
    return 'restarted';
  }

  if (action === 'enable') {
    return 'enabled';
  }

  return 'disabled';
}

const SYSTEM_SERVICE_SUDOERS_SNIPPET = `# Edit with:
# sudo visudo -f /etc/sudoers.d/homedashboard

# Replace dashboard-user and example.service.
dashboard-user ALL=(root) NOPASSWD: /usr/bin/systemctl start example.service
dashboard-user ALL=(root) NOPASSWD: /usr/bin/systemctl stop example.service
dashboard-user ALL=(root) NOPASSWD: /usr/bin/systemctl restart example.service`;

function statusClassName(activeState: string): string {
  if (activeState === 'active') {
    return 'running';
  }

  if (activeState === 'failed') {
    return 'failed';
  }

  if (activeState === 'activating' || activeState === 'deactivating') {
    return 'pending';
  }

  if (activeState === 'available') {
    return 'neutral';
  }

  return 'inactive';
}

function enabledClassName(unitFileState: string): string {
  if (unitFileState === 'enabled') {
    return 'enabled';
  }

  if (unitFileState === 'disabled') {
    return 'disabled';
  }

  return 'neutral';
}

import type React from 'react';
import { KeyRound, Save } from 'lucide-react';
import type { ServerFormState } from '../types';
import { SERVER_ICON_COLOR_OPTIONS, SERVER_ICON_OPTIONS, ServerIconGlyph } from './ServerIcon';

export function ServerForm({ form, setForm, busy, editing, onSubmit }: {
  form: ServerFormState;
  setForm: React.Dispatch<React.SetStateAction<ServerFormState>>;
  busy: boolean;
  editing: boolean;
  onSubmit: (event: React.FormEvent) => Promise<void>;
}) {
  const patch = (values: Partial<ServerFormState>) => setForm((current) => ({ ...current, ...values }));

  return (
    <form className="profile-form" onSubmit={(event) => void onSubmit(event)}>
      <label>Alias<input value={form.alias} onChange={(event) => patch({ alias: event.target.value })} required /></label>
      <label>Host<input value={form.host} onChange={(event) => patch({ host: event.target.value })} placeholder="192.168.1.50 or localhost" required /></label>
      <div className="split">
        <label>Port<input value={form.port} onChange={(event) => patch({ port: event.target.value })} inputMode="numeric" required /></label>
        <label>User<input value={form.username} onChange={(event) => patch({ username: event.target.value })} required /></label>
      </div>
      <div className="segmented" role="group" aria-label="Authentication method">
        <button type="button" className={form.authMethod === 'password' ? 'active' : ''} onClick={() => patch({ authMethod: 'password' })}><KeyRound size={15} /> Password</button>
        <button type="button" className={form.authMethod === 'privateKey' ? 'active' : ''} onClick={() => patch({ authMethod: 'privateKey' })}><KeyRound size={15} /> Key</button>
      </div>
      <fieldset className="icon-picker">
        <legend>Server icon</legend>
        <div className="icon-picker-grid">
          {SERVER_ICON_OPTIONS.map((option) => (
            <button
              key={option.id || 'auto'}
              type="button"
              className={form.serverIcon === option.id ? 'active' : ''}
              title={option.id ? option.label : 'Choose automatically from the profile name'}
              aria-label={option.id ? option.label : 'Auto'}
              onClick={() => patch({ serverIcon: option.id })}
            >
              <ServerIconGlyph iconId={option.id} />
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="icon-picker icon-color-picker">
        <legend>Icon color</legend>
        <div className="icon-color-grid">
          {SERVER_ICON_COLOR_OPTIONS.map((option) => (
            <button
              key={option.id || 'default'}
              type="button"
              className={form.serverIconColor === option.id ? 'active' : ''}
              title={option.label}
              aria-label={option.label}
              onClick={() => patch({ serverIconColor: option.id })}
            >
              <span className="icon-color-swatch" style={{ '--swatch-color': option.color } as React.CSSProperties} />
            </button>
          ))}
        </div>
      </fieldset>
      {form.authMethod === 'password' ? (
        <label>Password<input type="password" value={form.password} onChange={(event) => patch({ password: event.target.value })} placeholder={editing ? 'Leave blank to keep current password' : ''} /></label>
      ) : (
        <>
          <label>Key file name<input value={form.privateKeyName} onChange={(event) => patch({ privateKeyName: event.target.value })} placeholder="id_ed25519" /></label>
          <label>Private key<textarea value={form.privateKey} onChange={(event) => patch({ privateKey: event.target.value })} placeholder={editing ? 'Leave blank to reuse stored key' : ''} /></label>
        </>
      )}
      <button className="primary" disabled={busy}><Save size={16} /> Save</button>
    </form>
  );
}

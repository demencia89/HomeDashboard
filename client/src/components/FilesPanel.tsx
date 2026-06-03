import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Edit3, FileText, Folder, FolderPlus, RefreshCw, Save, Trash2, Upload } from 'lucide-react';
import type { FileItem, FileListResponse, ServerProfile } from '../types';
import { formatBytes, formatTime } from '../lib/format';
import { fileToBase64, joinPath, parentPath } from '../lib/paths';

export function FilesPanel({
  server,
  visible,
}: {
  server?: ServerProfile;
  visible: boolean;
}) {
  const [currentPath, setCurrentPath] = useState('.');
  const [items, setItems] = useState<FileItem[]>([]);
  const [selected, setSelected] = useState<FileItem | undefined>();
  const [editorPath, setEditorPath] = useState('');
  const [editorContent, setEditorContent] = useState('');
  const [loadedServerId, setLoadedServerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const uploadInput = useRef<HTMLInputElement | null>(null);

  const loadFiles = useCallback(async (pathValue = currentPath) => {
    if (!server) {
      return;
    }

    setBusy(true);
    setMessage('');

    try {
      const response = await fetch(`/api/servers/${server.id}/files?path=${encodeURIComponent(pathValue)}`);
      const body = await response.json();

      if (!response.ok) {
        throw new Error(body?.message ?? 'Unable to list files.');
      }

      const data = body as FileListResponse;
      setCurrentPath(data.path);
      setItems(data.items);
      setSelected(undefined);
      setLoadedServerId(server.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to list files.');
    } finally {
      setBusy(false);
    }
  }, [currentPath, server]);

  useEffect(() => {
    setCurrentPath('.');
    setItems([]);
    setSelected(undefined);
    setEditorPath('');
    setEditorContent('');
    setLoadedServerId('');
    setMessage('');
  }, [server?.id]);

  useEffect(() => {
    if (visible && server && loadedServerId !== server.id) {
      void loadFiles('.');
    }
  }, [loadFiles, loadedServerId, server, visible]);

  const openItem = (item: FileItem) => {
    const itemPath = joinPath(currentPath, item.name);

    if (item.type === 'directory') {
      void loadFiles(itemPath);
      return;
    }

    void readFile(itemPath);
  };

  const goUp = () => {
    void loadFiles(parentPath(currentPath));
  };

  const readFile = async (filePath: string) => {
    if (!server) {
      return;
    }

    setBusy(true);
    setMessage('');

    try {
      const response = await fetch(`/api/servers/${server.id}/files/read?path=${encodeURIComponent(filePath)}`);
      const body = await response.json();

      if (!response.ok) {
        throw new Error(body?.message ?? 'Unable to read file.');
      }

      setEditorPath(body.path);
      setEditorContent(body.content);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to read file.');
    } finally {
      setBusy(false);
    }
  };

  const saveEditor = async () => {
    if (!server || !editorPath) {
      return;
    }

    setBusy(true);
    setMessage('');

    try {
      const response = await fetch(`/api/servers/${server.id}/files/write`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: editorPath, content: editorContent }),
      });
      const body = await response.json();

      if (!response.ok) {
        throw new Error(body?.message ?? 'Unable to save file.');
      }

      setMessage('File saved.');
      await loadFiles(currentPath);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to save file.');
    } finally {
      setBusy(false);
    }
  };

  const createDirectory = async () => {
    if (!server) {
      return;
    }

    const name = window.prompt('Directory name');
    if (!name) {
      return;
    }

    await runFileAction(server.id, '/mkdir', { path: joinPath(currentPath, name) }, 'Directory created.', setMessage, setBusy);
    await loadFiles(currentPath);
  };

  const renameSelected = async () => {
    if (!server || !selected) {
      return;
    }

    const nextName = window.prompt('New name', selected.name);
    if (!nextName || nextName === selected.name) {
      return;
    }

    await runFileAction(server.id, '/rename', { from: joinPath(currentPath, selected.name), to: joinPath(currentPath, nextName) }, 'Item renamed.', setMessage, setBusy);
    await loadFiles(currentPath);
  };

  const deleteSelected = async () => {
    if (!server || !selected) {
      return;
    }

    const recursive = selected.type === 'directory';
    const confirmed = window.confirm(`Delete ${selected.name}${recursive ? ' and its contents' : ''}?`);

    if (!confirmed) {
      return;
    }

    setBusy(true);
    setMessage('');

    try {
      const response = await fetch(`/api/servers/${server.id}/files?path=${encodeURIComponent(joinPath(currentPath, selected.name))}&recursive=${recursive}`, {
        method: 'DELETE',
      });
      const body = await response.json();

      if (!response.ok) {
        throw new Error(body?.message ?? 'Unable to delete item.');
      }

      setMessage('Item deleted.');
      await loadFiles(currentPath);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to delete item.');
    } finally {
      setBusy(false);
    }
  };

  const downloadSelected = () => {
    if (!server || !selected || selected.type === 'directory') {
      return;
    }

    window.location.href = `/api/servers/${server.id}/files/download?path=${encodeURIComponent(joinPath(currentPath, selected.name))}`;
  };

  const uploadFile = async (file: File) => {
    if (!server) {
      return;
    }

    setBusy(true);
    setMessage('');

    try {
      const contentBase64 = await fileToBase64(file);
      const response = await fetch(`/api/servers/${server.id}/files/upload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: joinPath(currentPath, file.name), contentBase64 }),
      });
      const body = await response.json();

      if (!response.ok) {
        throw new Error(body?.message ?? 'Unable to upload file.');
      }

      setMessage('File uploaded.');
      await loadFiles(currentPath);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to upload file.');
    } finally {
      setBusy(false);
      if (uploadInput.current) {
        uploadInput.current.value = '';
      }
    }
  };

  if (!server) {
    return <div className="empty-state">No server selected.</div>;
  }

  return (
    <div className="files-panel">
      <div className="file-toolbar">
        <div className="refresh-controls">
          <button className="command" onClick={() => void loadFiles(currentPath)} disabled={busy}><RefreshCw size={16} /> Refresh</button>
        </div>
        <button className="command" onClick={goUp} disabled={busy}>Up</button>
        <button className="command" onClick={createDirectory} disabled={busy}><FolderPlus size={16} /> New Folder</button>
        <button className="command" onClick={() => uploadInput.current?.click()} disabled={busy}><Upload size={16} /> Upload</button>
        <input ref={uploadInput} className="hidden-input" type="file" onChange={(event) => event.target.files?.[0] && void uploadFile(event.target.files[0])} />
        <button className="command" onClick={downloadSelected} disabled={!selected || selected.type === 'directory'}><Download size={16} /> Download</button>
        <button className="command" onClick={renameSelected} disabled={!selected || busy}><Edit3 size={16} /> Rename</button>
        <button className="danger" onClick={deleteSelected} disabled={!selected || busy}><Trash2 size={16} /> Delete</button>
      </div>

      <div className="path-row">
        <input value={currentPath} onChange={(event) => setCurrentPath(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void loadFiles(currentPath)} />
        <button className="command" onClick={() => void loadFiles(currentPath)} disabled={busy}>Open</button>
      </div>

      {message && <p className="message">{message}</p>}

      <div className="files-layout">
        <div className="file-table">
          <div className="file-row header"><span>Name</span><span>Size</span><span>Mode</span><span>Modified</span></div>
          {items.length ? (
            items.map((item) => (
              <button
                key={`${item.name}-${item.modifyTime}`}
                className={selected?.name === item.name ? 'file-row active' : 'file-row'}
                onClick={() => setSelected(item)}
                onDoubleClick={() => openItem(item)}
              >
                <span className="file-name">{item.type === 'directory' ? <Folder size={16} /> : <FileText size={16} />}{item.name}</span>
                <span>{formatBytes(item.size)}</span>
                <span>{item.permissions}</span>
                <span>{formatTime(item.modifyTime)}</span>
              </button>
            ))
          ) : (
            <div className="empty-state table-empty">{busy ? 'Loading directory...' : 'Directory is empty.'}</div>
          )}
        </div>

        <div className="file-editor">
          <div className="editor-header">
            <strong>{editorPath || 'Text preview'}</strong>
            <button className="command" onClick={() => void saveEditor()} disabled={!editorPath || busy}><Save size={16} /> Save</button>
          </div>
          <textarea value={editorContent} onChange={(event) => setEditorContent(event.target.value)} placeholder="Double-click a file to edit text content." />
        </div>
      </div>
    </div>
  );
}

async function runFileAction(
  serverId: string,
  actionPath: '/mkdir' | '/rename',
  payload: Record<string, string>,
  successMessage: string,
  setMessage: (message: string) => void,
  setBusy: (busy: boolean) => void,
): Promise<void> {
  setBusy(true);
  setMessage('');

  try {
    const response = await fetch(`/api/servers/${serverId}/files${actionPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json();

    if (!response.ok) {
      throw new Error(body?.message ?? 'File operation failed.');
    }

    setMessage(successMessage);
  } catch (error) {
    setMessage(error instanceof Error ? error.message : 'File operation failed.');
  } finally {
    setBusy(false);
  }
}

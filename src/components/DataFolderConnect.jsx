import React, { useEffect, useState } from 'react';
import { FolderOpen, ShieldCheck, AlertTriangle, CheckCircle2 } from 'lucide-react';
import {
  isSupported, pickDataFolder, getSavedFolder, requestSavedPermission,
} from '../lib/dataFolder';
import { bootstrapDataFolder, readIndex } from '../lib/dataModel';
import KalshiConnect from './KalshiConnect';

export default function DataFolderConnect({ onFolderReady }) {
  const [state, setState] = useState('loading');
  const [folderName, setFolderName] = useState('');
  const [savedHandle, setSavedHandle] = useState(null);
  const [folderHandle, setFolderHandle] = useState(null);
  const [error, setError] = useState('');

  async function activate(handle) {
    const { season } = await bootstrapDataFolder(handle);
    const index = await readIndex(handle);
    setFolderHandle(handle);
    setFolderName(handle.name);
    setState('connected');
    onFolderReady?.({ handle, season, index });
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isSupported()) { if (!cancelled) setState('unsupported'); return; }
      const saved = await getSavedFolder();
      if (cancelled) return;
      if (saved?.needsPermission) {
        setSavedHandle(saved.handle);
        setFolderName(saved.handle.name);
        setState('saved');
      } else if (saved) {
        try { await activate(saved); }
        catch (e) { setError(e.message); setState('error'); }
      } else {
        setState('idle');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function handlePick() {
    try {
      setError('');
      const handle = await pickDataFolder();
      await activate(handle);
    } catch (e) {
      if (e.name === 'AbortError') return;
      setError(e.message || 'Could not open folder');
      setState('error');
    }
  }

  async function handleRestore() {
    try {
      setError('');
      const handle = await requestSavedPermission(savedHandle);
      if (!handle) { setError('Permission was not granted.'); return; }
      await activate(handle);
    } catch (e) {
      setError(e.message || 'Could not restore folder access');
    }
  }

  if (state === 'loading') return null;

  if (state === 'unsupported') {
    return <div className="dfc dfc-warn">
      <span className="dfc-icon warn"><AlertTriangle size={16} /></span>
      <div className="dfc-text">
        <b>Local data folder needs a compatible browser</b>
        <small>Saving prediction .txt files to your machine works in Chrome, Edge, and Opera.</small>
      </div>
    </div>;
  }

  const connected = state === 'connected';

  return <>
    <div className="dfc">
      <span className={`dfc-icon ${connected ? 'ok' : 'idle'}`}>
        {connected ? <CheckCircle2 size={16} /> : <ShieldCheck size={16} />}
      </span>
      <div className="dfc-text">
        <b>
          {connected && `Data folder connected: ${folderName}/`}
          {state === 'saved' && `Reconnect data folder: ${folderName}/`}
          {(state === 'idle' || state === 'error') && 'Connect your local data folder'}
        </b>
        <small>
          {connected
            ? 'Season and week structure ready · week1 active.'
            : state === 'saved'
            ? 'This browser needs you to confirm access again.'
            : 'Grant permission to store prediction .txt files and encrypted account credentials on this machine.'}
        </small>
        {error && <em className="dfc-error">{error}</em>}
      </div>
      {state === 'saved' ? (
        <button className="secondary-btn" onClick={handleRestore}>
          <FolderOpen size={15} /> Reconnect
        </button>
      ) : (
        <button className="secondary-btn" onClick={handlePick}>
          <FolderOpen size={15} /> {connected ? 'Change folder' : 'Choose folder'}
        </button>
      )}
    </div>
    <KalshiConnect dataFolderHandle={folderHandle}/>
  </>;
}
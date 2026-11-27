import React from 'react';
import { ShieldCheck, ShieldAlert } from 'lucide-react';

export default function PaperModeToggle({ enabled, onChange, disabled }) {
  return (
    <button
      className={`paper-toggle ${enabled ? 'on' : 'off'}`}
      onClick={() => onChange(!enabled)}
      disabled={disabled}
      title={enabled ? 'Paper mode is ON — no real orders' : 'Paper mode is OFF — recommendations hidden'}
    >
      {enabled ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />}
      <span>Paper mode {enabled ? 'ON' : 'OFF'}</span>
    </button>
  );
}
import { useEffect, useId, useRef, useState } from 'react';
import { Check, Save, Trash2, Wallet } from 'lucide-react';
import { LP_BTN_GHOST, LP_BTN_PRIMARY, LP_INPUT } from './styles';
import { issuesByField } from './policyDraft';
import { MAX_LP_SAFE_ADDRESSES, normalizeSafeAddress, safeAddressDirty, validateSafeAddress, type LpSettings, type LpSettingsPatch } from './positions';
import { shortAddress } from './format';
import type { PolicyFieldIssue } from './types';

export interface LpSafeAddressFieldProps {
  settings: LpSettings | null;
  loading: boolean;
  saving: boolean;
  saveError: string | null;
  issues: PolicyFieldIssue[];
  savedAt: number | null;
  disabled?: boolean;
  onSave: (patch: LpSettingsPatch) => Promise<boolean>;
  onSetActive: (address: string) => Promise<boolean>;
  onEdit: () => void;
}

export default function LpSafeAddressField({ settings, loading, saving, saveError, issues, savedAt, disabled = false, onSave, onSetActive, onEdit }: LpSafeAddressFieldProps) {
  const id = useId();
  const savedList = settings?.safeAddresses ?? [];
  const active = settings?.activeSafeAddress ?? settings?.safeAddress ?? null;
  const [value, setValue] = useState('');
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setValue(''); }, [savedList.join('|'), active]);
  const error = issuesByField(issues).safeAddress ?? issuesByField(issues).safeAddresses ?? null;
  const dirty = safeAddressDirty(value, null) && value.trim() !== '';
  const atCapacity = savedList.length >= MAX_LP_SAFE_ADDRESSES;

  return (
    <div className="px-4 py-3 border-b-2 border-oct-border bg-oct-surface-raised">
      <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-oct-text font-semibold inline-flex items-center gap-1.5 mb-2"><Wallet size={12} /> Safe addresses</span>
      {savedList.map((address) => (
        <div key={address} className="flex items-center gap-2 mb-2">
          <input type="radio" name={`${id}-active`} checked={address === active} onChange={() => void onSetActive(address)} />
          <span className="font-mono text-[11px]">{shortAddress(address)}</span>
          <button type="button" className={LP_BTN_GHOST} onClick={() => void onSave({ safeAddresses: savedList.filter((e) => e !== address), activeSafeAddress: active === address ? savedList.find((e) => e !== address) ?? null : active })}><Trash2 size={12} /></button>
        </div>
      ))}
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const msg = validateSafeAddress(value); if (msg) return; const n = normalizeSafeAddress(value).toLowerCase(); void onSave({ safeAddresses: savedList.includes(n) ? savedList : [...savedList, n].slice(0, MAX_LP_SAFE_ADDRESSES), activeSafeAddress: n }).then((ok) => { if (ok) { touched.current = false; setValue(''); } }); }}>
        <input id={id} value={value} disabled={disabled || loading || atCapacity} onChange={(e) => { touched.current = true; setValue(e.target.value); onEdit(); }} className={`${LP_INPUT} flex-1`} placeholder="0x…" />
        <button type="submit" disabled={disabled || saving || !dirty || atCapacity} className={LP_BTN_PRIMARY}><Save size={12} /> Save</button>
      </form>
      {error && <p className="mt-2 font-mono text-[11px] text-oct-flame">{error}</p>}
      {saveError && <p className="mt-2 font-mono text-[11px] text-oct-flame">{saveError}</p>}
      <p className="font-mono text-[11px] text-oct-muted mt-2">Up to {MAX_LP_SAFE_ADDRESSES} Safes. Active Safe drives the Positions tab.</p>
    </div>
  );
}

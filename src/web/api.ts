import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { InstrumentDetail, Snapshot } from '../server/engine';
import type { Settings } from '../core/settings';
import type { DateRange, ImportMode } from '../core/exportStore';
import type { CommitResult, ImportPreview, InboxFile } from '../server/importer';
import type { AccountsSnapshot } from '../server/accountsEngine';
import type { AccountsConfig } from '../core/accounts/analytics';

export type { Snapshot, InstrumentDetail, Settings, ImportPreview, CommitResult, InboxFile, AccountsSnapshot, AccountsConfig };

export interface Status {
  status: 'idle' | 'loading' | 'ready' | 'error';
  progress: string[];
  error?: string;
  generatedAt?: string;
  accountsGeneratedAt?: string;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export const api = {
  status: () => json<Status>('/api/status'),
  snapshot: () => json<Snapshot>('/api/snapshot'),
  instrument: (id: string) => json<InstrumentDetail>(`/api/instrument/${encodeURIComponent(id)}`),
  settings: () => json<{ settings: Settings; defaultExportsDir: string; demo: boolean }>('/api/settings'),
  setDemo: (enabled: boolean) => json<{ demo: boolean; settings: Settings }>('/api/demo', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }),
  saveSettings: (s: Partial<Settings>) => json<{ settings: Settings }>('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }),
  reload: (refreshMarket = false) => json<{ started: boolean }>('/api/reload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshMarket }) }),
  importPreview: (file: File) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return json<ImportPreview>('/api/import/preview', { method: 'POST', body: fd });
  },
  importInbox: (path: string) => post<ImportPreview>('/api/import/inbox', { path }),
  importReplan: (id: string, range: DateRange) => post<ImportPreview>('/api/import/replan', { id, range }),
  importCommit: (id: string, mode: ImportMode, range?: DateRange) => post<CommitResult>('/api/import/commit', { id, mode, range }),
  importCancel: (id: string) => post<{ ok: boolean }>('/api/import/cancel', { id }),
  accounts: () => json<AccountsSnapshot>('/api/accounts'),
  saveAccountsConfig: (c: AccountsConfig) => json<AccountsSnapshot>('/api/accounts/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c) }),
};

function post<T>(url: string, body: unknown): Promise<T> {
  return json<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** Polls the engine status; refreshes the snapshot whenever a new computation finishes. */
export function useStatus() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    refetchInterval: (query) => (query.state.data?.status === 'loading' || !query.state.data ? 700 : 5000),
  });
  const gen = q.data?.generatedAt;
  useEffect(() => {
    if (gen) {
      void qc.invalidateQueries({ queryKey: ['snapshot'] });
      void qc.invalidateQueries({ queryKey: ['instrument'] });
    }
  }, [gen, qc]);
  const accGen = q.data?.accountsGeneratedAt;
  useEffect(() => {
    if (accGen) void qc.invalidateQueries({ queryKey: ['accounts'] });
  }, [accGen, qc]);
  return q;
}

/** Accounts module snapshot (available before the investment computation finishes) */
export function useAccounts() {
  return useQuery({ queryKey: ['accounts'], queryFn: api.accounts, staleTime: Infinity, retry: false });
}

export function useSnapshot() {
  return useQuery({ queryKey: ['snapshot'], queryFn: api.snapshot, staleTime: Infinity, retry: false });
}

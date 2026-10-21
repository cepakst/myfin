import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { InstrumentDetail, Snapshot } from '../server/engine';
import type { Settings } from '../core/settings';

export type { Snapshot, InstrumentDetail, Settings };

export interface Status {
  status: 'idle' | 'loading' | 'ready' | 'error';
  progress: string[];
  error?: string;
  generatedAt?: string;
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
  settings: () => json<{ settings: Settings; defaultExportsDir: string }>('/api/settings'),
  saveSettings: (s: Partial<Settings>) => json<{ settings: Settings }>('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }),
  reload: (refreshMarket = false) => json<{ started: boolean }>('/api/reload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshMarket }) }),
  upload: (files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    return json<{ saved: { file: string; kind: string }[] }>('/api/upload', { method: 'POST', body: fd });
  },
};

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
  return q;
}

export function useSnapshot() {
  return useQuery({ queryKey: ['snapshot'], queryFn: api.snapshot, staleTime: Infinity, retry: false });
}

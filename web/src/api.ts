import type {
  ComparisonResult,
  HealthResponse,
  Machine,
  MachineSeries,
  Settings,
} from './types';

// In dev this is empty → relative '/api' uses the Vite proxy.
// In production (Netlify) set VITE_API_BASE_URL to the Render backend URL.
const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

async function get<T>(url: string): Promise<T> {
  const res = await fetch(`${BASE}${url}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.message ?? body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => get<HealthResponse>('/api/health'),
  machines: () => get<{ machines: Machine[] }>('/api/machines').then((r) => r.machines),
  comparison: (from: string, to: string) =>
    get<ComparisonResult>(`/api/comparison?from=${from}&to=${to}`),
  machineSeries: (serial: string, from: string, to: string) =>
    get<MachineSeries>(`/api/machines/${encodeURIComponent(serial)}/series?from=${from}&to=${to}`),
  settings: () => get<Settings>('/api/settings'),
  updateSettings: async (fuelArticleCodes: string[]): Promise<Settings> => {
    const res = await fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fuelArticleCodes }),
    });
    if (!res.ok) throw new Error(`Update failed (${res.status})`);
    return res.json();
  },
  triggerSync: async (): Promise<void> => {
    const res = await fetch(`${BASE}/api/sync`, { method: 'POST' });
    if (!res.ok && res.status !== 202) throw new Error(`Sync failed (${res.status})`);
  },
};

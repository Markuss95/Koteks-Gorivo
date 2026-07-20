import type {
  AuthUser,
  ComparisonResult,
  HealthResponse,
  Machine,
  MachineGroup,
  MachinePosition,
  MachineSeries,
  ManagedUser,
  Role,
  Settings,
  UtilizationResult,
  UtilizationSeries,
} from './types';

// In dev this is empty → relative '/api' uses the Vite proxy.
// In production (Netlify) set VITE_API_BASE_URL to the Render backend URL.
const BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

// ---- Token storage ----
const TOKEN_KEY = 'kg_token';
export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string): void => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = (): void => localStorage.removeItem(TOKEN_KEY);

// Called when a request comes back 401 (expired/invalid token) so the app can
// drop back to the login screen.
let onUnauthorized: (() => void) | null = null;
export const setOnUnauthorized = (cb: () => void): void => {
  onUnauthorized = cb;
};

function authHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    clearToken();
    onUnauthorized?.();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.message ?? body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

function get<T>(url: string): Promise<T> {
  return fetch(`${BASE}${url}`, { headers: authHeaders() }).then((r) => handle<T>(r));
}

function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  return fetch(`${BASE}${url}`, {
    method,
    headers: authHeaders(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then((r) => handle<T>(r));
}

export const api = {
  // ---- Auth ----
  login: async (username: string, password: string): Promise<AuthUser> => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Prijava nije uspjela (${res.status})`);
    }
    const data = (await res.json()) as { token: string; user: AuthUser };
    setToken(data.token);
    return data.user;
  },
  me: () => get<{ user: AuthUser }>('/api/auth/me').then((r) => r.user),
  logout: () => clearToken(),

  // ---- Users (admin) ----
  users: () => get<{ users: ManagedUser[] }>('/api/users').then((r) => r.users),
  createUser: (input: {
    username: string;
    password: string;
    role: Role;
    allowedGroups?: MachineGroup[];
  }) => send<{ user: ManagedUser }>('/api/users', 'POST', input).then((r) => r.user),
  updateUser: (
    id: number,
    patch: { username?: string; password?: string; role?: Role; allowedGroups?: MachineGroup[] },
  ) => send<{ user: ManagedUser }>(`/api/users/${id}`, 'PUT', patch).then((r) => r.user),
  deleteUser: (id: number) => send<{ ok: boolean }>(`/api/users/${id}`, 'DELETE'),

  // ---- App data ----
  health: () => get<HealthResponse>('/api/health'),
  machines: () => get<{ machines: Machine[] }>('/api/machines').then((r) => r.machines),
  machinePositions: (date: string) =>
    get<{ date: string; positions: MachinePosition[] }>(
      `/api/machines/positions?date=${date}`,
    ).then((r) => r.positions),
  comparison: (from: string, to: string) =>
    get<ComparisonResult>(`/api/comparison?from=${from}&to=${to}`),
  utilization: (from: string, to: string) =>
    get<UtilizationResult>(`/api/utilization?from=${from}&to=${to}`),
  utilizationSeries: (serial: string, from: string, to: string) =>
    get<UtilizationSeries>(
      `/api/utilization/${encodeURIComponent(serial)}/series?from=${from}&to=${to}`,
    ),
  machineSeries: (serial: string, from: string, to: string) =>
    get<MachineSeries>(`/api/machines/${encodeURIComponent(serial)}/series?from=${from}&to=${to}`),
  settings: () => get<Settings>('/api/settings'),
  updateSettings: (fuelArticleCodes: string[]) =>
    send<Settings>('/api/settings', 'PUT', { fuelArticleCodes }),
  triggerSync: () => send<{ started: boolean }>('/api/sync', 'POST'),

  // Mail a generated report. The file is built in the browser and posted as
  // base64; the recipient is fixed server-side, not chosen here.
  emailReport: (input: {
    filename: string;
    contentType: string;
    contentBase64: string;
    subject: string;
    body?: string;
    to?: string;
  }) => send<{ ok: boolean; to: string }>('/api/reports/email', 'POST', input),
};

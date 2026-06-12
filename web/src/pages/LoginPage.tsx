import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { AuthUser } from '../types';

export function LoginPage({ onLoggedIn }: { onLoggedIn: (user: AuthUser) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLoggedIn(await api.login(username.trim(), password));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="brand login-brand">
          KOTEKS <span>GORIVO</span>
        </div>
        <h1>Prijava</h1>
        {error && <div className="error-box">{error}</div>}
        <label className="field">
          <span>Korisničko ime</span>
          <input
            type="text"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label className="field">
          <span>Lozinka</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <button className="btn" type="submit" disabled={busy || !username || !password}>
          {busy ? 'Prijava…' : 'Prijavi se'}
        </button>
      </form>
    </div>
  );
}

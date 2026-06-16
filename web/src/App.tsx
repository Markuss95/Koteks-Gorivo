import { useEffect, useState } from 'react';
import { api, setOnUnauthorized, getToken, clearToken } from './api';
import type { AuthUser, HealthResponse } from './types';
import { ComparisonPage } from './pages/ComparisonPage';
import { MachinesPage } from './pages/MachinesPage';
import { SettingsPage } from './pages/SettingsPage';
import { UsersPage } from './pages/UsersPage';
import { LoginPage } from './pages/LoginPage';
import { UtilizationPage } from './pages/UtilizationPage';

type Tab = 'comparison' | 'utilization' | 'machines' | 'settings' | 'users';

export function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [tab, setTab] = useState<Tab>('comparison');
  const [health, setHealth] = useState<HealthResponse | null>(null);

  // Any 401 (expired/invalid token) drops us back to the login screen.
  useEffect(() => setOnUnauthorized(() => setUser(null)), []);

  // Validate an existing token on load.
  useEffect(() => {
    if (!getToken()) {
      setAuthChecking(false);
      return;
    }
    api
      .me()
      .then(setUser)
      .catch(() => {
        clearToken();
        setUser(null);
      })
      .finally(() => setAuthChecking(false));
  }, []);

  const loadHealth = () => api.health().then(setHealth).catch(() => setHealth(null));
  useEffect(() => {
    if (!user) {
      setHealth(null);
      return;
    }
    loadHealth();
    const t = setInterval(loadHealth, 30000);
    return () => clearInterval(t);
  }, [user]);

  const logout = () => {
    api.logout();
    setUser(null);
    setTab('comparison');
  };

  if (authChecking) {
    return (
      <div className="login-screen">
        <div className="spinner">Učitavanje…</div>
      </div>
    );
  }
  if (!user) {
    return <LoginPage onLoggedIn={setUser} />;
  }

  const isAdmin = user.role === 'admin';
  const activeTab: Tab = tab === 'users' && !isAdmin ? 'comparison' : tab;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          KOTEKS <span>STROJEVI</span>
        </div>
        <nav className="tabs">
          <button className={activeTab === 'comparison' ? 'active' : ''} onClick={() => setTab('comparison')}>
            Lidat vs Maris
          </button>
          <button className={activeTab === 'utilization' ? 'active' : ''} onClick={() => setTab('utilization')}>
            Iskorištenost
          </button>
          <button className={activeTab === 'machines' ? 'active' : ''} onClick={() => setTab('machines')}>
            Opće Informacije
          </button>
          <button className={activeTab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            Postavke
          </button>
          {isAdmin && (
            <button className={activeTab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>
              Korisnici
            </button>
          )}
        </nav>
        <div className="health">
          <span title={health?.maris.message ?? ''}>
            <span className={`dot ${health?.maris.ok ? 'ok' : 'bad'}`} />
            Maris
          </span>
          <span title={health?.lidat.message ?? ''}>
            <span className={`dot ${health?.lidat.ok ? 'ok' : 'bad'}`} />
            LiDAT
          </span>
          <span className="muted">
            {health ? `${health.db.readingCount.toLocaleString()} očitanja` : '…'}
          </span>
          <span className="user-box">
            <span className="muted" title={isAdmin ? 'Administrator' : 'Korisnik'}>
              {user.username}
              {isAdmin ? ' · admin' : ''}
            </span>
            <button className="btn secondary logout-btn" onClick={logout}>
              Odjava
            </button>
          </span>
        </div>
      </header>

      <main>
        {activeTab === 'comparison' && <ComparisonPage />}
        {activeTab === 'utilization' && <UtilizationPage />}
        {activeTab === 'machines' && (
          <MachinesPage health={health} onSyncDone={loadHealth} isAdmin={isAdmin} />
        )}
        {activeTab === 'settings' && <SettingsPage />}
        {activeTab === 'users' && isAdmin && <UsersPage currentUserId={user.id} />}
      </main>
    </div>
  );
}

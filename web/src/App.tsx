import { useEffect, useState } from 'react';
import { api } from './api';
import type { HealthResponse } from './types';
import { ComparisonPage } from './pages/ComparisonPage';
import { MachinesPage } from './pages/MachinesPage';
import { SettingsPage } from './pages/SettingsPage';

type Tab = 'comparison' | 'machines' | 'settings';

export function App() {
  const [tab, setTab] = useState<Tab>('comparison');
  const [health, setHealth] = useState<HealthResponse | null>(null);

  const loadHealth = () => api.health().then(setHealth).catch(() => setHealth(null));

  useEffect(() => {
    loadHealth();
    const t = setInterval(loadHealth, 30000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          KOTEKS <span>GORIVO</span>
        </div>
        <nav className="tabs">
          <button className={tab === 'comparison' ? 'active' : ''} onClick={() => setTab('comparison')}>
            Usporedba
          </button>
          <button className={tab === 'machines' ? 'active' : ''} onClick={() => setTab('machines')}>
            Strojevi
          </button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            Postavke
          </button>
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
        </div>
      </header>

      <main>
        {tab === 'comparison' && <ComparisonPage />}
        {tab === 'machines' && <MachinesPage health={health} onSyncDone={loadHealth} />}
        {tab === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}

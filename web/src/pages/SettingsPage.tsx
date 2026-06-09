import { useEffect, useState } from 'react';
import { api } from '../api';

export function SettingsPage() {
  const [codes, setCodes] = useState<string[]>([]);
  const [newCode, setNewCode] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .settings()
      .then((s) => setCodes(s.fuelArticleCodes))
      .catch((e) => setError(e.message));
  }, []);

  const addCode = () => {
    const c = newCode.trim();
    if (c && !codes.includes(c)) setCodes([...codes, c]);
    setNewCode('');
    setSaved(false);
  };

  const removeCode = (c: string) => {
    setCodes(codes.filter((x) => x !== c));
    setSaved(false);
  };

  const save = async () => {
    setError(null);
    try {
      const s = await api.updateSettings(codes);
      setCodes(s.fuelArticleCodes);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      {error && <div className="error-box">{error}</div>}

      <div className="panel" style={{ maxWidth: 640 }}>
        <h2>Šifre artikala goriva</h2>
        <p className="muted">
          Maris stavke s ovim šiframa artikla broje se kao potrošnja goriva. Zadano: <code>06010001</code>.
        </p>
        <div className="tags" style={{ margin: '12px 0' }}>
          {codes.map((c) => (
            <span className="tag" key={c}>
              {c}
              <button onClick={() => removeCode(c)} title="Ukloni">
                ×
              </button>
            </span>
          ))}
          {codes.length === 0 && <span className="muted">Nema šifri — dodajte barem jednu.</span>}
        </div>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <div className="field">
            <label>Nova šifra artikla</label>
            <input
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addCode()}
              placeholder="npr. 06010001"
            />
          </div>
          <button className="btn secondary" onClick={addCode}>
            Dodaj
          </button>
          <button className="btn" onClick={save} disabled={codes.length === 0}>
            Spremi
          </button>
          {saved && <span className="pos">Spremljeno ✓</span>}
        </div>
      </div>
    </>
  );
}

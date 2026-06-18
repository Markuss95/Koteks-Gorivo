import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { MachineGroup, ManagedUser, Role } from '../types';
import { GROUP_ORDER } from '../types';
import { fmtDateTime } from '../util';
import { GroupFilter } from '../components/GroupFilter';

export function UsersPage({ currentUserId }: { currentUserId: number }) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New-user form. New users see all groups by default.
  const [nu, setNu] = useState<{
    username: string;
    password: string;
    role: Role;
    allowedGroups: MachineGroup[];
  }>({
    username: '',
    password: '',
    role: 'user',
    allowedGroups: [...GROUP_ORDER],
  });
  const [creating, setCreating] = useState(false);

  // Per-row password reset.
  const [pwFor, setPwFor] = useState<number | null>(null);
  const [pwValue, setPwValue] = useState('');

  const load = () => {
    setLoading(true);
    api
      .users()
      .then(setUsers)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.createUser({
        username: nu.username.trim(),
        password: nu.password,
        role: nu.role,
        allowedGroups: nu.allowedGroups,
      });
      setNu({ username: '', password: '', role: 'user', allowedGroups: [...GROUP_ORDER] });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const changeRole = async (u: ManagedUser, role: Role) => {
    setError(null);
    try {
      await api.updateUser(u.id, { role });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const setUserGroups = async (u: ManagedUser, groups: MachineGroup[]) => {
    setError(null);
    try {
      await api.updateUser(u.id, { allowedGroups: groups });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const savePassword = async (id: number) => {
    setError(null);
    try {
      await api.updateUser(id, { password: pwValue });
      setPwFor(null);
      setPwValue('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (u: ManagedUser) => {
    if (!window.confirm(`Obrisati korisnika ${u.username}?`)) return;
    setError(null);
    try {
      await api.deleteUser(u.id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <>
      {error && <div className="error-box">{error}</div>}

      <div className="panel">
        <h2>Novi korisnik</h2>
        <form className="toolbar" onSubmit={create}>
          <div className="field">
            <label>Korisničko ime</label>
            <input
              type="text"
              value={nu.username}
              onChange={(e) => setNu({ ...nu, username: e.target.value })}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label>Lozinka (min. 6 znakova)</label>
            <input
              type="text"
              value={nu.password}
              onChange={(e) => setNu({ ...nu, password: e.target.value })}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label>Uloga</label>
            <select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value as Role })}>
              <option value="user">Korisnik</option>
              <option value="admin">Administrator</option>
            </select>
          </div>
          <div className="field">
            <label>Grupe (vidljive)</label>
            <GroupFilter
              value={new Set(nu.allowedGroups)}
              onChange={(next) => setNu({ ...nu, allowedGroups: [...next] })}
            />
          </div>
          <button
            className="btn"
            type="submit"
            disabled={creating || !nu.username.trim() || nu.password.length < 6}
          >
            {creating ? 'Dodavanje…' : 'Dodaj korisnika'}
          </button>
        </form>
      </div>

      <div className="panel">
        <h2>Korisnici ({users.length})</h2>
        {loading ? (
          <div className="spinner">Učitavanje…</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Korisničko ime</th>
                <th>Uloga</th>
                <th>Grupe</th>
                <th>Kreiran</th>
                <th>Radnje</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.username}</strong>
                    {u.id === currentUserId && <span className="pill" style={{ marginLeft: 8 }}>vi</span>}
                  </td>
                  <td>
                    <select
                      value={u.role}
                      onChange={(e) => changeRole(u, e.target.value as Role)}
                      disabled={u.id === currentUserId}
                      title={u.id === currentUserId ? 'Ne možete promijeniti vlastitu ulogu' : ''}
                    >
                      <option value="user">Korisnik</option>
                      <option value="admin">Administrator</option>
                    </select>
                  </td>
                  <td>
                    {u.role === 'admin' ? (
                      <span className="muted">Sve (administrator)</span>
                    ) : (
                      <GroupFilter
                        value={new Set(u.allowedGroups)}
                        onChange={(next) => setUserGroups(u, [...next])}
                      />
                    )}
                  </td>
                  <td className="muted">{fmtDateTime(u.createdAt)}</td>
                  <td>
                    {pwFor === u.id ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <input
                          type="text"
                          placeholder="Nova lozinka"
                          value={pwValue}
                          onChange={(e) => setPwValue(e.target.value)}
                          style={{ width: 150 }}
                        />
                        <button
                          className="btn"
                          style={{ padding: '6px 10px' }}
                          disabled={pwValue.length < 6}
                          onClick={() => savePassword(u.id)}
                        >
                          Spremi
                        </button>
                        <button
                          className="btn secondary"
                          style={{ padding: '6px 10px' }}
                          onClick={() => {
                            setPwFor(null);
                            setPwValue('');
                          }}
                        >
                          Odustani
                        </button>
                      </span>
                    ) : (
                      <span style={{ display: 'inline-flex', gap: 6 }}>
                        <button
                          className="btn secondary"
                          style={{ padding: '6px 10px' }}
                          onClick={() => {
                            setPwFor(u.id);
                            setPwValue('');
                          }}
                        >
                          Nova lozinka
                        </button>
                        <button
                          className="btn secondary neg-btn"
                          style={{ padding: '6px 10px' }}
                          disabled={u.id === currentUserId}
                          title={u.id === currentUserId ? 'Ne možete obrisati vlastiti račun' : ''}
                          onClick={() => remove(u)}
                        >
                          Obriši
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

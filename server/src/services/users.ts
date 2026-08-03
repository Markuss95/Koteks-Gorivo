import bcrypt from 'bcryptjs';
import { db } from '../db/index.js';
import { GROUP_KEYS, type MachineGroup } from './groups.js';

export type Role = 'user' | 'admin';

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  created_at: string;
  updated_at: string | null;
  allowed_groups: string | null;
}

export interface PublicUser {
  id: number;
  username: string;
  role: Role;
  allowedGroups: MachineGroup[];
  createdAt: string;
  updatedAt: string | null;
}

/**
 * Parse the stored allowed_groups JSON.
 *
 * An explicitly stored empty list means "no groups" and is returned as such —
 * the user then sees nothing and receives no monthly report. NULL is different:
 * it's a row predating the allowed_groups column, and defaults to all groups so
 * the migration doesn't lock anyone out.
 */
export function parseAllowedGroups(raw: string | null): MachineGroup[] {
  if (raw === null || raw === '') return [...GROUP_KEYS];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [...GROUP_KEYS];
    return arr.filter((g) => GROUP_KEYS.includes(g)) as MachineGroup[];
  } catch {
    return [...GROUP_KEYS];
  }
}

/** Normalise an incoming allowedGroups list. Empty stays empty — see above. */
function serializeGroups(groups?: MachineGroup[]): string {
  return JSON.stringify((groups ?? []).filter((g) => GROUP_KEYS.includes(g)));
}

/** The effective groups a user may see (admins always see all). */
export function userAllowedGroups(id: number, role: Role): MachineGroup[] {
  if (role === 'admin') return [...GROUP_KEYS];
  const row = getUserById(id);
  return parseAllowedGroups(row?.allowed_groups ?? null);
}

function toPublic(r: UserRow): PublicUser {
  return {
    id: r.id,
    username: r.username,
    role: r.role === 'admin' ? 'admin' : 'user',
    allowedGroups: parseAllowedGroups(r.allowed_groups),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

export function getUserByUsername(username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM user WHERE username = ?').get(username) as UserRow | undefined;
}

export function getUserById(id: number): UserRow | undefined {
  return db.prepare('SELECT * FROM user WHERE id = ?').get(id) as UserRow | undefined;
}

export function listUsers(): PublicUser[] {
  const rows = db.prepare('SELECT * FROM user ORDER BY username COLLATE NOCASE').all() as UserRow[];
  return rows.map(toPublic);
}

export function countUsers(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM user').get() as { c: number }).c;
}

export function countAdmins(excludeId?: number): number {
  const row = excludeId
    ? db.prepare("SELECT COUNT(*) AS c FROM user WHERE role = 'admin' AND id != ?").get(excludeId)
    : db.prepare("SELECT COUNT(*) AS c FROM user WHERE role = 'admin'").get();
  return (row as { c: number }).c;
}

/** Friendly duplicate-username detection across the unique (NOCASE) constraint. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

export function createUser(input: {
  username: string;
  password: string;
  role: Role;
  allowedGroups?: MachineGroup[];
}): PublicUser {
  const now = new Date().toISOString();
  try {
    const res = db
      .prepare(
        `INSERT INTO user (username, password_hash, role, created_at, allowed_groups)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.username.trim(),
        hashPassword(input.password),
        input.role,
        now,
        serializeGroups(input.allowedGroups),
      );
    return toPublic(getUserById(Number(res.lastInsertRowid))!);
  } catch (err) {
    if (isUniqueViolation(err)) throw new Error('Korisničko ime već postoji');
    throw err;
  }
}

export function updateUser(
  id: number,
  patch: { username?: string; role?: Role; password?: string; allowedGroups?: MachineGroup[] },
): PublicUser {
  const existing = getUserById(id);
  if (!existing) throw new Error('Korisnik nije pronađen');

  // Guard: never leave the system without an admin.
  if (patch.role === 'user' && existing.role === 'admin' && countAdmins(id) === 0) {
    throw new Error('Mora postojati barem jedan administrator');
  }

  const username = patch.username?.trim() || existing.username;
  const role = patch.role ?? (existing.role as Role);
  const passwordHash = patch.password ? hashPassword(patch.password) : existing.password_hash;
  const allowedGroups =
    patch.allowedGroups !== undefined ? serializeGroups(patch.allowedGroups) : existing.allowed_groups;

  try {
    db.prepare(
      `UPDATE user SET username = ?, role = ?, password_hash = ?, allowed_groups = ?, updated_at = ?
       WHERE id = ?`,
    ).run(username, role, passwordHash, allowedGroups, new Date().toISOString(), id);
  } catch (err) {
    if (isUniqueViolation(err)) throw new Error('Korisničko ime već postoji');
    throw err;
  }
  return toPublic(getUserById(id)!);
}

export function deleteUser(id: number): void {
  const existing = getUserById(id);
  if (!existing) throw new Error('Korisnik nije pronađen');
  if (existing.role === 'admin' && countAdmins(id) === 0) {
    throw new Error('Ne možete obrisati posljednjeg administratora');
  }
  db.prepare('DELETE FROM user WHERE id = ?').run(id);
}

/** Create the first admin from env on a fresh DB. No-op if any user exists. */
export function seedAdmin(username: string, password: string): PublicUser | null {
  if (!username || !password) return null;
  if (countUsers() > 0) return null;
  const user = createUser({ username, password, role: 'admin' });
  console.log(`[auth] seeded initial admin: ${user.username}`);
  return user;
}

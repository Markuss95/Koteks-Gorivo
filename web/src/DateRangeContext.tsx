import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { MachineGroup } from './types';
import { effectiveDateFloor, today } from './util';

/**
 * The date range is shared by every reporting page, so switching tabs keeps the
 * period you were looking at instead of resetting to the default.
 *
 * Each page still applies its own group-aware floor on top (Velički Kamen and
 * Kamen Psunj start later), which may clamp `from` upward — that clamp is
 * intentionally shared too, since a date with no data is no more valid on one
 * page than another.
 */
interface DateRange {
  from: string;
  to: string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
}

const DateRangeContext = createContext<DateRange | null>(null);

// Fallback floor until the backend reports the authoritative value.
const MIN_DATE_FALLBACK = '2026-05-27';

export function DateRangeProvider({
  allowedGroups,
  children,
}: {
  allowedGroups: MachineGroup[];
  children: ReactNode;
}) {
  // Start at the group-aware floor so the very first fetch already uses a valid
  // range for this user (a Velički/Psunj-only user must not start in June).
  const [from, setFrom] = useState(() =>
    effectiveDateFloor(MIN_DATE_FALLBACK, [
      allowedGroups.includes('osijek') ? 'osijek' : allowedGroups[0] ?? 'osijek',
    ]),
  );
  const [to, setTo] = useState(today());

  const value = useMemo(() => ({ from, to, setFrom, setTo }), [from, to]);
  return <DateRangeContext.Provider value={value}>{children}</DateRangeContext.Provider>;
}

export function useDateRange(): DateRange {
  const ctx = useContext(DateRangeContext);
  if (!ctx) throw new Error('useDateRange must be used inside a DateRangeProvider');
  return ctx;
}

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { MachineGroup } from './types';
import { effectiveDateFloor, today } from './util';

/**
 * The date range is shared by every reporting page, so switching tabs keeps the
 * period you were looking at instead of resetting to the default.
 *
 * Until the user picks a start date, each page opens on its own default (see
 * `useDateRange`); once they pick one, that choice is what every page shows.
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

interface SharedRange {
  floor: string;
  chosenFrom: string | null;
  setChosenFrom: (v: string) => void;
  to: string;
  setTo: (v: string) => void;
}

const DateRangeContext = createContext<SharedRange | null>(null);

// Fallback floor until the backend reports the authoritative value.
const MIN_DATE_FALLBACK = '2026-05-27';

export function DateRangeProvider({
  allowedGroups,
  children,
}: {
  allowedGroups: MachineGroup[];
  children: ReactNode;
}) {
  // The group-aware floor, so the very first fetch already uses a valid range
  // for this user (a Velički/Psunj-only user must not start in June).
  const [floor] = useState(() =>
    effectiveDateFloor(MIN_DATE_FALLBACK, [
      allowedGroups.includes('osijek') ? 'osijek' : allowedGroups[0] ?? 'osijek',
    ]),
  );
  // The start date the user picked; null until they pick one.
  const [chosenFrom, setChosenFrom] = useState<string | null>(null);
  const [to, setTo] = useState(today());

  const value = useMemo(
    () => ({ floor, chosenFrom, setChosenFrom, to, setTo }),
    [floor, chosenFrom, to],
  );
  return <DateRangeContext.Provider value={value}>{children}</DateRangeContext.Provider>;
}

/**
 * The shared range as one page sees it. `defaultFrom` is where this page opens
 * until the user picks a start date; without it, or before the floor, the page
 * opens on the oldest available date.
 */
export function useDateRange(defaultFrom?: string): DateRange {
  const ctx = useContext(DateRangeContext);
  if (!ctx) throw new Error('useDateRange must be used inside a DateRangeProvider');
  const pageDefault = defaultFrom && defaultFrom > ctx.floor ? defaultFrom : ctx.floor;
  return {
    from: ctx.chosenFrom ?? pageDefault,
    to: ctx.to,
    setFrom: ctx.setChosenFrom,
    setTo: ctx.setTo,
  };
}

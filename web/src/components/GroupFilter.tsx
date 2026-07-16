import { useId } from 'react';
import { GROUP_LABELS, GROUP_ORDER, type MachineGroup } from '../types';

/**
 * Worksite-group selector. `value` is the set of currently-shown groups and
 * `onChange` receives the next set.
 *
 * Two modes:
 * - default (checkboxes): any combination, at least one stays on. Used on the
 *   Korisnici page to grant a user several groups.
 * - `single` (radios): exactly one group at a time — the reporting pages, where
 *   mixing worksites in one report isn't meaningful.
 */
export function GroupFilter({
  value,
  onChange,
  options,
  single,
}: {
  value: Set<MachineGroup>;
  onChange: (next: Set<MachineGroup>) => void;
  // Which groups to offer (default all). Restricted users only see their own.
  options?: MachineGroup[];
  // Pick exactly one group instead of any combination.
  single?: boolean;
}) {
  // Radios must share a name to be mutually exclusive, unique per instance.
  const name = useId();
  const shown = options ? GROUP_ORDER.filter((g) => options.includes(g)) : GROUP_ORDER;
  // A single available group needs no selector.
  if (shown.length < 2) return null;

  const toggle = (g: MachineGroup) => {
    if (single) {
      onChange(new Set([g]));
      return;
    }
    const next = new Set(value);
    if (next.has(g)) {
      if (next.size === 1) return; // keep at least one group visible
      next.delete(g);
    } else {
      next.add(g);
    }
    onChange(next);
  };

  return (
    <div className="group-filter">
      {shown.map((g) => (
        <label key={g} className="group-filter__item">
          <input
            type={single ? 'radio' : 'checkbox'}
            name={single ? name : undefined}
            checked={value.has(g)}
            onChange={() => toggle(g)}
          />
          <span>{GROUP_LABELS[g]}</span>
        </label>
      ))}
    </div>
  );
}

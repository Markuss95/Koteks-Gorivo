import { GROUP_LABELS, GROUP_ORDER, type MachineGroup } from '../types';

/**
 * Worksite-group checkboxes. `value` is the set of currently-shown groups;
 * toggling a box calls `onChange` with the next set. At least one stays on.
 */
export function GroupFilter({
  value,
  onChange,
  options,
}: {
  value: Set<MachineGroup>;
  onChange: (next: Set<MachineGroup>) => void;
  // Which groups to offer (default all). Restricted users only see their own.
  options?: MachineGroup[];
}) {
  const shown = options ? GROUP_ORDER.filter((g) => options.includes(g)) : GROUP_ORDER;
  // A single available group needs no checkbox.
  if (shown.length < 2) return null;

  const toggle = (g: MachineGroup) => {
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
          <input type="checkbox" checked={value.has(g)} onChange={() => toggle(g)} />
          <span>{GROUP_LABELS[g]}</span>
        </label>
      ))}
    </div>
  );
}

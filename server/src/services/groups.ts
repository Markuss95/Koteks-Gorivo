// Machine groups (worksites), derived from a machine's Maris work orders (RNALOG).
// A machine belongs to exactly one group: if any of its RNALOGs is in the Velički
// or Psunj sets it goes there, otherwise it defaults to Osijek Koteks.
export type MachineGroup = 'osijek' | 'velicki' | 'psunj';

export const GROUP_KEYS: MachineGroup[] = ['osijek', 'velicki', 'psunj'];

/** Croatian worksite names, matching the labels shown in the web app. */
export const GROUP_LABELS: Record<MachineGroup, string> = {
  osijek: 'Osijek Koteks',
  velicki: 'Velički Kamen',
  psunj: 'Kamen Psunj',
};

const VELICKI_KAMEN = new Set([
  '4M/325', '4M/344', '4M/348', '4M/313', '4M/327', '4M/355', '4M/322', '4M/350',
  '4M/351', '4M/341', '4M/316', '4M/359', '4M/361', '4M/366', '4V/340', '4M/365', '4M/367',
]);

const KAMEN_PSUNJ = new Set([
  'M/801205', 'M/801206', 'M/801204', 'M/801207', 'M/801209', 'M/801210',
]);

export function machineGroup(rnalogs: string[]): MachineGroup {
  const norm = rnalogs.map((r) => r.trim());
  if (norm.some((r) => VELICKI_KAMEN.has(r))) return 'velicki';
  if (norm.some((r) => KAMEN_PSUNJ.has(r))) return 'psunj';
  return 'osijek';
}

// Client-side export of the reporting tables to PDF and Excel: the fuel
// comparison ("Detalji po stroju") and machine activity ("Iskorištenost po
// stroju"). Both libraries are lazy-imported so they only load when the user
// exports.
import type { ComparisonResult, Machine, MachineComparison, MachineUtilization } from './types';
import { daysSince, fmt, fmtDateTime, shortModel } from './util';

function fileStem(from: string, to: string, kind = 'gorivo'): string {
  return `koteks-${kind}_${from}_${to}`;
}

// "nepotpuno" avoids the č in "djelomično" purely for safety; both libs are
// Unicode-safe, but the plain word keeps every backend happy.
function labelWithPartial(model: string, serial: string, partial: boolean): string {
  const base = `${shortModel(model)} ${serial}`;
  return partial ? `${base} (nepotpuno)` : base;
}

function machineLabel(m: MachineComparison): string {
  return labelWithPartial(m.model, m.serialNumber, m.lidatPartial);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function totalsVariancePct(t: ComparisonResult['totals']): number | null {
  return t.lidatConsumedLitres > 0 ? (t.differenceLitres / t.lidatConsumedLitres) * 100 : null;
}

const COLUMNS = [
  'Stroj',
  'Radni nalog',
  'Maris izdano (L)',
  'LiDAT potrošeno (L)',
  'Razlika (L)',
  'Odstupanje (%)',
] as const;

// Activity columns optionally appended to the fuel report (Izvještaji page). The
// comparison page exports without them, so its layout is unchanged.
const ACTIVITY_EXTRA_COLUMNS = [
  'Radni sati',
  'Sati/dan',
  'Aktivni dani',
  'Sati u leru',
  'Udio lera (%)',
] as const;

/** Per-serial utilization, used to append the activity columns. */
export type ActivityBySerial = Map<string, MachineUtilization>;

// The five activity values for one machine, in ACTIVITY_EXTRA_COLUMNS order.
// Missing utilization (machine absent from the map) yields all-nulls.
function activityValues(a: MachineUtilization | undefined): Array<number | null> {
  return [
    a?.operatingHours ?? null,
    a?.hoursPerDay ?? null,
    a?.reportingDays || null,
    a?.idleHours ?? null,
    a?.idlePct ?? null,
  ];
}

// ---- Excel (SheetJS) ----
export async function exportComparisonExcel(
  rows: MachineComparison[],
  data: ComparisonResult,
  from: string,
  to: string,
  activity?: ActivityBySerial,
): Promise<void> {
  const XLSX = await import('xlsx');

  const columns = activity ? [...COLUMNS, ...ACTIVITY_EXTRA_COLUMNS] : [...COLUMNS];
  const header = [
    ['Koteks Gorivo — Usporedba potrošnje goriva'],
    [`Razdoblje: ${from} – ${to}`],
    [`Eurodizel (artikl): ${data.fuelArticleCodes.join(', ')}`],
    [`Generirano: ${new Date().toLocaleString('hr-HR')}`],
    [],
    columns,
  ];

  const dataRows = rows.map((m) => {
    const base: Array<string | number | null> = [
      machineLabel(m),
      m.rnalogs.join(', ') || '—',
      round1(m.marisIssuedLitres),
      m.lidatConsumedLitres === null ? null : round1(m.lidatConsumedLitres),
      m.differenceLitres === null ? null : round1(m.differenceLitres),
      m.variancePct === null ? null : round1(m.variancePct),
    ];
    if (!activity) return base;
    return [...base, ...activityValues(activity.get(m.serialNumber)).map(n1)];
  });

  const totalsPct = totalsVariancePct(data.totals);
  const footer = [
    [],
    [
      'UKUPNO',
      '',
      round1(data.totals.marisIssuedLitres),
      round1(data.totals.lidatConsumedLitres),
      round1(data.totals.differenceLitres),
      totalsPct === null ? null : round1(totalsPct),
    ],
  ];

  const aoa = [...header, ...dataRows, ...footer];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 24 },
    { wch: 20 },
    { wch: 16 },
    { wch: 18 },
    { wch: 14 },
    { wch: 16 },
    ...(activity
      ? [{ wch: 12 }, { wch: 10 }, { wch: 13 }, { wch: 12 }, { wch: 14 }]
      : []),
  ];

  // 1-decimal number format on the numeric columns (C onward, 0-based 2+). The
  // percentage columns get a % suffix and "Aktivni dani" stays a whole number.
  const pctCols = new Set(activity ? [5, 10] : [5]);
  const intCols = new Set(activity ? [8] : []);
  const lastCol = activity ? 10 : 5;
  const range = XLSX.utils.decode_range(ws['!ref']!);
  for (let r = 5; r <= range.e.r; r++) {
    for (let c = 2; c <= lastCol; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell || cell.t !== 'n') continue;
      cell.z = pctCols.has(c) ? '#,##0.0"%"' : intCols.has(c) ? '#,##0' : '#,##0.0';
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Detalji po stroju');
  XLSX.writeFile(wb, `${fileStem(from, to)}.xlsx`);
}

// ---- PDF (pdfmake) ----

// pdfmake + its bundled fonts, lazily loaded and shared by both PDF exports.
async function loadPdfMake(): Promise<any> {
  const pdfMake = (await import('pdfmake/build/pdfmake')).default ?? (await import('pdfmake/build/pdfmake'));
  const fontsMod: any = await import('pdfmake/build/vfs_fonts');
  // The bundled-fonts module shape varies across pdfmake versions — accept any.
  pdfMake.vfs =
    fontsMod.vfs ?? fontsMod.default?.vfs ?? fontsMod.pdfMake?.vfs ?? fontsMod.default?.pdfMake?.vfs;
  return pdfMake;
}

const headerCell = (text: string, right = false) => ({
  text,
  bold: true,
  color: '#ffffff',
  fillColor: '#1f2a33',
  alignment: right ? 'right' : 'left',
});

// Zebra striping + page counter, shared by both PDF documents.
const zebraLayout = {
  fillColor: (rowIndex: number) => (rowIndex > 0 && rowIndex % 2 === 0 ? '#f4f6f8' : null),
};

const pageFooter = (currentPage: number, pageCount: number) => ({
  text: `${currentPage} / ${pageCount}`,
  alignment: 'center',
  fontSize: 8,
  color: '#888888',
  margin: [0, 8, 0, 0],
});

export async function exportComparisonPdf(
  rows: MachineComparison[],
  data: ComparisonResult,
  from: string,
  to: string,
  activity?: ActivityBySerial,
): Promise<void> {
  const pdfMake = await loadPdfMake();

  const signed = (n: number, suffix = '') => `${n >= 0 ? '+' : ''}${fmt(n, 1)}${suffix}`;
  const cell = (v: number | null, digits = 1, suffix = '') =>
    ({ text: v === null ? '—' : `${fmt(v, digits)}${suffix}`, alignment: 'right' }) as const;

  // Shortened headers keep 11 columns readable on landscape A4.
  const activityHead = activity
    ? [
        headerCell('Radni sati', true),
        headerCell('Sati/dan', true),
        headerCell('Akt. dani', true),
        headerCell('Sati u leru', true),
        headerCell('Udio lera', true),
      ]
    : [];
  const activityRow = (serial: string) => {
    if (!activity) return [];
    const [hours, perDay, days, idle, idlePct] = activityValues(activity.get(serial));
    return [cell(hours), cell(perDay), cell(days, 0), cell(idle), cell(idlePct, 1, '%')];
  };

  const body = [
    [
      headerCell('Stroj'),
      headerCell('Radni nalog'),
      headerCell('Maris izdano (L)', true),
      headerCell('LiDAT potroš. (L)', true),
      headerCell('Razlika (L)', true),
      headerCell('Odstup. (%)', true),
      ...activityHead,
    ],
    ...rows.map((m) => [
      machineLabel(m),
      m.rnalogs.join(', ') || '—',
      { text: fmt(m.marisIssuedLitres, 1), alignment: 'right' },
      { text: m.lidatConsumedLitres === null ? '—' : fmt(m.lidatConsumedLitres, 1), alignment: 'right' },
      { text: m.differenceLitres === null ? '—' : signed(m.differenceLitres), alignment: 'right' },
      { text: m.variancePct === null ? '—' : signed(m.variancePct, '%'), alignment: 'right' },
      ...activityRow(m.serialNumber),
    ]),
  ];

  const totalsPct = totalsVariancePct(data.totals);
  const summary = {
    table: {
      widths: ['*', '*', '*', '*'],
      body: [
        [
          headerCell('Maris izdano'),
          headerCell('LiDAT potrošeno'),
          headerCell('Razlika'),
          headerCell('Odstupanje'),
        ],
        [
          `${fmt(data.totals.marisIssuedLitres, 1)} L`,
          `${fmt(data.totals.lidatConsumedLitres, 1)} L`,
          `${signed(data.totals.differenceLitres)} L`,
          totalsPct === null ? '—' : signed(totalsPct, '%'),
        ],
      ],
    },
    layout: 'lightHorizontalLines',
    margin: [0, 0, 0, 12] as [number, number, number, number],
  };

  const doc = {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [28, 36, 28, 40] as [number, number, number, number],
    // 11 columns need the smaller body text to fit landscape A4.
    defaultStyle: { fontSize: activity ? 8 : 9 },
    content: [
      { text: 'Koteks Gorivo — Usporedba potrošnje goriva', fontSize: 15, bold: true, margin: [0, 0, 0, 4] },
      {
        text: `Razdoblje: ${from} – ${to}     ·     Eurodizel (artikl): ${data.fuelArticleCodes.join(', ')}`,
        color: '#555555',
        margin: [0, 0, 0, 2],
      },
      { text: `Generirano: ${new Date().toLocaleString('hr-HR')}`, color: '#555555', margin: [0, 0, 0, 12] },
      summary,
      { text: 'Detalji po stroju', fontSize: 12, bold: true, margin: [0, 0, 0, 4] },
      {
        table: {
          headerRows: 1,
          widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto', ...(activity ? Array(5).fill('auto') : [])],
          body,
        },
        layout: zebraLayout,
      },
    ],
    footer: pageFooter,
  };

  pdfMake.createPdf(doc).download(`${fileStem(from, to)}.pdf`);
}

// ---- Machine activity ("Iskorištenost po stroju") ----

const ACTIVITY_COLUMNS = [
  'Stroj',
  'Zadnji kontakt',
  'Dana bez signala',
  'Zadnja poznata lokacija',
  'Mjesto',
] as const;

// Printed wherever place names appear — required by OpenStreetMap's licence.
const GEOCODE_ATTRIBUTION = 'Nazivi mjesta: © OpenStreetMap suradnici';

// Machines silent this long get their last known position printed — for a
// machine that reported this morning the location is just noise.
export const LOCATION_AFTER_DAYS = 20;

/** Machine records keyed by serial, for the last-known-location column. */
export type MachineBySerial = Map<string, Machine>;

/** Reverse-geocoded place names keyed by serial (see geocode.ts). */
export type PlaceBySerial = Map<string, string>;

// Coordinates of the last known position, or null when the machine is still
// reporting normally / has no position on file. Exported so the page knows which
// machines to reverse-geocode.
export function lastKnownPosition(
  m: MachineUtilization,
  machines: MachineBySerial | undefined,
): { lat: number; lon: number; time: string | null } | null {
  const days = daysSince(m.lastReadingTime);
  // null days = never reported; those count as silent.
  if (days !== null && days < LOCATION_AFTER_DAYS) return null;
  const rec = machines?.get(m.serialNumber);
  if (!rec || rec.latitude == null || rec.longitude == null) return null;
  return { lat: rec.latitude, lon: rec.longitude, time: rec.locationTime };
}

function positionText(p: { lat: number; lon: number } | null): string {
  return p ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : '—';
}

function activityLabel(m: MachineUtilization): string {
  return labelWithPartial(m.model, m.serialNumber, m.partial);
}

// Last LiDAT contact, as a local-time timestamp; machines that never reported
// read "Nikad", matching the Neaktivni strojevi page.
function lastContact(iso: string | null): string {
  return iso ? fmtDateTime(iso) : 'Nikad';
}

// Whole days since the last contact; null when the machine never reported, which
// renders as "—" (an unbounded gap isn't a number).
function daysWithoutSignal(iso: string | null): number | null {
  const d = daysSince(iso);
  return d === null ? null : Math.floor(d);
}

// One decimal, or null for "no data" so Excel leaves the cell empty rather than
// writing a misleading 0.
function n1(v: number | null): number | null {
  return v === null ? null : round1(v);
}

export async function exportUtilizationExcel(
  rows: MachineUtilization[],
  from: string,
  to: string,
  machines?: MachineBySerial,
  places?: PlaceBySerial,
): Promise<void> {
  const XLSX = await import('xlsx');

  const header = [
    ['Koteks Gorivo — Izvještaj o aktivnosti strojeva'],
    [`Razdoblje: ${from} – ${to}`],
    [`Generirano: ${new Date().toLocaleString('hr-HR')}`],
    [
      `Lokacija se prikazuje za strojeve bez signala ${LOCATION_AFTER_DAYS} dana ili dulje.` +
        `    ${GEOCODE_ATTRIBUTION}`,
    ],
    [],
    [...ACTIVITY_COLUMNS],
  ];

  const dataRows = rows.map((m) => {
    const pos = lastKnownPosition(m, machines);
    return [
      activityLabel(m),
      lastContact(m.lastReadingTime),
      daysWithoutSignal(m.lastReadingTime),
      positionText(pos),
      pos ? (places?.get(m.serialNumber) ?? '—') : '—',
    ];
  });

  const ws = XLSX.utils.aoa_to_sheet([...header, ...dataRows]);
  ws['!cols'] = [{ wch: 26 }, { wch: 18 }, { wch: 16 }, { wch: 22 }, { wch: 38 }];

  // "Dana bez signala" (col C, 0-based 2) is a whole number of days. Data starts
  // on row 6 (0-based), after the 4 title lines, the blank, and the header row.
  const range = XLSX.utils.decode_range(ws['!ref']!);
  for (let r = 6; r <= range.e.r; r++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c: 2 })];
    if (cell && cell.t === 'n') cell.z = '#,##0';
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Aktivnost strojeva');
  XLSX.writeFile(wb, `${fileStem(from, to, 'aktivnost')}.xlsx`);
}

export async function exportUtilizationPdf(
  rows: MachineUtilization[],
  from: string,
  to: string,
  machines?: MachineBySerial,
  places?: PlaceBySerial,
): Promise<void> {
  const pdfMake = await loadPdfMake();

  const body = [
    [
      headerCell('Stroj'),
      headerCell('Zadnji kontakt'),
      headerCell('Dana bez signala', true),
      headerCell('Zadnja poznata lokacija'),
      headerCell('Mjesto'),
    ],
    ...rows.map((m) => {
      const days = daysWithoutSignal(m.lastReadingTime);
      const pos = lastKnownPosition(m, machines);
      return [
        activityLabel(m),
        lastContact(m.lastReadingTime),
        { text: days === null ? '—' : fmt(days, 0), alignment: 'right' },
        // Coordinates link out to a map pin so the position is one click away.
        pos
          ? {
              text: positionText(pos),
              link: `https://www.openstreetmap.org/?mlat=${pos.lat}&mlon=${pos.lon}#map=15/${pos.lat}/${pos.lon}`,
              color: '#1a4f8a',
              decoration: 'underline',
            }
          : '—',
        pos ? (places?.get(m.serialNumber) ?? '—') : '—',
      ];
    }),
  ];

  const doc = {
    // Place names are long; landscape keeps them on one line.
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [28, 36, 28, 40] as [number, number, number, number],
    defaultStyle: { fontSize: 9 },
    content: [
      {
        text: 'Koteks Gorivo — Izvještaj o aktivnosti strojeva',
        fontSize: 15,
        bold: true,
        margin: [0, 0, 0, 4],
      },
      { text: `Razdoblje: ${from} – ${to}`, color: '#555555', margin: [0, 0, 0, 2] },
      { text: `Generirano: ${new Date().toLocaleString('hr-HR')}`, color: '#555555', margin: [0, 0, 0, 12] },
      {
        text: `Strojeva: ${rows.length}     ·     Sortirano po zadnjem kontaktu (najnoviji prvi)`,
        color: '#555555',
        margin: [0, 0, 0, 2],
      },
      {
        text:
          `Lokacija se prikazuje za strojeve bez signala ${LOCATION_AFTER_DAYS} dana ili dulje.` +
          `     ·     ${GEOCODE_ATTRIBUTION}`,
        color: '#555555',
        margin: [0, 0, 0, 12],
      },
      { text: 'Zadnji kontakt po stroju', fontSize: 12, bold: true, margin: [0, 0, 0, 4] },
      {
        table: { headerRows: 1, widths: ['auto', 'auto', 'auto', 'auto', '*'], body },
        layout: zebraLayout,
      },
    ],
    footer: pageFooter,
  };

  pdfMake.createPdf(doc).download(`${fileStem(from, to, 'aktivnost')}.pdf`);
}

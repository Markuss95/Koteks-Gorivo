// Client-side export of the reporting tables to PDF and Excel: the fuel
// comparison ("Detalji po stroju") and machine activity ("Iskorištenost po
// stroju"). Both libraries are lazy-imported so they only load when the user
// exports.
import type { ComparisonResult, Machine, MachineComparison, MachineUtilization } from './types';
import { daysSince, fmt, fmtDateTime, shortModel } from './util';

function fileStem(from: string, to: string, kind = 'gorivo'): string {
  return `koteks-${kind}_${from}_${to}`;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * What to do with a finished report: hand it to the browser as a download (the
 * button), or return the bytes so the caller can post it somewhere (e-mail).
 */
export type Delivery = 'download' | 'file';

export interface ReportFile {
  filename: string;
  contentType: string;
  blob: Blob;
}

// Every exporter ends here, so 'download' and 'file' can never drift apart —
// the e-mailed file is byte-identical to the downloaded one.
function finishWorkbook(
  XLSX: typeof import('xlsx'),
  wb: import('xlsx').WorkBook,
  filename: string,
  delivery: Delivery,
): ReportFile | null {
  if (delivery === 'download') {
    XLSX.writeFile(wb, filename);
    return null;
  }
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return { filename, contentType: XLSX_MIME, blob: new Blob([buf], { type: XLSX_MIME }) };
}

async function finishPdf(
  pdfMake: any,
  doc: unknown,
  filename: string,
  delivery: Delivery,
): Promise<ReportFile | null> {
  const built = pdfMake.createPdf(doc);
  if (delivery === 'download') {
    built.download(filename);
    return null;
  }
  const blob = await new Promise<Blob>((resolve) => built.getBlob(resolve));
  return { filename, contentType: 'application/pdf', blob };
}

function machineLabel(m: MachineComparison): string {
  return `${shortModel(m.model)} ${m.serialNumber}`;
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

// ---- Machines left out of the matched fuel report ----

const hasMaris = (m: MachineComparison) => m.marisIssuedLitres > 0;
const hasLidat = (m: MachineComparison) =>
  m.lidatConsumedLitres !== null && m.lidatConsumedLitres > 0;

const EXCLUDED_COLUMNS = [
  'Stroj',
  'Radni nalog',
  'Maris izdano (L)',
  'LiDAT potrošeno (L)',
  'Zadnji kontakt',
] as const;

/**
 * The machines the matched report leaves out, split by *why* they were left out.
 * Empty groups are dropped, so a report only shows the categories it actually has.
 */
export function groupExcluded(
  excluded: MachineComparison[],
): Array<{ title: string; note: string; rows: MachineComparison[] }> {
  const marisOnly = excluded.filter((m) => hasMaris(m) && !hasLidat(m));
  const lidatOnly = excluded.filter((m) => !hasMaris(m) && hasLidat(m));
  const neither = excluded.filter((m) => !hasMaris(m) && !hasLidat(m));

  return [
    {
      title: `Samo Maris izdanje — nema LiDAT potrošnje (${marisOnly.length})`,
      note: 'Gorivo je izdano iz skladišta, ali LiDAT nije zabilježio potrošnju — provjeriti javlja li se stroj.',
      rows: marisOnly,
    },
    {
      title: `Samo LiDAT potrošnja — nema Maris izdanja (${lidatOnly.length})`,
      note: 'Stroj je trošio gorivo, ali u razdoblju nema izdatnice — gorivo je vjerojatno izdano izvan razdoblja ili na drugi radni nalog.',
      rows: lidatOnly,
    },
    {
      title: `Bez Maris i LiDAT podataka (${neither.length})`,
      note: 'Nema ni izdatnice ni zabilježene potrošnje u razdoblju.',
      rows: neither,
    },
  ].filter((g) => g.rows.length > 0);
}

// The five info values for an excluded machine, in EXCLUDED_COLUMNS order.
function excludedValues(m: MachineComparison): Array<string | number | null> {
  return [
    machineLabel(m),
    m.rnalogs.join(', ') || '—',
    hasMaris(m) ? round1(m.marisIssuedLitres) : null,
    m.lidatConsumedLitres === null ? null : round1(m.lidatConsumedLitres),
    m.lastReadingTime ? fmtDateTime(m.lastReadingTime) : 'Nikad',
  ];
}

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
  excluded?: MachineComparison[],
  delivery: Delivery = 'download',
): Promise<ReportFile | null> {
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

  // Machines the matched report left out, appended below the totals and split by
  // which side is missing. Each group carries a one-line explanation.
  const groups = excluded?.length ? groupExcluded(excluded) : [];
  const excludedBlock: Array<Array<string | number | null>> = [];
  if (groups.length > 0) {
    excludedBlock.push([], [`STROJEVI BEZ OBA UNOSA (${excluded!.length})`]);
    for (const g of groups) {
      excludedBlock.push([], [g.title], [g.note], [...EXCLUDED_COLUMNS]);
      for (const m of g.rows) excludedBlock.push(excludedValues(m));
    }
  }

  const aoa = [...header, ...dataRows, ...footer, ...excludedBlock];
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
  return finishWorkbook(XLSX, wb, `${fileStem(from, to)}.xlsx`, delivery);
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
  excluded?: MachineComparison[],
  delivery: Delivery = 'download',
): Promise<ReportFile | null> {
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
      ...excludedSection(excluded),
    ],
    footer: pageFooter,
  };

  return finishPdf(pdfMake, doc, `${fileStem(from, to)}.pdf`, delivery);
}

// The "machines left out" appendix: one sub-table per reason, each preceded by a
// heading and a plain-language note. Returns [] when nothing was excluded.
function excludedSection(excluded: MachineComparison[] | undefined): any[] {
  const groups = excluded?.length ? groupExcluded(excluded) : [];
  if (groups.length === 0) return [];

  const content: any[] = [
    {
      text: `Strojevi bez oba unosa (${excluded!.length})`,
      fontSize: 12,
      bold: true,
      margin: [0, 18, 0, 2],
      pageBreak: 'before',
    },
    {
      text: 'Ovi strojevi nisu uključeni u usporedbu iznad jer im nedostaje jedna od dvije strane.',
      color: '#555555',
      margin: [0, 0, 0, 10],
    },
  ];

  for (const g of groups) {
    content.push(
      { text: g.title, fontSize: 10, bold: true, margin: [0, 8, 0, 2] },
      { text: g.note, color: '#555555', fontSize: 8, margin: [0, 0, 0, 4] },
      {
        table: {
          headerRows: 1,
          widths: ['*', 'auto', 'auto', 'auto', 'auto'],
          body: [
            [
              headerCell('Stroj'),
              headerCell('Radni nalog'),
              headerCell('Maris izdano (L)', true),
              headerCell('LiDAT potroš. (L)', true),
              headerCell('Zadnji kontakt'),
            ],
            ...g.rows.map((m) => [
              machineLabel(m),
              m.rnalogs.join(', ') || '—',
              { text: hasMaris(m) ? fmt(m.marisIssuedLitres, 1) : '—', alignment: 'right' },
              {
                text: m.lidatConsumedLitres === null ? '—' : fmt(m.lidatConsumedLitres, 1),
                alignment: 'right',
              },
              m.lastReadingTime ? fmtDateTime(m.lastReadingTime) : 'Nikad',
            ]),
          ],
        },
        layout: zebraLayout,
      },
    );
  }
  return content;
}

// ---- Machine activity ("Iskorištenost po stroju") ----

const ACTIVITY_COLUMNS = [
  'Stroj',
  'Zadnji kontakt',
  'Dana bez signala',
  'Zadnja poznata lokacija',
  'Mjesto',
] as const;

// OpenStreetMap's licence asks for attribution wherever place names are shown.
// Kept in the Excel export; removed from the PDF at the user's request.
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
  return `${shortModel(m.model)} ${m.serialNumber}`;
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
  delivery: Delivery = 'download',
): Promise<ReportFile | null> {
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
  return finishWorkbook(XLSX, wb, `${fileStem(from, to, 'aktivnost')}.xlsx`, delivery);
}

export async function exportUtilizationPdf(
  rows: MachineUtilization[],
  from: string,
  to: string,
  machines?: MachineBySerial,
  places?: PlaceBySerial,
  delivery: Delivery = 'download',
): Promise<ReportFile | null> {
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
        text: `Lokacija se prikazuje za strojeve bez signala ${LOCATION_AFTER_DAYS} dana ili dulje.`,
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

  return finishPdf(pdfMake, doc, `${fileStem(from, to, 'aktivnost')}.pdf`, delivery);
}

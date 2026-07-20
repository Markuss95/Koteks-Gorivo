// PDF (pdfmake) and Excel (SheetJS) layouts for both reports.
//
// Ported from the browser implementation so the scheduled monthly mail and the
// manual download come from one place. Layout changes belong here only.
import { createRequire } from 'node:module';
import * as XLSX from 'xlsx';
import type { MachineComparison, ComparisonResult } from '../comparison.js';
import type { MachineUtilization } from '../utilization.js';
import type { Machine } from '../machines.js';
import { groupExcluded, hasMaris, type FuelSelection } from './select.js';
import { daysSince, fileDate, fmt, fmtDateTime, fmtRange, round1, shortModel } from './format.js';

export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PDF_MIME = 'application/pdf';

// Machines silent this long get their last known position printed — for a
// machine that reported this morning the location is just noise.
export const LOCATION_AFTER_DAYS = 20;

export type MachineBySerial = Map<string, Machine>;
export type ActivityBySerial = Map<string, MachineUtilization>;
export type PlaceBySerial = Map<string, string>;

export function fileStem(from: string, to: string, kind = 'gorivo'): string {
  return `koteks-${kind}_${fileDate(from)}_${fileDate(to)}`;
}

function machineLabel(m: MachineComparison): string {
  return `${shortModel(m.model)} ${m.serialNumber}`;
}

function activityLabel(m: MachineUtilization): string {
  return `${shortModel(m.model)} ${m.serialNumber}`;
}

function lastContact(iso: string | null): string {
  return iso ? fmtDateTime(iso) : 'Nikad';
}

function daysWithoutSignal(iso: string | null): number | null {
  const d = daysSince(iso);
  return d === null ? null : Math.floor(d);
}

/** One decimal, or null so Excel leaves the cell empty rather than writing 0. */
function n1(v: number | null): number | null {
  return v === null ? null : round1(v);
}

export function lastKnownPosition(
  m: MachineUtilization,
  machines: MachineBySerial | undefined,
): { lat: number; lon: number } | null {
  const days = daysSince(m.lastReadingTime);
  // null days = never reported; those count as silent.
  if (days !== null && days < LOCATION_AFTER_DAYS) return null;
  const rec = machines?.get(m.serialNumber);
  if (!rec || rec.latitude == null || rec.longitude == null) return null;
  return { lat: rec.latitude, lon: rec.longitude };
}

function positionText(p: { lat: number; lon: number } | null): string {
  return p ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : '—';
}

// The five activity values for one machine, in ACTIVITY_EXTRA_COLUMNS order.
function activityValues(a: MachineUtilization | undefined): Array<number | null> {
  return [
    a?.operatingHours ?? null,
    a?.hoursPerDay ?? null,
    a?.reportingDays || null,
    a?.idleHours ?? null,
    a?.idlePct ?? null,
  ];
}

// ---- pdfmake setup ----

// Roboto ships with pdfmake as base64 in its vfs; feeding Buffers straight to
// PdfPrinter avoids needing .ttf files on disk. Roboto covers č/ć/š/ž/đ.
//
// Both pdfmake and its font bundle are CommonJS with no usable ESM types, so
// they're pulled in through createRequire (this package is "type": "module").
const require = createRequire(import.meta.url);

let printerCache: any = null;
function getPrinter(): any {
  if (printerCache) return printerCache;
  const PdfPrinter = require('pdfmake');
  const vfsMod: any = require('pdfmake/build/vfs_fonts.js');
  const vfs: Record<string, string> = vfsMod.vfs ?? vfsMod.pdfMake?.vfs ?? vfsMod;
  const buf = (name: string) => Buffer.from(vfs[name], 'base64');
  printerCache = new PdfPrinter({
    Roboto: {
      normal: buf('Roboto-Regular.ttf'),
      bold: buf('Roboto-Medium.ttf'),
      italics: buf('Roboto-Italic.ttf'),
      bolditalics: buf('Roboto-MediumItalic.ttf'),
    },
  });
  return printerCache;
}

function renderPdf(docDefinition: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = getPrinter().createPdfKitDocument(docDefinition);
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.end();
  });
}

const headerCell = (text: string, right = false) => ({
  text,
  bold: true,
  color: '#ffffff',
  fillColor: '#1f2a33',
  alignment: right ? 'right' : 'left',
});

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

function workbookToBuffer(wb: XLSX.WorkBook): Buffer {
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ---- Fuel report ----

const COLUMNS = [
  'Stroj',
  'Radni nalog',
  'Maris izdano (L)',
  'LiDAT potrošeno (L)',
  'Razlika (L)',
  'Odstupanje (%)',
] as const;

const ACTIVITY_EXTRA_COLUMNS = [
  'Radni sati',
  'Sati/dan',
  'Aktivni dani',
  'Sati u leru',
  'Udio lera (%)',
] as const;

const EXCLUDED_COLUMNS = [
  'Stroj',
  'Radni nalog',
  'Maris izdano (L)',
  'LiDAT potrošeno (L)',
  'Zadnji kontakt',
] as const;

export interface FuelReportInput {
  selection: FuelSelection;
  fuelArticleCodes: string[];
  from: string;
  to: string;
  activity: ActivityBySerial;
}

export function buildFuelExcel(input: FuelReportInput): Buffer {
  const { selection, fuelArticleCodes, from, to, activity } = input;
  const { rows, excluded, totals, variancePct } = selection;

  const header = [
    ['Koteks Gorivo — Usporedba potrošnje goriva'],
    [`Razdoblje: ${fmtRange(from, to)}`],
    [`Eurodizel (artikl): ${fuelArticleCodes.join(', ')}`],
    [`Generirano: ${new Date().toLocaleString('hr-HR')}`],
    [],
    [...COLUMNS, ...ACTIVITY_EXTRA_COLUMNS],
  ];

  const dataRows = rows.map((m) => [
    machineLabel(m),
    m.rnalogs.join(', ') || '—',
    round1(m.marisIssuedLitres),
    m.lidatConsumedLitres === null ? null : round1(m.lidatConsumedLitres),
    m.differenceLitres === null ? null : round1(m.differenceLitres),
    m.variancePct === null ? null : round1(m.variancePct),
    ...activityValues(activity.get(m.serialNumber)).map(n1),
  ]);

  const footer = [
    [],
    [
      'UKUPNO',
      '',
      round1(totals.marisIssuedLitres),
      round1(totals.lidatConsumedLitres),
      round1(totals.differenceLitres),
      variancePct === null ? null : round1(variancePct),
    ],
  ];

  const groups = groupExcluded(excluded);
  const excludedBlock: Array<Array<string | number | null>> = [];
  if (groups.length > 0) {
    excludedBlock.push([], [`STROJEVI BEZ OBA UNOSA (${excluded.length})`]);
    for (const g of groups) {
      excludedBlock.push([], [g.title], [g.note], [...EXCLUDED_COLUMNS]);
      for (const m of g.rows) {
        excludedBlock.push([
          machineLabel(m),
          m.rnalogs.join(', ') || '—',
          hasMaris(m) ? round1(m.marisIssuedLitres) : null,
          m.lidatConsumedLitres === null ? null : round1(m.lidatConsumedLitres),
          m.lastReadingTime ? fmtDateTime(m.lastReadingTime) : 'Nikad',
        ]);
      }
    }
  }

  const ws = XLSX.utils.aoa_to_sheet([...header, ...dataRows, ...footer, ...excludedBlock]);
  ws['!cols'] = [
    { wch: 24 }, { wch: 20 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 16 },
    { wch: 12 }, { wch: 10 }, { wch: 13 }, { wch: 12 }, { wch: 14 },
  ];

  // Numeric formats from column C onward; percentages get a % suffix and
  // "Aktivni dani" stays whole.
  const pctCols = new Set([5, 10]);
  const intCols = new Set([8]);
  const range = XLSX.utils.decode_range(ws['!ref']!);
  for (let r = 5; r <= range.e.r; r++) {
    for (let c = 2; c <= 10; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell || cell.t !== 'n') continue;
      cell.z = pctCols.has(c) ? '#,##0.0"%"' : intCols.has(c) ? '#,##0' : '#,##0.0';
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Detalji po stroju');
  return workbookToBuffer(wb);
}

export function buildFuelPdf(input: FuelReportInput): Promise<Buffer> {
  const { selection, fuelArticleCodes, from, to, activity } = input;
  const { rows, excluded, totals, variancePct } = selection;

  const signed = (n: number, suffix = '') => `${n >= 0 ? '+' : ''}${fmt(n, 1)}${suffix}`;
  const cell = (v: number | null, digits = 1, suffix = '') => ({
    text: v === null ? '—' : `${fmt(v, digits)}${suffix}`,
    alignment: 'right',
  });

  const body = [
    [
      headerCell('Stroj'),
      headerCell('Radni nalog'),
      headerCell('Maris izdano (L)', true),
      headerCell('LiDAT potroš. (L)', true),
      headerCell('Razlika (L)', true),
      headerCell('Odstup. (%)', true),
      headerCell('Radni sati', true),
      headerCell('Sati/dan', true),
      headerCell('Akt. dani', true),
      headerCell('Sati u leru', true),
      headerCell('Udio lera', true),
    ],
    ...rows.map((m) => {
      const [hours, perDay, days, idle, idlePct] = activityValues(activity.get(m.serialNumber));
      return [
        machineLabel(m),
        m.rnalogs.join(', ') || '—',
        { text: fmt(m.marisIssuedLitres, 1), alignment: 'right' },
        { text: m.lidatConsumedLitres === null ? '—' : fmt(m.lidatConsumedLitres, 1), alignment: 'right' },
        { text: m.differenceLitres === null ? '—' : signed(m.differenceLitres), alignment: 'right' },
        { text: m.variancePct === null ? '—' : signed(m.variancePct, '%'), alignment: 'right' },
        cell(hours), cell(perDay), cell(days, 0), cell(idle), cell(idlePct, 1, '%'),
      ];
    }),
  ];

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
          `${fmt(totals.marisIssuedLitres, 1)} L`,
          `${fmt(totals.lidatConsumedLitres, 1)} L`,
          `${signed(totals.differenceLitres)} L`,
          variancePct === null ? '—' : signed(variancePct, '%'),
        ],
      ],
    },
    layout: 'lightHorizontalLines',
    margin: [0, 0, 0, 12],
  };

  const content: any[] = [
    { text: 'Koteks Gorivo — Usporedba potrošnje goriva', fontSize: 15, bold: true, margin: [0, 0, 0, 4] },
    {
      text: `Razdoblje: ${fmtRange(from, to)}     ·     Eurodizel (artikl): ${fuelArticleCodes.join(', ')}`,
      color: '#555555',
      margin: [0, 0, 0, 2],
    },
    { text: `Generirano: ${new Date().toLocaleString('hr-HR')}`, color: '#555555', margin: [0, 0, 0, 12] },
    summary,
    { text: 'Detalji po stroju', fontSize: 12, bold: true, margin: [0, 0, 0, 4] },
    {
      table: { headerRows: 1, widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'], body },
      layout: zebraLayout,
    },
  ];

  const groups = groupExcluded(excluded);
  if (groups.length > 0) {
    content.push(
      {
        text: `Strojevi bez oba unosa (${excluded.length})`,
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
    );
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
                { text: m.lidatConsumedLitres === null ? '—' : fmt(m.lidatConsumedLitres, 1), alignment: 'right' },
                m.lastReadingTime ? fmtDateTime(m.lastReadingTime) : 'Nikad',
              ]),
            ],
          },
          layout: zebraLayout,
        },
      );
    }
  }

  return renderPdf({
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [28, 36, 28, 40],
    defaultStyle: { fontSize: 8 },
    content,
    footer: pageFooter,
  });
}

// ---- Activity report ----

const ACTIVITY_COLUMNS = [
  'Stroj',
  'Zadnji kontakt',
  'Dana bez signala',
  'Zadnja poznata lokacija',
  'Mjesto',
] as const;

export interface ActivityReportInput {
  rows: MachineUtilization[];
  from: string;
  to: string;
  machines: MachineBySerial;
  places: PlaceBySerial;
}

export function buildActivityExcel(input: ActivityReportInput): Buffer {
  const { rows, from, to, machines, places } = input;

  const header = [
    ['Koteks Gorivo — Izvještaj o aktivnosti strojeva'],
    [`Razdoblje: ${fmtRange(from, to)}`],
    [`Generirano: ${new Date().toLocaleString('hr-HR')}`],
    [
      `Lokacija se prikazuje za strojeve bez signala ${LOCATION_AFTER_DAYS} dana ili dulje.` +
        '    Nazivi mjesta: © OpenStreetMap suradnici',
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
      pos ? (places.get(m.serialNumber) ?? '—') : '—',
    ];
  });

  const ws = XLSX.utils.aoa_to_sheet([...header, ...dataRows]);
  ws['!cols'] = [{ wch: 26 }, { wch: 18 }, { wch: 16 }, { wch: 22 }, { wch: 38 }];

  // "Dana bez signala" is a whole number; data starts on row 6 (0-based).
  const range = XLSX.utils.decode_range(ws['!ref']!);
  for (let r = 6; r <= range.e.r; r++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c: 2 })];
    if (cell && cell.t === 'n') cell.z = '#,##0';
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Aktivnost strojeva');
  return workbookToBuffer(wb);
}

export function buildActivityPdf(input: ActivityReportInput): Promise<Buffer> {
  const { rows, from, to, machines, places } = input;

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
        pos
          ? {
              text: positionText(pos),
              link: `https://www.openstreetmap.org/?mlat=${pos.lat}&mlon=${pos.lon}#map=15/${pos.lat}/${pos.lon}`,
              color: '#1a4f8a',
              decoration: 'underline',
            }
          : '—',
        pos ? (places.get(m.serialNumber) ?? '—') : '—',
      ];
    }),
  ];

  return renderPdf({
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [28, 36, 28, 40],
    defaultStyle: { fontSize: 9 },
    content: [
      { text: 'Koteks Gorivo — Izvještaj o aktivnosti strojeva', fontSize: 15, bold: true, margin: [0, 0, 0, 4] },
      { text: `Razdoblje: ${fmtRange(from, to)}`, color: '#555555', margin: [0, 0, 0, 2] },
      { text: `Generirano: ${new Date().toLocaleString('hr-HR')}`, color: '#555555', margin: [0, 0, 0, 2] },
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
      { table: { headerRows: 1, widths: ['auto', 'auto', 'auto', 'auto', '*'], body }, layout: zebraLayout },
    ],
    footer: pageFooter,
  });
}

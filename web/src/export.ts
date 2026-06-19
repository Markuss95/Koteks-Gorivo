// Client-side export of the "Detalji po stroju" comparison table to PDF and Excel.
// Both libraries are lazy-imported so they only load when the user exports.
import type { ComparisonResult, MachineComparison } from './types';
import { fmt, shortModel } from './util';

function fileStem(from: string, to: string): string {
  return `koteks-gorivo_${from}_${to}`;
}

function machineLabel(m: MachineComparison): string {
  const base = `${shortModel(m.model)} ${m.serialNumber}`;
  // "nepotpuno" avoids the č in "djelomično" purely for safety; both libs are
  // Unicode-safe, but the plain word keeps every backend happy.
  return m.lidatPartial ? `${base} (nepotpuno)` : base;
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

// ---- Excel (SheetJS) ----
export async function exportComparisonExcel(
  rows: MachineComparison[],
  data: ComparisonResult,
  from: string,
  to: string,
): Promise<void> {
  const XLSX = await import('xlsx');

  const header = [
    ['Koteks Gorivo — Usporedba potrošnje goriva'],
    [`Razdoblje: ${from} – ${to}`],
    [`Eurodizel (artikl): ${data.fuelArticleCodes.join(', ')}`],
    [`Generirano: ${new Date().toLocaleString('hr-HR')}`],
    [],
    [...COLUMNS],
  ];

  const dataRows = rows.map((m) => [
    machineLabel(m),
    m.rnalogs.join(', ') || '—',
    round1(m.marisIssuedLitres),
    m.lidatConsumedLitres === null ? null : round1(m.lidatConsumedLitres),
    m.differenceLitres === null ? null : round1(m.differenceLitres),
    m.variancePct === null ? null : round1(m.variancePct),
  ]);

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
  ws['!cols'] = [{ wch: 24 }, { wch: 20 }, { wch: 16 }, { wch: 18 }, { wch: 14 }, { wch: 16 }];

  // Apply a 1-decimal number format to the numeric columns (cols C–F, 0-based 2–5).
  const range = XLSX.utils.decode_range(ws['!ref']!);
  for (let r = 5; r <= range.e.r; r++) {
    for (let c = 2; c <= 5; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && cell.t === 'n') cell.z = c === 5 ? '#,##0.0"%"' : '#,##0.0';
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Detalji po stroju');
  XLSX.writeFile(wb, `${fileStem(from, to)}.xlsx`);
}

// ---- PDF (pdfmake) ----
export async function exportComparisonPdf(
  rows: MachineComparison[],
  data: ComparisonResult,
  from: string,
  to: string,
): Promise<void> {
  const pdfMake = (await import('pdfmake/build/pdfmake')).default ?? (await import('pdfmake/build/pdfmake'));
  const fontsMod: any = await import('pdfmake/build/vfs_fonts');
  // The bundled-fonts module shape varies across pdfmake versions — accept any.
  pdfMake.vfs =
    fontsMod.vfs ?? fontsMod.default?.vfs ?? fontsMod.pdfMake?.vfs ?? fontsMod.default?.pdfMake?.vfs;

  const signed = (n: number, suffix = '') => `${n >= 0 ? '+' : ''}${fmt(n, 1)}${suffix}`;
  const headerCell = (text: string, right = false) => ({
    text,
    bold: true,
    color: '#ffffff',
    fillColor: '#1f2a33',
    alignment: right ? 'right' : 'left',
  });

  const body = [
    [
      headerCell('Stroj'),
      headerCell('Radni nalog'),
      headerCell('Maris izdano (L)', true),
      headerCell('LiDAT potroš. (L)', true),
      headerCell('Razlika (L)', true),
      headerCell('Odstup. (%)', true),
    ],
    ...rows.map((m) => [
      machineLabel(m),
      m.rnalogs.join(', ') || '—',
      { text: fmt(m.marisIssuedLitres, 1), alignment: 'right' },
      { text: m.lidatConsumedLitres === null ? '—' : fmt(m.lidatConsumedLitres, 1), alignment: 'right' },
      { text: m.differenceLitres === null ? '—' : signed(m.differenceLitres), alignment: 'right' },
      { text: m.variancePct === null ? '—' : signed(m.variancePct, '%'), alignment: 'right' },
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
    defaultStyle: { fontSize: 9 },
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
        table: { headerRows: 1, widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto'], body },
        layout: {
          fillColor: (rowIndex: number) => (rowIndex > 0 && rowIndex % 2 === 0 ? '#f4f6f8' : null),
        },
      },
    ],
    footer: (currentPage: number, pageCount: number) => ({
      text: `${currentPage} / ${pageCount}`,
      alignment: 'center',
      fontSize: 8,
      color: '#888888',
      margin: [0, 8, 0, 0],
    }),
  };

  pdfMake.createPdf(doc).download(`${fileStem(from, to)}.pdf`);
}

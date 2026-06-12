import DatePicker, { registerLocale } from 'react-datepicker';
import { hr } from 'date-fns/locale';
import 'react-datepicker/dist/react-datepicker.css';

// Croatian calendar + month/day names and dd.MM.yyyy. formatting.
registerLocale('hr', hr);

// App dates are ISO 'YYYY-MM-DD' strings. Convert to/from a *local* Date so the
// calendar day never shifts due to UTC parsing.
function parseISO(s: string | undefined): Date | null {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
function toISO(d: Date | null): string {
  if (!d) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function DateField({
  value,
  onChange,
  min,
  max,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  id?: string;
}) {
  return (
    <DatePicker
      id={id}
      locale="hr"
      dateFormat="dd.MM.yyyy."
      selected={parseISO(value)}
      onChange={(d) => {
        if (d) onChange(toISO(d));
      }}
      minDate={parseISO(min) ?? undefined}
      maxDate={parseISO(max) ?? undefined}
      className="date-input"
      popperClassName="dp-popper"
      showPopperArrow={false}
    />
  );
}

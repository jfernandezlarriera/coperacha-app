// Timezone helpers. Deadlines are stored as UTC ISO strings and entered/shown in
// America/Mexico_City (or APP_TIMEZONE).

const DEFAULT_TZ = 'America/Mexico_City';

function partsInZone(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  return map;
}

function offsetMs(date, tz) {
  const p = partsInZone(date, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// "2026-12-01T18:00" (local wall time in tz) -> Date in UTC.
export function zonedToUtc(localString, tz = DEFAULT_TZ) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(localString || '')) return null;
  const guess = new Date(localString + (localString.length === 16 ? ':00' : '') + 'Z');
  if (Number.isNaN(guess.getTime())) return null;
  let utc = new Date(guess.getTime() - offsetMs(guess, tz));
  const off2 = offsetMs(utc, tz);
  if (off2 !== offsetMs(guess, tz)) utc = new Date(guess.getTime() - off2);
  return utc;
}

// Date -> "2026-12-01T18:00" for <input type="datetime-local">.
export function utcToZonedInput(date, tz = DEFAULT_TZ) {
  const p = partsInZone(new Date(date), tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// Human format in Spanish, e.g. "1 dic 2026, 18:00".
export function formatZoned(date, tz = DEFAULT_TZ) {
  const d = new Date(date);
  const p = partsInZone(d, tz);
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${+p.day} ${months[+p.month - 1]} ${p.year}, ${p.hour}:${p.minute}`;
}

// Amounts are integer centavos (MXN) everywhere in the domain.

export function parsePesos(input) {
  if (input === undefined || input === null) return null;
  const s = String(input).replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

export function formatMXN(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}$${whole}.${frac}`;
}

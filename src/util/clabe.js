// CLABE (Clave Bancaria Estandarizada): 18 digits, the last one is a check digit
// computed with weights 3, 7, 1 over the first 17 digits.

export function clabeCheckDigit(first17) {
  const weights = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += (Number(first17[i]) * weights[i % 3]) % 10;
  }
  return (10 - (sum % 10)) % 10;
}

export function normalizeClabe(input) {
  return String(input || '').replace(/\s/g, '');
}

export function isValidClabe(input) {
  const clabe = normalizeClabe(input);
  if (!/^\d{18}$/.test(clabe)) return false;
  return clabeCheckDigit(clabe.slice(0, 17)) === Number(clabe[17]);
}

// Helper for tests and demos: builds a valid CLABE from any 17-digit prefix.
export function makeClabe(first17) {
  const prefix = String(first17).padStart(17, '0').slice(-17);
  return prefix + clabeCheckDigit(prefix);
}

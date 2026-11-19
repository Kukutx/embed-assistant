/**
 * Best-effort masking of common personal data before text is stored or sent to
 * a model. Pattern based (no ML), so it is fast and predictable; it is a
 * safety net, not a compliance guarantee.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// IBAN: country code, check digits, 11-30 alphanumerics (spaces allowed in groups of 4).
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g;
// 13-19 digits, optionally separated by spaces or dashes: card number candidates (Luhn-checked).
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
// Phone numbers: optional +country, at least 7 digits with common separators.
const PHONE = /(?<![\w+])\+?\d[\d ()./-]{6,18}\d(?!\w)/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function ibanValid(raw: string): boolean {
  const s = raw.replace(/ /g, "");
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of v) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}

export function redactPii(text: string): string {
  return text
    .replace(EMAIL, "[email]")
    .replace(IBAN, (m) => (ibanValid(m) ? "[iban]" : m))
    .replace(CARD, (m) => {
      const digits = m.replace(/\D/g, "");
      return digits.length >= 13 && luhn(digits) ? "[card]" : m;
    })
    .replace(PHONE, (m) => {
      const digits = m.replace(/\D/g, "");
      // Skip dates, years, versions and short numbers.
      if (digits.length < 8 || digits.length > 15) return m;
      if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(m.trim()) || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(m.trim())) return m;
      return "[phone]";
    });
}

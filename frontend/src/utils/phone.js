import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/**
 * Mirrors backend/utils/phone.js normalizePhone so the form rejects a number
 * before checkout, promo validation or free activation.
 *
 * With a country selected, the number must belong to that country whether or
 * not it starts with "+" (e.g. a US +1 832 number is rejected for Canada).
 * country = '' (Other) requires a full "+" international number.
 *
 * Returns { e164 } (with "+") on success, or { error }.
 */
export function checkPhone(input, country, countryName) {
  let s = String(input || '').trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!/^\+?\d{4,17}$/.test(s)) return { error: 'Please enter a valid WhatsApp number.' };

  const international = s.startsWith('+');
  if (!country) {
    if (!international) return { error: 'Enter the full number starting with + and the country code.' };
    const parsed = parsePhoneNumberFromString(s);
    return parsed && parsed.isValid() ? { e164: parsed.number } : { error: 'Please enter a valid WhatsApp number.' };
  }

  let parsed = parsePhoneNumberFromString(s, international ? undefined : country);
  if ((!parsed || !parsed.isValid()) && !international) parsed = parsePhoneNumberFromString(`+${s}`);
  if (!parsed || !parsed.isValid()) return { error: `Please enter a valid ${countryName} WhatsApp number.` };
  if (parsed.country !== country) {
    return { error: `This number is not a ${countryName} number. Select the correct country or check the number.` };
  }
  return { e164: parsed.number };
}

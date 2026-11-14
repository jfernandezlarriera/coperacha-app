// WhatsApp phone helpers. Numbers are stored as international digits without "+".
// Mexican 10-digit numbers get the 52 country code; the legacy "521" mobile prefix is
// collapsed to "52" so one person always maps to one chatId.

export function normalizePhone(input) {
  if (input === undefined || input === null) return null;
  let digits = String(input).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) digits = '52' + digits;
  if (digits.length === 13 && digits.startsWith('521')) digits = '52' + digits.slice(3);
  if (digits.length < 11 || digits.length > 15) return null;
  return digits;
}

export function chatIdForPhone(phone) {
  return `${phone}@s.whatsapp.net`;
}

// Extracts the digits from a chatId like "5215512345678@s.whatsapp.net" or "123@lid".
export function phoneFromChatId(chatId) {
  if (!chatId || typeof chatId !== 'string') return null;
  const [user, domain] = chatId.split('@');
  if (domain !== 's.whatsapp.net' && domain !== 'c.us') return null;
  return normalizePhone(user);
}

export function waMeLink(phone, text) {
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

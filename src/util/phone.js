// WhatsApp phone helpers. Numbers are stored as international digits without "+".
// Mexican 10-digit numbers get the 52 country code; the legacy "521" mobile prefix is
// collapsed to "52" so one person always maps to one stored phone (and one wa.me link).
// WhatsApp itself still uses "521" + 10 digits in the JIDs of Mexican mobiles, and Arturito
// matches chatIds exactly, so `registryChatIds` returns both forms.

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

// chatIds to register with Arturito for a stored phone. For a Mexican number the first one
// is the "521" JID that inbound events normally carry; the second is the "52" form this app
// stores in `participants.chatId` and uses for outbound sends. Other countries: one chatId.
export function registryChatIds(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return [];
  if (normalized.length === 12 && normalized.startsWith('52')) {
    return [chatIdForPhone('521' + normalized.slice(2)), chatIdForPhone(normalized)];
  }
  return [chatIdForPhone(normalized)];
}

// Extracts the digits from a chatId like "5215512345678@s.whatsapp.net" or "123@lid".
// Both the "52" and the "521" form resolve to the same stored phone; "@lid" has no mapping.
export function phoneFromChatId(chatId) {
  if (!chatId || typeof chatId !== 'string') return null;
  const [user, domain] = chatId.split('@');
  if (domain !== 's.whatsapp.net' && domain !== 'c.us') return null;
  return normalizePhone(user);
}

export function waMeLink(phone, text) {
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}

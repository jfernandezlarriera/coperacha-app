// Minimal structured logger. Privacy rule: never log message text, captions, names,
// phone numbers or secrets. Callers pass only identifiers (chatId, type, messageId, ids).
const SILENT = process.env.NODE_ENV === 'test' || process.env.LOG_SILENT === '1';

function emit(level, event, fields) {
  if (SILENT) return;
  const line = { ts: new Date().toISOString(), level, event, ...(fields || {}) };
  const out = level === 'error' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

export const log = {
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
};

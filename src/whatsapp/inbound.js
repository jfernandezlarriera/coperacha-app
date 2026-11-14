// Inbound WhatsApp messages (via Arturito) for people who already joined a colecta.
// Event shape assumed from Arturito: {chatId, type, messageId, text}. Unknown chats are a
// no-op. Logs never include text or names.
import { messages } from '../domain/messages.js';
import { phoneFromChatId } from '../util/phone.js';
import { DomainError } from '../domain/errors.js';
import { log } from '../logger.js';

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function parseCommand(text) {
  const t = fold(text).replace(/^[¿?!¡]+/, '');
  if (!t) return { cmd: 'menu' };
  if (/^(menu|hola|ayuda|opciones)\b/.test(t)) return { cmd: 'menu' };
  if (/^(cuanto falta|falta|cuanto)\b/.test(t)) return { cmd: 'remaining' };
  if (/^(mi monto|monto|cuanto pongo|cuanto me toca)\b/.test(t)) return { cmd: 'my_amount' };
  const propose = /^(proponer|propongo|propuesta)\s*:?\s*(.*)$/.exec(t);
  if (propose) return { cmd: 'propose', title: String(text).trim().replace(/^\S+\s*:?\s*/, '').trim() };
  const vote = /^(votar|voto)\s*:?\s*(\d+)?$/.exec(t);
  if (vote) return vote[2] ? { cmd: 'vote', index: Number(vote[2]) } : { cmd: 'proposals' };
  if (/^(regalos|propuestas|opciones de regalo)\b/.test(t)) return { cmd: 'proposals' };
  if (/^\d+$/.test(t)) return { cmd: 'vote', index: Number(t) };
  return { cmd: 'unknown' };
}

export class InboundHandler {
  constructor({ service }) {
    this.service = service;
  }

  // Picks the most recent active colecta for a phone; null when the number is unknown.
  resolve(chatId) {
    const phone = phoneFromChatId(chatId);
    if (!phone) return null;
    const participants = this.service.participantByPhone(phone);
    const active = participants
      .map((p) => ({ participant: p, colecta: this.service.byId(p.colectaId) }))
      .filter((x) => x.colecta && ['open', 'goal_reached', 'confirmed'].includes(x.colecta.status))
      .sort((a, b) => (a.participant.joinedAt < b.participant.joinedAt ? 1 : -1));
    return active[0] || null;
  }

  // Returns the reply text (or null for no-op). Sending is up to the caller.
  async handle(event) {
    const { chatId, type, messageId } = event || {};
    log.info('whatsapp.inbound', { chatId, type, messageId });
    if (!chatId || type !== 'text') return null;
    const ctx = this.resolve(chatId);
    if (!ctx) {
      log.info('whatsapp.inbound.ignored', { chatId, messageId, reason: 'unknown_chat' });
      return null;
    }
    const { participant, colecta } = ctx;
    const voter = `p:${participant.id}`;
    const command = parseCommand(event.text);
    try {
      switch (command.cmd) {
        case 'menu': return messages.menu(colecta);
        case 'remaining': return messages.remaining(colecta, this.service.summary(colecta.id));
        case 'my_amount': {
          const summary = this.service.summary(colecta.id);
          return messages.myAmount(colecta, this.service.amountFor(summary, participant), summary.contributorsVisible);
        }
        case 'proposals': return messages.proposals(this.service.votingBoard(colecta.id));
        case 'propose': {
          if (!command.title) return 'Escribe "proponer" seguido de tu idea, por ejemplo: proponer bocina bluetooth';
          const p = this.service.propose(colecta, voter, command.title);
          return messages.proposed(p.title);
        }
        case 'vote': {
          const board = this.service.votingBoard(colecta.id);
          const chosen = board.proposals[command.index - 1];
          if (!chosen) return messages.proposals(board);
          this.service.vote(colecta, voter, chosen.id);
          return messages.voted(chosen.title);
        }
        default: return messages.unknownCommand;
      }
    } catch (err) {
      if (err instanceof DomainError) return err.message;
      throw err;
    }
  }
}

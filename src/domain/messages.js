// WhatsApp copy (Mexican Spanish, tú). Never includes the private cap of a participant and
// never lists who put how much unless the colecta is confirmed.
import { formatMXN } from '../util/money.js';
import { formatZoned } from '../util/time.js';

const giftLabel = (c) => c.finalGift || c.giftIdea || 'el regalo sorpresa';

export const messages = {
  joined: (colecta, participant, amountCents) =>
    `¡Listo, ${participant.name}! Ya estás en la coperacha para ${giftLabel(colecta)}.\n` +
    `Por ahora te toca ${formatMXN(amountCents)} (puede cambiar conforme se sumen más personas).\n` +
    `No se cobra nada hasta llegar a la meta. Escríbeme "menu" para ver opciones.`,

  menu: (colecta) =>
    `Coperacha para ${giftLabel(colecta)}. ¿Qué quieres hacer?\n` +
    `1. "proponer <idea>" para proponer un regalo\n` +
    `2. "votar" para ver y votar las opciones\n` +
    `3. "cuánto falta"\n` +
    `4. "mi monto"`,

  remaining: (colecta, summary) =>
    summary.reached
      ? `¡Ya se llegó a la meta de ${formatMXN(colecta.goalCents)}! Van ${summary.participantCount} personas.`
      : `Van ${formatMXN(summary.totalCents)} de ${formatMXN(colecta.goalCents)} (${summary.percent}%). ` +
        `Faltan ${formatMXN(summary.remainingCents)} y la fecha límite es el ${formatZoned(colecta.deadline)}.`,

  myAmount: (colecta, amountCents, confirmed) =>
    confirmed
      ? `Tu aportación quedó en ${formatMXN(amountCents)}.`
      : `Por ahora te toca ${formatMXN(amountCents)}. Se confirma cuando se llegue a la meta.`,

  proposals: (board) => {
    if (board.proposals.length === 0) return 'Todavía no hay propuestas. Escribe "proponer <idea>" para sumar una.';
    const lines = board.proposals.map((p, i) => `${i + 1}. ${p.title} (${p.votes} ${p.votes === 1 ? 'voto' : 'votos'})`);
    return `Opciones de regalo:\n${lines.join('\n')}\nResponde "votar <número>" para votar.`;
  },

  proposed: (title) => `Anotado: "${title}". Los demás ya pueden votarla.`,
  voted: (title) => `Tu voto quedó en "${title}". Puedes cambiarlo cuando quieras.`,
  votingClosed: 'La votación ya está cerrada.',
  notJoined: null,

  milestone: (colecta, percent, summary) =>
    `Tu coperacha para ${giftLabel(colecta)} ya va al ${percent}%: ${formatMXN(summary.totalCents)} de ${formatMXN(colecta.goalCents)} con ${summary.participantCount} personas.`,

  goalReachedOrganizer: (colecta, summary, link) =>
    `¡Se llegó a la meta de ${formatMXN(colecta.goalCents)} con ${summary.participantCount} personas! ` +
    (colecta.codiStatus === 'ACTIVE'
      ? `Entra a ${link} para confirmar y mandar los cobros CoDi.`
      : `Los cobros CoDi salen cuando Pey active tu cuenta; te aviso en cuanto quede lista. Puedes ver cómo va en ${link}`),

  bankAccountActive: (colecta, summary, link) =>
    `¡Listo! Pey ya activó tu cuenta para la coperacha de ${giftLabel(colecta)}. ` +
    (summary.reached
      ? `Ya se llegó a la meta: entra a ${link} para confirmar y mandar los cobros CoDi.`
      : `Cuando se llegue a la meta vas a poder confirmar y mandar los cobros CoDi desde ${link}`),

  deadlineReminder: (colecta, summary) =>
    `Mañana vence la coperacha para ${giftLabel(colecta)}. ` +
    `Van ${formatMXN(summary.totalCents)} de ${formatMXN(colecta.goalCents)}; faltan ${formatMXN(summary.remainingCents)}. ` +
    `Si conoces a alguien que quiera sumarse, compártele el link.`,

  charge: (colecta, participant, charge) =>
    `¡Se armó la coperacha para ${giftLabel(colecta)}! Te toca ${formatMXN(charge.amountCents)}.\n` +
    (charge.qrString
      ? `Paga con CoDi desde la app de tu banco con este código; el pago va directo a la cuenta de ${colecta.organizerName}. Tienes 24 horas.\n${charge.qrString}`
      : `Te llega un cobro CoDi por ese monto en la app de tu banco; el pago va directo a la cuenta de ${colecta.organizerName}. Tienes 24 horas para aceptarlo.`),

  deadlineMissed: (colecta, summary, link) =>
    `Venció la fecha límite y la coperacha para ${giftLabel(colecta)} quedó en ${formatMXN(summary.totalCents)} de ${formatMXN(colecta.goalCents)}. ` +
    `Nadie paga nada. Entra a ${link} y elige: cambiar el regalo, bajar la meta o cancelar.`,

  reopened: (colecta, summary, reason) =>
    (reason === 'gift'
      ? `La coperacha cambió de regalo: ahora es para ${giftLabel(colecta)}. `
      : `La meta de la coperacha bajó a ${formatMXN(colecta.goalCents)}. `) +
    `Nueva fecha límite: ${formatZoned(colecta.deadline)}. Faltan ${formatMXN(summary.remainingCents)}.`,

  cancelled: (colecta) =>
    `La coperacha para ${giftLabel(colecta)} se canceló. No se cobra nada a nadie. ¡Gracias por sumarte!`,

  giftChosen: (colecta) => `Ya hay regalo elegido: ${colecta.finalGift}. ¡Shhh, es sorpresa!`,

  unknownCommand: 'No entendí. Escríbeme "menu" para ver las opciones.',
};

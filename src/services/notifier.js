// Turns domain events into WhatsApp messages and puts them on the throttled queue.
// Nothing here sends directly; the queue talks to the Arturito client.
import { messages } from '../domain/messages.js';
import { chatIdForPhone } from '../util/phone.js';

export class Notifier {
  constructor({ queue, baseUrl }) {
    this.queue = queue;
    this.baseUrl = baseUrl;
  }

  organizerLink(colecta) {
    return `${this.baseUrl}/colectas/${colecta.id}`;
  }

  toOrganizer(colecta, text) {
    this.queue.enqueue({ chatId: chatIdForPhone(colecta.organizerPhone), text });
  }

  toParticipant(participant, text) {
    this.queue.enqueue({ chatId: participant.chatId, text });
  }

  toAll(summary, text) {
    for (const p of summary.participants) this.toParticipant(p, text);
  }

  async joined(colecta, participant, amountCents) {
    this.toParticipant(participant, messages.joined(colecta, participant, amountCents));
  }

  async milestone(colecta, percent, summary) {
    this.toOrganizer(colecta, messages.milestone(colecta, percent, summary));
  }

  async goalReached(colecta, summary) {
    this.toOrganizer(colecta, messages.goalReachedOrganizer(colecta, summary, this.organizerLink(colecta)));
  }

  async deadlineReminder(colecta, summary) {
    const text = messages.deadlineReminder(colecta, summary);
    this.toOrganizer(colecta, text);
    this.toAll(summary, text);
  }

  async bankAccountActive(colecta, summary) {
    this.toOrganizer(colecta, messages.bankAccountActive(colecta, summary, this.organizerLink(colecta)));
  }

  async charge(colecta, participant, charge) {
    this.toParticipant(participant, messages.charge(colecta, participant, charge));
  }

  async deadlineMissed(colecta, summary) {
    this.toOrganizer(colecta, messages.deadlineMissed(colecta, summary, this.organizerLink(colecta)));
  }

  async reopened(colecta, summary, reason) {
    this.toAll(summary, messages.reopened(colecta, summary, reason));
  }

  async cancelled(colecta, summary) {
    const text = messages.cancelled(colecta);
    this.toOrganizer(colecta, text);
    this.toAll(summary, text);
  }

  async giftChosen(colecta, summary) {
    this.toAll(summary, messages.giftChosen(colecta));
  }
}

// Records events without a queue; handy for domain tests.
export class RecordingNotifier {
  constructor() {
    this.events = [];
  }
}
for (const name of ['joined', 'milestone', 'goalReached', 'deadlineReminder', 'bankAccountActive', 'charge', 'deadlineMissed', 'reopened', 'cancelled', 'giftChosen']) {
  RecordingNotifier.prototype[name] = async function (...args) {
    this.events.push({ type: name, args });
  };
}

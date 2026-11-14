process.env.NODE_ENV = 'test';
import { Store } from '../src/db/store.js';
import { ColectaService } from '../src/domain/colecta.js';
import { RecordingNotifier } from '../src/services/notifier.js';
import { MockArturitoClient } from '../src/integrations/arturito.js';
import { MockPeyClient } from '../src/integrations/pey.js';
import { makeClabe } from '../src/util/clabe.js';

export const CLABE = makeClabe('01218000123456789');

export function fixedClock(iso = '2026-11-14T12:00:00Z') {
  let now = new Date(iso);
  const clock = () => now;
  clock.set = (next) => { now = new Date(next); };
  clock.advanceHours = (h) => { now = new Date(now.getTime() + h * 36e5); };
  return clock;
}

export function makeSystem({ clock = fixedClock() } = {}) {
  const store = new Store(':memory:');
  const notifier = new RecordingNotifier();
  const arturito = new MockArturitoClient();
  const pey = new MockPeyClient();
  const service = new ColectaService({ store, notifier, pey, arturito, clock });
  const organizer = store.insert('organizers', { id: 'org-1', googleSub: 'g1', email: 'ana@example.com', name: 'Ana', createdAt: clock().toISOString() });
  const other = store.insert('organizers', { id: 'org-2', googleSub: 'g2', email: 'bob@example.com', name: 'Bob', createdAt: clock().toISOString() });
  return { store, notifier, arturito, pey, service, organizer, other, clock };
}

export async function makeColecta(sys, overrides = {}) {
  return sys.service.create(sys.organizer, {
    giftIdea: 'Bocina', goalCents: 100000, deadline: new Date(sys.clock().getTime() + 7 * 864e5), splitMode: 'free',
    organizerName: 'Ana', organizerPhone: '5512345678', clabe: CLABE, ...overrides,
  });
}

let phoneSeq = 5500000000;
export async function join(sys, colecta, input) {
  phoneSeq += 1;
  return sys.service.join(sys.service.byId(colecta.id), { name: `P${phoneSeq}`, phone: String(phoneSeq), mode: 'equal', ...input });
}

export const events = (sys, type) => sys.notifier.events.filter((e) => e.type === type);

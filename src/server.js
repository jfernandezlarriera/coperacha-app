// Entry point: wires config, store, integrations, services and the HTTP server.
import { loadDotEnv, buildConfig, validateConfig } from './config.js';
import { Store } from './db/store.js';
import { ColectaService } from './domain/colecta.js';
import { Notifier } from './services/notifier.js';
import { OutboundQueue } from './integrations/outbound-queue.js';
import { HttpArturitoClient, MockArturitoClient } from './integrations/arturito.js';
import { HttpPeyClient, MockPeyClient } from './integrations/pey.js';
import { GoogleAuth } from './auth/google.js';
import { InboundHandler } from './whatsapp/inbound.js';
import { buildApp } from './web/app.js';
import { log } from './logger.js';

export function buildSystem(config, overrides = {}) {
  const store = overrides.store || new Store(config.databasePath);
  const arturito = overrides.arturito || (config.arturito.sendUrl
    ? new HttpArturitoClient(config.arturito)
    : new MockArturitoClient());
  const queue = overrides.queue || new OutboundQueue({ client: arturito, limitPerMinute: config.arturito.sendLimitPerMinute });
  const notifier = overrides.notifier || new Notifier({ queue, baseUrl: config.baseUrl });
  const pey = overrides.pey || (config.pey.mode === 'http'
    ? new HttpPeyClient(config.pey)
    : new MockPeyClient({ webhookSecret: config.pey.webhookSecret || 'mock-secret' }));
  const service = new ColectaService({ store, notifier, pey, arturito, clock: overrides.clock });
  const inbound = new InboundHandler({ service });
  const googleAuth = overrides.googleAuth || new GoogleAuth(config.google);
  const { server } = buildApp({ config, store, service, inbound, pey, googleAuth, queue });
  return { store, arturito, queue, notifier, pey, service, inbound, googleAuth, server };
}

export function startDeadlineJob(service, intervalMs = 60_000) {
  const run = () => service.sweepDeadlines().catch((err) => log.error('deadline.sweep.error', { error: err?.message }));
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadDotEnv();
  const config = buildConfig();
  const problems = validateConfig(config);
  if (problems.length) {
    for (const p of problems) process.stderr.write(`config: ${p}\n`);
    process.exit(1);
  }
  const system = buildSystem(config);
  startDeadlineJob(system.service);
  system.server.listen(config.port, () => {
    log.info('server.listening', { port: config.port, baseUrl: config.baseUrl, pey: config.pey.mode, arturitoSend: Boolean(config.arturito.sendUrl) });
  });
}

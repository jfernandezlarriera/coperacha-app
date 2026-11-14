// Server-rendered pages (Mexican Spanish). Contributor names with amounts appear only in
// `contributors`, which is rendered solely when the service says the list is visible.
import { esc, layout } from '../util/html.js';
import { formatMXN } from '../util/money.js';
import { formatZoned, utcToZonedInput } from '../util/time.js';
import { isPreauthorizedClabe } from '../integrations/pey.js';

const CHARGE_STATUS_LABEL = { pending: 'Pendiente', paid: 'Pagado', expired: 'Venció sin pagarse', failed: 'No se pudo enviar' };

// Status of the organizer's account with Pey. Charges only go out once it is ACTIVE.
function bankAccountCard(colecta) {
  const tail = esc(String(colecta.clabe || '').slice(-4));
  const direct = `Los cobros CoDi van directo a tu CLABE terminada en ${tail}; Coperacha nunca guarda dinero.`;
  if (colecta.codiStatus === 'ACTIVE') {
    return `<div class="card"><p><strong>Cuenta para cobros: Activa</strong></p><p class="hint">${direct}</p></div>`;
  }
  if (colecta.codiStatus === 'ERROR') {
    return `<div class="error"><strong>Cuenta para cobros: Error.</strong> Pey no pudo activar tu CLABE terminada en ${tail}, así que no se pueden mandar cobros CoDi a esa cuenta. Revisa que la CLABE sea tuya y esté bien escrita; si lo está, crea una colecta nueva con otra CLABE.</div>`;
  }
  const label = colecta.codiStatus === 'PROCESSING' ? 'En revisión' : colecta.codiStatus === 'PENDING' ? 'En activación' : 'Por registrar';
  const wait = isPreauthorizedClabe(colecta.clabe)
    ? 'Tu CLABE ya está preautorizada con Pey, así que normalmente se activa al momento.'
    : 'Pey tiene que activar tu CLABE y eso puede tardar hasta 5 días hábiles.';
  return `<div class="card"><p><strong>Cuenta para cobros: ${label}</strong></p>
<p>${wait} Mientras tanto tu colecta funciona normal: la gente se puede sumar, votar y ves el avance. Los cobros CoDi se mandan hasta que la cuenta esté activa; te avisamos por WhatsApp en cuanto quede lista.</p>
<p class="hint">${direct}</p></div>`;
}

const STATUS_LABEL = {
  open: 'Abierta', goal_reached: 'Meta alcanzada', confirmed: 'Confirmada', failed: 'Venció sin llegar', cancelled: 'Cancelada',
};

const status = (c) => `<span class="status ${esc(c.status)}">${STATUS_LABEL[c.status] || c.status}</span>`;
const flash = (msg) => (msg ? `<div class="flash">${esc(msg)}</div>` : '');
const error = (msg) => (msg ? `<div class="error">${esc(msg)}</div>` : '');

function navFor(organizer, authDev) {
  if (organizer) return `<a href="/dashboard">Mis colectas</a><form method="post" action="/auth/logout" style="display:inline"><button class="inline secondary" style="margin-left:16px">Salir</button></form>`;
  return `<a href="/auth/google">Entrar con Google</a>${authDev ? '<a href="/auth/dev">Entrar (dev)</a>' : ''}`;
}

export function homePage({ organizer, authDev }) {
  const body = `
<h1>Coperacha</h1>
<p>Junta la lana para un regalo sorpresa entre varios. Nadie paga hasta que se llega a la meta, y cada cobro CoDi va directo a la cuenta de quien organiza: Coperacha nunca guarda dinero.</p>
<div class="card">
<p><strong>¿Organizas tú?</strong> Entra con Google, crea la colecta y comparte el link por WhatsApp.</p>
${organizer ? '<a class="btn" href="/dashboard">Ir a mis colectas</a>' : `<a class="btn" href="/auth/google">Entrar con Google</a>${authDev ? ' <a class="btn secondary" href="/auth/dev">Entrar en modo local</a>' : ''}`}
</div>
<div class="card"><p><strong>¿Te invitaron?</strong> Abre el link que te mandaron: no necesitas cuenta, solo tu nombre y tu WhatsApp.</p></div>`;
  return layout({ title: 'Inicio', body, nav: navFor(organizer, authDev) });
}

export function devLoginPage({ err }) {
  const body = `<h1>Entrar en modo local</h1>${error(err)}
<form method="post" action="/auth/dev" class="card">
<label>Nombre<input type="text" name="name" required></label>
<label>Correo<input type="email" name="email" required></label>
<button>Entrar</button>
</form><p class="hint">Este acceso existe solo cuando AUTH_DEV_LOGIN=true. En producción se usa Sign in with Google.</p>`;
  return layout({ title: 'Entrar', body, nav: navFor(null, true) });
}

export function dashboardPage({ organizer, colectas, summaries, authDev }) {
  const rows = colectas.map((c) => {
    const s = summaries.get(c.id);
    return `<li><a href="/colectas/${esc(c.id)}"><strong>${esc(c.giftIdea || c.finalGift || 'Regalo sorpresa')}</strong></a> ${status(c)}<br>
<small>${formatMXN(s.totalCents)} de ${formatMXN(c.goalCents)} · ${s.participantCount} personas · vence ${esc(formatZoned(c.deadline))}</small></li>`;
  });
  const body = `<h1>Hola, ${esc(organizer.name)}</h1>
<a class="btn" href="/colectas/new">Nueva colecta</a>
<h2>Mis colectas</h2>${rows.length ? `<ul class="plain">${rows.join('')}</ul>` : '<p>Todavía no tienes colectas.</p>'}`;
  return layout({ title: 'Mis colectas', body, nav: navFor(organizer, authDev) });
}

function configFields(c = {}) {
  return `
<label>Idea de regalo (opcional)<input type="text" name="giftIdea" value="${esc(c.giftIdea || '')}" maxlength="120"></label>
<label>Meta en MXN<input type="text" name="goal" inputmode="decimal" value="${c.goalCents ? esc((c.goalCents / 100).toFixed(2)) : ''}" required></label>
<label>Fecha límite (hora de la Ciudad de México)<input type="datetime-local" name="deadline" value="${c.deadline ? esc(utcToZonedInput(c.deadline)) : ''}" required></label>
<label>Cómo se reparte
<select name="splitMode">
<option value="equal" ${c.splitMode === 'equal' || !c.splitMode ? 'selected' : ''}>Todos ponen lo mismo (partes iguales)</option>
<option value="free" ${c.splitMode === 'free' ? 'selected' : ''}>Cada quien elige cuánto</option>
</select></label>`;
}

export function newColectaPage({ organizer, err, values = {}, authDev }) {
  const body = `<h1>Nueva colecta</h1>${error(err)}
<form method="post" action="/colectas" class="card">
${configFields(values)}
<h2>Tus datos</h2>
<label>Tu nombre<input type="text" name="organizerName" value="${esc(values.organizerName || organizer.name)}" required></label>
<label>Tu WhatsApp<input type="text" name="organizerPhone" inputmode="tel" placeholder="55 1234 5678" value="${esc(values.organizerPhone || '')}" required></label>
<label>CLABE donde recibes los pagos<input type="text" name="clabe" inputmode="numeric" maxlength="18" value="${esc(values.clabe || '')}" required>
<p class="hint">18 dígitos. Cada cobro CoDi va directo a esta CLABE; Coperacha nunca guarda dinero.</p>
<p class="hint">Al crear la colecta registramos tu CLABE con Pey para poder mandar los cobros. La activación puede tardar hasta 5 días hábiles (si tu CLABE ya está preautorizada con Pey, normalmente es al momento). Mientras tanto tu colecta funciona normal: la gente se suma, vota y ves el avance. Los cobros CoDi salen cuando la cuenta esté activa, y te avisamos por WhatsApp.</p></label>
<button>Crear colecta</button>
</form>`;
  return layout({ title: 'Nueva colecta', body, nav: navFor(organizer, authDev) });
}

export function editColectaPage({ organizer, colecta, err, authDev }) {
  const body = `<h1>Editar colecta</h1>${error(err)}
<form method="post" action="/colectas/${esc(colecta.id)}/edit" class="card">${configFields(colecta)}<button>Guardar</button></form>
<p><a href="/colectas/${esc(colecta.id)}">Volver</a></p>`;
  return layout({ title: 'Editar', body, nav: navFor(organizer, authDev) });
}

function progressBar(summary) {
  return `<div class="progress"><span style="width:${summary.percent}%"></span></div>
<p><strong>${formatMXN(summary.totalCents)}</strong> de ${formatMXN(summary.colecta.goalCents)} (${summary.percent}%) · ${summary.participantCount} ${summary.participantCount === 1 ? 'persona' : 'personas'}${summary.reached ? '' : ` · faltan ${formatMXN(summary.remainingCents)}`}</p>`;
}

function votingSection({ colecta, board, myVote, action, canClose }) {
  const open = !colecta.votingClosedAt;
  const list = board.proposals.length
    ? `<ul class="plain">${board.proposals.map((p) => `<li class="row"><span>${esc(p.title)} <small>· ${p.votes} ${p.votes === 1 ? 'voto' : 'votos'}${myVote === p.id ? ' · tu voto' : ''}</small></span>
${open ? `<form method="post" action="${action}/vote" style="margin:0"><input type="hidden" name="proposalId" value="${esc(p.id)}"><button class="inline secondary">${myVote === p.id ? 'Votado' : 'Votar'}</button></form>` : ''}
${canClose && open ? `<form method="post" action="${action}/close-voting" style="margin:0"><input type="hidden" name="proposalId" value="${esc(p.id)}"><button class="inline">Elegir este</button></form>` : ''}</li>`).join('')}</ul>`
    : '<p>Todavía no hay propuestas.</p>';
  const propose = open ? `<form method="post" action="${action}/proposals" class="row"><input type="text" name="title" placeholder="Proponer un regalo" maxlength="120" required style="flex:1"><button class="inline">Proponer</button></form>` : '';
  const closed = colecta.finalGift ? `<div class="ok">Regalo elegido: <strong>${esc(colecta.finalGift)}</strong></div>` : '';
  const ownPick = canClose && open ? `<form method="post" action="${action}/close-voting" class="row"><input type="text" name="ownPick" placeholder="O escribe tu propia elección" maxlength="120" style="flex:1"><button class="inline">Cerrar votación</button></form><p class="hint">Si lo dejas vacío, gana la propuesta con más votos (en empate, la más antigua).</p>` : '';
  return `<h2>Regalo</h2>${closed}${list}${propose}${ownPick}`;
}

function contributorsSection(contributors) {
  if (!contributors) return '';
  return `<h2>Quién puso cuánto</h2><table><tr><th>Nombre</th><th>Aportación</th></tr>${contributors.map((c) => `<tr><td>${esc(c.name)}</td><td>${formatMXN(c.amountCents)}</td></tr>`).join('')}</table>`;
}

export function organizerColectaPage({ organizer, summary, stats, board, myVote, link, waLink, charges, contributors, msg, err, authDev }) {
  const { colecta } = summary;
  const id = esc(colecta.id);
  let actions = '';
  if (colecta.status === 'goal_reached' && colecta.codiStatus !== 'ACTIVE') {
    actions = colecta.codiStatus === 'ERROR'
      ? `<div class="error"><strong>¡Se llegó a la meta!</strong> Pero no se pueden mandar los cobros CoDi porque Pey no pudo activar tu cuenta.</div>`
      : `<div class="flash"><strong>¡Se llegó a la meta!</strong> Los cobros CoDi esperan a que Pey active tu cuenta (puede tardar hasta 5 días hábiles). En cuanto quede activa te avisamos por WhatsApp y aquí vas a poder confirmar y mandar los cobros.</div>`;
  } else if (colecta.status === 'goal_reached') {
    actions = `<div class="ok"><strong>¡Se llegó a la meta!</strong> Al confirmar se congelan los montos y cada persona recibe su cobro CoDi.
<form method="post" action="/colectas/${id}/confirm"><button>Confirmar y mandar cobros</button></form></div>`;
  } else if (colecta.status === 'failed') {
    actions = `<div class="error"><strong>Venció la fecha límite sin llegar a la meta.</strong> Nadie paga nada. Elige qué hacer:</div>
<div class="card"><h3>Cambiar el regalo</h3><form method="post" action="/colectas/${id}/outcome"><input type="hidden" name="action" value="change_gift">
<label>Nuevo regalo<input type="text" name="giftIdea" required maxlength="120"></label>
<label>Nueva fecha límite<input type="datetime-local" name="deadline" required></label><button>Cambiar regalo</button></form></div>
<div class="card"><h3>Bajar la meta</h3><form method="post" action="/colectas/${id}/outcome"><input type="hidden" name="action" value="lower_goal">
<label>Nueva meta (hoy van ${formatMXN(summary.totalCents)})<input type="text" name="goal" inputmode="decimal" required></label>
<label>Nueva fecha límite (solo si la nueva meta todavía no se cubre)<input type="datetime-local" name="deadline"></label><button>Bajar meta</button></form></div>
<div class="card"><h3>Cancelar</h3><form method="post" action="/colectas/${id}/outcome"><input type="hidden" name="action" value="cancel"><button class="danger">Cancelar la colecta</button></form></div>`;
  } else if (colecta.status === 'confirmed') {
    const paid = charges.filter((c) => c.status === 'paid').length;
    actions = `<div class="ok">Cobros enviados: ${paid} de ${charges.length} pagados.</div>
<table><tr><th>Referencia</th><th>Monto</th><th>Estado</th></tr>${charges.map((c) => `<tr><td><code>${esc(c.reference)}</code></td><td>${formatMXN(c.amountCents)}</td><td>${esc(CHARGE_STATUS_LABEL[c.status] || c.status)}</td></tr>`).join('')}</table>
<p class="hint">Cada cobro CoDi vence a las 24 horas. Pey no hace devoluciones: si alguien no paga, su cobro solo vence.</p>`;
  }
  const body = `<h1>${esc(colecta.finalGift || colecta.giftIdea || 'Regalo sorpresa')} ${status(colecta)}</h1>
${flash(msg)}${error(err)}
<div class="card"><p><strong>Link para invitar</strong><br><code>${esc(link)}</code></p>
<p><a class="btn secondary" href="${esc(waLink)}" target="_blank" rel="noopener">Compartir por WhatsApp</a></p></div>
${['open', 'goal_reached', 'failed'].includes(colecta.status) ? bankAccountCard(colecta) : ''}
<div class="card">${progressBar(summary)}
<p><small>Vence ${esc(formatZoned(colecta.deadline))} · ${colecta.splitMode === 'equal' ? 'partes iguales' : 'monto libre'} · parte igual actual ${formatMXN(stats.shareCents)}</small></p>
<p><small>Participan: ${stats.names.length ? stats.names.map(esc).join(', ') : 'nadie todavía'}. Los montos de cada quien se muestran solo al confirmar.</small></p>
${['open', 'goal_reached', 'failed'].includes(colecta.status) ? `<a href="/colectas/${id}/edit">Editar meta, fecha o regalo</a>` : ''}</div>
${actions}
${votingSection({ colecta, board, myVote, action: `/colectas/${id}`, canClose: true })}
${contributorsSection(contributors)}
${['open', 'goal_reached'].includes(colecta.status) ? `<form method="post" action="/colectas/${id}/outcome"><input type="hidden" name="action" value="cancel"><button class="danger secondary">Cancelar colecta</button></form>` : ''}`;
  return layout({ title: 'Colecta', body, nav: navFor(organizer, authDev) });
}

export function joinPage({ colecta, summary, err, values = {} }) {
  const closed = !['open', 'goal_reached'].includes(colecta.status);
  const body = `<h1>Coperacha para ${esc(colecta.giftIdea || 'un regalo sorpresa')}</h1>
<p>${esc(colecta.organizerName)} está juntando ${formatMXN(colecta.goalCents)} hasta el ${esc(formatZoned(colecta.deadline))}. Nadie paga hasta llegar a la meta.</p>
<div class="card">${progressBar(summary)}</div>
${closed ? '<div class="flash">Esta colecta ya no acepta participantes.</div>' : `${error(err)}
<form method="post" action="/c/${esc(colecta.code)}/join" class="card">
<label>Tu nombre<input type="text" name="name" value="${esc(values.name || '')}" required></label>
<label>Tu WhatsApp<input type="text" name="phone" inputmode="tel" placeholder="55 1234 5678" value="${esc(values.phone || '')}" required></label>
<p class="hint">Te escribimos por WhatsApp para avisarte cómo va y, si se llega a la meta, mandarte tu cobro CoDi.</p>
<label>¿Cuánto pones?</label>
<label><input type="radio" name="mode" value="equal" checked> Parte igual (hoy ${formatMXN(summary.resolved.share)}; cambia conforme se sumen más personas)</label>
${colecta.splitMode === 'free' ? `<label><input type="radio" name="mode" value="fixed"> Un monto fijo: <input type="text" name="fixed" inputmode="decimal" placeholder="MXN" style="width:120px;display:inline-block"></label>` : ''}
<label><input type="radio" name="mode" value="majority_cap"> Pongo lo que ponga la mayoría, máximo: <input type="text" name="cap" inputmode="decimal" placeholder="MXN" style="width:120px;display:inline-block">
<p class="hint">Tu máximo es privado: nadie lo ve. Al confirmar pagas lo que ponga la mayoría o tu máximo, lo que sea menor.</p></label>
<button>Sumarme</button></form>`}`;
  return layout({ title: 'Sumarme', body });
}

export function participantMenuPage({ colecta, summary, participant, amountCents, board, myVote, contributors, msg, err }) {
  const body = `<h1>Hola, ${esc(participant.name)}</h1>
<p>Coperacha para ${esc(colecta.finalGift || colecta.giftIdea || 'un regalo sorpresa')} ${status(colecta)}</p>
${flash(msg)}${error(err)}
<div class="card"><h2 style="margin-top:0">Cuánto falta</h2>${progressBar(summary)}<p><small>Vence ${esc(formatZoned(colecta.deadline))}</small></p></div>
<div class="card"><h2 style="margin-top:0">Mi monto</h2><p><strong>${formatMXN(amountCents)}</strong> ${summary.contributorsVisible ? '(confirmado)' : '<small>por ahora; se confirma al llegar a la meta</small>'}</p></div>
${votingSection({ colecta, board, myVote, action: `/c/${esc(colecta.code)}`, canClose: false })}
${contributorsSection(contributors)}
${!contributors ? '<p class="hint">La lista de quién puso cuánto se muestra solo cuando la colecta se confirma.</p>' : ''}`;
  return layout({ title: 'Mi coperacha', body });
}

export function errorPage(status, message) {
  return layout({ title: `Error ${status}`, body: `<h1>${status}</h1><p>${esc(message)}</p><p><a href="/">Inicio</a></p>` });
}

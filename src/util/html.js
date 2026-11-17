// HTML escaping and the shared page layout. Brand colors: green #185744, coral #EB6468,
// marigold #FA9C28, sage #85A78C.

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `
:root{--green:#185744;--coral:#EB6468;--marigold:#FA9C28;--sage:#85A78C;--ink:#1f2a26;--paper:#fbfaf6;--line:#e3e6e1}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--paper);color:var(--ink);line-height:1.5}
header{background:var(--green);color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center}
header a{color:#fff;text-decoration:none;font-weight:700}
header nav a{margin-left:16px;font-weight:400}
main{max-width:720px;margin:0 auto;padding:24px 20px 60px}
h1{font-size:1.6rem;margin:0 0 12px}
h2{font-size:1.15rem;margin:28px 0 8px;color:var(--green)}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:14px 0}
label{display:block;font-weight:600;margin-top:14px}
input[type=text],input[type=number],input[type=email],input[type=datetime-local],select,textarea{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;font-size:1rem;margin-top:4px}
.hint{font-size:.9rem;color:#5c6b66;margin:4px 0 0}
button,.btn{display:inline-block;background:var(--green);color:#fff;border:0;border-radius:999px;padding:10px 18px;font-size:1rem;cursor:pointer;text-decoration:none;margin-top:14px}
button.secondary,.btn.secondary{background:var(--sage)}
button.danger,.btn.danger{background:var(--coral)}
button.inline{padding:6px 12px;font-size:.9rem;margin:0}
.progress{height:14px;background:#eee;border-radius:999px;overflow:hidden;margin:10px 0}
.progress span{display:block;height:100%;background:var(--marigold)}
.flash{background:#fff4e5;border-left:4px solid var(--marigold);padding:10px 14px;border-radius:8px;margin:12px 0}
.error{background:#fdecec;border-left:4px solid var(--coral);padding:10px 14px;border-radius:8px;margin:12px 0}
.ok{background:#e8f3ec;border-left:4px solid var(--green);padding:10px 14px;border-radius:8px;margin:12px 0}
.status{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.85rem;background:#eee}
.status.open{background:#fff4e5}.status.goal_reached{background:#e8f3ec}.status.confirmed{background:var(--green);color:#fff}.status.failed{background:#fdecec}.status.cancelled{background:#eee}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}
code{background:#eef1ee;padding:2px 6px;border-radius:6px;word-break:break-all}
ul.plain{list-style:none;padding:0}ul.plain li{padding:8px 0;border-bottom:1px solid var(--line)}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.prototype-notice{margin:0;padding:8px 20px;background:#f1f4ef;border-bottom:1px solid var(--line);color:#5c6b66;font-size:.85rem;line-height:1.4;text-align:center}
.prototype-notice a{color:var(--green);font-weight:600}
small{color:#5c6b66}
`;

// Shown on every page, right under the header; plain text, never blocks a flow.
export const PROTOTYPE_NOTICE = '<p class="prototype-notice" role="note">Coperacha es un prototipo creado en una hackatón. Puedes probarlo, pero todavía no es un servicio en producción: estamos haciendo pruebas para decidir cómo seguir. ¿Te interesa? <a href="https://coperacha.app/#contacto">Escríbenos</a>.</p>';

export function layout({ title, body, nav = '' }) {
  return `<!doctype html>
<html lang="es-MX">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Coperacha</title>
<style>${CSS}</style>
</head>
<body>
<header><a href="/">Coperacha</a><nav>${nav}</nav></header>
${PROTOTYPE_NOTICE}
<main>${body}</main>
</body>
</html>`;
}

const db = require('./db');
const { getResource } = require('./mikrotik');
const { sendToMikrotik } = require('./push');

const FALHAS_PARA_OFFLINE = 2; // evita alarme falso por uma falha isolada de conexão

// Decide a condição de uma regra para o status atual.
// Retorna { cond: true|false|null, falhas }. cond null = sem informação (não altera o estado).
function avaliar(regra, st, estado) {
  if (regra.tipo === 'offline') {
    const falhas = st.online ? 0 : estado.falhas + 1;
    return { cond: falhas >= FALHAS_PARA_OFFLINE, falhas };
  }
  if (!st.online) return { cond: null, falhas: estado.falhas };
  if (regra.tipo === 'cpu') return { cond: st.cpu != null && st.cpu >= regra.limite, falhas: 0 };
  if (regra.tipo === 'memoria') {
    const usada = st.memoriaTotal ? ((st.memoriaTotal - st.memoriaLivre) / st.memoriaTotal) * 100 : null;
    return { cond: usada != null && usada >= regra.limite, falhas: 0 };
  }
  return { cond: null, falhas: estado.falhas };
}

function mensagens(regra, router, st) {
  const nome = router.nome;
  if (regra.tipo === 'offline') {
    return {
      alerta: { title: `⚠️ ${nome} offline`, body: 'O equipamento não está respondendo.' },
      ok: { title: `✅ ${nome} online`, body: 'O equipamento voltou a responder.' },
    };
  }
  if (regra.tipo === 'cpu') {
    return {
      alerta: { title: `⚠️ CPU alta em ${nome}`, body: `Uso de CPU em ${st.cpu}% (limite ${regra.limite}%).` },
      ok: { title: `✅ CPU normalizada em ${nome}`, body: `Uso de CPU em ${st.cpu}%.` },
    };
  }
  const usada = Math.round(((st.memoriaTotal - st.memoriaLivre) / st.memoriaTotal) * 100);
  return {
    alerta: { title: `⚠️ Memória alta em ${nome}`, body: `Memória em uso: ${usada}% (limite ${regra.limite}%).` },
    ok: { title: `✅ Memória normalizada em ${nome}`, body: `Memória em uso: ${usada}%.` },
  };
}

async function checarRouter(router, regras) {
  const st = await getResource(router);
  for (const regra of regras) {
    const estado =
      db.prepare('SELECT * FROM alerta_estado WHERE alerta_id = ? AND mikrotik_id = ?').get(regra.id, router.id) ||
      { disparado: 0, falhas: 0 };
    const { cond, falhas } = avaliar(regra, st, estado);
    let disparado = estado.disparado;

    if (cond === true && !disparado) {
      disparado = 1;
      await sendToMikrotik(router.id, { ...mensagens(regra, router, st).alerta, tag: `${router.id}-${regra.id}` }, 'alerta');
    } else if (cond === false && disparado) {
      disparado = 0;
      await sendToMikrotik(router.id, { ...mensagens(regra, router, st).ok, tag: `${router.id}-${regra.id}` }, 'alerta');
    }
    db.prepare(
      `INSERT INTO alerta_estado (alerta_id, mikrotik_id, disparado, falhas) VALUES (?,?,?,?)
       ON CONFLICT(alerta_id, mikrotik_id) DO UPDATE SET disparado = excluded.disparado, falhas = excluded.falhas`
    ).run(regra.id, router.id, disparado, falhas);
  }
}

let rodando = false;
async function rodarUmaVez() {
  if (rodando) return;
  rodando = true;
  try {
    const regras = db.prepare('SELECT * FROM alertas WHERE ativo = 1').all();
    if (!regras.length) return;
    const routers = db.prepare('SELECT * FROM mikrotiks').all();
    const tarefas = routers
      // isolamento: a regra de um ID nunca é avaliada contra outro ID
      .map((r) => ({ router: r, regras: regras.filter((g) => g.mikrotik_id === r.id) }))
      .filter((t) => t.regras.length);
    for (let i = 0; i < tarefas.length; i += 5) {
      await Promise.all(
        tarefas.slice(i, i + 5).map((t) => checarRouter(t.router, t.regras).catch((e) => console.error('monitor:', e.message)))
      );
    }
  } finally {
    rodando = false;
  }
}

function iniciarMonitor() {
  const seg = Math.max(15, Number(process.env.MONITOR_INTERVAL_SEC || 60));
  setTimeout(rodarUmaVez, 10_000);
  setInterval(rodarUmaVez, seg * 1000);
  console.log(`Monitor de alertas ativo (a cada ${seg}s)`);
}

module.exports = { iniciarMonitor, rodarUmaVez, avaliar };

require('./config'); // carrega .env e gera as chaves na primeira execução (precisa vir antes de tudo)
const path = require('path');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const db = require('./db');
const { encrypt } = require('./crypto');
const { normalizeCpf, isValidCpf } = require('./cpf');
const { getResource } = require('./mikrotik');
const { sendPush, subsForMikrotik, subsForCpf, allSubs, logNotificacao, PUBLIC: VAPID_PUBLIC } = require('./push');
const { iniciarMonitor } = require('./monitor');
const { needsSetup, createAdmin, checkAdmin } = require('./admin');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('Defina JWT_SECRET no .env');
encrypt('teste'); // falha cedo se ENC_KEY estiver inválida

const app = express();
// Hospedagens colocam um proxy na frente: req.ip precisa vir do X-Forwarded-For (limite de tentativas por IP).
// Se expuser o Node direto na internet, defina TRUST_PROXY=0.
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
app.use(cors());
app.use(express.json({ limit: '50kb' }));

// Cabeçalhos de segurança para o PWA (sem scripts/estilos inline)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
  );
  next();
});

// ---------- utilidades ----------
const sign = (payload, expiresIn) => jwt.sign(payload, JWT_SECRET, { expiresIn });

// Limite simples de tentativas por IP (em memória)
const attempts = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const rec = (attempts.get(key) || []).filter((t) => now - t < windowMs);
    if (rec.length >= max) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde um pouco.' });
    rec.push(now);
    attempts.set(key, rec);
    next();
  };
}

function auth(role) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    try {
      const data = jwt.verify(token, JWT_SECRET);
      if (data.role !== role) return res.status(403).json({ erro: 'Acesso negado.' });
      req.user = data;
      next();
    } catch (_) {
      res.status(401).json({ erro: 'Sessão inválida ou expirada.' });
    }
  };
}

const isPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

function validateBody(b, { partial = false } = {}) {
  const out = {};
  if (!partial || b.id !== undefined) {
    if (!ID_RE.test(String(b.id || ''))) return { erro: 'ID inválido (use letras, números, - ou _; até 32 caracteres).' };
    out.id = String(b.id);
  }
  out.nome = String(b.nome || '').trim();
  out.ip = String(b.ip || '').trim();
  out.usuario = String(b.usuario || '').trim();
  out.porta_api = Number(b.porta_api ?? 8728);
  out.porta_ssh = Number(b.porta_ssh ?? 22);
  if (!out.nome) return { erro: 'Informe o nome.' };
  if (!out.ip) return { erro: 'Informe o IP.' };
  if (!out.usuario) return { erro: 'Informe o usuário.' };
  if (!isPort(out.porta_api)) return { erro: 'Porta API inválida.' };
  if (!isPort(out.porta_ssh)) return { erro: 'Porta SSH inválida.' };

  const rawCpfs = Array.isArray(b.cpfs) ? b.cpfs : [];
  const cpfs = [...new Set(rawCpfs.map(normalizeCpf).filter(Boolean))];
  const invalid = cpfs.find((c) => !isValidCpf(c));
  if (invalid) return { erro: `CPF inválido: ${invalid}` };
  out.cpfs = cpfs;
  out.senha = b.senha ? String(b.senha) : '';
  return { data: out };
}

function publicRow(row) {
  const cpfs = db.prepare('SELECT cpf FROM vinculos WHERE mikrotik_id = ? ORDER BY cpf').all(row.id).map((r) => r.cpf);
  const { senha_enc, ...rest } = row; // a senha nunca sai da API
  return { ...rest, cpfs };
}

// ---------- admin ----------
// Primeiro acesso: cria o administrador pelo navegador (só funciona enquanto não existir um)
app.get('/setup/status', (_req, res) => res.json({ needsSetup: needsSetup() }));

app.post('/setup/admin', rateLimit(10, 15 * 60 * 1000), (req, res) => {
  if (!needsSetup()) return res.status(409).json({ erro: 'O administrador já foi criado.' });
  const b = req.body || {};
  const r = createAdmin(b.usuario, b.senha);
  if (r.erro) return res.status(r.erro.startsWith('O administrador') ? 409 : 400).json({ erro: r.erro });
  res.status(201).json({ token: sign({ role: 'admin' }, '12h') });
});

app.post('/admin/login', rateLimit(10, 15 * 60 * 1000), (req, res) => {
  const { usuario, senha } = req.body || {};
  if (!checkAdmin(usuario, senha)) return res.status(401).json({ erro: 'Usuário ou senha incorretos.' });
  res.json({ token: sign({ role: 'admin' }, '12h') });
});

app.get('/admin/mikrotiks', auth('admin'), (req, res) => {
  const rows = db.prepare('SELECT * FROM mikrotiks ORDER BY nome').all();
  res.json(rows.map(publicRow));
});

app.get('/admin/mikrotiks/:id', auth('admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM mikrotiks WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ erro: 'MikroTik não encontrado.' });
  res.json(publicRow(row));
});

app.post('/admin/mikrotiks', auth('admin'), (req, res) => {
  const v = validateBody(req.body || {});
  if (v.erro) return res.status(400).json({ erro: v.erro });
  const d = v.data;
  if (!d.senha) return res.status(400).json({ erro: 'Informe a senha.' });
  if (db.prepare('SELECT 1 FROM mikrotiks WHERE id = ?').get(d.id)) {
    return res.status(409).json({ erro: 'Já existe um MikroTik com esse ID.' });
  }

  db.transaction(() => {
    db.prepare(
      'INSERT INTO mikrotiks (id, nome, ip, porta_api, usuario, senha_enc, porta_ssh) VALUES (?,?,?,?,?,?,?)'
    ).run(d.id, d.nome, d.ip, d.porta_api, d.usuario, encrypt(d.senha), d.porta_ssh);
    const ins = db.prepare('INSERT OR IGNORE INTO vinculos (cpf, mikrotik_id) VALUES (?, ?)');
    d.cpfs.forEach((c) => ins.run(c, d.id));
  })();
  res.status(201).json(publicRow(db.prepare('SELECT * FROM mikrotiks WHERE id = ?').get(d.id)));
});

app.put('/admin/mikrotiks/:id', auth('admin'), (req, res) => {
  const id = req.params.id;
  const current = db.prepare('SELECT * FROM mikrotiks WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ erro: 'MikroTik não encontrado.' });

  const v = validateBody({ ...req.body, id }, { partial: true });
  if (v.erro) return res.status(400).json({ erro: v.erro });
  const d = v.data;

  db.transaction(() => {
    db.prepare(
      'UPDATE mikrotiks SET nome=?, ip=?, porta_api=?, usuario=?, senha_enc=?, porta_ssh=? WHERE id=?'
    ).run(d.nome, d.ip, d.porta_api, d.usuario, d.senha ? encrypt(d.senha) : current.senha_enc, d.porta_ssh, id);
    db.prepare('DELETE FROM vinculos WHERE mikrotik_id = ?').run(id);
    const ins = db.prepare('INSERT OR IGNORE INTO vinculos (cpf, mikrotik_id) VALUES (?, ?)');
    d.cpfs.forEach((c) => ins.run(c, id));
  })();
  res.json(publicRow(db.prepare('SELECT * FROM mikrotiks WHERE id = ?').get(id)));
});

app.delete('/admin/mikrotiks/:id', auth('admin'), (req, res) => {
  const r = db.prepare('DELETE FROM mikrotiks WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ erro: 'MikroTik não encontrado.' });
  res.json({ ok: true });
});

// ---------- cliente ----------
// Login só com CPF. O token guarda apenas o CPF; a cada requisição o vínculo
// (cpf, id) é conferido no banco, então mudanças de vínculo valem na hora.
const idsDoCpf = (cpf) =>
  db.prepare(
    'SELECT m.id, m.nome FROM vinculos v JOIN mikrotiks m ON m.id = v.mikrotik_id WHERE v.cpf = ? ORDER BY m.nome'
  ).all(cpf);

async function painel(row, cpf) {
  return { id: row.id, nome: row.nome, cpf: cpf || null, status: await getResource(row) };
}

app.post('/auth/cpf', rateLimit(15, 15 * 60 * 1000), (req, res) => {
  const cpf = normalizeCpf(req.body && req.body.cpf);
  if (!isValidCpf(cpf)) return res.status(400).json({ erro: 'CPF inválido.' });
  const lista = idsDoCpf(cpf);
  if (!lista.length) return res.status(404).json({ erro: 'CPF não cadastrado.' });
  res.json({ token: sign({ role: 'cliente', cpf }, process.env.CLIENT_TOKEN_TTL || '30d'), mikrotiks: lista });
});

// Todos os IDs (painéis) vinculados ao CPF logado
app.get('/cliente/mikrotiks', auth('cliente'), (req, res) => {
  res.json(idsDoCpf(req.user.cpf));
});

// Painel de um ID — só se o CPF logado estiver vinculado a ele
app.get('/cliente/dashboard/:id', auth('cliente'), async (req, res) => {
  const vinc = db.prepare('SELECT 1 FROM vinculos WHERE cpf = ? AND mikrotik_id = ?').get(req.user.cpf, req.params.id);
  if (!vinc) return res.status(403).json({ erro: 'Acesso negado a este painel.' });
  const row = db.prepare('SELECT * FROM mikrotiks WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ erro: 'Cadastro não encontrado.' });
  res.json(await painel(row, req.user.cpf));
});

// Admin: vê o painel de qualquer ID
app.get('/admin/dashboard/:id', auth('admin'), async (req, res) => {
  const row = db.prepare('SELECT * FROM mikrotiks WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ erro: 'MikroTik não encontrado.' });
  res.json(await painel(row, null));
});

// ---------- push: aparelhos (cliente) ----------
// Chave pública VAPID: o navegador precisa dela para criar a inscrição
app.get('/push/public-key', (_req, res) => res.json({ key: VAPID_PUBLIC || null }));

app.post('/cliente/push-subscription', auth('cliente'), (req, res) => {
  const b = req.body || {};
  const endpoint = String(b.endpoint || '');
  const keys = b.keys || {};
  const p256dh = String(keys.p256dh || '');
  const authKey = String(keys.auth || '');
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !authKey || p256dh.length > 200 || authKey.length > 100) {
    return res.status(400).json({ erro: 'Inscrição de notificação inválida.' });
  }
  // Um aparelho pertence ao último CPF que entrou nele
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, cpf, p256dh, auth) VALUES (?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET cpf = excluded.cpf, p256dh = excluded.p256dh, auth = excluded.auth`
  ).run(endpoint, req.user.cpf, p256dh, authKey);
  res.json({ ok: true });
});

app.post('/cliente/push-subscription/remover', auth('cliente'), (req, res) => {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND cpf = ?')
    .run(String((req.body && req.body.endpoint) || ''), req.user.cpf);
  res.json({ ok: true });
});

// ---------- push: alertas e envio (admin) ----------
const TIPOS = ['offline', 'cpu', 'memoria'];

function validarAlerta(b) {
  const nome = String(b.nome || '').trim();
  if (!nome) return { erro: 'Informe o nome da regra.' };
  if (!TIPOS.includes(b.tipo)) return { erro: 'Tipo de alerta inválido.' };
  // Cada alerta pertence a um único ID (nunca "todos"): só avisa os CPFs vinculados a ele
  const mikrotik_id = String(b.mikrotik_id || '');
  if (!mikrotik_id) return { erro: 'Escolha o ID do alerta.' };
  if (!db.prepare('SELECT 1 FROM mikrotiks WHERE id = ?').get(mikrotik_id)) {
    return { erro: 'MikroTik não encontrado.' };
  }
  let limite = null;
  if (b.tipo !== 'offline') {
    limite = Number(b.limite);
    if (!(limite >= 1 && limite <= 100)) return { erro: 'Limite deve ser entre 1 e 100 (%).' };
  }
  return { data: { nome, tipo: b.tipo, mikrotik_id, limite, ativo: b.ativo === false || b.ativo === 0 ? 0 : 1 } };
}

app.get('/admin/alertas', auth('admin'), (_req, res) => {
  res.json(db.prepare('SELECT * FROM alertas ORDER BY mikrotik_id, id').all());
});

app.post('/admin/alertas', auth('admin'), (req, res) => {
  const v = validarAlerta(req.body || {});
  if (v.erro) return res.status(400).json({ erro: v.erro });
  const d = v.data;
  const r = db.prepare('INSERT INTO alertas (nome, tipo, mikrotik_id, limite, ativo) VALUES (?,?,?,?,?)')
    .run(d.nome, d.tipo, d.mikrotik_id, d.limite, d.ativo);
  res.status(201).json(db.prepare('SELECT * FROM alertas WHERE id = ?').get(r.lastInsertRowid));
});

app.put('/admin/alertas/:id', auth('admin'), (req, res) => {
  const atual = db.prepare('SELECT * FROM alertas WHERE id = ?').get(req.params.id);
  if (!atual) return res.status(404).json({ erro: 'Regra não encontrada.' });
  const v = validarAlerta(req.body || {});
  if (v.erro) return res.status(400).json({ erro: v.erro });
  const d = v.data;
  db.transaction(() => {
    db.prepare('UPDATE alertas SET nome=?, tipo=?, mikrotik_id=?, limite=?, ativo=? WHERE id=?')
      .run(d.nome, d.tipo, d.mikrotik_id, d.limite, d.ativo, atual.id);
    db.prepare('DELETE FROM alerta_estado WHERE alerta_id = ?').run(atual.id); // regra mudou: recomeça o estado
  })();
  res.json(db.prepare('SELECT * FROM alertas WHERE id = ?').get(atual.id));
});

app.delete('/admin/alertas/:id', auth('admin'), (req, res) => {
  const r = db.prepare('DELETE FROM alertas WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ erro: 'Regra não encontrada.' });
  res.json({ ok: true });
});

app.get('/admin/notificacoes', auth('admin'), (_req, res) => {
  res.json(db.prepare('SELECT * FROM notificacoes ORDER BY id DESC LIMIT 30').all());
});

// Envio manual: destino = 'todos' | 'id' | 'cpf'
app.post('/admin/notificacoes', auth('admin'), async (req, res) => {
  const b = req.body || {};
  const titulo = String(b.titulo || '').trim();
  const mensagem = String(b.mensagem || '').trim();
  if (!titulo || titulo.length > 100) return res.status(400).json({ erro: 'Título obrigatório (até 100 caracteres).' });
  if (!mensagem || mensagem.length > 500) return res.status(400).json({ erro: 'Mensagem obrigatória (até 500 caracteres).' });

  let subs, destino, data = {};
  if (b.destino === 'id') {
    const id = String(b.mikrotik_id || '');
    if (!db.prepare('SELECT 1 FROM mikrotiks WHERE id = ?').get(id)) return res.status(404).json({ erro: 'MikroTik não encontrado.' });
    subs = subsForMikrotik(id);
    destino = `ID ${id}`;
    data = { mikrotik_id: id };
  } else if (b.destino === 'cpf') {
    const cpf = normalizeCpf(b.cpf);
    if (!isValidCpf(cpf)) return res.status(400).json({ erro: 'CPF inválido.' });
    subs = subsForCpf(cpf);
    destino = `CPF ${cpf}`;
  } else {
    subs = allSubs();
    destino = 'Todos';
  }

  const dispositivos = new Set(subs.map((s) => s.endpoint)).size;
  const enviados = dispositivos ? await sendPush(subs, { title: titulo, body: mensagem, data }) : 0;
  logNotificacao({ titulo, mensagem, destino, origem: 'manual', enviados });
  res.json({ dispositivos, enviados });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- PWA (arquivos estáticos em backend/public) ----------
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    setHeaders: (res, file) => {
      // o service worker e o manifest precisam ser revalidados sempre, senão atualizações não chegam
      if (/(sw\.js|manifest\.webmanifest|index\.html)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`MikroTik Manager rodando na porta ${port}`);
  if (needsSetup()) console.log('Primeiro acesso: abra o endereço do site no navegador para criar o administrador.');
  iniciarMonitor();
});

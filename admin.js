const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const getCfg = (k) => (db.prepare('SELECT valor FROM config WHERE chave = ?').get(k) || {}).valor;
const envAdmin = () => !!(process.env.ADMIN_USER && process.env.ADMIN_PASS);

// Primeiro acesso: enquanto não existe administrador, o app pede para criar um
const needsSetup = () => !envAdmin() && !getCfg('admin_hash');

function createAdmin(usuario, senha) {
  usuario = String(usuario || '').trim();
  senha = String(senha || '');
  if (!/^[A-Za-z0-9_.@-]{3,32}$/.test(usuario)) return { erro: 'Usuário: 3 a 32 caracteres (letras, números, . _ - @).' };
  if (senha.length < 8 || senha.length > 100) return { erro: 'A senha deve ter de 8 a 100 caracteres.' };
  const hash = bcrypt.hashSync(senha, 10);
  const criado = db.transaction(() => {
    if (getCfg('admin_hash')) return false;
    const ins = db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?)');
    ins.run('admin_user', usuario);
    ins.run('admin_hash', hash);
    return true;
  })();
  return criado ? { ok: true } : { erro: 'O administrador já foi criado.' };
}

function checkAdmin(usuario, senha) {
  usuario = String(usuario || '');
  senha = String(senha || '');
  if (envAdmin()) {
    const u = safeEqual(usuario, process.env.ADMIN_USER);
    const p = safeEqual(senha, process.env.ADMIN_PASS);
    return u && p;
  }
  const u = getCfg('admin_user');
  const h = getCfg('admin_hash');
  if (!u || !h) return false;
  const a = safeEqual(usuario, u);
  const b = bcrypt.compareSync(senha, h); // sempre avalia os dois
  return a && b;
}

module.exports = { needsSetup, createAdmin, checkAdmin };

// Primeira coisa carregada. Deixa o sistema pronto sem configuração manual:
// gera (uma única vez) JWT_SECRET, ENC_KEY e as chaves VAPID e guarda em DATA_DIR/secrets.json.
// Variáveis de ambiente (.env ou painel da hospedagem), se existirem, têm prioridade.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const file = path.join(DATA_DIR, 'secrets.json');
let saved = {};
try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}

const falta = (k) => !process.env[k] && !saved[k];
let mudou = false;
if (falta('JWT_SECRET')) { saved.JWT_SECRET = crypto.randomBytes(48).toString('hex'); mudou = true; }
if (falta('ENC_KEY')) { saved.ENC_KEY = crypto.randomBytes(32).toString('hex'); mudou = true; }
if (falta('VAPID_PUBLIC_KEY') || falta('VAPID_PRIVATE_KEY')) {
  const k = require('web-push').generateVAPIDKeys();
  saved.VAPID_PUBLIC_KEY = k.publicKey;
  saved.VAPID_PRIVATE_KEY = k.privateKey;
  mudou = true;
}
if (mudou) {
  fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  console.log(`Chaves de segurança geradas em ${file} (faça backup desta pasta junto com o banco).`);
}
for (const k of ['JWT_SECRET', 'ENC_KEY', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) {
  if (!process.env[k]) process.env[k] = saved[k];
}

module.exports = { DATA_DIR };

const path = require('path');
const { DATA_DIR } = require('./config');
const Database = require('./sqlite');

const db = new Database(path.join(DATA_DIR, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS mikrotiks (
    id         TEXT PRIMARY KEY,
    nome       TEXT NOT NULL,
    ip         TEXT NOT NULL,
    porta_api  INTEGER NOT NULL DEFAULT 8728,
    usuario    TEXT NOT NULL,
    senha_enc  TEXT NOT NULL,
    porta_ssh  INTEGER NOT NULL DEFAULT 22,
    criado_em  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Muitos-para-muitos: um CPF pode estar em vários IDs e um ID pode ter vários CPFs
  CREATE TABLE IF NOT EXISTS vinculos (
    cpf          TEXT NOT NULL,
    mikrotik_id  TEXT NOT NULL REFERENCES mikrotiks(id) ON DELETE CASCADE ON UPDATE CASCADE,
    PRIMARY KEY (cpf, mikrotik_id)
  );
  CREATE INDEX IF NOT EXISTS idx_vinculos_mikrotik ON vinculos(mikrotik_id);

  -- Aparelhos/navegadores que receberão Web Push, ligados ao CPF logado
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    cpf        TEXT NOT NULL,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    criado_em  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_push_cpf ON push_subscriptions(cpf);

  -- Configurações do sistema (administrador criado no primeiro acesso)
  CREATE TABLE IF NOT EXISTS config (
    chave  TEXT PRIMARY KEY,
    valor  TEXT NOT NULL
  );

  -- Alertas automáticos: cada regra pertence a UM ID e só avisa os CPFs vinculados a esse ID.
  CREATE TABLE IF NOT EXISTS alertas (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    nome         TEXT NOT NULL,
    tipo         TEXT NOT NULL CHECK (tipo IN ('offline','cpu','memoria')),
    mikrotik_id  TEXT NOT NULL REFERENCES mikrotiks(id) ON DELETE CASCADE ON UPDATE CASCADE,
    limite       REAL,
    ativo        INTEGER NOT NULL DEFAULT 1,
    criado_em    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Estado por (regra, id) para avisar só quando muda (evita spam)
  CREATE TABLE IF NOT EXISTS alerta_estado (
    alerta_id    INTEGER NOT NULL REFERENCES alertas(id) ON DELETE CASCADE,
    mikrotik_id  TEXT NOT NULL REFERENCES mikrotiks(id) ON DELETE CASCADE ON UPDATE CASCADE,
    disparado    INTEGER NOT NULL DEFAULT 0,
    falhas       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (alerta_id, mikrotik_id)
  );

  -- Histórico do que foi enviado
  CREATE TABLE IF NOT EXISTS notificacoes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo     TEXT NOT NULL,
    mensagem   TEXT NOT NULL,
    destino    TEXT NOT NULL,
    origem     TEXT NOT NULL,
    enviados   INTEGER NOT NULL DEFAULT 0,
    criado_em  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migração da versão anterior (tabela "cpfs", um CPF → um ID)
const old = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cpfs'").get();
if (old) {
  db.exec(`
    INSERT OR IGNORE INTO vinculos (cpf, mikrotik_id) SELECT cpf, mikrotik_id FROM cpfs;
    DROP TABLE cpfs;
  `);
}

// Versão anterior permitia regra "para todos os IDs" (mikrotik_id NULL). Agora cada ID tem as suas:
// a regra geral vira uma cópia isolada em cada ID existente e a geral é apagada.
db.exec(`
  INSERT INTO alertas (nome, tipo, mikrotik_id, limite, ativo)
    SELECT a.nome || ' - ' || m.nome, a.tipo, m.id, a.limite, a.ativo
    FROM alertas a CROSS JOIN mikrotiks m WHERE a.mikrotik_id IS NULL;
  DELETE FROM alertas WHERE mikrotik_id IS NULL;
`);

// A versão nativa (tokens Expo) foi substituída pelo PWA: tokens antigos não servem mais
db.exec('DROP TABLE IF EXISTS push_tokens');

module.exports = db;

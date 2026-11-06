// better-sqlite3 (padrão). Se a hospedagem não conseguir instalar o módulo nativo,
// usa o SQLite embutido do Node 22+ com a mesma interface.
let Database;
try {
  Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (e) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) {
    throw new Error('Não foi possível carregar o SQLite. Use Node 18+ com "npm install" completo, ou Node 22+. Detalhe: ' + e.message);
  }
  console.warn('better-sqlite3 indisponível: usando node:sqlite (Node 22+).');
  Database = class {
    constructor(file) { this.d = new DatabaseSync(file); }
    exec(sql) { this.d.exec(sql); }
    pragma(s) { this.d.exec('PRAGMA ' + s); }
    prepare(sql) {
      const st = this.d.prepare(sql);
      return {
        run: (...a) => { const r = st.run(...a); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
        get: (...a) => st.get(...a),
        all: (...a) => st.all(...a),
      };
    }
    transaction(fn) {
      return (...a) => {
        this.d.exec('BEGIN');
        try { const r = fn(...a); this.d.exec('COMMIT'); return r; } catch (err) { this.d.exec('ROLLBACK'); throw err; }
      };
    }
  };
}
module.exports = Database;

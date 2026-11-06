const { RouterOSAPI } = require('node-routeros');
const { decrypt } = require('./crypto');

// Consulta o MikroTik via API RouterOS. Só deve receber o registro
// do próprio id do cliente autenticado.
async function getResource(row) {
  let conn;
  try {
    conn = new RouterOSAPI({
      host: row.ip,
      port: row.porta_api,
      user: row.usuario,
      password: decrypt(row.senha_enc),
      timeout: 6,
    });
    await conn.connect();
    const [resource] = await conn.write('/system/resource/print');
    const [identity] = await conn.write('/system/identity/print');
    return {
      online: true,
      identidade: identity && identity.name,
      uptime: resource && resource.uptime,
      versao: resource && resource.version,
      modelo: resource && resource['board-name'],
      cpu: resource && Number(resource['cpu-load']),
      memoriaLivre: resource && Number(resource['free-memory']),
      memoriaTotal: resource && Number(resource['total-memory']),
    };
  } catch (e) {
    return { online: false, erro: 'Não foi possível conectar ao equipamento.' };
  } finally {
    try { conn && conn.close(); } catch (_) {}
  }
}

module.exports = { getResource };

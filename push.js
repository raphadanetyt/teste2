const webpush = require('web-push');
const db = require('./db');

const PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const pushAtivo = !!(PUBLIC && PRIVATE);
if (pushAtivo) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', PUBLIC, PRIVATE);
} else {
  console.warn('VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY ausentes: notificações desativadas. Rode "npm run keys".');
}

const subsForMikrotik = (id) =>
  db.prepare(
    'SELECT DISTINCT p.endpoint, p.p256dh, p.auth FROM push_subscriptions p JOIN vinculos v ON v.cpf = p.cpf WHERE v.mikrotik_id = ?'
  ).all(id);

const subsForCpf = (cpf) => db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE cpf = ?').all(cpf);
const allSubs = () => db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all();

// Envia Web Push (o navegador entrega ao service worker, mesmo com o app fechado).
// Retorna quantos aparelhos o serviço de push aceitou.
async function sendPush(subs, { title, body, data, tag }) {
  if (!pushAtivo) return 0;
  const unicas = [...new Map(subs.map((s) => [s.endpoint, s])).values()];
  const payload = JSON.stringify({ title, body, data: data || {}, tag: tag || undefined });
  let enviados = 0;

  for (let i = 0; i < unicas.length; i += 20) {
    await Promise.all(
      unicas.slice(i, i + 20).map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
            { TTL: 3600, urgency: 'high' }
          );
          enviados++;
        } catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410) {
            db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint); // aparelho removido
          } else {
            console.error('Falha ao enviar push:', e.statusCode || '', e.message);
          }
        }
      })
    );
  }
  return enviados;
}

function logNotificacao({ titulo, mensagem, destino, origem, enviados }) {
  db.prepare('INSERT INTO notificacoes (titulo, mensagem, destino, origem, enviados) VALUES (?,?,?,?,?)')
    .run(titulo, mensagem, destino, origem, enviados);
}

// Notifica todos os CPFs vinculados a um ID. O toque na notificação abre esse painel.
async function sendToMikrotik(id, { title, body, tag }, origem = 'alerta') {
  const enviados = await sendPush(subsForMikrotik(id), { title, body, tag, data: { mikrotik_id: id } });
  logNotificacao({ titulo: title, mensagem: body, destino: `ID ${id}`, origem, enviados });
  return enviados;
}

module.exports = { sendPush, sendToMikrotik, subsForMikrotik, subsForCpf, allSubs, logNotificacao, pushAtivo, PUBLIC };

'use strict';

// ============ utilidades ============
const root = document.getElementById('app');
const enc = encodeURIComponent;

// Cria elementos sem innerHTML (os textos entram como texto, nunca como HTML)
const h = (tag, props, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
};

const formatCpf = (v) =>
  String(v || '').replace(/\D/g, '').slice(0, 11)
    .replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1-$2');
const mb = (b) => (b ? `${Math.round(b / 1048576)} MB` : '—');
const dataBR = (iso) => {
  const d = new Date(String(iso).replace(' ', 'T') + 'Z');
  return isNaN(d) ? iso : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const withBusy = async (btn, fn) => { btn.disabled = true; try { return await fn(); } finally { btn.disabled = false; } };
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };

// ============ sessão e API ============
let session = null;
try { session = JSON.parse(localStorage.getItem('session')); } catch (_) {}
const saveSession = (s) => {
  session = s;
  try { s ? localStorage.setItem('session', JSON.stringify(s)) : localStorage.removeItem('session'); } catch (_) {}
};

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (_) {
    throw new Error('Sem conexão com o servidor.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && session) { saveSession(null); go('#/'); } // sessão expirada
    const err = new Error(data.erro || 'Erro inesperado.');
    err.status = res.status;
    throw err;
  }
  return data;
}

// ============ notificações (Web Push) ============
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const swReady = () =>
  Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('Service worker indisponível.')), 5000))]);
const getSub = async () => (await swReady()).pushManager.getSubscription();

const b64ToU8 = (b64) => {
  const s = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
const sameKey = (buf, u8) => {
  if (!buf) return false;
  const a = new Uint8Array(buf);
  return a.length === u8.length && a.every((v, i) => v === u8[i]);
};

async function pushStatus() {
  if (isIOS && !standalone) return 'ios-install'; // no iPhone só funciona com o app na Tela de Início
  if (!pushSupported) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission === 'granted' && (await getSub())) return 'on';
  return 'off';
}

// Cria (ou reaproveita) a inscrição deste aparelho e registra no servidor, ligada ao CPF logado
async function subscribePush() {
  const { key } = await api('GET', '/push/public-key');
  if (!key) throw new Error('O servidor ainda não está configurado para enviar notificações.');
  const want = b64ToU8(key);
  const reg = await swReady();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, want)) { await sub.unsubscribe(); sub = null; } // chave VAPID mudou
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
  await api('POST', '/cliente/push-subscription', sub.toJSON());
}

async function enablePush() {
  const perm = await Notification.requestPermission(); // precisa ser a primeira ação do toque (exigência do iOS)
  if (perm !== 'granted') throw new Error('Permissão negada. Libere as notificações nas configurações do aparelho.');
  await subscribePush();
}

async function disablePush() {
  const sub = await getSub();
  if (!sub) return;
  try { await api('POST', '/cliente/push-subscription/remover', { endpoint: sub.endpoint }); } catch (_) {}
  await sub.unsubscribe();
}

function pushCard() {
  const box = h('div', { class: 'card' });
  const draw = async (msg) => {
    const st = await pushStatus().catch(() => 'unsupported');
    const err = msg ? h('p', { class: 'error', role: 'alert' }, msg) : null;
    const act = (label, fn, cls) =>
      h('button', {
        class: `btn small ${cls || ''}`, type: 'button',
        onclick: (e) => withBusy(e.currentTarget, async () => { try { await fn(); await draw(); } catch (x) { await draw(x.message); } }),
      }, label);
    const parts = {
      'ios-install': [h('p', { class: 'muted' }, 'No iPhone/iPad, toque em Compartilhar, depois em “Adicionar à Tela de Início”. Abra o app pelo ícone novo e ative os avisos aqui.')],
      unsupported: [h('p', { class: 'muted' }, 'Este navegador não suporta avisos. No iPhone é preciso iOS 16.4 ou mais novo.')],
      denied: [h('p', { class: 'muted' }, 'Os avisos estão bloqueados. Libere as notificações deste app nas configurações do aparelho ou do navegador.')],
      on: [h('p', { class: 'muted' }, 'Você receberá os alertas neste aparelho mesmo com o app fechado.'), act('Desativar avisos', disablePush, 'ghost')],
      off: [h('p', { class: 'muted' }, 'Ative para ser avisado automaticamente, mesmo com o app fechado.'), act('Ativar avisos', enablePush)],
    }[st];
    fill(box,
      h('div', { class: 'row between' }, h('p', { class: 'h2' }, 'Avisos neste aparelho'), st === 'on' ? h('span', { class: 'on' }, '● Ativados') : null),
      h('div', { class: 'mt' }, parts), err
    );
  };
  draw();
  return box;
}

// ============ instalação do app (atalho na tela inicial) ============
let deferredInstall = null;
const banner = h('div', { class: 'install hidden', role: 'status' });
document.body.append(banner);
const hideBanner = (remember) => { banner.classList.add('hidden'); if (remember) try { localStorage.setItem('installHint', '1'); } catch (_) {} };

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  banner.replaceChildren(
    h('p', { class: 'h2' }, 'Instalar o app'),
    h('p', { class: 'muted mt' }, 'Abra direto da tela inicial, como um aplicativo, e receba os alertas.'),
    h('div', { class: 'row' },
      h('button', { class: 'link', type: 'button', onclick: () => hideBanner(false) }, 'Agora não'),
      h('button', {
        class: 'btn small', type: 'button',
        onclick: async () => { hideBanner(false); deferredInstall.prompt(); await deferredInstall.userChoice.catch(() => {}); deferredInstall = null; },
      }, 'Instalar'))
  );
  banner.classList.remove('hidden');
});
window.addEventListener('appinstalled', () => hideBanner(false));

if (isIOS && !standalone && !localStorage.getItem('installHint')) {
  banner.replaceChildren(
    h('p', { class: 'h2' }, 'Instalar no iPhone'),
    h('p', { class: 'muted mt' }, 'Toque em Compartilhar e depois em “Adicionar à Tela de Início”. É assim que o iPhone libera os avisos.'),
    h('div', { class: 'row' }, h('button', { class: 'link', type: 'button', onclick: () => hideBanner(true) }, 'Entendi'))
  );
  banner.classList.remove('hidden');
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // Toque na notificação com o app já aberto: o service worker pede para navegar
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'abrir') go(e.data.hash); });
}

// ============ estrutura das telas ============
let rid = 0; // identifica a navegação atual (descarta respostas atrasadas)
let cleanup = null;
const mount = (node) => root.replaceChildren(node);
// replaceChildren escreve "null" na tela se receber null: este helper descarta vazios
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
const loading = () => h('div', { class: 'center' }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': 'Carregando' }));
const errorBox = (msg) => h('p', { class: 'error', role: 'alert' }, msg);

function shell({ title, back, actions }, ...body) {
  return h('div', { class: 'screen' },
    h('header', { class: 'bar' },
      back ? h('a', { class: 'back', href: back, 'aria-label': 'Voltar' }, '‹') : null,
      h('h1', {}, title),
      h('div', { class: 'actions' }, actions || [])),
    h('main', { class: 'pad' }, body));
}

const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);
const input = (props) => h('input', { class: 'input', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', ...props });
const logoutBtn = () => h('button', { class: 'link', type: 'button', onclick: signOut }, 'Sair');

function chips(options, value, onChange) {
  let current = value;
  const box = h('div', { class: 'chips' });
  const draw = () => box.replaceChildren(...options.map((o) =>
    h('button', { class: 'chip', type: 'button', 'aria-pressed': String(o.value === current), onclick: () => { current = o.value; onChange(current); draw(); } }, o.label)));
  draw();
  return box;
}

async function signOut() {
  if (session && session.role === 'cliente' && pushSupported) {
    try { await disablePush(); } catch (_) {} // este aparelho deixa de receber avisos deste CPF
  }
  saveSession(null);
  go('#/');
}

// ============ login ============
// Primeiro acesso: ainda não existe administrador, então o app pede para criar um
function viewSetup() {
  const user = input({ autocomplete: 'username', placeholder: 'ex.: admin' });
  const p1 = input({ type: 'password', autocomplete: 'new-password' });
  const p2 = input({ type: 'password', autocomplete: 'new-password' });
  const err = h('p', { class: 'error', role: 'alert' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Criar administrador');
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      err.textContent = '';
      if (p1.value !== p2.value) return (err.textContent = 'As senhas não conferem.');
      withBusy(btn, async () => {
        try {
          const { token } = await api('POST', '/setup/admin', { usuario: user.value, senha: p1.value });
          saveSession({ token, role: 'admin' });
          go('#/');
        } catch (x) { err.textContent = x.message; }
      });
    },
  }, field('Usuário do administrador', user), field('Senha (mínimo 8 caracteres)', p1), field('Repita a senha', p2), err, btn);
  mount(h('div', { class: 'screen' }, h('main', { class: 'pad' },
    h('h1', { class: 'title center-text' }, 'Primeiro acesso'),
    h('p', { class: 'muted center-text mt' }, 'Crie o usuário e a senha do administrador. Esta tela aparece só uma vez.'),
    h('div', { class: 'mt2' }, form))));
}

async function viewLogin() {
  const me = rid;
  mount(loading());
  const st = await api('GET', '/setup/status').catch(() => ({ needsSetup: false }));
  if (me !== rid) return;
  if (st.needsSetup) return viewSetup();
  let mode = 'cliente';
  const err = h('p', { class: 'error', role: 'alert' });
  const cpf = input({ inputmode: 'numeric', placeholder: '000.000.000-00', maxlength: '14', oninput: (e) => { e.target.value = formatCpf(e.target.value); } });
  const user = input({ autocomplete: 'username' });
  const pass = input({ type: 'password', autocomplete: 'current-password' });
  const clientBox = h('div', {}, field('CPF', cpf));
  const adminBox = h('div', { class: 'hidden' }, field('Usuário', user), field('Senha', pass));
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Entrar');

  const tab = (id, label) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': String(mode === id), 'data-id': id,
    onclick: () => {
      mode = id; err.textContent = '';
      tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.id === id)));
      clientBox.classList.toggle('hidden', id !== 'cliente');
      adminBox.classList.toggle('hidden', id !== 'admin');
    },
  }, label);
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, tab('cliente', 'Cliente'), tab('admin', 'Administrador'));

  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      err.textContent = '';
      withBusy(btn, async () => {
        try {
          const { token } = mode === 'cliente' ? await api('POST', '/auth/cpf', { cpf: cpf.value }) : await api('POST', '/admin/login', { usuario: user.value, senha: pass.value });
          saveSession({ token, role: mode });
          const back = sessionStorage.getItem('redirect');
          sessionStorage.removeItem('redirect');
          go(mode === 'cliente' && back ? back : '#/');
        } catch (x) { err.textContent = x.message; }
      });
    },
  }, tabs, clientBox, adminBox, err, btn);

  mount(h('div', { class: 'screen' }, h('main', { class: 'pad' },
    h('h1', { class: 'title center-text' }, 'MikroTik Manager'), h('div', { class: 'mt2' }, form))));
}

// ============ painel (cliente e admin) ============
async function viewPanel(id, admin) {
  const me = rid;
  const body = h('div', {}, loading());
  const view = shell({ title: admin ? 'Painel (admin)' : 'Meu painel', back: admin ? '#/admin' : '#/', actions: [admin ? null : logoutBtn()] }, body);
  const back = view.querySelector('.back');
  if (!admin) back.classList.add('hidden'); // só aparece se o CPF tiver mais de um painel
  mount(view);

  const kv = (k, v) => h('div', { class: 'kv' }, h('span', {}, k), h('span', {}, v ?? '—'));
  const draw = (d) => {
    const st = d.status;
    fill(body,
      h('div', { class: 'card' },
        h('p', { class: 'title' }, d.nome),
        h('p', { class: 'muted mt' }, `ID ${d.id}${d.cpf ? ` · CPF ${formatCpf(d.cpf)}` : ''}`)),
      h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('p', { class: 'h2' }, 'Equipamento'), h('span', { class: st.online ? 'on' : 'off' }, st.online ? '● Online' : '● Offline')),
        st.online
          ? h('div', { class: 'mt' }, kv('Identidade', st.identidade), kv('Modelo', st.modelo), kv('RouterOS', st.versao), kv('Uptime', st.uptime),
              kv('CPU', st.cpu != null ? `${st.cpu}%` : null), kv('Memória livre', `${mb(st.memoriaLivre)} / ${mb(st.memoriaTotal)}`))
          : h('p', { class: 'muted mt' }, st.erro)),
      h('p', { class: 'muted center-text' }, `Atualizado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`),
      admin ? null : pushCard()
    );
  };

  const load = async (silent) => {
    try {
      const [d, list] = await Promise.all([
        api('GET', `${admin ? '/admin' : '/cliente'}/dashboard/${enc(id)}`),
        admin ? null : api('GET', '/cliente/mikrotiks'),
      ]);
      if (me !== rid) return;
      if (list && list.length > 1) back.classList.remove('hidden');
      draw(d);
    } catch (e) {
      if (me !== rid || (silent && body.children.length)) return;
      body.replaceChildren(errorBox(e.message), h('a', { class: 'link', href: admin ? '#/admin' : '#/' }, 'Voltar'));
    }
  };
  await load(false);
  const t = setInterval(() => { if (!document.hidden) load(true); }, 30000);
  cleanup = () => clearInterval(t);
}

// ============ cliente: lista de painéis ============
async function viewClientList() {
  const me = rid;
  mount(loading());
  try {
    const list = await api('GET', '/cliente/mikrotiks');
    if (me !== rid) return;
    if (list.length === 1) return location.replace(`#/painel/${enc(list[0].id)}`); // um só: abre direto
    mount(shell({ title: 'Meus painéis', actions: [logoutBtn()] },
      list.length
        ? [h('p', { class: 'muted' }, 'Escolha o painel que deseja abrir'), h('div', { class: 'mt' }, list.map((m) =>
            h('a', { class: 'card', href: `#/painel/${enc(m.id)}` }, h('p', { class: 'h2' }, m.nome), h('p', { class: 'muted mt' }, `ID ${m.id}`)))),
          pushCard()]
        : [h('p', { class: 'muted center-text' }, 'Nenhum painel vinculado a este CPF.')]));
  } catch (e) {
    if (me === rid) mount(shell({ title: 'Meus painéis', actions: [logoutBtn()] }, errorBox(e.message)));
  }
}

// ============ admin: lista ============
async function viewAdminHome() {
  const me = rid;
  mount(loading());
  const view = (items, erro) => shell({ title: 'MikroTiks', actions: [h('a', { class: 'link', href: '#/admin/alertas' }, 'Alertas'), logoutBtn()] },
    erro ? errorBox(erro) : null,
    !items.length && !erro ? h('p', { class: 'muted center-text mt2' }, 'Nenhum MikroTik cadastrado. Toque em + para adicionar.') : null,
    items.map((m) => h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('p', { class: 'h2' }, m.nome), h('span', { class: 'muted' }, `ID ${m.id}`)),
      h('p', { class: 'muted mt' }, `${m.ip} · API ${m.porta_api} · SSH ${m.porta_ssh}`),
      h('p', { class: 'muted mt' }, `${m.cpfs.length} CPF${m.cpfs.length === 1 ? '' : 's'}${m.cpfs.length ? ': ' + m.cpfs.slice(0, 2).map(formatCpf).join(', ') + (m.cpfs.length > 2 ? '…' : '') : ''}`),
      h('div', { class: 'row mt2' },
        h('a', { class: 'link', href: `#/admin/painel/${enc(m.id)}` }, 'Ver painel'),
        h('a', { class: 'link', href: `#/admin/mk/${enc(m.id)}` }, 'Editar e alertas')))),
    h('a', { class: 'fab', href: '#/admin/mk/novo', 'aria-label': 'Novo MikroTik' }, '+'));
  try {
    const items = await api('GET', '/admin/mikrotiks');
    if (me === rid) mount(view(items));
  } catch (e) { if (me === rid) mount(view([], e.message)); }
}

// ============ admin: cadastro + alertas do ID ============
const TIPOS = [['offline', 'Equipamento offline'], ['cpu', 'CPU alta'], ['memoria', 'Memória alta']];

async function viewMikrotikForm(id) {
  const me = rid;
  mount(loading());
  let exists = !!id && id !== 'novo';
  let m = { id: '', nome: '', ip: '', porta_api: 8728, usuario: '', porta_ssh: 22, cpfs: [] };
  let rules;
  try {
    if (exists) m = await api('GET', `/admin/mikrotiks/${enc(id)}`);
    rules = await api('GET', '/admin/alertas');
  } catch (e) {
    return me === rid && mount(shell({ title: 'MikroTik', back: '#/admin' }, errorBox(e.message)));
  }
  if (me !== rid) return;

  // Alertas deste ID: uma linha por tipo (liga/desliga e limite)
  const al = {};
  for (const [t] of TIPOS) {
    const rule = exists ? rules.find((r) => r.mikrotik_id === m.id && r.tipo === t) : null;
    al[t] = { rule, on: exists ? !!(rule && rule.ativo) : t === 'offline', limite: String((rule && rule.limite) || 80) };
  }

  const f = {
    id: input({ value: m.id, disabled: exists, placeholder: 'ex.: loja01', required: true, maxlength: '32' }),
    nome: input({ value: m.nome, autocapitalize: 'sentences', required: true }),
    ip: input({ value: m.ip, placeholder: 'ex.: 200.150.10.5', inputmode: 'url', required: true }),
    api: input({ value: String(m.porta_api), inputmode: 'numeric' }),
    ssh: input({ value: String(m.porta_ssh), inputmode: 'numeric' }),
    usuario: input({ value: m.usuario, required: true }),
    senha: input({ type: 'password', autocomplete: 'new-password', required: !exists }),
  };
  let cpfs = [...m.cpfs];
  const cpfInput = input({ inputmode: 'numeric', placeholder: '000.000.000-00', maxlength: '14', oninput: (e) => { e.target.value = formatCpf(e.target.value); } });
  const cpfList = h('div');
  const err = h('p', { class: 'error', role: 'alert' });

  const drawCpfs = () => cpfList.replaceChildren(...cpfs.map((c) =>
    h('div', { class: 'cpf-item' }, h('span', {}, formatCpf(c)),
      h('button', { class: 'link danger', type: 'button', onclick: () => { cpfs = cpfs.filter((x) => x !== c); drawCpfs(); } }, 'Remover'))));
  const addCpf = () => {
    const d = cpfInput.value.replace(/\D/g, '');
    if (d.length !== 11) return (err.textContent = 'CPF deve ter 11 dígitos.');
    if (cpfs.includes(d)) return (err.textContent = 'CPF já adicionado.');
    err.textContent = '';
    cpfs.push(d); cpfInput.value = ''; drawCpfs();
  };
  drawCpfs();

  const alertRows = TIPOS.map(([t, label]) => {
    const lim = input({ value: al[t].limite, inputmode: 'numeric', maxlength: '3', 'aria-label': `Limite de ${label} em %`, oninput: (e) => { al[t].limite = e.target.value; } });
    let limBox;
    const sw = h('input', { class: 'switch', type: 'checkbox', checked: al[t].on, 'aria-label': label, onchange: (e) => { al[t].on = e.target.checked; limBox.classList.toggle('hidden', !al[t].on); } });
    limBox = h('div', { class: `row mt${al[t].on ? '' : ' hidden'}` }, h('span', { class: 'muted' }, 'Avisar a partir de'), lim, h('span', { class: 'muted' }, '%'));
    return h('div', { class: 'alert-row' }, h('div', { class: 'row between' }, h('span', {}, label), sw), t === 'offline' ? null : limBox);
  });

  async function syncAlerts(mid, nome) {
    for (const [t, label] of TIPOS) {
      const a = al[t];
      const limite = t === 'offline' ? null : Number(a.limite);
      if (a.rule) {
        const mudou = a.on !== !!a.rule.ativo || (t !== 'offline' && limite !== a.rule.limite);
        if (mudou) a.rule = await api('PUT', `/admin/alertas/${a.rule.id}`, { nome: a.rule.nome, tipo: t, mikrotik_id: mid, limite: t === 'offline' ? null : (a.on ? limite : a.rule.limite), ativo: a.on });
      } else if (a.on) {
        a.rule = await api('POST', '/admin/alertas', { nome: `${label} - ${nome}`, tipo: t, mikrotik_id: mid, limite, ativo: true });
      }
    }
  }

  const saveBtn = h('button', { class: 'btn', type: 'submit' }, 'Salvar');
  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      err.textContent = '';
      withBusy(saveBtn, async () => {
        const body = {
          id: f.id.value.trim(), nome: f.nome.value, ip: f.ip.value, usuario: f.usuario.value, senha: f.senha.value,
          porta_api: Number(f.api.value), porta_ssh: Number(f.ssh.value), cpfs,
        };
        try {
          if (exists) await api('PUT', `/admin/mikrotiks/${enc(body.id)}`, body);
          else { await api('POST', '/admin/mikrotiks', body); exists = true; f.id.disabled = true; }
          await syncAlerts(body.id, body.nome.trim());
          go('#/admin');
        } catch (x) { err.textContent = x.message; }
      });
    },
  },
    field('ID', f.id), field('Nome', f.nome), field('IP / host', f.ip),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, field('Porta API', f.api)), h('div', { class: 'grow' }, field('Porta SSH', f.ssh))),
    field('Usuário', f.usuario), field(exists ? 'Senha (deixe em branco para manter)' : 'Senha', f.senha),

    h('p', { class: 'label mt2' }, 'CPFs que acessam e recebem os alertas deste ID'),
    h('div', { class: 'row' }, cpfInput, h('button', { class: 'btn small', type: 'button', onclick: addCpf }, 'Adicionar')),
    cpfList,

    h('div', { class: 'card mt2' },
      h('p', { class: 'h2' }, 'Alertas automáticos deste ID'),
      h('p', { class: 'muted mt' }, 'Valem só para este ID e avisam só os CPFs acima, mesmo com o app fechado. Avisa quando o problema começa e quando termina.'),
      h('div', { class: 'mt' }, alertRows)),
    err, saveBtn,
    exists ? h('button', {
      class: 'btn danger', type: 'button',
      onclick: async () => {
        if (!confirm(`Excluir "${m.nome}" (ID ${m.id}), desvincular seus CPFs e apagar seus alertas?`)) return;
        try { await api('DELETE', `/admin/mikrotiks/${enc(m.id)}`); go('#/admin'); } catch (x) { err.textContent = x.message; }
      },
    }, 'Excluir MikroTik') : null);

  mount(shell({ title: exists ? 'Editar MikroTik' : 'Novo MikroTik', back: '#/admin' }, form));
}

// ============ admin: alertas, regras gerais, envio manual e histórico ============
async function viewAlerts() {
  const me = rid;
  mount(loading());
  let rules, hist, mks;
  try { [rules, hist, mks] = await Promise.all([api('GET', '/admin/alertas'), api('GET', '/admin/notificacoes'), api('GET', '/admin/mikrotiks')]); }
  catch (e) { return me === rid && mount(shell({ title: 'Alertas', back: '#/admin' }, errorBox(e.message))); }
  if (me !== rid) return;

  const tipoNome = Object.fromEntries(TIPOS);
  const err = h('p', { class: 'error', role: 'alert' });
  const ruleRow = (r) => {
    const sw = h('input', {
      class: 'switch', type: 'checkbox', checked: !!r.ativo, 'aria-label': `${tipoNome[r.tipo]} ativo`,
      onchange: async (e) => {
        try { await api('PUT', `/admin/alertas/${r.id}`, { ...r, ativo: e.target.checked }); err.textContent = ''; }
        catch (x) { err.textContent = x.message; e.target.checked = !e.target.checked; }
      },
    });
    return h('div', { class: 'alert-row row between' }, h('span', {}, `${tipoNome[r.tipo]}${r.limite ? ` ≥ ${r.limite}%` : ''}`), sw);
  };
  const porId = mks.map((m) => {
    const rs = rules.filter((r) => r.mikrotik_id === m.id);
    return h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('p', { class: 'h2' }, m.nome), h('a', { class: 'link', href: `#/admin/mk/${enc(m.id)}` }, 'Configurar')),
      h('p', { class: 'muted mt' }, `ID ${m.id}`),
      rs.length ? h('div', { class: 'mt' }, rs.map(ruleRow)) : h('p', { class: 'muted mt' }, 'Nenhum alerta configurado.'));
  });

  mount(shell({ title: 'Alertas', back: '#/admin' },
    h('a', { class: 'btn', href: '#/admin/enviar' }, 'Enviar notificação agora'),
    h('p', { class: 'h2 mt2' }, 'Alertas automáticos por ID'),
    h('p', { class: 'muted mt' }, 'Cada alerta pertence a um único ID e avisa só os CPFs vinculados a ele. Para mudar, toque em Configurar.'),
    err,
    h('div', { class: 'mt' }, porId.length ? porId : h('p', { class: 'muted' }, 'Nenhum MikroTik cadastrado.')),
    h('p', { class: 'h2 mt2' }, 'Enviadas recentemente'),
    h('div', { class: 'mt' }, hist.length
      ? hist.map((n) => h('div', { class: 'card' }, h('p', { class: 'h2' }, n.titulo), h('p', { class: 'mt' }, n.mensagem),
          h('p', { class: 'muted mt' }, `${n.destino} · ${n.enviados} aparelho${n.enviados === 1 ? '' : 's'} · ${n.origem === 'manual' ? 'manual' : 'automática'} · ${dataBR(n.criado_em)}`)))
      : h('p', { class: 'muted' }, 'Nada enviado ainda.'))));
}

async function viewSend() {
  const me = rid;
  mount(loading());
  let mks;
  try { mks = await api('GET', '/admin/mikrotiks'); }
  catch (e) { return me === rid && mount(shell({ title: 'Enviar notificação', back: '#/admin/alertas' }, errorBox(e.message))); }
  if (me !== rid) return;

  let destino = 'todos', mkId = null;
  const titulo = input({ maxlength: '100', autocapitalize: 'sentences' });
  const msg = h('textarea', { class: 'input', maxlength: '500' });
  const cpf = input({ inputmode: 'numeric', placeholder: '000.000.000-00', maxlength: '14', oninput: (e) => { e.target.value = formatCpf(e.target.value); } });
  const idBox = h('div', { class: 'hidden mt' }, chips(mks.map((x) => ({ value: x.id, label: `${x.nome} (${x.id})` })), null, (v) => { mkId = v; }));
  const cpfBox = h('div', { class: 'hidden mt' }, cpf);
  const err = h('p', { class: 'error', role: 'alert' });
  const ok = h('p', { class: 'notice', role: 'status' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Enviar');

  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      err.textContent = ''; ok.textContent = '';
      if (destino === 'id' && !mkId) return (err.textContent = 'Escolha o ID de destino.');
      withBusy(btn, async () => {
        try {
          const r = await api('POST', '/admin/notificacoes', { titulo: titulo.value, mensagem: msg.value, destino, mikrotik_id: mkId, cpf: cpf.value });
          if (r.dispositivos) ok.textContent = `Enviado a ${r.enviados} de ${r.dispositivos} aparelho${r.dispositivos === 1 ? '' : 's'}.`;
          else err.textContent = 'Nenhum aparelho com o app instalado e avisos ativados para esse destino.';
        } catch (x) { err.textContent = x.message; }
      });
    },
  },
    field('Título', titulo), field('Mensagem', msg),
    h('p', { class: 'label' }, 'Enviar para'),
    chips([{ value: 'todos', label: 'Todos (aviso geral)' }, { value: 'id', label: 'Um ID' }, { value: 'cpf', label: 'Um CPF' }], destino, (v) => {
      destino = v; idBox.classList.toggle('hidden', v !== 'id'); cpfBox.classList.toggle('hidden', v !== 'cpf');
    }),
    idBox, cpfBox, err, ok, btn);

  mount(shell({ title: 'Enviar notificação', back: '#/admin/alertas' }, form));
}

// ============ rotas ============
async function render() {
  rid++;
  if (cleanup) { cleanup(); cleanup = null; }
  const [path, qs = ''] = (location.hash.slice(1) || '/').split('?');
  const q = new URLSearchParams(qs);
  const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
  window.scrollTo(0, 0);

  if (!session) {
    if (seg.length) sessionStorage.setItem('redirect', location.hash); // volta ao painel depois do login
    return viewLogin();
  }
  if (session.role === 'admin') {
    if (seg[0] !== 'admin') return seg.length ? go('#/admin') : viewAdminHome();
    switch (seg[1]) {
      case 'mk': return viewMikrotikForm(seg[2]);
      case 'painel': return seg[2] ? viewPanel(seg[2], true) : viewAdminHome();
      case 'alertas': return viewAlerts();
      case 'enviar': return viewSend();
      default: return viewAdminHome();
    }
  }
  if (seg[0] === 'painel' && seg[1]) return viewPanel(seg[1], false);
  return viewClientList();
}

window.addEventListener('hashchange', render);

// Cliente já com permissão: mantém a inscrição deste aparelho em dia no servidor
if (session && session.role === 'cliente' && pushSupported && Notification.permission === 'granted') {
  subscribePush().catch(() => {});
}
render();

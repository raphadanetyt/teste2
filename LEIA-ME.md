# MikroTik Manager

App web instalável (PWA) + servidor. Uma versão só para Android e iPhone: o cliente abre o endereço no celular e instala como atalho na tela inicial.

- **Administrador**: cadastra os MikroTiks (ID, nome, IP, porta API, usuário, senha, porta SSH), vincula CPFs a cada ID e **configura os alertas de cada ID**.
- **Cliente**: entra só com o CPF, vê o painel dos IDs vinculados ao CPF e recebe os alertas.

## Colocar no ar (hospedagem com botão "Iniciar")
1. Envie o conteúdo deste zip para a aplicação Node.js da hospedagem (o `package.json` fica na raiz).
2. Configure a aplicação: **Node 18 ou mais novo** (ideal 20 ou 22) e comando de início **`npm start`** (ou arquivo de início **`index.js`**). A hospedagem roda o `npm install` sozinha.
3. Clique em **Iniciar**. Abra o endereço do site e, na primeira vez, **crie o usuário e a senha do administrador**. Pronto.

Não precisa criar `.env`: na primeira inicialização o sistema gera sozinho as chaves de segurança e de notificação (arquivo `data/secrets.json`) e cria o banco (`data/data.db`).

**Requisitos da hospedagem**
- **Domínio com HTTPS** (certificado válido). Sem HTTPS o celular não instala o app nem libera notificações.
- **Saída para a internet**: os avisos passam pelo serviço de push do Google, Mozilla ou Apple.
- **Alcançar os MikroTiks**: o servidor precisa conectar no IP e na porta API (padrão 8728) de cada um (`/ip service enable api`). Restrinja essa porta ao IP do servidor. Hospedagem compartilhada costuma bloquear conexões de saída em portas diferentes: se o painel mostrar tudo "Offline", prefira uma VPS.
- **Pasta `data/` persistente**: guarda o banco e as chaves. Se a hospedagem apaga arquivos a cada atualização, defina a variável `DATA_DIR` apontando para uma pasta que fica. **Faça backup da pasta `data/` inteira** (banco e chaves juntos; sem as chaves as senhas dos MikroTiks não podem ser lidas).
- cPanel: *Setup Node.js App* → Application root = pasta do projeto, Startup file = `index.js` → *Run NPM Install* → *Start/Restart*.

Variáveis opcionais (painel da hospedagem ou arquivo `.env`, modelo em `.env.example`): `DATA_DIR`, `PORT`, `ADMIN_USER`/`ADMIN_PASS`, `VAPID_SUBJECT`, `MONITOR_INTERVAL_SEC`, `CLIENT_TOKEN_TTL`, `TRUST_PROXY`.

**Esqueceu a senha do administrador?** Defina `ADMIN_USER` e `ADMIN_PASS` nas variáveis da hospedagem e reinicie: elas passam a valer no lugar da senha cadastrada.

## Alertas: automáticos e isolados por ID
- Em *MikroTik → Editar e alertas* o administrador liga, para aquele ID, os alertas **offline**, **CPU alta** e **memória alta** (com o limite em %).
- **Cada alerta pertence a um único ID e só avisa os CPFs vinculados a esse ID.** Não existe regra "para todos". Um CPF que está em dois IDs recebe um aviso separado de cada um; um CPF que não está no ID nunca recebe.
- O **servidor** verifica os equipamentos a cada 60 s e envia o aviso quando o problema começa e quando termina, sem repetir. "Offline" só dispara após 2 falhas seguidas (evita alarme falso). Funciona **mesmo com o app fechado**: o aviso chega pelo celular. Tocar nele abre o painel daquele ID.
- Único envio que não é por ID: o **aviso manual** (*Alertas → Enviar notificação agora*), que o administrador escolhe enviar para todos, um ID ou um CPF.

## Instalar no celular (cliente)
- **Android**: abrir o endereço no Chrome e tocar em *Instalar o app*.
- **iPhone/iPad (iOS 16.4 ou mais novo)**: Safari → Compartilhar → *Adicionar à Tela de Início* → abrir pelo ícone novo. Só assim o iPhone libera avisos.
- Em cada aparelho: entrar com o CPF e tocar em **Ativar avisos** (o celular exige esse toque).
- Android com economia de bateria agressiva (Xiaomi, Huawei) pode atrasar avisos: liberar o app da otimização de bateria.

## Segurança
- Senhas dos MikroTiks e senha do administrador ficam só no servidor (AES-256-GCM e bcrypt) e nunca vão ao celular.
- Login só por CPF é fraco por natureza (CPF não é segredo). Há limite de tentativas por IP, mas considere um segundo fator (SMS/WhatsApp) antes de expor dados sensíveis.
- A sessão do cliente dura 30 dias (app instalado); a do administrador, 12 h.
- Abra o site logo após o primeiro "Iniciar": enquanto não existir administrador, qualquer pessoa que acessar o endereço poderia criá-lo.

# Manual de Uso — Painel Vendly (dash.vendly.chat)

> Base de conhecimento para o agente de atendimento. Este documento ensina o cliente a usar o
> painel da automação de WhatsApp (Vendly), passo a passo. Linguagem simples, voltada a quem
> nunca usou. Sempre que possível, oriente o cliente exatamente como descrito aqui.

## O que é o painel Vendly

O painel em **dash.vendly.chat** é onde o cliente configura a automação de atendimento no WhatsApp:
conecta seus números, cria agentes de inteligência artificial, ensina o que eles sabem e acompanha
tudo. O agente de IA responde os clientes no WhatsApp 24 horas por dia, sozinho.

## Como entrar (login)

1. Acesse **dash.vendly.chat**.
2. Entre com o **mesmo e-mail e senha da conta em redatudo.online**.
3. É necessário ter uma **assinatura ativa** da automação. Sem assinatura ativa, o acesso fica bloqueado — nesse caso, oriente a pessoa a assinar em redatudo.online.

Se a pessoa esqueceu a senha, ela recupera pela conta em redatudo.online (mesma conta).

## Visão geral do painel

No menu lateral esquerdo:
- **WhatsApp e agentes** — conectar números e criar/gerenciar os agentes.
- **Conhecimento** — ensinar o agente sobre o negócio (base de conhecimento).
- **Postagens agendadas** — programar mensagens automáticas.
- **Configurações** — conta, manutenção e parada de emergência.

No topo, à direita:
- **Central de Conversas** — abre o histórico de todas as conversas (onde um humano pode assumir o atendimento).
- **Menu do usuário** — mostra o ID da conta e a opção Sair.

> Importante: os menus Conhecimento e Postagens agendadas só liberam **depois que houver pelo menos um WhatsApp conectado**.

## Passo 1 — Conectar um WhatsApp

1. Vá em **WhatsApp e agentes**.
2. Clique em **Conectar um WhatsApp**.
3. Dê um nome para identificar o número (ex.: "Atendimento", "Delivery", "Loja Centro"). É só para organização.
4. Clique em **Criar e gerar QR**.
5. Vai aparecer um **QR code**. No celular: abra o **WhatsApp → Aparelhos conectados → Conectar um aparelho** e aponte a câmera para o QR.
6. Quando conectar, o status muda para **Conectado**. Se o QR expirar, clique em **Atualizar**; para reconectar depois, use o botão **Reconectar / QR**.

Pode conectar **quantos números quiser**. Em cada número é possível ter **um agente**, ou **vários agentes** (ex.: um para o grupo do restaurante e outro para o dos entregadores).

## Passo 2 — Criar um agente

Dentro de um WhatsApp conectado, clique em **Adicionar agente a este WhatsApp**. O agente tem 5 abas:

### Aba "Identidade"
- **Nome do agente**: só para o cliente organizar (não aparece para o cliente final).
- **Instruções do agente** (o mais importante): descreva quem é o agente, inclusive **o nome com que ele se apresenta**, a personalidade, o que ele deve fazer e quando usar cada ação. Exemplo: "Você é a Sofia, atendente da Loja X. Seja simpática e objetiva. Se pedirem o endereço, envie a localização."

### Aba "Ações"
Habilite e configure o que o agente pode fazer além de conversar. Cada ação só funciona **depois de configurada** (com os itens que ela usa). Ações disponíveis:
- **Enviar um menu de opções**
- **Reagir com emoji**
- **Enviar uma figurinha**
- **Etiquetar a conversa (CRM)** — marca o contato com uma etiqueta.
- **Remover etiqueta da conversa (CRM)**
- **Enviar um arquivo** (PDF, imagem, etc.)
- **Enviar uma localização**
- **Compartilhar um contato**
- **Notificar (avisar) um contato ou grupo** — o destinatário é escolhido de uma lista pré-configurada (por segurança, o agente nunca digita um número solto).

### Aba "Integrações"
Conectar APIs externas (sistemas do próprio cliente) para o agente consultar dados. É opcional e voltado a quem tem um sistema próprio.

### Aba "Quem ele atende"
Por padrão o agente responde **a todos** naquele número. Só restrinja se houver **mais de um agente no mesmo número**:
- **Responder a todos, EXCETO os bloqueados** (lista de bloqueio), ou
- **Responder SOMENTE aos permitidos** (lista de permitidos).
Use números com DDI/DDD (ex.: 5511999998888) ou IDs de grupo (terminam em @g.us).

### Aba "Grupos"
Em grupos o agente só responde se uma condição for atendida. Ligue/desligue:
- **Responder quando mencionado (@)**
- **Responder quando respondem a uma mensagem dele**
- **Responder a todas as mensagens do grupo**

Ao terminar, salve. O agente começa a atender assim que o WhatsApp estiver **Conectado** e o agente estiver **Ativo**.

## Gerenciar agentes

Na lista de cada WhatsApp, cada agente tem:
- **Pausar / Retomar** — pausar faz o agente **parar de responder**, mas o número continua conectado. Retomar volta a responder.
- **Editar** — reabre as abas de configuração.
- **Remover** (lixeira) — apaga o agente e a base de conhecimento dele. **O WhatsApp continua conectado.**

Diferença importante:
- **Remover o agente** = tira só o agente; o número segue conectado.
- **Remover o WhatsApp** (lixeira no topo do cartão do número) = desconecta o número e remove os agentes dele.

## Áudio e mídia (já vem pronto)

O agente **entende áudios** (mensagens de voz do cliente), **lê imagens, fotos, PDFs e documentos**, e **responde em áudio** quando o cliente manda áudio ou pede resposta em voz. Não precisa configurar nada para isso — já é automático.

## Base de Conhecimento (ensinar o agente)

Em **Conhecimento**, o cliente ensina o agente sobre o negócio. É o que faz o agente responder com precisão.

1. Selecione o **agente** no topo.
2. Clique em **Novo item**.
3. Preencha:
   - **Título** (ex.: "Horário de funcionamento").
   - **Categoria**: Informações do negócio, Produto / Serviço, FAQ, Fluxo de objetivo, Perfil de cliente, ou Geral.
   - **Conteúdo**: o texto que o agente vai consultar.
4. Salve. Use **Ver**, **Editar** (lápis) ou **Remover** (lixeira) nos itens existentes. Dá para **filtrar por categoria**.

Dica: quanto mais completa a base (preços, prazos, políticas, perguntas frequentes), menos o agente erra e menos precisa de um humano.

## Postagens agendadas

Em **Postagens agendadas**, o cliente programa mensagens automáticas recorrentes.

1. Clique em **Nova postagem** (precisa ter um agente criado).
2. **O que enviar**:
   - **Texto fixo** — a mesma mensagem sempre.
   - **Gerar com IA** — descreva o que a IA deve escrever; ela cria uma mensagem nova a cada envio.
   - Opcional: **Incluir uma imagem gerada por IA** (descreva a imagem; se vazio, usa o texto como base).
3. **Quando enviar**: escolha os **dias da semana**, o **horário (HH:MM)** e o **fuso horário**.
4. **Para quem** (adicione um ou mais destinos):
   - **Contato** — digite o telefone (ex.: 5531999998888).
   - **Grupo** — escolha o grupo na lista (aparece quando o WhatsApp está conectado).
   - **Status** — publica no Status do WhatsApp.
5. Salve. Depois é possível **Pausar/Retomar**, **Editar** ou **Remover** cada postagem, e filtrar por agente.

## Central de Conversas e atendimento humano

O botão **Central de Conversas** (topo) abre o histórico de todas as conversas. Lá um atendente humano pode **assumir** uma conversa — quando isso acontece, o agente de IA **para de responder** aquele contato (para não atrapalhar). Quando o atendente **resolve/devolve** a conversa, o agente volta a atender automaticamente.

## Configurações

Na aba **Configurações**:
- **Minha conta**: e-mail, plano, status e o nome da empresa (editável).
- **Itens de configuração pendentes**: se aparecer um aviso amarelo, clique em **Resolver** — o sistema corrige sozinho provisionamentos que não terminaram (ex.: uma instabilidade momentânea). Quando está tudo certo, aparece "Tudo provisionado e funcionando".
- **Limpar histórico de conversas**: apaga a memória do agente (ele "esquece" o que foi conversado). Pode ser **de um cliente específico** (escolha o agente + número) ou **de todos os clientes de um agente**. Isso **não apaga** as mensagens no WhatsApp do cliente, só a memória interna. Útil quando o agente "travou" em algo antigo.
- **Parada total**: **Pausar todos os agentes** (param de responder na hora, sem desconectar o número) e **Reativar todos**. Use em emergências ou fora do horário.

## Perguntas frequentes e solução de problemas

**O agente não está respondendo. Por quê?**
Verifique, em ordem:
1. O **WhatsApp está Conectado**? (status no cartão do número). Se estiver "Aguardando conexão", clique em Conectar e escaneie o QR.
2. O **agente está Ativo**? Se estiver "Pausado", clique em **Retomar**.
3. Em **Parada total** (Configurações), os agentes não foram pausados em massa? Se sim, **Reativar todos**.
4. A aba **"Quem ele atende"** não está bloqueando aquele número?
5. Se for **grupo**, as regras da aba **Grupos** permitem? (ele pode estar configurado para responder só quando mencionado.)
6. Um **humano assumiu** a conversa na Central de Conversas? Aí o agente fica em silêncio até a conversa ser resolvida/devolvida.

**O QR code não aparece ou expirou.** Clique em **Atualizar** no quadro do QR. Se persistir, feche e abra de novo pelo botão **Reconectar / QR**.

**Apareceu um aviso de "configuração pendente".** Vá em **Configurações** e clique em **Resolver**. Ele corrige automaticamente.

**Quero parar tudo agora (emergência).** Configurações → **Pausar todos os agentes**. Para voltar, **Reativar todos**.

**O agente respondeu errado / ficou preso num assunto antigo.** Configurações → **Limpar histórico** daquele cliente (ou de todos) e melhore a Base de Conhecimento.

**Quero que o agente saiba algo novo (preço, horário, política).** Adicione na **Base de Conhecimento** (Conhecimento → Novo item).

**Posso ter vários números e vários agentes?** Sim. Quantos números quiser, e em cada número um ou vários agentes.

**Pausar o agente desconecta o WhatsApp?** Não. Pausar só silencia as respostas; o número continua conectado.

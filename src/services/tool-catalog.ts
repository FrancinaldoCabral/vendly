/**
 * tool-catalog.ts — Curated actions an agent can perform during a conversation.
 *
 * Principle: the LLM NEVER invents content. Every action's content is pre-configured
 * by the client (menus, allowed reactions, stickers, CRM labels, files, locations,
 * contacts). The agent only DECIDES WHEN to fire and WHICH configured item to use
 * (by its label). The platform injects all sensitive fields (which WhatsApp, the
 * contact's number, message id, conversation id).
 */

export type AssetKind = 'menus' | 'reactions' | 'stickers' | 'labels' | 'files' | 'locations' | 'contacts';

export interface CatalogTool {
  id: string;            // tool name exposed to the LLM
  label: string;         // friendly name in the UI
  description: string;
  example: string;
  category: string;
  asset: AssetKind;      // every action draws from configured content
  /** The single LLM param whose enum is filled with the configured item labels. */
  assetParam: string;
  params: Record<string, unknown>;
}

export const TOOL_CATALOG: CatalogTool[] = [
  {
    id: 'acao_enviar_menu',
    label: 'Enviar um menu de opções',
    description: 'O agente envia um dos menus que você cadastrou (uma lista de opções numerada). O cliente responde em texto e o agente age sobre a escolha.',
    example: 'O cliente quer agendar → o agente envia o menu "Horários" e segue conforme a resposta.',
    category: 'Ações',
    asset: 'menus',
    assetParam: 'menu',
    params: {
      type: 'object',
      required: ['menu'],
      properties: { menu: { type: 'string', description: 'Qual menu enviar (use exatamente um dos rótulos disponíveis)' } },
    },
  },
  {
    id: 'acao_reagir',
    label: 'Reagir com emoji',
    description: 'O agente reage a uma mensagem da conversa com uma das reações que você cadastrou (cada reação tem um rótulo e um emoji). Por padrão reage à ÚLTIMA mensagem do cliente.',
    example: 'O cliente diz "obrigado" → o agente usa a reação "Agradecimento" (👍) na mensagem dele.',
    category: 'Ações',
    asset: 'reactions',
    assetParam: 'reacao',
    params: {
      type: 'object',
      required: ['reacao'],
      properties: {
        reacao: { type: 'string', description: 'Qual reação usar (use exatamente um dos rótulos disponíveis)' },
        mensagem_id: { type: 'string', description: 'Opcional: o id exato da mensagem a reagir (veja a lista de mensagens recentes). Deixe vazio para reagir à última mensagem do cliente.' },
        referencia: { type: 'string', description: 'Opcional: um trecho da mensagem a reagir, caso não tenha o id.' },
      },
    },
  },
  {
    id: 'acao_enviar_figurinha',
    label: 'Enviar uma figurinha',
    description: 'O agente envia uma das figurinhas (stickers) da sua marca que você cadastrou.',
    example: 'O cliente fecha o pedido → o agente manda a figurinha "Comemoração".',
    category: 'Conteúdo',
    asset: 'stickers',
    assetParam: 'figurinha',
    params: {
      type: 'object',
      required: ['figurinha'],
      properties: { figurinha: { type: 'string', description: 'Qual figurinha enviar (use exatamente um dos rótulos disponíveis)' } },
    },
  },
  {
    id: 'acao_etiquetar',
    label: 'Etiquetar a conversa (CRM)',
    description: 'O agente marca a conversa atual com uma das etiquetas que você cadastrou, para organizar/segmentar no painel. Invisível para o cliente.',
    example: 'O cliente demonstra interesse de compra → o agente etiqueta a conversa como "Lead quente".',
    category: 'Organização',
    asset: 'labels',
    assetParam: 'etiqueta',
    params: {
      type: 'object',
      required: ['etiqueta'],
      properties: { etiqueta: { type: 'string', description: 'Qual etiqueta aplicar (use exatamente um dos rótulos disponíveis)' } },
    },
  },
  {
    id: 'acao_enviar_arquivo',
    label: 'Enviar um arquivo',
    description: 'O agente envia um dos arquivos que você cadastrou (imagem, vídeo ou documento).',
    example: 'O cliente pede o cardápio → o agente envia o PDF "Cardápio".',
    category: 'Conteúdo',
    asset: 'files',
    assetParam: 'arquivo',
    params: {
      type: 'object',
      required: ['arquivo'],
      properties: { arquivo: { type: 'string', description: 'Qual arquivo enviar (use exatamente um dos rótulos disponíveis)' } },
    },
  },
  {
    id: 'acao_enviar_localizacao',
    label: 'Enviar uma localização',
    description: 'O agente envia um dos endereços que você cadastrou, como ponto no mapa.',
    example: 'O cliente pergunta onde fica a loja → o agente envia "Loja Centro".',
    category: 'Conteúdo',
    asset: 'locations',
    assetParam: 'local',
    params: {
      type: 'object',
      required: ['local'],
      properties: { local: { type: 'string', description: 'Qual local enviar (use exatamente um dos rótulos disponíveis)' } },
    },
  },
  {
    id: 'acao_enviar_contato',
    label: 'Compartilhar um contato',
    description: 'O agente compartilha um dos contatos que você cadastrou.',
    example: 'O cliente quer falar com o financeiro → o agente envia o contato "Financeiro".',
    category: 'Conteúdo',
    asset: 'contacts',
    assetParam: 'contato',
    params: {
      type: 'object',
      required: ['contato'],
      properties: { contato: { type: 'string', description: 'Qual contato enviar (use exatamente um dos rótulos disponíveis)' } },
    },
  },
];

export const CATALOG_BY_ID = new Map(TOOL_CATALOG.map(t => [t.id, t]));

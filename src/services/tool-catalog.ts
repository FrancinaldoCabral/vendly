/**
 * tool-catalog.ts — Curated actions an agent can perform during a conversation.
 *
 * Principle: the LLM NEVER invents content. Every action's content is pre-configured
 * by the client (polls, allowed emojis, files, locations, contacts). The agent only
 * DECIDES WHEN to fire and WHICH configured item to use (by its label). The platform
 * injects all sensitive fields (which WhatsApp, the contact's number, message id).
 */

export type AssetKind = 'polls' | 'reactions' | 'files' | 'locations' | 'contacts';

export interface CatalogTool {
  id: string;            // tool name exposed to the LLM
  label: string;         // friendly name in the UI
  description: string;
  example: string;
  category: string;
  asset: AssetKind;      // every action draws from configured content
  /** The single LLM param whose enum is filled with the configured item labels (or emojis). */
  assetParam: string;
  params: Record<string, unknown>;
}

export const TOOL_CATALOG: CatalogTool[] = [
  {
    id: 'acao_enviar_enquete',
    label: 'Enviar uma enquete',
    description: 'O agente envia uma das enquetes que você cadastrou (pergunta + opções prontas).',
    example: 'O cliente quer agendar → o agente envia a enquete "Horários".',
    category: 'Ações',
    asset: 'polls',
    assetParam: 'enquete',
    params: {
      type: 'object',
      required: ['enquete'],
      properties: { enquete: { type: 'string', description: 'Qual enquete enviar (use exatamente um dos rótulos disponíveis)' } },
    },
  },
  {
    id: 'acao_reagir',
    label: 'Reagir com emoji',
    description: 'O agente reage a uma mensagem da conversa usando um dos emojis que você permitiu.',
    example: 'O cliente confirma o pedido → o agente reage com 👍.',
    category: 'Ações',
    asset: 'reactions',
    assetParam: 'emoji',
    params: {
      type: 'object',
      required: ['emoji'],
      properties: {
        emoji: { type: 'string', description: 'Qual emoji usar (use exatamente um dos permitidos)' },
        referencia: { type: 'string', description: 'Opcional: um trecho da mensagem a reagir, se não for a última.' },
      },
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

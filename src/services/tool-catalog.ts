/**
 * tool-catalog.ts — Curated, brand-free catalog of actions an agent can perform
 * during a conversation. Written for business owners (no Evolution/Chatwoot/API
 * jargon). Each action exposes to the LLM ONLY the content it must decide; the
 * platform injects the rest (which WhatsApp, the contact's number, message id…)
 * in agent-loop. Actions that need content the agent can't invent (a file, an
 * address, a contact card) draw from per-agent "assets" the client configures.
 */

export type AssetKind = 'files' | 'locations' | 'contacts';

export interface CatalogTool {
  id: string;            // tool name exposed to the LLM
  label: string;         // friendly name in the UI
  description: string;   // what it does
  example: string;       // 💡 when the agent would use it
  category: string;      // UI grouping
  /** If set, this action picks from the agent's configured assets of this kind. */
  asset?: AssetKind;
  /** JSON-schema of what the LLM provides. Dynamic enums (asset labels) are filled at runtime. */
  params: Record<string, unknown>;
}

export const TOOL_CATALOG: CatalogTool[] = [
  {
    id: 'acao_enviar_enquete',
    label: 'Criar uma enquete',
    description: 'O agente cria uma enquete (votação) para o cliente escolher uma opção. O agente monta a pergunta e as opções conforme a conversa.',
    example: 'Para agendar, o agente manda uma enquete com os horários disponíveis.',
    category: 'Durante a conversa',
    params: {
      type: 'object',
      required: ['pergunta', 'opcoes'],
      properties: {
        pergunta: { type: 'string', description: 'A pergunta da enquete' },
        opcoes: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 12, description: 'As opções de resposta' },
        multipla: { type: 'boolean', description: 'Permitir escolher mais de uma opção (padrão: não)' },
      },
    },
  },
  {
    id: 'acao_reagir',
    label: 'Reagir com emoji',
    description: 'O agente reage com um emoji a uma mensagem da conversa (por padrão, a última). Pode reagir a uma mensagem anterior informando um trecho dela.',
    example: 'O cliente confirma o endereço → o agente reage com 👍. Ou dá um 👍 numa mensagem específica que ele citar.',
    category: 'Durante a conversa',
    params: {
      type: 'object',
      required: ['emoji'],
      properties: {
        emoji: { type: 'string', description: 'Um único emoji, ex.: 👍 ❤️ 🎉' },
        referencia: { type: 'string', description: 'Opcional: um trecho do texto da mensagem a reagir, se não for a última.' },
      },
    },
  },
  {
    id: 'acao_enviar_arquivo',
    label: 'Enviar um arquivo (imagem, vídeo ou documento)',
    description: 'O agente envia um dos arquivos que você cadastrou (ex.: cardápio, catálogo, tabela de preços).',
    example: 'O cliente pede o cardápio → o agente envia o PDF do cardápio.',
    category: 'Conteúdo cadastrado',
    asset: 'files',
    params: {
      type: 'object',
      required: ['arquivo'],
      properties: { arquivo: { type: 'string', description: 'Qual arquivo enviar (use exatamente um dos rótulos disponíveis)' } },
    },
  },
  {
    id: 'acao_enviar_localizacao',
    label: 'Enviar uma localização no mapa',
    description: 'O agente envia um dos endereços que você cadastrou, como ponto no mapa.',
    example: 'O cliente pergunta onde fica a loja → o agente envia a localização.',
    category: 'Conteúdo cadastrado',
    asset: 'locations',
    params: {
      type: 'object',
      required: ['local'],
      properties: { local: { type: 'string', description: 'Qual local enviar (use exatamente um dos rótulos disponíveis)' } },
    },
  },
  {
    id: 'acao_enviar_contato',
    label: 'Compartilhar um contato',
    description: 'O agente compartilha um dos contatos que você cadastrou (ex.: financeiro, suporte, um vendedor).',
    example: 'O cliente quer falar com o financeiro → o agente envia o contato dele.',
    category: 'Conteúdo cadastrado',
    asset: 'contacts',
    params: {
      type: 'object',
      required: ['contato'],
      properties: { contato: { type: 'string', description: 'Qual contato enviar (use exatamente um dos rótulos disponíveis)' } },
    },
  },
];

export const CATALOG_BY_ID = new Map(TOOL_CATALOG.map(t => [t.id, t]));

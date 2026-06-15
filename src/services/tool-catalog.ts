/**
 * tool-catalog.ts — Curated, brand-free catalog of built-in tools a client can
 * enable per agent. Labels are written for business owners, NOT programmers:
 * no mention of Evolution / Chatwoot / APIs. Each id maps to a real built-in tool.
 *
 * The dashboard renders these as friendly toggles with teaching captions.
 */

export interface CatalogTool {
  id: string;            // real built-in tool name (used by agent-loop)
  label: string;         // friendly name shown in the UI
  description: string;   // teaching caption
  example: string;       // "quando usar" — a concrete situation for the customer
  category: string;      // grouping in the UI
  behavior: 'void';      // these run and the agent confirms (no payload back to the model)
}

export const TOOL_CATALOG: CatalogTool[] = [
  // ── Mensagens ricas ────────────────────────────────────────────────────────
  {
    id: 'evolution_send_media',
    label: 'Enviar imagem, vídeo ou arquivo',
    description: 'O agente envia fotos, vídeos ou documentos quando a conversa pedir.',
    example: 'O cliente pede o cardápio → o agente manda o PDF do cardápio.',
    category: 'Mensagens',
    behavior: 'void',
  },
  {
    id: 'evolution_send_audio',
    label: 'Enviar áudio (mensagem de voz)',
    description: 'O agente responde com uma mensagem de voz quando fizer sentido.',
    example: 'O cliente manda um áudio → o agente responde também em áudio.',
    category: 'Mensagens',
    behavior: 'void',
  },
  {
    id: 'evolution_send_sticker',
    label: 'Enviar figurinha',
    description: 'Deixa o atendimento mais leve com figurinhas nos momentos certos.',
    example: 'Ao fechar um pedido, o agente manda uma figurinha comemorando.',
    category: 'Mensagens',
    behavior: 'void',
  },
  {
    id: 'evolution_send_reaction',
    label: 'Reagir a uma mensagem',
    description: 'O agente reage com um emoji (👍 ❤️ 😂) à mensagem do cliente.',
    example: 'O cliente confirma o endereço → o agente reage com 👍.',
    category: 'Mensagens',
    behavior: 'void',
  },
  // ── Negócio ─────────────────────────────────────────────────────────────────
  {
    id: 'evolution_send_location',
    label: 'Enviar localização no mapa',
    description: 'O agente compartilha um endereço direto no mapa.',
    example: 'O cliente pergunta onde fica a loja → o agente envia o ponto no mapa.',
    category: 'Negócio',
    behavior: 'void',
  },
  {
    id: 'evolution_send_contact',
    label: 'Compartilhar um contato',
    description: 'O agente envia um cartão de contato (telefone de alguém).',
    example: 'O cliente quer falar com o financeiro → o agente envia o contato dele.',
    category: 'Negócio',
    behavior: 'void',
  },
  {
    id: 'evolution_send_poll',
    label: 'Criar uma enquete',
    description: 'O agente cria uma enquete para o cliente escolher uma opção.',
    example: 'Para agendar, o agente manda uma enquete com os horários disponíveis.',
    category: 'Negócio',
    behavior: 'void',
  },
  {
    id: 'evolution_check_number',
    label: 'Verificar número de WhatsApp',
    description: 'O agente confere se um número existe no WhatsApp.',
    example: 'Antes de cadastrar um contato, confere se o número é válido.',
    category: 'Negócio',
    behavior: 'void',
  },
  // ── Atendimento ──────────────────────────────────────────────────────────────
  {
    id: 'chatwoot_assign_conversation',
    label: 'Chamar um atendente humano',
    description: 'O agente passa a conversa para a sua equipe quando precisa de uma pessoa.',
    example: 'O cliente pede para falar com um humano → o agente transfere para a equipe.',
    category: 'Atendimento',
    behavior: 'void',
  },
  {
    id: 'chatwoot_update_conversation_status',
    label: 'Encerrar o atendimento',
    description: 'O agente marca a conversa como resolvida quando o assunto termina.',
    example: 'O pedido foi concluído e o cliente agradeceu → o agente encerra.',
    category: 'Atendimento',
    behavior: 'void',
  },
];

/** Real tool ids that exist in the curated catalog (for validation). */
export const CATALOG_IDS = new Set(TOOL_CATALOG.map(t => t.id));

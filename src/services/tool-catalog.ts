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
  category: string;      // grouping in the UI
  behavior: 'void';      // these run and the agent confirms (no payload back to the model)
}

export const TOOL_CATALOG: CatalogTool[] = [
  // ── Mensagens ricas ────────────────────────────────────────────────────────
  {
    id: 'evolution_send_media',
    label: 'Enviar imagem, vídeo ou arquivo',
    description: 'Permite que o agente envie fotos, vídeos ou documentos (ex.: cardápio, catálogo, comprovante).',
    category: 'Mensagens',
    behavior: 'void',
  },
  {
    id: 'evolution_send_audio',
    label: 'Enviar áudio (mensagem de voz)',
    description: 'O agente pode enviar uma mensagem de voz quando fizer sentido.',
    category: 'Mensagens',
    behavior: 'void',
  },
  {
    id: 'evolution_send_sticker',
    label: 'Enviar figurinha',
    description: 'Deixa o atendimento mais leve com figurinhas em momentos certos.',
    category: 'Mensagens',
    behavior: 'void',
  },
  {
    id: 'evolution_send_reaction',
    label: 'Reagir a uma mensagem',
    description: 'O agente reage com um emoji (👍 ❤️ 😂) à mensagem do cliente.',
    category: 'Mensagens',
    behavior: 'void',
  },
  // ── Negócio ─────────────────────────────────────────────────────────────────
  {
    id: 'evolution_send_location',
    label: 'Enviar localização no mapa',
    description: 'Compartilha o endereço do seu negócio (ou outro ponto) direto no mapa.',
    category: 'Negócio',
    behavior: 'void',
  },
  {
    id: 'evolution_send_contact',
    label: 'Compartilhar um contato',
    description: 'Envia um cartão de contato (ex.: telefone do suporte, de um vendedor).',
    category: 'Negócio',
    behavior: 'void',
  },
  {
    id: 'evolution_send_poll',
    label: 'Criar uma enquete',
    description: 'O agente cria uma enquete para o cliente votar (ex.: escolher horário, sabor).',
    category: 'Negócio',
    behavior: 'void',
  },
  {
    id: 'evolution_check_number',
    label: 'Verificar número de WhatsApp',
    description: 'Confere se um número existe no WhatsApp antes de enviar algo.',
    category: 'Negócio',
    behavior: 'void',
  },
  // ── Atendimento / CRM ────────────────────────────────────────────────────────
  {
    id: 'chatwoot_assign_conversation',
    label: 'Encaminhar para um atendente humano',
    description: 'Transfere a conversa para a sua equipe quando o cliente precisa de uma pessoa.',
    category: 'Atendimento',
    behavior: 'void',
  },
  {
    id: 'chatwoot_update_conversation_status',
    label: 'Marcar conversa como resolvida',
    description: 'O agente fecha o atendimento quando o assunto é concluído.',
    category: 'Atendimento',
    behavior: 'void',
  },
];

/** Real tool ids that exist in the curated catalog (for validation). */
export const CATALOG_IDS = new Set(TOOL_CATALOG.map(t => t.id));

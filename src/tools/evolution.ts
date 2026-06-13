import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config.js';
import { createClient, safeRequest, toText } from '../utils/http.js';

const client = () =>
  createClient(config.evolution.url, {
    apikey: config.evolution.apiKey,
    'Content-Type': 'application/json',
  });

export const evolutionTools: Tool[] = [
  {
    name: 'evolution_list_instances',
    description: 'Lista todas as instâncias do WhatsApp configuradas na Evolution API com status de conexão.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'evolution_create_instance',
    description: 'Cria uma nova instância do WhatsApp na Evolution API.',
    inputSchema: {
      type: 'object',
      required: ['instanceName'],
      properties: {
        instanceName: { type: 'string', description: 'Nome único da instância' },
        token: { type: 'string', description: 'Token opcional para a instância' },
        qrcode: { type: 'boolean', description: 'Gerar QR code automaticamente (padrão true)' },
        integration: {
          type: 'string',
          enum: ['WHATSAPP-BAILEYS', 'WHATSAPP-BUSINESS'],
          description: 'Tipo de integração',
        },
        webhook: { type: 'string', description: 'URL do webhook para esta instância' },
        webhookByEvents: { type: 'boolean', description: 'Webhook por eventos separados' },
        chatwootAccountId: { type: 'string', description: 'ID da conta Chatwoot para integração' },
        chatwootToken: { type: 'string', description: 'Token Chatwoot para integração' },
      },
    },
  },
  {
    name: 'evolution_get_instance',
    description: 'Obtém status e informações de uma instância específica.',
    inputSchema: {
      type: 'object',
      required: ['instanceName'],
      properties: { instanceName: { type: 'string' } },
    },
  },
  {
    name: 'evolution_delete_instance',
    description: 'Remove uma instância da Evolution API.',
    inputSchema: {
      type: 'object',
      required: ['instanceName'],
      properties: { instanceName: { type: 'string' } },
    },
  },
  {
    name: 'evolution_get_qrcode',
    description: 'Obtém o QR code de conexão para uma instância desconectada.',
    inputSchema: {
      type: 'object',
      required: ['instanceName'],
      properties: { instanceName: { type: 'string' } },
    },
  },
  {
    name: 'evolution_send_text',
    description: 'Envia uma mensagem de texto via WhatsApp. Para @mencionar em grupos, passe o JID em mentionedList E escreva @NUMERO no texto.',
    inputSchema: {
      type: 'object',
      required: ['instanceName', 'number', 'text'],
      properties: {
        instanceName: { type: 'string' },
        number: { type: 'string', description: 'Número com código do país (ex: 5511999999999) ou JID do grupo' },
        text: { type: 'string' },
        delay: { type: 'number', description: 'Delay em ms antes de enviar' },
        mentionedList: { type: 'array', items: { type: 'string' }, description: 'JIDs a mencionar nativamente' },
        mentionsEveryOne: { type: 'boolean', description: 'Menciona @Todos no grupo' },
        quoted: { type: 'object', description: 'Mensagem a citar: { key: { id: "MESSAGE_ID" } }' },
      },
    },
  },
  {
    name: 'evolution_send_media',
    description: 'Envia mídia (imagem, vídeo, documento) via WhatsApp.',
    inputSchema: {
      type: 'object',
      required: ['instanceName', 'number', 'mediatype', 'media'],
      properties: {
        instanceName: { type: 'string' },
        number: { type: 'string' },
        mediatype: { type: 'string', enum: ['image', 'video', 'document'] },
        mimetype: { type: 'string' },
        media: { type: 'string', description: 'URL ou base64 da mídia' },
        caption: { type: 'string' },
        fileName: { type: 'string' },
        delay: { type: 'number' },
        quoted: { type: 'object' },
      },
    },
  },
  {
    name: 'evolution_send_audio',
    description: 'Envia áudio como mensagem de voz PTT via WhatsApp.',
    inputSchema: {
      type: 'object',
      required: ['instanceName', 'number', 'audio'],
      properties: {
        instanceName: { type: 'string' },
        number: { type: 'string' },
        audio: { type: 'string', description: 'URL ou base64 do áudio' },
        delay: { type: 'number' },
        quoted: { type: 'object' },
      },
    },
  },
  {
    name: 'evolution_send_sticker',
    description: 'Envia um sticker via WhatsApp.',
    inputSchema: {
      type: 'object',
      required: ['instanceName', 'number', 'sticker'],
      properties: {
        instanceName: { type: 'string' },
        number: { type: 'string' },
        sticker: { type: 'string' },
        delay: { type: 'number' },
        quoted: { type: 'object' },
      },
    },
  },
  {
    name: 'evolution_send_location',
    description: 'Envia uma localização GPS via WhatsApp.',
    inputSchema: {
      type: 'object',
      required: ['instanceName', 'number', 'name', 'address', 'latitude', 'longitude'],
      properties: {
        instanceName: { type: 'string' },
        number: { type: 'string' },
        name: { type: 'string' },
        address: { type: 'string' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
        delay: { type: 'number' },
        quoted: { type: 'object' },
      },
    },
  },
  {
    name: 'evolution_send_contact',
    description: 'Envia cartões de contato via WhatsApp.',
    inputSchema: {
      type: 'object',
      required: ['instanceName', 'number', 'contact'],
      properties: {
        instanceName: { type: 'string' },
        number: { type: 'string' },
        contact: { type: 'array', items: { type: 'object' } },
      },
    },
  },
  {
    name: 'evolution_send_reaction',
    description: 'Envia uma reação emoji em uma mensagem. String vazia remove a reação.',
    inputSchema: {
      type: 'object',
      required: ['instanceName', 'remoteJid', 'messageId', 'reaction'],
      properties: {
        instanceName: { type: 'string' },
        remoteJid: { type: 'string' },
        fromMe: { type: 'boolean' },
        messageId: { type: 'string' },
        reaction: { type: 'string' },
      },
    },
  },
  {
    name: 'evolution_send_poll',
    description: 'Cria e envia uma enquete via WhatsApp.',
    inputSchema: {
      type: 'object',
      required: ['instanceName', 'number', 'name', 'selectableCount', 'values'],
      properties: {
        instanceName: { type: 'string' },
        number: { type: 'string' },
        name: { type: 'string' },
        selectableCount: { type: 'number' },
        values: { type: 'array', items: { type: 'string' } },
        delay: { type: 'number' },
      },
    },
  },
  {
    name: 'evolution_send_status',
    description: 'Publica um status/story no WhatsApp (texto, imagem ou áudio). Para posts agendados.',
    inputSchema: {
      type: 'object',
      required: ['instanceName', 'type', 'content', 'allContacts'],
      properties: {
        instanceName: { type: 'string' },
        type: { type: 'string', enum: ['text', 'image', 'audio'] },
        content: { type: 'string', description: 'Texto ou URL/base64 da mídia' },
        caption: { type: 'string' },
        backgroundColor: { type: 'string', description: 'Cor hex (ex: #008000)' },
        font: { type: 'number' },
        allContacts: { type: 'boolean' },
        statusJidList: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'evolution_send_chunks',
    description: 'Envia múltiplas mensagens em sequência com delays entre elas (digitação humana natural).',
    inputSchema: {
      type: 'object',
      required: ['instanceName', 'number', 'chunks'],
      properties: {
        instanceName: { type: 'string' },
        number: { type: 'string' },
        delayBetween: { type: 'number', description: 'Delay padrão entre chunks em ms (padrão: 1200)' },
        chunks: {
          type: 'array',
          items: {
            type: 'object',
            required: ['type', 'content'],
            properties: {
              type: { type: 'string', enum: ['text', 'audio', 'sticker', 'image'] },
              content: { type: 'string' },
              caption: { type: 'string' },
              delay: { type: 'number' },
            },
          },
        },
      },
    },
  },
  {
    name: 'evolution_set_webhook',
    description: 'Configura o webhook de uma instância.',
    inputSchema: {
      type: 'object',
      required: ['instanceName', 'url'],
      properties: {
        instanceName: { type: 'string' },
        url: { type: 'string' },
        enabled: { type: 'boolean' },
        events: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'evolution_logout_instance',
    description: 'Desconecta (logout) uma instância do WhatsApp.',
    inputSchema: {
      type: 'object',
      required: ['instanceName'],
      properties: { instanceName: { type: 'string' } },
    },
  },
  {
    name: 'evolution_restart_instance',
    description: 'Reinicia uma instância da Evolution API.',
    inputSchema: {
      type: 'object',
      required: ['instanceName'],
      properties: { instanceName: { type: 'string' } },
    },
  },
  {
    name: 'evolution_check_number',
    description: 'Verifica se números de telefone existem no WhatsApp.',
    inputSchema: {
      type: 'object',
      required: ['instanceName', 'numbers'],
      properties: {
        instanceName: { type: 'string' },
        numbers: { type: 'array', items: { type: 'string' } },
      },
    },
  },
];

type Args = Record<string, unknown>;

export async function handleEvolutionTool(name: string, args: Args): Promise<string> {
  const http = client();

  switch (name) {
    case 'evolution_list_instances': {
      const res = await safeRequest(() => http.get('/instance/fetchInstances').then(r => r.data));
      return toText(res);
    }
    case 'evolution_create_instance': {
      const { instanceName, ...rest } = args;
      const payload: Record<string, unknown> = { instanceName, qrcode: true, ...rest };
      const res = await safeRequest(() => http.post('/instance/create', payload).then(r => r.data));
      return toText(res);
    }
    case 'evolution_get_instance': {
      const res = await safeRequest(() =>
        http.get(`/instance/fetchInstances?instanceName=${args.instanceName}`).then(r => r.data)
      );
      return toText(res);
    }
    case 'evolution_delete_instance': {
      const res = await safeRequest(() =>
        http.delete(`/instance/delete/${args.instanceName}`).then(r => r.data)
      );
      return toText(res);
    }
    case 'evolution_get_qrcode': {
      const res = await safeRequest(() =>
        http.get(`/instance/qrcode/${args.instanceName}?image=true`).then(r => r.data)
      );
      return toText(res);
    }
    case 'evolution_send_text': {
      const { instanceName, number, text, delay, mentionedList, mentionsEveryOne, quoted } = args;
      const payload: Record<string, unknown> = { number, text, delay: delay ?? 0 };
      if (Array.isArray(mentionedList) && mentionedList.length) payload.mentioned = mentionedList;
      if (mentionsEveryOne) payload.mentionsEveryOne = true;
      if (quoted) payload.quoted = quoted;
      const res = await safeRequest(() =>
        http.post(`/message/sendText/${instanceName}`, payload).then(r => r.data)
      );
      return toText(res);
    }
    case 'evolution_send_media': {
      const { instanceName, number, mediatype, mimetype, media, caption, fileName, delay, quoted } = args;
      const payload: Record<string, unknown> = { number, mediatype, media };
      if (mimetype) payload.mimetype = mimetype;
      if (caption) payload.caption = caption;
      if (fileName) payload.fileName = fileName;
      if (delay) payload.delay = delay;
      if (quoted) payload.quoted = quoted;
      const res = await safeRequest(() =>
        http.post(`/message/sendMedia/${instanceName}`, payload).then(r => r.data)
      );
      return toText(res);
    }
    case 'evolution_send_audio': {
      const { instanceName, number, audio, delay, quoted } = args;
      const payload: Record<string, unknown> = { number, audio, delay: delay ?? 0 };
      if (quoted) payload.quoted = quoted;
      const res = await safeRequest(() =>
        http.post(`/message/sendWhatsAppAudio/${instanceName}`, payload).then(r => r.data)
      );
      return toText(res);
    }
    case 'evolution_send_sticker': {
      const { instanceName, number, sticker, delay, quoted } = args;
      const payload: Record<string, unknown> = { number, sticker, delay: delay ?? 0 };
      if (quoted) payload.quoted = quoted;
      const res = await safeRequest(() =>
        http.post(`/message/sendSticker/${instanceName}`, payload).then(r => r.data)
      );
      return toText(res);
    }
    case 'evolution_send_location': {
      const { instanceName, number, name, address, latitude, longitude, delay, quoted } = args;
      const payload: Record<string, unknown> = { number, name, address, latitude, longitude, delay: delay ?? 0 };
      if (quoted) payload.quoted = quoted;
      const res = await safeRequest(() =>
        http.post(`/message/sendLocation/${instanceName}`, payload).then(r => r.data)
      );
      return toText(res);
    }
    case 'evolution_send_contact': {
      const { instanceName, number, contact } = args;
      const res = await safeRequest(() =>
        http.post(`/message/sendContact/${instanceName}`, { number, contact }).then(r => r.data)
      );
      return toText(res);
    }
    case 'evolution_send_reaction': {
      const { instanceName, remoteJid, fromMe, messageId, reaction } = args;
      const payload = { key: { remoteJid, fromMe: fromMe ?? false, id: messageId }, reaction };
      const res = await safeRequest(() =>
        http.post(`/message/sendReaction/${instanceName}`, payload).then(r => r.data)
      );
      return toText(res);
    }
    case 'evolution_send_poll': {
      const { instanceName, number, name, selectableCount, values, delay } = args;
      const payload: Record<string, unknown> = { number, name, selectableCount, values, delay: delay ?? 0 };
      const res = await safeRequest(() =>
        http.post(`/message/sendPoll/${instanceName}`, payload).then(r => r.data)
      );
      return toText(res);
    }
    case 'evolution_send_status': {
      const { instanceName, type, content, caption, backgroundColor, font, allContacts, statusJidList } = args;
      const payload: Record<string, unknown> = { type, content, allContacts };
      if (caption) payload.caption = caption;
      if (backgroundColor) payload.backgroundColor = backgroundColor;
      if (font) payload.font = font;
      if (statusJidList) payload.statusJidList = statusJidList;
      const res = await safeRequest(() =>
        http.post(`/message/sendStatus/${instanceName}`, payload).then(r => r.data)
      );
      return toText(res);
    }
    case 'evolution_send_chunks': {
      const { instanceName, number, chunks, delayBetween } = args;
      const defaultDelay = (delayBetween as number) ?? 1200;
      const results: Array<{ type: string; status: string }> = [];
      for (const chunk of chunks as Array<{ type: string; content: string; caption?: string; delay?: number }>) {
        const ms = chunk.delay ?? defaultDelay;
        await new Promise<void>(resolve => setTimeout(resolve, ms));
        let res: unknown;
        switch (chunk.type) {
          case 'audio':
            res = await safeRequest(() =>
              http.post(`/message/sendWhatsAppAudio/${instanceName}`, { number, audio: chunk.content }).then(r => r.data)
            );
            break;
          case 'sticker':
            res = await safeRequest(() =>
              http.post(`/message/sendSticker/${instanceName}`, { number, sticker: chunk.content }).then(r => r.data)
            );
            break;
          case 'image':
            res = await safeRequest(() =>
              http.post(`/message/sendMedia/${instanceName}`, {
                number, mediatype: 'image', media: chunk.content, caption: chunk.caption,
              }).then(r => r.data)
            );
            break;
          default:
            res = await safeRequest(() =>
              http.post(`/message/sendText/${instanceName}`, { number, text: chunk.content }).then(r => r.data)
            );
        }
        results.push({ type: chunk.type, status: (res as Record<string, unknown>)?.status as string ?? 'sent' });
      }
      return toText({ data: results });
    }
    case 'evolution_set_webhook': {
      const { instanceName, url, enabled, events } = args;
      const payload = {
        url,
        enabled: enabled ?? true,
        events: events ?? ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
      };
      const res = await safeRequest(() =>
        http.post(`/webhook/set/${instanceName}`, payload).then(r => r.data)
      );
      return toText(res);
    }
    case 'evolution_logout_instance': {
      const res = await safeRequest(() =>
        http.delete(`/instance/logout/${args.instanceName}`).then(r => r.data)
      );
      return toText(res);
    }
    case 'evolution_restart_instance': {
      const res = await safeRequest(() =>
        http.put(`/instance/restart/${args.instanceName}`).then(r => r.data)
      );
      return toText(res);
    }
    case 'evolution_check_number': {
      const { instanceName, numbers } = args;
      const res = await safeRequest(() =>
        http.post(`/chat/whatsappNumbers/${instanceName}`, { numbers }).then(r => r.data)
      );
      return toText(res);
    }
    default:
      return `❌ Ferramenta desconhecida: ${name}`;
  }
}

/**
 * media.ts — Multimodal helpers (ported from the original stack-mcp /util endpoints
 * and the N8N wf-entrada/wf-executor media logic).
 *
 * Responsibilities:
 *  - Pull media bytes for a WhatsApp message out of Evolution (base64).
 *  - Transcribe audio to text via the multimodal model.
 *  - Generate speech (TTS) so the agent can reply in audio (mirror behaviour).
 *  - Build OpenRouter multimodal content parts for image / audio / pdf / video.
 *
 * All models come from config — never hardcode them.
 */
import { config } from '../config.js';

// ── PCM → WAV (Gemini TTS returns raw PCM) ───────────────────────────────────

export function pcmToWav(pcmBytes: Uint8Array, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
  const dataSize = pcmBytes.length;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataSize, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  wav.writeUInt16LE(channels * bitsPerSample / 8, 32); wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36); wav.writeUInt32LE(dataSize, 40);
  Buffer.from(pcmBytes).copy(wav, 44);
  return wav;
}

// ── Media classification ─────────────────────────────────────────────────────

export type MediaKind = 'audio' | 'image' | 'video' | 'document' | 'sticker';

export interface ExtractedMedia {
  kind: MediaKind;
  mimetype: string;
  caption: string;
  /** filename for documents */
  fileName?: string;
}

/**
 * Inspect a raw Evolution `message` object and classify any media it carries.
 * Returns null for plain text messages.
 */
export function classifyEvolutionMedia(message: Record<string, unknown>): ExtractedMedia | null {
  const audio = message.audioMessage as Record<string, unknown> | undefined;
  if (audio) {
    return { kind: 'audio', mimetype: String(audio.mimetype ?? 'audio/ogg'), caption: '' };
  }
  const image = message.imageMessage as Record<string, unknown> | undefined;
  if (image) {
    return { kind: 'image', mimetype: String(image.mimetype ?? 'image/jpeg'), caption: String(image.caption ?? '') };
  }
  const video = message.videoMessage as Record<string, unknown> | undefined;
  if (video) {
    return { kind: 'video', mimetype: String(video.mimetype ?? 'video/mp4'), caption: String(video.caption ?? '') };
  }
  const doc = (message.documentMessage ?? message.documentWithCaptionMessage) as Record<string, unknown> | undefined;
  if (doc) {
    // documentWithCaptionMessage nests the real document one level deeper
    const inner = (doc.message as Record<string, unknown> | undefined)?.documentMessage as Record<string, unknown> | undefined;
    const d = inner ?? doc;
    return {
      kind: 'document',
      mimetype: String(d.mimetype ?? 'application/pdf'),
      caption: String(d.caption ?? ''),
      fileName: String(d.fileName ?? d.title ?? 'documento'),
    };
  }
  const sticker = message.stickerMessage as Record<string, unknown> | undefined;
  if (sticker) {
    return { kind: 'sticker', mimetype: String(sticker.mimetype ?? 'image/webp'), caption: '' };
  }
  return null;
}

// ── Evolution: download media as base64 ──────────────────────────────────────

/**
 * Fetch the decrypted media bytes for a message via Evolution's
 * /chat/getBase64FromMediaMessage endpoint. Returns base64 (no data: prefix).
 */
export async function fetchEvolutionMediaBase64(
  instance: string,
  rawMsg: Record<string, unknown>,
): Promise<{ base64: string; mimetype?: string } | null> {
  const evUrl = config.evolution.url.replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const r = await fetch(`${evUrl}/chat/getBase64FromMediaMessage/${instance}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', apikey: config.evolution.apiKey },
      body: JSON.stringify({ message: rawMsg, convertToMp4: false }),
    });
    if (!r.ok) {
      console.error(`[media] getBase64 failed instance=${instance}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      return null;
    }
    const data = await r.json() as { base64?: string; mimetype?: string };
    if (!data.base64) return null;
    return { base64: data.base64, mimetype: data.mimetype };
  } catch (e) {
    console.error('[media] getBase64 error:', String(e));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Transcription ────────────────────────────────────────────────────────────

/**
 * Transcribe audio (base64) to Portuguese text using the multimodal model.
 * Audio is passed as an image_url data URL — the pattern Gemini multimodal accepts.
 */
export async function transcribeAudio(base64: string, mimetype = 'audio/ogg'): Promise<string> {
  if (!config.openrouter.apiKey) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Authorization': `Bearer ${config.openrouter.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.openrouter.multimodalModel,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Transcreva este áudio para texto em português. Retorne SOMENTE o texto transcrito, sem comentários adicionais.' },
            { type: 'image_url', image_url: { url: `data:${mimetype};base64,${base64}` } },
          ],
        }],
      }),
    });
    if (!r.ok) {
      console.error(`[media] transcribe failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
      return '';
    }
    const data = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
    return (data.choices?.[0]?.message?.content ?? '').trim();
  } catch (e) {
    console.error('[media] transcribe error:', String(e));
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// ── Text-to-speech ───────────────────────────────────────────────────────────

/**
 * Generate speech for `text`. Returns base64 audio (WAV for Gemini PCM, else mp3).
 * Used to mirror the client: reply in audio when they spoke / asked for audio.
 */
export async function generateTts(text: string): Promise<{ base64: string; mimetype: string } | null> {
  if (!config.openrouter.apiKey || !text.trim()) return null;
  const model = config.openrouter.ttlModel;
  const isGemini = model.toLowerCase().includes('gemini');
  const voice = isGemini ? config.openrouter.ttsVoice : 'alloy';
  const responseFormat = isGemini ? 'pcm' : 'mp3';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const r = await fetch('https://openrouter.ai/api/v1/audio/speech', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Authorization': `Bearer ${config.openrouter.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text, voice, response_format: responseFormat }),
    });
    if (!r.ok) {
      console.error(`[media] TTS failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
      return null;
    }
    const rawBuf = new Uint8Array(await r.arrayBuffer());
    if (responseFormat === 'pcm') {
      return { base64: pcmToWav(rawBuf, 24000, 1, 16).toString('base64'), mimetype: 'audio/wav' };
    }
    return { base64: Buffer.from(rawBuf).toString('base64'), mimetype: 'audio/mpeg' };
  } catch (e) {
    console.error('[media] TTS error:', String(e));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Build OpenRouter multimodal content part ─────────────────────────────────

/**
 * Build the content part for a piece of media to feed the chat model.
 * - image/video → image_url data URL
 * - document (pdf etc.) → file part
 * Audio is handled upstream (transcribed to text), not here.
 */
export function buildMediaContentPart(kind: MediaKind, base64: string, mimetype: string, fileName?: string): unknown | null {
  const dataUrl = `data:${mimetype};base64,${base64}`;
  if (kind === 'image' || kind === 'sticker' || kind === 'video') {
    return { type: 'image_url', image_url: { url: dataUrl } };
  }
  if (kind === 'document') {
    return { type: 'file', file: { filename: fileName ?? 'documento', file_data: dataUrl } };
  }
  return null;
}

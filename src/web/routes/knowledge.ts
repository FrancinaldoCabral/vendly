/**
 * knowledge.ts — Knowledge base CRUD (per-agent Qdrant collections)
 * Collection: agent_{agentId}
 *
 * A knowledge "item" is a logical unit (a pasted text or an uploaded document). On ingestion the
 * text is split into smaller CHUNKS, and each chunk becomes its own Qdrant point sharing a stable
 * `groupId`. This makes semantic search far more precise (a query matches the relevant slice, not
 * one giant blob). The dashboard still sees one row per item: the GET endpoint groups points back
 * by `groupId`. Editing an item re-chunks AND re-embeds (fixing the old bug where edits kept the
 * stale vector). Files (PDF/DOCX/TXT/MD) are accepted as base64 and extracted to text server-side.
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { getDb } from '../../tools/mongodb.js';

export const knowledgeRouter = Router();

const qdrantBase = config.qdrant.url.replace(/\/$/, '');
const qdrantHeaders = () => ({
  'Content-Type': 'application/json',
  ...(config.qdrant.apiKey ? { 'api-key': config.qdrant.apiKey } : {}),
});

// ── Chunking ─────────────────────────────────────────────────────────────────
// Target ~1400 chars (~350 tokens) per chunk: small enough for precise retrieval, large enough to
// keep a coherent idea. Splits on paragraph boundaries, packing paragraphs until the limit; a
// single oversized paragraph is split by sentences, then hard-cut as a last resort.
const MAX_CHARS = 1400;

function chunkText(input: string): string[] {
  const text = input.replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  if (text.length <= MAX_CHARS) return [text];

  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = '';

  const flush = () => { if (buf.trim()) chunks.push(buf.trim()); buf = ''; };

  for (const para of paragraphs) {
    if (para.length > MAX_CHARS) {
      flush();
      // Split the long paragraph by sentences, packing into chunks.
      const sentences = para.match(/[^.!?\n]+[.!?]*\s*/g) ?? [para];
      let sbuf = '';
      for (const s of sentences) {
        if ((sbuf + s).length > MAX_CHARS && sbuf) { chunks.push(sbuf.trim()); sbuf = ''; }
        if (s.length > MAX_CHARS) {
          // Hard-cut a single giant sentence.
          for (let i = 0; i < s.length; i += MAX_CHARS) chunks.push(s.slice(i, i + MAX_CHARS).trim());
        } else {
          sbuf += s;
        }
      }
      if (sbuf.trim()) chunks.push(sbuf.trim());
      continue;
    }
    if ((buf + '\n\n' + para).length > MAX_CHARS && buf) flush();
    buf = buf ? `${buf}\n\n${para}` : para;
  }
  flush();
  return chunks.filter(Boolean);
}

// ── Embeddings ───────────────────────────────────────────────────────────────
async function embed(input: string): Promise<number[]> {
  const r = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openrouter.apiKey}` },
    body: JSON.stringify({ model: config.openrouter.embeddingModel, input }),
  });
  const data = await r.json() as { data?: { embedding: number[] }[] };
  const vector = data.data?.[0]?.embedding;
  if (!vector) throw new Error('Falha ao gerar embedding');
  return vector;
}

interface ItemMeta {
  title: string;
  category: string;
  agentId: string;
  tenantId: string;
  source?: 'text' | 'file' | 'url';
  fileName?: string;
  sourceUrl?: string;
  createdAt?: string;
}

/** Build Qdrant points (one per chunk) for a logical item, embedding each chunk with its title for context. */
async function buildPoints(groupId: string, fullText: string, meta: ItemMeta) {
  const chunks = chunkText(fullText);
  if (chunks.length === 0) throw new Error('Conteúdo vazio.');
  const createdAt = meta.createdAt ?? new Date().toISOString();
  const points = [];
  for (let i = 0; i < chunks.length; i++) {
    const vector = await embed(`${meta.title}: ${chunks[i]}`);
    points.push({
      id: randomUUID(),
      vector,
      payload: {
        groupId,
        title: meta.title,
        text: chunks[i],
        category: meta.category || 'general',
        agentId: meta.agentId,
        tenantId: meta.tenantId,
        createdAt,
        chunkIndex: i,
        chunkCount: chunks.length,
        source: meta.source ?? 'text',
        ...(meta.fileName ? { fileName: meta.fileName } : {}),
        ...(meta.sourceUrl ? { sourceUrl: meta.sourceUrl } : {}),
        // The full original text lives only on the first chunk, so the editor can reconstruct it.
        ...(i === 0 ? { fullText } : {}),
      },
    });
  }
  return points;
}

async function resolveCollection(agentId: string, tenantId: string): Promise<string | null> {
  if (!agentId) return null;
  const db = await getDb();
  const filter: Record<string, unknown> = { _id: agentId };
  if (tenantId !== '__admin__') filter.tenantId = tenantId;
  const agent = await db.collection('agents').findOne(filter, { projection: { _id: 1 } });
  return agent ? `agent_${agentId}` : null;
}

interface RawPoint { id: string | number; payload?: Record<string, unknown> }

/** Scroll all points of an agent (knowledge bases are small; one pass is fine). */
async function scrollPoints(collection: string, agentId: string): Promise<RawPoint[]> {
  const r = await fetch(`${qdrantBase}/collections/${collection}/points/scroll`, {
    method: 'POST',
    headers: qdrantHeaders(),
    body: JSON.stringify({
      limit: 4096, with_payload: true, with_vector: false,
      filter: { must: [{ key: 'agentId', match: { value: agentId } }] },
    }),
  });
  const data = await r.json() as { result?: { points: RawPoint[] } };
  return data.result?.points ?? [];
}

/** Point ids that make up a logical item (by groupId; legacy single-point items match by raw id). */
async function groupPointIds(collection: string, agentId: string, groupId: string): Promise<(string | number)[]> {
  const points = await scrollPoints(collection, agentId);
  const ids = points
    .filter(p => (p.payload?.groupId ?? String(p.id)) === groupId)
    .map(p => p.id);
  return ids;
}

async function deletePoints(collection: string, ids: (string | number)[]): Promise<void> {
  if (ids.length === 0) return;
  await fetch(`${qdrantBase}/collections/${collection}/points/delete`, {
    method: 'POST', headers: qdrantHeaders(), body: JSON.stringify({ points: ids }),
  });
}

async function upsertPoints(collection: string, points: unknown[]): Promise<void> {
  await fetch(`${qdrantBase}/collections/${collection}/points`, {
    method: 'PUT', headers: qdrantHeaders(), body: JSON.stringify({ points }),
  });
}

// ── Content extraction (no hard whitelist — route by type, reject only the truly unreadable) ──

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

/** Rough HTML → plain text: drop scripts/styles, turn block tags into line breaks, strip the rest. */
function htmlToText(html: string): string {
  let s = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  // Decode the most common HTML entities.
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

/** Heuristic: too many NUL/replacement chars means it's binary, not text. */
function looksBinary(s: string): boolean {
  if (!s) return true;
  const sample = s.slice(0, 4000);
  let bad = 0;
  for (const ch of sample) { const c = ch.charCodeAt(0); if (c === 0 || c === 0xFFFD) bad++; }
  return bad / sample.length > 0.1;
}

const EXTRACT_PROMPT = 'Extraia TODO o texto presente neste arquivo e descreva de forma objetiva o conteúdo relevante para uma base de conhecimento de atendimento (tabelas, valores, instruções, etc.). Preserve a ordem. Responda em português, apenas com o conteúdo, sem comentários seus.';

/**
 * Read an image or PDF via the multimodal model (no OCR, no pdfjs/DOM dependency).
 * Images go as image_url; PDFs go as a `file` part with OpenRouter's free `pdf-text` parser plugin.
 */
async function extractViaModel(buffer: Buffer, mime: string, fileName: string, kind: 'image' | 'pdf'): Promise<string> {
  const dataUrl = `data:${mime || (kind === 'pdf' ? 'application/pdf' : 'image/png')};base64,${buffer.toString('base64')}`;
  const body: Record<string, unknown> = {
    model: config.openrouter.multimodalModel,
    messages: [{
      role: 'user',
      content: kind === 'pdf'
        ? [{ type: 'text', text: EXTRACT_PROMPT }, { type: 'file', file: { filename: fileName, file_data: dataUrl } }]
        : [{ type: 'text', text: EXTRACT_PROMPT }, { type: 'image_url', image_url: { url: dataUrl } }],
    }],
  };
  // For PDFs, ask OpenRouter to extract the text server-side (free engine) before the model reads it.
  if (kind === 'pdf') body.plugins = [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }];

  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openrouter.apiKey}` },
    body: JSON.stringify(body),
  });
  const d = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
  return (d.choices?.[0]?.message?.content ?? '').trim();
}

/** Extract text from any supported file, choosing the strategy by extension/mime. */
async function extractFromFile(buffer: Buffer, fileName: string, mime: string): Promise<string> {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();

  if (ext === 'pdf' || mime === 'application/pdf') {
    const t = await extractViaModel(buffer, mime || 'application/pdf', fileName, 'pdf');
    if (!t) throw new Error('Não foi possível ler este PDF. Tente novamente ou cole o texto.');
    return t;
  }
  if (ext === 'docx' || mime.includes('officedocument.wordprocessingml')) {
    // Loaded on demand so this dependency never runs at app startup.
    const mammoth = (await import('mammoth')).default;
    const result = await mammoth.extractRawText({ buffer });
    return (result.value ?? '').trim();
  }
  if (IMAGE_EXTS.includes(ext) || mime.startsWith('image/')) {
    return extractViaModel(buffer, mime || `image/${ext}`, fileName, 'image');
  }
  if (ext === 'html' || ext === 'htm' || mime.includes('html')) {
    return htmlToText(buffer.toString('utf8'));
  }
  // Anything else: try to read as text (txt, md, csv, json, code, etc.). Reject only real binaries.
  const decoded = buffer.toString('utf8');
  if (looksBinary(decoded)) {
    throw new Error('Não foi possível ler este arquivo como texto. Envie PDF, DOCX, imagem, ou um arquivo de texto.');
  }
  return decoded.trim();
}

// GET /api/knowledge?agentId=&category= — returns one row per logical item (grouped chunks)
knowledgeRouter.get('/', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const agentId = String(req.query.agentId ?? '');
    const collection = await resolveCollection(agentId, tenantId);
    if (!collection) { res.status(400).json({ error: 'agentId obrigatório e válido' }); return; }

    const points = await scrollPoints(collection, agentId);
    const categoryFilter = req.query.category ? String(req.query.category) : '';

    // Group chunk-points back into logical items by groupId (legacy points: their own id is the group).
    const groups = new Map<string, RawPoint[]>();
    for (const p of points) {
      const gid = String(p.payload?.groupId ?? p.id);
      if (!groups.has(gid)) groups.set(gid, []);
      groups.get(gid)!.push(p);
    }

    const items = [...groups.entries()].map(([gid, pts]) => {
      pts.sort((a, b) => Number(a.payload?.chunkIndex ?? 0) - Number(b.payload?.chunkIndex ?? 0));
      const head = pts[0]?.payload ?? {};
      const fullText = (head.fullText as string)
        ?? pts.map(p => String(p.payload?.text ?? '')).join('\n\n');
      return {
        id: gid,
        payload: {
          title: String(head.title ?? ''),
          text: fullText,
          category: String(head.category ?? 'general'),
          agentId,
          tenantId: String(head.tenantId ?? tenantId),
          createdAt: head.createdAt as string | undefined,
          chunkCount: Number(head.chunkCount ?? pts.length),
          source: (head.source as string) ?? 'text',
          fileName: head.fileName as string | undefined,
          sourceUrl: head.sourceUrl as string | undefined,
        },
      };
    })
    .filter(it => !categoryFilter || it.payload.category === categoryFilter)
    .sort((a, b) => String(b.payload.createdAt ?? '').localeCompare(String(a.payload.createdAt ?? '')));

    res.json({ data: items });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST /api/knowledge — create a knowledge item from text (auto-chunks + embeds)
knowledgeRouter.post('/', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const { title, text, category, agentId } = req.body as Record<string, string>;
    if (!title || !text || !agentId) {
      res.status(400).json({ error: 'title, text e agentId são obrigatórios' }); return;
    }
    const collection = await resolveCollection(agentId, tenantId);
    if (!collection) { res.status(404).json({ error: 'Agente não encontrado' }); return; }

    const groupId = randomUUID();
    const points = await buildPoints(groupId, text, { title, category: category ?? 'general', agentId, tenantId, source: 'text' });
    await upsertPoints(collection, points);
    res.status(201).json({ id: groupId, chunkCount: points.length });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST /api/knowledge/upload — create from a file (PDF/DOCX/imagem/HTML/texto) enviado em base64.
// Sem whitelist: o tipo é roteado e só recusamos o que realmente não é legível.
knowledgeRouter.post('/upload', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const { agentId, category, fileName, fileBase64, title } = req.body as Record<string, string>;
    if (!agentId || !fileName || !fileBase64) {
      res.status(400).json({ error: 'agentId, fileName e fileBase64 são obrigatórios' }); return;
    }
    const collection = await resolveCollection(agentId, tenantId);
    if (!collection) { res.status(404).json({ error: 'Agente não encontrado' }); return; }

    const mime = fileBase64.match(/^data:([^;,]+)[;,]/)?.[1] ?? '';
    const buffer = Buffer.from(fileBase64.replace(/^data:[^,]*,/, ''), 'base64');

    const text = (await extractFromFile(buffer, fileName, mime)).trim();
    if (!text) { res.status(422).json({ error: 'Não foi possível extrair texto deste arquivo.' }); return; }

    const groupId = randomUUID();
    const itemTitle = (title && title.trim()) || fileName.replace(/\.[^.]+$/, '');
    const points = await buildPoints(groupId, text, {
      title: itemTitle, category: category ?? 'general', agentId, tenantId, source: 'file', fileName,
    });
    await upsertPoints(collection, points);
    res.status(201).json({ id: groupId, chunkCount: points.length, title: itemTitle });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST /api/knowledge/url — create from a web page (fetch → extract text → chunk → embed)
knowledgeRouter.post('/url', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const { agentId, category, title } = req.body as Record<string, string>;
    let { url } = req.body as Record<string, string>;
    if (!agentId || !url) { res.status(400).json({ error: 'agentId e url são obrigatórios' }); return; }
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

    const collection = await resolveCollection(agentId, tenantId);
    if (!collection) { res.status(404).json({ error: 'Agente não encontrado' }); return; }

    let html = '';
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 20_000);
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (VendlyBot)' }, signal: ctrl.signal });
      clearTimeout(to);
      if (!r.ok) { res.status(422).json({ error: `Não foi possível acessar a página (HTTP ${r.status}).` }); return; }
      html = await r.text();
    } catch {
      res.status(422).json({ error: 'Não foi possível acessar a URL. Verifique o endereço.' }); return;
    }

    const pageTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
    const text = htmlToText(html);
    if (!text) { res.status(422).json({ error: 'A página não tem texto extraível.' }); return; }

    const groupId = randomUUID();
    const itemTitle = (title && title.trim()) || pageTitle || url;
    const points = await buildPoints(groupId, text, {
      title: itemTitle, category: category ?? 'general', agentId, tenantId, source: 'url', sourceUrl: url,
    });
    await upsertPoints(collection, points);
    res.status(201).json({ id: groupId, chunkCount: points.length, title: itemTitle });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// PUT /api/knowledge/:groupId?agentId= — re-chunk AND re-embed (replaces the item's points)
knowledgeRouter.put('/:groupId', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const agentId = String(req.query.agentId ?? req.body.agentId ?? '');
    const collection = await resolveCollection(agentId, tenantId);
    if (!collection) { res.status(404).json({ error: 'Agente não encontrado' }); return; }

    const groupId = req.params.groupId;
    const points = await scrollPoints(collection, agentId);
    const existing = points
      .filter(p => String(p.payload?.groupId ?? p.id) === groupId)
      .sort((a, b) => Number(a.payload?.chunkIndex ?? 0) - Number(b.payload?.chunkIndex ?? 0));
    if (existing.length === 0) { res.status(404).json({ error: 'Item não encontrado' }); return; }

    const head = existing[0].payload ?? {};
    const { title, text, category } = req.body as Record<string, string>;
    const newTitle = title ?? String(head.title ?? '');
    const newCategory = category ?? String(head.category ?? 'general');
    const newText = (text ?? (head.fullText as string) ?? existing.map(p => String(p.payload?.text ?? '')).join('\n\n')).trim();
    if (!newText) { res.status(400).json({ error: 'Conteúdo vazio.' }); return; }

    // Replace: delete old chunk-points, insert freshly chunked + re-embedded ones (same groupId).
    const newPoints = await buildPoints(groupId, newText, {
      title: newTitle, category: newCategory, agentId, tenantId,
      source: (head.source as 'text' | 'file' | 'url') ?? 'text',
      fileName: head.fileName as string | undefined,
      sourceUrl: head.sourceUrl as string | undefined,
      createdAt: head.createdAt as string | undefined,
    });
    await deletePoints(collection, existing.map(p => p.id));
    await upsertPoints(collection, newPoints);
    res.json({ ok: true, chunkCount: newPoints.length });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// DELETE /api/knowledge/:groupId?agentId= — remove all chunk-points of the item
knowledgeRouter.delete('/:groupId', async (req, res) => {
  try {
    const tenantId = req.auth!.tenantId;
    const agentId = String(req.query.agentId ?? '');
    const collection = await resolveCollection(agentId, tenantId);
    if (!collection) { res.status(404).json({ error: 'Agente não encontrado' }); return; }

    const ids = await groupPointIds(collection, agentId, req.params.groupId);
    await deletePoints(collection, ids);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

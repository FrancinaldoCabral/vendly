/**
 * scheduler.ts — Scheduled post runner using node-cron
 * Loads active scheduled_posts from MongoDB at startup and on demand.
 * Executes pipeline[] steps (search, image_gen, fetch_url, compose) then posts.
 */
import cron from 'node-cron';
import { getDb } from '../tools/mongodb.js';
import { config } from '../config.js';
import { uploadFile } from './storage.js';

// ── Types ───────────────────────────────────────────────────────────────────

type PipelineStepType = 'search' | 'image_gen' | 'fetch_url' | 'compose';

interface PipelineStep {
  type: PipelineStepType;
  config: Record<string, unknown>;
}

interface ScheduledPost {
  _id: string;
  agentId: string;
  tenantId: string;
  schedule: {
    days: number[];   // 0=Sunday … 6=Saturday
    time: string;     // 'HH:MM' in 24h
    timezone?: string;
  };
  pipeline: PipelineStep[];
  targets: Array<{
    type: 'contact' | 'group' | 'status';
    jid: string;
  }>;
  status: 'active' | 'paused';
  lastRun?: Date;
  nextRun?: Date;
}

// ── Cron registry ────────────────────────────────────────────────────────────

const activeCrons = new Map<string, cron.ScheduledTask>();

export async function startScheduler(): Promise<void> {
  const db = await getDb();
  const posts = await db.collection('scheduled_posts').find({ status: 'active' }).toArray() as unknown as ScheduledPost[];

  for (const post of posts) {
    schedulePost(post);
  }

  console.log(`[scheduler] Started — ${posts.length} active posts loaded`);
}

export function schedulePost(post: ScheduledPost): void {
  stopPost(post._id);

  const cronExpr = buildCronExpression(post.schedule.days, post.schedule.time);
  if (!cronExpr) {
    console.warn(`[scheduler] Invalid schedule for post ${post._id}:`, post.schedule);
    return;
  }

  const tz = post.schedule.timezone ?? 'America/Sao_Paulo';
  const task = cron.schedule(cronExpr, async () => {
    console.log(`[scheduler] Firing post ${post._id} agent=${post.agentId}`);
    try {
      await runPostPipeline(post);
      await updateLastRun(post._id);
    } catch (e) {
      console.error(`[scheduler] Pipeline error post=${post._id}:`, String(e));
    }
  }, { timezone: tz });

  activeCrons.set(post._id, task);
  console.log(`[scheduler] Scheduled post ${post._id}: ${cronExpr} (${tz})`);
}

export function stopPost(postId: string): void {
  const existing = activeCrons.get(postId);
  if (existing) {
    existing.stop();
    activeCrons.delete(postId);
  }
}

export async function reloadPost(postId: string): Promise<void> {
  const db = await getDb();
  const post = await db.collection<ScheduledPost>('scheduled_posts').findOne({ _id: postId }) as ScheduledPost | null;
  if (!post || post.status !== 'active') {
    stopPost(postId);
    return;
  }
  schedulePost(post);
}

// ── Pipeline execution ───────────────────────────────────────────────────────

async function runPostPipeline(post: ScheduledPost): Promise<void> {
  const context: Record<string, unknown> = {};

  // Execute pipeline steps sequentially, passing context forward
  for (const step of post.pipeline) {
    try {
      const result = await executePipelineStep(step, context, post.agentId, post.tenantId);
      Object.assign(context, result);
    } catch (e) {
      console.error(`[scheduler] Step ${step.type} failed:`, String(e));
      return; // abort pipeline on step failure
    }
  }

  // Post to all targets
  const text = String(context.finalText ?? context.composedText ?? context.searchResult ?? '');
  const imageUrl = String(context.imageUrl ?? '');
  console.log(`[scheduler] post=${post._id} text=${text.length}chars image=${imageUrl ? 'yes' : 'no'} targets=${post.targets.length}`);

  for (const target of post.targets) {
    await sendToTarget(post.agentId, target, text, imageUrl);
  }
}

async function executePipelineStep(
  step: PipelineStep,
  context: Record<string, unknown>,
  agentId: string,
  tenantId: string,
): Promise<Record<string, unknown>> {
  switch (step.type) {
    case 'search': {
      const query = String(step.config.query ?? context.topic ?? '');
      const result = await webSearch(query);
      return { searchResult: result };
    }

    case 'image_gen': {
      const prompt = String(step.config.prompt ?? context.searchResult ?? context.topic ?? '');
      const imageUrl = await generateImage(prompt, tenantId);
      return { imageUrl };
    }

    case 'fetch_url': {
      const url = String(step.config.url ?? '');
      if (!url) return {};
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const text = await r.text();
      return { fetchedContent: text.slice(0, 2000) };
    }

    case 'compose': {
      // Fixed text: send exactly what the user wrote, no LLM call.
      const staticText = typeof step.config.static === 'string' ? step.config.static.trim() : '';
      if (staticText) return { composedText: staticText, finalText: staticText };
      const systemPrompt = String(step.config.systemPrompt ?? 'Você é um assistente criativo.');
      const userPrompt = buildComposePrompt(step.config, context);
      const composed = await callLLM(systemPrompt, userPrompt, agentId);
      return { composedText: composed, finalText: composed };
    }

    default:
      return {};
  }
}

// ── LLM call (for compose step) ─────────────────────────────────────────────

async function callLLM(system: string, user: string, _agentId: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Authorization': `Bearer ${config.openrouter.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.openrouter.chatModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    const data = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? '';
  } finally { clearTimeout(t); }
}

function buildComposePrompt(stepConfig: Record<string, unknown>, context: Record<string, unknown>): string {
  const template = String(stepConfig.prompt ?? 'Crie uma postagem sobre: {topic}');
  let prompt = template;
  for (const [k, v] of Object.entries(context)) {
    prompt = prompt.replace(`{${k}}`, String(v));
  }
  return prompt;
}

// ── Web search (simple DuckDuckGo or config-defined endpoint) ────────────────

async function webSearch(query: string): Promise<string> {
  if (!query) return '';
  try {
    const encoded = encodeURIComponent(query);
    const r = await fetch(
      `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const data = await r.json() as { AbstractText?: string; RelatedTopics?: Array<{ Text?: string }> };
    const abstract = data.AbstractText ?? '';
    const related = (data.RelatedTopics ?? []).slice(0, 3).map(t => t.Text ?? '').filter(Boolean).join('\n');
    return [abstract, related].filter(Boolean).join('\n') || `Sem resultados para: ${query}`;
  } catch (e) {
    return `Erro na busca: ${String(e)}`;
  }
}

// ── Image generation ─────────────────────────────────────────────────────────

async function generateImage(prompt: string, tenantId: string): Promise<string> {
  if (!prompt) return '';
  try {
    // OpenRouter generates images through the chat completions API with image modality — there is
    // NO /images/generations endpoint. The image comes back as a data URL in message.images[].
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: {
        'Authorization': `Bearer ${config.openrouter.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.openrouter.imageModel,
        // recraft-v4.1 only supports the "image" output modality (not "text").
        modalities: ['image'],
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const raw = await r.text();
    if (!r.ok) { console.error(`[scheduler] Image gen ${r.status}: ${raw.slice(0, 250)}`); return ''; }
    let data: { choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }> };
    try { data = JSON.parse(raw); } catch { console.error('[scheduler] Image gen: non-JSON response'); return ''; }
    const url = data.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? '';
    if (!url) { console.log(`[scheduler] Image gen (${config.openrouter.imageModel}): no image returned`); return ''; }
    // Images come back as a base64 data URL. WhatsApp Status needs a real URL (it rejects base64),
    // so upload to our storage and use the public URL everywhere. Fall back to the data URL.
    if (url.startsWith('data:')) {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
      if (m) {
        try {
          const ext = (m[1].split('/')[1] ?? 'png').replace(/[^a-z0-9]/gi, '') || 'png';
          const publicUrl = await uploadFile(tenantId, `post.${ext}`, m[1], Buffer.from(m[2], 'base64'));
          console.log(`[scheduler] Image gen: uploaded → ${publicUrl}`);
          return publicUrl;
        } catch (e) {
          console.warn('[scheduler] Image upload failed, using base64:', String(e));
          return url;
        }
      }
    }
    console.log(`[scheduler] Image gen (${config.openrouter.imageModel}): ok (${url.slice(0, 40)}…)`);
    return url;
  } catch (e) {
    console.error(`[scheduler] Image gen failed:`, String(e));
    return '';
  }
}

// ── Evolution send helpers ───────────────────────────────────────────────────

async function sendToTarget(
  agentId: string,
  target: ScheduledPost['targets'][number],
  text: string,
  imageUrl: string,
): Promise<void> {
  const db = await getDb();
  const agent = await db.collection<{ _id: string; evolutionInstance?: string }>('agents').findOne({ _id: agentId });
  if (!agent?.evolutionInstance) return;
  const instance = agent.evolutionInstance;

  if (target.type === 'status') {
    // WhatsApp Status (Story)
    await sendEvolutionStatus(instance, text, imageUrl);
    return;
  }

  if (imageUrl) {
    await sendEvolutionMedia(instance, target.jid, text, imageUrl);
  } else if (text) {
    await sendEvolutionText(instance, target.jid, text);
  }
}

async function evoPost(instance: string, endpoint: string, body: Record<string, unknown>, label: string): Promise<void> {
  try {
    const r = await fetch(`${config.evolution.url}/message/${endpoint}/${instance}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.evolution.apiKey },
      body: JSON.stringify(body),
    });
    const txt = await r.text();
    console.log(`[scheduler] ${label} → ${r.status} ${txt.slice(0, 160)}`);
  } catch (e) {
    console.error(`[scheduler] ${label} failed:`, String(e));
  }
}

async function sendEvolutionText(instance: string, jid: string, text: string): Promise<void> {
  await evoPost(instance, 'sendText', { number: jid, text }, `sendText ${jid}`);
}

async function sendEvolutionMedia(instance: string, jid: string, caption: string, mediaUrl: string): Promise<void> {
  // Evolution accepts a public URL or raw base64. Generated images come as a data URL → strip prefix.
  const media = mediaUrl.startsWith('data:') ? mediaUrl.replace(/^data:[^;]+;base64,/, '') : mediaUrl;
  await evoPost(instance, 'sendMedia', { number: jid, mediatype: 'image', media, caption }, `sendMedia ${jid}`);
}

async function sendEvolutionStatus(instance: string, text: string, mediaUrl: string): Promise<void> {
  // WhatsApp Status broadcast. Evolution requires the audience (allContacts) and, for text,
  // a background color + font. Media goes as a URL or base64.
  const media = mediaUrl.startsWith('data:') ? mediaUrl.replace(/^data:[^;]+;base64,/, '') : mediaUrl;
  const payload: Record<string, unknown> = media
    ? { type: 'image', content: media, caption: text || undefined, allContacts: true }
    : { type: 'text', content: text, backgroundColor: '#0d9488', font: 1, allContacts: true };
  await evoPost(instance, 'sendStatus', payload, 'sendStatus');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildCronExpression(days: number[], time: string): string | null {
  const [hStr, mStr] = time.split(':');
  const h = parseInt(hStr ?? '', 10);
  const m = parseInt(mStr ?? '', 10);
  if (isNaN(h) || isNaN(m) || days.length === 0) return null;
  const dayList = days.join(',');
  return `${m} ${h} * * ${dayList}`;
}

async function updateLastRun(postId: string): Promise<void> {
  const db = await getDb();
  await db.collection<ScheduledPost>('scheduled_posts').updateOne(
    { _id: postId },
    { $set: { lastRun: new Date() } },
  );
}

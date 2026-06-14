import 'dotenv/config';
import { createServer } from 'node:http';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import crypto from 'node:crypto';

import { n8nTools, handleN8nTool } from './tools/n8n.js';
import { evolutionTools, handleEvolutionTool } from './tools/evolution.js';
import { chatwootTools, handleChatwootTool } from './tools/chatwoot.js';
import { mongodbTools, handleMongodbTool, closeMongo } from './tools/mongodb.js';
import { redisTools, handleRedisTool, closeRedis } from './tools/redis.js';
import { qdrantTools, handleQdrantTool } from './tools/qdrant.js';
import { coolifyTools, handleCoolifyTool } from './tools/coolify.js';
import { intelligenceTools, handleIntelligenceTool } from './tools/intelligence.js';
import { systemTools, handleSystemTool } from './tools/system.js';

import { registerWebhookRoute, handleEvolutionMessageWebhook } from './services/webhook.js';
import { startScheduler } from './services/scheduler.js';
import { findOrCreateTenant, sendWelcomeEmailWithChatwoot, sendMagicLink, provisionAgent, reprovisionEvolutionWebhook } from './services/provisioning.js';
import { getDb } from './tools/mongodb.js';
import { apiRouter } from './web/router.js';
import { config } from './config.js';

// ── Global tool registry (MCP server — all built-ins) ───────────────────────

const ALL_TOOLS = [
  ...n8nTools,
  ...evolutionTools,
  ...chatwootTools,
  ...mongodbTools,
  ...redisTools,
  ...qdrantTools,
  ...coolifyTools,
  ...intelligenceTools,
  ...systemTools,
];

async function routeTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name.startsWith('n8n_'))        return handleN8nTool(name, args);
  if (name.startsWith('evolution_'))  return handleEvolutionTool(name, args);
  if (name.startsWith('chatwoot_'))   return handleChatwootTool(name, args);
  if (name.startsWith('mongo_'))      return handleMongodbTool(name, args);
  if (name.startsWith('redis_'))      return handleRedisTool(name, args);
  if (name.startsWith('qdrant_'))     return handleQdrantTool(name, args);
  if (name.startsWith('coolify_'))    return handleCoolifyTool(name, args);
  if (name.startsWith('intelligence_') || name.startsWith('customer_') || name.startsWith('business_'))
    return handleIntelligenceTool(name, args);
  if (name.startsWith('system_'))     return handleSystemTool(name, args);
  return `❌ Ferramenta não encontrada: ${name}`;
}

// ── MCP Server factory ───────────────────────────────────────────────────────

function makeMcpServer(): Server {
  const srv = new Server(
    { name: 'stack-mcp-v1', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ALL_TOOLS }));

  srv.setRequestHandler(CallToolRequestSchema, async (request): Promise<{ content: CallToolResult['content'] }> => {
    const { name, arguments: args = {} } = request.params;
    try {
      const text = await routeTool(name, args as Record<string, unknown>);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ Erro inesperado: ${String(err)}` }] };
    }
  });

  return srv;
}

// ── PCM → WAV (Gemini TTS) ───────────────────────────────────────────────────

function pcmToWav(pcmBytes: Uint8Array, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
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

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

/** On startup, ensure all existing Evolution instances have MESSAGES_UPSERT in their webhook. */
async function upgradeEvolutionWebhooks(): Promise<void> {
  try {
    const db = await getDb();
    const agents = await db.collection('agents').find(
      {}, { projection: { evolutionInstance: 1 } }
    ).toArray() as Array<{ evolutionInstance?: string }>;

    if (agents.length === 0) return;
    console.log(`[startup] Upgrading Evolution webhooks for ${agents.length} agent(s)`);

    for (const agent of agents) {
      if (!agent.evolutionInstance) continue;
      try {
        await reprovisionEvolutionWebhook(agent.evolutionInstance);
      } catch (e) {
        console.warn(`[startup] webhook upgrade failed for ${agent.evolutionInstance}:`, String(e));
      }
    }
    console.log('[startup] Evolution webhook upgrade complete');
  } catch (e) {
    console.error('[startup] upgradeEvolutionWebhooks failed:', String(e));
  }
}

async function main() {
  const port = config.app.port;

  process.on('SIGINT', async () => { await closeMongo(); await closeRedis(); process.exit(0); });
  process.on('SIGTERM', async () => { await closeMongo(); await closeRedis(); process.exit(0); });
  process.on('uncaughtException', (err) => { console.error('[crash] uncaughtException:', err); });
  process.on('unhandledRejection', (reason) => { console.error('[crash] unhandledRejection:', reason); });

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.resolve(__dirname, '..', 'public');

  const webApp = express();
  webApp.use(express.json({ limit: '4mb' }));

  // ── WooCommerce subscription webhook ──────────────────────────────────────
  webApp.post('/webhooks/woocommerce', async (req, res) => {
    const signature = req.headers['x-wc-webhook-signature'] as string | undefined;
    const secret = config.woocommerce.webhookSecret;

    // Verify HMAC-SHA256 if secret is configured
    if (secret) {
      const body = JSON.stringify(req.body);
      const expected = crypto.createHmac('sha256', secret).update(body).digest('base64');
      if (!signature || signature !== expected) {
        res.status(401).json({ error: 'invalid signature' });
        return;
      }
    }

    res.status(200).json({ ok: true });

    const body = req.body as Record<string, unknown>;
    const email = String(body.billing_email ?? body.email ?? '');
    const name = String(
      body.billing_first_name
        ? `${body.billing_first_name} ${body.billing_last_name ?? ''}`.trim()
        : body.username ?? email
    );
    const woocommerceUserId = String(body.customer_id ?? body.id ?? '');
    const status = String(body.status ?? '');

    if (!email) return;
    // Only provision on active/completed subscriptions
    if (!['active', 'completed', 'processing'].includes(status)) return;

    try {
      // findOrCreateTenant is idempotent, creates Chatwoot account, and handles duplicates
      const normalizedEmail = email.trim().toLowerCase();
      const parsedWcId = parseInt(woocommerceUserId, 10);
      const { tenant, isNew, chatwootSsoUrl } = await findOrCreateTenant(
        normalizedEmail,
        { wcUserId: Number.isFinite(parsedWcId) ? parsedWcId : undefined, wcUserName: name || undefined },
      );
      if (isNew) {
        if (chatwootSsoUrl) {
          await sendWelcomeEmailWithChatwoot(normalizedEmail, tenant.name, tenant._id, chatwootSsoUrl);
        } else {
          await sendMagicLink(normalizedEmail, tenant._id, tenant.name);
        }
        console.log(`[woocommerce] New tenant provisioned: ${normalizedEmail} id=${tenant._id}`);
      } else {
        console.log(`[woocommerce] Existing tenant: ${normalizedEmail} id=${tenant._id}`);
      }
    } catch (e) {
      console.error('[woocommerce] findOrCreateTenant error:', String(e));
    }
  });

  // ── Evolution webhook (connection updates + direct message delivery) ────────
  webApp.post('/webhook/evolution/:instance', async (req, res) => {
    res.status(200).json({ ok: true });

    const { instance } = req.params;
    const body = req.body as Record<string, unknown>;
    const event = String(body.event ?? '').toLowerCase().replace(/[._-]/g, '_');

    console.log(`[evolution-webhook] instance=${instance} event=${event}`);

    if (event === 'connection_update') {
      // Normalize state across Evolution payload variants
      const data = (body.data ?? {}) as Record<string, unknown>;
      const innerInst = (data.instance ?? {}) as Record<string, unknown>;
      const state = String(innerInst.state ?? data.state ?? data.connectionStatus ?? '');

      if (state !== 'open') {
        console.log(`[evolution-webhook] ${instance}: state=${state} — ignoring`);
        return;
      }

      try {
        const db = await getDb();
        const result = await db.collection('agents').findOneAndUpdate(
          { evolutionInstance: instance, status: 'pending_qr' },
          { $set: { status: 'active', updatedAt: new Date() } },
          { returnDocument: 'after' },
        );
        if (result) {
          console.log(`[evolution-webhook] Agent activated: agentId=${result._id} instance=${instance}`);
        } else {
          console.log(`[evolution-webhook] No pending_qr agent found for instance=${instance}`);
        }
      } catch (e) {
        console.error(`[evolution-webhook] DB update failed:`, String(e));
      }
      return;
    }

    if (event === 'messages_upsert') {
      try {
        await handleEvolutionMessageWebhook(instance, body);
      } catch (e) {
        console.error(`[evolution-webhook] messages_upsert error instance=${instance}:`, String(e));
      }
    }
  });

  // ── Chatwoot webhook (per-agent) ──────────────────────────────────────────
  registerWebhookRoute(webApp as unknown as import('express').Router);

  // ── REST API ──────────────────────────────────────────────────────────────
  webApp.use('/api', apiRouter);

  // ── Internal tool REST endpoint (scripts, testing) ────────────────────────
  webApp.post('/tool/:name', async (req, res) => {
    const authKey = req.headers['x-admin-key'] as string | undefined;
    if (authKey !== config.admin.apiKey) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const name = req.params.name;
    const args = (req.body ?? {}) as Record<string, unknown>;
    try {
      const text = await routeTool(name, args);
      res.json({ ok: true, name, result: text });
    } catch (err) {
      res.status(500).json({ ok: false, name, error: String(err) });
    }
  });

  // ── Audio utils (proxy from stack-mcp) ───────────────────────────────────
  webApp.get('/util/audio-base64', async (req, res) => {
    const url = req.query.url as string;
    if (!url) { res.status(400).json({ error: 'url required' }); return; }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') { res.status(403).json({ error: 'Apenas HTTPS permitido' }); return; }
      const host = parsed.hostname;
      if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|localhost|::1)/.test(host)) {
        res.status(403).json({ error: 'URL não permitida' }); return;
      }
    } catch { res.status(400).json({ error: 'URL inválida' }); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const r = await fetch(url, { signal: controller.signal });
      if (!r.ok) { res.status(502).json({ error: `upstream ${r.status}` }); return; }
      const buf = Buffer.from(await r.arrayBuffer());
      let mimeType = r.headers.get('content-type')?.split(';')[0]?.trim() ?? 'audio/ogg';
      if (mimeType === 'application/ogg') mimeType = 'audio/ogg';
      res.json({ base64: buf.toString('base64'), size: buf.length, mimeType });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    } finally { clearTimeout(timer); }
  });

  webApp.post('/util/tts', async (req, res) => {
    const DEFAULT_MODEL = config.openrouter.ttlModel;
    const isGemini = (m: string) => m.toLowerCase().includes('gemini');
    const { text, model = DEFAULT_MODEL } = req.body ?? {};
    const voice: string = (req.body as Record<string, unknown>)?.voice as string
      ?? (isGemini(model as string) ? config.openrouter.ttsVoice : 'alloy');
    if (!text) { res.status(400).json({ error: 'text required' }); return; }
    const authHeader = req.headers.authorization;
    const apiKey = (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null)
      ?? config.openrouter.apiKey;
    if (!apiKey) { res.status(500).json({ error: 'no OpenRouter API key' }); return; }
    const responseFormat = isGemini(model as string) ? 'pcm' : 'mp3';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const r = await fetch('https://openrouter.ai/api/v1/audio/speech', {
        method: 'POST', signal: controller.signal,
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text, voice, response_format: responseFormat }),
      });
      if (!r.ok) {
        const errBody = await r.text();
        res.status(502).json({ error: `OpenRouter TTS ${r.status}`, detail: errBody }); return;
      }
      const rawBuf = new Uint8Array(await r.arrayBuffer());
      const buf = responseFormat === 'pcm' ? pcmToWav(rawBuf, 24000, 1, 16) : Buffer.from(rawBuf);
      res.json({ base64: buf.toString('base64'), size: buf.length });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    } finally { clearTimeout(timer); }
  });

  webApp.post('/util/transcribe', async (req, res) => {
    const { url, base64: inBase64, mimeType: inMimeType = 'audio/ogg' } = req.body ?? {};
    if (!url && !inBase64) { res.status(400).json({ error: 'url or base64 required' }); return; }
    const authHeader = req.headers.authorization;
    const apiKey = (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null)
      ?? config.openrouter.apiKey;
    if (!apiKey) { res.status(500).json({ error: 'no OpenRouter API key' }); return; }
    let audioBase64: string | undefined = inBase64 as string | undefined;
    let mimeType: string = inMimeType as string;
    if (!audioBase64 && url) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url as string);
        const allowedHosts = [
          new URL(config.chatwoot.url).hostname,
          new URL(config.evolution.url).hostname,
        ];
        if (!allowedHosts.includes(parsedUrl.hostname)) {
          res.status(403).json({ error: 'URL não permitida' }); return;
        }
      } catch { res.status(400).json({ error: 'URL inválida' }); return; }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15_000);
      try {
        const fetchHeaders: Record<string, string> = {};
        if (parsedUrl!.hostname === new URL(config.chatwoot.url).hostname && config.chatwoot.apiKey) {
          fetchHeaders['api_access_token'] = config.chatwoot.apiKey;
        }
        const r = await fetch(url as string, { signal: ctrl.signal, headers: fetchHeaders });
        if (!r.ok) { res.status(502).json({ error: `download ${r.status}` }); return; }
        const buf = Buffer.from(await r.arrayBuffer());
        audioBase64 = buf.toString('base64');
        const ct = r.headers.get('content-type');
        if (ct && ct.startsWith('audio/')) mimeType = ct.split(';')[0].trim();
      } catch (err) {
        res.status(500).json({ error: `download: ${String(err)}` }); return;
      } finally { clearTimeout(t); }
    }
    const model = config.openrouter.multimodalModel;
    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), 30_000);
    try {
      const r2 = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', signal: ctrl2.signal,
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: [
            { type: 'text', text: 'Transcreva este áudio para texto em português. Retorne SOMENTE o texto transcrito, sem comentários adicionais.' },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${audioBase64}` } },
          ]}],
        }),
      });
      if (!r2.ok) {
        const errBody = await r2.text();
        res.status(502).json({ error: `OpenRouter ${r2.status}`, detail: errBody }); return;
      }
      const data = await r2.json() as { choices?: Array<{ message?: { content?: string } }> };
      res.json({ transcription: data.choices?.[0]?.message?.content ?? '', model });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    } finally { clearTimeout(t2); }
  });

  // ── SPA fallback ──────────────────────────────────────────────────────────
  webApp.use(express.static(publicDir));
  webApp.get(/^\/(?!api|mcp|health|util|tool|webhook|webhooks).*/, (_req, webRes) => {
    webRes.sendFile(path.join(publicDir, 'index.html'));
  });

  const httpServer = createServer(async (req, res) => {
    if (req.url === '/mcp' || req.url?.startsWith('/mcp?')) {
      const srv = makeMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await srv.connect(transport);
        const raw = await readBody(req);
        const parsedBody = raw ? JSON.parse(raw) : undefined;
        await transport.handleRequest(req, res, parsedBody);
        res.on('close', () => { transport.close(); srv.close(); });
      } catch (err) {
        process.stderr.write(`❌ MCP request error: ${String(err)}\n`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      }
    } else if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    } else {
      webApp(req, res);
    }
  });

  httpServer.listen(port, async () => {
    process.stderr.write(`✅ Stack MCP v1 — porta ${port} — ${ALL_TOOLS.length} ferramentas\n`);
    // Start scheduled posts
    try {
      await startScheduler();
    } catch (e) {
      console.error('[scheduler] Failed to start:', String(e));
    }
    // Upgrade all existing Evolution instances to include MESSAGES_UPSERT
    setTimeout(() => upgradeEvolutionWebhooks().catch(e => console.error('[startup] webhook upgrade error:', String(e))), 5000);
  });
}

main().catch(err => {
  process.stderr.write(`❌ Falha ao iniciar: ${String(err)}\n`);
  process.exit(1);
});

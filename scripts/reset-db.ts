/**
 * reset-db.ts — Wipes all tenant/agent data for a clean slate.
 * Keeps infrastructure (Redis, Qdrant, MongoDB server) intact.
 * Run: npx tsx scripts/reset-db.ts
 *
 * What gets cleared:
 *   MongoDB  → drops the entire `vendly` database
 *   Redis    → FLUSHALL (all keys across all DBs)
 *   Qdrant   → deletes every collection named agent_*
 *
 * What is NOT touched:
 *   Chatwoot → accounts/inboxes must be deleted manually in the super admin
 *   Evolution → instances must be deleted manually (or they'll be re-used by name)
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { Redis } from 'ioredis';

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const REDIS_HOST  = process.env.REDIS_HOST ?? 'localhost';
const REDIS_PORT  = parseInt(process.env.REDIS_PORT ?? '6379', 10);
const REDIS_PASS  = process.env.REDIS_PASSWORD ?? '';
const QDRANT_URL  = process.env.QDRANT_URL ?? 'http://localhost:6333';
const QDRANT_KEY  = process.env.QDRANT_API_KEY ?? '';

async function resetMongo(): Promise<void> {
  console.log('\n── MongoDB ──────────────────────────────');
  const client = new MongoClient(MONGODB_URI, { connectTimeoutMS: 10_000, serverSelectionTimeoutMS: 10_000 });
  try {
    await client.connect();
    const result = await client.db('vendly').dropDatabase();
    console.log(`✅ Database "vendly" dropped: ${result}`);
  } finally {
    await client.close();
  }
}

async function resetRedis(): Promise<void> {
  console.log('\n── Redis ────────────────────────────────');
  const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASS || undefined,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    await redis.flushall();
    console.log('✅ FLUSHALL — all Redis keys cleared');
  } finally {
    redis.disconnect();
  }
}

async function resetQdrant(): Promise<void> {
  console.log('\n── Qdrant ───────────────────────────────');
  const base = QDRANT_URL.replace(/\/$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (QDRANT_KEY) headers['api-key'] = QDRANT_KEY;

  try {
    const res = await fetch(`${base}/collections`, { headers });
    if (!res.ok) { console.warn(`⚠️  Could not list Qdrant collections: ${res.status}`); return; }
    const { result } = await res.json() as { result: { collections: { name: string }[] } };
    const agentCols = result.collections.filter(c => c.name.startsWith('agent_'));

    if (agentCols.length === 0) { console.log('✅ No agent_* collections found'); return; }

    for (const col of agentCols) {
      const del = await fetch(`${base}/collections/${col.name}`, { method: 'DELETE', headers });
      console.log(`${del.ok ? '✅' : '❌'} Deleted collection: ${col.name} (${del.status})`);
    }
  } catch (e) {
    console.warn(`⚠️  Qdrant cleanup failed (non-fatal): ${String(e)}`);
  }
}

async function main(): Promise<void> {
  console.log('🗑️  stack-mcp-v1 — Full DB Reset');
  console.log('═'.repeat(42));

  await resetMongo();
  await resetRedis();
  await resetQdrant();

  console.log('\n═'.repeat(42));
  console.log('✅ Reset complete.');
  console.log('\n⚠️  Manual cleanup still required:');
  console.log('   • Chatwoot: delete orphaned accounts in super admin → /super_admin/accounts');
  console.log('   • Evolution: orphaned instances still exist but will be overwritten on next provision');
  console.log('\nNext step: log in again — a fresh tenant + Chatwoot account will be created.');
}

main().catch(e => { console.error('❌ Reset failed:', e); process.exit(1); });

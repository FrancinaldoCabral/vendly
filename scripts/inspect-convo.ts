/* One-off: dump agent session histories from Redis to inspect a test conversation. */
import { getRedis } from '../src/tools/redis.js';

const redis = getRedis();
const needle = (process.argv[2] ?? '').toLowerCase();

function preview(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => (c?.type === 'text' ? c.text : `[${c?.type}]`)).join(' ');
  }
  return JSON.stringify(content);
}

const keys = await redis.keys('sessao:*');
console.log(`Sessões encontradas: ${keys.length}\n`);

for (const key of keys) {
  const raw = await redis.get(key);
  if (!raw) continue;
  let msgs: Array<{ role: string; content: unknown; tool_calls?: unknown }> = [];
  try { msgs = JSON.parse(raw); } catch { continue; }
  const joined = JSON.stringify(msgs).toLowerCase();
  if (needle && !joined.includes(needle)) continue;

  console.log('═'.repeat(80));
  console.log(`KEY: ${key}  (${msgs.length} mensagens)`);
  console.log('─'.repeat(80));
  for (const m of msgs) {
    const tc = m.tool_calls ? ` [tool_calls: ${JSON.stringify(m.tool_calls).slice(0, 300)}]` : '';
    const body = preview(m.content);
    console.log(`\n[${m.role}]${tc}\n${body.slice(0, 1200)}`);
  }
  console.log('\n');
}

await redis.quit();

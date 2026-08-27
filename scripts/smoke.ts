const BASE = process.env.HERMOD_URL ?? 'http://localhost:3000';
const source = process.env.SMOKE_SOURCE ?? 'chatgpt';
const prompt = process.argv.slice(2).join(' ') || 'What are the three largest countries in Europe by population?';

async function main(): Promise<void> {
  const res = await fetch(`${BASE}/v1/queries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source, prompt, parse: true }),
  });
  const bodyText = await res.text();
  let parsed: unknown = bodyText;
  try {
    parsed = JSON.parse(bodyText);
  } catch {}
  console.log(`HTTP ${res.status}  (x-request-id: ${res.headers.get('x-request-id') ?? 'n/a'})`);
  console.log(JSON.stringify(parsed, null, 2));

  process.exit(res.status < 500 ? 0 : 1);
}

main().catch((e) => {
  console.error('smoke failed to reach the server:', e);
  process.exit(1);
});

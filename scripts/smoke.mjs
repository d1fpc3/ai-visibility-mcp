#!/usr/bin/env node
// Smoke test for the built server, speaking raw JSON-RPC with no SDK in the way.
// 1. stdio: initialize, tools/list, call suggest_questions, call check_visibility with no keys, read a resource.
// 2. HTTP: start with --http, then initialize and tools/list over Streamable HTTP.
// Run `npm run build` first. Exits non-zero on any failure.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const EXPECTED_TOOLS = ['ask_engines', 'check_visibility', 'compare_competitors', 'suggest_questions'];

// No API keys, so the run is free and deterministic.
const env = { ...process.env };
for (const name of [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'PERPLEXITY_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
]) {
  delete env[name];
}

function assert(condition, message) {
  if (!condition) throw new Error(`Smoke test failed: ${message}`);
  console.log(`  ok  ${message}`);
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1.0.0' },
  },
};

async function stdio() {
  console.log('stdio transport');
  const child = spawn(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });

  const pending = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (message) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout on ${message.method}\n${stderr}`)), 10_000);
      pending.set(message.id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      send(message);
    });

  try {
    const init = await request(initialize);
    assert(init.result?.serverInfo?.name === 'ai-visibility-mcp', 'initialize returns serverInfo');
    assert(init.result?.capabilities?.tools, 'server advertises tools');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const list = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.result.tools.map((t) => t.name).sort();
    assert(
      JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS),
      `tools/list returns ${names.join(', ')}`,
    );

    const suggest = await request({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'suggest_questions', arguments: { businessType: 'HVAC company', city: 'Bel Air, MD' } },
    });
    assert(
      suggest.result?.content?.[0]?.text?.includes('10 questions'),
      'suggest_questions works with no keys',
    );

    const check = await request({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'check_visibility',
        arguments: { business: 'Eco-Cool HVAC', questions: ['Best HVAC?'] },
      },
    });
    assert(
      check.result?.isError && check.result.content[0].text.includes('No AI engines are configured'),
      'check_visibility explains that no keys are set',
    );

    const resource = await request({
      jsonrpc: '2.0',
      id: 5,
      method: 'resources/read',
      params: { uri: 'ai-visibility://engines' },
    });
    assert(JSON.parse(resource.result.contents[0].text).engines.length === 0, 'engines resource reads');
    assert(stderr.includes('running on stdio'), 'logs go to stderr, not stdout');
  } finally {
    child.kill();
  }
}

async function http() {
  console.log('Streamable HTTP transport');
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, [entry, '--http', '--port', String(port)], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  try {
    for (let i = 0; i < 50 && !stderr.includes('listening'); i++)
      await new Promise((r) => setTimeout(r, 100));
    assert(stderr.includes(`127.0.0.1:${port}/mcp`), 'HTTP server starts');

    const post = async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      // Responses may come back as an SSE stream: take the JSON from the data line.
      const data = text.includes('data:')
        ? text
            .split('\n')
            .find((l) => l.startsWith('data:'))
            .slice(5)
        : text;
      return JSON.parse(data);
    };

    const init = await post(initialize);
    assert(init.result?.serverInfo?.name === 'ai-visibility-mcp', 'HTTP initialize works');
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert(list.result?.tools?.length === EXPECTED_TOOLS.length, 'HTTP tools/list works');

    const notFound = await fetch(`http://127.0.0.1:${port}/other`);
    assert(notFound.status === 404, 'unknown paths return 404');
  } finally {
    child.kill();
    await once(child, 'exit');
  }
}

await stdio();
await http();
console.log('Smoke test passed.');

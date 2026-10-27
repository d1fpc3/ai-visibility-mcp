#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type AppConfig, configFromEnv } from './config.js';
import { ENGINE_LABELS } from './providers/types.js';
import { AnswerCache } from './run.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';

// stdout carries the MCP protocol, so every log line goes to stderr.
const log = (message: string) => process.stderr.write(`[${SERVER_NAME}] ${message}\n`);

function describe(config: AppConfig): string {
  return config.engines.length
    ? `engines: ${config.engines.map((e) => `${ENGINE_LABELS[e.id]} (${e.model})`).join(', ')}`
    : 'no engines configured, set an API key to enable one';
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

/** Stateless Streamable HTTP: a fresh server and transport per request, sharing one answer cache. */
async function serveHttp(config: AppConfig, port: number): Promise<void> {
  const cache = new AnswerCache(config.run.cacheTtlMs);
  const http = createHttpServer(async (req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found. The MCP endpoint is /mcp.');
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed' },
          id: null,
        }),
      );
      return;
    }
    try {
      const body = await readBody(req);
      const server = createServer(config, { cache });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log(`request failed: ${(err as Error).message}`);
      if (!res.headersSent) {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Bad request' }, id: null }));
      }
    }
  });
  await new Promise<void>((resolve) => http.listen(port, '127.0.0.1', resolve));
  log(`v${SERVER_VERSION} listening on http://127.0.0.1:${port}/mcp, ${describe(config)}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      `${SERVER_NAME} v${SERVER_VERSION}\n\nUsage: ai-visibility-mcp [--http] [--port 3333]\n\n` +
        'Runs over stdio by default. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, PERPLEXITY_API_KEY or GEMINI_API_KEY.\n',
    );
    return;
  }
  const config = configFromEnv();

  if (args.includes('--http')) {
    const portArg = args[args.indexOf('--port') + 1];
    const port = Number(args.includes('--port') ? portArg : (process.env.PORT ?? 3333));
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid port: ${portArg}`);
    await serveHttp(config, port);
    return;
  }

  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  log(`v${SERVER_VERSION} running on stdio, ${describe(config)}`);
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

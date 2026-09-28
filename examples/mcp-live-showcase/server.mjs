#!/usr/bin/env node
/**
 * Reference MCP server (streamable HTTP transport) for exercising real
 * `mcp_servers` behavior against a live Kaltura agent — no mocks, no SDK for
 * MCP itself (Node builtins only, matching this repo's zero-runtime-dep
 * convention). Runnable locally, or behind any HTTPS tunnel/reverse proxy
 * that forwards the `Host` header (every absolute URL below is derived from
 * the request's own Host, so it works unmodified under any public origin).
 *
 * Two mounts, same five tools, one wire difference:
 *   POST /mcp        open — no transport-level auth. Per-attendee/shared
 *                     credentials still ride the request's own headers
 *                     (Authorization, X-Attendee-Id), exactly as they would
 *                     when set via `mcp_servers[name].headers` templating.
 *   POST /mcp/oauth   protected — every request needs a valid Bearer token
 *                     minted by this same server's own OAuth2 endpoints
 *                     (DCR + PKCE authorization-code + refresh). Missing/
 *                     invalid token -> 401 + WWW-Authenticate pointing at
 *                     this server's own protected-resource metadata.
 *
 * Tools (both mounts): echo (trivial), whoami (header echo — the per-attendee
 * assertion hook), counter (stateful, keyed by X-Attendee-Id), slow_op
 * (artificial delay), flaky_op (deterministic failure).
 *
 * OAuth test user auto-approves every /authorize request — no human in the
 * loop, so the full consent+token-exchange+authenticated-call flow scripts
 * end to end. This is a test fixture, not a real consent screen.
 *
 * Run: node examples/mcp-live-showcase/server.mjs [--port 8877]
 * Expose publicly for a live backend to reach it, e.g.:
 *   cloudflared tunnel --url http://localhost:8877
 */
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : (process.env.PORT || 8877));

// ── In-memory state (this is a test fixture — a real server would persist this) ──
const counters = new Map();          // attendeeKey -> count
const oauthClients = new Map();      // client_id -> {client_secret, redirect_uris}
const authCodes = new Map();         // code -> {client_id, redirect_uri, code_challenge, code_challenge_method, scope, expiresAt}
const accessTokens = new Map();      // token -> {client_id, scope, expiresAt}
const refreshTokens = new Map();     // token -> {client_id, scope}

const ACCESS_TOKEN_TTL_S = 3600;
const AUTH_CODE_TTL_MS = 60_000;

function randomToken(prefix) { return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`; }
function base64url(buf) { return buf.toString('base64url'); }
function sha256(input) { return crypto.createHash('sha256').update(input).digest(); }
function json(res, status, body, extraHeaders) {
  res.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}
function originOf(req) { return `https://${req.headers.host}`; }

// ── The five tools, shared by both mounts ──
const TOOLS = [
  { name: 'echo', description: 'Echo back the given text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'whoami', description: 'Report the Authorization/X-Attendee-Id headers this call arrived with.', inputSchema: { type: 'object', properties: {} } },
  { name: 'counter', description: 'Increment and return an in-memory counter keyed by X-Attendee-Id.', inputSchema: { type: 'object', properties: {} } },
  { name: 'slow_op', description: 'Sleep for ms (default 6000) before responding — for client-side timeout testing.', inputSchema: { type: 'object', properties: { ms: { type: 'number' } } } },
  { name: 'flaky_op', description: 'Always fails deterministically — for resilience testing.', inputSchema: { type: 'object', properties: {} } },
];

function toolResult(content, isError) { return { content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content) }], isError: !!isError }; }

async function callTool(name, args, req, authenticatedClientId) {
  const attendeeKey = req.headers['x-attendee-id'] || 'default';
  switch (name) {
    case 'echo':
      return toolResult({ text: args?.text ?? '' });
    case 'whoami': {
      const auth = req.headers['authorization'] || null;
      return toolResult({
        authorizationTail: auth ? auth.slice(-6) : null,
        attendeeId: req.headers['x-attendee-id'] || null,
        authenticatedClientId: authenticatedClientId || null,
      });
    }
    case 'counter': {
      const next = (counters.get(attendeeKey) || 0) + 1;
      counters.set(attendeeKey, next);
      return toolResult({ key: attendeeKey, count: next });
    }
    case 'slow_op': {
      // Bucketed rather than scaled from the raw request: the sink only ever
      // sees one of these four literal constants, never the tainted input
      // itself, so a caller can't hold a timer open past the largest bucket.
      const requested = Number.isFinite(args?.ms) ? args.ms : 6000;
      const ms = requested <= 0 ? 0 : requested < 3000 ? 1000 : requested < 10000 ? 6000 : 15000;
      await new Promise((r) => setTimeout(r, ms));
      return toolResult({ sleptMs: ms });
    }
    case 'flaky_op':
      return toolResult('flaky_op: deterministic failure for live-verify resilience testing', true);
    default:
      throw Object.assign(new Error(`unknown tool ${name}`), { rpcCode: -32602 });
  }
}

// ── JSON-RPC 2.0 over a single POST (streamable HTTP transport, unary form) ──
async function handleRpc(body, req, authenticatedClientId) {
  const { id, method, params } = body;
  if (method === 'notifications/initialized') return null; // notification — no response
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2026-07-28', capabilities: { tools: {} }, serverInfo: { name: 'kaltura-sdk-mcp-live-showcase', version: '1.0.0' } } };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    try {
      const result = await callTool(params?.name, params?.arguments, req, authenticatedClientId);
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      return { jsonrpc: '2.0', id, error: { code: err.rpcCode || -32603, message: err.message } };
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function validAccessToken(req) {
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  const entry = accessTokens.get(token);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry;
}

// ── OAuth2: DCR + PKCE authorization-code + refresh, spec-compliant, test-only ──
function protectedResourceMetadata(req) {
  const origin = originOf(req);
  return { resource: `${origin}/mcp/oauth`, authorization_servers: [origin] };
}
function authorizationServerMetadata(req) {
  const origin = originOf(req);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  };
}

async function handleRegister(req, res) {
  const raw = await readBody(req);
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch { /* empty/invalid body -> defaults below */ }
  const redirectUris = Array.isArray(body.redirect_uris) && body.redirect_uris.length ? body.redirect_uris : [];
  if (redirectUris.length === 0) return json(res, 400, { error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
  const clientId = randomToken('client');
  const clientSecret = randomToken('secret');
  oauthClients.set(clientId, { clientSecret, redirectUris });
  json(res, 201, { client_id: clientId, client_secret: clientSecret, redirect_uris: redirectUris, client_id_issued_at: Math.floor(Date.now() / 1000), client_secret_expires_at: 0 });
}

function handleAuthorize(req, res, url) {
  const q = url.searchParams;
  const clientId = q.get('client_id');
  const redirectUri = q.get('redirect_uri');
  const client = oauthClients.get(clientId);
  if (!client || !redirectUri || !client.redirectUris.includes(redirectUri)) {
    return json(res, 400, { error: 'invalid_request', error_description: 'unknown client_id or redirect_uri' });
  }
  // Auto-approving test user — no human consent screen, so the flow is fully scriptable.
  const code = randomToken('code');
  authCodes.set(code, {
    clientId,
    redirectUri,
    codeChallenge: q.get('code_challenge'),
    codeChallengeMethod: q.get('code_challenge_method') || 'plain',
    scope: q.get('scope') || '',
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });
  const location = new URL(redirectUri);
  location.searchParams.set('code', code);
  if (q.get('state')) location.searchParams.set('state', q.get('state'));
  res.writeHead(302, { location: location.toString() });
  res.end();
}

async function handleToken(req, res) {
  const raw = await readBody(req);
  const params = new URLSearchParams(raw);
  const grantType = params.get('grant_type');

  if (grantType === 'authorization_code') {
    const code = params.get('code');
    const entry = authCodes.get(code);
    if (!entry || entry.expiresAt < Date.now()) return json(res, 400, { error: 'invalid_grant', error_description: 'unknown or expired code' });
    authCodes.delete(code); // single-use
    if (entry.redirectUri !== params.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    const verifier = params.get('code_verifier');
    if (entry.codeChallenge) {
      const expected = entry.codeChallengeMethod === 'S256' ? base64url(sha256(verifier || '')) : verifier;
      if (expected !== entry.codeChallenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }
    const accessToken = randomToken('at');
    const refreshToken = randomToken('rt');
    accessTokens.set(accessToken, { clientId: entry.clientId, scope: entry.scope, expiresAt: Date.now() + ACCESS_TOKEN_TTL_S * 1000 });
    refreshTokens.set(refreshToken, { clientId: entry.clientId, scope: entry.scope });
    return json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refreshToken, scope: entry.scope });
  }

  if (grantType === 'refresh_token') {
    const rt = params.get('refresh_token');
    const entry = refreshTokens.get(rt);
    if (!entry) return json(res, 400, { error: 'invalid_grant', error_description: 'unknown refresh_token' });
    const accessToken = randomToken('at');
    accessTokens.set(accessToken, { clientId: entry.clientId, scope: entry.scope, expiresAt: Date.now() + ACCESS_TOKEN_TTL_S * 1000 });
    return json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_S, scope: entry.scope });
  }

  return json(res, 400, { error: 'unsupported_grant_type', error_description: grantType || '(missing)' });
}

// ── HTTP entry point ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });

  if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') return json(res, 200, protectedResourceMetadata(req));
  if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp/oauth') return json(res, 200, protectedResourceMetadata(req));
  if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') return json(res, 200, authorizationServerMetadata(req));
  if (req.method === 'POST' && url.pathname === '/register') return handleRegister(req, res);
  if (req.method === 'GET' && url.pathname === '/authorize') return handleAuthorize(req, res, url);
  if (req.method === 'POST' && url.pathname === '/token') return handleToken(req, res);

  if (req.method === 'POST' && (url.pathname === '/mcp' || url.pathname === '/mcp/oauth')) {
    if (url.pathname === '/mcp/oauth') {
      const tokenEntry = validAccessToken(req);
      if (!tokenEntry) {
        return json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${originOf(req)}/.well-known/oauth-protected-resource"` });
      }
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); } catch { return json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' } }); }
      const rpcResult = await handleRpc(body, req, tokenEntry.clientId);
      return rpcResult ? json(res, 200, rpcResult) : res.writeHead(202).end();
    }
    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw); } catch { return json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' } }); }
    const rpcResult = await handleRpc(body, req, null);
    return rpcResult ? json(res, 200, rpcResult) : res.writeHead(202).end();
  }

  json(res, 404, { error: 'not_found' });
});

server.listen(PORT, () => {
  console.log(`mcp-live-showcase server listening on http://127.0.0.1:${PORT}`);
  console.log('Open mount:      POST /mcp');
  console.log('OAuth-gated:     POST /mcp/oauth (DCR at /register, PKCE at /authorize + /token)');
  console.log('Expose publicly: cloudflared tunnel --url http://localhost:' + PORT);
});

import crypto from 'crypto';

// Secret used to sign access tokens. Set JWT_SECRET in production (Railway).
const SECRET =
  process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const CODE_TTL_MS = 10 * 60 * 1000; // 10m

// In-memory stores — fine for single-user / personal use.
const authCodes = new Map();
export const clients = new Map();

// ── Metadata documents ──────────────────────────────────────────

export function getResourceMetadata(baseUrl) {
  return {
    resource: baseUrl,
    authorization_servers: [baseUrl],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  };
}

export function getAuthServerMetadata(baseUrl) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  };
}

// ── Dynamic client registration (RFC 7591) ──────────────────────

export function registerClient(data) {
  const clientId = crypto.randomUUID();
  clients.set(clientId, {
    redirectUris: data.redirect_uris || [],
    name: data.client_name || 'client',
  });
  return clientId;
}

// ── Authorization code + PKCE ───────────────────────────────────

export function createAuthCode(clientId, redirectUri, codeChallenge, scope) {
  const code = crypto.randomBytes(32).toString('hex');
  authCodes.set(code, {
    clientId,
    redirectUri,
    codeChallenge,
    scope,
    expiresAt: Date.now() + CODE_TTL_MS,
  });
  return code;
}

export function exchangeCode(code, codeVerifier) {
  const stored = authCodes.get(code);
  if (!stored || Date.now() > stored.expiresAt) {
    authCodes.delete(code);
    return null;
  }
  authCodes.delete(code); // single use

  // Verify PKCE S256: base64url(sha256(verifier)) === stored challenge
  const hash = crypto
    .createHash('sha256')
    .update(codeVerifier || '')
    .digest('base64url');
  if (hash !== stored.codeChallenge) {
    return null;
  }

  const token = signToken({
    sub: stored.clientId,
    scope: stored.scope || 'mcp',
    exp: Date.now() + TOKEN_TTL_MS,
  });

  return { access_token: token, token_type: 'Bearer', expires_in: 86400 };
}

// ── Self-contained signed tokens (HMAC, no external deps) ────────

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', SECRET)
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(body)
    .digest('base64url');
  // Constant-time comparison
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

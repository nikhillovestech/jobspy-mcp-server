import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import cors from 'cors';
import logger from './logger.js';
import SseManager from './sseManager.js';
import {
  searchJobsPrompt,
  jobRecommendationsPrompt,
  resumeFeedbackPrompt,
} from './prompts/index.js';
import { searchJobsTool, searchJobsHandler } from './tools/index.js';
import {
  getResourceMetadata,
  getAuthServerMetadata,
  registerClient,
  createAuthCode,
  exchangeCode,
  verifyToken,
  clients,
} from './oauth.js';

// Environment configuration
// Railway provides PORT; fall back to JOBSPY_PORT then default.
const PORT = process.env.PORT || process.env.JOBSPY_PORT || 9423;
const HOST = process.env.JOBSPY_HOST || '0.0.0.0';
const ENABLE_SSE = !!(process.env.ENABLE_SSE | 0);
const BASE_URL = process.env.BASE_URL || `http://${HOST}:${PORT}`;
// OAuth can be disabled for local stdio/dev use.
const ENABLE_OAUTH = process.env.ENABLE_OAUTH !== '0';

// Bearer-token guard for protected MCP endpoints.
function requireAuth(req, res, next) {
  if (!ENABLE_OAUTH) return next();
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    res.set(
      'WWW-Authenticate',
      `Bearer realm="mcp", resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`,
    );
    return res.status(401).json({ error: 'unauthorized' });
  }
  const payload = verifyToken(auth.slice(7));
  if (!payload) {
    return res.status(401).json({ error: 'invalid_token' });
  }
  req.auth = payload;
  next();
}

// Create the MCP server
const server = new McpServer({
  name: 'JobSpy MCP Server',
  version: '1.0.0',
  description:
    'A Model Context Protocol server that enables searching for jobs across various platforms',
});

const sseManager = new SseManager(server);

searchJobsPrompt(server);
jobRecommendationsPrompt(server);
resumeFeedbackPrompt(server);
searchJobsTool(server, sseManager);

// Factory: build a fresh, fully-registered McpServer.
// Used by the stateless Streamable HTTP endpoint (one server per request),
// which is the transport claude.ai web connects with.
function buildMcpServer() {
  const s = new McpServer({
    name: 'JobSpy MCP Server',
    version: '1.0.0',
    description:
      'A Model Context Protocol server that enables searching for jobs across various platforms',
  });
  const mgr = new SseManager(s);
  searchJobsPrompt(s);
  jobRecommendationsPrompt(s);
  resumeFeedbackPrompt(s);
  searchJobsTool(s, mgr);
  return s;
}

// Initialize transports
let stdioTransport = null;
let httpServer = null;

// Start the server with configured transports
async function runServer() {
  logger.info('Starting JobSpy MCP server...');

  try {
    // Initialize and connect transports
    const connectedTransports = [];

    // Set up SSE transport if enabled
    if (ENABLE_SSE) {
      try {
        // Create Express app
        const app = express();

        // Configure CORS
        app.use(cors());

        // Configure Express middleware
        app.use(express.json());
        app.use(express.urlencoded({ extended: true }));

        // ── OAuth 2.1 endpoints (required by claude.ai web) ──────
        if (ENABLE_OAUTH) {
          // Protected resource metadata (RFC 9728)
          app.get('/.well-known/oauth-protected-resource', (req, res) => {
            res.json(getResourceMetadata(BASE_URL));
          });

          // Authorization server metadata (RFC 8414)
          app.get('/.well-known/oauth-authorization-server', (req, res) => {
            res.json(getAuthServerMetadata(BASE_URL));
          });

          // Dynamic client registration (RFC 7591)
          app.post('/register', (req, res) => {
            const clientId = registerClient(req.body || {});
            res.status(201).json({
              client_id: clientId,
              client_id_issued_at: Math.floor(Date.now() / 1000),
              redirect_uris: (req.body && req.body.redirect_uris) || [],
              grant_types: ['authorization_code'],
              response_types: ['code'],
              token_endpoint_auth_method: 'none',
            });
          });

          // Authorization endpoint — auto-approves (personal use)
          app.get('/authorize', (req, res) => {
            const {
              client_id,
              redirect_uri,
              code_challenge,
              code_challenge_method,
              state,
              scope,
            } = req.query;

            if (!client_id || !clients.has(client_id)) {
              return res.status(400).json({ error: 'invalid_client' });
            }
            if (code_challenge_method !== 'S256') {
              return res.status(400).json({
                error: 'invalid_request',
                error_description: 'Only S256 PKCE is supported',
              });
            }
            if (!redirect_uri) {
              return res.status(400).json({ error: 'invalid_request' });
            }

            const code = createAuthCode(
              client_id,
              redirect_uri,
              code_challenge,
              scope,
            );
            const redirectUrl = new URL(redirect_uri);
            redirectUrl.searchParams.set('code', code);
            if (state) redirectUrl.searchParams.set('state', state);

            res.send(`<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><title>JobSpy MCP — Authorizing</title></head>
  <body style="font-family:sans-serif;text-align:center;padding:2rem">
    <h2>Authorizing JobSpy MCP Server…</h2>
    <p>Redirecting back to Claude…</p>
    <script>window.location.href = ${JSON.stringify(redirectUrl.toString())};</script>
  </body>
</html>`);
          });

          // Token endpoint — exchange auth code for bearer token
          app.post('/token', (req, res) => {
            const { code, code_verifier, grant_type } = req.body || {};
            if (grant_type !== 'authorization_code') {
              return res.status(400).json({ error: 'unsupported_grant_type' });
            }
            const tokenData = exchangeCode(code, code_verifier);
            if (!tokenData) {
              return res.status(400).json({ error: 'invalid_grant' });
            }
            res.json(tokenData);
          });
        }
        // ── End OAuth ─────────────────────────────────────────────

        // Health check endpoint
        app.get('/health', (req, res) => {
          res.status(200).json({ status: 'ok' });
        });

        // ── Streamable HTTP transport (claude.ai web connector) ──
        // Stateless: a fresh server + transport per request.
        app.post('/mcp', requireAuth, async (req, res) => {
          try {
            const mcp = buildMcpServer();
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: undefined, // stateless
            });
            res.on('close', () => {
              transport.close();
              mcp.close?.();
            });
            await mcp.connect(transport);
            await transport.handleRequest(req, res, req.body);
          } catch (error) {
            logger.error('Streamable HTTP request failed', {
              error: error.message,
              stack: error.stack,
            });
            if (!res.headersSent) {
              res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null,
              });
            }
          }
        });

        // Stateless mode has no server-initiated streams; reject GET/DELETE.
        const rejectStateless = (req, res) => {
          res.status(405).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Method not allowed' },
            id: null,
          });
        };
        app.get('/mcp', requireAuth, rejectStateless);
        app.delete('/mcp', requireAuth, rejectStateless);
        // ── End Streamable HTTP ───────────────────────────────────

        // SSE endpoint for client connections
        app.get('/sse', requireAuth, async (req, res) => {
          const transport = sseManager.createTransport('/messages', res);

          res.on('close', () => {
            sseManager.removeTransport(transport.sessionId);
            logger.info(`Client disconnected: ${transport.sessionId}`);
          });

          await server.connect(transport);
          logger.info(`New SSE client connected: ${transport.sessionId}`);
        });

        // Message handling endpoint
        app.post('/messages', requireAuth, async (req, res) => {
          const transport = sseManager.getTransport(req);

          if (transport) {
            await transport.handlePostMessage(req, res, req.body);
          } else {
            res.status(400).send('No transport found for sessionId');
          }
        });

        app.post('/api', async (req, res) => {
          const data = searchJobsHandler(req.body);
          res.json(data);
        });

        // Start the Express server
        httpServer = app.listen(PORT, HOST, () => {
          logger.info(`SSE server listening at http://${HOST}:${PORT}`);
        });

        connectedTransports.push('SSE');

        logger.info(`SSE transport listening at http://${HOST}:${PORT}/sse`);
        logger.info(
          `Send endpoint available at http://${HOST}:${PORT}/messages`,
        );
      } catch (error) {
        logger.error('Failed to connect SSE transport', {
          error: error.message,
          stack: error.stack,
        });
      }
    } else {
      // Set up stdio transport if no SSE
      try {
        stdioTransport = new StdioServerTransport();
        await server.connect(stdioTransport);
        connectedTransports.push('stdio');

        logger.info('Stdio transport connected');
      } catch (error) {
        logger.error('Failed to connect stdio transport', {
          error: error.message,
        });
      }
    }

    // Ensure at least one transport is connected
    if (connectedTransports.length === 0) {
      throw new Error('No transports connected. Check configuration.');
    }

    logger.info(
      `Server successfully connected with transports: ${connectedTransports.join(
        ', ',
      )}`,
    );
  } catch (error) {
    logger.error('Server connection error', {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

// Handle graceful shutdown
async function shutdown() {
  logger.info('Shutting down JobSpy MCP server...');

  try {
    // Disconnect all transports gracefully
    await server.disconnect();

    // Close HTTP server if it exists
    if (httpServer) {
      httpServer.close(() => {
        logger.info('HTTP server closed');
      });
    }

    logger.info('Server shutdown complete');
  } catch (error) {
    logger.error('Error during shutdown', { error: error.message });
  } finally {
    // Give logger time to flush
    setTimeout(() => process.exit(0), 100);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Run the server
runServer().catch((error) => {
  logger.error('Unhandled error in server', { error: error.message });
  process.exit(1);
});

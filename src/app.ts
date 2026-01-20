import Fastify, { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { ZodError } from 'zod';
import type { ErrorResponse } from './schemas/index.js';
import { SQLiteSessionStore } from './utils/sessionStore.js';

// ES modules __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import routes
import healthRoute from './routes/health.js';
import stateRoute from './routes/state.js';
import watchesRoute from './routes/watches.js';
import tradesRoute from './routes/trades.js';
import portfolioRoute from './routes/portfolio.js';
import signalsRoute from './routes/signals.js';
import eventsRoute from './routes/events.js';
import devRoute from './routes/dev.js';
import settingsRoute from './routes/settings.js';
import auditRoute from './routes/audit.js';
import metricsRoute from './routes/metrics.js';
import notifyRoute from './routes/notify.js';
import ohlcRoute from './routes/ohlc.js';
import streamRoute from './routes/stream.js';
import authRoutes from './routes/auth.js';
import secretsRoutes from './routes/secrets.js';
import adminRoutes from './routes/admin.js';

export async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({
        logger: true,
        trustProxy: process.env.TRUST_PROXY === 'true',
    });

    // CORS - only allow specific origin, no wildcard
    const corsOrigin = process.env.CORS_ORIGIN || 'https://kaptanbotui.vercel.app';
    await app.register(cors, {
        origin: corsOrigin.split(','),
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        credentials: true, // Required for sessions
    });

    // Cookie & Session
    await app.register(cookie);
    await app.register(session, {
        secret: process.env.SESSION_SECRET || 'a-very-long-and-secure-random-secret-key-1234567890',
        cookieName: 'sessionId',
        cookie: {
            secure: process.env.NODE_ENV === 'production',
            httpOnly: true,
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
            path: '/',
            maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        },
        store: new SQLiteSessionStore(),
    });

    // FAZ 8: Authentication & IP Allowlist Middleware
    const ipAllowlist = process.env.IP_ALLOWLIST ? process.env.IP_ALLOWLIST.split(',') : [];

    app.addHook('onRequest', async (request, reply) => {
        if (request.method === 'OPTIONS') return; // Skip auth for CORS preflight
        if (request.url === '/health') return; // Always allow health check

        // Skip auth for login/register
        if (request.url === '/auth/login' || request.url === '/auth/register') return;

        // 1. IP Allowlist (Always checked if configured)
        if (ipAllowlist.length > 0) {
            const clientIp = request.ip;
            if (!ipAllowlist.includes(clientIp)) {
                return reply.status(403).send({
                    error: 'IP_NOT_ALLOWED',
                    message: 'Access denied',
                });
            }
        }

        // 2. Session Auth
        // Exclude /docs and /openapi.json from strict auth if needed
        if (request.url.startsWith('/docs') || request.url === '/openapi.json') return;

        const userId = request.session.get('userId');
        if (!userId) {
            return reply.status(401).send({
                error: 'UNAUTHORIZED',
                message: 'Authentication required',
            });
        }
    });

    // FAZ 7: Swagger & OpenAPI
    const openapiSpec = JSON.parse(fs.readFileSync(path.join(__dirname, '../openapi/openapi.json'), 'utf8'));
    await app.register(swagger, {
        openapi: openapiSpec,
    });

    if (process.env.NODE_ENV !== 'production') {
        await app.register(swaggerUi, {
            routePrefix: '/docs',
            uiConfig: {
                docExpansion: 'list',
                deepLinking: false
            },
        });
    }

    // Endpoint to serve openapi.json
    app.get('/openapi.json', async (request, reply) => {
        return reply.type('application/json').send(openapiSpec);
    });

    // FAZ 6: Rate limiting
    await app.register(rateLimit, {
        max: 60,
        timeWindow: '1 minute',
        keyGenerator: (request: FastifyRequest) => {
            return request.ip;
        },
        allowList: (request: FastifyRequest) => {
            return request.url === '/v1/stream' || request.url === '/health' || request.url.startsWith('/docs') || request.url.startsWith('/v1/ohlc');
        },
        errorResponseBuilder: () => ({
            statusCode: 429,
            error: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests. Please wait and try again.',
        }),
    });

    // Custom error handler
    app.setErrorHandler((error: FastifyError | ZodError | Error, request: FastifyRequest, reply: FastifyReply) => {
        const response: ErrorResponse = {
            error: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred',
        };

        if ('error' in error && (error as any).error === 'RATE_LIMIT_EXCEEDED') {
            return reply.status(429).send({
                error: 'RATE_LIMIT_EXCEEDED',
                message: (error as any).message || 'Too many requests',
            });
        }

        if (error instanceof ZodError) {
            response.error = 'VALIDATION_ERROR';
            response.message = 'Invalid request data';
            response.details = error.errors.map(e => ({
                path: e.path.join('.'),
                message: e.message,
            }));
            return reply.status(400).send(response);
        }

        if ('statusCode' in error && error.statusCode) {
            response.error = error.code || 'REQUEST_ERROR';
            response.message = (error as any).message || error.message;
            return reply.status(error.statusCode).send(response);
        }

        request.log.error(error);
        return reply.status(500).send(response);
    });

    // Register routes
    await app.register(healthRoute);
    await app.register(authRoutes, { prefix: '/auth' });
    await app.register(secretsRoutes, { prefix: '/v1' });
    await app.register(stateRoute, { prefix: '/v1' });
    await app.register(watchesRoute, { prefix: '/v1' });
    await app.register(tradesRoute, { prefix: '/v1' });
    await app.register(portfolioRoute, { prefix: '/v1' });
    await app.register(signalsRoute, { prefix: '/v1' });
    await app.register(eventsRoute, { prefix: '/v1' });
    await app.register(devRoute, { prefix: '/v1' });
    await app.register(settingsRoute, { prefix: '/v1' });
    await app.register(auditRoute, { prefix: '/v1' });
    await app.register(metricsRoute, { prefix: '/v1' });
    await app.register(streamRoute, { prefix: '/v1' });
    await app.register(notifyRoute, { prefix: '/v1' });
    await app.register(ohlcRoute, { prefix: '/v1' });
    await app.register(adminRoutes, { prefix: '/v1' });

    return app;
}

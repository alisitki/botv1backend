// FAZ 6: Server with graceful shutdown

import dotenv from 'dotenv';
dotenv.config();

import { buildApp } from './app.js';
import db from './db/index.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

let app: Awaited<ReturnType<typeof buildApp>> | null = null;

async function start() {
    try {
        app = await buildApp();

        await app.listen({ port: PORT, host: HOST });

        console.log('');
        console.log('🚀 Trading Bot API Server');
        console.log(`📡 Listening on http://${HOST}:${PORT}`);
        console.log('');
        console.log('Available endpoints:');
        console.log('  GET  /health');
        console.log('  GET  /v1/state');
        console.log('  GET  /v1/watches');
        console.log('  POST /v1/watches');
        console.log('  POST /v1/watches/:id/pause');
        console.log('  POST /v1/watches/:id/resume');
        console.log('  POST /v1/watches/:id/sell');
        console.log('  GET  /v1/trades');
        console.log('  GET  /v1/portfolio');
        console.log('  GET  /v1/signals');
        console.log('  GET  /v1/events');
        console.log('  GET  /v1/settings');
        console.log('  GET  /v1/audit');
        console.log('  GET  /v1/metrics/debug');
        console.log('  GET  /v1/stream (SSE)');
        console.log('  POST /v1/admin/active-user');
        console.log('  GET  /v1/admin/active-user');
        console.log('  DELETE /v1/admin/active-user');
        console.log('');
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

// FAZ 6: Graceful shutdown
async function shutdown(signal: string) {
    console.log('');
    console.log(`🔴 ${signal} received, shutting down gracefully...`);

    if (app) {
        try {
            await app.close();
            console.log('✅ Fastify server closed');
        } catch (err) {
            console.error('Error closing Fastify:', err);
        }
    }

    try {
        db.close();
        console.log('✅ Database connection closed');
    } catch (err) {
        console.error('Error closing database:', err);
    }

    console.log('👋 Shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();

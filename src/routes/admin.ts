// Admin routes - DEPRECATED for multi-user mode

import dotenv from 'dotenv';
dotenv.config();

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export default async function adminRoutes(app: FastifyInstance) {
    const deprecatedResponse = {
        error: 'DEPRECATED',
        message: 'Multi-user mode active. active_user endpoint removed.',
    };

    // POST /admin/active-user - DEPRECATED
    app.post('/admin/active-user', async (request: FastifyRequest, reply: FastifyReply) => {
        return reply.status(410).send(deprecatedResponse);
    });

    // GET /admin/active-user - DEPRECATED
    app.get('/admin/active-user', async (request: FastifyRequest, reply: FastifyReply) => {
        return reply.status(410).send(deprecatedResponse);
    });

    // DELETE /admin/active-user - DEPRECATED
    app.delete('/admin/active-user', async (request: FastifyRequest, reply: FastifyReply) => {
        return reply.status(410).send(deprecatedResponse);
    });
}


import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getAuditLogs, AuditLogEntry } from '../utils/audit.js';

const auditQuerySchema = z.object({
    limit: z.string().optional().transform(v => v ? parseInt(v, 10) : 50),
});

export default async function auditRoute(app: FastifyInstance) {
    // GET /v1/audit - Get audit logs
    app.get('/audit', async (request: FastifyRequest): Promise<AuditLogEntry[]> => {
        const { limit } = auditQuerySchema.parse(request.query);
        return getAuditLogs(limit);
    });
}

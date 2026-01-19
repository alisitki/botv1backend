// FAZ 8: Notification Test Endpoint
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { sendTelegramMessage } from '../notify/telegram.js';

const notifyTestSchema = z.object({
    message: z.string().min(1).default('hello'),
});

export default async function notifyRoute(app: FastifyInstance) {
    // POST /v1/notify/test
    app.post('/notify/test', async (request: FastifyRequest, reply: FastifyReply) => {
        const { message } = notifyTestSchema.parse(request.body);

        const success = await sendTelegramMessage(`<b>TEST:</b> ${message}`);

        if (success) {
            return { ok: true, message: 'Notification sent' };
        } else {
            return reply.status(400).send({
                error: 'NOTIFICATION_FAILED',
                message: 'Failed to send notification. Check settings and logs.',
            });
        }
    });
}

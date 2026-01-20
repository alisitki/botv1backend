import { FastifyInstance, FastifyRequest } from 'fastify';
import db, { Event } from '../db/index.js';
import { eventsQuerySchema, EventResponse } from '../schemas/index.js';

export default async function eventsRoute(app: FastifyInstance) {
    app.get('/events', async (request: FastifyRequest): Promise<EventResponse[]> => {
        const userId = request.session.get('userId')!;
        const { limit, watch_id } = eventsQuerySchema.parse(request.query);

        let query = 'SELECT * FROM events WHERE user_id = ?';
        const params: (number | string)[] = [userId];

        if (watch_id !== undefined) {
            query += ' AND watch_id = ?';
            params.push(watch_id);
        }

        query += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);

        const events = db.prepare(query).all(...params) as Event[];

        // FAZ 1.1: Map to UI contract format
        return events.map(event => ({
            id: String(event.id),                                    // number → string
            watch_id: event.watch_id !== null ? String(event.watch_id) : null,  // number → string
            type: event.type,
            payload: JSON.parse(event.payload),
            ts: event.created_at,                                    // created_at → ts
        }));
    });
}


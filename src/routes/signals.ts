import { FastifyInstance } from 'fastify';

export default async function signalsRoute(app: FastifyInstance) {
    // FAZ1: Signals are mocked, return empty array
    app.get('/signals', async (): Promise<unknown[]> => {
        return [];
    });
}

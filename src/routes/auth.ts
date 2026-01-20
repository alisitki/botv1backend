import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import argon2 from 'argon2';
import { z } from 'zod';
import { createUser, getUserByEmail, getUserById, getUserSecrets } from '../db/index.js';

const registerSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
});

const loginSchema = z.object({
    email: z.string().email(),
    password: z.string(),
});

export default async function authRoutes(app: FastifyInstance) {
    // POST /register
    app.post('/register', async (request, reply) => {
        const { email, password } = registerSchema.parse(request.body);

        const existingUser = getUserByEmail(email);
        if (existingUser) {
            return reply.status(400).send({ error: 'USER_EXISTS', message: 'User already exists' });
        }

        const passwordHash = await argon2.hash(password);
        const userId = uuidv4();

        createUser({
            id: userId,
            email,
            password_hash: passwordHash,
        });

        return { ok: true, message: 'User registered successfully' };
    });

    // POST /login
    app.post('/login', async (request, reply) => {
        const { email, password } = loginSchema.parse(request.body);

        const user = getUserByEmail(email);
        if (!user) {
            return reply.status(401).send({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
        }

        const validPassword = await argon2.verify(user.password_hash, password);
        if (!validPassword) {
            return reply.status(401).send({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
        }

        // Set session
        request.session.set('userId', user.id);

        return { ok: true, user: { id: user.id, email: user.email } };
    });

    // POST /logout
    app.post('/logout', async (request, reply) => {
        request.session.destroy();
        return { ok: true };
    });

    // GET /me
    app.get('/me', async (request, reply) => {
        const userId = request.session.get('userId');
        if (!userId) {
            return reply.status(401).send({ error: 'UNAUTHORIZED', message: 'Not logged in' });
        }

        const user = getUserById(userId);
        if (!user) {
            return reply.status(404).send({ error: 'USER_NOT_FOUND', message: 'User not found' });
        }

        const secrets = getUserSecrets(userId);
        const hasBinanceKeys = !!(secrets?.binance_api_key_enc && secrets?.nonce);

        return {
            user: {
                id: user.id,
                email: user.email,
            },
            has_binance_keys: hasBinanceKeys,
        };
    });
}

import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Get the master key from environment variables.
 * Must be a 32-byte hex string (64 characters).
 */
const getMasterKey = () => {
    const key = process.env.MASTER_KEY;
    if (!key) {
        throw new Error('MASTER_KEY environment variable is not set');
    }
    if (key.length !== 64) {
        throw new Error('MASTER_KEY must be a 64-character hex string (32 bytes)');
    }
    return Buffer.from(key, 'hex');
};

/**
 * Encrypts text using AES-256-GCM
 * @param text Pattern to encrypt
 * @returns Object containing encrypted text (hex) and nonce (hex)
 */
export function encrypt(text: string): { encrypted: string; nonce: string } {
    const masterKey = getMasterKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');

    // We combine iv + authTag + encrypted into one string or return separately
    // To keep it simple for DB storage, we'll return encrypted (authTag + cipherText) and nonce (iv)
    return {
        encrypted: authTag + encrypted,
        nonce: iv.toString('hex')
    };
}

/**
 * Decrypts text using AES-256-GCM
 * @param encrypted Encrypted text (authTag + cipherText) in hex
 * @param nonce Nonce (iv) in hex
 * @returns Decrypted text
 */
export function decrypt(encrypted: string, nonce: string): string {
    const masterKey = getMasterKey();
    const iv = Buffer.from(nonce, 'hex');
    const authTag = Buffer.from(encrypted.substring(0, AUTH_TAG_LENGTH * 2), 'hex');
    const cipherText = encrypted.substring(AUTH_TAG_LENGTH * 2);

    const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(cipherText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}

/**
 * Generate a random 32-byte master key
 */
export function generateMasterKey(): string {
    return crypto.randomBytes(32).toString('hex');
}

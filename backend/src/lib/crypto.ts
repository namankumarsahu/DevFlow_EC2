import crypto from 'crypto';
import { config } from '../config';

// AES-256-GCM. Stored format: base64(iv):base64(authTag):base64(ciphertext)
const key = () => Buffer.from(config.encryptionKey, 'hex');

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join(':');
}

export function decrypt(payload: string): string {
  const [iv, tag, enc] = payload.split(':').map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

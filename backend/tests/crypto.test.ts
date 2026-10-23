import { decrypt, encrypt } from '../src/lib/crypto';

describe('env var encryption (AES-256-GCM)', () => {
  it('round-trips a value', () => {
    expect(decrypt(encrypt('postgres://user:p@ss@db/app'))).toBe('postgres://user:p@ss@db/app');
  });

  it('uses a random IV so identical plaintexts differ', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  it('does not contain the plaintext', () => {
    expect(encrypt('super-secret-value')).not.toContain('super-secret-value');
  });

  it('detects tampering', () => {
    const [iv, tag, data] = encrypt('hello').split(':');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 1;
    expect(() => decrypt([iv, tag, flipped.toString('base64')].join(':'))).toThrow();
  });
});

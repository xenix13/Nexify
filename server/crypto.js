// Chiffrement des secrets au repos (jetons Spotify, cookies YouTube) et hachage des mots de passe
import crypto from 'node:crypto';

export function makeCipher(secret) {
  if (!secret || secret.length < 16) {
    throw new Error('APP_SECRET doit faire au moins 16 caractères (voir .env.example)');
  }
  const key = crypto.createHash('sha256').update(`nexify:${secret}`).digest();
  return {
    encrypt(plain) {
      if (plain == null) return null;
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return `v1:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
    },
    decrypt(box) {
      if (!box) return null;
      if (!box.startsWith('v1:')) throw new Error('format chiffré inconnu');
      const buf = Buffer.from(box.slice(3), 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [kind, saltHex, hashHex] = String(stored || '').split(':');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');

export function pkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

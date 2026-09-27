import { randomBytes } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';

// argon2id (параметры OWASP); реализация на WebAssembly — без нативных модулей, одинаково работает
// на любой платформе и в офлайн-сборке.
export async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(16),
    parallelism: 1,
    iterations: 2,
    memorySize: 19456,
    hashLength: 32,
    outputType: 'encoded',
  });
}

export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  if (!hash) return false;
  try {
    return await argon2Verify({ password, hash });
  } catch {
    return false;
  }
}

export const PASSWORD_MIN_LENGTH = 8;

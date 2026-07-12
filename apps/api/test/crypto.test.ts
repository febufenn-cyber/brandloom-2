import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, sha256Hex } from '../src/crypto';

describe('credential encryption', () => {
  it('round-trips a token without storing plaintext', async () => {
    const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const encrypted = await encryptSecret('secret-token', key);
    expect(encrypted.ciphertext).not.toContain('secret-token');
    expect(await decryptSecret(encrypted.ciphertext, encrypted.nonce, key)).toBe('secret-token');
  });

  it('hashes deterministically', async () => {
    expect(await sha256Hex('brandloom')).toBe(await sha256Hex('brandloom'));
  });
});

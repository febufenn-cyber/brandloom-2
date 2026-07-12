const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64Url(bytes: Uint8Array) {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

export function randomToken(size = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return base64Url(bytes);
}

export async function sha256Bytes(value: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

export async function sha256Hex(value: string) {
  return [...await sha256Bytes(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Base64Url(value: string) {
  return base64Url(await sha256Bytes(value));
}

async function encryptionKey(encodedKey: string) {
  if (!encodedKey) throw new Error('TOKEN_ENCRYPTION_KEY is not configured.');
  const bytes = base64ToBytes(encodedKey);
  if (bytes.byteLength !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(value: string, encodedKey: string) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await encryptionKey(encodedKey), encoder.encode(value));
  return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), nonce: bytesToBase64(nonce) };
}

export async function decryptSecret(ciphertext: string, nonce: string, encodedKey: string) {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(nonce) },
    await encryptionKey(encodedKey),
    base64ToBytes(ciphertext),
  );
  return decoder.decode(plaintext);
}

export async function verifyHmacSha256(rawBody: string, signatureHeader: string | undefined, secret: string) {
  if (!signatureHeader?.startsWith('sha256=') || !secret) return false;
  const supplied = signatureHeader.slice(7).toLowerCase();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody)));
  const expected = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (expected.length !== supplied.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  return mismatch === 0;
}

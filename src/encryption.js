// SyncPad – encryption.js
// AES-GCM-256 with PBKDF2 key derivation.
// All functions that encrypt/decrypt take a CryptoKey (not raw passphrase).
// deriveKey() converts passphrase + salt → CryptoKey.
import { bufToBase64, base64ToBuf } from './utils.js';

/** Generate a random 32-byte hex salt string. */
export function generateSalt() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive a CryptoKey from a passphrase + hex salt.
 * @param {string} passphrase
 * @param {string} saltHex  – hex string produced by generateSalt()
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(passphrase, saltHex) {
  const saltBytes = new Uint8Array(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: 200_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt plaintext with a CryptoKey. Returns a base64 string (IV prepended).
 * @param {string} plaintext
 * @param {CryptoKey} key
 * @returns {Promise<string>}
 */
export async function encryptContent(plaintext, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  const combined = new Uint8Array(12 + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), 12);
  return bufToBase64(combined.buffer);
}

/**
 * Decrypt a base64 ciphertext (IV prepended) with a CryptoKey.
 * @param {string} cipherB64
 * @param {CryptoKey} key
 * @returns {Promise<string>}
 */
export async function decryptContent(cipherB64, key) {
  const combined = new Uint8Array(base64ToBuf(cipherB64));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: combined.slice(0, 12) },
    key,
    combined.slice(12)
  );
  return new TextDecoder().decode(plain);
}

/**
 * Returns true if the string looks like it could be AES-GCM base64 ciphertext.
 * Used as a heuristic before attempting decryption.
 */
export function looksEncrypted(content) {
  if (!content || content.length < 20) return false;
  return /^[A-Za-z0-9+/]+=*$/.test(content.trim());
}

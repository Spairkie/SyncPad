// SyncPad – encryption.js
// AES-GCM-256 with PBKDF2 key derivation.
// All functions that encrypt/decrypt take a CryptoKey (not raw passphrase).
// deriveKey() converts passphrase + salt → CryptoKey.
import { bufToBase64, base64ToBuf } from './utils.js';

// ── Constants ─────────────────────────────────────────────────────────────────
/** PBKDF2 iteration count. 200k is the OWASP 2023 minimum for SHA-256. */
const PBKDF2_ITERATIONS = 200_000;
const PBKDF2_HASH       = 'SHA-256';

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
  if (!saltHex || saltHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(saltHex)) {
    throw new Error('Invalid salt: expected a non-empty even-length hex string');
  }
  const saltBytes = new Uint8Array(saltHex.match(/.{2}/g).map(hexByte => parseInt(hexByte, 16)));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: PBKDF2_HASH },
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
  try {
    const combined = new Uint8Array(base64ToBuf(cipherB64));
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: combined.slice(0, 12) },
      key,
      combined.slice(12)
    );
    return new TextDecoder().decode(plain);
  } catch {
    // Wrap raw DOMException / base64 errors in a recognisable sentinel so
    // callers can distinguish "wrong passphrase / corrupt ciphertext" from
    // other unexpected failures without string-matching browser messages.
    throw new Error('DECRYPT_FAILED');
  }
}

/**
 * Returns true if the string looks like it could be AES-GCM base64 ciphertext.
 * Used as a heuristic before attempting decryption.
 *
 * Structural requirements for our ciphertext:
 *   IV (12 bytes) + AES-GCM tag (16 bytes) + ≥1 byte plaintext = ≥29 bytes raw
 *   → base64-encoded length ≥ ceil(29/3)*4 = 40 characters
 * Valid base64 (with padding) always has a length divisible by 4.
 */
export function looksEncrypted(content) {
  if (!content) return false;
  const trimmed = content.trim();
  // Must be long enough to hold IV + tag + at least 1 byte of ciphertext
  if (trimmed.length < 40) return false;
  // Must consist only of base64 characters
  if (!/^[A-Za-z0-9+/]+=*$/.test(trimmed)) return false;
  // Valid padded base64 length is always a multiple of 4
  if (trimmed.length % 4 !== 0) return false;
  return true;
}

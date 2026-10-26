// Tsuzuki crypto. WebCrypto only, so the same code runs in Firefox, Safari and Node.
//
//   passphrase ──PBKDF2-SHA256 (600k, salt = vault id)──▶ master (256 bit)
//   master ──HKDF "tsuzuki/v1/enc"──────────▶ AES-256-GCM key   (never leaves devices)
//   master ──HKDF "tsuzuki/v1/relay-auth"───▶ relay bearer token (relay stores only its SHA-256)
//
// Envelope: "TZK" | version(1) | iv(12) | AES-GCM ciphertext+tag.
// Additional authenticated data binds each envelope to vault, purpose and device,
// so a relay can't pass one device's blob off as another's, or a sync blob as local state.

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export const KDF_ITERATIONS = 600_000;
const MAGIC = [0x54, 0x5a, 0x4b]; // "TZK"
const VERSION = 1;
const HEADER = MAGIC.length + 1;
const IV_BYTES = 12;

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

export function toB64url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** URL-safe random identifier. 16 bytes → 22 chars (vault ids); 12 bytes → 16 chars (device ids). */
export function randomId(bytes = 12) {
  return toB64url(randomBytes(bytes));
}

export async function sha256Hex(input) {
  const data = typeof input === 'string' ? te.encode(input) : input;
  const digest = new Uint8Array(await subtle.digest('SHA-256', data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

async function hkdf(masterKey, info) {
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode(info) },
    masterKey,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Derive the vault's key material from a passphrase. Slow on purpose.
 * Returns raw bytes so the key can be parked in storage.session between
 * service-worker restarts; call importEncKey() to get a usable CryptoKey.
 */
export async function deriveVaultSecrets(passphrase, vaultId, iterations = KDF_ITERATIONS) {
  if (typeof passphrase !== 'string' || !passphrase) throw new Error('empty passphrase');
  const base = await subtle.importKey('raw', te.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const masterBits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: te.encode(`tsuzuki/v1/salt/${vaultId}`), iterations },
    base,
    256,
  );
  const master = await subtle.importKey('raw', masterBits, 'HKDF', false, ['deriveBits']);
  const encKeyRaw = await hkdf(master, 'tsuzuki/v1/enc');
  const authToken = toB64url(await hkdf(master, 'tsuzuki/v1/relay-auth'));
  return { encKeyRaw: toB64url(encKeyRaw), authToken };
}

export function importEncKey(encKeyRawB64) {
  return subtle.importKey('raw', fromB64url(encKeyRawB64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export function aad({ vaultId, purpose, deviceId }) {
  return te.encode(`tsuzuki/v1|${vaultId}|${purpose}|${deviceId}`);
}

export async function seal(key, plaintextBytes, aadBytes) {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadBytes }, key, plaintextBytes));
  const out = new Uint8Array(HEADER + IV_BYTES + ct.length);
  out.set(MAGIC, 0);
  out[MAGIC.length] = VERSION;
  out.set(iv, HEADER);
  out.set(ct, HEADER + IV_BYTES);
  return out;
}

export class DecryptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DecryptError';
  }
}

export async function open(key, envelope, aadBytes) {
  const u8 = envelope instanceof Uint8Array ? envelope : new Uint8Array(envelope);
  if (u8.length < HEADER + IV_BYTES + 16 || MAGIC.some((b, i) => u8[i] !== b)) {
    throw new DecryptError('not a Tsuzuki envelope');
  }
  if (u8[MAGIC.length] !== VERSION) throw new DecryptError(`unsupported envelope version ${u8[MAGIC.length]}`);
  const iv = u8.subarray(HEADER, HEADER + IV_BYTES);
  try {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aadBytes }, key, u8.subarray(HEADER + IV_BYTES));
    return new Uint8Array(pt);
  } catch {
    throw new DecryptError('wrong key or tampered data');
  }
}

export async function sealJSON(key, value, aadBytes) {
  return seal(key, te.encode(JSON.stringify(value)), aadBytes);
}

export async function openJSON(key, envelope, aadBytes) {
  return JSON.parse(td.decode(await open(key, envelope, aadBytes)));
}

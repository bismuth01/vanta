// Sealed-box encryption to the enclave: X25519 ECDH → HKDF-SHA256 → AES-256-GCM.
// Layout: ephemeralPub(32) | iv(12) | tag(16) | ciphertext
import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto'

const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const INFO = Buffer.from('vanta-seal-v1')

export function rawPublicKey(pub: KeyObject): Buffer {
  return pub.export({ format: 'der', type: 'spki' }).subarray(SPKI_X25519_PREFIX.length)
}

export function publicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, raw]), format: 'der', type: 'spki' })
}

export function generateEncryptionKey() {
  return generateKeyPairSync('x25519')
}

function deriveKey(shared: Buffer, ephPub: Buffer, recipientPub: Buffer) {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephPub, recipientPub]), INFO, 32))
}

export function seal(recipientRaw: Buffer, plaintext: Buffer): Buffer {
  const eph = generateKeyPairSync('x25519')
  const ephRaw = rawPublicKey(eph.publicKey)
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyFromRaw(recipientRaw) })
  const key = deriveKey(shared, ephRaw, recipientRaw)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([ephRaw, iv, cipher.getAuthTag(), ct])
}

export function open(privateKey: KeyObject, recipientRaw: Buffer, sealed: Buffer): Buffer {
  const ephRaw = sealed.subarray(0, 32)
  const iv = sealed.subarray(32, 44)
  const tag = sealed.subarray(44, 60)
  const ct = sealed.subarray(60)
  const shared = diffieHellman({ privateKey, publicKey: publicKeyFromRaw(ephRaw) })
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(shared, ephRaw, recipientRaw), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

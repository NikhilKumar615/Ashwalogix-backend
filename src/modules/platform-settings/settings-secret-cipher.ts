import { Logger } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

const ENCRYPTED_PREFIX = 'enc:v1:';
const MASK = '••••';

/**
 * AES-256-GCM encryption for integration secrets stored in platform settings.
 *
 * Key: SETTINGS_ENCRYPTION_KEY (32 bytes as base64 or 64 hex chars; any other
 * string is stretched with SHA-256). When the key is absent values are stored
 * in plaintext and a warning is logged. Legacy plaintext values are always
 * readable, so enabling the key later is transparent (values get encrypted on
 * the next save).
 */
export class SettingsSecretCipher {
  private readonly logger = new Logger(SettingsSecretCipher.name);
  private readonly key: Buffer | null;
  private missingKeyWarned = false;

  constructor(rawKey: string | undefined | null) {
    this.key = SettingsSecretCipher.deriveKey(rawKey);
  }

  get enabled() {
    return this.key !== null;
  }

  static isEncrypted(value: string | null | undefined) {
    return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
  }

  /** A masked value as returned by GET (or typed placeholder) - never a real secret. */
  static isMasked(value: string) {
    return /[•*]/.test(value);
  }

  encrypt(plaintext: string): string {
    if (!this.key) {
      if (!this.missingKeyWarned) {
        this.missingKeyWarned = true;
        this.logger.warn(
          'SETTINGS_ENCRYPTION_KEY is not set: integration API keys are stored in plaintext. Configure it to encrypt them at rest.',
        );
      }
      return plaintext;
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return `${ENCRYPTED_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
  }

  /** Returns the plaintext, or null when the value cannot be decrypted. */
  decrypt(stored: string | null | undefined): string | null {
    if (stored === null || stored === undefined || stored === '') {
      return stored ?? null;
    }

    if (!SettingsSecretCipher.isEncrypted(stored)) {
      // Legacy plaintext value.
      return stored;
    }

    if (!this.key) {
      this.logger.error(
        'An encrypted integration secret exists but SETTINGS_ENCRYPTION_KEY is not set',
      );
      return null;
    }

    try {
      const [ivB64, tagB64, dataB64] = stored
        .slice(ENCRYPTED_PREFIX.length)
        .split(':');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(ivB64, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      this.logger.error(
        'Failed to decrypt an integration secret (wrong SETTINGS_ENCRYPTION_KEY?)',
      );
      return null;
    }
  }

  /** Masks a stored value for display: '••••last4', or '' when nothing is stored. */
  mask(stored: string | null | undefined): string {
    if (!stored) {
      return '';
    }

    const plaintext = this.decrypt(stored);
    if (!plaintext) {
      return MASK;
    }

    return plaintext.length > 8 ? `${MASK}${plaintext.slice(-4)}` : MASK;
  }

  private static deriveKey(rawKey: string | undefined | null): Buffer | null {
    const value = rawKey?.trim();
    if (!value) {
      return null;
    }

    if (/^[0-9a-fA-F]{64}$/.test(value)) {
      return Buffer.from(value, 'hex');
    }

    try {
      const decoded = Buffer.from(value, 'base64');
      if (decoded.length === 32) {
        return decoded;
      }
    } catch {
      // fall through
    }

    return createHash('sha256').update(value, 'utf8').digest();
  }
}

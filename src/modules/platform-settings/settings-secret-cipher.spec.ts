import { SettingsSecretCipher } from './settings-secret-cipher';

describe('SettingsSecretCipher', () => {
  it('encrypts with AES-256-GCM and decrypts back', () => {
    const cipher = new SettingsSecretCipher('a'.repeat(64));
    const stored = cipher.encrypt('sk_live_1234567890abcd');

    expect(SettingsSecretCipher.isEncrypted(stored)).toBe(true);
    expect(stored).not.toContain('1234567890');
    expect(cipher.decrypt(stored)).toBe('sk_live_1234567890abcd');
    expect(cipher.mask(stored)).toBe('••••abcd');
  });

  it('reads legacy plaintext values transparently', () => {
    const cipher = new SettingsSecretCipher('some passphrase');
    expect(cipher.decrypt('legacy-plain-key-9876')).toBe(
      'legacy-plain-key-9876',
    );
    expect(cipher.mask('legacy-plain-key-9876')).toBe('••••9876');
    expect(cipher.mask('')).toBe('');
  });

  it('stores plaintext when no key is configured', () => {
    const cipher = new SettingsSecretCipher(undefined);
    expect(cipher.enabled).toBe(false);
    expect(cipher.encrypt('plain-value')).toBe('plain-value');
  });

  it('never reveals anything when an encrypted value cannot be decrypted', () => {
    const stored = new SettingsSecretCipher('key-one').encrypt(
      'secret-value-1234',
    );
    expect(new SettingsSecretCipher('key-two').mask(stored)).toBe('••••');
  });
});

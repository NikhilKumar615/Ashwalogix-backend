/**
 * Upload restrictions shared by the authenticated and public document flows.
 */

/** Max size for unauthenticated (public registration) uploads. */
export const PUBLIC_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** Max declared size for authenticated document uploads. */
export const AUTHENTICATED_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** Prefix of every key issued for public registration uploads. */
export const PUBLIC_REGISTRATION_STORAGE_PREFIX =
  'public/registrations/company-admin/';

/** Prefix of every key issued for an organization's authenticated uploads. */
export function organizationStoragePrefix(organizationId: string) {
  return `organizations/${organizationId}/`;
}

export function isPublicRegistrationStorageKey(storageKey: string) {
  return (
    typeof storageKey === 'string' &&
    storageKey.startsWith(PUBLIC_REGISTRATION_STORAGE_PREFIX) &&
    !hasPathTraversal(storageKey)
  );
}

export function hasPathTraversal(storageKey: string) {
  return (
    storageKey.includes('..') ||
    storageKey.includes('\\') ||
    storageKey.includes('//') ||
    [...storageKey].some((char) => char.charCodeAt(0) < 0x20)
  );
}

/** extension -> canonical MIME type */
export const PUBLIC_UPLOAD_FORMATS: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export const PUBLIC_UPLOAD_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/png',
  'image/webp',
]);

/**
 * Authenticated uploads (POD photos, shipment paperwork such as invoices or
 * e-way bills) accept a wider, still inert, set of formats. Active content
 * (html, svg, js, executables) is never allowed.
 */
export const AUTHENTICATED_UPLOAD_FORMATS: Readonly<Record<string, string>> = {
  ...PUBLIC_UPLOAD_FORMATS,
  heic: 'image/heic',
  heif: 'image/heif',
  gif: 'image/gif',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
};

const MIME_TO_EXTENSION: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/gif': 'gif',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'text/plain': 'txt',
};

export function fileExtension(fileName: string) {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(fileName.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * Resolves the extension to use for a file, from its name or, when the name
 * has none, from its declared MIME type. Returns null when not allowed.
 */
export function resolveAllowedExtension(
  fileName: string,
  mimeType: string | undefined,
  allowed: Readonly<Record<string, string>>,
) {
  const fromName = fileExtension(fileName);
  if (fromName) {
    return Object.prototype.hasOwnProperty.call(allowed, fromName)
      ? fromName
      : null;
  }

  const fromMime = mimeType
    ? MIME_TO_EXTENSION[mimeType.toLowerCase().split(';')[0].trim()]
    : undefined;
  return fromMime && Object.prototype.hasOwnProperty.call(allowed, fromMime)
    ? fromMime
    : null;
}

/** Keeps a file name safe to embed in a storage key, preserving the extension. */
export function sanitizeFileName(fileName: string, extension: string) {
  const withoutExtension = fileName.trim().replace(/\.[A-Za-z0-9]{1,8}$/, '');
  const base =
    withoutExtension
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 100) || 'file';
  return `${base}.${extension}`;
}

export function sanitizeKeySegment(value: string, maxLength = 64) {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLength) || 'document'
  );
}

/**
 * Detects the real type of a buffer from its leading bytes. Only the formats
 * allowed for public uploads are recognised.
 */
export function detectPublicUploadMimeType(buffer: Buffer): string | null {
  if (!buffer || buffer.length < 12) {
    return null;
  }

  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    return 'application/pdf';
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }

  if (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

export function normalizeMimeType(mimeType: string | undefined) {
  const normalized = (mimeType ?? '').toLowerCase().split(';')[0].trim();
  if (normalized === 'image/jpg' || normalized === 'image/pjpeg') {
    return 'image/jpeg';
  }
  return normalized;
}

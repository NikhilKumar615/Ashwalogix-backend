const DEFAULT_BUSINESS_PREFIX = 'ORG';
const DEFAULT_STATE_PREFIX = 'GEN';
const PLATFORM_PREFIX = 'AL';
const INDEPENDENT_DRIVER_PREFIX = 'DRV-IND-AL';
const INDIA_STATE_CODE_MAP: Record<string, string> = {
  ANDHRAPRADESH: 'AP',
  ARUNACHALPRADESH: 'AR',
  ASSAM: 'AS',
  BIHAR: 'BR',
  CHHATTISGARH: 'CG',
  GOA: 'GA',
  GUJARAT: 'GJ',
  HARYANA: 'HR',
  HIMACHALPRADESH: 'HP',
  JHARKHAND: 'JH',
  KARNATAKA: 'KA',
  KERALA: 'KL',
  MADHYAPRADESH: 'MP',
  MAHARASHTRA: 'MH',
  MANIPUR: 'MN',
  MEGHALAYA: 'ML',
  MIZORAM: 'MZ',
  NAGALAND: 'NL',
  ODISHA: 'OD',
  ORISSA: 'OD',
  PUNJAB: 'PB',
  RAJASTHAN: 'RJ',
  SIKKIM: 'SK',
  TAMILNADU: 'TN',
  TELANGANA: 'TS',
  TRIPURA: 'TR',
  UTTARPRADESH: 'UP',
  UTTARAKHAND: 'UK',
  UTTARANCHAL: 'UK',
  WESTBENGAL: 'WB',
  ANDAMANANDNICOBARISLANDS: 'AN',
  CHANDIGARH: 'CH',
  DADRAANDNAGARHAVELIANDDAMANANDDIU: 'DN',
  DADRAANDNAGARHAVELI: 'DN',
  DAMANANDDIU: 'DD',
  DELHI: 'DL',
  NCTOFDELHI: 'DL',
  JAMMUANDKASHMIR: 'JK',
  LADAKH: 'LA',
  LAKSHADWEEP: 'LD',
  PUDUCHERRY: 'PY',
  PONDICHERRY: 'PY',
};

function sanitizeSegment(value: string | null | undefined) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function buildBusinessPrefix(name: string | null | undefined) {
  const sanitized = sanitizeSegment(name);
  return (sanitized || DEFAULT_BUSINESS_PREFIX).slice(0, 3).padEnd(3, 'X');
}

export function buildStatePrefix(state: string | null | undefined) {
  const sanitized = sanitizeSegment(state);
  if (!sanitized) {
    return DEFAULT_STATE_PREFIX;
  }

  return INDIA_STATE_CODE_MAP[sanitized] || sanitized.slice(0, 2).padEnd(2, 'X');
}

export function formatRollingAlphaCode(
  prefix: string,
  entity: string,
  sequence: number,
) {
  const cycle = Math.floor(sequence / 10000);
  const number = String(sequence % 10000).padStart(4, '0');
  return `${prefix}-${entity}-${number}${toAlphaSuffix(cycle)}`;
}

export function formatRollingAlphaCodeWithState(
  prefix: string,
  entity: string,
  statePrefix: string,
  sequence: number,
) {
  const cycle = Math.floor(sequence / 10000);
  const number = String(sequence % 10000).padStart(4, '0');
  return `${prefix}-${entity}-${statePrefix}-${number}${toAlphaSuffix(cycle)}`;
}

export function formatNumericCode(
  prefix: string,
  entity: string,
  sequence: number,
) {
  return `${prefix}-${entity}-${String(sequence).padStart(4, '0')}`;
}

export function parseRollingAlphaCodeSequence(
  code: string,
  prefix: string,
  entity: string,
  statePrefix?: string,
) {
  const pattern = statePrefix
    ? new RegExp(
        `^${escapeRegExp(prefix)}-${escapeRegExp(entity)}-${escapeRegExp(statePrefix)}-(\\d{4})([A-Z]+)$`,
      )
    : new RegExp(
        `^${escapeRegExp(prefix)}-${escapeRegExp(entity)}-(\\d{4})([A-Z]+)$`,
      );
  const match = code.match(pattern);

  if (!match) {
    return null;
  }

  const numericPart = Number(match[1]);
  const cycle = fromAlphaSuffix(match[2]);
  return cycle * 10000 + numericPart;
}

export function parseNumericCodeSequence(
  code: string,
  prefix: string,
  entity: string,
) {
  const match = code.match(
    new RegExp(`^${escapeRegExp(prefix)}-${escapeRegExp(entity)}-(\\d{4})$`),
  );

  if (!match) {
    return null;
  }

  return Number(match[1]);
}

export function formatPlatformClientCode(year: number, sequence: number) {
  const cycle = Math.floor(sequence / 10000);
  const number = String(sequence % 10000).padStart(4, '0');
  return `${PLATFORM_PREFIX}-${String(year).slice(-2)}-${number}${toAlphaSuffix(cycle)}`;
}

export function parsePlatformClientCodeSequence(code: string, year: number) {
  const match = code.match(
    new RegExp(
      `^${escapeRegExp(PLATFORM_PREFIX)}-${escapeRegExp(String(year).slice(-2))}-(\\d{4})([A-Z]+)$`,
    ),
  );

  if (!match) {
    return null;
  }

  return fromAlphaSuffix(match[2]) * 10000 + Number(match[1]);
}

export function isPlatformClientCode(code: string | null | undefined) {
  return Boolean(
    code &&
      code.match(
        new RegExp(`^${escapeRegExp(PLATFORM_PREFIX)}-\\d{2}-(\\d{4})([A-Z]+)$`),
      ),
  );
}

export function formatIndependentDriverCode(sequence: number) {
  const cycle = Math.floor(sequence / 10000);
  const number = String(sequence % 10000).padStart(4, '0');
  return `${INDEPENDENT_DRIVER_PREFIX}-${number}${toAlphaSuffix(cycle)}`;
}

export function parseIndependentDriverCodeSequence(code: string) {
  const match = code.match(
    new RegExp(
      `^${escapeRegExp(INDEPENDENT_DRIVER_PREFIX)}-(\\d{4})([A-Z]+)$`,
    ),
  );

  if (!match) {
    return null;
  }

  return fromAlphaSuffix(match[2]) * 10000 + Number(match[1]);
}

export function isIndependentDriverCode(code: string | null | undefined) {
  return parseIndependentDriverCodeSequence(String(code || '')) !== null;
}

function toAlphaSuffix(index: number) {
  let current = index;
  let result = '';

  do {
    result = String.fromCharCode(65 + (current % 26)) + result;
    current = Math.floor(current / 26) - 1;
  } while (current >= 0);

  return result;
}

function fromAlphaSuffix(value: string) {
  return value.split('').reduce((total, character) => {
    return total * 26 + (character.charCodeAt(0) - 64);
  }, 0) - 1;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

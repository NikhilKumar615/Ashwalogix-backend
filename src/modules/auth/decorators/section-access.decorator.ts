import { SetMetadata } from '@nestjs/common';

export const SECTION_ACCESS_KEY = 'sectionAccess';

export const SectionAccess = (section: string) =>
  SetMetadata(SECTION_ACCESS_KEY, section);

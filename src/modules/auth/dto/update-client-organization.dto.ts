import { PartialType } from '@nestjs/swagger';
import { CreateClientOrganizationDto } from './create-client-organization.dto';

export class UpdateClientOrganizationDto extends PartialType(
  CreateClientOrganizationDto,
) {}

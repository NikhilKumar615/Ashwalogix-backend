import { PartialType } from '@nestjs/swagger';
import { CreateCompanyClientDto } from './create-company-client.dto';

export class UpdateCompanyClientDto extends PartialType(CreateCompanyClientDto) {}

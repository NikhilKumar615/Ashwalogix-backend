import { PartialType } from '@nestjs/swagger';
import { CreateCompanyClientLocationDto } from './create-company-client-location.dto';

export class UpdateCompanyClientLocationDto extends PartialType(CreateCompanyClientLocationDto) {}

import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { CreateCompanyClientDto } from './create-company-client.dto';
import { CreateCompanyClientLocationDto } from './create-company-client-location.dto';

export class CreateCompanyClientWithLocationsDto extends CreateCompanyClientDto {
  @ApiProperty({ type: [CreateCompanyClientLocationDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateCompanyClientLocationDto)
  locations!: CreateCompanyClientLocationDto[];
}

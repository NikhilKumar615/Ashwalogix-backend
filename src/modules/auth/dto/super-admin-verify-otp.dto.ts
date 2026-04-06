import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length } from 'class-validator';

export class SuperAdminVerifyOtpDto {
  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty({
    description: '6-digit one-time password sent to the super admin email',
  })
  @IsString()
  @Length(6, 6)
  otp!: string;
}

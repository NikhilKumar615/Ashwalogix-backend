import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from './decorators/current-user.decorator';
import { Roles } from './decorators/roles.decorator';
import { ApproveIndependentDriverDto } from './dto/approve-independent-driver.dto';
import { ApproveOrganizationDto } from './dto/approve-organization.dto';
import { CreateClientOrganizationDto } from './dto/create-client-organization.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterCompanyAdminDto } from './dto/register-company-admin.dto';
import { RegisterIndependentDriverDto } from './dto/register-independent-driver.dto';
import { RejectIndependentDriverDto } from './dto/reject-independent-driver.dto';
import { RejectOrganizationDto } from './dto/reject-organization.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SuperAdminRequestOtpDto } from './dto/super-admin-request-otp.dto';
import { SuperAdminVerifyOtpDto } from './dto/super-admin-verify-otp.dto';
import { UpdateClientOrganizationDto } from './dto/update-client-organization.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { AuthService } from './auth.service';
import type { JwtPayload } from './interfaces/jwt-payload.interface';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register-company-admin')
  @ApiOperation({
    summary:
      'Register a new client company and its first organization admin account',
  })
  @ApiBody({ type: RegisterCompanyAdminDto })
  registerCompanyAdmin(@Body() body: RegisterCompanyAdminDto) {
    return this.authService.registerCompanyAdmin(body);
  }

  @Post('register-independent-driver')
  @ApiOperation({
    summary: 'Register an independent driver for verification and approval',
  })
  @ApiBody({ type: RegisterIndependentDriverDto })
  registerIndependentDriver(@Body() body: RegisterIndependentDriverDto) {
    return this.authService.registerIndependentDriver(body);
  }

  @Post('verify-email')
  @ApiOperation({ summary: 'Verify a newly registered user email' })
  @ApiBody({ type: VerifyEmailDto })
  verifyEmail(@Body() body: VerifyEmailDto) {
    return this.authService.verifyEmail(body);
  }

  @Post('login')
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiBody({ type: LoginDto })
  login(@Body() body: LoginDto) {
    return this.authService.login(body);
  }

  @Post('super-admin/request-otp')
  @ApiOperation({
    summary: 'Validate super admin credentials and send a sign-in OTP by email',
  })
  @ApiBody({ type: SuperAdminRequestOtpDto })
  requestSuperAdminOtp(@Body() body: SuperAdminRequestOtpDto) {
    return this.authService.requestSuperAdminOtp(body);
  }

  @Post('super-admin/verify-otp')
  @ApiOperation({
    summary: 'Verify the emailed OTP and complete super admin sign-in',
  })
  @ApiBody({ type: SuperAdminVerifyOtpDto })
  verifySuperAdminOtp(@Body() body: SuperAdminVerifyOtpDto) {
    return this.authService.verifySuperAdminOtp(body);
  }

  @Post('forgot-password')
  @ApiOperation({ summary: 'Create a password reset token for a user account' })
  @ApiBody({ type: ForgotPasswordDto })
  forgotPassword(@Body() body: ForgotPasswordDto) {
    return this.authService.forgotPassword(body.email);
  }

  @Post('reset-password')
  @ApiOperation({ summary: 'Reset a user password using a reset token' })
  @ApiBody({ type: ResetPasswordDto })
  resetPassword(@Body() body: ResetPasswordDto) {
    return this.authService.resetPassword(body.token, body.newPassword);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the current authenticated user profile' })
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: JwtPayload) {
    return this.authService.getCurrentUser(user.sub);
  }

  @Get('organizations/pending')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List client organizations waiting for approval' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN')
  getPendingOrganizations() {
    return this.authService.getPendingOrganizations();
  }

  @Get('organizations/approved/count')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get total approved client organizations' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN')
  getApprovedOrganizationsCount() {
    return this.authService.getApprovedOrganizationsCount();
  }

  @Get('organizations/approved')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List approved client organizations for super admin' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN')
  getApprovedOrganizations() {
    return this.authService.getApprovedOrganizations();
  }

  @Post('organizations')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a client organization as super admin' })
  @ApiBody({ type: CreateClientOrganizationDto })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN')
  createClientOrganization(
    @Body() body: CreateClientOrganizationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.authService.createClientOrganization(body, user.sub);
  }

  @Patch('organizations/:organizationId')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a client organization as super admin' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiBody({ type: UpdateClientOrganizationDto })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN')
  updateClientOrganization(
    @Param('organizationId') organizationId: string,
    @Body() body: UpdateClientOrganizationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.authService.updateClientOrganization(
      organizationId,
      body,
      user.sub,
    );
  }

  @Get('independent-drivers/pending')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List independent driver registrations waiting for approval',
  })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN')
  getPendingIndependentDrivers() {
    return this.authService.getPendingIndependentDrivers();
  }

  @Get('independent-drivers/:registrationId')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get one independent driver registration by id',
  })
  @ApiParam({ name: 'registrationId', type: String })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN')
  getIndependentDriverRegistration(
    @Param('registrationId') registrationId: string,
  ) {
    return this.authService.getIndependentDriverRegistration(registrationId);
  }

  @Post('organizations/:organizationId/approve')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Approve a pending client organization' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiBody({ type: ApproveOrganizationDto })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN')
  approveOrganization(
    @Param('organizationId') organizationId: string,
    @Body() body: ApproveOrganizationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.authService.approveOrganization(
      organizationId,
      user.sub,
      body.notes,
    );
  }

  @Post('organizations/:organizationId/reject')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reject a pending client organization' })
  @ApiParam({ name: 'organizationId', type: String })
  @ApiBody({ type: RejectOrganizationDto })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN')
  rejectOrganization(
    @Param('organizationId') organizationId: string,
    @Body() body: RejectOrganizationDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.authService.rejectOrganization(
      organizationId,
      user.sub,
      body.reason,
    );
  }

  @Post('independent-drivers/:registrationId/approve')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Approve an independent driver registration' })
  @ApiParam({ name: 'registrationId', type: String })
  @ApiBody({ type: ApproveIndependentDriverDto })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN')
  approveIndependentDriver(
    @Param('registrationId') registrationId: string,
    @Body() body: ApproveIndependentDriverDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.authService.approveIndependentDriver(
      registrationId,
      user.sub,
      body.organizationId,
      body.notes,
    );
  }

  @Post('independent-drivers/:registrationId/reject')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reject an independent driver registration' })
  @ApiParam({ name: 'registrationId', type: String })
  @ApiBody({ type: RejectIndependentDriverDto })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('SUPER_ADMIN')
  rejectIndependentDriver(
    @Param('registrationId') registrationId: string,
    @Body() body: RejectIndependentDriverDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.authService.rejectIndependentDriver(
      registrationId,
      user.sub,
      body.reason,
    );
  }
}

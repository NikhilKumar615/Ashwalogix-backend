import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';
import type { TrackingTokenPayload } from './interfaces/tracking-token-payload.interface';

@Injectable()
export class TrackingAuthService {
  constructor(private readonly jwtService: JwtService) {}

  async authenticate(client: Socket) {
    const token = this.extractToken(client);

    if (!token) {
      throw new UnauthorizedException('Missing tracking token');
    }

    const payload = await this.jwtService.verifyAsync<TrackingTokenPayload>(token);
    // Access tokens share the signing secret; only tokens minted for tracking
    // may open a tracking socket.  Legacy tracking tokens have no typ.
    const tokenType = (payload as { typ?: unknown }).typ;
    if (tokenType !== undefined && tokenType !== 'tracking') {
      throw new UnauthorizedException('Invalid tracking token');
    }
    this.assertValidPayload(payload);

    return payload;
  }

  private extractToken(client: Socket) {
    const authToken = client.handshake.auth.token;

    if (typeof authToken === 'string' && authToken.length > 0) {
      return authToken;
    }

    const authorizationHeader = client.handshake.headers.authorization;

    if (!authorizationHeader) {
      return null;
    }

    const [scheme, token] = authorizationHeader.split(' ');

    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      return null;
    }

    return token;
  }

  private assertValidPayload(payload: TrackingTokenPayload) {
    if (
      !payload?.shipmentId ||
      !payload.organizationId ||
      !payload.sub ||
      (payload.role !== 'rider' && payload.role !== 'customer')
    ) {
      throw new UnauthorizedException('Invalid tracking token payload');
    }

  }
}

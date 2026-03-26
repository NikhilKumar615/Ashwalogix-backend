import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClientStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { CreateCompanyClientDto } from './dto/create-company-client.dto';
import { CreateCompanyClientLocationDto } from './dto/create-company-client-location.dto';
import { UpdateCompanyClientDto } from './dto/update-company-client.dto';
import { UpdateCompanyClientLocationDto } from './dto/update-company-client-location.dto';

@Injectable()
export class CompanyClientsService {
  constructor(private readonly prisma: PrismaService) {}

  async listCompanyClients(organizationId: string, status?: ClientStatus) {
    const companyClients = await this.prisma.companyClient.findMany({
      where: {
        organizationId,
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        locations: {
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        },
      },
    });

    return companyClients.map((companyClient) =>
      this.mapCompanyClientResponse(companyClient),
    );
  }

  async createCompanyClient(
    organizationId: string,
    input: CreateCompanyClientDto,
  ) {
    const companyClient = await this.prisma.companyClient.create({
      data: {
        organizationId,
        companyClientCode: input.companyClientCode,
        name: input.name,
        legalName: input.legalName,
        industry: input.industry,
        status: input.status ?? ClientStatus.ACTIVE,
        pan: input.pan,
        gstin: input.gstin,
        creditTerms: input.creditTerms,
        notes: input.notes,
      },
    });

    return this.mapCompanyClientResponse(companyClient);
  }

  async getCompanyClientById(
    organizationId: string,
    companyClientId: string,
  ) {
    const companyClient = await this.prisma.companyClient.findFirst({
      where: {
        id: companyClientId,
        organizationId,
      },
      include: {
        locations: {
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        },
        shipments: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!companyClient) {
      throw new NotFoundException('Company client not found');
    }

    return this.mapCompanyClientResponse(companyClient);
  }

  async updateCompanyClient(
    organizationId: string,
    companyClientId: string,
    input: UpdateCompanyClientDto,
  ) {
    await this.ensureCompanyClientExists(organizationId, companyClientId);

    const companyClient = await this.prisma.companyClient.update({
      where: { id: companyClientId },
      data: input,
    });

    return this.mapCompanyClientResponse(companyClient);
  }

  async listCompanyClientLocations(
    organizationId: string,
    companyClientId: string,
  ) {
    await this.ensureCompanyClientExists(organizationId, companyClientId);

    return this.prisma.companyClientLocation.findMany({
      where: {
        organizationId,
        companyClientId,
      },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async createCompanyClientLocation(
    organizationId: string,
    companyClientId: string,
    input: CreateCompanyClientLocationDto,
  ) {
    await this.ensureCompanyClientExists(organizationId, companyClientId);

    return this.prisma.$transaction(async (tx) => {
      if (input.isPrimary) {
        await tx.companyClientLocation.updateMany({
          where: {
            organizationId,
            companyClientId,
            isPrimary: true,
          },
          data: {
            isPrimary: false,
          },
        });
      }

      return tx.companyClientLocation.create({
        data: {
          organizationId,
          companyClientId,
          locationType: input.locationType,
          name: input.name,
          addressLine1: input.addressLine1,
          addressLine2: input.addressLine2,
          city: input.city,
          state: input.state,
          postalCode: input.postalCode,
          country: input.country ?? 'India',
          gstin: input.gstin,
          contactName: input.contactName,
          contactPhone: input.contactPhone,
          isPrimary: input.isPrimary ?? false,
        },
      });
    });
  }

  async updateCompanyClientLocation(
    organizationId: string,
    companyClientId: string,
    locationId: string,
    input: UpdateCompanyClientLocationDto,
  ) {
    await this.ensureCompanyClientLocationExists(
      organizationId,
      companyClientId,
      locationId,
    );

    return this.prisma.$transaction(async (tx) => {
      if (input.isPrimary) {
        await tx.companyClientLocation.updateMany({
          where: {
            organizationId,
            companyClientId,
            isPrimary: true,
            id: {
              not: locationId,
            },
          },
          data: {
            isPrimary: false,
          },
        });
      }

      return tx.companyClientLocation.update({
        where: { id: locationId },
        data: input,
      });
    });
  }

  private async ensureCompanyClientExists(
    organizationId: string,
    companyClientId: string,
  ) {
    const companyClient = await this.prisma.companyClient.findFirst({
      where: {
        id: companyClientId,
        organizationId,
      },
    });

    if (!companyClient) {
      throw new NotFoundException('Company client not found');
    }

    return companyClient;
  }

  private async ensureCompanyClientLocationExists(
    organizationId: string,
    companyClientId: string,
    locationId: string,
  ) {
    const location = await this.prisma.companyClientLocation.findFirst({
      where: {
        id: locationId,
        organizationId,
        companyClientId,
      },
    });

    if (!location) {
      throw new NotFoundException('Company client location not found');
    }

    return location;
  }

  private mapCompanyClientResponse<T extends { companyClientCode?: string }>(
    companyClient: T,
  ) {
    const { companyClientCode, ...rest } = companyClient;

    return {
      ...rest,
      companyClientCode: companyClientCode ?? null,
    };
  }
}

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."ClientStatus" AS ENUM ('ACTIVE', 'PROSPECT', 'INACTIVE');

-- CreateEnum
CREATE TYPE "public"."DocumentEntityType" AS ENUM ('SHIPMENT', 'DRIVER', 'CLIENT', 'VEHICLE', 'POD', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "public"."DocumentStatus" AS ENUM ('UPLOADED', 'ARCHIVED', 'DELETED');

-- CreateEnum
CREATE TYPE "public"."DriverLicenseType" AS ENUM ('LMV', 'HMV');

-- CreateEnum
CREATE TYPE "public"."DriverStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED', 'ON_LEAVE');

-- CreateEnum
CREATE TYPE "public"."EmploymentType" AS ENUM ('EMPLOYEE', 'CONTRACT', 'INDEPENDENT', 'THIRD_PARTY');

-- CreateEnum
CREATE TYPE "public"."EventSource" AS ENUM ('SYSTEM', 'ADMIN', 'DRIVER', 'WAREHOUSE', 'API');

-- CreateEnum
CREATE TYPE "public"."FuelType" AS ENUM ('DIESEL', 'CNG', 'ELECTRIC', 'PETROL', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY');

-- CreateEnum
CREATE TYPE "public"."IndependentDriverRegistrationStatus" AS ENUM ('PENDING_VERIFICATION', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."InventoryItemStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "public"."InventoryMovementType" AS ENUM ('INBOUND', 'OUTBOUND', 'ADJUSTMENT', 'TRANSFER');

-- CreateEnum
CREATE TYPE "public"."MembershipStatus" AS ENUM ('ACTIVE', 'INVITED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "public"."OrganizationRole" AS ENUM ('ORG_ADMIN', 'DISPATCHER', 'OPERATIONS', 'WAREHOUSE', 'DRIVER');

-- CreateEnum
CREATE TYPE "public"."OrganizationStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "public"."PaymentCollectionMethod" AS ENUM ('NONE', 'MANUAL', 'OFFLINE', 'DEFERRED');

-- CreateEnum
CREATE TYPE "public"."PlanBillingCycle" AS ENUM ('MONTHLY', 'QUARTERLY', 'YEARLY', 'ONE_TIME', 'CUSTOM');

-- CreateEnum
CREATE TYPE "public"."PlanStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "public"."PlatformRole" AS ENUM ('SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "public"."ProofType" AS ENUM ('PICKUP', 'DELIVERY');

-- CreateEnum
CREATE TYPE "public"."ShipmentAssignmentStatus" AS ENUM ('ACTIVE', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."ShipmentMode" AS ENUM ('BUSINESS', 'INTERNAL');

-- CreateEnum
CREATE TYPE "public"."ShipmentPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "public"."ShipmentStatus" AS ENUM ('DRAFT', 'PLANNED', 'ASSIGNED', 'EN_ROUTE_PICKUP', 'AT_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'AT_DELIVERY', 'DELIVERED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."ShipmentType" AS ENUM ('INBOUND', 'OUTBOUND', 'TRANSFER', 'RETURN');

-- CreateEnum
CREATE TYPE "public"."StopStatus" AS ENUM ('PENDING', 'ARRIVED', 'COMPLETED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "public"."StopType" AS ENUM ('PICKUP', 'DELIVERY', 'CHECKPOINT', 'TRANSIT');

-- CreateEnum
CREATE TYPE "public"."SubscriptionPaymentStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'RECEIVED', 'WAIVED', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."SubscriptionStatus" AS ENUM ('DRAFT', 'PENDING_PAYMENT', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "public"."TrackingSessionStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."UserStatus" AS ENUM ('PENDING_VERIFICATION', 'PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "public"."VehicleOwnerType" AS ENUM ('OWNED', 'ATTACHED', 'THIRD_PARTY');

-- CreateEnum
CREATE TYPE "public"."VehicleStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'UNDER_MAINTENANCE');

-- CreateEnum
CREATE TYPE "public"."WarehouseStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "public"."billing_settings" (
    "id" TEXT NOT NULL,
    "default_invoice_prefix" TEXT NOT NULL DEFAULT 'ALX',
    "billing_grace_days" INTEGER NOT NULL DEFAULT 7,
    "tax_mode" TEXT NOT NULL DEFAULT 'GST inclusive',
    "default_plan_id" UUID,
    "default_payment_collection_method" "public"."PaymentCollectionMethod" NOT NULL DEFAULT 'MANUAL',
    "allow_manual_activation_without_payment" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."branding_settings" (
    "id" TEXT NOT NULL,
    "logo_file" TEXT,
    "brand_primary_color" TEXT NOT NULL DEFAULT '#7C3AED',
    "brand_secondary_color" TEXT NOT NULL DEFAULT '#1447E6',
    "brand_tagline" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branding_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."company_client_locations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "company_client_id" UUID NOT NULL,
    "location_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address_line_1" TEXT NOT NULL,
    "address_line_2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postal_code" TEXT,
    "country" TEXT DEFAULT 'India',
    "gstin" TEXT,
    "contact_name" TEXT,
    "contact_phone" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_client_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."company_clients" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "company_client_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "industry" TEXT,
    "status" "public"."ClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "pan" TEXT,
    "gstin" TEXT,
    "credit_terms" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "billing_cycle" TEXT,
    "company_type" TEXT,
    "contact_email" TEXT,
    "contact_person" TEXT,
    "contact_phone" TEXT,
    "credit_account" BOOLEAN NOT NULL DEFAULT false,
    "designation" TEXT,

    CONSTRAINT "company_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shipment_id" UUID,
    "entity_type" "public"."DocumentEntityType" NOT NULL,
    "entity_id" UUID NOT NULL,
    "document_type" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "storage_bucket" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT,
    "file_size" INTEGER,
    "status" "public"."DocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "uploaded_by" UUID,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."drivers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID,
    "driver_code" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "employment_type" "public"."EmploymentType" NOT NULL,
    "status" "public"."DriverStatus" NOT NULL DEFAULT 'ACTIVE',
    "license_number" TEXT,
    "license_expiry" TIMESTAMP(3),
    "home_base" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."independent_driver_registrations" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "full_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "date_of_birth" TIMESTAMP(3),
    "gender" "public"."Gender",
    "address_line_1" TEXT NOT NULL,
    "address_line_2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "postal_code" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "home_base_location" TEXT,
    "license_number" TEXT NOT NULL,
    "license_expiry" TIMESTAMP(3) NOT NULL,
    "license_type" "public"."DriverLicenseType",
    "license_issue_date" TIMESTAMP(3),
    "license_issuing_state" TEXT,
    "aadhaar_number" TEXT,
    "pan_number" TEXT,
    "vehicle_number" TEXT NOT NULL,
    "vehicle_type" TEXT NOT NULL,
    "vehicle_model" TEXT,
    "vehicle_capacity" DECIMAL(12,2),
    "vehicle_owner_name" TEXT,
    "vehicle_registration_state" TEXT,
    "fuel_type" "public"."FuelType",
    "uploaded_documents" JSONB NOT NULL,
    "status" "public"."IndependentDriverRegistrationStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "approved_at" TIMESTAMP(3),
    "approved_by_user_id" UUID,
    "rejected_at" TIMESTAMP(3),
    "rejected_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "driver_code" TEXT,

    CONSTRAINT "independent_driver_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."integration_settings" (
    "id" TEXT NOT NULL,
    "maps_provider" TEXT NOT NULL DEFAULT 'Google Maps',
    "maps_api_key" TEXT,
    "messaging_provider" TEXT NOT NULL DEFAULT 'Twilio',
    "messaging_api_key" TEXT,
    "external_api_enabled" BOOLEAN NOT NULL DEFAULT false,
    "external_api_base_url" TEXT,
    "external_api_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."inventory_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "item_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "unit_of_measure" TEXT NOT NULL,
    "min_threshold" DECIMAL(12,2),
    "max_threshold" DECIMAL(12,2),
    "status" "public"."InventoryItemStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."inventory_movements" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "inventory_item_id" UUID NOT NULL,
    "movement_type" "public"."InventoryMovementType" NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "storage_location" TEXT,
    "reference_type" TEXT,
    "reference_id" TEXT,
    "notes" TEXT,
    "performed_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."inventory_stocks" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "inventory_item_id" UUID NOT NULL,
    "storage_location" TEXT,
    "quantity_on_hand" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_stocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."notification_settings" (
    "id" TEXT NOT NULL,
    "email_shipment_alerts" BOOLEAN NOT NULL DEFAULT true,
    "email_delay_alerts" BOOLEAN NOT NULL DEFAULT true,
    "email_delivery_alerts" BOOLEAN NOT NULL DEFAULT true,
    "sms_shipment_alerts" BOOLEAN NOT NULL DEFAULT false,
    "whatsapp_delay_alerts" BOOLEAN NOT NULL DEFAULT true,
    "whatsapp_delivery_alerts" BOOLEAN NOT NULL DEFAULT false,
    "notification_template_name" TEXT,
    "notification_template_body" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."organization_locations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address_line_1" TEXT NOT NULL,
    "address_line_2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postal_code" TEXT,
    "country" TEXT DEFAULT 'India',
    "gstin" TEXT,
    "contact_phone" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."organization_subscriptions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "public"."SubscriptionStatus" NOT NULL DEFAULT 'DRAFT',
    "payment_status" "public"."SubscriptionPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "payment_collection_method" "public"."PaymentCollectionMethod" NOT NULL DEFAULT 'MANUAL',
    "billing_amount" DECIMAL(12,2) NOT NULL,
    "billing_currency" TEXT NOT NULL DEFAULT 'INR',
    "starts_at" TIMESTAMP(3),
    "renews_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "grace_ends_at" TIMESTAMP(3),
    "activated_at" TIMESTAMP(3),
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "metadata" JSONB,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."organization_users" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "public"."OrganizationRole" NOT NULL,
    "status" "public"."MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "status" "public"."OrganizationStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "approved_at" TIMESTAMP(3),
    "approved_by_user_id" UUID,
    "owner_user_id" UUID,
    "rejected_at" TIMESTAMP(3),
    "rejected_reason" TEXT,
    "submitted_by_user_id" UUID,
    "address_line_1" TEXT,
    "address_line_2" TEXT,
    "cin_number" TEXT,
    "city" TEXT,
    "country" TEXT DEFAULT 'India',
    "gst_number" TEXT,
    "pan_number" TEXT,
    "postal_code" TEXT,
    "state" TEXT,
    "billing_cycle" TEXT,
    "client_code" TEXT,
    "client_segment" TEXT,
    "client_status" "public"."ClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "company_type" TEXT,
    "contact_email" TEXT,
    "contact_person" TEXT,
    "contact_phone" TEXT,
    "credit_account" BOOLEAN NOT NULL DEFAULT false,
    "designation" TEXT,
    "industry" TEXT,
    "notes" TEXT,
    "priority_client" BOOLEAN NOT NULL DEFAULT true,
    "tags" TEXT,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."platform_identity_settings" (
    "id" TEXT NOT NULL,
    "platform_name" TEXT NOT NULL,
    "support_email" TEXT,
    "support_phone" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "language" TEXT NOT NULL DEFAULT 'English',
    "date_format" TEXT NOT NULL DEFAULT 'DD-MM-YYYY',
    "regional_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_identity_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."platform_settings_revisions" (
    "id" TEXT NOT NULL,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."proof_of_delivery" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "proof_type" "public"."ProofType" NOT NULL,
    "photo_document_id" UUID,
    "signature_document_id" UUID,
    "receiver_name" TEXT,
    "receiver_phone" TEXT,
    "remarks" TEXT,
    "captured_by" UUID,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proof_of_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."security_settings" (
    "id" TEXT NOT NULL,
    "session_timeout_minutes" INTEGER NOT NULL DEFAULT 45,
    "max_login_attempts" INTEGER NOT NULL DEFAULT 5,
    "password_min_length" INTEGER NOT NULL DEFAULT 10,
    "require_uppercase" BOOLEAN NOT NULL DEFAULT true,
    "require_numbers" BOOLEAN NOT NULL DEFAULT true,
    "require_special_chars" BOOLEAN NOT NULL DEFAULT true,
    "allow_remember_me" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "security_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."shipment_assignments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "vehicle_id" UUID,
    "assignment_status" "public"."ShipmentAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassigned_at" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "shipment_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."shipment_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unit" TEXT NOT NULL,
    "weight" DECIMAL(12,2),
    "volume" DECIMAL(12,2),
    "declared_value" DECIMAL(14,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."shipment_status_events" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "driver_id" UUID,
    "event_type" TEXT NOT NULL,
    "from_status" "public"."ShipmentStatus",
    "to_status" "public"."ShipmentStatus",
    "event_time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "public"."EventSource" NOT NULL DEFAULT 'SYSTEM',
    "notes" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."shipment_stops" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "stop_sequence" INTEGER NOT NULL,
    "stop_type" "public"."StopType" NOT NULL,
    "location_name" TEXT NOT NULL,
    "address_line_1" TEXT,
    "address_line_2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postal_code" TEXT,
    "country" TEXT DEFAULT 'India',
    "planned_arrival_at" TIMESTAMP(3),
    "actual_arrival_at" TIMESTAMP(3),
    "planned_departure_at" TIMESTAMP(3),
    "actual_departure_at" TIMESTAMP(3),
    "status" "public"."StopStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipment_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."shipments" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shipment_code" TEXT NOT NULL,
    "company_client_id" UUID,
    "shipment_type" "public"."ShipmentType" NOT NULL,
    "status" "public"."ShipmentStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" "public"."ShipmentPriority" NOT NULL DEFAULT 'MEDIUM',
    "source_location_id" UUID,
    "destination_location_id" UUID,
    "source_address_snapshot" JSONB,
    "destination_address_snapshot" JSONB,
    "planned_pickup_at" TIMESTAMP(3),
    "planned_delivery_at" TIMESTAMP(3),
    "actual_pickup_at" TIMESTAMP(3),
    "actual_delivery_at" TIMESTAMP(3),
    "current_driver_id" UUID,
    "current_vehicle_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "current_tracking_session_id" UUID,
    "invoice_amount" DECIMAL(14,2),
    "invoice_date" TIMESTAMP(3),
    "invoice_number" TEXT,
    "internal_receiver_department" TEXT,
    "internal_receiver_name" TEXT,
    "internal_receiver_phone" TEXT,
    "internal_sender_department" TEXT,
    "internal_sender_name" TEXT,
    "internal_sender_phone" TEXT,
    "shipment_mode" "public"."ShipmentMode" NOT NULL DEFAULT 'BUSINESS',
    "admin_form_data" JSONB,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."subscription_plans" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price_amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "billing_cycle" "public"."PlanBillingCycle" NOT NULL DEFAULT 'MONTHLY',
    "tenant_cap" INTEGER,
    "shipment_cap_per_day" INTEGER,
    "grace_days" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" "public"."PlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."system_settings" (
    "id" TEXT NOT NULL,
    "tenant_id_pattern" TEXT NOT NULL DEFAULT 'TEN-{YYYY}-{SEQ4}',
    "shipment_id_pattern" TEXT NOT NULL DEFAULT 'SHP-{YYYYMMDD}-{SEQ6}',
    "data_retention_days" INTEGER NOT NULL DEFAULT 365,
    "audit_retention_days" INTEGER NOT NULL DEFAULT 730,
    "enable_driver_marketplace" BOOLEAN NOT NULL DEFAULT true,
    "enable_smart_tracking" BOOLEAN NOT NULL DEFAULT true,
    "enable_experimental_billing" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."tenant_governance_settings" (
    "id" TEXT NOT NULL,
    "auto_approval" BOOLEAN NOT NULL DEFAULT false,
    "require_document_verification" BOOLEAN NOT NULL DEFAULT true,
    "tenant_limit_policy" TEXT NOT NULL DEFAULT 'Standard',
    "approval_workflow" TEXT NOT NULL DEFAULT 'Two-step approval',
    "tenant_operational_limit" TEXT,
    "tenant_review_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_governance_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."tracking_points" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "tracking_session_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "speed" DECIMAL(10,2),
    "heading" DECIMAL(10,2),
    "accuracy" DECIMAL(10,2),
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."tracking_sessions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "status" "public"."TrackingSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracking_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "password_hash" TEXT,
    "status" "public"."UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "approved_at" TIMESTAMP(3),
    "approved_by_user_id" UUID,
    "email_verified_at" TIMESTAMP(3),
    "full_name" TEXT NOT NULL,
    "platform_role" "public"."PlatformRole",
    "rejected_at" TIMESTAMP(3),
    "rejected_reason" TEXT,
    "verification_token" TEXT,
    "verification_token_expires_at" TIMESTAMP(3),
    "reset_password_token" TEXT,
    "reset_password_token_expires_at" TIMESTAMP(3),
    "login_otp_expires_at" TIMESTAMP(3),
    "login_otp_hash" TEXT,
    "login_otp_requested_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."vehicles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "vehicle_number" TEXT NOT NULL,
    "vehicle_type" TEXT NOT NULL,
    "capacity_weight" DECIMAL(12,2),
    "capacity_volume" DECIMAL(12,2),
    "owner_type" "public"."VehicleOwnerType" NOT NULL DEFAULT 'OWNED',
    "status" "public"."VehicleStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."warehouses" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "warehouse_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address_line_1" TEXT,
    "address_line_2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postal_code" TEXT,
    "country" TEXT DEFAULT 'India',
    "status" "public"."WarehouseStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_settings_default_plan_id_idx" ON "public"."billing_settings"("default_plan_id" ASC);

-- CreateIndex
CREATE INDEX "company_client_locations_company_client_id_idx" ON "public"."company_client_locations"("company_client_id" ASC);

-- CreateIndex
CREATE INDEX "company_client_locations_company_client_id_is_primary_idx" ON "public"."company_client_locations"("company_client_id" ASC, "is_primary" ASC);

-- CreateIndex
CREATE INDEX "company_client_locations_organization_id_idx" ON "public"."company_client_locations"("organization_id" ASC);

-- CreateIndex
CREATE INDEX "company_clients_gstin_idx" ON "public"."company_clients"("gstin" ASC);

-- CreateIndex
CREATE INDEX "company_clients_name_idx" ON "public"."company_clients"("name" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "company_clients_organization_id_company_client_code_key" ON "public"."company_clients"("organization_id" ASC, "company_client_code" ASC);

-- CreateIndex
CREATE INDEX "company_clients_organization_id_idx" ON "public"."company_clients"("organization_id" ASC);

-- CreateIndex
CREATE INDEX "company_clients_status_idx" ON "public"."company_clients"("status" ASC);

-- CreateIndex
CREATE INDEX "documents_document_type_idx" ON "public"."documents"("document_type" ASC);

-- CreateIndex
CREATE INDEX "documents_entity_type_entity_id_idx" ON "public"."documents"("entity_type" ASC, "entity_id" ASC);

-- CreateIndex
CREATE INDEX "documents_organization_id_idx" ON "public"."documents"("organization_id" ASC);

-- CreateIndex
CREATE INDEX "documents_shipment_id_idx" ON "public"."documents"("shipment_id" ASC);

-- CreateIndex
CREATE INDEX "documents_uploaded_at_idx" ON "public"."documents"("uploaded_at" DESC);

-- CreateIndex
CREATE INDEX "drivers_license_expiry_idx" ON "public"."drivers"("license_expiry" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "drivers_organization_id_driver_code_key" ON "public"."drivers"("organization_id" ASC, "driver_code" ASC);

-- CreateIndex
CREATE INDEX "drivers_organization_id_idx" ON "public"."drivers"("organization_id" ASC);

-- CreateIndex
CREATE INDEX "drivers_phone_idx" ON "public"."drivers"("phone" ASC);

-- CreateIndex
CREATE INDEX "drivers_status_idx" ON "public"."drivers"("status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "drivers_user_id_key" ON "public"."drivers"("user_id" ASC);

-- CreateIndex
CREATE INDEX "independent_driver_registrations_driver_code_idx" ON "public"."independent_driver_registrations"("driver_code" ASC);

-- CreateIndex
CREATE INDEX "independent_driver_registrations_organization_id_idx" ON "public"."independent_driver_registrations"("organization_id" ASC);

-- CreateIndex
CREATE INDEX "independent_driver_registrations_phone_idx" ON "public"."independent_driver_registrations"("phone" ASC);

-- CreateIndex
CREATE INDEX "independent_driver_registrations_status_idx" ON "public"."independent_driver_registrations"("status" ASC);

-- CreateIndex
CREATE INDEX "independent_driver_registrations_vehicle_number_idx" ON "public"."independent_driver_registrations"("vehicle_number" ASC);

-- CreateIndex
CREATE INDEX "inventory_items_category_idx" ON "public"."inventory_items"("category" ASC);

-- CreateIndex
CREATE INDEX "inventory_items_organization_id_idx" ON "public"."inventory_items"("organization_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_organization_id_item_code_key" ON "public"."inventory_items"("organization_id" ASC, "item_code" ASC);

-- CreateIndex
CREATE INDEX "inventory_items_status_idx" ON "public"."inventory_items"("status" ASC);

-- CreateIndex
CREATE INDEX "inventory_movements_created_at_idx" ON "public"."inventory_movements"("created_at" DESC);

-- CreateIndex
CREATE INDEX "inventory_movements_inventory_item_id_idx" ON "public"."inventory_movements"("inventory_item_id" ASC);

-- CreateIndex
CREATE INDEX "inventory_movements_organization_id_idx" ON "public"."inventory_movements"("organization_id" ASC);

-- CreateIndex
CREATE INDEX "inventory_movements_reference_id_idx" ON "public"."inventory_movements"("reference_id" ASC);

-- CreateIndex
CREATE INDEX "inventory_movements_warehouse_id_idx" ON "public"."inventory_movements"("warehouse_id" ASC);

-- CreateIndex
CREATE INDEX "inventory_stocks_inventory_item_id_idx" ON "public"."inventory_stocks"("inventory_item_id" ASC);

-- CreateIndex
CREATE INDEX "inventory_stocks_organization_id_idx" ON "public"."inventory_stocks"("organization_id" ASC);

-- CreateIndex
CREATE INDEX "inventory_stocks_warehouse_id_idx" ON "public"."inventory_stocks"("warehouse_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_stocks_warehouse_id_inventory_item_id_storage_loc_key" ON "public"."inventory_stocks"("warehouse_id" ASC, "inventory_item_id" ASC, "storage_location" ASC);

-- CreateIndex
CREATE INDEX "organization_locations_organization_id_idx" ON "public"."organization_locations"("organization_id" ASC);

-- CreateIndex
CREATE INDEX "organization_locations_organization_id_is_primary_idx" ON "public"."organization_locations"("organization_id" ASC, "is_primary" ASC);

-- CreateIndex
CREATE INDEX "organization_subscriptions_created_by_user_id_idx" ON "public"."organization_subscriptions"("created_by_user_id" ASC);

-- CreateIndex
CREATE INDEX "organization_subscriptions_organization_id_idx" ON "public"."organization_subscriptions"("organization_id" ASC);

-- CreateIndex
CREATE INDEX "organization_subscriptions_organization_id_is_current_idx" ON "public"."organization_subscriptions"("organization_id" ASC, "is_current" ASC);

-- CreateIndex
CREATE INDEX "organization_subscriptions_plan_id_idx" ON "public"."organization_subscriptions"("plan_id" ASC);

-- CreateIndex
CREATE INDEX "organization_subscriptions_status_idx" ON "public"."organization_subscriptions"("status" ASC);

-- CreateIndex
CREATE INDEX "organization_users_organization_id_idx" ON "public"."organization_users"("organization_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "organization_users_organization_id_user_id_key" ON "public"."organization_users"("organization_id" ASC, "user_id" ASC);

-- CreateIndex
CREATE INDEX "organization_users_role_idx" ON "public"."organization_users"("role" ASC);

-- CreateIndex
CREATE INDEX "organization_users_user_id_idx" ON "public"."organization_users"("user_id" ASC);

-- CreateIndex
CREATE INDEX "organizations_client_code_idx" ON "public"."organizations"("client_code" ASC);

-- CreateIndex
CREATE INDEX "platform_settings_revisions_updated_by_user_id_idx" ON "public"."platform_settings_revisions"("updated_by_user_id" ASC);

-- CreateIndex
CREATE INDEX "proof_of_delivery_captured_at_idx" ON "public"."proof_of_delivery"("captured_at" DESC);

-- CreateIndex
CREATE INDEX "proof_of_delivery_organization_id_idx" ON "public"."proof_of_delivery"("organization_id" ASC);

-- CreateIndex
CREATE INDEX "proof_of_delivery_proof_type_idx" ON "public"."proof_of_delivery"("proof_type" ASC);

-- CreateIndex
CREATE INDEX "proof_of_delivery_shipment_id_idx" ON "public"."proof_of_delivery"("shipment_id" ASC);

-- CreateIndex
CREATE INDEX "shipment_assignments_assigned_at_idx" ON "public"."shipment_assignments"("assigned_at" ASC);

-- CreateIndex
CREATE INDEX "shipment_assignments_assignment_status_idx" ON "public"."shipment_assignments"("assignment_status" ASC);

-- CreateIndex
CREATE INDEX "shipment_assignments_driver_id_idx" ON "public"."shipment_assignments"("driver_id" ASC);

-- CreateIndex
CREATE INDEX "shipment_assignments_organization_id_idx" ON "public"."shipment_assignments"("organization_id" ASC);

-- CreateIndex
CREATE INDEX "shipment_assignments_shipment_id_idx" ON "public"."shipment_assignments"("shipment_id" ASC);

-- CreateIndex
CREATE INDEX "shipment_assignments_vehicle_id_idx" ON "public"."shipment_assignments"("vehicle_id" ASC);

-- CreateIndex
CREATE INDEX "shipment_items_organization_id_idx" ON "public"."shipment_items"("organization_id" ASC);

-- CreateIndex
CREATE INDEX "shipment_items_shipment_id_idx" ON "public"."shipment_items"("shipment_id" ASC);

-- CreateIndex
CREATE INDEX "shipment_status_events_event_time_idx" ON "public"."shipment_status_events"("event_time" DESC);

-- CreateIndex
CREATE INDEX "shipment_status_events_event_type_idx" ON "public"."shipment_status_events"("event_type" ASC);

-- CreateIndex
CREATE INDEX "shipment_status_events_organization_id_idx" ON "public"."shipment_status_events"("organization_id" ASC);

-- CreateIndex
CREATE INDEX "shipment_status_events_shipment_id_idx" ON "public"."shipment_status_events"("shipment_id" ASC);

-- CreateIndex
CREATE INDEX "shipment_stops_organization_id_idx" ON "public"."shipment_stops"("organization_id" ASC);

-- CreateIndex
CREATE INDEX "shipment_stops_shipment_id_idx" ON "public"."shipment_stops"("shipment_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "shipment_stops_shipment_id_stop_sequence_key" ON "public"."shipment_stops"("shipment_id" ASC, "stop_sequence" ASC);

-- CreateIndex
CREATE INDEX "shipment_stops_stop_type_idx" ON "public"."shipment_stops"("stop_type" ASC);

-- CreateIndex
CREATE INDEX "shipments_company_client_id_idx" ON "public"."shipments"("company_client_id" ASC);

-- CreateIndex
CREATE INDEX "shipments_current_driver_id_idx" ON "public"."shipments"("current_driver_id" ASC);

-- CreateIndex
CREATE INDEX "shipments_current_tracking_session_id_idx" ON "public"."shipments"("current_tracking_session_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "shipments_current_tracking_session_id_key" ON "public"."shipments"("current_tracking_session_id" ASC);

-- CreateIndex
CREATE INDEX "shipments_invoice_number_idx" ON "public"."shipments"("invoice_number" ASC);

-- CreateIndex
CREATE INDEX "shipments_organization_id_idx" ON "public"."shipments"("organization_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "shipments_organization_id_invoice_number_key" ON "public"."shipments"("organization_id" ASC, "invoice_number" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "shipments_organization_id_shipment_code_key" ON "public"."shipments"("organization_id" ASC, "shipment_code" ASC);

-- CreateIndex
CREATE INDEX "shipments_planned_delivery_at_idx" ON "public"."shipments"("planned_delivery_at" ASC);

-- CreateIndex
CREATE INDEX "shipments_planned_pickup_at_idx" ON "public"."shipments"("planned_pickup_at" ASC);

-- CreateIndex
CREATE INDEX "shipments_status_idx" ON "public"."shipments"("status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_code_key" ON "public"."subscription_plans"("code" ASC);

-- CreateIndex
CREATE INDEX "subscription_plans_is_default_idx" ON "public"."subscription_plans"("is_default" ASC);

-- CreateIndex
CREATE INDEX "subscription_plans_sort_order_idx" ON "public"."subscription_plans"("sort_order" ASC);

-- CreateIndex
CREATE INDEX "subscription_plans_status_idx" ON "public"."subscription_plans"("status" ASC);

-- CreateIndex
CREATE INDEX "tracking_points_driver_id_idx" ON "public"."tracking_points"("driver_id" ASC);

-- CreateIndex
CREATE INDEX "tracking_points_organization_id_idx" ON "public"."tracking_points"("organization_id" ASC);

-- CreateIndex
CREATE INDEX "tracking_points_recorded_at_idx" ON "public"."tracking_points"("recorded_at" DESC);

-- CreateIndex
CREATE INDEX "tracking_points_shipment_id_idx" ON "public"."tracking_points"("shipment_id" ASC);

-- CreateIndex
CREATE INDEX "tracking_points_tracking_session_id_idx" ON "public"."tracking_points"("tracking_session_id" ASC);

-- CreateIndex
CREATE INDEX "tracking_sessions_driver_id_idx" ON "public"."tracking_sessions"("driver_id" ASC);

-- CreateIndex
CREATE INDEX "tracking_sessions_organization_id_idx" ON "public"."tracking_sessions"("organization_id" ASC);

-- CreateIndex
CREATE INDEX "tracking_sessions_shipment_id_idx" ON "public"."tracking_sessions"("shipment_id" ASC);

-- CreateIndex
CREATE INDEX "tracking_sessions_status_idx" ON "public"."tracking_sessions"("status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "public"."users"("email" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "public"."users"("phone" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "users_reset_password_token_key" ON "public"."users"("reset_password_token" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "users_verification_token_key" ON "public"."users"("verification_token" ASC);

-- CreateIndex
CREATE INDEX "vehicles_organization_id_idx" ON "public"."vehicles"("organization_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_organization_id_vehicle_number_key" ON "public"."vehicles"("organization_id" ASC, "vehicle_number" ASC);

-- CreateIndex
CREATE INDEX "vehicles_status_idx" ON "public"."vehicles"("status" ASC);

-- CreateIndex
CREATE INDEX "vehicles_vehicle_number_idx" ON "public"."vehicles"("vehicle_number" ASC);

-- CreateIndex
CREATE INDEX "warehouses_organization_id_idx" ON "public"."warehouses"("organization_id" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_organization_id_warehouse_code_key" ON "public"."warehouses"("organization_id" ASC, "warehouse_code" ASC);

-- CreateIndex
CREATE INDEX "warehouses_status_idx" ON "public"."warehouses"("status" ASC);

-- AddForeignKey
ALTER TABLE "public"."billing_settings" ADD CONSTRAINT "billing_settings_default_plan_id_fkey" FOREIGN KEY ("default_plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."company_client_locations" ADD CONSTRAINT "company_client_locations_company_client_id_fkey" FOREIGN KEY ("company_client_id") REFERENCES "public"."company_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."company_client_locations" ADD CONSTRAINT "company_client_locations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."company_clients" ADD CONSTRAINT "company_clients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."documents" ADD CONSTRAINT "documents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."documents" ADD CONSTRAINT "documents_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."drivers" ADD CONSTRAINT "drivers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."drivers" ADD CONSTRAINT "drivers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."independent_driver_registrations" ADD CONSTRAINT "independent_driver_registrations_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."independent_driver_registrations" ADD CONSTRAINT "independent_driver_registrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."inventory_items" ADD CONSTRAINT "inventory_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."inventory_movements" ADD CONSTRAINT "inventory_movements_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."inventory_movements" ADD CONSTRAINT "inventory_movements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."inventory_movements" ADD CONSTRAINT "inventory_movements_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."inventory_stocks" ADD CONSTRAINT "inventory_stocks_inventory_item_id_fkey" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."inventory_stocks" ADD CONSTRAINT "inventory_stocks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."inventory_stocks" ADD CONSTRAINT "inventory_stocks_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."organization_locations" ADD CONSTRAINT "organization_locations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."organization_users" ADD CONSTRAINT "organization_users_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."organization_users" ADD CONSTRAINT "organization_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."platform_settings_revisions" ADD CONSTRAINT "platform_settings_revisions_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."proof_of_delivery" ADD CONSTRAINT "proof_of_delivery_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."proof_of_delivery" ADD CONSTRAINT "proof_of_delivery_photo_document_id_fkey" FOREIGN KEY ("photo_document_id") REFERENCES "public"."documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."proof_of_delivery" ADD CONSTRAINT "proof_of_delivery_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."proof_of_delivery" ADD CONSTRAINT "proof_of_delivery_signature_document_id_fkey" FOREIGN KEY ("signature_document_id") REFERENCES "public"."documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shipment_assignments" ADD CONSTRAINT "shipment_assignments_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shipment_assignments" ADD CONSTRAINT "shipment_assignments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shipment_assignments" ADD CONSTRAINT "shipment_assignments_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shipment_assignments" ADD CONSTRAINT "shipment_assignments_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shipment_items" ADD CONSTRAINT "shipment_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shipment_items" ADD CONSTRAINT "shipment_items_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shipment_status_events" ADD CONSTRAINT "shipment_status_events_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shipment_status_events" ADD CONSTRAINT "shipment_status_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shipment_status_events" ADD CONSTRAINT "shipment_status_events_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shipment_stops" ADD CONSTRAINT "shipment_stops_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shipment_stops" ADD CONSTRAINT "shipment_stops_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shipments" ADD CONSTRAINT "shipments_company_client_id_fkey" FOREIGN KEY ("company_client_id") REFERENCES "public"."company_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shipments" ADD CONSTRAINT "shipments_current_driver_id_fkey" FOREIGN KEY ("current_driver_id") REFERENCES "public"."drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shipments" ADD CONSTRAINT "shipments_current_tracking_session_id_fkey" FOREIGN KEY ("current_tracking_session_id") REFERENCES "public"."tracking_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shipments" ADD CONSTRAINT "shipments_current_vehicle_id_fkey" FOREIGN KEY ("current_vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shipments" ADD CONSTRAINT "shipments_destination_location_id_fkey" FOREIGN KEY ("destination_location_id") REFERENCES "public"."company_client_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shipments" ADD CONSTRAINT "shipments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."shipments" ADD CONSTRAINT "shipments_source_location_id_fkey" FOREIGN KEY ("source_location_id") REFERENCES "public"."company_client_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tracking_points" ADD CONSTRAINT "tracking_points_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tracking_points" ADD CONSTRAINT "tracking_points_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tracking_points" ADD CONSTRAINT "tracking_points_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tracking_points" ADD CONSTRAINT "tracking_points_tracking_session_id_fkey" FOREIGN KEY ("tracking_session_id") REFERENCES "public"."tracking_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tracking_sessions" ADD CONSTRAINT "tracking_sessions_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tracking_sessions" ADD CONSTRAINT "tracking_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tracking_sessions" ADD CONSTRAINT "tracking_sessions_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."vehicles" ADD CONSTRAINT "vehicles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."warehouses" ADD CONSTRAINT "warehouses_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


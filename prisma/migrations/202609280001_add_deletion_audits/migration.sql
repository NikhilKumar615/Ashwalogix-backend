CREATE TABLE "deletion_audits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "entity_label" TEXT,
    "reason" TEXT NOT NULL,
    "deleted_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deletion_audits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "deletion_audits_organization_id_idx" ON "deletion_audits"("organization_id");
CREATE INDEX "deletion_audits_entity_type_entity_id_idx" ON "deletion_audits"("entity_type", "entity_id");

ALTER TABLE "vehicles"
ADD COLUMN "vehicle_code" TEXT;

CREATE UNIQUE INDEX "vehicles_organization_id_vehicle_code_key"
ON "vehicles"("organization_id", "vehicle_code");

CREATE INDEX "vehicles_vehicle_code_idx"
ON "vehicles"("vehicle_code");

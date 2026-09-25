-- CreateEnum
CREATE TYPE "StorageLocationStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "destination_storage_location" TEXT,
ADD COLUMN     "destination_warehouse_id" UUID,
ADD COLUMN     "reversal_of_movement_id" UUID,
ADD COLUMN     "storage_location_id" UUID;

-- AlterTable
ALTER TABLE "inventory_stocks" ADD COLUMN     "storage_location_id" UUID;

-- CreateTable
CREATE TABLE "storage_locations" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "StorageLocationStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_locations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "storage_locations_warehouse_id_idx" ON "storage_locations"("warehouse_id");

-- CreateIndex
CREATE INDEX "storage_locations_status_idx" ON "storage_locations"("status");

-- CreateIndex
CREATE UNIQUE INDEX "storage_locations_warehouse_id_code_key" ON "storage_locations"("warehouse_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_movements_reversal_of_movement_id_key" ON "inventory_movements"("reversal_of_movement_id");

-- CreateIndex
CREATE INDEX "inventory_movements_storage_location_id_idx" ON "inventory_movements"("storage_location_id");

-- CreateIndex
CREATE INDEX "inventory_movements_destination_warehouse_id_idx" ON "inventory_movements"("destination_warehouse_id");

-- CreateIndex
CREATE INDEX "inventory_stocks_storage_location_id_idx" ON "inventory_stocks"("storage_location_id");

-- AddForeignKey
ALTER TABLE "inventory_stocks" ADD CONSTRAINT "inventory_stocks_storage_location_id_fkey" FOREIGN KEY ("storage_location_id") REFERENCES "storage_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_storage_location_id_fkey" FOREIGN KEY ("storage_location_id") REFERENCES "storage_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_destination_warehouse_id_fkey" FOREIGN KEY ("destination_warehouse_id") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_reversal_of_movement_id_fkey" FOREIGN KEY ("reversal_of_movement_id") REFERENCES "inventory_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE CASCADE ON UPDATE CASCADE;


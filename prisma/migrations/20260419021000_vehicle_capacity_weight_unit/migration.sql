CREATE TYPE "VehicleCapacityWeightUnit" AS ENUM ('KG', 'MT');

ALTER TABLE "vehicles"
ADD COLUMN "capacity_weight_unit" "VehicleCapacityWeightUnit" NOT NULL DEFAULT 'KG';

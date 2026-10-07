-- Shipment lifecycle hardening: actor on status events + composite indexes
-- for the hot read paths (tracking history, timelines, org shipment lists,
-- driver/vehicle availability checks, active tracking session lookups).

-- AlterTable
ALTER TABLE "shipment_status_events" ADD COLUMN "actor_user_id" UUID;

-- CreateIndex
CREATE INDEX "shipments_organization_id_status_created_at_idx" ON "shipments"("organization_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "shipment_assignments_driver_id_assignment_status_idx" ON "shipment_assignments"("driver_id", "assignment_status");

-- CreateIndex
CREATE INDEX "shipment_assignments_vehicle_id_assignment_status_idx" ON "shipment_assignments"("vehicle_id", "assignment_status");

-- CreateIndex
CREATE INDEX "shipment_status_events_shipment_id_event_time_idx" ON "shipment_status_events"("shipment_id", "event_time");

-- CreateIndex
CREATE INDEX "shipment_status_events_actor_user_id_idx" ON "shipment_status_events"("actor_user_id");

-- CreateIndex
CREATE INDEX "tracking_sessions_shipment_id_status_idx" ON "tracking_sessions"("shipment_id", "status");

-- CreateIndex
CREATE INDEX "tracking_points_shipment_id_recorded_at_idx" ON "tracking_points"("shipment_id", "recorded_at");

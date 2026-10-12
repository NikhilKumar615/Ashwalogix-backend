CREATE TABLE "notifications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID,
  "registration_id" UUID,
  "organization_id" UUID,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "data" JSONB,
  "dedupe_key" TEXT,
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");
CREATE INDEX "notifications_registration_id_idx" ON "notifications"("registration_id");

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_registration_id_fkey"
  FOREIGN KEY ("registration_id") REFERENCES "independent_driver_registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "independent_driver_registrations" ADD COLUMN "expo_push_token" TEXT;

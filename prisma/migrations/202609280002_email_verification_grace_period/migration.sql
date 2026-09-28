ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "email_verification_suspended_at" TIMESTAMP(3);

# AWS to Neon, Cloudinary, and Resend

The backend no longer includes AWS SDK packages. Its runtime integrations are:

- PostgreSQL: Neon
- Document storage: Cloudinary authenticated raw assets
- Transactional email: Resend

## Configure providers

Copy the values from `.env.example` into the deployment environment.

- Set `DATABASE_URL` to Neon’s pooled connection string for the running API.
- Set `DIRECT_DATABASE_URL` to Neon’s direct (non-pooled) connection string. Prisma CLI migration commands use this value when it is present.
- Configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`. Documents are uploaded as `raw` assets with Cloudinary’s `authenticated` delivery type, not as public URLs.
- Verify the sending domain in Resend, then set `RESEND_API_KEY`, `MAIL_FROM_EMAIL`, and `MAIL_ENABLED=true`.

## Move the database

1. Create a Neon project and database.
2. Restore the RDS PostgreSQL dump into Neon, then set the two Neon connection strings.
3. Run `npx prisma migrate deploy` from `backend` to ensure migration history is current.
4. Start the API and validate the health endpoint and a read/write workflow before switching production traffic.

## Move existing S3 documents

New documents use the Cloudinary key returned by the upload endpoint. Existing `Document` records still point to S3 until their object is copied and its metadata is updated.

1. Export or generate a time-limited download URL for every existing S3 object.
2. Upload each file to Cloudinary as a `raw`, `authenticated` asset.
3. Update the matching database record: set `storageBucket` to the Cloudinary cloud name and `storageKey` to Cloudinary’s returned `public_id`.
4. Call `GET /documents/:documentId/access-url` for representative image, PDF, and non-image files to confirm signed delivery.

Keep the S3 bucket and RDS instance until the data-count and document-access checks pass. Then remove AWS credentials from every deployment environment and decommission the AWS resources.

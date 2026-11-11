# Advocate Priyanka Choudhary website

The site is served by a Node.js application. Enquiries are validated by the server and saved either in local SQLite (for development) or Supabase Postgres (for deployment). Payment screenshots are required only when a visitor marks payment as made; Supabase stores them in a private bucket. The password-protected inbox is available at `/admin`.

## Run locally

Requirements: Node.js 20 or newer and npm.

```sh
npm install
export ADMIN_USERNAME=admin
read -s ADMIN_PASSWORD
export ADMIN_PASSWORD
npm start
```

Enter a unique password of at least 16 characters when prompted. Open `http://localhost:3000`; use `http://localhost:3000/admin` for the inbox. The SQLite database is created at `data/enquiries.sqlite3`.

For a custom local database location, set `DATA_DIR` to a writable directory. Set `PORT` and `HOST` as needed by your environment. If the app is behind a reverse proxy, configure `TRUST_PROXY` to the exact proxy hop count or trusted proxy addresses; do not set it to `true` without understanding the network topology. Local SQLite is not suitable for a host with an ephemeral filesystem.

## Free-tier deployment with Render and Supabase

The included `render.yaml` configures a free Render web service and secure prompts for application credentials. Enquiry records and private screenshots are stored in Supabase so they survive Render restarts; the Render service itself has no persistent disk and may sleep when idle.

1. Create a Supabase project on its free tier.
2. In the Supabase SQL Editor, run [`supabase/schema.sql`](./supabase/schema.sql). This creates the enquiries table with row-level security enabled and a private receipt bucket.
3. In Render, create a Blueprint from the public GitHub repository and use the included `render.yaml`.
4. Enter the Supabase project URL, Supabase `service_role` key, a private admin username, and a unique admin password of at least 16 characters into Render's secret prompts. Never put these values in GitHub or send them in chat.
5. After Render deploys, use its `onrender.com` URL first and verify the site, enquiry form, `/admin`, and private receipt viewing.
6. Configure `adv.priyankachoudhary.com` later only if desired. Add DNS records only after reviewing the targets shown in Render.

Free services have provider quotas and availability limits; Render may sleep while idle and Supabase may enforce free-tier limits or pause inactive projects. Review provider usage and terms regularly. The site is not live until the Blueprint deploy succeeds.

## Hosting and security

- In production, set `STORAGE_MODE=supabase`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`. The service-role key grants privileged access and must remain only in the hosting provider's secret manager.
- The Supabase `payment-receipts` bucket must remain private. The application serves screenshots only through its authenticated admin route; do not add public bucket policies or expose the service-role key to browser code.
- Local development defaults to SQLite and stores its database and screenshots in `data/`. Do not deploy SQLite on an ephemeral filesystem: restarts can erase enquiries and receipts.
- Terminate HTTPS at the hosting provider or a trusted reverse proxy. Do not expose the admin inbox over plain HTTP on a public network.
- Configure `ADMIN_USERNAME` and a unique `ADMIN_PASSWORD` (at least 16 characters) using the host's secret manager. Never commit credentials.
- The default rate limits are per application instance. For multi-instance deployments, use a shared rate-limit store and a shared database solution rather than relying on local SQLite.
- The server does not collect visitor IP addresses and does not automatically delete enquiries. Review and remove records from the inbox when no longer needed.
- The form accepts a PNG, JPEG, or WebP payment screenshot up to 5 MB. A screenshot is required only when the visitor marks that payment has been made. Files are stored outside the public web directory and served only to authenticated admin users. Deleting an enquiry removes its associated screenshot. A screenshot is not proof of settled payment; verify each payment independently.
- Do not ask visitors to submit passwords, one-time codes, identity documents, tax documents, or other sensitive records through this enquiry form.

## Tests

```sh
npm test
```

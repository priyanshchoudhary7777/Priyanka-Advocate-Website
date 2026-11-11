# Advocate Priyanka Choudhary website

The website can be published free as a static GitHub Pages site using `index.html`. The static version opens a prefilled WhatsApp message; it does not save enquiries, provide an admin inbox, or upload payment screenshots. Visitors must press Send in WhatsApp and attach a payment screenshot there if they have paid.

The optional Node.js backend validates and stores enquiries. It uses local SQLite for development or Supabase Postgres and a private Supabase Storage bucket for a hosted deployment. The password-protected inbox is available at `/admin` when the backend is deployed.

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

## Publish the free static site with GitHub Pages

The repository includes a static `index.html`, so GitHub Pages can serve it without a server or payment method.

1. Open the repository's **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**.
3. Select branch `main`, folder `/ (root)`, and save.
4. Wait for the Pages deployment to finish. The site URL is `https://priyanshchoudhary7777.github.io/Priyanka-Advocate-Website/`.

This static option does not run the Node backend. Do not enter sensitive information into the static form; it prepares a message in WhatsApp for the visitor to review and send.

## Optional backend deployment

The included `render.yaml` configures a free Render web service with Supabase-backed enquiries and private receipts. Free services have quotas and availability limits; the service may sleep while idle, and providers may require verification or payment details.

1. Create a Supabase project and run [`supabase/schema.sql`](./supabase/schema.sql) in its SQL Editor.
2. In Render, create a Blueprint from this repository and use `render.yaml`.
3. Enter the Supabase project URL, service-role key, an admin username, and a unique password of at least 16 characters in Render's secret prompts. Never commit or share the service-role key.
4. Verify the Render service URL, enquiry form, `/admin`, and private receipt viewing before using the backend.

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

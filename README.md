# Advocate Priyanka Choudhary website

The site is served by a small Node.js application. Enquiries are validated by the server and saved in SQLite. Payment screenshots are required only when a visitor marks payment as made; they are stored privately. The password-protected inbox is available at `/admin`.

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

For a custom database location, set `DATA_DIR` to a writable directory. Set `PORT` and `HOST` as needed by your environment. If the app is behind a reverse proxy, configure `TRUST_PROXY` to the exact proxy hop count or trusted proxy addresses; do not set it to `true` without understanding the network topology.

## Publish with Render

The included `render.yaml` configures a Node web service, health check, 1 GB persistent disk for the SQLite database and private screenshots, the `adv.priyankachoudhary.com` domain, and secure prompts for the admin credentials.

1. Create a **private GitHub repository** and push this project to it. Do not include `.env`, `data/`, uploads, or `node_modules/`.
2. In Render, choose **New → Blueprint**, connect the repository, and select `render.yaml`.
3. Use a paid web-service plan with a persistent disk (the Blueprint requests the Starter plan). The free plan does not preserve the SQLite database and payment screenshots.
4. When prompted, enter a private admin username and a unique password of at least 16 characters. Do not reuse the local preview credentials.
5. After Render deploys, open its service URL and verify the site, enquiry form, and `/admin`.
6. Configure DNS for `adv.priyankachoudhary.com` using the target and verification records Render shows in the service's **Settings → Custom Domains**. Wait for DNS and HTTPS provisioning, then verify the custom domain.

Until the repository is connected, DNS is configured, and the Render deployment succeeds, the site remains available only through the local preview.

## Hosting and security

- Use a Node.js host with a **persistent writable disk** mounted for `DATA_DIR`. Enquiries are stored in `DATA_DIR/enquiries.sqlite3` and payment screenshots in `DATA_DIR/uploads/`. Ephemeral filesystems lose enquiry data and screenshots on restart or redeploy. Keep separate, access-controlled backups of both.
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

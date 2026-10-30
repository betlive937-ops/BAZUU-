# BAZUU — consent-based link analytics

BAZUU creates short links and counts visits only after the visitor sees a clear notice and chooses **Continue to destination**.

## Privacy by design
- Does not store IP addresses.
- Does not request or collect GPS/location.
- Stores consented click time, broad device category, browser category, and referrer (if provided).
- The visitor can close the notice without continuing.
- Do not use this service to identify, stalk, or monitor people without their knowledge.

## Run locally
1. Install Node.js 18 or newer.
2. Open a terminal in this folder.
3. Run `npm install`.
4. Set environment variables:
   - `BAZUU_ADMIN_USER` — your admin username.
   - `BAZUU_ADMIN_PASSWORD` — a strong password of at least 14 characters.
   - `BASE_URL` — e.g. `http://localhost:3000`.
5. Run `npm start`.
6. Visit `http://localhost:3000/admin`. Your browser will ask for the admin username/password.
7. Create a link using a destination URL. Share the generated `/r/...` link.

## Deploy to Render
1. Create a GitHub repository named `BAZUU`.
2. Upload the contents of this folder to the repository root (not the ZIP itself).
3. In Render, choose **New + → Blueprint**, connect the repository, and deploy `render.yaml`.
4. In the Render service's Environment settings, set:
   - `BAZUU_ADMIN_USER`
   - `BAZUU_ADMIN_PASSWORD` (use a unique, strong password)
   - `BASE_URL` (your full Render URL, e.g. `https://bazuu-example.onrender.com`)
5. Redeploy after setting the environment variables.
6. Open `https://YOUR-RENDER-URL/admin` and sign in.

The included Render blueprint requests a persistent disk at `/var/data`. Persistent disks may require a paid Render plan; check Render's current pricing before deploying. Without persistent storage, local JSON data can be lost when the service restarts or redeploys.

## Important
- Treat the admin URL and password as private.
- Use HTTPS in production (Render provides HTTPS).
- This starter stores analytics in a local JSON file and is intended for a small, low-volume project. For a larger service, use a managed database and add account management, backups, retention controls, and a published privacy policy.
- This is a technical starter, not legal advice. Check applicable privacy laws before operating it.

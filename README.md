# Harbor — campus care

Harbor is a Vercel-hosted web app that uses Supabase Auth for accounts and a managed Supabase PostgreSQL database for reports, case updates, review decisions, and profiles. Git contains the application and SQL schema only; report data is never committed to the repository.

## Important privacy and safety limits

This project is a technical starter, not a certified confidential-reporting service. A report is connected to its reporter account; choosing not to share extra contact information does **not** make a report anonymous. Authorized case staff can read submitted report details. Reviewers receive de-identified similarity suggestions, not report narratives or contact details. Administrators can manage roles and invite accounts.

The portal is not monitored for emergencies and cannot dispatch help. Configure accurate local support and emergency contacts before launch. Before accepting real sensitive information, the institution must review privacy notices, consent, retention and deletion, access controls, email delivery, incident response, backups, audit requirements, accessibility, and applicable law. Use a paid hosting plan with suitable uptime and backup guarantees for production; no hosted service promises perpetual availability.

## Local development

1. Install Node.js 20 or later.
2. Create a Supabase project and run [`database/schema.sql`](./database/schema.sql) in its SQL Editor.
3. Copy `.env.example` to `.env.local` and fill in:

   ```text
   VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY
   SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY
   SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_ONLY_SERVICE_ROLE_KEY
   ```

   The `VITE_` values and anon/publishable key are public client configuration. The service-role key bypasses database policies: use it only in server environment variables, never in `VITE_` variables, client code, or Git.

4. Install and start the app:

   ```sh
   npm install
   npm run dev
   ```

5. Check the production bundle with `npm run build`.

The app's authentication session is managed by Supabase. Report content is stored in PostgreSQL, not browser `localStorage`. Any records from the previous local-only version are left untouched in their existing browser storage and are not automatically imported.

## Supabase setup

1. In Supabase, enable email/password sign-in and turn on **Confirm email** under Authentication provider settings. Email confirmation is required for reporter registration. Configure a production SMTP provider before sending real confirmation, invitation, or recovery links.
2. Set the Supabase Site URL and allowed redirect URLs for local development and the deployed Vercel domain. The confirmation link returns users to the site root.
3. For a new project, run [`database/schema.sql`](./database/schema.sql) once in the SQL Editor. For a project that already has the earlier schema, run [`database/migrations/20261115_harden_case_updates.sql`](./database/migrations/20261115_harden_case_updates.sql) instead. The update routes staff case changes through the audited database function and removes direct table writes that could skip the case history.
4. Register your own account in the app and verify its email. Then, as the project owner, promote that account to the first administrator in the Supabase SQL Editor:

   ```sql
   update public.profiles
   set role = 'admin'
   where email = 'YOUR_VERIFIED_ADMIN_EMAIL';
   ```

   Replace the example address with the verified administrator address. Do not expose SQL Editor or service-role credentials to ordinary users. Admins can then invite staff and reviewers and change roles in the Administration screen.

## Deploy to Vercel

1. Push the application source to a Git provider and import the project into Vercel.
2. Add these environment variables in Vercel's project settings for each deployment environment:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (server-side invitations only)
3. Deploy. Vercel builds the static frontend; `/api/admin/invite` is a serverless function. Supabase provides authentication and durable database storage.
4. Add the deployed domain to Supabase's Site URL and redirect allowlist.

Keep `.env.local` out of Git. `.gitignore` already excludes local environment files. Never copy the service-role key into the `VITE_` variables.

## Install Harbor as an app

The production site is a Progressive Web App. Deploy it on HTTPS, then open its domain in a supported browser. When the browser says installation is available, Harbor shows an **Install app** prompt. On iPhone and iPad, use Safari's Share menu and choose **Add to Home Screen**. Once installed, Harbor opens in a standalone app window without the usual browser address bar.

The service worker caches the built site files so the Harbor screen can reopen offline after its first successful load. Sign in, email confirmation, reports, invitations, and all Supabase data still require an internet connection. Sensitive report data is not stored for offline use. Vite bundles the frontend dependencies during the build; installation does not install a local database or replace the hosted Supabase service.

## Access model

- **Reporter:** creates an account with email and password, confirms the email, creates reports, and reads only their own reports and reporter visible updates.
- **Case staff:** invitation-only; views and manages reports, assigns cases, changes status, and adds updates.
- **Pattern reviewer:** invitation only; receives only potential shared wording details from a database function and records a reasoned human review. Similarity is not proof or a finding.
- **Administrator:** invitation-only; manages roles and sends staff/reviewer invitations. The initial administrator is promoted directly by the Supabase project owner.

Database row-level security is the authority for access. UI navigation is not a security boundary. The service-role key is used only by the admin invitation function and must remain a server secret.

## Configure before real use

- Replace the campus-support placeholder in `index.html` with institution-verified support and emergency resources.
- Review every privacy, contact, and incident-response statement with the responsible office; this project cannot make an unverified confidentiality promise.
- Confirm that Supabase email confirmation is on. Test account registration, confirmation links, invitations, recovery email delivery, database backups, retention, and deletion procedures.
- Review the SQL policies and test them using separate reporter, staff, reviewer, and admin accounts before deployment.
- Decide whether the institution permits the pattern-review feature. It compares report wording in the database and only returns references, dates, and overlap counts to authorized reviewers.

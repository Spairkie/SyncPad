# SyncPad — Deployment Guide

> ⚠️ **Personal / demo project.**  
> Read-only links and view-once are frontend/convenience controls, not backend-enforced security boundaries. (Room lock is the exception — see [Security reminder](#security-reminder) below.)  
> View-once is a convenience feature, not a secure destruction guarantee. A viewer may copy, screenshot, save, or otherwise preserve content before it clears.  
> Do **not** deploy SyncPad for use with passwords, HIPAA/PII, classified data, or anything sensitive.

---

## Prerequisites

- A [Supabase](https://supabase.com) project (free tier works)
- A GitHub account with GitHub Pages enabled

---

## Base path

SyncPad is deployed at `/SyncPad` on GitHub Pages. The runtime base path is configured in `index.html`:

```html
window.SYNCPAD_CONFIG = {
  basePath: '/SyncPad',
  ...
};
```

`src/app.js` reads this value and `service-worker.js` derives its base from the service worker registration scope. The static HTML links, `manifest.json`, and `404.html` still use `/SyncPad` because GitHub Pages is the permanent deployment target.

**To host at the root** (custom domain, Vercel, Netlify, etc.):
1. Change `window.SYNCPAD_CONFIG.basePath` to `''`.
2. Update `manifest.json`: `"start_url": "/"` and `"scope": "/"`.
3. Replace `/SyncPad/` static prefixes in `index.html` with `/`.
4. Update the `404.html` redirect script or use the host's SPA rewrite support.

---

## Step 1 — Supabase project

1. Go to [supabase.com](https://supabase.com) → **New project**
2. Note your **Project URL** and **anon public key** from Settings → API
3. Optional: enable the `pg_cron` extension (Database → Extensions) for automatic expired-room cleanup

---

## Step 2 — Database and storage setup

In the Supabase **SQL Editor**, paste and run the full contents of `supabase-setup.sql` first. It is the base schema — every other migration in this step depends on it.

The script is **idempotent** — safe to rerun on an existing project. It creates:

- `syncpad_rooms` table
- `syncpad_files` table (FK to rooms + cascade delete on metadata rows)
- All required indexes
- Row Level Security (RLS) policies for the `anon` role
- `cleanup_expired_syncpad_rooms()` function
- A server-side trigger that enforces the room editing lock (`editing_locked`) at the database level — the one write-permission control in SyncPad that RLS alone can't express (see `docs/security.md`)
- Optional `pg_cron` schedule (every 10 minutes) — skipped gracefully if pg_cron is not enabled
- Realtime publication entries for both tables
- `syncpad-files` Storage bucket (private)
- Storage RLS policies for upload, read, and delete

The optional Storage cleanup Edge Function lives at `supabase/functions/syncpad-cleanup` and is deployed separately with the Supabase CLI. It is not installed by the SQL script.

> **Important:** The bucket is private. SyncPad always accesses files via signed URLs. Do not make the bucket public.

### Optional feature migrations

`supabase-setup.sql` covers the core app (rooms, files, sharing, admin login). Several shipped features are **opt-in** and live in their own file under `docs/migrations/` — the app works without them, but each feature silently no-ops (or shows a "check Supabase setup" error) until its migration is run. All are idempotent and safe to rerun; run `supabase-setup.sql` first, then any of these you want, in any order:

| Migration | Enables | Symptom if skipped |
|---|---|---|
| [`docs/migrations/short-room-codes.sql`](docs/migrations/short-room-codes.sql) | Short (6-character) spoken/typed room codes — the "Short code" row in the Share modal, and typing a code into the landing page's join box | Share modal shows "Short codes need one more setup step…"; typing a code on the landing page falls through to treating it as a literal room id instead of resolving it |
| [`docs/migrations/room-comments.sql`](docs/migrations/room-comments.sql) | Anchored inline comments on a text range (Comments panel) | Comments panel loads with no comments and no error — the feature is silently unavailable |
| [`docs/migrations/version-history.sql`](docs/migrations/version-history.sql) | Version History panel — browse and restore past snapshots of a room | History panel shows no snapshots |
| [`docs/migrations/device-limit.sql`](docs/migrations/device-limit.sql) | "Burn after N devices join" room setting | The device-limit setting has no effect; `device_limit` stays `null` |
| [`docs/migrations/admin-dashboard-improvements.sql`](docs/migrations/admin-dashboard-improvements.sql) | Admin audit log, room quarantine, and disabled-downloads support in `/admin` | Those admin actions are unavailable; the rest of `/admin` still works |

If a feature you expect to see doesn't work, re-check that its migration was actually run — the Supabase SQL Editor's query history shows past runs.

---

## Step 3 — Configure credentials

Open `index.html` and replace the placeholder credentials:

```html
<script>
  window.SYNCPAD_CONFIG = {
    supabaseUrl:     'https://YOUR-PROJECT-REF.supabase.co',
    supabaseAnonKey: 'YOUR-ANON-PUBLIC-KEY',
  };
</script>
```

The anon key is public-facing by design in Supabase. RLS policies (installed by `supabase-setup.sql`) control what the anon role can actually do.

---

## Step 4 — Deploy to GitHub Pages

1. Push the repository to GitHub (the entire project root, no build needed)
2. **Settings → Pages → Source:** Deploy from a branch → `main` → `/` (root)
3. GitHub deploys to `https://YOUR-USERNAME.github.io/SyncPad/`

The `404.html` file handles SPA routing: unknown paths store the room ID in `sessionStorage`, then redirect to the app root so the correct room loads.

### Alternative hosting

SyncPad deploys to any static host — Vercel, Netlify, Cloudflare Pages, or any CDN. No server-side logic is needed. Just set the publish directory to the repo root and configure the rewrite rule to serve `index.html` for all paths. Then update the configured base path and static asset prefixes as described above.

---

## Step 5 — Verify deployment

After deploying, confirm these work in a browser:

- [ ] Landing screen loads at the root URL
- [ ] Creating a room redirects to `/<roomId>`
- [ ] Joining a room by URL works
- [ ] Hard-refreshing a room URL loads correctly (404.html redirect)
- [ ] Read-only share link (`/SyncPad/share/:token`) opens in read-only mode
- [ ] Uploading a file works
- [ ] Downloading a file works
- [ ] Two browser tabs show each other in the Devices panel
- [ ] Typing in one tab shows the indicator in the other

---

## Scheduled cleanup

### Expired rooms (Postgres-side)

If `pg_cron` is enabled, the SQL setup schedules a job every 10 minutes:

```sql
-- Verify the job exists
SELECT jobid, jobname, schedule, active
FROM   cron.job
WHERE  jobname = 'syncpad-expired-room-cleanup';

-- Run manually at any time
SELECT * FROM public.cleanup_expired_syncpad_rooms();
```

Unencrypted expired rooms are cleared in place. Encrypted expired rooms are deleted (the DB cannot recreate the encrypted empty payload without the user's passphrase).

### Storage orphan cleanup

Deleting a `syncpad_rooms` row cascades the `syncpad_files` metadata rows via `ON DELETE CASCADE`. It does **not** remove the physical objects in the `syncpad-files` Storage bucket unless the deletion path explicitly calls the Storage API.

The admin UI now removes known Storage objects before deleting rooms. For backend cleanup paths, deploy the optional service-role Edge Function:

```bash
# From a machine with the Supabase CLI configured for this project
supabase secrets set SYNCPAD_CLEANUP_SECRET="use-a-long-random-value"
supabase functions deploy syncpad-cleanup --no-verify-jwt

# Dry run first
curl -X POST "https://YOUR-PROJECT-REF.functions.supabase.co/syncpad-cleanup" \
  -H "Authorization: Bearer $SYNCPAD_CLEANUP_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode":"all","dryRun":true}'

# Real cleanup after reviewing counts
curl -X POST "https://YOUR-PROJECT-REF.functions.supabase.co/syncpad-cleanup" \
  -H "Authorization: Bearer $SYNCPAD_CLEANUP_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"mode":"all","dryRun":false}'
```

Supported modes are `expired`, `orphans`, and `all`. The function logs aggregate counts only and never reads file contents. Keep `SUPABASE_SERVICE_ROLE_KEY` server-side only; never add it to `index.html`.

For manual auditing, list known metadata paths:

```sql
SELECT room_id, file_path, filename, file_size
FROM   syncpad_files
ORDER  BY room_id, uploaded_at;
```

Then compare those paths with Supabase Dashboard -> Storage -> `syncpad-files`. Delete only confirmed orphaned objects.

> Always verify before deleting. There is no undo for deleted storage objects.

---


## Web3Forms operations (Contact page)

SyncPad's contact form uses Web3Forms from frontend JavaScript. The Web3Forms access key is a **public frontend key**, not a server secret.

Recommended Web3Forms dashboard settings:

- **Allowed domain:** `spairkie.github.io`
- **Subject:** `New SyncPad Contact Form Submission`
- **from_name:** `SyncPad Contact Form`
- **hCaptcha:** keep **off** unless the frontend adds an hCaptcha widget and verification flow

Operational note: keep the botcheck honeypot enabled and verify report-table DB constraints (reason allowlist + details length) and RLS posture before each public release.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Blank page on load | Wrong base path | Check `window.SYNCPAD_CONFIG.basePath`, static asset prefixes, and service worker scope |
| "Could not load room" | Wrong Supabase credentials | Check `supabaseUrl` and `supabaseAnonKey` in `index.html` |
| Files not uploading | Storage bucket missing or wrong RLS | Re-run `supabase-setup.sql`; verify bucket policies |
| Realtime not syncing | Supabase Realtime not enabled | Dashboard → Database → Replication → enable both tables |
| Expired rooms not cleared | `pg_cron` not enabled | Enable `pg_cron` extension; re-run `supabase-setup.sql` |
| App serving old cached content | Stale service worker | Bump `CACHE_VERSION` in `service-worker.js`; redeploy |
| Room URL 404 on hard refresh | `404.html` not present | Ensure `404.html` is in the repo root and deployed |
| Mobile "Add to Home Screen" fails | Wrong manifest paths | Verify `/SyncPad/` prefix in `manifest.json` icons |
| Room creation fails after visiting `/admin` | Missing authenticated RLS policies | Re-run `supabase-setup.sql` — the authenticated baseline policies section fixes this |

---

## Service worker cache versioning

The service worker uses a named cache. To force clients to download fresh assets after cached files change:

1. Bump `CACHE_NAME` in `service-worker.js`
2. Deploy
3. On next load, old caches are purged and fresh assets are fetched

Current value at the time of this update: `syncpad-v10`.

---

## Security reminder

| Control | Enforcement |
|---|---|
| Read-only links | Frontend JS only — see `docs/security.md` for why this one specifically can't be closed without a bigger redesign |
| Room lock | **Backend-enforced** — a database trigger (`syncpad_rooms_enforce_lock`, installed by `supabase-setup.sql`) rejects content changes to a locked room regardless of what calls the API |
| `/admin` route | Supabase Auth (`signInWithPassword`) + `is_syncpad_admin()` RLS — not a public-facing feature |
| Passcode | Client-side hash check |
| Text encryption | In-browser (AES-256-GCM) |
| File access | Signed URLs (1 h TTL) — no end-to-end encryption |

A determined user with the anon key can bypass every frontend-only control listed above (all except Room lock, `/admin`, and encryption, which don't rely on the frontend for their protection). Do not use SyncPad for sensitive data.

### Admin session and RLS roles

The Supabase JS client uses a single shared instance. After a user signs in at `/admin`, the client's session role changes from `anon` to `authenticated`. This means the anon RLS policies for `syncpad_rooms`, `syncpad_files`, and `storage.objects` no longer apply — they only match the `anon` role.

To prevent normal app features from breaking after admin login, `supabase-setup.sql` adds mirrored **authenticated baseline** policies that grant the same permissions as the anon policies. These are not privileged — they only allow what anon already could do. Admin-only destructive actions (delete rooms, etc.) are still gated by `is_syncpad_admin()` in separate admin policies.

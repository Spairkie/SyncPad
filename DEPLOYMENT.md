# SyncPad — Deployment Guide

> ⚠️ **Personal / demo project.**  
> Read-only links, room locks, and view-once are frontend/convenience controls, not backend-enforced security boundaries.  
> View-once is a convenience feature, not a secure destruction guarantee. A viewer may copy, screenshot, save, or otherwise preserve content before it clears.  
> Do **not** deploy SyncPad for use with passwords, HIPAA/PII, classified data, or anything sensitive.

---

## Prerequisites

- A [Supabase](https://supabase.com) project (free tier works)
- A GitHub account with GitHub Pages enabled

---

## Base path

SyncPad is deployed at `/SyncPad` on GitHub Pages. The base path appears in **two files**:

| File | Line |
|---|---|
| `src/app.js` | `const BASE = '/SyncPad';` |
| `service-worker.js` | `const BASE = '/SyncPad';` |

**To host at the root** (custom domain, Vercel, Netlify, etc.):
1. Change both constants to `const BASE = '';`
2. Update `manifest.json`: `"start_url": "/"` and `"scope": "/"`
3. Replace all `/SyncPad/` prefixes in `index.html` with `/`
4. Update the `404.html` redirect script if present

No other JS files need changes — all path logic flows through the `BASE` constant via helper functions.

---

## Step 1 — Supabase project

1. Go to [supabase.com](https://supabase.com) → **New project**
2. Note your **Project URL** and **anon public key** from Settings → API
3. Optional: enable the `pg_cron` extension (Database → Extensions) for automatic expired-room cleanup

---

## Step 2 — Database and storage setup

In the Supabase **SQL Editor**, paste and run the full contents of `supabase-setup.sql`.

The script is **idempotent** — safe to rerun on an existing project. It creates:

- `syncpad_rooms` table
- `syncpad_files` table (FK to rooms + cascade delete on metadata rows)
- All required indexes
- Row Level Security (RLS) policies for the `anon` role
- `cleanup_expired_syncpad_rooms()` function
- Optional `pg_cron` schedule (every 10 minutes) — skipped gracefully if pg_cron is not enabled
- Realtime publication entries for both tables
- `syncpad-files` Storage bucket (private)
- Storage RLS policies for upload, read, and delete

> **Important:** The bucket is private. SyncPad always accesses files via signed URLs. Do not make the bucket public.

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

SyncPad deploys to any static host — Vercel, Netlify, Cloudflare Pages, or any CDN. No server-side logic is needed. Just set the publish directory to the repo root and configure the rewrite rule to serve `index.html` for all paths. Then update the `BASE` constant as described above.

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

Deleting a `syncpad_rooms` row cascades the `syncpad_files` metadata rows via `ON DELETE CASCADE`. It does **not** remove the physical objects in the `syncpad-files` Storage bucket.

**To identify orphaned storage objects:**

```sql
-- List all file paths tracked in metadata
SELECT room_id, file_path, filename, file_size
FROM   syncpad_files
ORDER  BY room_id, uploaded_at;
```

Then in the Supabase Dashboard → Storage → `syncpad-files`:
- Browse objects by folder (each folder = a room ID)
- Compare against the query results above
- Objects with no matching `file_path` row are orphans

Delete orphaned objects via the Dashboard UI or the Storage REST API.

> ⚠️ **Always verify before deleting.** There is no undo for deleted storage objects.

Deleting expired room/file metadata does not automatically remove physical objects from Supabase Storage. Before enabling public file uploads at scale, configure a storage cleanup process (scheduled Edge Function or manual bucket pruning job).

Future storage cleanup design (recommended):
- Run a scheduled Supabase Edge Function daily.
- Enumerate objects in `syncpad-files`, then match against `syncpad_files` rows and active/non-expired rooms.
- Delete only confirmed orphaned objects.
- Log only aggregate counts (no file contents).
- Start with a dry-run mode for first execution.

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
| Blank page on load | Wrong `BASE` path | Check `const BASE` in `src/app.js` and `service-worker.js` |
| "Could not load room" | Wrong Supabase credentials | Check `supabaseUrl` and `supabaseAnonKey` in `index.html` |
| Files not uploading | Storage bucket missing or wrong RLS | Re-run `supabase-setup.sql`; verify bucket policies |
| Realtime not syncing | Supabase Realtime not enabled | Dashboard → Database → Replication → enable both tables |
| Expired rooms not cleared | `pg_cron` not enabled | Enable `pg_cron` extension; re-run `supabase-setup.sql` |
| App serving old cached content | Stale service worker | Bump `CACHE_VERSION` in `service-worker.js`; redeploy |
| Room URL 404 on hard refresh | `404.html` not present | Ensure `404.html` is in the repo root and deployed |
| Mobile "Add to Home Screen" fails | Wrong manifest paths | Verify `/SyncPad/` prefix in `manifest.json` icons |

---

## Service worker cache versioning

The service worker uses a named cache. To force clients to download fresh assets after cached files change:

1. Bump `CACHE_NAME` in `service-worker.js`
2. Deploy
3. On next load, old caches are purged and fresh assets are fetched

Current value at the time of this update: `syncpad-v8`.

---

## Security reminder

| Control | Enforcement |
|---|---|
| Read-only links | Frontend JS only |
| Room lock | Frontend JS only |
| `/admin` route | Placeholder page only (dashboard shelved) |
| Passcode | Client-side hash check |
| Text encryption | In-browser (AES-256-GCM) |
| File access | Signed URLs (1 h TTL) — no end-to-end encryption |

A determined user with the anon key can bypass all frontend controls. Do not use SyncPad for sensitive data.

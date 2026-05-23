# SyncPad Deployment Guide

This guide walks you through deploying SyncPad with **Supabase** for the backend and **GitHub Pages** for hosting.

Target URL used by this project:

```text
https://spairkie.github.io/SyncPad/
```

---

## What you need first

- A GitHub account
- A Supabase account
- The SyncPad project folder
- A browser
- Optional: GitHub Desktop or Git command line

SyncPad is a static app. There is no build step, no `npm install`, and no server to run.

---

## Step 1 — Create the Supabase project

1. Go to Supabase and create a new project.
2. Save your project password somewhere safe.
3. Wait for the project to finish provisioning.
4. Open the project dashboard.

You will use this project for:

- `syncpad_rooms` table
- `syncpad_files` table
- Realtime sync
- Storage bucket for file attachments
- Optional scheduled cleanup for expired rooms

---

## Step 2 — Enable Realtime requirements

The setup SQL adds the required tables to Supabase Realtime.

You do not need to manually create channels. SyncPad creates Broadcast and Presence channels from the browser.

---

## Step 3 — Enable pg_cron for backend expiration cleanup

This step is recommended.

SyncPad can clear expired rooms from the browser when someone opens the room after expiration. The updated version also includes a backend cleanup function so expired rooms can be cleaned even when nobody is online.

1. In Supabase, go to **Database**.
2. Open **Extensions**.
3. Search for `pg_cron`.
4. Enable `pg_cron`.

If you skip this step, the app still works. The SQL setup will create the cleanup function, but it will not schedule the automatic cleanup job.

---

## Step 4 — Run the Supabase setup SQL

1. Open **SQL Editor** in Supabase.
2. Open the local file:

```text
supabase-setup.sql
```

3. Copy the entire file.
4. Paste it into the Supabase SQL Editor.
5. Click **Run**.

The script is safe to rerun. It creates or updates:

- `syncpad_rooms`
- `syncpad_files`
- indexes
- RLS policies
- Realtime publication entries
- `syncpad-files` private Storage bucket
- Storage policies
- `public.cleanup_expired_syncpad_rooms()`
- optional `syncpad-expired-room-cleanup` pg_cron job

---

## Step 5 — Confirm the Storage bucket

In Supabase:

1. Go to **Storage**.
2. Open **Buckets**.
3. Confirm there is a bucket named:

```text
syncpad-files
```

4. Confirm it is **private**, not public.

If the bucket was not created, create it manually with this exact name:

```text
syncpad-files
```

---

## Step 6 — Confirm the cleanup job

If you enabled `pg_cron`, run this in Supabase SQL Editor:

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname = 'syncpad-expired-room-cleanup';
```

You should see one active job with this schedule:

```text
*/10 * * * *
```

That means the cleanup runs every 10 minutes.

You can also manually test the function with:

```sql
select * from public.cleanup_expired_syncpad_rooms();
```

Expected result columns:

```text
cleared_unencrypted | deleted_encrypted
```

Important behavior:

- Expired unencrypted rooms are cleared in place.
- Expired encrypted rooms are deleted because the database does not know the passphrase needed to write an encrypted empty note.

---

## Step 7 — Get your Supabase URL and anon key

In Supabase:

1. Go to **Project Settings**.
2. Open **API**.
3. Copy the **Project URL**.
4. Copy the **anon public** key.

They will look similar to this:

```text
https://your-project-ref.supabase.co
```

and a long JWT-style anon key.

The anon key is public in this app. That is normal for Supabase browser apps.

---

## Step 8 — Add your Supabase credentials to SyncPad

Open:

```text
index.html
```

Find this block near the bottom of the `<head>` section:

```html
<script>
  window.SYNCPAD_CONFIG = {
    supabaseUrl:     'https://YOUR_PROJECT.supabase.co',
    supabaseAnonKey: 'YOUR_ANON_KEY_HERE',
  };
</script>
```

Replace it with your real Supabase values:

```html
<script>
  window.SYNCPAD_CONFIG = {
    supabaseUrl:     'https://your-project-ref.supabase.co',
    supabaseAnonKey: 'your-real-anon-public-key',
  };
</script>
```

Save the file.

Do not use the Supabase `service_role` key in this app. Only use the `anon public` key.

---

## Step 9 — Create or update the GitHub repository

For this deployment target, the repository should be named:

```text
SyncPad
```

The project folder should contain files like this at the repository root:

```text
404.html
README.md
DEPLOYMENT.md
index.html
manifest.json
service-worker.js
supabase-setup.sql
assets/
src/
styles/
```

Do not put the app inside an extra nested folder unless you also update the deployment paths.

---

## Step 10 — Push the project to GitHub

Using Git command line from inside the project folder:

```bash
git init
git branch -M main
git remote add origin https://github.com/spairkie/SyncPad.git
git add .
git commit -m "Deploy SyncPad"
git push -u origin main
```

If the repo already exists and already has history, use:

```bash
git add .
git commit -m "Update SyncPad deployment"
git push
```

---

## Step 11 — Enable GitHub Pages

In GitHub:

1. Open the `SyncPad` repository.
2. Go to **Settings**.
3. Open **Pages**.
4. Under **Build and deployment**, choose:
   - Source: **Deploy from a branch**
   - Branch: **main**
   - Folder: **/** root
5. Save.

After GitHub Pages finishes publishing, the app should be available at:

```text
https://spairkie.github.io/SyncPad/
```

---

## Step 12 — Test basic room creation

Open:

```text
https://spairkie.github.io/SyncPad/
```

The app should automatically create a room URL like:

```text
https://spairkie.github.io/SyncPad/calm-lake-xxxxxxxxxx
```

The random room suffix now uses `crypto.getRandomValues()` for stronger entropy.

Type a test note and refresh the page. The note should still be there.

---

## Step 13 — Test live sync

1. Open the same room URL in two browser tabs.
2. Type in one tab.
3. Confirm the second tab updates live.
4. Check the device counter in the header.

If live sync does not work:

- Confirm your Supabase URL and anon key are correct.
- Confirm `syncpad_rooms` was added to Realtime by the setup SQL.
- Confirm your browser console does not show Supabase connection errors.

---

## Step 14 — Test passcode mode

1. Open a room.
2. Go to **Settings**.
3. Set a passcode.
4. Copy the room URL.
5. Open it in a private/incognito window.
6. Confirm the app asks for the passcode.

Important: passcode mode is a normal app entry gate. It is not backend security. For real note confidentiality, use text encryption.

---

## Step 15 — Test text encryption

1. Open a room.
2. Add a test note.
3. Go to **Settings**.
4. Enable encryption.
5. Enter a strong passphrase.
6. Refresh the page.
7. Confirm the app asks for the encryption passphrase.
8. Enter the passphrase and confirm the note decrypts.

Important:

- The encryption passphrase is not stored anywhere.
- If you lose the passphrase, the encrypted note cannot be recovered.
- Text is encrypted, but files are not encrypted in v1.

---

## Step 16 — Test read-only links

1. Open the share modal.
2. Copy the read-only link.
3. Open it in another browser tab.
4. Confirm you can view and copy the note.
5. Confirm you cannot type, clear, import, upload, delete, or change settings.

Important: read-only mode is enforced by the frontend. The current v1 Supabase RLS policies do not enforce true backend read-only access.

---

## Step 17 — Test expiration

1. Open a room.
2. Go to **Settings**.
3. Set expiration to a short value, such as:

```text
30s
```

4. Wait for it to expire.
5. Confirm the note clears.

To test backend cleanup manually, run:

```sql
select * from public.cleanup_expired_syncpad_rooms();
```

---

## Step 18 — Test view-once

1. Create a room and type a note.
2. Enable **View-once** in Settings.
3. Copy the editable link.
4. Open the link in another normal browser session.
5. Confirm the note displays, then the server copy clears.

Important:

- The creator does not consume their own view-once note.
- Read-only links do not consume view-once notes.
- View-once is not a guaranteed security boundary because direct backend access could bypass the normal app workflow.

---

## Step 19 — Test file attachments

1. Open a room without text encryption enabled.
2. Upload a small test file.
3. Download it from another tab.
4. Delete it.

Files are not encrypted in v1. New uploads are blocked while text encryption is enabled.

---

## Step 20 — Final production checklist

Before sharing widely, confirm:

- Supabase credentials are replaced in `index.html`.
- `supabase-setup.sql` ran successfully.
- `syncpad-files` bucket exists and is private.
- Realtime works across two tabs.
- Expiration cleanup function exists.
- pg_cron job exists if you want automatic backend cleanup.
- Read-only behavior works as expected.
- Encryption works after refresh.
- GitHub Pages URL works after refresh on a room path.
- Browser console has no major errors.

---

## Important security notes

SyncPad v1 is good for personal use, demos, and casual sharing, but it is not a full permissioned document platform.

Current limitations:

- Passcode mode is a frontend entry gate, not backend access control.
- Read-only mode is frontend-only.
- Editing lock is frontend-only.
- View-once is a normal app workflow, not a guaranteed burn-after-reading control.
- Files are not encrypted.
- The anon Supabase key is public by design.
- The current RLS policies are permissive so anonymous browser clients can create, read, and update rooms.

For sensitive notes, enable text encryption and use a strong passphrase.

# Admin Setup

SyncPad's `/admin` screen uses Supabase Auth for sign-in and the `public.syncpad_admins` table for authorization. A user can sign in only if they exist in Supabase Auth, and they can access admin data only if their Auth user ID is present in `syncpad_admins`.

## 1. Apply Database Setup

Run `supabase-setup.sql` in the Supabase SQL Editor first. It creates:

- `public.syncpad_admins`
- `public.is_syncpad_admin()`
- admin-only RLS policies for rooms, files, reports, and share links
- authenticated baseline policies so normal app behavior still works after an admin signs in

## 2. Create an Auth User

In Supabase Dashboard:

1. Open Authentication -> Users.
2. Create a user with email/password.
3. Confirm the email if your project requires confirmation.
4. Copy the user's UUID from the user details page.

## 3. Grant SyncPad Admin Access

Run this in SQL Editor, replacing the values:

```sql
insert into public.syncpad_admins (user_id, email)
values (
  '00000000-0000-0000-0000-000000000000',
  'admin@example.com'
)
on conflict (user_id) do update
set email = excluded.email;
```

## 4. Verify Access

1. Open `/SyncPad/admin`.
2. Sign in with the Auth user's email/password.
3. Confirm the Rooms, Reports, and Cleanup tabs load.

If sign-in succeeds but dashboard data does not load, verify that the Auth user's UUID exactly matches the `syncpad_admins.user_id` row.

## 5. Revoke Access

```sql
delete from public.syncpad_admins
where email = 'admin@example.com';
```

Deleting the Auth user also removes the admin row because `syncpad_admins.user_id` references `auth.users(id)` with `on delete cascade`.

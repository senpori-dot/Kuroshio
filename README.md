# R9 黒潮医療人養成プロジェクト 希望調整

A single-page Japanese web app for coordinating student placement preferences
("希望調整") for the R9 黒潮医療人養成プロジェクト program. Students pick a
training slot (in-prefecture / 県内 or out-of-prefecture / 県外); staff
monitor and administer capacity, deadlines and the student roster.

## Tech

- Plain static HTML/CSS/JavaScript (no build step, no framework) served
  from `public/`.
- [Supabase](https://supabase.com) as the backend: Postgres tables
  (`app_settings`, `slots`, `students`, `change_log`, `admins`) and two RPC
  functions (`student_snapshot`, `student_set_choice`), all of which already
  exist in the target project. This app only reads/writes them via the
  Supabase JS client (`@supabase/supabase-js`, loaded from a CDN) — it does
  **not** create or modify any of that schema. The one exception is the
  matching feature, whose additive tables/functions live in
  `supabase/matching.sql` and are applied by hand (see `supabase/README.md`).
- Supabase Auth (email/password) for the admin login.

Only Supabase's public **publishable/anon** key is embedded in the client
code. No service-role key is used or exposed anywhere in this app.

## Modes

- **Student mode** (default): open with `?token=<student token>`. Polls
  `student_snapshot(p_token)` every 5 seconds and lets the student change
  their slot via `student_set_choice(p_token, p_slot_id)` when the backend
  reports `can_edit = true`.
- **Admin mode**: open with `?admin=1`. Requires a Supabase Auth
  email/password login. Lets staff edit settings, manage students, and view
  the slot master table, over-capacity slots, unselected students and the
  change log.

## Running locally

This is a static site, so any static file server works:

```bash
netlify dev --port 8889
```

or simply open `public/index.html` in a browser (some browser security
policies around `fetch`/CORS work better when served over `http://`, so
`netlify dev` or another local server is recommended over opening the file
directly).

No environment variables are required — the Supabase URL and publishable
key are public values embedded directly in `public/js/app.js`.

## Project structure

```
public/
  index.html       Single HTML shell (student + admin views share this page)
  css/style.css    Mobile-first styling (iPad Safari friendly)
  js/app.js        All application logic: routing, Supabase calls, rendering
netlify.toml       Publishes public/ as a static site, no build step
```

```
supabase/
  matching.sql     First/second matching: tables, RPCs and the guard trigger.
                   Applied by hand in the Supabase SQL Editor — nothing in
                   this repo executes DDL.
```

## Where to look next

- `AGENTS.md` — schema assumptions, real column names and extension notes.
- `HANDOFF.md` — handoff notes, admin runbook, invariants and open issues.
- `supabase/README.md` — how to apply `supabase/matching.sql`.

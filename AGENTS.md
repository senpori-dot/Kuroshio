# AGENTS.md

## What this project is

A frontend-only, single-page app for "R9 黒潮医療人養成プロジェクト 希望調整"
(student training-slot preference coordination). It has no server code of
its own — all persistence and business logic lives in an existing Supabase
project (tables + RPC functions), which this app was explicitly instructed
not to create or modify.

## Architecture

- `public/index.html` — one HTML shell. `public/js/app.js` decides at load
  time, from the URL, whether to render student mode or admin mode into
  `#main`. There is no router/framework; each mode's `boot*()` function
  owns a small local `state` object and calls a `render()` closure whenever
  state changes (no virtual DOM — `innerHTML` re-renders per section).
- `public/css/style.css` — one stylesheet, mobile-first, tuned for iPad
  Safari (safe-area padding, large tap targets, responsive `slot-grid`).
- No bundler/build step. `netlify.toml` just publishes `public/` as-is.

## Supabase integration

- Client created directly in `app.js` with the **publishable/anon key**
  only (`SUPABASE_URL` / `SUPABASE_ANON_KEY` constants near the top of the
  file). Never add a service-role key to this codebase — it must stay
  frontend-safe.
- Student mode: `sb.rpc('student_snapshot', { p_token })` polled every 5s,
  and `sb.rpc('student_set_choice', { p_token, p_slot_id })` to change a
  choice. The RPC is the sole source of truth for whether editing is
  currently allowed (`can_edit`); the client never computes that itself.
- Admin mode: authenticates via `sb.auth.signInWithPassword`, then reads/
  writes the `app_settings`, `slots`, `students`, and `change_log` tables
  directly with the Supabase client. Whether a logged-in user is actually
  allowed to touch these tables is enforced by Supabase Row Level Security
  policies tied to the `admins` table / `auth.uid()` — this app does not
  duplicate that check client-side, it just surfaces the resulting error if
  a query is denied.

## Schema (confirmed against the live project)

The real column names were confirmed by probing PostgREST `?select=<col>`
per candidate column (RLS hides rows, not the schema, so a valid column
returns `[]` and an invalid one returns
`column X does not exist`). The earlier alias guesses were wrong and are
no longer used for these tables:

- `slots`: `id`, `code`, `facility`, `label`, `capacity`, `note`,
  `duration_weeks`, `start_course`, `end_course`, `sort_order`, `active`,
  `created_at`. There is **no** `hospital`/`course`/`weeks`/`area` column.
  The クール表 grid is built from `facility` (row), `start_course`..
  `end_course` (column span) and `duration_weeks` (3 = yellow, 6 = blue).
- `students`: `id`, `student_code`, `name`, `access_token`,
  `current_slot_id`, `updated_at`. There is **no** `token`, `student_name`
  or `created_at` column. `student_code` is **NOT NULL with no default**,
  so every insert must supply one — the admin form only asks for a name,
  so `insertStudents()` derives the existing format from the rows already
  loaded for the logged-in admin (most common "prefix + zero-padded
  number" wins, sequence continues from the highest number) and retries on
  `23505`. Anonymous inserts are still rejected with `42501`, i.e. RLS is
  unchanged.
- `change_log`: `id`, `student_id`, `old_slot_id`, `new_slot_id`,
  `changed_at`. There is **no** `created_at`, `student_name` or
  `description` column — the admin history view joins `student_id` and the
  slot ids against the already-loaded `students` / `slots` rows.
- `app_settings`: `id`, `title`, `starts_on`, `deadline_on`, `daily_open`,
  `daily_close`, `after_hours_mode`. `id` is **boolean** (singleton-row
  pattern), so integer filters like `.neq("id", -1)` fail with `22P02`;
  `daily_open` / `daily_close` are Postgres `time`, which serializes with
  seconds — `toTimeInputValue()` / `fromTimeInputValue()` convert between
  that and the bare `HH:MM` an `input[type=time]` needs.
  `after_hours_mode` is text guarded by `app_settings_after_hours_mode_check`,
  whose allowed literals cannot be read from any client available here (RLS
  hides the row from the anon key, PostgREST does not expose constraint
  definitions, and there is deliberately no service-role key). The settings
  form therefore **omits the column from the UPDATE** unless the admin actually
  switches the dropdown, so an ordinary save never re-evaluates the constraint;
  only a real mode switch tries the `AFTER_HOURS_CANDIDATES` synonyms and, if
  all are rejected with `23514` / `22P02`, retries once without the column so
  the remaining settings still save. If the real literals become known, replace
  those lists with the two exact values.
- `admins` is not queried directly by the app's own queries; access control is
  enforced by RLS. It has a single relevant column, `user_id`, matched against
  `auth.uid()` (that is what the matching functions below check).
- `match_rounds` / `match_results` are the **only objects this repo adds**, and
  they live in `supabase/matching.sql`, which has to be pasted into the
  Supabase SQL Editor by hand — there is no service-role key here and no
  migration runner, so nothing in this repo ever executes DDL. The file is
  re-runnable and modifies no existing table, policy, constraint or function.
  Until it is applied, PostgREST answers `PGRST205` / `PGRST202`; the client
  treats those as "not finalized" (`isMissingMatchObject()`) and behaves
  exactly as it did before, and the admin マッチング tab says which file to run.

Because `slots` has no prefecture column, the 県内 / 県外 split, the
facility display order and the per-facility notes come from the official
クール表 and live in the `FACILITY_GROUPS` constant in `app.js`. Facilities
are matched by substring, so a DB naming variant still lands in the right
group; anything unmatched renders in a trailing 「その他」 group rather than
disappearing.

The `student_snapshot` RPC's exact return shape is still unverified (it
needs a valid student token). `normalizeSlot()` reads the same real column
names from it; slots it cannot place are listed under
「クール表に配置できなかった枠」 instead of being dropped silently. Because the
shape is unverified, the student banner reads the settings from the snapshot
row **and** from a nested `settings` / `app_settings` object, so a flat or a
nested payload both work; `app_settings` itself is not readable with the anon
key (RLS), so the snapshot — re-fetched every 5s — is the only source and
nothing is cached client-side.

Occupant names in the timetable cells come from `normalizeSlot()`. Because the
snapshot shape is unverified, names are accepted per slot (`student_names` /
`names` / `occupants` / `students` / `occupant_names` / `selected_names`, as an
array, an array of `{name}`, or a `、`/`,`-joined string) **and** from a roster
of students carrying `current_slot_id` (`students` / `all_students` /
`student_choices` / `choices` / `selections`); the two are merged as a multiset
by `mergeNameLists()`, so an overlap is not duplicated and two students sharing
a name are not collapsed. The viewer's own choice is added from
`student.current_slot_id` so it shows even if the RPC returns no roster. Only
name fields are ever read — no token, `student_code` or other identifier
reaches the DOM. `count` is `max(current_count, names.length)`, so an
over-capacity cell keeps showing every name and its `st-over` styling during
the coordination period. Admin mode feeds the same function the names it
derives from the already-loaded `students` rows, so both views list the same
people. If `student_snapshot` returns neither per-slot names nor a roster, no
client change can show other students' names — the RPC would have to include
them.

Student editability is judged by `selectionWindow()` in **Asia/Tokyo**
(`tokyoNow()`), from the current `starts_on` / `deadline_on` / `daily_open` /
`daily_close` / `after_hours_mode`: inside the reception period (inclusive) and
inside the daily window (or `after_hours_mode` allowing), the cells are
tappable. It is OR-ed with the RPC's `can_edit`, never AND-ed, so the client
can enable within the configured window but never revokes what the server
grants; when the snapshot carries no settings at all the RPC's `can_edit` is
used alone. `starts_on` / `deadline_on` are `date` columns, so they are
formatted by `fmtDateOnly()` straight from the string — passing them through
`new Date()` printed UTC midnight as "09:00" in Asia/Tokyo, which is why the
old banner mixed a phantom time into the deadline.

## First matching (1次) and second matching (2次)

The lottery is entirely server-side; the client can only read a result it
cannot influence.

- `run_first_matching(p_dry_run, p_force, p_is_test)` holds the lottery itself
  and has **no grants at all** (`revoke all … from public`, nothing granted), so
  it is reachable only from the two `SECURITY DEFINER` functions below.
  `finalize_first_matching(p_dry_run, p_force, p_is_test)` is the admin-only
  (`admins` / `auth.uid()`) wrapper the dashboard calls; `student_matching()`
  calls `run_first_matching(false, false, false)` when no round row exists yet,
  so the **first student page view after the deadline finalizes automatically**
  — there is no scheduler, and if nobody opens the page the round stays
  unfinalized until an admin presses the button. The deadline is re-read from
  `app_settings` on every attempt (`deadline_on` + `daily_close` evaluated in
  `app_settings.timezone`, falling back to `Asia/Tokyo` when it is null, blank
  or not in `pg_timezone_names`), so editing the settings before finalization
  takes effect. `run_first_matching` takes
  `pg_advisory_xact_lock(hashtext('r9_match_round_1'))`, and if a
  `match_rounds` row for the round already exists it re-reads and returns the
  stored result with `status = 'already_finalized'` — it never calls `random()`
  again. `match_rounds.round` being the primary key is what makes a second
  finalization impossible even under a race. Otherwise it gates on
  `deadline_on + coalesce(daily_close, '23:59:59')` compared against
  `now() at time zone 'Asia/Tokyo'` (`status = 'not_due'` / `'no_deadline'`),
  runs **one** `random()` pass
  (`row_number() over (partition by current_slot_id order by random(), id)`,
  rank ≤ `capacity` → `confirmed`, else `second_matching`) into a jsonb value,
  and inserts the rows *from that same jsonb*, so what it returns and what it
  stores can never diverge. `p_dry_run` computes and returns without inserting;
  `p_force` skips only the deadline gate; `p_is_test` marks the round so
  `reset_test_matching('RESET-TEST')` can delete it (real rounds are never
  deletable).
- `student_matching(p_token)` — token-authenticated, returns the caller's own
  `my_outcome` / `my_slot_*` / `my_lottery_rank` plus, per slot, only
  `capacity` / `confirmed_count` / `remaining` / `confirmed_names`. No
  `access_token`, `student_code`, email or other students' ids are in the
  payload.
- Neither table has an INSERT/UPDATE/DELETE policy at all, so the
  `SECURITY DEFINER` functions are the only writers; the anon/publishable key
  can reach nothing but `student_matching`.
- `students_guard_after_first_matching` (BEFORE UPDATE OF `current_slot_id`)
  enforces the same rules server-side once a round exists: a confirmed student
  cannot change, and a second-matching student can only move into a slot that
  still has room. Occupancy counts each student once if they are round-1
  `confirmed` for the slot, hold it as their `second_slot_id`, **or** currently
  point at it, so students who already moved in during second matching consume
  seats too. When the check passes, the guard upserts
  `match_results.second_slot_id` / `second_assigned_at` for that student
  (creating the row if they never applied in round 1), which is what "no longer
  waiting for second matching" means: the round-1 `slot_id` / `outcome` /
  `lottery_rank` are left untouched as the lottery record, `student_matching`
  reports `my_outcome = 'confirmed'` and `my_slot_id = second_slot_id` once it
  is set, and the same student is then locked out of further changes. The check is
  serialized per slot by `pg_advisory_xact_lock(hashtext('r9_slot_' || id))`
  taken before the count, so under the default READ COMMITTED the count sees
  the previously committed move and two students racing for the last seat
  cannot both succeed. Admins are exempt (and take no lock). Note that a
  `p_is_test` round activates this guard too, which is the point of being able
  to reset it.

Client side: `fetchMatching()` calls `student_matching` in parallel with each
`student_snapshot` poll and keeps the row only when `finalized` is true, so
`state.matching` is null both before the deadline and when the SQL is not
applied. When it is set, `matchingSlotIndex()` / `decorateMatching()` attach
`confirmedNames` / `confirmedCount` / `remaining` / `finalized` to each slot;
`cellHTML()` then renders the finalized state — a green hatched cell
(`td.cell.finalized`, declared after `.yellow` / `.blue` so it wins the cascade
without touching the fixed column widths), a 「確定」 marker, `confirmedCount /
capacity` instead of the applicant count, and `.cell-name.confirmed` chips for
the confirmed names (consumed as a multiset, so a second student with the same
name is not mislabelled). Editability after finalization ignores the reception
window entirely: a confirmed student can never edit, and a second-matching
student may tap only slots with `remaining > 0` (`opts.canSelectSlot`). The
`result-banner` above the timetable carries the two exact required messages and
the finalized slot. The admin マッチング tab derives the same view from
`match_rounds` / `match_results` joined against the already-loaded `students` /
`slots` rows (confirmed list, second-matching list, remaining capacity per slot,
lottery ranks) and holds the dry-run / finalize / test-finalize / reset buttons;
the real finalize is behind a confirmation modal because it cannot be undone.

The per-facility lodging/commute conditions are rendered **only** in the
left-hand hospital column, never repeated inside the yellow/blue cells:
cells carry capacity, student names and (for 6週 slots) a bare 「6週間」
marker, so all six courses fit an iPad-landscape screen without
horizontal scrolling. `table.timetable` is therefore `table-layout: fixed`
with percentage columns (16% hospital + 6 × 14%) rather than a
`max-content` width; below 720px it falls back to fixed pixel columns and
scrolls. Any per-slot `note` is shown in the tap-confirmation modal.

## Conventions

- No comments explaining *what* code does; only genuinely non-obvious
  constraints (e.g. the `student_code` / `access_token` generation notes).
- All user-facing strings are Japanese.
- Status coloring is centralized in `capacityStatus()` /
  `statusLabel()` / the `.available` / `.full` / `.over` CSS classes —
  reuse these rather than re-deriving color logic elsewhere.

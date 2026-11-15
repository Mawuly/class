# UCC Classroom Booking - Supabase implementation guide

This guide is written for another engineer or AI agent who has to take this repository
live on Supabase. It describes the existing database, the additive change this project
made, how to connect the Express API to Supabase, the API surface, the booking conflict
rules, and how to verify the result.

**Do not replace or reset an existing Supabase project.** The application already owns a
working database (users, rooms, bookings, audit history). Everything described here is
additive and idempotent. There is no `DROP TABLE`, no `TRUNCATE`, and no project re-creation
anywhere in the setup path.

---

## 1. Architecture in one paragraph

The browser never talks to Supabase. Static pages in `public/` call the Express API in
`src/`. The Express API connects to Supabase Postgres with a single server-side connection
string (`DATABASE_URL`), owns every query, and enforces rules in three layers: request
validation in `src/services/*`, transactional checks with friendly error messages, and
`EXCLUDE USING gist` constraints plus triggers in `src/db/schema.sql` as the last line of
defence. Row Level Security is enabled on every table with no policies, so Supabase's public
`anon` key cannot read or write anything even if it leaks.

```
browser  ->  Express (src/)  ->  node-postgres  ->  Supabase Postgres (pooler, port 6543)
   |              |
   |              +-- schema.sql (idempotent migrations, RLS, constraints, triggers)
   |              +-- seed.js    (59 UCC rooms, optional demo data)
   +-- public/index.html        public site (rooms, booking requests, sign-in; calls the API)
   +-- public/preview.html      standalone localStorage interface preview (no database)
   +-- public/account.html      sign in / sign up / password reset (calls /api/auth)
   +-- public/booking.html      older database-connected UI, kept as a secondary client
   +-- public/admin.html        timetable office UI
```

## 2. What this project changed in the existing database

The original schema is still there, versioned 1 to 8 in `src/db/setup.js`. This project adds
**schema versions 9, 10, 11 and 12**:

| Change | Where |
|---|---|
| `room_blocks` table (dated temporary closures) | `src/db/schema.sql` |
| Exclusion constraint `room_blocks_no_overlap` | `src/db/schema.sql` |
| Advisory-lock trigger `lock_room_for_schedule` on `bookings` and `room_blocks` | `src/db/schema.sql` |
| Trigger `bookings_reject_room_blocks` (a booking cannot land on a closure) | `src/db/schema.sql` |
| Trigger `room_blocks_reject_bookings` (a closure cannot land on a booking) | `src/db/schema.sql` |
| `ALTER TABLE room_blocks ENABLE ROW LEVEL SECURITY` | `src/db/schema.sql` |
| UCC room inventory (SW, NLT, CALC) | `src/db/seed.js` |
| Room-block service, routes and admin form | `src/services/roomBlocks.js`, `src/routes/admin.js`, `public/js/rooms-admin.js` |
| Availability, day board, clash checks, suggestions, weekly series respect blocks | `src/services/rooms.js`, `src/services/bookings.js` |
| Booking window saved in `app_meta` (`booking_open`, `booking_close`, `booking_max_hours`) | `src/db/schema.sql`, `src/services/settings.js` |
| Admin Settings page and `GET/PATCH /api/admin/settings` | `src/routes/admin.js`, `public/admin.html`, `public/js/settings-admin.js` |
| Whole-hour booking rule (blocks may still be 30 minutes) | `src/utils/time.js`, `src/services/bookings.js`, `src/services/rooms.js` |
| `supervisor` column on bookings (course code and/or supervisor on a request) | `src/db/schema.sql` |
| `checked_out_at` on bookings (schema 12). Checkout shortens `end_time` to now and keeps `approved` | `src/db/schema.sql`, `src/services/bookings.js` |
| Public room list `GET /api/public/rooms?date=` with free periods, no booking details | `src/routes/public.js`, `src/services/rooms.js` |

Nothing is dropped or rewritten. `setup.js` runs the whole `schema.sql` again whenever the
stored `schema_version` is lower than `SCHEMA_VERSION`, and every statement in that file is
idempotent (`CREATE ... IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE`,
`DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`).

## 3. Prerequisites

- Node.js 20 or newer.
- A Supabase project you are allowed to modify.
- The database password, stored in a password manager.
- Optional: Vercel account for deployment.
- Optional: `psql` for manual verification (Supabase SQL Editor is enough).

## 4. Connection settings

Use the **Transaction pooler** string, not the direct connection: Vercel functions are
short-lived and would exhaust direct connections.

Supabase dashboard -> **Connect** -> **Transaction pooler** (port `6543`):

```text
postgresql://postgres.<project-ref>:<url-encoded-password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Rules that the code already handles for you:

- `src/config/index.js` strips `sslmode`, `sslrootcert`, `supa`, `pgbouncer` and
  `connection_limit` from the URL, because `pg` misreads them against Supabase's pooler.
- TLS is configured in `src/db/index.js`; `DATABASE_CA` (Project Settings -> Database ->
  SSL certificate) enables full verification.
- `POSTGRES_URL` and `POSTGRES_PRISMA_URL` are accepted as fallbacks, which is what Vercel's
  Supabase integration sets automatically.

Encode special characters in the password (`@` -> `%40`, `#` -> `%23`, `/` -> `%2F`).

## 5. Environment variables

Create `.env` locally (never commit it) or add these in Vercel -> Settings -> Environment
Variables. Only `DATABASE_URL` is required for a database-backed deployment.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (pooler, port 6543). |
| `ADMIN_EMAILS` | recommended | Comma-separated emails that become `admin` on sign-up/sign-in. |
| `JWT_SECRET` | recommended | 32+ random characters for signing sessions. If unset in production it is derived from `DATABASE_URL`; rotating the database password then signs everyone out. |
| `DATABASE_CA` | optional | Supabase CA certificate, enables verified TLS. |
| `ALLOWED_EMAIL_DOMAIN` | optional | Restrict sign-ups, e.g. `ucc.edu.gh`. Empty allows any address. |
| `SEED_DEMO` | optional | `true` adds demo lecturers/student/bookings to an empty database. Never demo admin. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | optional | Emailed password-reset codes. Without them "Forgot password" tells the user to contact the timetable office. |
| `ARKESEL_API_KEY`, `ARKESEL_SENDER_ID`, `ARKESEL_URL`, `ARKESEL_SANDBOX` | optional | SMS reset codes and phone verification. |
| `CHECKIN_GRACE_MINUTES` | optional | `5`-`60`, default `15`. |
| `CHECKIN_RELEASE` | optional | `off` keeps check-in but never releases a no-show booking. |
| `TZ` | optional | Defaults to `Africa/Accra`. Leave it. |

Security notes:

- `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are **not used** and
  should not be added. The API is the only database client.
- Never expose `DATABASE_URL` to the browser, a static page, or a build log.
- The app refuses API requests with a clear message when `DATABASE_URL` is missing instead of
  crashing, and `/api/health` lists what is missing.

## 6. Database setup, step by step

```bash
npm install
```

Set `DATABASE_URL` for the current shell:

```powershell
$env:DATABASE_URL = "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres"
```

```bash
npm run db:migrate      # applies schema.sql if schema_version < 9, then stops
npm run db:seed:rooms   # inserts the 59 UCC rooms only if they are missing
```

What each command does:

- `npm run db:migrate` -> `src/db/migrate.js` -> `setup.ensureReady()`. It takes a Postgres
  advisory lock, reads `app_meta.schema_version`, runs `schema.sql` when needed, writes the
  new version, and seeds rooms only when `rooms` is empty. Running it twice is safe.
- `npm run db:seed:rooms` -> `src/db/seed.js --no-demo`. Inserts/updates reference buildings
  and rooms. It does not create demo users, bookings or passwords.
- `npm run db:seed` (no flag) also adds demo accounts and sample bookings. Do not run it on a
  database that already has real data.

If you prefer SQL only, open the Supabase SQL Editor, paste `src/db/schema.sql`, and run it
once. It creates or updates every table, constraint, trigger and index without deleting rows.

### Schema you should see afterwards

| Table | Purpose |
|---|---|
| `users` | Accounts: `student`, `lecturer`, `admin`; password hash, phone, reset/2FA fields, `session_version`. |
| `buildings` | `SW`, `NLT`, `CALC`. |
| `rooms` | 59 rooms with `capacity`, `type`, `facilities` (jsonb), `bookable_by`, `is_active`, `door_code`. |
| `bookings` | One row per request or booking; status `pending`, `approved`, `rejected`, `cancelled`, `released`. |
| `booking_series` | One row per weekly recurring booking. |
| `room_blocks` | Dated temporary closures created by the timetable office. |
| `notifications` | In-app notices. |
| `audit_log` | Append-only; database triggers refuse `UPDATE` and `DELETE`. |
| `access_requests` | Lecturer/admin verification with staff ID and document fingerprint. |
| `password_resets`, `phone_verifications` | Hashed reset codes and phone checks. |
| `app_meta` | `schema_version`, `checkin_since`. |

### `room_blocks` reference DDL

This is already inside `schema.sql`. It is repeated here so you can confirm the object
exists, or create it by hand in an emergency.

```sql
CREATE TABLE IF NOT EXISTS room_blocks (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id    integer     NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  date       date        NOT NULL,
  start_time time        NOT NULL,
  end_time   time        NOT NULL,
  reason     text        NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 300),
  created_by integer     NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_time < end_time),
  CONSTRAINT room_blocks_no_overlap EXCLUDE USING gist (
    room_id WITH =,
    tsrange(date + start_time, date + end_time) WITH &&
  )
);
CREATE INDEX IF NOT EXISTS idx_room_blocks_room_date ON room_blocks (room_id, date);
ALTER TABLE room_blocks ENABLE ROW LEVEL SECURITY;
```

Meaning: a closure is a **time range on a date**, not a permanent room status. The room stays
`is_active = true` and becomes bookable again as soon as the range passes.

## 7. UCC room inventory

`src/db/seed.js` creates exactly these rooms. Codes are stable identifiers used by the API,
the door codes and every booking.

| Building | Code | Room codes | Count | Sample capacity |
|---|---|---|---:|---:|
| Sandwich Lecture Theatre | `SW` | `SW-01` ... `SW-23` | 23 | 80 |
| New Lecture Theatre | `NLT` | `NLT-01` ... `NLT-23` | 23 | 80 |
| C. A. Ackah Theatre | `CALC` | `CALC-01` ... `CALC-13` | 13 | 60 |
| **Total** | | | **59** | |

Capacities, floors, facilities and names are **placeholders**. Before launch the timetable
office must edit each room in Admin -> Rooms and buildings with verified values. The
standalone demo in `public/preview.html` uses 30 seats per room; the seeded database uses
80/80/60. Unify them once UCC confirms the real numbers.

Example update:

```sql
UPDATE rooms SET capacity = 120, floor = 1, facilities = '["projector","air conditioning"]'::jsonb
WHERE code = 'NLT-01';
```

## 8. Accounts, roles and password recovery

Roles are stored on `users.role` and carried in the JWT session cookie.

| Role | Can do |
|---|---|
| `student` | Search free rooms, request `study`/`meeting`/`event` bookings in rooms with `bookable_by = 'all'`, cancel own booking. Requests start as `pending`. |
| `lecturer` | Everything a student can do, plus `lecture`/`tutorial`/`lab`/`exam` categories, rooms marked `bookable_by = 'staff'`, and weekly series (2 to 16 weeks). Bookings are created `approved`. |
| `admin` | Approve/reject requests, create closures, manage rooms/buildings, reset passwords, review access requests, read statistics and the audit log, print door signs. |

Sign-up and reset flows (already implemented, no Supabase Auth involved):

| Endpoint | Behaviour |
|---|---|
| `POST /api/auth/register` | Creates a student. An email in `ADMIN_EMAILS` becomes admin. Staff roles require an access request with a document. |
| `POST /api/auth/login` | Sets an HTTP-only session cookie. `mustChangePassword` forces a password change. |
| `POST /api/auth/forgot-password` | Sends a 6-digit code by email or SMS when configured; otherwise returns the "contact the timetable office" method. |
| `POST /api/auth/reset-password` | Consumes the newest unused code (5 attempts max) and signs the user in. |
| `POST /api/auth/change-password` | Requires the current password; bumps `session_version` so other sessions end. |
| `POST /api/auth/phone`, `POST /api/auth/phone/verify`, `DELETE /api/auth/phone` | Verify or remove a phone number for SMS resets. |
| `POST /api/access` | Lecturer/admin access request with staff ID, position and a PDF/JPEG/PNG document. |
| `GET /api/access/mine` | Status of the caller's request. |

Do **not** switch this to Supabase Auth. Passwords, reset codes, sessions, role checks and
the audit trail are implemented here and tested; migrating identity would invalidate all
existing accounts.

Make yourself admin on a fresh database:

```sql
UPDATE users SET role = 'admin' WHERE lower(email) = lower('you@ucc.edu.gh');
```

or set `ADMIN_EMAILS=you@ucc.edu.gh` before signing up.

## 9. Booking rules and conflict logic

Defaults live in `src/config/index.js` under `booking`. The booking window is stored in
`app_meta` and edited on **Settings** in `/admin`, then loaded into the running server:

| Rule | Value |
|---|---|
| Open hours | 06:30 - 20:30 by default, Africa/Accra; editable in `/admin` → Settings |
| Start times | every 30 minutes |
| Booking length | whole hours only, up to the longest class set in `/admin` (default 4, range 1-6) |
| Booking horizon | 150 days ahead |
| Check-in window | 10 minutes before start, 15 minutes after (configurable) |
| No-show release | Approved booking without check-in becomes `released` and frees the room |
| Checkout | Owner only, after check-in and after the start. Sets `checked_out_at` and moves `end_time` to the current minute, so the unused tail is free immediately. Status stays `approved`. |

A room is **available** for a slot only when all of these are true:

1. `rooms.is_active` is true.
2. The caller's role may book it (`bookable_by`, and the category list for students).
3. `capacity >= attendees`.
4. No `bookings` row for that room on that date with `status IN ('pending','approved')`
   overlapping the slot.
5. No `room_blocks` row for that room on that date overlapping the slot.

Overlap is half-open: `08:00-10:00` and `10:00-12:00` do not clash.

Enforcement layers:

- **Service layer** (`src/services/bookings.js`) returns `409` with `clash: 'room' | 'unavailable' | 'user'`, the conflicting rows, and a suggested free slot.
- **Database constraints**: `bookings_no_room_overlap` and `bookings_no_user_overlap` are
  `EXCLUDE USING gist` on `tsrange(date + start_time, date + end_time)` restricted to
  holding statuses. `room_blocks_no_overlap` prevents two closures for the same room/time.
- **Cross-table triggers**: `bookings_reject_room_blocks` and `room_blocks_reject_bookings`
  raise SQLSTATE `23P01` when a booking and a closure overlap. `lock_room_for_schedule`
  takes `pg_advisory_xact_lock(room_id)` first, so a booking and a closure created in the
  same millisecond still serialise. The services translate `23P01` into `409`.

Never weaken these constraints to make an import easier. Load historical data with
`status = 'cancelled'` or outside the exclusion predicate.

## 10. API surface

All responses are JSON. Errors use `{ "error": "message", ... }` with the listed status.
Auth uses an HTTP-only cookie set by `/api/auth/login`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/api/health` | none | Reports database status and missing settings. |
| `GET` | `/api/public/now` | none | Rooms free right now. |
| `GET` | `/api/public/rooms` | none | `date`. Every active room with its first free whole-hour period. No booking titles or names. |
| `GET` | `/api/rooms/meta` | user | Buildings, room types, facilities, booking rules. |
| `GET` | `/api/rooms` | user | `buildingId`, `type`. Active rooms only. |
| `GET` | `/api/rooms/available` | user | `date`, `start`, `end`, `buildingId`, `type`, `minCapacity`, `facilities=a,b`. Excludes bookings and closures. |
| `GET` | `/api/rooms/schedule/day` | user | `date`, `buildingId`. Day board including `blocks`. |
| `GET` | `/api/rooms/:id` | user | One room. |
| `GET` | `/api/rooms/:id/week` | user | `date`. Weekly view. |
| `POST` | `/api/bookings` | user | `roomId`, `title`, `category` (optional for the public site), `courseCode`, `supervisor`, `date`, `start`, `end`, `attendees` (optional, default 1), `notes`. Students get `pending`. |
| `GET` | `/api/bookings/mine` | user | Caller's bookings. |
| `POST` | `/api/bookings/:id/cancel` | owner or admin | Frees the slot. |
| `POST` | `/api/bookings/:id/check-out` | owner | After check-in. Ends the booking now and frees the rest of the room. |
| `POST` | `/api/bookings/series/preview` | staff | Dry run for a weekly series. |
| `POST` | `/api/bookings/series` | staff | Creates 2-16 weekly occurrences atomically. |
| `POST` | `/api/bookings/series/:id/cancel` | owner | Cancels the remaining occurrences. |
| `GET` | `/api/bookings/mine.ics`, `/api/bookings/:id/calendar.ics` | user | Calendar files. |
| `GET` | `/api/calendar/feed/:file` | token | Subscribable feed. |
| `POST` | `/api/calendar/feed`, `DELETE /api/calendar/feed` | user | Create/revoke feed token. |
| `POST` | `/api/door/check-in` | user | `code`; releases no-shows. |
| `GET` | `/api/door/:code` | none | Door landing page data. |
| `GET` | `/api/notifications`, `POST /api/notifications/read-all` | user | In-app notices. |
| `GET` | `/api/admin/bookings` | admin | Filter by status/date. |
| `POST` | `/api/admin/bookings/:id/approve`, `.../reject` | admin | Decision plus optional reason. |
| `GET` | `/api/admin/bookings/:id/context` | admin | Requester history for a decision. |
| `GET/POST` | `/api/admin/room-blocks` | admin | `GET` filters `roomId`, `date`. `POST` body `roomId`, `date`, `start`, `end`, `reason`. |
| `DELETE` | `/api/admin/room-blocks/:id` | admin | Removes a closure. |
| `GET/PATCH` | `/api/admin/settings` | admin | The booking window: `open`, `close`, `maxHours` (1–6). Applies to every room. |
| `GET` | `/api/admin/rooms` | admin | Buildings, rooms, types for the room editor. |
| `POST/PATCH/DELETE` | `/api/admin/buildings[/:id]` | admin | Building CRUD. Deleting a building with rooms is refused. |
| `POST/PATCH/DELETE` | `/api/admin/rooms[/:id]` | admin | Room CRUD; deletion deactivates when history exists. |
| `GET` | `/api/admin/users` | admin | Search/filter accounts. |
| `PATCH` | `/api/admin/users/:id` | admin | Role, active flag, department. |
| `POST` | `/api/admin/users/:id/reset-password` | admin | Issues a temporary password. |
| `GET` | `/api/admin/access-requests`, `.../:id/document` | admin | Pending staff verifications and the uploaded file. |
| `POST` | `/api/admin/access-requests/:id/approve`, `.../reject` | admin | Grants the requested role. |
| `GET` | `/api/admin/stats`, `/api/admin/audit`, `/api/admin/audit.csv` | admin | Reporting and export. |
| `GET` | `/api/admin/door-signs`, `/api/admin/rooms/:id/door-qr.svg` | admin | Printable signage. |
| `POST` | `/api/admin/rooms/:id/door-code` | admin | Rotates a room's door code. |

### Example requests

```bash
# free rooms
curl "http://localhost:3000/api/rooms/available?date=2026-11-20&start=10:00&end=12:00&buildingId=1"

# book a room (session cookie from /api/auth/login)
curl -X POST http://localhost:3000/api/bookings \
  -H "Content-Type: application/json" -H "X-Requested-With: XMLHttpRequest" \
  -b cookies.txt \
  -d '{"roomId":1,"title":"BUS 201 revision","category":"study","date":"2026-11-20","start":"10:00","end":"12:00","attendees":40}'

# close a room for maintenance
curl -X POST http://localhost:3000/api/admin/room-blocks \
  -H "Content-Type: application/json" -H "X-Requested-With: XMLHttpRequest" \
  -b admin-cookies.txt \
  -d '{"roomId":1,"date":"2026-11-21","start":"08:00","end":"12:00","reason":"Electrical maintenance"}'
```

`POST`/`PATCH`/`DELETE` require the `X-Requested-With: XMLHttpRequest` header (CSRF defence).

## 11. Admin workflows

Approvals: `GET /api/admin/bookings?status=pending`, then approve or reject. A rejection
requires a reason that is stored in `decision_reason` and shown to the requester. Approving
keeps the slot held; rejecting frees it immediately.

Temporary unavailability (the new capability):

1. Admin -> Room management -> Temporary unavailability.
2. Pick room, date, start, end and a reason of 3-300 characters.
3. `POST /api/admin/room-blocks` writes `room_blocks` and an audit entry `room.block`.
4. The period disappears from `/api/rooms/available`, shows as `unavailable` on the day board,
   and blocks new bookings and weekly planning.
5. The database refuses a closure that overlaps a pending/approved booking, and refuses a
   booking that overlaps a closure. The admin sees
   "SW-03 already has a booking or an unavailable period at that time".
6. "Make available" in the admin list calls `DELETE /api/admin/room-blocks/:id` and frees the
   period again.

Existing bookings are **not** cancelled automatically when a closure is added. If a closure
must displace a booking, reject or cancel the booking first, then create the closure.

## 12. Front-end pages

| Page | Backend | Purpose |
|---|---|---|
| `public/index.html` + `css/spaces.css` + `js/spaces.js` | `/api/public/*`, `/api/auth/*`, `/api/bookings/*`, `/api/door/check-in` | The public site: browse the 59 UCC rooms, sign in or register, request a room, then check in, check out or cancel. Admin tools are at `/admin`. |
| `public/preview.html` + `js/preview.js` | none | Standalone interface preview kept for design review. All data stays in `localStorage` key `ucc-spaces-preview-v2`; it is not linked from the live site. |
| `public/account.html` + `js/account.js` | `/api/auth/*` | Sign in, sign up, forgot password, reset with code, change password. |
| `public/booking.html` + `js/app.js` | full API | Older database-connected client, kept as a secondary interface. |
| `public/admin.html` + `js/admin-app.js` | `/api/admin/*` | Timetable office, with approvals, rooms, people, statistics, audit log and the booking window. Light UCC theme in `css/admin-spaces.css`. |
| `public/door.html` | `/api/door/*` | Door code check-in. |

`/` and `/admin` share the same database. A room approved, closed or re-timed in `/admin`
appears that way on `/` on the next request. The preview at `/preview.html` is deliberately
separate and must never be presented as production data.

## 13. Deploy to Vercel

1. Push the repository.
2. Import it in Vercel. Framework preset: **Other**. Output directory: `public`
   (`vercel.json` already sets this).
3. Add `DATABASE_URL`, `ADMIN_EMAILS` and `JWT_SECRET` for Production and Preview.
4. `vercel.json` sets `buildCommand` to `npm run vercel-build`, which runs
   `npm run db:migrate`. The first deploy therefore brings Supabase to schema version 12.
5. `api/index.js` is the serverless entry point; `/api/(.*)` rewrites to it, `maxDuration` 10s.
6. After the first deploy open `/api/health`. It must report the database as reachable and
   list no missing settings.
7. Sign up with an `ADMIN_EMAILS` address, then confirm Admin access.

`npm run vercel-build` needs `DATABASE_URL` in the environment. Running it locally without a
database fails by design; that is not a code defect. Use `npm run db:migrate` locally with a
development `DATABASE_URL`, or a separate Supabase project for tests.

Local development:

```bash
npm install
$env:DATABASE_URL = "postgresql://...:6543/postgres"   # required for the live site
npm run dev                                            # http://localhost:3000
```

With no `DATABASE_URL`, `npm run dev` still serves `public/`, but `/` shows that classrooms
are unavailable and the API returns a clear "no database connected" error. The design preview
at `/preview.html` still works.

## 14. Verification checklist

Run these in order on a copy first, then production.

Database

- [ ] `SELECT value FROM app_meta WHERE key = 'schema_version';` returns `9`.
- [ ] `SELECT count(*) FROM rooms;` returns `59` (23 SW, 23 NLT, 13 CALC).
- [ ] `SELECT count(*) FROM buildings;` returns `3`.
- [ ] `SELECT to_regclass('public.room_blocks');` is not null.
- [ ] `SELECT relrowsecurity FROM pg_class WHERE relname = 'room_blocks';` is `true`.
- [ ] `SELECT conname FROM pg_constraint WHERE conname IN ('room_blocks_no_overlap','bookings_no_room_overlap','bookings_no_user_overlap');` returns all three.
- [ ] `SELECT tgname FROM pg_trigger WHERE tgname IN ('bookings_reject_room_blocks','room_blocks_reject_bookings','room_blocks_lock_room','bookings_lock_room');` returns all four.

Application

- [ ] `GET /api/health` is `200` and reports the database.
- [ ] `GET /api/rooms/meta` lists SW, NLT, CALC and the current booking window (06:30-20:30 by default).
- [ ] `GET /api/rooms/available?date=<tomorrow>&start=10:00&end=11:00` returns rooms.
- [ ] Sign up, sign in, sign out, forgot password, reset with a code.
- [ ] Student request is `pending`; lecturer booking is `approved`; student cannot use `lecture` or a staff-only room.
- [ ] Approve and reject both work and the requester sees the decision.
- [ ] Booking 10:00-12:00 twice in the same room returns `409` with `clash: 'room'`.
- [ ] Booking the same time in two rooms returns `409` with `clash: 'user'`.
- [ ] Admin closure on a free period succeeds; closure overlapping a booking returns `409`.
- [ ] Booking a closed period returns `409` with `clash: 'unavailable'`.
- [ ] Day board shows the closure; `/api/rooms/available` omits the room.
- [ ] Weekly series preview flags the closed week and creation refuses it.
- [ ] `audit_log` gains `booking.create`, `room.block`, `room.unblock` entries.
- [ ] `audit_log` rejects `UPDATE` and `DELETE`.
- [ ] `public/preview.html` still works with the server stopped.

## 15. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ECONNREFUSED`/timeout on Vercel | Direct connection (5432) instead of pooler | Use the Transaction pooler string, port 6543. |
| `self-signed certificate in certificate chain` | `sslmode=require` sent to Supabase pooler | The config strips it; if it persists set `DATABASE_CA` or unset the parameter in the URL. |
| `password authentication failed` | Unencoded characters in the password | URL-encode `@ # / ? %`. |
| `prepared statement "s1" already exists` | Session pooler/direct connection with `pg` pooling | Use the transaction pooler, which the code is written for. |
| `npm run vercel-build` fails locally | No `DATABASE_URL` | Expected. Provide one or skip the build step locally. |
| `23P01` surfaces as 500 | A code path does not translate the exclusion violation | Catch `err.code === '23P01'` and return `409`, as the booking and block services do. |
| Sign-ups succeed but nobody is admin | `ADMIN_EMAILS` missing or mistyped | Set it, redeploy, then update the existing row: `UPDATE users SET role='admin' WHERE lower(email)=lower('...');` |
| Everyone signed out after deploy | `JWT_SECRET` unset and `DATABASE_URL` changed | Set a stable `JWT_SECRET` of 32+ characters. |
| Duplicate rooms after a manual seed | Seed re-run against a partially populated database | Room codes are unique; inspect `rooms` and fix duplicates by code instead of truncating. |
| Preview shows old data | Browser `localStorage` | Open `/preview.html` and use "Reset bookings", or clear key `ucc-spaces-preview-v2`. |

## 16. Handoff notes for the next agent

- Preserve the existing Supabase project and its data. Apply `schema.sql` (additive), never
  recreate the project or reset the schema.
- Do not introduce Supabase Auth, client-side Supabase keys or direct browser queries.
- Do not call `db:seed` against a database with real accounts or bookings.
- Keep the three-layer conflict protection. Removing the exclusion constraints or triggers
  reintroduces double booking under concurrent requests.
- Verify capacities, room names, facilities and door codes with UCC before launch.
- Photos in `public/media/` are free-licence campus images from Wikimedia Commons. Replace
  them with verified UCC building photographs before launch.
- Legal pages `public/privacy.html` and `public/terms.html` are linked from the site footer.
- The standalone preview at `/preview.html` stores data only in the browser. Say so when
  demonstrating it; do not present it as the live booking system.

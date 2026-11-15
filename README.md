# Lecture Room Booking System

Find a free lecture room, book it without clashes, and let the timetable office approve student requests.
Node.js + Express API, vanilla JS frontend, PostgreSQL (Supabase), hosted on Vercel.

## What works so far

- Register, sign in and out (bcrypt + JWT in an `httpOnly` cookie), change password
- Booking rules: 07:00–21:00, 30-minute slots, at most 6 hours, up to 150 days ahead, no past times, capacity check
- Role rules: students may only book seminar, study and meeting rooms, for study, meeting or event purposes, and wait for approval; lecturers and admins are approved straight away
- Clash detection that names the conflicting booking and suggests the nearest free slot of the same length
- **Database-level double-booking protection:** two Postgres exclusion constraints stop overlapping pending or approved bookings, in one room or for one person, even if requests arrive at the same moment
- Free-room finder (smallest suitable room first), day board and room week API
- Admin approval API with approve and reject, in-app notifications, audit log
- "Campus Now" landing page with live room counts and ticker, sign-in and register, and a first dashboard
- Booking sheet: book or request a room from the search results; clashes are shown inline with a one-click
  "Try 10:00–12:00?" suggestion; bookings can be cancelled from the dashboard

- Day board: every room against the hours of one day, with a live current-time line. Click an empty
  slot to book it, drag for longer, or use the keyboard; staff-only rooms are locked for students;
  past time is dimmed; filter by building and step through days

- Approval queue for admins (Approvals in the top bar, with a count of requests waiting): reads like
  an inbox, most urgent first; shows who is asking, the room that day and their history; A approves,
  R rejects with an optional reason (quick reasons offered); a Decided tab lists recent decisions

- Room management for admins (Rooms in the top bar): add, edit and search buildings and rooms; set
  seats, type, facilities and who can book; deactivate a room (its upcoming bookings are cancelled and
  the people who booked are told, after a confirmation); delete rooms that were never booked

- People for admins (People in the top bar): search by name, email or index number; make someone a
  student, lecturer or admin (they're told, and it applies on their next click); correct details;
  deactivate an account (upcoming bookings are cancelled after a confirmation). You can't change your
  own role or deactivate yourself, and people in `ADMIN_EMAILS` can't be demoted here

- Staff verification: at sign-up, people choose student, lecturer or timetable office (admin). Staff
  give their staff ID, position and department and upload their offer or appointment letter (PDF, JPG
  or PNG, up to 3 MB; phone photos are shrunk in the browser). They start with student access; admins
  review the letter under Approvals → Staff access, tick three checks, and approve or reject with a
  reason. The letter is deleted as soon as a decision is made; its SHA-256 fingerprint stays in the
  audit log. Existing students can ask from their dashboard

- Passwords: "Forgot your password?" tells the timetable office (same answer for any email, so it
  can't reveal who has an account). An admin checks the person's ID and presses Reset password under
  People: a one-time temporary password (shown once, valid 72 hours) is created and the account is
  signed out everywhere. Signing in with it leads straight to "Choose a new password"; nothing else
  works until that's done. Everyone can change their password from their name in the top bar, which
  signs out their other devices

- Statistics for admins (Statistics in the top bar), for any date range and building: room
  utilisation (hours booked ÷ hours available, 07:00–21:00 on teaching days, approved bookings only)
  with the change against the previous period; bookings, hours, student requests and the median time
  to a decision; busiest hours; what rooms are booked for; utilisation per room with plain-language
  notes on under-used and over-sized rooms. Every chart has a table view, and room figures download
  as CSV

- Room week view (click a room's code on the day board, in search results or in the admin rooms list):
  Monday to Sunday across, time running down; the room's seats, type and facilities; click or drag
  down an empty slot to book; keyboard arrows move by half-hour and by day; previous / this / next
  week, and a date picker; the address (#/room/12?date=…) can be bookmarked or shared

Next: recurring bookings, admin pages for rooms, users, stats and audit log, calendar export.

## Run it locally

You need Node 20+ and a Postgres database. Either install Postgres locally, or point `DATABASE_URL` at a
**separate** Supabase project used only for development.

```bash
npm install
```

```bash
createdb rooms_dev
```

```bash
createdb rooms_test
```

```bash
npm run db:seed
```

```bash
npm run dev
```

Open http://localhost:3000. Demo accounts (password `Campus2026`): `admin@campus.test`, `lecturer@campus.test`, `student@campus.test`.

Locally the app connects to `postgres://postgres:postgres@localhost:5432/rooms_dev`. Set `DATABASE_URL` to change that.

### Tests

```bash
npm test
```

The tests empty and refill the `rooms_test` database (or `DATABASE_URL_TEST`). Never point that at real data.

## Deploy: Supabase + Vercel (no terminal needed)

Everything happens in the two websites. The app creates its own tables and rooms the first
time it meets an empty database.

1. **Supabase:** create a project at supabase.com. Note the database password.
2. **Vercel:** import the `lilcrips/class` repository (Add New → Project). Leave the build settings as they are.
3. **Connect the database**, either way:
   - **Easiest:** in your Vercel project open **Storage → Connect Database → Supabase** and pick your
     project. Vercel adds the connection settings itself.
   - **Or by hand:** in Supabase click **Connect**, copy the **Transaction pooler** string (port 6543,
     host ends in `pooler.supabase.com`), put your password in place of `[YOUR-PASSWORD]`, and add it in
     Vercel → Settings → Environment Variables as `DATABASE_URL`.
4. **Make yourself the first admin:** in Vercel → Settings → Environment Variables add `ADMIN_EMAILS`
   with your email address (several can be separated by commas). Someone has to review the first staff
   request; after that, new lecturers and admins sign up with their offer letter and you approve them
   under Approvals → Staff access.
5. **Redeploy** (Deployments → latest → ⋯ → Redeploy). Settings only reach deployments made after you add them.
6. Open `https://<your-site>.vercel.app/api/health`. When it shows `"ok": true`, open the site and
   **register with the email from step 4**. You are now the admin.

Optional settings (Vercel → Settings → Environment Variables):

| Name | What it does |
|---|---|
| `SEED_DEMO` | `true` adds demo lecturers, a demo student (`student@campus.test` / `Campus2026`) and sample bookings to an empty database. No demo admin is ever created on a deployment. |
| `ALLOWED_EMAIL_DOMAIN` | e.g. `ug.edu.gh`: only addresses at that domain can register. |
| `JWT_SECRET` | A long random string for signing logins. Optional: without it, one is derived from the database connection string. |

To use your campus's real rooms, sign in as admin and open **Rooms**: add your buildings and rooms,
and delete the demo ones (any demo room that was never booked can be deleted; booked ones can be
deactivated).

### If the deployed site shows an error

Open `https://<your-site>.vercel.app/api/health`. It says in plain words what is wrong:

| It says | Fix |
|---|---|
| `No database is connected` | Do step 3, then redeploy. |
| `Could not reach the database` | You used the direct connection (`db.<ref>.supabase.co`). Vercel can't reach it; use the **Transaction pooler** string (port 6543). |
| `Wrong database password` | Reset it in Supabase. Symbols in the password must be URL-encoded (`@` → `%40`, `#` → `%23`, `/` → `%2F`). |
| `did not recognise the user` | With the pooler the user is `postgres.<project-ref>`, not `postgres`. |
| `No admin yet` | Do step 4, redeploy, then register (or sign in) with that email. |

`"ok": true` means the server is configured and connected. For anything else, check Vercel → Deployments → (latest) → Logs.

### Notes for Supabase

- **Row Level Security is switched on for every table with no policies.** Supabase exposes tables in `public`
  through its REST API to anyone holding the public anon key; with RLS on and no policies, that API returns
  nothing. The app connects directly as the table owner, so it is not affected. Do not add policies unless
  you mean to expose data.
- The app uses Supabase only as a Postgres database.
- The connection string's `sslmode=require` option is removed on purpose: node-postgres would otherwise
  demand a certificate chain Supabase's pooler doesn't send, and every connection would fail. The
  connection is still encrypted. It does not use Supabase Auth or the Supabase JS client.

### Notes for Vercel

- The login rate limit is kept in memory, so each serverless instance counts separately. That's enough
  for a project; a shared store (e.g. Upstash Redis) would make it exact.
- The time zone is pinned to `Africa/Accra` in `src/config/index.js`, so "today" and "now" are right
  whatever region the function runs in.

## Project layout

```
api/index.js          Vercel entry point (exports the Express app)
src/app.js            Express app: security headers, CSRF guard, routes
src/server.js         Local development server
src/config/           Settings and booking rules
src/db/               Postgres pool, schema.sql, migrate, seed
src/middleware/       Auth (JWT cookie, roles), CSRF, errors
src/services/         Booking rules and clash detection, rooms, notifications, audit
src/routes/           REST endpoints
src/utils/            Time-slot validation and overlap logic
public/               Frontend (HTML, CSS, JS, fonts, campus footage)
tests/                Unit tests and API tests (node:test + supertest)
```

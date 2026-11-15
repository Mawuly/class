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
- Admin approval queue with approve and reject, in-app notifications, audit log
- "Campus Now" landing page with live room counts and ticker, sign-in and register, and a first dashboard
- Booking sheet: book or request a room from the search results; clashes are shown inline with a one-click
  "Try 10:00–12:00?" suggestion; bookings can be cancelled from the dashboard

- Day board: every room against the hours of one day, with a live current-time line. Click an empty
  slot to book it, drag for longer, or use the keyboard; staff-only rooms are locked for students;
  past time is dimmed; filter by building and step through days

Next: room week view, recurring bookings, admin pages for rooms, users, stats and audit log, calendar export.

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
4. **Make yourself the admin:** in Vercel → Settings → Environment Variables add `ADMIN_EMAILS` with your
   email address (several can be separated by commas).
5. **Redeploy** (Deployments → latest → ⋯ → Redeploy). Settings only reach deployments made after you add them.
6. Open `https://<your-site>.vercel.app/api/health`. When it shows `"ok": true`, open the site and
   **register with the email from step 4**. You are now the admin.

Optional settings (Vercel → Settings → Environment Variables):

| Name | What it does |
|---|---|
| `SEED_DEMO` | `true` adds demo lecturers, a demo student (`student@campus.test` / `Campus2026`) and sample bookings to an empty database. No demo admin is ever created on a deployment. |
| `ALLOWED_EMAIL_DOMAIN` | e.g. `ug.edu.gh`: only addresses at that domain can register. |
| `JWT_SECRET` | A long random string for signing logins. Optional: without it, one is derived from the database connection string. |

To change the rooms to your campus's real ones, edit the lists at the top of `src/db/seed.js`
(you can do that on github.com) **before** the first deploy, or later in Supabase's Table Editor.

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

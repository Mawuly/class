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

Next: day board and week view pages, recurring bookings, admin pages for rooms, users, stats and audit log, calendar export.

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

## Deploy: Supabase + Vercel

1. **Create a Supabase project.** Note the database password.
2. **Create the tables.** In Supabase, open **Connect** and copy the **Session pooler** connection string (port 5432). Then run, once:
   ```bash
   DATABASE_URL="<session pooler string>" npm run db:seed:rooms
   ```
   This creates the schema and the buildings and rooms, but no demo users. Use `npm run db:seed` instead if you want the demo accounts on a test deployment. Edit `src/db/seed.js` with your campus's real rooms first.
3. **Make yourself an admin.** Register on the deployed site, then in the Supabase SQL editor:
   ```sql
   update users set role = 'admin' where email = 'you@your-university.edu.gh';
   ```
4. **Import the repository into Vercel** (framework preset: Other). Add these environment variables:
   | Name | Value |
   |---|---|
   | `DATABASE_URL` | The **Transaction pooler** string from Supabase → Connect (port 6543) |
   | `JWT_SECRET` | A long random string |
   | `ALLOWED_EMAIL_DOMAIN` | Optional, e.g. `ug.edu.gh` |
5. Deploy. Vercel serves `public/` from its CDN, and every `/api/*` request goes to `api/index.js` (see `vercel.json`).

### Notes for Supabase

- **Row Level Security is switched on for every table with no policies.** Supabase exposes tables in `public`
  through its REST API to anyone holding the public anon key; with RLS on and no policies, that API returns
  nothing. The app connects directly as the table owner, so it is not affected. Do not add policies unless
  you mean to expose data.
- The app uses Supabase only as a Postgres database. It does not use Supabase Auth or the Supabase JS client.

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

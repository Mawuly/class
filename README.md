# UCC Room Finder

Find a free room at the University of Cape Coast, submit a booking without clashes, and let the timetable office approve student requests.
Node.js + Express API, vanilla JS frontend, PostgreSQL (Supabase), hosted on Vercel.

## Features

Every feature in the project plan is built.

**Booking**
- Free-room finder: smallest suitable room first, so big halls aren't used up by small groups
- Booking sheet with clash detection that names what is in the way and offers the nearest free slot
- Day board (every room against one day's hours) and room week view, both bookable by click, drag or keyboard
- Weekly bookings for staff: 2–16 weeks, every week checked first, clashing weeks skipped on request, all in one transaction
- Rules: open 06:30–20:30 by default (set in `/admin` → **Settings**), start times every 30 minutes, bookings last whole hours up to the longest class (default 4 h), up to 150 days ahead, capacity; students request study, meeting and event bookings and wait for approval
- Requests can carry a course code and a supervisor; after checking in you can **check out early**, which ends the booking now and frees the rest of the slot
- Public room list `GET /api/public/rooms?date=`: every room's free periods, no booking details
- Check-in at the door: every room has a printed sign with a QR code and a six-character door code. Scanning it opens the room's door page (`/door?c=CODE`): whether the room is free, in use or waiting for check-in, a one-tap **Check in**, and booking it from the next half hour. On the public site, **My bookings** asks for that same door code. Check-in opens 10 minutes before the start; an approved booking nobody checks in to within 15 minutes is released, the room becomes free, and the person is told why
- Calendar export: an .ics file, or a private subscription link for Google Calendar, Outlook or Apple Calendar that stays up to date
- "Campus Now" landing page with live room counts; dashboard with your next booking, Coming up and notifications

**Timetable office portal (admins, at `/admin`)**
- A separate page with its own sign-in and navigation; students and lecturers never see it. Admins reach it from the **Timetable office** link on the main site, which shows how many requests are waiting
- Approvals inbox for room requests and staff access requests, with keyboard shortcuts (A / R) and reasons
- Rooms and buildings: add, edit, deactivate (upcoming bookings cancelled and people told), delete if never booked (deleting a room with only past bookings deactivates it)
- Temporary unavailability: close a room for a time on a date (maintenance, exams, events) with a reason; it disappears from search, shows hatched on the day board, week view and door page, and is bookable again afterwards. The database refuses a closure on a booking and a booking on a closure, even at the same instant
- Rejections need a reason, which the person sees
- People: change roles, correct details, deactivate accounts, reset passwords
- Door signs: print one sign per room (or all at once) from Rooms → **Print door signs**; **New code** on a room replaces a lost or photographed sign
- Statistics: utilisation, busiest hours, purposes, per-room use with plain-language notes; table views and CSV
- Audit log: every action as a sentence, filters, a failed-sign-in warning, CSV export
- Settings: the booking window (day opens, last class ends, longest class) for every room; changes apply to the public site immediately

**Accounts and security**
- Sign-up asks "I am a student" or "I am a lecturer". Lecturers attach their letter at sign-up; timetable office staff request access on the portal (`/admin` → Request access)
- Staff verification: lecturers and admins upload an offer or appointment letter, checked by an admin; the letter is deleted after the decision and only its SHA-256 fingerprint is kept
- Passwords hashed with bcrypt; sessions in an `httpOnly` cookie; every login token carries a session version, so a reset or password change signs out every device
- Forgot password by a 6-digit code texted through Arkesel to a confirmed phone number, or emailed to people without one (valid 10 minutes, 5 tries, newest code only, at most one a minute and five an hour, stored as a keyed hash); otherwise through the timetable office with a one-time temporary password
- Phone numbers only receive reset codes after their owner confirms them with a texted code
- Show / Hide on every password field
- **Double booking is impossible at the database level:** Postgres exclusion constraints per room and per person
- The audit log is append-only: a database trigger refuses any change or deletion
- CSRF header check, rate-limited sign-in, strict Content Security Policy, Row Level Security on every table

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

Open http://localhost:3000. That page is the live client: find a room, request it, then check in, check out or cancel. `/preview.html` is a separate demo that keeps its data in the browser. `/admin` is the timetable office. Demo accounts (password `Campus2026`): `admin@campus.test`, `lecturer@campus.test`, `student@campus.test`.

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
   request; after that, lecturers sign up on the main site and office staff request access at `/admin`,
   both with their offer letter, and you approve them at `/admin` under Approvals → Staff access.
5. **Redeploy** (Deployments → latest → ⋯ → Redeploy). Settings only reach deployments made after you add them.
6. Open `https://<your-site>.vercel.app/api/health`. When it shows `"ok": true`, open the site and
   **register with the email from step 4**. You are now the admin: open `https://<your-site>.vercel.app/admin`.

Optional settings (Vercel → Settings → Environment Variables):

| Name | What it does |
|---|---|
| `SEED_DEMO` | `true` adds demo lecturers, a demo student (`student@campus.test` / `Campus2026`) and sample bookings to an empty database. No demo admin is ever created on a deployment. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Turn on **Continue with Google** (see below). Without them the button is hidden. |
| `CAMPUS` | `ucc` (default): the University of Cape Coast's lecture buildings and rooms. `demo`: a small made-up campus. |
| `CHECKIN_GRACE_MINUTES` | Minutes after the start a booking can be checked in to before it is released (5–60, default 15). |
| `CHECKIN_RELEASE` | `off` keeps check-in but never releases bookings (useful while signs are being put up). |
| `ALLOWED_EMAIL_DOMAIN` | e.g. `ug.edu.gh`: only addresses at that domain can register. |
| `JWT_SECRET` | A long random string for signing logins. Optional: without it, one is derived from the database connection string. |

The site comes with the University of Cape Coast's lecture rooms: NLT 1–20, SW 1–19, CAC 1–12 and
Auditorium 900, LT 1–22, G1–G26, LLR 1–2, CoDE C1–C3, CRT 1–4, the S. K. Adjepong, Main and SMS
auditoriums, and empty buildings for the Faculty of Education, School of Business, Science Roof Top and
Assembly Hall Annex. **Seat counts are estimates**: correct them, and add rooms, in `/admin` → **Rooms**.
A database set up with the old demo rooms switches over by itself on the next start (demo rooms that
were booked are kept as `DEMO-…` for their history, and hidden once their bookings are over).

To change rooms, sign in at `/admin` and open **Rooms**: edit seats, add rooms or buildings, deactivate
rooms that aren't used for teaching (a room that was never booked can be deleted).

### Optional: password reset codes by text message (Arkesel)

With Arkesel set up, people add their Ghana mobile number under their name in the top bar, confirm it
with a texted code, and then get reset codes by text. People without a confirmed number get them by
email (if set up below), or through the timetable office.

1. Create an account at arkesel.com and buy some SMS credit.
2. Register a **sender ID** (up to 11 letters, e.g. `LectRooms`) and wait for Arkesel to approve it.
3. Copy your **API key** from the Arkesel dashboard (SMS API, version 2).
4. In Vercel → Settings → Environment Variables add:

| Name | Value |
|---|---|
| `ARKESEL_API_KEY` | your API key |
| `ARKESEL_SENDER_ID` | your approved sender ID |
| `ARKESEL_SANDBOX` | `true` for a first test (Arkesel accepts the message but doesn't send or charge); remove it afterwards |

5. Redeploy. `/api/health` shows `"passwordReset": "by code: text message …"`.
6. With the sandbox on, add your number under your name: if no error appears, Arkesel accepted the
   request. Then remove `ARKESEL_SANDBOX`, redeploy, and try again: the code should arrive on your phone.

If Arkesel refuses a message, the reason (wrong key, sender ID not approved, no credit) is in Vercel →
Deployments → Logs and in the audit log. The request format lives in `src/services/sms.js`; if Arkesel
changes its API, that is the only file to update (`ARKESEL_URL` overrides the address).

### Optional: password reset codes by email

"Forgot your password?" sends a 6-digit code by email once you give the app an email account to send
from. Without these settings it falls back to telling the timetable office, who reset passwords in
person. `/api/health` shows which one your site uses.

**Gmail (free, about 500 emails a day):**
1. Use a Gmail account for the app (a new one like `lecturerooms.noreply@gmail.com` is best).
2. Turn on 2-Step Verification for it, then create an **App password** (Google Account → Security →
   App passwords). Google shows a 16-letter password once.
3. In Vercel → Settings → Environment Variables add:

| Name | Value |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | the Gmail address |
| `SMTP_PASS` | the 16-letter app password (no spaces) |
| `MAIL_FROM` | `Lecture Rooms <the Gmail address>` |

4. Redeploy, then try "Forgot your password?" with your own account.

**Brevo** (free, 300 a day) works the same way with `smtp-relay.brevo.com`, port `587`, and the SMTP
login and key from Brevo → SMTP & API; verify your sender address there first. A university mail
server works too: ask IT for its SMTP host, port and an account.

Codes are never shown in Vercel's logs. On your own computer, without SMTP settings, codes are printed
in the terminal running `npm run dev` instead of being emailed.

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


## Continue with Google

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create (or choose) a project.
2. **APIs & Services → OAuth consent screen**: user type *External* (or *Internal* if your
   university uses Google Workspace and only its accounts should sign in), app name, support email.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Web application**.
   Under **Authorised redirect URIs** add `https://<your-site>.vercel.app/api/auth/google/callback`
   (and the same for any custom domain).
4. In Vercel → Settings → Environment Variables add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then redeploy.

New Google users become students (admins if listed in `ADMIN_EMAILS`); lecturers then request lecturer
access with their letter as before. If someone signs in with Google using the email of an existing
account, the accounts are linked, and the old password stops working (sign-up never proved who owned
that email; Google has). They keep using Google, or set a new password with "Forgot password".
With `ALLOWED_EMAIL_DOMAIN` set, only Google accounts at that domain can sign in.


## Location check at check-in

When someone checks in (door QR code or typed code), the phone is asked for its location. By default
the location is **required**: check-in is refused if the phone is away from the room's building, if
location is turned off, or if the phone's fix is too imprecise to tell, with a message saying which and
what to do. Buildings without a location are never refused. Every check-in is labelled for the
timetable office (at the building, away from it with the distance, location not shared, or building
location not set), and refused attempts are in the audit log. In `/admin` → **Settings** the office can
switch to **flag only**: check-in always works and far-away check-ins are only flagged. Only the label and the distance
are stored, never anyone's coordinates. Flagged check-ins are listed on **Statistics → Check-in
location** and in the audit log.

Set each building's location once in `/admin` → Rooms → **Edit building**: stand at the building and
press **Use my current location**, or paste the coordinates from Google Maps (right-click the
building). The radius (default 150 m) is how far away still counts as "at the building"; the phone's
own uncertainty (up to 100 m) is allowed on top.

To start with, every UCC building has a **campus-wide area**: the university's coordinates
(5°06′57″N, 1°17′27″W) with a 3 km radius. That flags check-ins from town, home or another city, but
not from a hostel on campus. Replace it building by building (the Rooms page marks which still use
it); buildings you set yourself are never overwritten.


## Directions to buildings

Room cards, **My bookings** and the door page have a **Directions** link: Google Maps walking directions
from wherever the person is (the Maps app on phones; no API key needed). For a building with its own
location (`/admin` → Rooms → Edit building) the directions go to that exact point; for a building still
on the campus-wide area, Google Maps is asked for "<building name>, University of Cape Coast".

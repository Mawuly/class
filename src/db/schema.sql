-- Lecture Room Booking System: PostgreSQL schema (Supabase in production).
-- Idempotent: safe to run again with `npm run db:migrate`.

CREATE SCHEMA IF NOT EXISTS extensions;
-- btree_gist lets an exclusion constraint combine "same room" (=) with "time ranges overlap" (&&).
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS users (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text        NOT NULL,
  email         text        NOT NULL,
  password_hash text        NOT NULL,
  role          text        NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'lecturer', 'admin')),
  department    text,
  index_number  text,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));

-- Password reset (schema version 3).
--   must_change_password      set by an admin reset: the person must choose a new password first
--   temp_password_expires_at  a temporary password stops working after this
--   session_version           part of every login token; bumping it signs the account out everywhere
--   password_changed_at       last change or reset, so an old "forgot password" note can be cleared
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password     boolean     NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS temp_password_expires_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version          integer     NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at      timestamptz;

-- Calendar subscription (schema version 5). Calendar apps fetch the feed without a login, so its
-- address carries a secret token. Only the token's SHA-256 is stored, like a password.
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_token_hash       text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_token_created_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS users_calendar_token_key ON users (calendar_token_hash) WHERE calendar_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS buildings (
  id   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  building_id integer NOT NULL REFERENCES buildings(id),
  code        text    NOT NULL UNIQUE,
  name        text    NOT NULL,
  type        text    NOT NULL CHECK (type IN ('lecture_hall', 'lab', 'seminar', 'study', 'meeting')),
  capacity    integer NOT NULL CHECK (capacity > 0),
  floor       integer NOT NULL DEFAULT 0,
  facilities  jsonb   NOT NULL DEFAULT '[]',
  bookable_by text    NOT NULL DEFAULT 'all' CHECK (bookable_by IN ('staff', 'all')),
  is_active   boolean NOT NULL DEFAULT true
);

-- One row per weekly recurring booking; each occurrence lives in bookings with this series_id.
CREATE TABLE IF NOT EXISTS booking_series (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    integer     NOT NULL REFERENCES users(id),
  room_id    integer     NOT NULL REFERENCES rooms(id),
  weekday    smallint    NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time time        NOT NULL,
  end_time   time        NOT NULL,
  first_date date        NOT NULL,
  last_date  date        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bookings (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id         integer     NOT NULL REFERENCES rooms(id),
  user_id         integer     NOT NULL REFERENCES users(id),
  title           text        NOT NULL,
  category        text        NOT NULL CHECK (category IN ('lecture', 'tutorial', 'lab', 'exam', 'meeting', 'study', 'event')),
  course_code     text,
  date            date        NOT NULL,
  start_time      time        NOT NULL,
  end_time        time        NOT NULL,
  attendees       integer     NOT NULL CHECK (attendees > 0),
  notes           text,
  status          text        NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'released')),
  series_id       integer     REFERENCES booking_series(id),
  decided_by      integer     REFERENCES users(id),
  decision_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (start_time < end_time),

  -- The last line of defence against double booking: even two requests arriving in the same
  -- millisecond cannot both hold overlapping time in one room. Ranges are [start, end), so
  -- 08:00–10:00 and 10:00–12:00 do not overlap. Rejected and cancelled bookings free the slot.
  CONSTRAINT bookings_no_room_overlap EXCLUDE USING gist (
    room_id WITH =,
    tsrange(date + start_time, date + end_time) WITH &&
  ) WHERE (status IN ('pending', 'approved')),

  -- Nobody can be in two rooms at once.
  CONSTRAINT bookings_no_user_overlap EXCLUDE USING gist (
    user_id WITH =,
    tsrange(date + start_time, date + end_time) WITH &&
  ) WHERE (status IN ('pending', 'approved'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_room_date ON bookings (room_id, date);
CREATE INDEX IF NOT EXISTS idx_bookings_user_date ON bookings (user_id, date);
CREATE INDEX IF NOT EXISTS idx_bookings_status    ON bookings (status);
CREATE INDEX IF NOT EXISTS idx_bookings_series    ON bookings (series_id);

CREATE TABLE IF NOT EXISTS notifications (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    integer     NOT NULL REFERENCES users(id),
  message    text        NOT NULL,
  is_read    boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, is_read);

CREATE TABLE IF NOT EXISTS audit_log (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    integer REFERENCES users(id),
  action     text        NOT NULL,
  entity     text,
  entity_id  integer,
  details    jsonb,
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action, created_at);

-- The audit log is append-only (schema version 4): any attempt to change or remove an entry is
-- refused by the database itself, whichever program asks. The app never updates or deletes it.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'The audit log cannot be changed or deleted (entry %)', OLD.id
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;
DROP TRIGGER IF EXISTS audit_log_no_changes ON audit_log;
CREATE TRIGGER audit_log_no_changes BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- Requests for lecturer or admin access, made at sign-up with an offer or appointment letter.
-- The letter itself is deleted when an admin decides; its SHA-256 fingerprint is kept as a record
-- of exactly which file was checked, without keeping the personal data it contains.
CREATE TABLE IF NOT EXISTS access_requests (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         integer     NOT NULL REFERENCES users(id),
  role            text        NOT NULL CHECK (role IN ('lecturer', 'admin')),
  staff_id        text        NOT NULL,
  position        text        NOT NULL,
  department      text,
  note            text,
  document        bytea,
  document_name   text        NOT NULL,
  document_type   text        NOT NULL CHECK (document_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  document_size   integer     NOT NULL CHECK (document_size > 0),
  document_sha256 text        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by      integer     REFERENCES users(id),
  decision_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz
);
-- One open request per person at a time.
CREATE UNIQUE INDEX IF NOT EXISTS access_requests_one_pending ON access_requests (user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests (status, created_at);

-- Password reset by emailed code (schema version 6). The code is stored only as a keyed hash.
-- Only the newest unused code for a person works; five wrong tries use it up.
CREATE TABLE IF NOT EXISTS password_resets (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    integer     NOT NULL REFERENCES users(id),
  code_hash  text        NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts   integer     NOT NULL DEFAULT 0,
  used_at    timestamptz,
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets (user_id, created_at);

-- Phone numbers for reset codes by text message (schema version 7). A number only receives reset
-- codes once its owner has typed in a code sent to it, so a mistyped number can't receive them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone             text;      -- 233XXXXXXXXX
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;
ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS channel text;      -- 'sms' or 'email'
CREATE TABLE IF NOT EXISTS phone_verifications (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    integer     NOT NULL REFERENCES users(id),
  phone      text        NOT NULL,
  code_hash  text        NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts   integer     NOT NULL DEFAULT 0,
  used_at    timestamptz,
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_phone_verifications_user ON phone_verifications (user_id, created_at);

-- Check-in and door codes (schema version 8).
-- Every room has a short code printed on its door, with a QR code that opens /door?c=CODE.
-- Typing or scanning it proves you are at the room. An approved booking nobody checks in to
-- within the grace period is "released": the slot frees up for someone else.
CREATE OR REPLACE FUNCTION new_door_code() RETURNS text LANGUAGE sql VOLATILE AS $$
  -- 31 letters and digits that can't be mistaken for each other (no I, L, O, 0, 1).
  SELECT string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + get_byte(uuid_send(gen_random_uuid()), 0) % 31, 1), '')
  FROM generate_series(1, 6)
$$;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS door_code text;
UPDATE rooms SET door_code = new_door_code() WHERE door_code IS NULL;
ALTER TABLE rooms ALTER COLUMN door_code SET DEFAULT new_door_code();
ALTER TABLE rooms ALTER COLUMN door_code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rooms_door_code_key ON rooms (door_code);

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS released_at   timestamptz;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'released'));
CREATE INDEX IF NOT EXISTS idx_bookings_date_status ON bookings (date, status);

-- Temporary closures (schema version 9). The timetable office closes a room for a time range on
-- a date (maintenance, exams, events). The room stays active and is bookable again afterwards.
-- Closures can't overlap each other (exclusion constraint), and the triggers below stop a
-- closure and a pending/approved booking from overlapping, whichever is written first.
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

-- Bookings and closures live in two tables, so no single constraint covers both. Each write
-- first takes a lock on its room (held until the transaction ends), so a booking and a closure
-- written at the same moment are checked one after the other, never side by side.
CREATE OR REPLACE FUNCTION lock_room_for_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(72710002, NEW.room_id);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION bookings_reject_room_blocks_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('pending', 'approved') AND EXISTS (
    SELECT 1 FROM room_blocks rb
    WHERE rb.room_id = NEW.room_id AND rb.date = NEW.date
      AND rb.start_time < NEW.end_time AND rb.end_time > NEW.start_time
  ) THEN
    RAISE EXCEPTION 'The room is unavailable at that time'
      USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'bookings_reject_room_blocks';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION room_blocks_reject_bookings_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.room_id = NEW.room_id AND b.date = NEW.date AND b.status IN ('pending', 'approved')
      AND b.start_time < NEW.end_time AND b.end_time > NEW.start_time
  ) THEN
    RAISE EXCEPTION 'The room has a booking at that time'
      USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'room_blocks_reject_bookings';
  END IF;
  RETURN NEW;
END $$;

-- Trigger names sort alphabetically within a table: the lock ("..._lock_room") must run before
-- the check ("..._reject_..."), and "l" comes before "r".
DROP TRIGGER IF EXISTS bookings_lock_room ON bookings;
CREATE TRIGGER bookings_lock_room BEFORE INSERT OR UPDATE OF room_id, date, start_time, end_time, status ON bookings
  FOR EACH ROW EXECUTE FUNCTION lock_room_for_schedule();
DROP TRIGGER IF EXISTS bookings_reject_room_blocks ON bookings;
CREATE TRIGGER bookings_reject_room_blocks BEFORE INSERT OR UPDATE OF room_id, date, start_time, end_time, status ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_reject_room_blocks_fn();
DROP TRIGGER IF EXISTS room_blocks_lock_room ON room_blocks;
CREATE TRIGGER room_blocks_lock_room BEFORE INSERT OR UPDATE ON room_blocks
  FOR EACH ROW EXECUTE FUNCTION lock_room_for_schedule();
DROP TRIGGER IF EXISTS room_blocks_reject_bookings ON room_blocks;
CREATE TRIGGER room_blocks_reject_bookings BEFORE INSERT OR UPDATE ON room_blocks
  FOR EACH ROW EXECUTE FUNCTION room_blocks_reject_bookings_fn();

-- Course code and/or supervisor on a request (schema version 11), and check-out (schema
-- version 12): leaving early moves end_time to the minute you left, so the rest is free again.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS supervisor     text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_out_at timestamptz;

-- Which version of this file the database has been brought up to (see db/setup.js).
CREATE TABLE IF NOT EXISTS app_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);
-- The day check-in started, so statistics don't count older bookings as missed check-ins.
INSERT INTO app_meta (key, value) VALUES ('checkin_since', to_char(current_date, 'YYYY-MM-DD')) ON CONFLICT (key) DO NOTHING;
-- The booking window (schema version 10), edited on /admin -> Settings. Applies to every room.
INSERT INTO app_meta (key, value) VALUES ('booking_open', '06:30'), ('booking_close', '20:30'), ('booking_max_hours', '4')
  ON CONFLICT (key) DO NOTHING;

-- Supabase publishes every table in the public schema through its REST API using the public
-- "anon" key. Row Level Security with no policies closes that door: only this server, which
-- connects as the table owner, can read or write the data.
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE buildings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms          ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log      ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_meta       ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE phone_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_blocks    ENABLE ROW LEVEL SECURITY;

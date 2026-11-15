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
  status          text        NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
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

-- Which version of this file the database has been brought up to (see db/setup.js).
CREATE TABLE IF NOT EXISTS app_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);

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

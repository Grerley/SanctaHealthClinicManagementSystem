-- 0011_ops.sql — staff/credentials and operational tasks (OPS-001/003). Staff live
-- in the organisation schema; tasks in the flow schema. An expired credential can
-- block configured clinical actions; overdue tasks surface on role dashboards.

BEGIN;

CREATE TABLE organisation.staff (
  id                uuid PRIMARY KEY,
  full_name         text NOT NULL,
  role              text NOT NULL,
  registration_no   text,
  credential_expiry date,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE flow.task (
  id          uuid PRIMARY KEY,
  subject     text NOT NULL,
  owner       uuid,
  priority    integer NOT NULL DEFAULT 100,
  due_date    date,
  status      text NOT NULL DEFAULT 'open',   -- open | done | cancelled
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);
CREATE INDEX task_open_due_idx ON flow.task (status, due_date);

COMMIT;

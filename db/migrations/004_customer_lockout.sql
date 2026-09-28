-- 004_customer_lockout.sql
--
-- Customer accounts get the same per-account lockout as admin accounts: five
-- failures lock the account for a growing interval, whatever addresses the
-- attempts come from. Additive only, so the previous release keeps working.

BEGIN;

ALTER TABLE customers ADD COLUMN failed_logins INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN locked_until  TIMESTAMPTZ;

COMMIT;

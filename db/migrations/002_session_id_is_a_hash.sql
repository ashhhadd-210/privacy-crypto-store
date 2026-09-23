-- 002_session_id_is_a_hash.sql
--
-- Corrects a comment, not a structure.
--
-- 001 described admin_sessions.id as "opaque random id, also the cookie value".
-- The application stores the SHA-256 of the cookie value instead, and keeps the
-- cookie value nowhere. The reason is worth recording where the next
-- maintainer will read it: if the database is ever copied, raw session ids
-- would let whoever holds the copy replay them and walk into the admin panel
-- as the owner. A hash cannot be replayed, and the lookup is still one indexed
-- primary-key hit.
--
-- The same reasoning will apply to customer_sessions when optional accounts
-- land in week 2.

BEGIN;

COMMENT ON COLUMN admin_sessions.id IS
    'SHA-256 (hex) of the session cookie value. The cookie value itself is never stored.';

COMMENT ON COLUMN admin_sessions.ip_hash IS
    'HMAC-SHA256 of the client IP, keyed with SESSION_SECRET. Lets us see that a session moved without holding an address that identifies a person.';

COMMENT ON COLUMN customer_sessions.id IS
    'SHA-256 (hex) of the session cookie value, same rule as admin_sessions.id.';

COMMIT;

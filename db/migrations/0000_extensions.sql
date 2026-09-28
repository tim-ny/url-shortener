-- Extensions required by later migrations. Kept as its own migration ahead of the
-- schema so a table migration never depends on an extension created inside the
-- same file, and so this is obviously re-runnable on a fresh database.
--
-- citext backs users.email, which makes email uniqueness case-insensitive in the
-- database rather than relying on application code to lowercase before insert.
--
-- pgcrypto is deliberately absent: gen_random_uuid() is part of core Postgres
-- from 13 onward, and this project targets 17.
CREATE EXTENSION IF NOT EXISTS citext;

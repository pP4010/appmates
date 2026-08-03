-- A real profile, not just a display name: a short bio and an avatar
-- (linked, not uploaded — no object storage exists in this deployment yet)
-- so the person on the other end of a test request or a chat is a person,
-- not just an email address.
--
-- Plain ADD COLUMN, same as 0008: new nullable columns, no constraint change.

ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN avatar_url TEXT;

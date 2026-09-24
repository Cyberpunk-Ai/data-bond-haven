-- Signed-out visitors may only read public data; all writes require sign-in.
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from anon;
alter default privileges in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon;
drop table if exists public._probe;

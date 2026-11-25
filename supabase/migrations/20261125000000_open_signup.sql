-- Open sign-up: anyone can create an account and start projects straight away.
-- Projects run on each person's own ElevenLabs and Claude keys (see 20261122000000_user_keys.sql), so letting
-- people in no longer spends the owner's credits.
--
-- `profiles.approved` stays, but now means "not blocked": it starts true for everyone. To block someone, set it
-- to false in the dashboard (Table Editor -> profiles); they can still sign in but can't create projects.

alter table public.profiles alter column approved set default true;
update public.profiles set approved = true where not approved;

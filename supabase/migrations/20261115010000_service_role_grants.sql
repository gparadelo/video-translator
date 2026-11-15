-- The worker reads profiles (each person's voice) directly with the secret key. The first migration
-- assumed Supabase grants the service role access to new tables by default; this project doesn't, so the
-- read was refused (403). Grant it explicitly. People's access is unchanged.

grant select, insert, update, delete
  on public.profiles, public.jobs, public.job_outputs, public.usage_events, public.workers
  to service_role;
grant usage, select on all sequences in schema public to service_role;

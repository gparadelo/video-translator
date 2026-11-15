-- Video Translator web app: jobs, their outputs, API usage, and the render workers.
--
-- Who can do what:
--   * People (role `authenticated`) read their own rows, create jobs, and move them forward only through
--     the functions below (submit_job, approve_job, retry_job, cancel_job). They never update rows directly.
--   * The worker (on the Mac) uses the service-role key, which bypasses row-level security, and the
--     worker_* functions, which only the service role may call.
--
-- Job status flow:
--   uploading -> queued -> preparing -> needs_review -> approved -> producing -> done
--   (any of these -> failed / canceled)

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ profiles (one per person)

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text,
  approved    boolean not null default false,         -- only approved people can create jobs (spend credits):
                                                      -- set it by hand in the dashboard for each person you let in
  voice_id    text,                                   -- ElevenLabs voice; null = the worker's default
  voice_ids   jsonb not null default '{}'::jsonb,     -- per language, e.g. {"de": "..."}
  languages   text[] not null default '{en,es,de,fr,it,nl}',
  created_at  timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

insert into public.profiles (id) select id from auth.users on conflict do nothing;  -- people who signed up before

-- ------------------------------------------------------------------ jobs

create table public.jobs (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name            text not null check (length(name) between 1 and 120),
  status          text not null default 'uploading' check (status in
                    ('uploading', 'queued', 'preparing', 'needs_review', 'approved', 'producing',
                     'done', 'failed', 'canceled')),
  source_key      text generated always as ('u/' || user_id || '/' || id || '/source') stored,  -- in R2
  source_filename text,
  source_bytes    bigint check (source_bytes between 1 and 5000000000),  -- one presigned PUT: 5 GB max
  languages       text[] not null default '{}',
  base_lang       text,                 -- detected (or set) language of the original voiceover
  reference       text,                 -- optional written script: spelling of names
  script          text,                 -- transcript after prepare; the person may edit it in review
  names_fixed     text[] not null default '{}',
  warnings        text[] not null default '{}',
  progress        jsonb,                -- last progress event from the worker {stage, lang, done, total, msg}
  error           text,
  worker_id       text,
  lease_until     timestamptz,          -- a running job whose lease runs out goes back to the queue
  attempts        int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  finished_at     timestamptz
);

create index jobs_user_idx on public.jobs (user_id, created_at desc);
create index jobs_queue_idx on public.jobs (status, created_at) where status in ('queued', 'approved');

create function public.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger jobs_touch before update on public.jobs
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------------ outputs (one per job and language)

create table public.job_outputs (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.jobs (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  lang          text not null,
  status        text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed')),
  seconds       numeric,
  flags         text[] not null default '{}',   -- what still doesn't fit (from the report)
  report        text,                           -- report.md
  output_key    text,                           -- R2 object key of the rendered video (4K HEVC, to download)
  output_bytes  bigint,
  preview_key   text,                           -- R2 object key of a small H.264 copy (plays in any browser)
  updated_at    timestamptz not null default now(),
  unique (job_id, lang)
);

create trigger job_outputs_touch before update on public.job_outputs
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------------ API usage (what each job cost)

create table public.usage_events (
  id          bigint generated always as identity primary key,
  job_id      uuid not null references public.jobs (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  service     text not null,      -- claude, elevenlabs_tts, elevenlabs_stt, elevenlabs_alignment
  amounts     jsonb not null,     -- e.g. {"input_tokens": 1510, "output_tokens": 2026} or {"characters": 812}
  created_at  timestamptz not null default now()
);

create index usage_job_idx on public.usage_events (job_id);

-- ------------------------------------------------------------------ workers (so the app can say "online")

create table public.workers (
  id           text primary key,
  last_seen    timestamptz not null default now(),
  version      text,
  current_job  uuid references public.jobs (id) on delete set null
);

-- ------------------------------------------------------------------ row-level security

alter table public.profiles     enable row level security;
alter table public.jobs         enable row level security;
alter table public.job_outputs  enable row level security;
alter table public.usage_events enable row level security;
alter table public.workers      enable row level security;

create policy "own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "own jobs" on public.jobs for select to authenticated using (user_id = auth.uid());
create policy "new job" on public.jobs for insert to authenticated
  with check (user_id = auth.uid() and status = 'uploading' and worker_id is null and attempts = 0
              and exists (select 1 from public.profiles p where p.id = auth.uid() and p.approved));
create policy "own outputs" on public.job_outputs for select to authenticated using (user_id = auth.uid());
create policy "own usage" on public.usage_events for select to authenticated using (user_id = auth.uid());
create policy "see workers" on public.workers for select to authenticated using (true);

-- People get only what the policies allow; columns a person may set when creating a job:
revoke all on public.profiles, public.jobs, public.job_outputs, public.usage_events, public.workers
  from anon, authenticated;
grant select on public.profiles, public.jobs, public.job_outputs, public.usage_events, public.workers
  to authenticated;
grant insert (name, source_filename, source_bytes, languages, reference) on public.jobs to authenticated;

-- ------------------------------------------------------------------ what people can do with a job

-- After the browser finished uploading the video.
create function public.submit_job(p_job uuid) returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare j public.jobs;
begin
  update public.jobs set status = 'queued'
   where id = p_job and user_id = auth.uid() and status = 'uploading'
  returning * into j;
  if j.id is null then raise exception 'job not found or not waiting for its upload'; end if;
  return j;
end $$;

-- After checking (and maybe editing) the transcript. Null arguments keep what's there.
create function public.approve_job(p_job uuid, p_script text default null, p_languages text[] default null)
returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare j public.jobs;
begin
  update public.jobs
     set status = 'approved',
         script = coalesce(p_script, script),
         languages = coalesce(p_languages, languages),
         attempts = 0
   where id = p_job and user_id = auth.uid() and status in ('needs_review', 'done', 'failed')
     and script is not null and base_lang is not null
     and coalesce(cardinality(coalesce(p_languages, languages)), 0) > 0
  returning * into j;
  if j.id is null then raise exception 'job not found, not ready for review, or no languages chosen'; end if;
  return j;
end $$;

-- Try a failed job again: from the start if it never got a transcript, otherwise from the translation.
create function public.retry_job(p_job uuid) returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare j public.jobs;
begin
  update public.jobs
     set status = case when script is null then 'queued' else 'approved' end,
         attempts = 0, error = null, finished_at = null
   where id = p_job and user_id = auth.uid() and status = 'failed'
  returning * into j;
  if j.id is null then raise exception 'job not found or it did not fail'; end if;
  return j;
end $$;

create function public.cancel_job(p_job uuid) returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare j public.jobs;
begin
  update public.jobs set status = 'canceled', finished_at = now()
   where id = p_job and user_id = auth.uid() and status not in ('done', 'canceled')
  returning * into j;
  if j.id is null then raise exception 'job not found or already finished'; end if;
  return j;
end $$;

-- ------------------------------------------------------------------ what the worker does

-- Take the next piece of work: a queued job (-> preparing) or an approved one (-> producing).
-- Jobs whose worker vanished (lease ran out) go back to the queue first; after 3 tries they fail.
-- SKIP LOCKED lets several workers ask at once without taking the same job.
create function public.worker_claim(p_worker text, p_lease_seconds int default 120, p_version text default null)
returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare j public.jobs;
begin
  update public.jobs
     set status = case when attempts >= 3 then 'failed'
                       when status = 'preparing' then 'queued' else 'approved' end,
         error = case when attempts >= 3 then 'the worker stopped 3 times while working on this job' end,
         finished_at = case when attempts >= 3 then now() end,
         worker_id = null, lease_until = null
   where status in ('preparing', 'producing') and lease_until < now();

  update public.jobs t
     set status = case when t.status = 'queued' then 'preparing' else 'producing' end,
         worker_id = p_worker,
         lease_until = now() + make_interval(secs => p_lease_seconds),
         attempts = t.attempts + 1,
         error = null
   where t.id = (select id from public.jobs
                  where status in ('queued', 'approved')
                  order by created_at
                  limit 1
                  for update skip locked)
  returning t.* into j;

  insert into public.workers (id, last_seen, current_job, version) values (p_worker, now(), j.id, p_version)
    on conflict (id) do update set last_seen = now(), current_job = j.id,
                                   version = coalesce(p_version, public.workers.version);
  return j;  -- all fields null when there is nothing to do
end $$;

-- Every ~30 s: "I'm alive", and (while working) keep the lease. Returns false when the job was
-- canceled or taken away, so the worker should stop working on it.
create function public.worker_heartbeat(p_worker text, p_job uuid default null, p_progress jsonb default null,
                                        p_lease_seconds int default 120, p_version text default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare ok boolean := true;
begin
  if p_job is not null then
    update public.jobs
       set lease_until = now() + make_interval(secs => p_lease_seconds),
           progress = coalesce(p_progress, progress)
     where id = p_job and worker_id = p_worker and status in ('preparing', 'producing');
    ok := found;
  end if;
  insert into public.workers (id, last_seen, current_job, version)
  values (p_worker, now(), case when ok then p_job end, p_version)
    on conflict (id) do update set last_seen = now(), current_job = excluded.current_job,
                                   version = coalesce(p_version, public.workers.version);
  return ok;
end $$;

-- prepare finished: hand the transcript to the person for review.
create function public.worker_prepared(p_worker text, p_job uuid, p_base_lang text, p_script text,
                                       p_names_fixed text[], p_warnings text[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.jobs
     set status = 'needs_review', base_lang = p_base_lang, script = p_script,
         names_fixed = coalesce(p_names_fixed, '{}'), warnings = coalesce(p_warnings, '{}'),
         worker_id = null, lease_until = null, attempts = 0, progress = null
   where id = p_job and worker_id = p_worker and status = 'preparing';
  if not found then raise exception 'job % is not being prepared by %', p_job, p_worker; end if;
end $$;

-- One language finished (or failed).
create function public.worker_output(p_worker text, p_job uuid, p_lang text, p_status text,
                                     p_seconds numeric default null, p_flags text[] default '{}',
                                     p_report text default null, p_output_key text default null,
                                     p_output_bytes bigint default null, p_preview_key text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  select user_id into uid from public.jobs where id = p_job and worker_id = p_worker and status = 'producing';
  if uid is null then raise exception 'job % is not being produced by %', p_job, p_worker; end if;
  insert into public.job_outputs (job_id, user_id, lang, status, seconds, flags, report, output_key, output_bytes,
                                  preview_key)
  values (p_job, uid, p_lang, p_status, p_seconds, coalesce(p_flags, '{}'), p_report, p_output_key, p_output_bytes,
          p_preview_key)
  on conflict (job_id, lang) do update
    set status = excluded.status, seconds = excluded.seconds, flags = excluded.flags,
        report = excluded.report, output_key = excluded.output_key, output_bytes = excluded.output_bytes,
        preview_key = excluded.preview_key;
end $$;

-- The whole job finished (p_error null) or failed (p_error = what to tell the person).
create function public.worker_finish(p_worker text, p_job uuid, p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.jobs
     set status = case when p_error is null then 'done' else 'failed' end,
         error = p_error, worker_id = null, lease_until = null, progress = null,
         finished_at = now()
   where id = p_job and worker_id = p_worker and status in ('preparing', 'producing');
  update public.workers set current_job = null where id = p_worker;
end $$;

create function public.worker_usage(p_job uuid, p_service text, p_amounts jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.usage_events (job_id, user_id, service, amounts)
  select id, user_id, p_service, p_amounts from public.jobs where id = p_job;
$$;

-- Functions are callable by everyone unless revoked: people get only their four.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.submit_job(uuid), public.approve_job(uuid, text, text[]),
  public.retry_job(uuid), public.cancel_job(uuid) to authenticated;
grant execute on all functions in schema public to service_role;

-- Live updates in the browser (Supabase Realtime respects the policies above).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.jobs, public.job_outputs, public.workers;
  end if;
end $$;

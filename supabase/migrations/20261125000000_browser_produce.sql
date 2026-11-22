-- The web app translates and voices each language itself (phase 3 of moving the whole pipeline into the browser).
--
-- After a person approves the transcript, the job page does everything for each language with the person's own
-- keys, through short routes of the web app (app/api/jobs/<id>/produce/<lang>/...): Claude translates, Claude
-- rewrites the beats that don't fit, ElevenLabs voices every beat, and the route writes the plan inputs
-- (inputs.json and tts/, exactly as the phase 2 worker did); then the browser builds the plan and the voice track
-- and renders, as before. No worker is involved, and the web app still has no service-role key: everything
-- below that a person calls only ever touches their own rows.
--
-- The worker (version 4) now only analyzes: it transcribes and times the voiceover (prepare), and times it again
-- after the person edited the transcript (align). It uploads the result as u/<user>/<job>/analysis.json, which
-- the translation routes read. A worker older than version 4 gets no work from worker_claim below.
--
-- jobs.status:
--   uploading -> queued -> preparing (worker) -> needs_review
--   needs_review -> approve_job:
--       transcript as the worker last timed it            -> producing (the job page does the rest)
--       edited, or timed by an older worker (no analysis) -> approved -> aligning (worker) -> producing
--                                                            (back to needs_review if the edits broke the timing)
--   producing -> done (every language voiced, or some failed) / failed (every language failed): set here, when
--   the last language of the job settles
--   any of these -> canceled; queued/preparing/approved/aligning -> failed when the worker fails
--
-- job_outputs.status (per language), for a job that is producing:
--   pending  -> approve_job asked for this language; the job page starts a run (start_run)
--   running  -> a run is going on: generation counts the runs, and every file of a run is under g<generation>/
--   voiced   -> inputs_key is set (mark_voiced): the browser builds the plan and the voice (save_plan)
--   ready    -> as in phase 2
--   failed   -> flags[1] says why (fail_run)
--
-- jobs.voices: a job's languages get their voices pinned when the first run of the job starts (start_run), with
-- the voice Settings give each then; a pin never changes, so a retry or a new translation speaks with the same
-- voice.

-- ------------------------------------------------------------------ columns

alter table public.jobs drop constraint jobs_status_check;
alter table public.jobs add constraint jobs_status_check check (status in
  ('uploading', 'queued', 'preparing', 'needs_review', 'approved', 'aligning', 'producing', 'done', 'failed',
   'canceled'));

alter table public.jobs
  add column analysis_key    text,  -- R2 key of analysis.json (written by a version 4 worker), null until then
  add column analysis_script text;  -- the transcript analysis.json was made from: approve_job compares it

-- ------------------------------------------------------------------ jobs that were waiting for an older worker

-- Approved or producing jobs were waiting for the old worker to translate them: they now go through a version 4
-- worker first (it writes analysis.json), then the job page takes over. Languages the old worker hadn't voiced
-- start from the beginning; voiced ones keep their recorded voice.
update public.jobs set status = 'approved', worker_id = null, lease_until = null, progress = null, attempts = 0
 where status in ('approved', 'producing');
update public.job_outputs o set status = 'pending', seconds = null, flags = '{}', report = null, output_key = null,
       output_bytes = null, preview_key = null, preview_bytes = null, plan_key = null, voice_key = null,
       inputs_key = null
  from public.jobs j
 where j.id = o.job_id and j.status = 'approved' and o.lang = any (j.languages)
   and o.status in ('pending', 'running', 'failed');
insert into public.job_outputs (job_id, user_id, lang, status)
select j.id, j.user_id, l, 'pending' from public.jobs j, unnest(j.languages) l
 where j.status = 'approved' and l is distinct from j.base_lang
on conflict (job_id, lang) do nothing;

-- ------------------------------------------------------------------ helpers (not callable by people)

-- Every language asked for gets a 'pending' row (a new one, or the old one emptied): the job page starts a run for
-- each. Their files stay in R2 under their old run folders until storage removes them.
create function public.request_languages(p_job uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.job_outputs (job_id, user_id, lang, status)
  select j.id, j.user_id, l, 'pending'
    from public.jobs j, unnest(j.languages) l
   where j.id = p_job and l is distinct from j.base_lang
  on conflict (job_id, lang) do update
    set status = 'pending', seconds = null, flags = '{}', report = null, output_key = null, output_bytes = null,
        preview_key = null, preview_bytes = null, plan_key = null, voice_key = null, inputs_key = null;
end $$;

-- A producing job whose languages have all settled is finished: done when any was voiced, failed when all failed.
create function public.settle_job(p_job uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare j public.jobs; open_count int; good_count int; first_error text;
begin
  select * into j from public.jobs where id = p_job for update;
  if j.id is null or j.status <> 'producing' then return; end if;
  select count(*) filter (where o.status in ('pending', 'running')),
         count(*) filter (where o.status in ('voiced', 'ready', 'done')),
         min(o.lang || ': ' || coalesce(o.flags[1], 'failed')) filter (where o.status = 'failed')
    into open_count, good_count, first_error
    from public.job_outputs o
   where o.job_id = p_job and o.lang = any (j.languages) and o.lang is distinct from j.base_lang;
  if open_count > 0 then return; end if;
  update public.jobs
     set status = case when good_count > 0 then 'done' else 'failed' end,
         error = case when good_count > 0 then null else coalesce(first_error, 'no language could be made') end,
         progress = null, finished_at = now()
   where id = p_job;
end $$;

-- A worker of version 4 or later (the version it reports, e.g. '4').
create function public.worker_version_ok(p_version text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(nullif(regexp_replace(coalesce(p_version, ''), '\D.*$', ''), '')::int, 0) >= 4;
$$;

-- ------------------------------------------------------------------ what people do with a job

-- After checking (and maybe editing) the transcript, or to add or retry languages later. Null arguments keep
-- what's there. When the transcript is the one the worker last timed, the job page starts translating straight
-- away; otherwise the worker times it first.
create or replace function public.approve_job(p_job uuid, p_script text default null, p_languages text[] default null)
returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare j public.jobs; missing text := public.missing_setup(auth.uid());
begin
  if missing is not null then raise exception '%', missing; end if;
  update public.jobs
     set script = coalesce(p_script, script),
         languages = coalesce(p_languages, languages),
         status = case when analysis_key is not null and coalesce(p_script, script) = analysis_script
                       then 'producing' else 'approved' end,
         attempts = 0, error = null, finished_at = null, progress = null
   where id = p_job and user_id = auth.uid() and status in ('needs_review', 'done', 'failed')
     and script is not null and base_lang is not null
     and coalesce(cardinality(coalesce(p_languages, languages)), 0) > 0
  returning * into j;
  if j.id is null then raise exception 'job not found, not ready for review, or no languages chosen'; end if;
  perform public.request_languages(j.id);
  return j;
end $$;

-- Try a failed job again: from the start if it never got a transcript, otherwise from the translation.
create or replace function public.retry_job(p_job uuid) returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare j public.jobs; missing text := public.missing_setup(auth.uid());
begin
  if missing is not null then raise exception '%', missing; end if;
  update public.jobs
     set status = case when script is null then 'queued'
                       when analysis_key is not null and script = analysis_script then 'producing'
                       else 'approved' end,
         attempts = 0, error = null, finished_at = null, progress = null
   where id = p_job and user_id = auth.uid() and status = 'failed'
  returning * into j;
  if j.id is null then raise exception 'job not found or it did not fail'; end if;
  if j.status <> 'queued' then perform public.request_languages(j.id); end if;
  return j;
end $$;

-- The job page starts a run of a language that is waiting (pending) or failed: a new generation, every file
-- column cleared. Returns the run number (generation). Pins the voices of all the job's languages that aren't
-- pinned yet (never changing a pin), so this run, and every later one, uses the pinned voice.
create function public.start_run(p_job uuid, p_lang text) returns int
language plpgsql security definer set search_path = '' as $$
declare
  j public.jobs;
  missing text := public.missing_setup(auth.uid());
  current_voices jsonb;
  gen int;
begin
  if missing is not null then raise exception '%', missing; end if;
  select * into j from public.jobs where id = p_job and user_id = auth.uid() for update;
  if j.id is null then raise exception 'project not found'; end if;
  if j.status <> 'producing' then raise exception 'this project isn''t being translated right now'; end if;
  if not (p_lang = any (j.languages)) or p_lang = j.base_lang then
    raise exception 'this project isn''t being translated into %', p_lang;
  end if;

  select coalesce(jsonb_object_agg(l, coalesce(p.voice_ids ->> l, p.voice_id)), '{}'::jsonb)
    into current_voices
    from public.profiles p, unnest(j.languages) l
   where p.id = j.user_id and coalesce(p.voice_ids ->> l, p.voice_id) is not null;
  update public.jobs set voices = current_voices || voices where id = p_job returning * into j;
  if not (j.voices ? p_lang) then raise exception 'choose your ElevenLabs voice in Settings first'; end if;

  update public.job_outputs
     set status = 'running', generation = generation + 1, seconds = null, flags = '{}', report = null,
         output_key = null, output_bytes = null, preview_key = null, preview_bytes = null, plan_key = null,
         voice_key = null, inputs_key = null
   where job_id = p_job and lang = p_lang and status in ('pending', 'failed')
  returning generation into gen;
  if gen is null then raise exception 'this language is already being made, or is done'; end if;
  return gen;
end $$;

-- The produce route (POST /api/jobs/<id>/produce/<lang>/fit) wrote the run's plan inputs, inputs.json last: the
-- language is voiced. The key is made here from the row, for the run the row is at.
create function public.mark_voiced(p_job uuid, p_lang text, p_generation int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.job_outputs o
     set status = 'voiced',
         inputs_key = 'u/' || o.user_id || '/' || o.job_id || '/out/' || o.lang || '/g' || o.generation || '/inputs.json'
    from public.jobs j
   where o.job_id = p_job and o.lang = p_lang and o.user_id = auth.uid() and o.status = 'running'
     and o.generation = p_generation and j.id = o.job_id and j.status = 'producing';
  if not found then raise exception 'this language changed while it was being voiced'; end if;
  perform public.settle_job(p_job);
end $$;

-- A run stopped with a problem the person has to see (and maybe fix, e.g. a key): the language is failed, with
-- the reason. Try again starts a new run; what the failed one finished (the translation, the recorded beats) is
-- reused.
create function public.fail_run(p_job uuid, p_lang text, p_generation int, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.job_outputs
     set status = 'failed', flags = array[left(coalesce(nullif(trim(p_error), ''), 'something went wrong'), 500)]
   where job_id = p_job and lang = p_lang and user_id = auth.uid() and status = 'running'
     and generation = p_generation;
  if not found then raise exception 'this language changed while it was being voiced'; end if;
  perform public.settle_job(p_job);
end $$;

-- What a job's API calls cost, recorded by the produce routes after each call (as the worker did before).
create function public.log_usage(p_job uuid, p_service text, p_amounts jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_service not in ('claude', 'elevenlabs_tts', 'elevenlabs_stt', 'elevenlabs_alignment') then
    raise exception 'unknown service %', p_service;
  end if;
  if jsonb_typeof(p_amounts) <> 'object' or length(p_amounts::text) > 2000 then
    raise exception 'amounts must be a small object';
  end if;
  insert into public.usage_events (job_id, user_id, service, amounts)
  select id, user_id, p_service, p_amounts from public.jobs where id = p_job and user_id = auth.uid();
  if not found then raise exception 'project not found'; end if;
end $$;

-- ------------------------------------------------------------------ what the worker does (version 4)

-- Take the next piece of work: a queued job (-> preparing: transcribe and time it) or an approved one
-- (-> aligning: time the edited transcript). Producing is the job page's now. A worker older than version 4 would
-- translate approved jobs itself and can't write analysis.json: it gets nothing (it still shows as online).
create or replace function public.worker_claim(p_worker text, p_lease_seconds int default 120, p_version text default null)
returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare j public.jobs;
begin
  insert into public.workers (id, last_seen, current_job, version) values (p_worker, now(), null, p_version)
    on conflict (id) do update set last_seen = now(), current_job = null,
                                   version = coalesce(p_version, public.workers.version);
  if not public.worker_version_ok(p_version) then return j; end if;

  update public.jobs
     set status = case when attempts >= 3 then 'failed'
                       when status = 'preparing' then 'queued' else 'approved' end,
         error = case when attempts >= 3 then 'the worker stopped 3 times while working on this job' end,
         finished_at = case when attempts >= 3 then now() end,
         worker_id = null, lease_until = null
   where status in ('preparing', 'aligning') and lease_until < now();

  update public.jobs t
     set status = case when t.status = 'queued' then 'preparing' else 'aligning' end,
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

  update public.workers set current_job = j.id where id = p_worker;
  return j;  -- all fields null when there is nothing to do
end $$;

create or replace function public.worker_heartbeat(p_worker text, p_job uuid default null, p_progress jsonb default null,
                                                   p_lease_seconds int default 120, p_version text default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare ok boolean := true;
begin
  if p_job is not null then
    update public.jobs
       set lease_until = now() + make_interval(secs => p_lease_seconds),
           progress = coalesce(p_progress, progress)
     where id = p_job and worker_id = p_worker and status in ('preparing', 'aligning');
    ok := found;
  end if;
  insert into public.workers (id, last_seen, current_job, version)
  values (p_worker, now(), case when ok then p_job end, p_version)
    on conflict (id) do update set last_seen = now(), current_job = excluded.current_job,
                                   version = coalesce(p_version, public.workers.version);
  return ok;
end $$;

-- prepare finished: analysis.json is in R2; hand the transcript to the person for review.
create or replace function public.worker_prepared(p_worker text, p_job uuid, p_base_lang text, p_script text,
                                                  p_names_fixed text[], p_warnings text[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.jobs
     set status = 'needs_review', base_lang = p_base_lang, script = p_script, analysis_script = p_script,
         analysis_key = 'u/' || user_id || '/' || id || '/analysis.json',
         names_fixed = coalesce(p_names_fixed, '{}'), warnings = coalesce(p_warnings, '{}'),
         worker_id = null, lease_until = null, attempts = 0, progress = null
   where id = p_job and worker_id = p_worker and status = 'preparing';
  if not found then raise exception 'job % is not being prepared by %', p_job, p_worker; end if;
end $$;

-- align finished: analysis.json is in R2 for the edited transcript (p_script, as the worker split it). p_ok false:
-- the edits made the transcript stop matching the voiceover (p_warnings say how): back to the person's review.
create function public.worker_aligned(p_worker text, p_job uuid, p_script text, p_warnings text[], p_ok boolean)
returns void
language plpgsql security definer set search_path = '' as $$
declare j public.jobs;
begin
  update public.jobs
     set status = case when p_ok then 'producing' else 'needs_review' end,
         script = p_script, analysis_script = p_script,
         analysis_key = 'u/' || user_id || '/' || id || '/analysis.json',
         warnings = coalesce(p_warnings, '{}'),
         worker_id = null, lease_until = null, attempts = 0, progress = null
   where id = p_job and worker_id = p_worker and status = 'aligning'
  returning * into j;
  if j.id is null then raise exception 'job % is not being aligned by %', p_job, p_worker; end if;
  -- every language of the job has a row the job page can start (approve_job made them; this is a safety net)
  insert into public.job_outputs (job_id, user_id, lang, status)
  select j.id, j.user_id, l, 'pending' from unnest(j.languages) l where l is distinct from j.base_lang
  on conflict (job_id, lang) do nothing;
end $$;

-- The worker's part failed (p_error = what to tell the person).
create or replace function public.worker_finish(p_worker text, p_job uuid, p_error text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.jobs
     set status = 'failed', error = coalesce(p_error, 'the worker stopped'), worker_id = null, lease_until = null,
         progress = null, finished_at = now()
   where id = p_job and worker_id = p_worker and status in ('preparing', 'aligning');
  update public.workers set current_job = null where id = p_worker;
end $$;

-- The worker no longer produces: these were only for that.
drop function public.worker_output(text, uuid, text, text, numeric, text[], text, text, bigint, text, text, text, int);
drop function public.worker_pin_voices(text, uuid, jsonb);

-- ------------------------------------------------------------------ who may call what

revoke execute on function public.request_languages(uuid), public.settle_job(uuid), public.worker_version_ok(text),
  public.start_run(uuid, text), public.mark_voiced(uuid, text, int), public.fail_run(uuid, text, int, text),
  public.log_usage(uuid, text, jsonb), public.worker_aligned(text, uuid, text, text[], boolean)
  from public, anon, authenticated;
grant execute on function public.start_run(uuid, text), public.mark_voiced(uuid, text, int),
  public.fail_run(uuid, text, int, text), public.log_usage(uuid, text, jsonb) to authenticated;
grant execute on function public.request_languages(uuid), public.settle_job(uuid), public.worker_version_ok(text),
  public.start_run(uuid, text), public.mark_voiced(uuid, text, int), public.fail_run(uuid, text, int, text),
  public.log_usage(uuid, text, jsonb), public.worker_aligned(text, uuid, text, text[], boolean) to service_role;

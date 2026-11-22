-- The browser prepares each new video itself (phase 4 of moving the whole pipeline into the browser). Nothing needs
-- the worker any more.
--
-- After the upload, the job page measures the video in the person's browser (length, frame rate, cuts, loudness,
-- and the voiceover's sound, lib/prepare/local.ts) and drives short routes of the web app with the person's own keys
-- (app/api/jobs/<id>/prepare/...): ElevenLabs transcribes the voiceover, Claude checks the spelling of names, and
-- ElevenLabs times every word; the route writes analysis.json and hands the transcript to the person. An approved
-- transcript that was edited is timed again the same way. The web app still has no service-role key: everything
-- below that a person calls only ever touches their own rows.
--
-- jobs.status:
--   uploading -> preparing (submit_job; the job page prepares it) -> needs_review
--   needs_review -> approve_job:
--       transcript as it was last timed                   -> producing (the job page makes each language)
--       edited, or timed by an older worker (no analysis) -> aligning (the job page times it again) -> producing
--                                                            (back to needs_review if the edits broke the timing)
--   producing -> done / failed (settle_job, as before)
--   any of these -> canceled; preparing/aligning -> failed when the job page stops with a problem (fail_prepare)
-- 'queued' and 'approved' (waiting for the worker) are gone.
--
-- jobs.runner / runner_until: which browser is preparing (or aligning) the job (hold_prepare), as job_outputs.runner
-- does for a language: the prepare routes answer only that browser, so two devices never pay twice.

-- ------------------------------------------------------------------ jobs that were waiting for the worker

-- (the worker is stopped before this runs: see "Upgrading to preparing videos in the browser" in docs/web-setup.md)
update public.jobs set status = 'preparing', worker_id = null, lease_until = null, progress = null, attempts = 0
 where status in ('queued', 'preparing');
update public.jobs set status = 'aligning', worker_id = null, lease_until = null, progress = null, attempts = 0
 where status in ('approved', 'aligning');

alter table public.jobs drop constraint jobs_status_check;
alter table public.jobs add constraint jobs_status_check check (status in
  ('uploading', 'preparing', 'needs_review', 'aligning', 'producing', 'done', 'failed', 'canceled'));
drop index if exists public.jobs_queue_idx;

alter table public.jobs
  add column runner       text,         -- the browser preparing or aligning this job (hold_prepare)
  add column runner_until timestamptz;  -- another browser may take it over after this

update public.workers set current_job = null;

-- ------------------------------------------------------------------ what people do with a job

-- After the browser finished uploading the video: the job page prepares it.
create or replace function public.submit_job(p_job uuid) returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare j public.jobs; missing text := public.missing_setup(auth.uid());
begin
  if missing is not null then raise exception '%', missing; end if;
  update public.jobs set status = 'preparing', runner = null, runner_until = null
   where id = p_job and user_id = auth.uid() and status = 'uploading'
  returning * into j;
  if j.id is null then raise exception 'job not found or not waiting for its upload'; end if;
  return j;
end $$;

-- After checking (and maybe editing) the transcript, or to add or retry languages later. Null arguments keep
-- what's there. When the transcript is the one last timed, the job page starts translating straight away;
-- otherwise it times it again first (aligning).
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
                       then 'producing' else 'aligning' end,
         attempts = 0, error = null, finished_at = null, progress = null, runner = null, runner_until = null
   where id = p_job and user_id = auth.uid() and status in ('needs_review', 'done', 'failed')
     and script is not null and base_lang is not null
     and coalesce(cardinality(coalesce(p_languages, languages)), 0) > 0
  returning * into j;
  if j.id is null then raise exception 'job not found, not ready for review, or no languages chosen'; end if;
  perform public.request_languages(j.id);
  return j;
end $$;

-- Try a failed job again: from the start if it never got a transcript, otherwise from the translation. What was
-- already made (in R2) is reused, so nothing is paid twice.
create or replace function public.retry_job(p_job uuid) returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare j public.jobs; missing text := public.missing_setup(auth.uid());
begin
  if missing is not null then raise exception '%', missing; end if;
  update public.jobs
     set status = case when script is null then 'preparing'
                       when analysis_key is not null and script = analysis_script then 'producing'
                       else 'aligning' end,
         attempts = 0, error = null, finished_at = null, progress = null, runner = null, runner_until = null
   where id = p_job and user_id = auth.uid() and status = 'failed'
  returning * into j;
  if j.id is null then raise exception 'job not found or it did not fail'; end if;
  if j.status <> 'preparing' then perform public.request_languages(j.id); end if;
  return j;
end $$;

-- The job page's browser (p_runner: an id it keeps) prepares or aligns this job, or carries on doing so; it calls
-- this every 20 seconds while it does. 'ok': it holds the job for the next minute, and the prepare routes answer only
-- its requests. 'taken': another browser holds it (it may take over once that one stops renewing). 'gone': the job
-- isn't being prepared or aligned any more.
create function public.hold_prepare(p_job uuid, p_runner text) returns text
language plpgsql security definer set search_path = '' as $$
declare j public.jobs;
begin
  if p_runner is null or length(p_runner) not between 8 and 64 then raise exception 'invalid runner'; end if;
  select * into j from public.jobs
   where id = p_job and user_id = auth.uid() and status in ('preparing', 'aligning')
     for update;
  if j.id is null then return 'gone'; end if;
  if j.runner is not null and j.runner <> p_runner and j.runner_until > now() then return 'taken'; end if;
  update public.jobs set runner = p_runner, runner_until = now() + interval '60 seconds' where id = p_job;
  return 'ok';
end $$;

-- The align route (POST /api/jobs/<id>/prepare/align) wrote analysis.json for a new video: hand the transcript to
-- the person for review. The key is made here from the row. (What the worker's worker_prepared did.)
create function public.save_prepared(p_job uuid, p_base_lang text, p_script text, p_names_fixed text[], p_warnings text[])
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_base_lang is null or p_base_lang !~ '^[a-z]{2,3}$' then raise exception 'invalid language'; end if;
  if coalesce(length(p_script), 0) not between 1 and 200000 then raise exception 'invalid transcript'; end if;
  if coalesce(cardinality(p_names_fixed), 0) > 50 or coalesce(cardinality(p_warnings), 0) > 20 then
    raise exception 'too many notes';
  end if;
  update public.jobs
     set status = 'needs_review', base_lang = p_base_lang, script = p_script, analysis_script = p_script,
         analysis_key = 'u/' || user_id || '/' || id || '/analysis.json',
         names_fixed = coalesce(p_names_fixed, '{}'), warnings = coalesce(p_warnings, '{}'),
         runner = null, runner_until = null, progress = null, attempts = 0
   where id = p_job and user_id = auth.uid() and status = 'preparing';
  if not found then raise exception 'this project isn''t being prepared any more'; end if;
end $$;

-- The align route wrote analysis.json for the approved (edited) transcript, p_script as it was split into beats.
-- p_ok false: the edits made the transcript stop matching the voiceover (p_warnings say how): back to the review.
-- (What the worker's worker_aligned did.)
create function public.save_aligned(p_job uuid, p_script text, p_warnings text[], p_ok boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare j public.jobs;
begin
  if coalesce(length(p_script), 0) not between 1 and 200000 then raise exception 'invalid transcript'; end if;
  if coalesce(cardinality(p_warnings), 0) > 20 then raise exception 'too many notes'; end if;
  update public.jobs
     set status = case when p_ok then 'producing' else 'needs_review' end,
         script = p_script, analysis_script = p_script,
         analysis_key = 'u/' || user_id || '/' || id || '/analysis.json',
         warnings = coalesce(p_warnings, '{}'),
         runner = null, runner_until = null, progress = null, attempts = 0
   where id = p_job and user_id = auth.uid() and status = 'aligning'
  returning * into j;
  if j.id is null then raise exception 'this project isn''t being timed any more'; end if;
  -- every language of the job has a row the job page can start (approve_job made them; this is a safety net)
  insert into public.job_outputs (job_id, user_id, lang, status)
  select j.id, j.user_id, l, 'pending' from unnest(j.languages) l where l is distinct from j.base_lang
  on conflict (job_id, lang) do nothing;
  -- a job whose languages were all voiced before (by an older worker) has nothing left to make
  perform public.settle_job(j.id);
end $$;

-- Preparing or aligning stopped with a problem the person has to see (and maybe fix, e.g. a key, or a video
-- without a voiceover): the job is failed, with the reason. Try again (retry_job) carries on from what was made.
create function public.fail_prepare(p_job uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.jobs
     set status = 'failed', error = left(coalesce(nullif(trim(p_error), ''), 'something went wrong'), 500),
         runner = null, runner_until = null, progress = null, finished_at = now()
   where id = p_job and user_id = auth.uid() and status in ('preparing', 'aligning');
  if not found then raise exception 'this project isn''t being prepared any more'; end if;
end $$;

-- What a job's API calls cost, recorded by the routes after each call. People record what they paid with their own
-- keys (informational): only these services, each with its own amounts within reason, and only on their own jobs.
create or replace function public.log_usage(p_job uuid, p_service text, p_amounts jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare allowed text[] := case p_service
    when 'claude' then array['model', 'input_tokens', 'output_tokens']
    when 'elevenlabs_tts' then array['characters']
    when 'elevenlabs_stt' then array['seconds']
    when 'elevenlabs_alignment' then array['seconds']
  end;
begin
  if allowed is null then raise exception 'unknown service %', p_service; end if;
  if jsonb_typeof(p_amounts) <> 'object' or exists (
       select 1 from jsonb_each(p_amounts) e
        where not (e.key = any (allowed) and case
          when e.key = 'model' then jsonb_typeof(e.value) = 'string' and length(e.value #>> '{}') <= 100
          when e.key = 'seconds' then  -- the video's length, one decimal (as the worker recorded it)
            jsonb_typeof(e.value) = 'number' and (e.value #>> '{}')::numeric between 0 and 86400
          else  -- tokens, characters
            jsonb_typeof(e.value) = 'number' and (e.value #>> '{}')::numeric between 0 and 10000000
            and (e.value #>> '{}')::numeric = trunc((e.value #>> '{}')::numeric)
          end)) then
    raise exception 'amounts must be %, within reason', array_to_string(allowed, ', ');
  end if;
  insert into public.usage_events (job_id, user_id, service, amounts)
  select id, user_id, p_service, p_amounts from public.jobs where id = p_job and user_id = auth.uid();
  if not found then raise exception 'project not found'; end if;
end $$;

-- ------------------------------------------------------------------ the worker is no longer needed

-- Nothing hands work to a worker any more. A worker that is still running gets an error asking for work (it should
-- be removed: see docs/web-setup.md); the workers table stays until the worker is deleted for good (phase 5).
drop function public.worker_claim(text, int, text);
drop function public.worker_heartbeat(text, uuid, jsonb, int, text);
drop function public.worker_prepared(text, uuid, text, text, text[], text[]);
drop function public.worker_aligned(text, uuid, text, text[], boolean);
drop function public.worker_finish(text, uuid, text);
drop function public.worker_usage(uuid, text, jsonb);
drop function public.worker_version_ok(text);

-- ------------------------------------------------------------------ who may call what

revoke execute on function public.hold_prepare(uuid, text), public.save_prepared(uuid, text, text, text[], text[]),
  public.save_aligned(uuid, text, text[], boolean), public.fail_prepare(uuid, text)
  from public, anon, authenticated;
grant execute on function public.hold_prepare(uuid, text), public.save_prepared(uuid, text, text, text[], text[]),
  public.save_aligned(uuid, text, text[], boolean), public.fail_prepare(uuid, text) to authenticated, service_role;

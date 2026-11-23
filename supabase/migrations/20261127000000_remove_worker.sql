-- The worker is gone: everything happens in the web app (the person's browser and short routes on their own keys).
-- Run it after the worker was stopped and its launchd service removed (see "Upgrading" in docs/web-setup.md).
--
--   * the workers table goes (its select policy, its grants and its place in the realtime publication with it);
--   * jobs.worker_id, lease_until, attempts and progress go: nothing sets or reads them any more. The functions that
--     still cleared them are replaced first, the same without them, and so is the insert policy that checked them;
--   * the service role loses its table grants: only the worker used the secret key. The web app uses the
--     publishable key and the owner-scoped functions.
--
-- Kept for projects made before the browser pipeline, until their files are past R2's 30-day lifecycle:
-- job_outputs.output_key / output_bytes and the 'done' status of an output (a video the worker rendered).
-- Remove after 2026-12-23 (30 days after this deploys; later if it deploys later).

-- ------------------------------------------------------------------ functions, without the worker's columns

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
         error = null, finished_at = null, runner = null, runner_until = null
   where id = p_job and user_id = auth.uid() and status in ('needs_review', 'done', 'failed')
     and script is not null and base_lang is not null
     and coalesce(cardinality(coalesce(p_languages, languages)), 0) > 0
  returning * into j;
  if j.id is null then raise exception 'job not found, not ready for review, or no languages chosen'; end if;
  perform public.request_languages(j.id);
  return j;
end $$;

create or replace function public.retry_job(p_job uuid) returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare j public.jobs; missing text := public.missing_setup(auth.uid());
begin
  if missing is not null then raise exception '%', missing; end if;
  update public.jobs
     set status = case when script is null then 'preparing'
                       when analysis_key is not null and script = analysis_script then 'producing'
                       else 'aligning' end,
         error = null, finished_at = null, runner = null, runner_until = null
   where id = p_job and user_id = auth.uid() and status = 'failed'
  returning * into j;
  if j.id is null then raise exception 'job not found or it did not fail'; end if;
  if j.status <> 'preparing' then perform public.request_languages(j.id); end if;
  return j;
end $$;

create or replace function public.save_prepared(p_job uuid, p_base_lang text, p_script text, p_names_fixed text[],
                                                p_warnings text[]) returns void
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
         runner = null, runner_until = null
   where id = p_job and user_id = auth.uid() and status = 'preparing';
  if not found then raise exception 'this project isn''t being prepared any more'; end if;
end $$;

create or replace function public.save_aligned(p_job uuid, p_script text, p_warnings text[], p_ok boolean) returns void
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
         runner = null, runner_until = null
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

create or replace function public.fail_prepare(p_job uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.jobs
     set status = 'failed', error = left(coalesce(nullif(trim(p_error), ''), 'something went wrong'), 500),
         runner = null, runner_until = null, finished_at = now()
   where id = p_job and user_id = auth.uid() and status in ('preparing', 'aligning');
  if not found then raise exception 'this project isn''t being prepared any more'; end if;
end $$;

create or replace function public.settle_job(p_job uuid) returns void
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
         finished_at = now()
   where id = p_job;
end $$;

-- ------------------------------------------------------------------ a new project, without the worker's columns

drop policy "new job" on public.jobs;
create policy "new job" on public.jobs for insert to authenticated
  with check (user_id = auth.uid()
              and ((has_video and status = 'uploading')
                   or (not has_video and status = 'done' and title is not null and source_bytes is null))
              and exists (select 1 from public.profiles p where p.id = auth.uid() and p.approved));

-- ------------------------------------------------------------------ the worker's table and columns

drop table public.workers;

alter table public.jobs
  drop column worker_id,
  drop column lease_until,
  drop column attempts,
  drop column progress;

-- ------------------------------------------------------------------ the service role (the worker's secret key)

revoke all on public.profiles, public.jobs, public.job_outputs, public.usage_events, public.user_secrets
  from service_role;
revoke all on all sequences in schema public from service_role;

-- ------------------------------------------------------------------ kept for older projects

comment on column public.job_outputs.output_key is
  'R2 key of a video the worker rendered (status done). Remove after 2026-12-23, with output_bytes and the done status.';
comment on column public.job_outputs.output_bytes is
  'Size of output_key. Remove after 2026-12-23, with output_key and the done status.';
comment on constraint job_outputs_status_check on public.job_outputs is
  '''done'' is a video the worker rendered (output_key). Remove it after 2026-12-23, with output_key and output_bytes.';

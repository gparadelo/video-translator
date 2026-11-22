-- The browser builds the timing plan and the voice track (phase 2 of moving the whole pipeline into the browser).
--
-- The worker now stops after recording the voice. For each language it uploads the plan inputs to R2, under
-- u/<user>/<job>/out/<lang>/g<generation>/:
--   inputs.json      -> what the plan is built from (vt.plan_inputs / web/lib/pipeline/inputs.ts, "format": 1)
--   tts/<name>.mp3   -> the ElevenLabs clip of each beat, and tts/<name>.json its word timing
-- and marks the language 'voiced'. The job page then builds plan.json and voice.wav in the browser
-- (web/lib/pipeline), uploads them next to the inputs, and marks the language 'ready' (save_plan below). From
-- there on everything is as in phase 1: the browser renders the preview and the downloads.
--
-- job_outputs.status:
--   pending / running / failed  -> as before
--   voiced                      -> inputs_key is set: the browser builds the plan and the voice
--   ready                       -> plan_key and voice_key are set; preview_key once the browser made the preview
--   done                        -> rendered by an older worker
--
-- job_outputs.generation counts the runs of a language: every new run (worker_output 'running') adds one, and
-- every file of a run lives under g<generation>/. save_plan and save_preview only accept the generation the
-- row is at, so a plan or preview made from an older run (a browser tab that was still busy with it while the
-- language was translated again) can never be saved against the new one, nor overwrite its files.
--
-- jobs.voices pins the ElevenLabs voice of each language for the whole job ({"de": "<voice id>"}): the worker
-- fills in a language the first time it voices it and never changes it, so a later run (a retry, a new
-- translation) speaks with the same voice even if the person changed their voice in Settings since.

alter table public.job_outputs drop constraint job_outputs_status_check;
alter table public.job_outputs add constraint job_outputs_status_check
  check (status in ('pending', 'running', 'voiced', 'ready', 'done', 'failed'));

alter table public.job_outputs
  add column generation int not null default 0,  -- see above
  add column inputs_key text;                    -- R2 key of inputs.json (status voiced)

alter table public.jobs
  add column voices jsonb not null default '{}'::jsonb;  -- the voice of each language, pinned for this job

-- One language started (running), was voiced (voiced: the plan inputs are in R2), finished (an older worker:
-- ready with plan_key and voice_key), or failed. 'running' starts a new generation and returns it; the later
-- calls of the same run pass it back (an older worker passes none). A new run makes every older file wrong, so
-- every call replaces all the file columns.
drop function public.worker_output(text, uuid, text, text, numeric, text[], text, text, bigint, text, text, text);
create function public.worker_output(p_worker text, p_job uuid, p_lang text, p_status text,
                                     p_seconds numeric default null, p_flags text[] default '{}',
                                     p_report text default null, p_output_key text default null,
                                     p_output_bytes bigint default null, p_preview_key text default null,
                                     p_plan_key text default null, p_voice_key text default null,
                                     p_generation int default null)
returns int
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid;
  gen int;
  dir text;
begin
  select user_id into uid from public.jobs where id = p_job and worker_id = p_worker and status = 'producing';
  if uid is null then raise exception 'job % is not being produced by %', p_job, p_worker; end if;
  select generation into gen from public.job_outputs where job_id = p_job and lang = p_lang;
  gen := coalesce(gen, 0);
  if p_status = 'running' then
    gen := gen + 1;
  elsif p_generation is not null and p_generation <> gen then
    raise exception 'language % of job % is at run %, not %', p_lang, p_job, gen, p_generation;
  end if;
  if p_status = 'voiced' and p_generation is null then
    raise exception 'say which run was voiced (p_generation)';
  end if;
  dir := 'u/' || uid || '/' || p_job || '/out/' || p_lang || '/g' || gen || '/';
  insert into public.job_outputs (job_id, user_id, lang, status, seconds, flags, report, output_key, output_bytes,
                                  preview_key, plan_key, voice_key, preview_bytes, generation, inputs_key)
  values (p_job, uid, p_lang, p_status, p_seconds, coalesce(p_flags, '{}'), p_report, p_output_key, p_output_bytes,
          p_preview_key, p_plan_key, p_voice_key, null, gen,
          case when p_status = 'voiced' then dir || 'inputs.json' end)
  on conflict (job_id, lang) do update
    set status = excluded.status, seconds = excluded.seconds, flags = excluded.flags,
        report = excluded.report, output_key = excluded.output_key, output_bytes = excluded.output_bytes,
        preview_key = excluded.preview_key, plan_key = excluded.plan_key, voice_key = excluded.voice_key,
        preview_bytes = null, generation = excluded.generation, inputs_key = excluded.inputs_key;
  return gen;
end $$;

-- Pin the voice of each language for this job: languages already pinned keep theirs. Returns all the pins.
create function public.worker_pin_voices(p_worker text, p_job uuid, p_voices jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if jsonb_typeof(p_voices) <> 'object' then raise exception 'p_voices must be an object'; end if;
  update public.jobs set voices = p_voices || voices
   where id = p_job and worker_id = p_worker and status = 'producing'
  returning voices into v;
  if v is null then raise exception 'job % is not being produced by %', p_job, p_worker; end if;
  return v;
end $$;

-- The browser built and uploaded plan.json and voice.wav for a voiced language. POST /api/jobs/<id>/plan/<lang>
-- calls this once it checked both files arrived whole and read the plan (seconds, flags and report come from
-- it). A person could also call it directly, but only for their own outputs, only for the run the row is at,
-- and the keys are fixed here, so nobody can point a plan at another file.
create function public.save_plan(p_job uuid, p_lang text, p_generation int, p_seconds numeric, p_flags text[],
                                 p_report text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.job_outputs
     set status = 'ready',
         plan_key = 'u/' || user_id || '/' || job_id || '/out/' || lang || '/g' || generation || '/plan.json',
         voice_key = 'u/' || user_id || '/' || job_id || '/out/' || lang || '/g' || generation || '/voice.wav',
         seconds = p_seconds, flags = coalesce(p_flags, '{}'), report = p_report,
         preview_key = null, preview_bytes = null
   where job_id = p_job and lang = p_lang and user_id = auth.uid() and status = 'voiced'
     and generation = p_generation;
  if not found then raise exception 'this language changed while its voice was being prepared'; end if;
end $$;

-- The browser uploaded the preview it rendered (as before), now only for the run the row is at, and under its
-- folder, so a preview of an older run can't replace the new one's.
drop function public.save_preview(uuid, text, bigint);
create function public.save_preview(p_job uuid, p_lang text, p_generation int, p_bytes bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_bytes is null or p_bytes < 1 then raise exception 'the preview is empty'; end if;
  update public.job_outputs
     set preview_key = 'u/' || user_id || '/' || job_id || '/out/' || lang || '/g' || generation || '/preview.mp4',
         preview_bytes = p_bytes
   where job_id = p_job and lang = p_lang and user_id = auth.uid() and status = 'ready'
     and generation = p_generation;
  if not found then raise exception 'this language changed while its preview was being made'; end if;
end $$;

revoke execute on function
  public.worker_output(text, uuid, text, text, numeric, text[], text, text, bigint, text, text, text, int),
  public.worker_pin_voices(text, uuid, jsonb),
  public.save_plan(uuid, text, int, numeric, text[], text),
  public.save_preview(uuid, text, int, bigint)
  from public, anon, authenticated;
grant execute on function public.save_plan(uuid, text, int, numeric, text[], text),
  public.save_preview(uuid, text, int, bigint) to authenticated;
grant execute on function
  public.worker_output(text, uuid, text, text, numeric, text[], text, text, bigint, text, text, text, int),
  public.worker_pin_voices(text, uuid, jsonb),
  public.save_plan(uuid, text, int, numeric, text[], text),
  public.save_preview(uuid, text, int, bigint)
  to service_role;

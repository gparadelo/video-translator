-- The browser renders the videos (phase 1 of moving the whole pipeline into the browser).
--
-- The worker no longer renders. For each language it now uploads to R2, in u/<user>/<job>/out/<lang>/:
--   plan.json  -> how to cut and retime the source (vt.portable_plan; "format" says which version)
--   voice.wav  -> the finished voice track: 16-bit PCM, 44.1 kHz, stereo, loudness matched and limited,
--                 exactly as long as the video
-- and marks the language 'ready' (ready to render). The browser then renders a 720p preview from them and
-- uploads it as preview.mp4 (save_preview below), so it plays on the job page. The full-quality video is
-- rendered in the browser again when the person downloads it, and saved on their computer: it is never uploaded.
--
-- job_outputs.status:
--   pending / running / failed  -> as before
--   ready                       -> plan_key and voice_key are set; preview_key once the browser made the preview
--   done                        -> rendered by an older worker: output_key (the full video) and preview_key are set

alter table public.job_outputs drop constraint job_outputs_status_check;
alter table public.job_outputs add constraint job_outputs_status_check
  check (status in ('pending', 'running', 'ready', 'done', 'failed'));

alter table public.job_outputs
  add column plan_key      text,    -- R2 key of plan.json
  add column voice_key     text,    -- R2 key of voice.wav
  add column preview_bytes bigint;  -- size of the browser-made preview

-- One language finished (or failed). Same as before, plus the plan and voice files. A new plan makes the old
-- preview wrong, so every call replaces all the file columns (an older worker still sends output/preview keys).
drop function public.worker_output(text, uuid, text, text, numeric, text[], text, text, bigint, text);
create function public.worker_output(p_worker text, p_job uuid, p_lang text, p_status text,
                                     p_seconds numeric default null, p_flags text[] default '{}',
                                     p_report text default null, p_output_key text default null,
                                     p_output_bytes bigint default null, p_preview_key text default null,
                                     p_plan_key text default null, p_voice_key text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  select user_id into uid from public.jobs where id = p_job and worker_id = p_worker and status = 'producing';
  if uid is null then raise exception 'job % is not being produced by %', p_job, p_worker; end if;
  insert into public.job_outputs (job_id, user_id, lang, status, seconds, flags, report, output_key, output_bytes,
                                  preview_key, plan_key, voice_key, preview_bytes)
  values (p_job, uid, p_lang, p_status, p_seconds, coalesce(p_flags, '{}'), p_report, p_output_key, p_output_bytes,
          p_preview_key, p_plan_key, p_voice_key, null)
  on conflict (job_id, lang) do update
    set status = excluded.status, seconds = excluded.seconds, flags = excluded.flags,
        report = excluded.report, output_key = excluded.output_key, output_bytes = excluded.output_bytes,
        preview_key = excluded.preview_key, plan_key = excluded.plan_key, voice_key = excluded.voice_key,
        preview_bytes = null;
end $$;

-- The browser uploaded the preview it rendered. POST /api/jobs/<id>/preview/<lang> calls this once it checked
-- the file is complete. A person could also call it directly, but only for their own outputs, and the key is
-- fixed here, so nobody can point a preview at another file.
create function public.save_preview(p_job uuid, p_lang text, p_bytes bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_bytes is null or p_bytes < 1 then raise exception 'the preview is empty'; end if;
  update public.job_outputs
     set preview_key = 'u/' || user_id || '/' || job_id || '/out/' || lang || '/preview.mp4',
         preview_bytes = p_bytes
   where job_id = p_job and lang = p_lang and user_id = auth.uid() and status = 'ready';
  if not found then raise exception 'this language is not ready to render'; end if;
end $$;

revoke execute on function public.worker_output(text, uuid, text, text, numeric, text[], text, text, bigint, text, text, text),
  public.save_preview(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.save_preview(uuid, text, bigint) to authenticated;
grant execute on function public.worker_output(text, uuid, text, text, numeric, text[], text, text, bigint, text, text, text),
  public.save_preview(uuid, text, bigint) to service_role;

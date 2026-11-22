-- Projects: a job can have a video, a title, or both.
--
--   has_video = false  -> title-only project. It is created as 'done' (there is nothing for the worker to do),
--                         and worker_claim only ever takes 'queued' / 'approved' jobs, so the worker never sees it.
--   title              -> the title as the person typed it; title_lang its language (null = not known yet).
--   titles             -> the translations, {"es": "...", "de": "..."}: plain ASCII, at most 60 characters each,
--                         written by the web app (/api/jobs/<id>/title) through set_titles below.

alter table public.jobs
  add column has_video  boolean not null default true,
  add column title      text check (length(title) between 1 and 300),
  add column title_lang text,
  add column titles     jsonb not null default '{}'::jsonb,
  add constraint jobs_video_or_title check (has_video or title is not null),
  add constraint jobs_titles_object check (jsonb_typeof(titles) = 'object');

-- A video project starts 'uploading' (waiting for its file); a title-only one is finished from the start.
drop policy "new job" on public.jobs;
create policy "new job" on public.jobs for insert to authenticated
  with check (user_id = auth.uid() and worker_id is null and attempts = 0
              and ((has_video and status = 'uploading')
                   or (not has_video and status = 'done' and title is not null and source_bytes is null))
              and exists (select 1 from public.profiles p where p.id = auth.uid() and p.approved));

grant insert (has_video, status, title, title_lang) on public.jobs to authenticated;

-- Save a project's title and its translations (any time: also to add a title to an existing video).
-- p_replace = false merges p_titles into what is there (translating only the missing languages).
create function public.set_titles(p_job uuid, p_title text, p_title_lang text, p_titles jsonb,
                                  p_replace boolean default true) returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare j public.jobs;
begin
  if jsonb_typeof(coalesce(p_titles, '{}'::jsonb)) <> 'object' then raise exception 'titles must be an object'; end if;
  update public.jobs
     set title = coalesce(p_title, title),
         title_lang = coalesce(p_title_lang, title_lang),
         titles = case when p_replace then coalesce(p_titles, '{}'::jsonb)
                       else titles || coalesce(p_titles, '{}'::jsonb) end
   where id = p_job and user_id = auth.uid()
  returning * into j;
  if j.id is null then raise exception 'project not found'; end if;
  return j;
end $$;

revoke execute on function public.set_titles(uuid, text, text, jsonb, boolean) from public, anon;
grant execute on function public.set_titles(uuid, text, text, jsonb, boolean) to authenticated, service_role;

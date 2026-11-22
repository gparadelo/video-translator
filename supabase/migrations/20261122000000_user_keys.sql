-- Each person brings their own ElevenLabs and Claude API keys, and their own voice.
--
--   user_secrets  -> one row per person: their API keys, encrypted (AES-256-GCM) by the web app with SECRETS_KEY,
--                    which is only in the web app's and the worker's settings, never in the database. A copy of
--                    the database alone gives no usable keys. The *_hint columns are the last 4 characters, so
--                    Settings can show which key is saved without ever sending the key back to the browser.
--   People can't read or write the table directly: they save through set_my_keys, see hints through
--   my_key_status, and the web server reads their encrypted keys through my_keys. The worker reads it with
--   the service role.
--   A video can't go into the queue (submit, approve, retry) until its owner has both keys and a voice.

create table public.user_secrets (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  elevenlabs_key   text,     -- "v1:" + base64(iv | ciphertext | tag); see web/lib/secrets.ts
  elevenlabs_hint  text,
  anthropic_key    text,
  anthropic_hint   text,
  updated_at       timestamptz not null default now()
);

create trigger user_secrets_touch before update on public.user_secrets
  for each row execute function public.touch_updated_at();

alter table public.user_secrets enable row level security;  -- and no policies: nobody but the service role
revoke all on public.user_secrets from anon, authenticated;
grant select, insert, update, delete on public.user_secrets to service_role;

-- Save keys. For each key: null = keep what's saved, '' = remove it, anything else = the new (encrypted) key.
create function public.set_my_keys(p_elevenlabs_key text default null, p_elevenlabs_hint text default null,
                                   p_anthropic_key text default null, p_anthropic_hint text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  insert into public.user_secrets (user_id) values (auth.uid()) on conflict do nothing;
  update public.user_secrets
     set elevenlabs_key  = case when p_elevenlabs_key is null then elevenlabs_key else nullif(p_elevenlabs_key, '') end,
         elevenlabs_hint = case when p_elevenlabs_key is null then elevenlabs_hint
                                when p_elevenlabs_key = '' then null else left(p_elevenlabs_hint, 8) end,
         anthropic_key   = case when p_anthropic_key is null then anthropic_key else nullif(p_anthropic_key, '') end,
         anthropic_hint  = case when p_anthropic_key is null then anthropic_hint
                                when p_anthropic_key = '' then null else left(p_anthropic_hint, 8) end
   where user_id = auth.uid();
end $$;

-- What Settings shows: which keys are saved (their last characters), and the voice.
create function public.my_key_status()
returns table (elevenlabs_hint text, anthropic_hint text, voice_id text, voice_ids jsonb)
language sql stable security definer set search_path = '' as $$
  select s.elevenlabs_hint, s.anthropic_hint, p.voice_id, p.voice_ids
    from public.profiles p left join public.user_secrets s on s.user_id = p.id
   where p.id = auth.uid();
$$;

-- The encrypted keys, for the web server (title translation, checking the voice). Useless without SECRETS_KEY.
create function public.my_keys() returns table (elevenlabs_key text, anthropic_key text)
language sql stable security definer set search_path = '' as $$
  select elevenlabs_key, anthropic_key from public.user_secrets where user_id = auth.uid();
$$;

-- The voice: one for every language, and optionally a different one per language ({"de": "..."}).
create function public.set_my_voice(p_voice_id text, p_voice_ids jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare k text; v jsonb;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if p_voice_id is not null and p_voice_id !~ '^[A-Za-z0-9]{10,40}$' then
    raise exception 'that does not look like an ElevenLabs voice ID';
  end if;
  if jsonb_typeof(coalesce(p_voice_ids, '{}'::jsonb)) <> 'object' then raise exception 'voice_ids must be an object'; end if;
  for k, v in select * from jsonb_each(coalesce(p_voice_ids, '{}'::jsonb)) loop
    if k !~ '^[a-z]{2}$' or jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^[A-Za-z0-9]{10,40}$' then
      raise exception 'voice for "%" does not look like an ElevenLabs voice ID', k;
    end if;
  end loop;
  update public.profiles set voice_id = nullif(p_voice_id, ''), voice_ids = coalesce(p_voice_ids, '{}'::jsonb)
   where id = auth.uid();
end $$;

-- What's still missing before this person's videos can be made, or null when nothing is.
create function public.missing_setup(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when s.elevenlabs_key is null then 'add your ElevenLabs API key in Settings first'
    when s.anthropic_key is null then 'add your Claude API key in Settings first'
    when p.voice_id is null then 'choose your ElevenLabs voice in Settings first'
  end
  from public.profiles p left join public.user_secrets s on s.user_id = p.id
  where p.id = p_user;
$$;

-- The three ways a video reaches the worker now check the setup first (bodies otherwise as before).

create or replace function public.submit_job(p_job uuid) returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare j public.jobs; missing text := public.missing_setup(auth.uid());
begin
  if missing is not null then raise exception '%', missing; end if;
  update public.jobs set status = 'queued'
   where id = p_job and user_id = auth.uid() and status = 'uploading'
  returning * into j;
  if j.id is null then raise exception 'job not found or not waiting for its upload'; end if;
  return j;
end $$;

create or replace function public.approve_job(p_job uuid, p_script text default null, p_languages text[] default null)
returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare j public.jobs; missing text := public.missing_setup(auth.uid());
begin
  if missing is not null then raise exception '%', missing; end if;
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

create or replace function public.retry_job(p_job uuid) returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare j public.jobs; missing text := public.missing_setup(auth.uid());
begin
  if missing is not null then raise exception '%', missing; end if;
  update public.jobs
     set status = case when script is null then 'queued' else 'approved' end,
         attempts = 0, error = null, finished_at = null
   where id = p_job and user_id = auth.uid() and status = 'failed'
  returning * into j;
  if j.id is null then raise exception 'job not found or it did not fail'; end if;
  return j;
end $$;

revoke execute on function public.set_my_keys(text, text, text, text), public.my_key_status(), public.my_keys(),
  public.set_my_voice(text, jsonb), public.missing_setup(uuid) from public, anon;
revoke execute on function public.missing_setup(uuid) from authenticated;  -- only for the functions above
grant execute on function public.set_my_keys(text, text, text, text), public.my_key_status(), public.my_keys(),
  public.set_my_voice(text, jsonb) to authenticated;
grant execute on function public.set_my_keys(text, text, text, text), public.my_key_status(), public.my_keys(),
  public.set_my_voice(text, jsonb), public.missing_setup(uuid) to service_role;

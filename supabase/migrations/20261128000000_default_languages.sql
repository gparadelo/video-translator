-- People choose their default languages in Settings: the ones a new project starts with.
-- profiles.languages already holds them (and New project reads it); people can read their profile but not
-- write it, so they save through set_my_languages, like set_my_voice.

create function public.set_my_languages(p_languages text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare l text;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if p_languages is null then raise exception 'send the languages as a list'; end if;
  foreach l in array p_languages loop
    if l is null or l !~ '^[a-z]{2}$' then raise exception 'unknown language "%"', l; end if;
  end loop;
  update public.profiles
     set languages = p_languages
   where id = auth.uid();
end $$;

revoke execute on function public.set_my_languages(text[]) from public, anon;
grant execute on function public.set_my_languages(text[]) to authenticated, service_role;

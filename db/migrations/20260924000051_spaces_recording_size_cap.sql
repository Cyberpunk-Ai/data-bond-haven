-- Phase 5: Spaces — server-side backstop on recording size (defense in depth;
-- the primary configurable limit is enforced client-side via VITE_SPACES_RECORDING_MAX_MB).
create or replace function public.t_spaces_recording_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Hard ceiling regardless of client config, to stop abusive uploads.
  if new.recording_bytes > 1073741824 then -- 1 GiB
    raise exception 'Recording exceeds the maximum allowed size';
  end if;
  return new;
end;
$$;

drop trigger if exists t_spaces_recording_cap on public.spaces;
create trigger t_spaces_recording_cap
  before insert or update on public.spaces
  for each row execute function public.t_spaces_recording_cap();

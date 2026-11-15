create or replace function public.record_case_update(
  p_report_id uuid,
  p_status text,
  p_note text,
  p_assigned_to uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_status text;
  previous_assignee uuid;
  clean_note text := trim(coalesce(p_note, ''));
begin
  if coalesce(public.current_app_role()::text, '') not in ('staff', 'admin') then
    raise exception 'Staff access is required.';
  end if;
  if p_status is null or p_status not in ('Received', 'In review', 'Follow-up', 'Closed') then
    raise exception 'Invalid report status.';
  end if;

  select status, assigned_to into previous_status, previous_assignee
  from public.reports
  where id = p_report_id
  for update;
  if not found then
    raise exception 'Report was not found or is not accessible.';
  end if;

  if clean_note = '' and previous_status = p_status then
    if previous_assignee is not distinct from p_assigned_to then
      raise exception 'Add an update, change the status, or assign the report before saving.';
    end if;
  end if;
  if p_assigned_to is not null and not exists (
    select 1 from public.staff_directory where id = p_assigned_to
  ) then
    raise exception 'The assignee must have staff or administrator access.';
  end if;

  update public.reports
  set status = p_status, assigned_to = p_assigned_to, updated_at = now()
  where id = p_report_id;

  if previous_status is distinct from p_status then
    insert into public.case_updates (report_id, author_id, kind, status, note)
    values (p_report_id, auth.uid(), 'status', p_status, 'Status changed to ' || p_status || '.');
  end if;

  if clean_note <> '' then
    insert into public.case_updates (report_id, author_id, kind, status, note)
    values (p_report_id, auth.uid(), 'note', p_status, clean_note);
  end if;
  if previous_assignee is distinct from p_assigned_to then
    insert into public.case_updates (report_id, author_id, kind, status, note)
    values (
      p_report_id,
      auth.uid(),
      'assignment',
      p_status,
      case when p_assigned_to is null then 'Report unassigned.'
        else 'Report assigned to ' || coalesce(
          (select nullif(display_name, '') from public.staff_directory where id = p_assigned_to),
          'a team member'
        ) || '.'
      end
    );
  end if;
end;
$$;

revoke update (status, assigned_to, updated_at) on public.reports from authenticated;
revoke insert on public.case_updates from authenticated;
grant select on public.case_updates to authenticated;
grant execute on function public.record_case_update(uuid, text, text, uuid) to authenticated;

create index if not exists reports_assigned_to_idx
  on public.reports (assigned_to) where assigned_to is not null;
create index if not exists pattern_reviews_reviewer_id_created_at_idx
  on public.pattern_reviews (reviewer_id, created_at desc);

alter table public.reports
  alter column reference set default (
    'HBR' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
  );

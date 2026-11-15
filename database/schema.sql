create type public.app_role as enum ('reporter', 'staff', 'reviewer', 'admin');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  display_name text not null default '',
  role public.app_role not null default 'reporter',
  created_at timestamptz not null default now()
);

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', ''),
    'reporter'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create function public.handle_user_email_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute procedure public.handle_user_email_update();

create function public.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid()
$$;

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique default (
    'HBR' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
  ),
  reporter_id uuid not null references public.profiles (id),
  contact_preference text not null check (contact_preference in ('private', 'contact')),
  reporter_name text,
  reporter_contact text,
  description text not null default '',
  incident_date date,
  location text,
  desired_support text,
  status text not null default 'Received'
    check (status in ('Received', 'In review', 'Follow-up', 'Closed')),
  assigned_to uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (contact_preference = 'contact' or (reporter_name is null and reporter_contact is null))
);

create index reports_reporter_id_created_at_idx on public.reports (reporter_id, created_at desc);
create index reports_status_created_at_idx on public.reports (status, created_at desc);
create index reports_assigned_to_idx on public.reports (assigned_to) where assigned_to is not null;

create table public.case_updates (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.reports (id) on delete cascade,
  author_id uuid not null references public.profiles (id),
  kind text not null check (kind in ('status', 'note', 'assignment')),
  status text check (status in ('Received', 'In review', 'Follow-up', 'Closed')),
  note text not null default '',
  visible_to_reporter boolean not null default true,
  created_at timestamptz not null default now()
);

create index case_updates_report_id_created_at_idx on public.case_updates (report_id, created_at);

create function public.handle_new_report()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.case_updates (report_id, author_id, kind, status, note)
  values (new.id, new.reporter_id, 'status', new.status, 'Report received.');
  return new;
end;
$$;

create trigger on_report_created
  after insert on public.reports
  for each row execute procedure public.handle_new_report();

create view public.staff_directory with (security_invoker = true) as
  select id, display_name, role
  from public.profiles
  where role in ('staff', 'admin');

create table public.pattern_reviews (
  id uuid primary key default gen_random_uuid(),
  report_a_id uuid not null references public.reports (id) on delete cascade,
  report_b_id uuid not null references public.reports (id) on delete cascade,
  reviewer_id uuid not null references public.profiles (id),
  outcome text not null check (outcome in ('dismissed', 'reviewed', 'linked')),
  reason text not null check (length(trim(reason)) > 0),
  created_at timestamptz not null default now(),
  check (report_a_id < report_b_id),
  unique (report_a_id, report_b_id)
);

create index pattern_reviews_reviewer_id_created_at_idx
  on public.pattern_reviews (reviewer_id, created_at desc);

create function public.record_case_update(
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

create function public.report_belongs_to_user(p_report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.reports
    where id = p_report_id and reporter_id = auth.uid()
  )
$$;

create function public.report_exists(p_report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.reports where id = p_report_id)
$$;

create function public.get_pattern_suggestions()
returns table (
  report_a_id uuid,
  report_a_reference text,
  report_a_created_at timestamptz,
  report_b_id uuid,
  report_b_reference text,
  report_b_created_at timestamptz,
  shared_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(public.current_app_role()::text, '') not in ('reviewer', 'admin') then
    raise exception 'Pattern reviewer access is required.';
  end if;

  return query
    with words as (
      select r.id, r.reference, r.created_at, tokenized.word
      from public.reports r
      cross join lateral regexp_matches(
        coalesce(r.description, '') || ' ' || coalesce(r.desired_support, ''),
        '[A-Za-z]{5,}',
        'g'
      ) as tokens(captures)
      cross join lateral (select lower(tokens.captures[1]) as word) tokenized
      where tokenized.word not in (
        'about', 'after', 'again', 'against', 'also', 'among', 'been', 'being',
        'both', 'could', 'does', 'doing', 'down', 'each', 'from', 'have',
        'having', 'here', 'into', 'just', 'more', 'most', 'other', 'over',
        'same', 'should', 'some', 'such', 'than', 'that', 'their', 'them',
        'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under',
        'very', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your'
      )
    ),
    pair_counts as (
      select first_word.id as first_id, second_word.id as second_id,
        count(distinct first_word.word) as terms
      from words first_word
      join words second_word
        on first_word.id < second_word.id
        and first_word.word = second_word.word
      group by first_word.id, second_word.id
      having count(distinct first_word.word) >= 2
    )
    select first_report.id, first_report.reference, first_report.created_at,
      second_report.id, second_report.reference, second_report.created_at,
      pair_counts.terms
    from pair_counts
    join public.reports first_report on first_report.id = pair_counts.first_id
    join public.reports second_report on second_report.id = pair_counts.second_id
    order by pair_counts.terms desc, first_report.created_at desc;
end;
$$;

create function public.admin_list_profiles()
returns table (
  id uuid,
  email text,
  display_name text,
  role public.app_role,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_app_role() is distinct from 'admin'::public.app_role then
    raise exception 'Administrator access is required.';
  end if;
  return query
    select p.id, p.email, p.display_name, p.role, p.created_at
    from public.profiles p
    order by p.created_at desc;
end;
$$;

create function public.set_profile_role(p_user_id uuid, p_role public.app_role)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_role public.app_role;
begin
  if p_role is null then
    raise exception 'A valid role is required.';
  end if;
  if public.current_app_role() is distinct from 'admin'::public.app_role then
    raise exception 'Administrator access is required.';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You cannot change your own administrator role.';
  end if;

  select role into target_role from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'User was not found.';
  end if;
  if target_role = 'admin' and p_role <> 'admin'
     and (select count(*) from public.profiles where role = 'admin') <= 1 then
    raise exception 'The last administrator cannot be demoted.';
  end if;

  update public.profiles set role = p_role where id = p_user_id;
end;
$$;

alter table public.profiles enable row level security;
alter table public.reports enable row level security;
alter table public.case_updates enable row level security;
alter table public.pattern_reviews enable row level security;

create policy "Users read their own profile"
  on public.profiles for select to authenticated
  using (id = auth.uid());
create policy "Admins read all profiles"
  on public.profiles for select to authenticated
  using (public.current_app_role() = 'admin');
create policy "Staff read staff directory"
  on public.profiles for select to authenticated
  using (
    public.current_app_role() in ('staff', 'admin')
    and role in ('staff', 'admin')
  );
create policy "Users update their own display name"
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "Signed-in users create their own reports"
  on public.reports for insert to authenticated
  with check (reporter_id = auth.uid());
create policy "Reporters read their own reports"
  on public.reports for select to authenticated
  using (reporter_id = auth.uid());
create policy "Staff read reports"
  on public.reports for select to authenticated
  using (public.current_app_role() in ('staff', 'admin'));
create policy "Staff update reports"
  on public.reports for update to authenticated
  using (public.current_app_role() in ('staff', 'admin'))
  with check (public.current_app_role() in ('staff', 'admin'));

create policy "Reporters read visible updates on their reports"
  on public.case_updates for select to authenticated
  using (
    visible_to_reporter
    and public.report_belongs_to_user(case_updates.report_id)
  );
create policy "Staff read all case updates"
  on public.case_updates for select to authenticated
  using (public.current_app_role() in ('staff', 'admin'));
create policy "Staff add case updates"
  on public.case_updates for insert to authenticated
  with check (
    author_id = auth.uid()
    and public.current_app_role() in ('staff', 'admin')
  );

create policy "Reviewers read pattern reviews"
  on public.pattern_reviews for select to authenticated
  using (public.current_app_role() in ('reviewer', 'admin'));
create policy "Reviewers create pattern reviews"
  on public.pattern_reviews for insert to authenticated
  with check (
    reviewer_id = auth.uid()
    and public.current_app_role() in ('reviewer', 'admin')
    and public.report_exists(report_a_id)
    and public.report_exists(report_b_id)
  );

revoke all on public.profiles, public.reports, public.case_updates, public.pattern_reviews from anon;
revoke all on public.profiles, public.reports, public.case_updates, public.pattern_reviews from authenticated;
grant select (id, display_name, role, created_at) on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select (id, reference, contact_preference, reporter_name, reporter_contact, description, incident_date, location, desired_support, status, assigned_to, created_at, updated_at) on public.reports to authenticated;
grant insert (reporter_id, contact_preference, reporter_name, reporter_contact, description, incident_date, location, desired_support) on public.reports to authenticated;
grant select on public.case_updates to authenticated;
grant select, insert on public.pattern_reviews to authenticated;
grant select on public.staff_directory to authenticated;
revoke all on public.staff_directory from anon;

revoke all on function public.current_app_role() from public;
revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_user_email_update() from public;
revoke all on function public.handle_new_report() from public;
revoke all on function public.record_case_update(uuid, text, text, uuid) from public;
revoke all on function public.report_belongs_to_user(uuid) from public;
revoke all on function public.report_exists(uuid) from public;
revoke all on function public.get_pattern_suggestions() from public;
revoke all on function public.admin_list_profiles() from public;
revoke all on function public.set_profile_role(uuid, public.app_role) from public;
grant execute on function public.current_app_role() to authenticated;
grant execute on function public.record_case_update(uuid, text, text, uuid) to authenticated;
grant execute on function public.report_belongs_to_user(uuid) to authenticated;
grant execute on function public.report_exists(uuid) to authenticated;
grant execute on function public.get_pattern_suggestions() to authenticated;
grant execute on function public.admin_list_profiles() to authenticated;
grant execute on function public.set_profile_role(uuid, public.app_role) to authenticated;

create schema if not exists factory;

create table if not exists factory.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  repository text,
  status text not null default 'active'
    check (status in ('active','paused','archived')),
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists factory.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references factory.projects(id) on delete cascade,
  category text not null check (category in (
    'feature','bug','docs','security','database','deployment','incident','other'
  )),
  title text not null,
  description text not null,
  assigned_agent text not null check (assigned_agent in (
    'mission_control','product_architect','engineer','qa_security','sre'
  )),
  status text not null default 'received' check (status in (
    'received','triaged','planned','awaiting_approval','executing','verifying',
    'staging','deploying','monitoring','completed','failed','rolled_back','human_required'
  )),
  risk_level text not null default 'low'
    check (risk_level in ('low','medium','high','critical')),
  priority smallint not null default 50 check (priority between 0 and 100),
  requested_by text not null default 'Abu',
  input jsonb not null default '{}'::jsonb,
  plan jsonb,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create table if not exists factory.approvals (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references factory.tasks(id) on delete cascade,
  action text not null,
  reason text,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  requested_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text
);

create table if not exists factory.agent_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references factory.tasks(id) on delete cascade,
  agent_role text not null,
  model text,
  status text not null default 'running'
    check (status in ('running','succeeded','failed','cancelled')),
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  cost_usd numeric(12,6) not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists factory.audit_events (
  id bigint generated always as identity primary key,
  project_id uuid references factory.projects(id) on delete set null,
  task_id uuid references factory.tasks(id) on delete set null,
  actor text not null,
  event_type text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tasks_status_idx
  on factory.tasks(status, priority desc, created_at);
create index if not exists approvals_status_idx
  on factory.approvals(status, requested_at);
create index if not exists agent_runs_task_idx
  on factory.agent_runs(task_id, started_at desc);
create index if not exists audit_task_idx
  on factory.audit_events(task_id, created_at desc);

alter table factory.projects enable row level security;
alter table factory.tasks enable row level security;
alter table factory.approvals enable row level security;
alter table factory.agent_runs enable row level security;
alter table factory.audit_events enable row level security;

revoke all on schema factory from anon, authenticated;
revoke all on all tables in schema factory from anon, authenticated;
revoke all on all sequences in schema factory from anon, authenticated;

create or replace function factory.touch_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, factory
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projects_touch_updated_at on factory.projects;
create trigger projects_touch_updated_at
before update on factory.projects
for each row execute function factory.touch_updated_at();

drop trigger if exists tasks_touch_updated_at on factory.tasks;
create trigger tasks_touch_updated_at
before update on factory.tasks
for each row execute function factory.touch_updated_at();



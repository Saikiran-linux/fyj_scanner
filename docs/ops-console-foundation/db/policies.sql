-- ============================================================================
-- Ops-console RLS — f-131 security core (Neon Postgres)
-- ============================================================================
-- Apply AFTER the Drizzle migration creates the tables (drizzle-kit migrate),
-- on every deploy. Idempotent.
--
-- Tenant isolation is enforced here, not in app code. The Cloudflare Worker
-- authenticates the request (Better Auth), resolves the principal, and stamps
-- the transaction with per-request GUCs:
--
--   set local app.user_id   = '<better-auth user id>';
--   set local app.principal = 'staff' | 'client';
--   set local app.org_id    = '<uuid>';
--   set local app.role      = 'admin' | 'operator' | 'viewer';   -- staff only
--   set local app.client_id = '<uuid>';                          -- client only
--
-- The Worker connects as `ops_app` (LOGIN, NOT superuser, NOT BYPASSRLS), so RLS
-- is actually enforced. Forgetting a SET LOCAL fails CLOSED (GUC null -> every
-- policy denies). Do NOT `force row level security` — the SECURITY DEFINER
-- helpers below must read `clients` as the table owner (RLS-exempt) to avoid
-- recursive policy evaluation.
-- ============================================================================

create schema if not exists app;

-- ── claim readers (per-request GUCs) ──────────────────────────────────
create or replace function app.current_user_id() returns text
  language sql stable as $$ select nullif(current_setting('app.user_id', true), '') $$;

create or replace function app.current_org_id() returns uuid
  language sql stable as $$ select nullif(current_setting('app.org_id', true), '')::uuid $$;

create or replace function app.current_principal() returns text
  language sql stable as $$ select nullif(current_setting('app.principal', true), '') $$;

create or replace function app.current_role() returns text
  language sql stable as $$ select nullif(current_setting('app.role', true), '') $$;

create or replace function app.current_client_id() returns uuid
  language sql stable as $$ select nullif(current_setting('app.client_id', true), '')::uuid $$;

-- ── access helpers (SECURITY DEFINER: read clients RLS-exempt as owner) ─
-- Staff path: admin/viewer see every client in their org; operators see only
-- clients assigned to them. Centralized so child-table policies stay one-liners,
-- and so reassigning a client (one column on `clients`) instantly re-gates all
-- of that client's profiles/campaigns/matches/placements/feedback.
create or replace function app.can_access_client(p_client_id uuid)
  returns boolean language plpgsql stable security definer
  set search_path = public, pg_temp as $$
declare r record;
begin
  if app.current_principal() is distinct from 'staff' then return false; end if;
  select org_id, assigned_operator_id into r from public.clients where id = p_client_id;
  if not found then return false; end if;
  if r.org_id is distinct from app.current_org_id() then return false; end if;
  if app.current_role() in ('admin', 'viewer') then return true; end if;
  if app.current_role() = 'operator' then
    return r.assigned_operator_id is not distinct from app.current_user_id();
  end if;
  return false;
end $$;

-- Client portal path: the client may view their OWN client row's data, and only
-- while the operator has portal access enabled.
create or replace function app.can_view_as_client(p_client_id uuid)
  returns boolean language plpgsql stable security definer
  set search_path = public, pg_temp as $$
declare r record;
begin
  if app.current_principal() is distinct from 'client' then return false; end if;
  if p_client_id is distinct from app.current_client_id() then return false; end if;
  select org_id, portal_enabled into r from public.clients where id = p_client_id;
  if not found then return false; end if;
  return coalesce(r.portal_enabled, false) and r.org_id is not distinct from app.current_org_id();
end $$;

-- ── enable RLS ────────────────────────────────────────────────────────
alter table public.organizations    enable row level security;
alter table public.memberships      enable row level security;
alter table public.clients          enable row level security;
alter table public.client_profiles  enable row level security;
alter table public.campaigns        enable row level security;
alter table public.campaign_matches enable row level security;
alter table public.reports          enable row level security;
alter table public.placements       enable row level security;
alter table public.feedback         enable row level security;
alter table public.audit_log        enable row level security;

-- ── organizations ─────────────────────────────────────────────────────
drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations for select
  using (id = app.current_org_id());

drop policy if exists organizations_update on public.organizations;
create policy organizations_update on public.organizations for update
  using (id = app.current_org_id() and app.current_role() = 'admin')
  with check (id = app.current_org_id() and app.current_role() = 'admin');

-- ── memberships (staff read own org; admin writes) ────────────────────
drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships for select
  using (org_id = app.current_org_id() and app.current_principal() = 'staff');

drop policy if exists memberships_admin_write on public.memberships;
create policy memberships_admin_write on public.memberships for all
  using (org_id = app.current_org_id() and app.current_role() = 'admin')
  with check (org_id = app.current_org_id() and app.current_role() = 'admin');

-- ── clients ───────────────────────────────────────────────────────────
drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients for select
  using ((app.current_principal() = 'staff' and app.can_access_client(id))
         or app.can_view_as_client(id));

drop policy if exists clients_insert on public.clients;
create policy clients_insert on public.clients for insert
  with check (
    app.current_principal() = 'staff'
    and org_id = app.current_org_id()
    and app.current_role() in ('admin', 'operator')
    and (app.current_role() = 'admin' or assigned_operator_id = app.current_user_id())
  );

drop policy if exists clients_update on public.clients;
create policy clients_update on public.clients for update
  using (app.current_role() in ('admin', 'operator') and app.can_access_client(id))
  with check (org_id = app.current_org_id());

drop policy if exists clients_delete on public.clients;
create policy clients_delete on public.clients for delete
  using (org_id = app.current_org_id() and app.current_role() = 'admin');

-- ── child tables that BOTH staff and the client can read ──────────────
-- client_profiles, campaigns, campaign_matches, placements: visible to staff
-- (via can_access_client) and to the client portal (via can_view_as_client);
-- writable only by admin/operator staff for accessible clients.
do $$
declare tbl text;
begin
  foreach tbl in array array['client_profiles','campaigns','campaign_matches','placements']
  loop
    execute format('drop policy if exists %1$s_select on public.%1$s', tbl);
    execute format($f$
      create policy %1$s_select on public.%1$s for select
        using (org_id = app.current_org_id()
               and (app.can_access_client(client_id) or app.can_view_as_client(client_id)))
    $f$, tbl);

    execute format('drop policy if exists %1$s_staff_write on public.%1$s', tbl);
    execute format($f$
      create policy %1$s_staff_write on public.%1$s for all
        using (org_id = app.current_org_id()
               and app.current_principal() = 'staff'
               and app.current_role() in ('admin','operator')
               and app.can_access_client(client_id))
        with check (org_id = app.current_org_id()
               and app.current_principal() = 'staff'
               and app.current_role() in ('admin','operator')
               and app.can_access_client(client_id))
    $f$, tbl);
  end loop;
end $$;

-- ── reports (staff-only; not exposed to the client portal) ────────────
drop policy if exists reports_staff_select on public.reports;
create policy reports_staff_select on public.reports for select
  using (app.current_principal() = 'staff' and app.can_access_client(client_id));

drop policy if exists reports_staff_write on public.reports;
create policy reports_staff_write on public.reports for all
  using (app.current_principal() = 'staff'
         and app.current_role() in ('admin','operator')
         and app.can_access_client(client_id))
  with check (app.current_principal() = 'staff'
         and app.current_role() in ('admin','operator')
         and app.can_access_client(client_id));

-- ── feedback (staff + client read; CLIENT-INSERT-ONLY, immutable) ─────
drop policy if exists feedback_select on public.feedback;
create policy feedback_select on public.feedback for select
  using (org_id = app.current_org_id()
         and (app.can_access_client(client_id) or app.can_view_as_client(client_id)));

drop policy if exists feedback_client_insert on public.feedback;
create policy feedback_client_insert on public.feedback for insert
  with check (
    app.current_principal() = 'client'
    and client_id = app.current_client_id()
    and org_id = app.current_org_id()
    and app.can_view_as_client(client_id)
  );

-- ── audit_log (admin read; staff insert) ──────────────────────────────
drop policy if exists audit_log_admin_select on public.audit_log;
create policy audit_log_admin_select on public.audit_log for select
  using (org_id = app.current_org_id() and app.current_role() = 'admin');

drop policy if exists audit_log_staff_insert on public.audit_log;
create policy audit_log_staff_insert on public.audit_log for insert
  with check (org_id = app.current_org_id() and app.current_principal() = 'staff');

-- ============================================================================
-- App role — the Worker connects as this (NOT owner, NOT superuser, NO BYPASSRLS)
-- ============================================================================
-- Set the password out of band (Neon role page) or:  alter role ops_app with password '...';
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ops_app') then
    create role ops_app login;
  end if;
end $$;

grant usage on schema public, app to ops_app;
grant select, insert, update, delete on all tables in schema public to ops_app;
grant execute on all functions in schema app to ops_app;
alter default privileges in schema public
  grant select, insert, update, delete on tables to ops_app;

-- Sanity: ops_app must NOT bypass RLS.
do $$
begin
  if (select rolbypassrls from pg_roles where rolname = 'ops_app') then
    raise exception 'ops_app must not have BYPASSRLS';
  end if;
end $$;

-- ============================================================================
-- System role — the TRUSTED cron/queue Worker (matcher) connects as this.
-- ============================================================================
-- The continuous matcher legitimately spans all orgs (list active campaigns),
-- which RLS blocks for ops_app. ops_system has BYPASSRLS and is used ONLY by the
-- background Worker over its own Hyperdrive binding — NEVER on the request path.
-- Each match run still touches exactly one campaign's data.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ops_system') then
    create role ops_system login bypassrls;
  end if;
end $$;

grant usage on schema public, app to ops_system;
grant select, insert, update, delete on all tables in schema public to ops_system;
grant execute on all functions in schema app to ops_system;
alter default privileges in schema public
  grant select, insert, update, delete on tables to ops_system;


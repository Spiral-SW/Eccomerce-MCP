-- Usuário de banco dedicado ao MCP em rede, com acesso SOMENTE ao schema `mcp`.
-- Use a connection string deste usuário (não a do `postgres`) em OLLYX_DATABASE_URL.
-- A senha NÃO fica neste arquivo: defina com ALTER ROLE mcp_app PASSWORD '...' (ou com um verificador SCRAM já calculado).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mcp_app') then
    create role mcp_app login nosuperuser nocreatedb nocreaterole noinherit nobypassrls connection limit 20;
  end if;
end $$;

grant usage on schema mcp to mcp_app;
grant select, insert, update, delete on all tables in schema mcp to mcp_app;
alter default privileges in schema mcp grant select, insert, update, delete on tables to mcp_app;

-- RLS está ligado nas tabelas: sem policy, mcp_app não enxergaria nada. A policy vale só para esse usuário;
-- anon e authenticated continuam sem policy e sem acesso ao schema.
do $$
declare t text;
begin
  for t in select unnest(array['users', 'clients', 'auth_codes', 'tokens', 'hits', 'kv', 'provider_tokens']) loop
    execute format('drop policy if exists mcp_app_all on mcp.%I', t);
    execute format('create policy mcp_app_all on mcp.%I for all to mcp_app using (true) with check (true)', t);
  end loop;
end $$;

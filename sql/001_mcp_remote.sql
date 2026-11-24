-- MCP Ollyx em rede: usuários, OAuth próprio, tokens dos provedores e cache.
-- Tudo no schema `mcp`, que NÃO é exposto pela API REST do Supabase (só o schema public é).
-- Acesso apenas pelo servidor, com a connection string do banco. RLS ligado e sem policies como segunda barreira.
create schema if not exists mcp;
revoke all on schema mcp from public;
do $$
begin  -- anon/authenticated existem no Supabase, mas não em um Postgres comum
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema mcp from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on schema mcp from authenticated'; end if;
end $$;

create table if not exists mcp.users (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  papel text not null default 'user' check (papel in ('admin', 'user')),
  code_hash text not null unique,           -- SHA-256 do código de acesso; o código em si nunca é guardado
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists mcp.clients (
  id text primary key,
  name text not null,
  redirect_uris jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists mcp.auth_codes (
  hash text primary key,
  client_id text not null references mcp.clients (id) on delete cascade,
  user_id uuid not null references mcp.users (id) on delete cascade,
  redirect_uri text not null,
  challenge text not null,
  expires_at timestamptz not null
);

create table if not exists mcp.tokens (
  hash text primary key,                    -- SHA-256 do token
  kind text not null check (kind in ('access', 'refresh')),
  client_id text not null references mcp.clients (id) on delete cascade,
  user_id uuid not null references mcp.users (id) on delete cascade,
  family_id text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists tokens_family_idx on mcp.tokens (family_id);
create index if not exists tokens_expires_idx on mcp.tokens (expires_at);

create table if not exists mcp.hits (       -- limitador de tentativas por IP
  bucket text not null,
  key text not null,
  at timestamptz not null default now()
);
create index if not exists hits_lookup_idx on mcp.hits (bucket, key, at);

create table if not exists mcp.kv (         -- cache (pedidos por dia, catálogo Bling, exportações CSV)
  key text primary key,
  value jsonb not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists mcp.provider_tokens (  -- conexão do MCP com Bling e Mercado Livre
  provider text primary key check (provider in ('bling', 'meli')),
  access_token_enc text not null,           -- AES-256-GCM com a chave OLLYX_TOKEN_KEY
  refresh_token_enc text not null,
  expires_at timestamptz not null,
  scope text not null default '',
  updated_at timestamptz not null default now()
);

alter table mcp.users enable row level security;
alter table mcp.clients enable row level security;
alter table mcp.auth_codes enable row level security;
alter table mcp.tokens enable row level security;
alter table mcp.hits enable row level security;
alter table mcp.kv enable row level security;
alter table mcp.provider_tokens enable row level security;

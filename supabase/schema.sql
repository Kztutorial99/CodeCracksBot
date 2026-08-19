-- CodeCracksBot memory schema. Run once in the Supabase SQL editor.

create table if not exists public.chat_messages (
  id bigint generated always as identity primary key,
  chat_id bigint not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_chat_created_idx
  on public.chat_messages (chat_id, created_at desc);

create table if not exists public.chat_sandbox (
  chat_id bigint primary key,
  sandbox_id text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.chat_stop (
  chat_id bigint primary key,
  requested_at timestamptz not null default now()
);

-- Bot-only data: reachable through the service role key from the webhook,
-- never from browsers. No anon/authenticated grants, RLS on with no policies.
grant all on public.chat_messages to service_role;
grant usage, select on all sequences in schema public to service_role;
grant all on public.chat_sandbox to service_role;
grant all on public.chat_stop to service_role;

alter table public.chat_messages enable row level security;
alter table public.chat_sandbox enable row level security;
alter table public.chat_stop enable row level security;

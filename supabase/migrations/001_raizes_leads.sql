-- Tabela de leads capturados pelo agente de diagnóstico
create table if not exists raizes_leads (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  email text not null,
  summary text,
  conversation jsonb,
  created_at timestamptz default now()
);

-- RLS: apenas service_role pode ler/escrever
alter table raizes_leads enable row level security;
create policy "service_role only" on raizes_leads
  using (auth.role() = 'service_role');

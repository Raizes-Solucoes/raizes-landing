# supabase/

Aqui fica só a migration histórica de `raizes_leads` (`migrations/001_raizes_leads.sql`).

As edge functions que o painel (`/admin`) e as páginas usam **não moram neste repositório**: o código e a publicação
são do `miller-crm-backend` (`supabase/functions/`). Não copie funções para cá: as cópias antigas ficaram defasadas
e divergentes do que roda em produção, e este repositório é público.

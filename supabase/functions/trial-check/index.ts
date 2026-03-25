import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    const now = new Date().toISOString();
    
    // Busca trials expirados
    const { data: expiredTrials, error: fetchErr } = await adminClient
      .from("subscriptions")
      .select("*, organizations(*)")
      .eq("status", "trial")
      .lt("trial_ends_at", now);

    if (fetchErr) throw fetchErr;

    let suspendedCount = 0;
    let warningCount = 0;
    const errors = [];

    // Processa cada trial expirado
    for (const sub of expiredTrials || []) {
      try {
        // Atualiza status da subscription para 'suspended'
        const { error: subErr } = await adminClient
          .from("subscriptions")
          .update({ 
            status: "suspended",
            updated_at: now
          })
          .eq("id", sub.id);

        if (subErr) throw subErr;

        // Desativa a organização
        const { error: orgErr } = await adminClient
          .from("organizations")
          .update({ 
            is_active: false,
            updated_at: now
          })
          .eq("id", sub.org_id);

        if (orgErr) throw orgErr;

        // Desativa todos os usuários da org
        const { error: userErr } = await adminClient
          .from("users")
          .update({ 
            is_active: false,
            updated_at: now
          })
          .eq("org_id", sub.org_id);

        if (userErr) throw userErr;

        suspendedCount++;
      } catch (e) {
        errors.push({ org_id: sub.org_id, error: e.message });
      }
    }

    // Busca trials próximos do vencimento (3 dias)
    const threeDaysFromNow = new Date();
    threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

    const { data: warningTrials, error: warningErr } = await adminClient
      .from("subscriptions")
      .select("*, organizations(*)")
      .eq("status", "trial")
      .gte("trial_ends_at", now)
      .lt("trial_ends_at", threeDaysFromNow.toISOString());

    if (warningErr) throw warningErr;

    // Adiciona flag de aviso (opcional - pode ser usado para notificações futuras)
    for (const sub of warningTrials || []) {
      try {
        const settings = sub.organizations?.settings || {};
        settings.trial_warning_sent = true;
        
        await adminClient
          .from("organizations")
          .update({ 
            settings,
            updated_at: now
          })
          .eq("id", sub.org_id);

        warningCount++;
      } catch (e) {
        errors.push({ org_id: sub.org_id, error: e.message, type: 'warning' });
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        suspended: suspendedCount,
        warnings: warningCount,
        errors: errors.length > 0 ? errors : undefined,
        timestamp: now
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (e) {
    console.error("Error in trial-check:", e);
    return new Response(
      JSON.stringify({ error: e.message }), 
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

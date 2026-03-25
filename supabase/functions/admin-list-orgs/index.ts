import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response(JSON.stringify({ error: "No auth" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
    const adminClient = createClient(supabaseUrl, supabaseKey);

    // Verify super_admin
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { data: profile } = await adminClient.from("users").select("role").eq("id", user.id).single();
    if (profile?.role !== "super_admin") return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    // Get all orgs
    const { data: orgs } = await adminClient.from("organizations").select("*").order("created_at", { ascending: false });

    // Get subscriptions with plans
    const { data: subs } = await adminClient.from("subscriptions").select("*, plans(*)");

    // Get metrics per org
    const orgResults = await Promise.all((orgs || []).map(async (org: any) => {
      const [usersRes, dealsRes, clientsRes, chatsRes] = await Promise.all([
        adminClient.from("users").select("id", { count: "exact", head: true }).eq("org_id", org.id),
        adminClient.from("deals").select("id", { count: "exact", head: true }).eq("org_id", org.id),
        adminClient.from("clientes").select("id", { count: "exact", head: true }).eq("org_id", org.id),
        adminClient.from("whatsapp_chats").select("id", { count: "exact", head: true }).eq("org_id", org.id),
      ]);

      const sub = subs?.find((s: any) => s.org_id === org.id);
      return {
        ...org,
        isActive: org.is_active,
        primaryColor: org.primary_color,
        logoUrl: org.logo_url,
        subscription: sub ? { status: sub.status, plan: sub.plans, trialEndsAt: sub.trial_ends_at } : null,
        metrics: {
          users: usersRes.count || 0,
          deals: dealsRes.count || 0,
          clients: clientsRes.count || 0,
          chats: chatsRes.count || 0,
        },
      };
    }));

    return new Response(JSON.stringify({ orgs: orgResults }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

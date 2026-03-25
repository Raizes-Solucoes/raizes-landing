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

    const { orgId, action } = await req.json();
    if (!orgId) return new Response(JSON.stringify({ error: "orgId required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const newStatus = action === "activate";

    // Update org
    const { error: orgErr } = await adminClient.from("organizations").update({ is_active: newStatus, updated_at: new Date().toISOString() }).eq("id", orgId);
    if (orgErr) throw orgErr;

    // Update subscription status
    if (!newStatus) {
      await adminClient.from("subscriptions").update({ status: "suspended", updated_at: new Date().toISOString() }).eq("org_id", orgId);
    } else {
      await adminClient.from("subscriptions").update({ status: "active", updated_at: new Date().toISOString() }).eq("org_id", orgId);
    }

    // Deactivate/activate all users of that org
    await adminClient.from("users").update({ is_active: newStatus }).eq("organization_id", orgId);

    return new Response(JSON.stringify({ ok: true, orgId, is_active: newStatus }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

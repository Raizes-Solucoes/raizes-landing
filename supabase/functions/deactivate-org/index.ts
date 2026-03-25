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

    // DELETE ORG
    if (action === "delete") {
      // Get all user IDs to delete from auth
      const { data: orgUsers } = await adminClient.from("users").select("id").eq("org_id", orgId);
      
      // Delete in order: dependent tables first
      await adminClient.from("whatsapp_messages").delete().in("chat_id", 
        (await adminClient.from("whatsapp_chats").select("id").eq("org_id", orgId)).data?.map((c: any) => c.id) || []
      );
      await adminClient.from("whatsapp_chats").delete().eq("org_id", orgId);
      await adminClient.from("tasks").delete().eq("org_id", orgId);
      await adminClient.from("notifications").delete().eq("org_id", orgId);
      await adminClient.from("documents").delete().eq("org_id", orgId);
      await adminClient.from("activity_logs").delete().eq("org_id", orgId);
      await adminClient.from("deals").delete().eq("org_id", orgId);
      await adminClient.from("clientes").delete().eq("org_id", orgId);
      await adminClient.from("users").delete().eq("org_id", orgId);
      await adminClient.from("subscriptions").delete().eq("org_id", orgId);
      await adminClient.from("usage_counters").delete().eq("org_id", orgId);
      await adminClient.from("organizations").delete().eq("id", orgId);

      // Delete auth users
      for (const u of (orgUsers || [])) {
        await adminClient.auth.admin.deleteUser(u.id);
      }

      return new Response(JSON.stringify({ ok: true, deleted: orgId }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

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
    await adminClient.from("users").update({ is_active: newStatus }).eq("org_id", orgId);

    return new Response(JSON.stringify({ ok: true, orgId, is_active: newStatus }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

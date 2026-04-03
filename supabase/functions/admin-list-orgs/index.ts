import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "No auth" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
    const adminClient = createClient(supabaseUrl, supabaseKey);

    // Verify super_admin
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const { data: profile } = await adminClient.from("users").select("role").eq("id", user.id).single();
    if (profile?.role !== "super_admin") return json({ error: "Forbidden" }, 403);

    // ── Bulk queries (replaces N+1 per-org loop) ──
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    const [orgsRes, subsRes, usersRes, dealsRes, clientsRes, chatsRes, msgCountsRes, autoConfigsRes, autoLogsRes] = await Promise.all([
      adminClient.from("organizations").select("*").order("created_at", { ascending: false }),
      adminClient.from("subscriptions").select("*, plans(*)"),
      adminClient.from("users").select("org_id, is_active, is_logged_in, last_seen, last_login_at"),
      adminClient.from("deals").select("org_id, created_at, paid_at"),
      adminClient.from("clientes").select("org_id"),
      adminClient.from("whatsapp_chats").select("org_id"),
      adminClient.rpc("count_messages_by_org_30d"),
      adminClient.from("automation_configs").select("org_id, is_active"),
      adminClient.from("automation_logs").select("org_id, status").gte("timestamp", sevenDaysAgo),
    ]);

    const orgs = orgsRes.data || [];
    const subs = subsRes.data || [];
    const users = usersRes.data || [];
    const deals = dealsRes.data || [];
    const clients = clientsRes.data || [];
    const chats = chatsRes.data || [];
    const msgCounts = msgCountsRes.data || [];
    const autoConfigs = autoConfigsRes.data || [];
    const autoLogs = autoLogsRes.data || [];

    // ── Build lookup maps ──
    const groupBy = (arr: any[], key: string) => {
      const map: Record<string, any[]> = {};
      arr.forEach((item) => {
        const k = item[key];
        if (k) (map[k] || (map[k] = [])).push(item);
      });
      return map;
    };

    const usersByOrg = groupBy(users, "org_id");
    const dealsByOrg = groupBy(deals, "org_id");
    const clientsByOrg = groupBy(clients, "org_id");
    const chatsByOrg = groupBy(chats, "org_id");
    const autoConfigsByOrg = groupBy(autoConfigs, "org_id");
    const autoLogsByOrg = groupBy(autoLogs, "org_id");

    const msgCountMap: Record<string, number> = {};
    msgCounts.forEach((m: any) => { msgCountMap[m.org_id] = Number(m.msg_count) || 0; });

    const now = Date.now();
    const thirtyDaysMs = 30 * 86400000;

    // ── Map orgs with enriched data ──
    const orgResults = orgs.map((org: any) => {
      const sub = subs.find((s: any) => s.org_id === org.id);
      const orgUsers = usersByOrg[org.id] || [];
      const orgDeals = dealsByOrg[org.id] || [];
      const orgClients = clientsByOrg[org.id] || [];
      const orgChats = chatsByOrg[org.id] || [];
      const orgAutoConfigs = autoConfigsByOrg[org.id] || [];
      const orgAutoLogs = autoLogsByOrg[org.id] || [];
      const msgs30d = msgCountMap[org.id] || 0;

      // Derived metrics
      const deals30d = orgDeals.filter((d: any) => new Date(d.created_at).getTime() > now - thirtyDaysMs).length;
      const dealsPaid30d = orgDeals.filter((d: any) => d.paid_at && new Date(d.paid_at).getTime() > now - thirtyDaysMs).length;
      const activeAutomations = orgAutoConfigs.filter((c: any) => c.is_active).length;
      const automationErrors7d = orgAutoLogs.filter((l: any) => l.status === "error" || l.status === "failed").length;

      // Last activity: max(last_seen) across org users
      let lastActivityTs = 0;
      orgUsers.forEach((u: any) => {
        const seen = u.last_seen ? new Date(u.last_seen).getTime() : 0;
        if (seen > lastActivityTs) lastActivityTs = seen;
      });
      const lastActivity = lastActivityTs > 0 ? new Date(lastActivityTs).toISOString() : null;

      // WhatsApp connected
      const whatsappConnected = !!(org.settings?.evolution_instance || org.settings?.zapi_instance_id);

      // Health score (0-100)
      let healthScore = 0;

      // Login recency (0-30 pts)
      if (lastActivityTs > 0) {
        const daysSince = (now - lastActivityTs) / 86400000;
        if (daysSince < 1) healthScore += 30;
        else if (daysSince < 3) healthScore += 25;
        else if (daysSince < 7) healthScore += 15;
        else if (daysSince < 14) healthScore += 5;
      }

      // Deals 30d (0-25 pts)
      if (deals30d >= 10) healthScore += 25;
      else if (deals30d >= 5) healthScore += 20;
      else if (deals30d >= 1) healthScore += 10;

      // Messages 30d (0-25 pts)
      if (msgs30d >= 100) healthScore += 25;
      else if (msgs30d >= 30) healthScore += 20;
      else if (msgs30d >= 1) healthScore += 10;

      // WhatsApp connected (0-10 pts)
      if (whatsappConnected) healthScore += 10;

      // Automation errors (0-10 pts)
      if (automationErrors7d === 0) healthScore += 10;
      else if (automationErrors7d <= 3) healthScore += 5;

      return {
        ...org,
        isActive: org.is_active,
        primaryColor: org.primary_color,
        logoUrl: org.logo_url,
        zapiConnected: whatsappConnected,
        subscription: sub ? { status: sub.status, plan: sub.plans, trialEndsAt: sub.trial_ends_at } : null,
        metrics: {
          users: orgUsers.length,
          deals: orgDeals.length,
          clients: orgClients.length,
          chats: orgChats.length,
        },
        // Enriched fields
        healthScore,
        lastActivity,
        deals30d,
        dealsPaid30d,
        messages30d: msgs30d,
        activeAutomations,
        automationErrors7d,
      };
    });

    return json({ orgs: orgResults });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
});

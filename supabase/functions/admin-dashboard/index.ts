import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // ── Auth ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "No auth" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const adminClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const { data: profile } = await adminClient.from("users").select("role").eq("id", user.id).single();
    if (profile?.role !== "super_admin") return json({ error: "Forbidden" }, 403);

    // ── Date helpers ──
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
    const sevenDaysFromNow = new Date(now.getTime() + 7 * 86400000).toISOString();
    const twelveMonthsAgo = new Date(now.getFullYear() - 1, now.getMonth(), 1).toISOString();
    const nowISO = now.toISOString();

    // ── 6 parallel query groups ──
    const [kpis, trialHealth, orgRisk, automationHealth, activityFeed, growth] = await Promise.all([
      fetchGlobalKpis(adminClient, startOfMonth),
      fetchTrialHealth(adminClient, nowISO, sevenDaysFromNow),
      fetchOrgRisk(adminClient, sevenDaysAgo),
      fetchAutomationHealth(adminClient, sevenDaysAgo),
      fetchRecentActivity(adminClient),
      fetchGrowthCharts(adminClient, twelveMonthsAgo),
    ]);

    return json({ kpis, trialHealth, orgRisk, automationHealth, activityFeed, growth });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
});

// ─── Group 1: Global KPIs ───
async function fetchGlobalKpis(db: any, startOfMonth: string) {
  const [orgsRes, subsRes, usersRes, dealsMonthRes, dealsTotalRes] = await Promise.all([
    db.from("organizations").select("id, is_active"),
    db.from("subscriptions").select("status, trial_ends_at, plans(slug, price_monthly)"),
    db.from("users").select("id, is_active, is_logged_in"),
    db.from("deals").select("id, approved_amount, gross_premium, product_type, paid_at, created_at").gte("created_at", startOfMonth),
    db.from("deals").select("id", { count: "exact", head: true }),
  ]);

  const orgsData = orgsRes.data || [];
  const subsData = subsRes.data || [];
  const usersData = usersRes.data || [];
  const dealsMonth = dealsMonthRes.data || [];

  // Org counts
  const activeOrgs = orgsData.filter((o: any) => o.is_active).length;
  const trialCount = subsData.filter((s: any) => s.status === "trial").length;

  // MRR
  const activeSubs = subsData.filter((s: any) => s.status === "active" || s.status === "trial");
  const mrrTotal = activeSubs.reduce((sum: number, s: any) => sum + (s.plans?.price_monthly || 0), 0);
  const mrrByPlan: Record<string, number> = {};
  activeSubs.forEach((s: any) => {
    const slug = s.plans?.slug || "unknown";
    mrrByPlan[slug] = (mrrByPlan[slug] || 0) + (s.plans?.price_monthly || 0);
  });

  // Users
  const activeUsers = usersData.filter((u: any) => u.is_active).length;
  const onlineNow = usersData.filter((u: any) => u.is_logged_in).length;

  // Deals this month
  const paidThisMonth = dealsMonth.filter((d: any) => d.paid_at);
  let volFinancing = 0;
  let volInsurance = 0;
  paidThisMonth.forEach((d: any) => {
    if (d.product_type?.startsWith("seguro")) {
      volInsurance += parseFloat(d.gross_premium) || 0;
    } else {
      volFinancing += parseFloat(d.approved_amount) || 0;
    }
  });

  return {
    orgs: { total: orgsData.length, active: activeOrgs, inactive: orgsData.length - activeOrgs, trial: trialCount },
    users: { total: usersData.length, active: activeUsers, onlineNow },
    mrr: { total: mrrTotal, byPlan: mrrByPlan },
    deals: { total: dealsTotalRes.count || 0, thisMonth: dealsMonth.length, paidThisMonth: paidThisMonth.length },
    volume: { total: volFinancing + volInsurance, financing: volFinancing, insurance: volInsurance },
  };
}

// ─── Group 2: Trial Health ───
async function fetchTrialHealth(db: any, nowISO: string, sevenDaysFromNow: string) {
  const [expiringRes, allTrialsRes, convertedRes] = await Promise.all([
    db.from("subscriptions").select("org_id, trial_ends_at, organizations(name)").eq("status", "trial").gte("trial_ends_at", nowISO).lte("trial_ends_at", sevenDaysFromNow),
    db.from("subscriptions").select("id", { count: "exact", head: true }).not("trial_ends_at", "is", null),
    db.from("subscriptions").select("id", { count: "exact", head: true }).not("trial_ends_at", "is", null).eq("status", "active"),
  ]);

  const now = Date.now();
  const expiringTrials = (expiringRes.data || []).map((s: any) => ({
    orgId: s.org_id,
    orgName: s.organizations?.name || "—",
    trialEndsAt: s.trial_ends_at,
    daysLeft: Math.ceil((new Date(s.trial_ends_at).getTime() - now) / 86400000),
  })).sort((a: any, b: any) => a.daysLeft - b.daysLeft);

  const totalTrials = allTrialsRes.count || 0;
  const converted = convertedRes.count || 0;

  return {
    expiringTrials,
    conversionRate: totalTrials > 0 ? Math.round((converted / totalTrials) * 100) : 0,
    totalTrialsEver: totalTrials,
    convertedTrials: converted,
  };
}

// ─── Group 3: Org Risk ───
async function fetchOrgRisk(db: any, sevenDaysAgo: string) {
  const [usersRes, orgsRes] = await Promise.all([
    db.from("users").select("org_id, last_seen, organizations(name, is_active)").eq("is_active", true),
    db.from("organizations").select("id, name, settings").eq("is_active", true),
  ]);

  // Inactive orgs: group users by org, find max last_seen
  const orgLastSeen: Record<string, { maxSeen: number; orgName: string }> = {};
  (usersRes.data || []).forEach((u: any) => {
    if (!u.organizations?.is_active) return;
    const seen = u.last_seen ? new Date(u.last_seen).getTime() : 0;
    const existing = orgLastSeen[u.org_id];
    if (!existing || seen > existing.maxSeen) {
      orgLastSeen[u.org_id] = { maxSeen: seen, orgName: u.organizations?.name || "—" };
    }
  });

  const now = Date.now();
  const sevenDaysMs = 7 * 86400000;
  const inactiveOrgs = Object.entries(orgLastSeen)
    .filter(([, v]) => now - v.maxSeen > sevenDaysMs)
    .map(([orgId, v]) => ({
      orgId,
      orgName: v.orgName,
      lastSeen: v.maxSeen > 0 ? new Date(v.maxSeen).toISOString() : null,
      daysSinceLogin: v.maxSeen > 0 ? Math.floor((now - v.maxSeen) / 86400000) : 999,
    }))
    .sort((a, b) => b.daysSinceLogin - a.daysSinceLogin);

  // WhatsApp disconnected
  const disconnectedWhatsapp = (orgsRes.data || [])
    .filter((o: any) => !o.settings?.evolution_instance && !o.settings?.zapi_instance_id)
    .map((o: any) => ({ orgId: o.id, orgName: o.name }));

  return { inactiveOrgs, disconnectedWhatsapp };
}

// ─── Group 4: Automation Health ───
async function fetchAutomationHealth(db: any, sevenDaysAgo: string) {
  const [configsRes, logsRes] = await Promise.all([
    db.from("automation_configs").select("org_id, type, is_active, last_run_at, last_error"),
    db.from("automation_logs").select("org_id, status, automation_type").gte("timestamp", sevenDaysAgo),
  ]);

  const configs = configsRes.data || [];
  const logs = logsRes.data || [];

  // Per-org aggregation
  const perOrg: Record<string, { activeCount: number; totalLogs7d: number; errors7d: number }> = {};
  configs.forEach((c: any) => {
    if (!perOrg[c.org_id]) perOrg[c.org_id] = { activeCount: 0, totalLogs7d: 0, errors7d: 0 };
    if (c.is_active) perOrg[c.org_id].activeCount++;
  });

  let totalLogs = 0;
  let totalErrors = 0;
  logs.forEach((l: any) => {
    if (!perOrg[l.org_id]) perOrg[l.org_id] = { activeCount: 0, totalLogs7d: 0, errors7d: 0 };
    perOrg[l.org_id].totalLogs7d++;
    totalLogs++;
    if (l.status === "error" || l.status === "failed") {
      perOrg[l.org_id].errors7d++;
      totalErrors++;
    }
  });

  return {
    perOrg,
    global: {
      totalLogs7d: totalLogs,
      totalErrors7d: totalErrors,
      errorRate: totalLogs > 0 ? Math.round((totalErrors / totalLogs) * 100) : 0,
    },
  };
}

// ─── Group 5: Recent Activity Feed ───
async function fetchRecentActivity(db: any) {
  const [orgsRes, dealsRes, ticketsRes, errorsRes] = await Promise.all([
    db.from("organizations").select("id, name, created_at").order("created_at", { ascending: false }).limit(30),
    db.from("deals").select("id, org_id, paid_at, title, organizations(name)").not("paid_at", "is", null).order("paid_at", { ascending: false }).limit(30),
    db.from("support_tickets").select("id, org_id, title, status, created_at, organizations(name)").order("created_at", { ascending: false }).limit(30),
    db.from("automation_logs").select("id, org_id, automation_type, error_message, timestamp, organizations(name)").eq("status", "error").order("timestamp", { ascending: false }).limit(30),
  ]);

  const items: any[] = [];

  (orgsRes.data || []).forEach((o: any) => items.push({
    type: "org_created", timestamp: o.created_at, title: o.name, orgName: o.name, orgId: o.id,
  }));

  (dealsRes.data || []).forEach((d: any) => items.push({
    type: "deal_paid", timestamp: d.paid_at, title: d.title || "Deal pago", orgName: d.organizations?.name || "—", orgId: d.org_id,
  }));

  (ticketsRes.data || []).forEach((t: any) => items.push({
    type: "support_ticket", timestamp: t.created_at, title: t.title, orgName: t.organizations?.name || "—", orgId: t.org_id,
  }));

  (errorsRes.data || []).forEach((e: any) => items.push({
    type: "automation_error", timestamp: e.timestamp, title: `${e.automation_type}: ${e.error_message || "erro"}`, orgName: e.organizations?.name || "—", orgId: e.org_id,
  }));

  items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return items.slice(0, 30);
}

// ─── Group 6: Growth Charts (12 months) ───
async function fetchGrowthCharts(db: any, twelveMonthsAgo: string) {
  const [orgsRes, subsRes, dealsRes] = await Promise.all([
    db.from("organizations").select("created_at").gte("created_at", twelveMonthsAgo),
    db.from("subscriptions").select("org_id, status, plans(price_monthly), organizations(created_at)"),
    db.from("deals").select("created_at").gte("created_at", twelveMonthsAgo),
  ]);

  // Build 12-month array
  const now = new Date();
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  const toMonth = (dateStr: string) => {
    const d = new Date(dateStr);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };

  // Org signups per month
  const orgSignups = months.map((m) => (orgsRes.data || []).filter((o: any) => toMonth(o.created_at) === m).length);

  // Deals per month
  const dealCounts = months.map((m) => (dealsRes.data || []).filter((d: any) => toMonth(d.created_at) === m).length);

  // MRR approximation: for each month, count orgs created on or before that month-end with active/trial subs
  const activeSubs = (subsRes.data || []).filter((s: any) => s.status === "active" || s.status === "trial");
  const mrrData = months.map((m) => {
    const monthEnd = new Date(parseInt(m.slice(0, 4)), parseInt(m.slice(5)) , 0); // last day of month
    return activeSubs
      .filter((s: any) => {
        const orgCreated = s.organizations?.created_at;
        return orgCreated && new Date(orgCreated) <= monthEnd;
      })
      .reduce((sum: number, s: any) => sum + (s.plans?.price_monthly || 0), 0);
  });

  return { months, orgSignups, mrr: mrrData, deals: dealCounts };
}

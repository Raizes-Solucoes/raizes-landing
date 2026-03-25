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

    const body = await req.json();
    const { orgName, adminName, adminUsername, adminPassword, planSlug, trialDays, primaryColor, logoUrl } = body;

    if (!orgName || !adminName || !adminUsername || !adminPassword) {
      return new Response(JSON.stringify({ error: "Campos obrigatórios: orgName, adminName, adminUsername, adminPassword" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Generate slug
    const slug = orgName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

    // Check slug uniqueness
    const { data: existing } = await adminClient.from("organizations").select("id").eq("slug", slug).single();
    if (existing) return new Response(JSON.stringify({ error: `Slug "${slug}" já existe` }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    // Find plan
    const { data: plan } = await adminClient.from("plans").select("*").eq("slug", planSlug || "starter").single();
    if (!plan) return new Response(JSON.stringify({ error: `Plano "${planSlug}" não encontrado` }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    // 1. Create org
    const { data: org, error: orgErr } = await adminClient.from("organizations").insert({
      name: orgName,
      slug,
      primary_color: primaryColor || "#2D5A3D",
      logo_url: logoUrl || null,
      is_active: true,
      settings: {},
    }).select().single();
    if (orgErr) throw orgErr;

    // 2. Create subscription
    const now = new Date();
    const trialEnd = trialDays > 0 ? new Date(now.getTime() + trialDays * 86400000) : null;
    const { error: subErr } = await adminClient.from("subscriptions").insert({
      org_id: org.id,
      plan_id: plan.id,
      status: trialDays > 0 ? "trial" : "active",
      trial_ends_at: trialEnd?.toISOString() || null,
      current_period_start: now.toISOString(),
    });
    if (subErr) throw subErr;

    // 3. Create admin user in auth
    const email = `${adminUsername}@miller.internal`;
    const { data: authUser, error: authCreateErr } = await adminClient.auth.admin.createUser({
      email,
      password: adminPassword,
      email_confirm: true,
    });
    if (authCreateErr) throw authCreateErr;

    // 4. Create user profile
    const { error: profileErr } = await adminClient.from("users").insert({
      id: authUser.user.id,
      name: adminName,
      username: adminUsername,
      email,
      role: "admin",
      org_id: org.id,
      is_active: true,
    });
    if (profileErr) throw profileErr;

    return new Response(JSON.stringify({
      ok: true,
      org: { id: org.id, name: org.name, slug: org.slug },
      admin: { id: authUser.user.id, username: adminUsername },
      plan: { name: plan.name, status: trialDays > 0 ? "trial" : "active" },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

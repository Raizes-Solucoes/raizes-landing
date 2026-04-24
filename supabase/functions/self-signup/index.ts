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

    const body = await req.json();
    const { companyName, adminName, adminEmail, adminPhone, adminPassword, planSlug } = body;

    // Validação básica
    if (!companyName || !adminName || !adminEmail || !adminPassword) {
      return new Response(
        JSON.stringify({ error: "Campos obrigatórios: companyName, adminName, adminEmail, adminPassword" }), 
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (adminPassword.length < 6) {
      return new Response(
        JSON.stringify({ error: "A senha deve ter pelo menos 6 caracteres" }), 
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Gera slug da organização
    const slug = companyName
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");

    // Verifica se o slug já existe
    const { data: existingOrg } = await adminClient
      .from("organizations")
      .select("id")
      .eq("slug", slug)
      .single();

    if (existingOrg) {
      return new Response(
        JSON.stringify({ error: `Uma organização com o nome "${companyName}" já existe. Tente outro nome.` }), 
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verifica se o email já existe
    const { data: existingAuthUser } = await adminClient.auth.admin.listUsers();
    const emailExists = existingAuthUser?.users?.some(u => u.email === adminEmail);
    
    if (emailExists) {
      return new Response(
        JSON.stringify({ error: "Este email já está cadastrado" }), 
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Busca o plano
    const { data: plan } = await adminClient
      .from("plans")
      .select("*")
      .eq("slug", planSlug || "starter")
      .single();

    if (!plan) {
      return new Response(
        JSON.stringify({ error: `Plano "${planSlug}" não encontrado` }), 
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Cria a organização (com features opt-in habilitadas durante o trial)
    const { data: org, error: orgErr } = await adminClient
      .from("organizations")
      .insert({
        name: companyName,
        slug,
        primary_color: "#2D5A3D",
        logo_url: null,
        is_active: true,
        settings: {
          onboarding_completed: false,
          features: {
            nina: true,
          },
        },
      })
      .select()
      .single();

    if (orgErr) throw orgErr;

    // 2. Cria a subscription (trial por 14 dias)
    const now = new Date();
    const trialEnd = new Date(now.getTime() + 14 * 86400000);

    const { error: subErr } = await adminClient
      .from("subscriptions")
      .insert({
        org_id: org.id,
        plan_id: plan.id,
        status: "trial",
        trial_ends_at: trialEnd.toISOString(),
        current_period_start: now.toISOString(),
      });

    if (subErr) throw subErr;

    // 3. Cria o usuário no Supabase Auth
    const { data: authUser, error: authErr } = await adminClient.auth.admin.createUser({
      email: adminEmail,
      password: adminPassword,
      email_confirm: true,
      user_metadata: {
        name: adminName,
        phone: adminPhone
      }
    });

    if (authErr) throw authErr;

    // 4. Cria o perfil do usuário
    const { error: profileErr } = await adminClient
      .from("users")
      .insert({
        id: authUser.user.id,
        name: adminName,
        email: adminEmail,
        phone: adminPhone,
        role: "admin",
        org_id: org.id,
        is_active: true,
      });

    if (profileErr) throw profileErr;

    // Retorna sucesso com a URL de login (APP_URL é setado por ambiente — STG aponta pra sandbox)
    const loginUrl = Deno.env.get("APP_URL") || "https://app.raizesolucoes.com.br";

    return new Response(
      JSON.stringify({
        ok: true,
        org: {
          id: org.id,
          name: org.name,
          slug: org.slug
        },
        loginUrl,
        message: "Conta criada com sucesso! Você tem 14 dias de trial grátis."
      }), 
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (e) {
    console.error("Error in self-signup:", e);
    return new Response(
      JSON.stringify({ error: e.message || "Erro ao criar conta" }), 
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

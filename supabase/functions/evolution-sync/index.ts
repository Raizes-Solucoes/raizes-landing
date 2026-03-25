import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EVO_URL = "http://95.111.236.173:8080";
const EVO_KEY = "raizes-evo-2026-secret";

function normalizePhone(phone: string): string {
  // Remove WhatsApp suffixes
  let normalized = phone.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
  
  // Check if it's a group
  if (phone.includes('@g.us')) {
    normalized = phone.replace(/@g\.us$/, '-group');
  }
  
  return normalized;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No auth" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Verify authenticated user
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } }
    });
    
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Get user's organization
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    
    const { data: profile } = await adminClient
      .from('users')
      .select('org_id')
      .eq('id', user.id)
      .single();

    if (!profile?.org_id) {
      return new Response(JSON.stringify({ error: "No organization found" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const orgId = profile.org_id;

    // Get organization settings
    const { data: org } = await adminClient
      .from('organizations')
      .select('settings')
      .eq('id', orgId)
      .single();

    if (!org?.settings?.evolution_instance) {
      return new Response(JSON.stringify({ error: "Evolution instance not configured" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const instanceName = org.settings.evolution_instance;

    // Fetch chats from Evolution API
    const chatsRes = await fetch(`${EVO_URL}/chat/findChats/${instanceName}`, {
      headers: { "apikey": EVO_KEY }
    });

    if (!chatsRes.ok) {
      throw new Error(`Failed to fetch chats: ${chatsRes.statusText}`);
    }

    const allChats = await chatsRes.json();
    
    // Only sync the 30 most recent chats (avoid timeout with 400+ chats)
    const recentChats = allChats.slice(0, 30);
    
    let syncedChats = 0;
    let syncedMessages = 0;

    // Batch upsert chats (columns match actual whatsapp_chats table)
    const chatRows = recentChats.map((chat: any) => {
      const phoneNumber = normalizePhone(chat.id);
      return {
        org_id: orgId,
        phone_number: phoneNumber,
        custom_name: chat.name || chat.pushName || phoneNumber,
        is_group: phoneNumber.endsWith('-group'),
        group_subject: phoneNumber.endsWith('-group') ? (chat.subject || null) : null,
        updated_at: new Date().toISOString()
      };
    });

    const { error: batchErr, count } = await adminClient
      .from('whatsapp_chats')
      .upsert(chatRows, { onConflict: 'org_id,phone_number', count: 'exact' });

    if (batchErr) {
      console.error('Upsert error:', batchErr);
    }
    syncedChats = count || chatRows.length;

    return new Response(JSON.stringify({
      synced: syncedChats,
      messages: syncedMessages,
      total: allChats.length
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (e) {
    console.error('Evolution sync error:', e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EVO_URL = "http://95.111.236.173:8080";
const EVO_KEY = "raizes-evo-2026-secret";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response(JSON.stringify({ error: "No auth" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const body = await req.json();
    const { orgId, chatId, phone, message, messageType = 'text', mediaUrl, caption, fileName } = body;

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Get org settings
    const { data: org } = await adminClient.from('organizations').select('settings').eq('id', orgId).single();
    if (!org?.settings?.evolution_instance) return new Response(JSON.stringify({ error: "Evolution instance not configured" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const instanceName = org.settings.evolution_instance;
    const cleanPhone = phone.replace(/\D/g, '');

    // Send via Evolution API
    let endpoint: string;
    let requestBody: any;

    switch (messageType) {
      case 'image':
        endpoint = `${EVO_URL}/message/sendMedia/${instanceName}`;
        requestBody = { number: cleanPhone, mediatype: 'image', media: mediaUrl, caption: caption || '' };
        break;
      case 'video':
        endpoint = `${EVO_URL}/message/sendMedia/${instanceName}`;
        requestBody = { number: cleanPhone, mediatype: 'video', media: mediaUrl, caption: caption || '' };
        break;
      case 'audio':
        endpoint = `${EVO_URL}/message/sendMedia/${instanceName}`;
        requestBody = { number: cleanPhone, mediatype: 'audio', media: mediaUrl };
        break;
      case 'document':
        endpoint = `${EVO_URL}/message/sendMedia/${instanceName}`;
        requestBody = { number: cleanPhone, mediatype: 'document', media: mediaUrl, fileName: fileName || 'document' };
        break;
      default: // text
        endpoint = `${EVO_URL}/message/sendText/${instanceName}`;
        requestBody = { number: cleanPhone, text: message };
    }

    const sendRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVO_KEY },
      body: JSON.stringify(requestBody)
    });

    if (!sendRes.ok) {
      const err = await sendRes.text();
      throw new Error(`Evolution API: ${sendRes.status} - ${err}`);
    }

    const evoResponse = await sendRes.json();
    const zapiMessageId = evoResponse.key?.id || `sent-${Date.now()}`;
    const content = message || caption || `[${messageType}]`;
    const now = new Date().toISOString();

    // Save to DB (correct columns: direction, sent_by, zapi_message_id, participant_phone, participant_name)
    if (chatId) {
      await adminClient.from('whatsapp_messages').insert({
        chat_id: chatId,
        org_id: orgId,
        content,
        message_type: messageType,
        media_url: mediaUrl || null,
        mime_type: null,
        file_name: fileName || null,
        direction: 'outbound',
        sent_by: user.id,
        is_read: true,
        status: 'sent',
        zapi_message_id: zapiMessageId,
        timestamp: now,
      });

      // Update chat
      await adminClient.from('whatsapp_chats').update({
        last_message_content: content,
        last_message_at: now,
        last_message_direction: 'outbound',
        updated_at: now,
      }).eq('id', chatId);
    }

    return new Response(JSON.stringify({ ok: true, messageId: zapiMessageId, chatId }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error('Evolution send error:', e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

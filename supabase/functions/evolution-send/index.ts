import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EVO_URL = "http://95.111.236.173:8080";
const EVO_KEY = "raizes-evo-2026-secret";

function normalizePhone(phone: string): string {
  // Remove WhatsApp suffixes if present
  let normalized = phone.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
  
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

    const body = await req.json();
    const { orgId, chatId, phone, message, messageType = 'text', mediaUrl, caption, fileName } = body;

    if (!orgId || !phone || (!message && !mediaUrl)) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Get organization settings
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    
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

    // Prepare phone number (Evolution expects format like 5511999999999)
    const cleanPhone = phone.replace(/\D/g, '');

    // Send message based on type
    let evoResponse;
    let endpoint;
    let requestBody;

    switch (messageType) {
      case 'text':
        endpoint = `${EVO_URL}/message/sendText/${instanceName}`;
        requestBody = {
          number: cleanPhone,
          text: message
        };
        break;

      case 'image':
        endpoint = `${EVO_URL}/message/sendMedia/${instanceName}`;
        requestBody = {
          number: cleanPhone,
          mediatype: 'image',
          media: mediaUrl,
          caption: caption || ''
        };
        break;

      case 'video':
        endpoint = `${EVO_URL}/message/sendMedia/${instanceName}`;
        requestBody = {
          number: cleanPhone,
          mediatype: 'video',
          media: mediaUrl,
          caption: caption || ''
        };
        break;

      case 'audio':
        endpoint = `${EVO_URL}/message/sendMedia/${instanceName}`;
        requestBody = {
          number: cleanPhone,
          mediatype: 'audio',
          media: mediaUrl
        };
        break;

      case 'document':
        endpoint = `${EVO_URL}/message/sendMedia/${instanceName}`;
        requestBody = {
          number: cleanPhone,
          mediatype: 'document',
          media: mediaUrl,
          fileName: fileName || 'document'
        };
        break;

      default:
        return new Response(JSON.stringify({ error: "Invalid message type" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
    }

    // Send to Evolution API
    const sendRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': EVO_KEY
      },
      body: JSON.stringify(requestBody)
    });

    if (!sendRes.ok) {
      const errorText = await sendRes.text();
      throw new Error(`Evolution API error: ${sendRes.status} - ${errorText}`);
    }

    evoResponse = await sendRes.json();
    const messageId = evoResponse.key?.id || `sent-${Date.now()}`;

    // Save message to database
    const messageContent = message || caption || `[${messageType}]`;
    const timestamp = new Date().toISOString();

    // Get or create chat
    let chatDbId = chatId;
    
    if (!chatDbId) {
      const normalizedPhone = normalizePhone(phone);
      const { data: existingChat } = await adminClient
        .from('whatsapp_chats')
        .select('id')
        .eq('org_id', orgId)
        .eq('phone_number', normalizedPhone)
        .single();

      if (existingChat) {
        chatDbId = existingChat.id;
      } else {
        // Create new chat
        const { data: newChat, error: chatErr } = await adminClient
          .from('whatsapp_chats')
          .insert({
            org_id: orgId,
            phone_number: normalizedPhone,
            contact_name: normalizedPhone,
            is_group: normalizedPhone.endsWith('-group'),
            created_at: timestamp,
            updated_at: timestamp
          })
          .select('id')
          .single();

        if (chatErr) {
          console.error('Failed to create chat:', chatErr);
        } else {
          chatDbId = newChat.id;
        }
      }
    }

    // Save message
    if (chatDbId) {
      await adminClient
        .from('whatsapp_messages')
        .insert({
          chat_id: chatDbId,
          org_id: orgId,
          message_id: messageId,
          content: messageContent,
          message_type: messageType,
          media_url: mediaUrl || null,
          mime_type: null,
          file_name: fileName || null,
          is_from_me: true,
          sender_name: 'Me',
          sender_phone: cleanPhone,
          timestamp,
          status: 'sent',
          created_at: timestamp
        });

      // Update chat's last message
      await adminClient
        .from('whatsapp_chats')
        .update({
          last_message: messageContent,
          last_message_at: timestamp,
          updated_at: timestamp
        })
        .eq('id', chatDbId);
    }

    return new Response(JSON.stringify({
      ok: true,
      messageId,
      chatId: chatDbId
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (e) {
    console.error('Evolution send error:', e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});

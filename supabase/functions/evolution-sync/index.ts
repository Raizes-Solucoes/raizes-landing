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

    const chatsData = await chatsRes.json();
    let syncedChats = 0;
    let syncedMessages = 0;

    // Process each chat
    for (const chat of chatsData) {
      const phoneNumber = normalizePhone(chat.id);
      const isGroup = phoneNumber.endsWith('-group');

      // Upsert chat
      const { error: chatError } = await adminClient
        .from('whatsapp_chats')
        .upsert({
          org_id: orgId,
          phone_number: phoneNumber,
          contact_name: chat.name || chat.pushName || phoneNumber,
          is_group: isGroup,
          profile_pic_url: chat.profilePicUrl || null,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'org_id,phone_number'
        });

      if (!chatError) syncedChats++;

      // Fetch recent messages for this chat
      try {
        const messagesRes = await fetch(
          `${EVO_URL}/chat/findMessages/${instanceName}?limit=50&where[key.remoteJid]=${chat.id}`,
          { headers: { "apikey": EVO_KEY } }
        );

        if (messagesRes.ok) {
          const messagesData = await messagesRes.json();

          for (const msg of messagesData) {
            const messageId = msg.key?.id || `${Date.now()}-${Math.random()}`;
            const isFromMe = msg.key?.fromMe || false;
            const timestamp = msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000).toISOString() : new Date().toISOString();

            // Extract message content
            let content = '';
            let messageType = 'text';
            let mediaUrl = null;
            let mimeType = null;
            let fileName = null;

            if (msg.message?.conversation) {
              content = msg.message.conversation;
            } else if (msg.message?.extendedTextMessage) {
              content = msg.message.extendedTextMessage.text || '';
            } else if (msg.message?.imageMessage) {
              messageType = 'image';
              content = msg.message.imageMessage.caption || '[Image]';
              mediaUrl = msg.message.imageMessage.url || null;
              mimeType = msg.message.imageMessage.mimetype || null;
            } else if (msg.message?.videoMessage) {
              messageType = 'video';
              content = msg.message.videoMessage.caption || '[Video]';
              mediaUrl = msg.message.videoMessage.url || null;
              mimeType = msg.message.videoMessage.mimetype || null;
            } else if (msg.message?.audioMessage) {
              messageType = 'audio';
              content = '[Audio]';
              mediaUrl = msg.message.audioMessage.url || null;
              mimeType = msg.message.audioMessage.mimetype || null;
            } else if (msg.message?.documentMessage) {
              messageType = 'document';
              content = '[Document]';
              mediaUrl = msg.message.documentMessage.url || null;
              mimeType = msg.message.documentMessage.mimetype || null;
              fileName = msg.message.documentMessage.fileName || null;
            }

            // Get chat_id
            const { data: chatData } = await adminClient
              .from('whatsapp_chats')
              .select('id')
              .eq('org_id', orgId)
              .eq('phone_number', phoneNumber)
              .single();

            if (chatData) {
              // Upsert message
              const { error: msgError } = await adminClient
                .from('whatsapp_messages')
                .upsert({
                  chat_id: chatData.id,
                  org_id: orgId,
                  message_id: messageId,
                  content,
                  message_type: messageType,
                  media_url: mediaUrl,
                  mime_type: mimeType,
                  file_name: fileName,
                  is_from_me: isFromMe,
                  sender_name: msg.pushName || null,
                  sender_phone: msg.key?.participant ? normalizePhone(msg.key.participant) : phoneNumber,
                  timestamp,
                  status: 'delivered',
                  created_at: timestamp
                }, {
                  onConflict: 'message_id,chat_id'
                });

              if (!msgError) {
                syncedMessages++;
                
                // Update chat's last message
                await adminClient
                  .from('whatsapp_chats')
                  .update({
                    last_message: content,
                    last_message_at: timestamp,
                    updated_at: new Date().toISOString()
                  })
                  .eq('id', chatData.id);
              }
            }
          }
        }
      } catch (msgErr) {
        console.error(`Failed to fetch messages for chat ${phoneNumber}:`, msgErr);
      }
    }

    return new Response(JSON.stringify({
      synced: syncedChats,
      messages: syncedMessages
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

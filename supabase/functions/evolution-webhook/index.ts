import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const { event, instance, data } = body;

    console.log('Received webhook event:', event, 'for instance:', instance);

    // Handle different event types
    if (event === 'messages.upsert') {
      // Find organization by instance name
      const { data: orgs } = await adminClient
        .from('organizations')
        .select('id, settings')
        .contains('settings', { evolution_instance: instance });

      if (!orgs || orgs.length === 0) {
        console.log('No organization found for instance:', instance);
        return new Response(JSON.stringify({ ok: true, message: 'No org found' }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      const org = orgs[0];
      const orgId = org.id;

      // Process messages
      for (const msg of data) {
        const remoteJid = msg.key?.remoteJid;
        if (!remoteJid) continue;

        const phoneNumber = normalizePhone(remoteJid);
        const isGroup = phoneNumber.endsWith('-group');
        const isFromMe = msg.key?.fromMe || false;
        const messageId = msg.key?.id || `${Date.now()}-${Math.random()}`;
        const timestamp = msg.messageTimestamp 
          ? new Date(msg.messageTimestamp * 1000).toISOString() 
          : new Date().toISOString();

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

        const contactName = msg.pushName || phoneNumber;

        // Upsert chat
        const { data: chatData, error: chatError } = await adminClient
          .from('whatsapp_chats')
          .upsert({
            org_id: orgId,
            phone_number: phoneNumber,
            contact_name: contactName,
            is_group: isGroup,
            last_message: content,
            last_message_at: timestamp,
            updated_at: timestamp
          }, {
            onConflict: 'org_id,phone_number',
            returning: 'representation'
          })
          .select('id')
          .single();

        if (chatError) {
          console.error('Failed to upsert chat:', chatError);
          continue;
        }

        const chatId = chatData.id;

        // If message is not from us, increment unread count
        if (!isFromMe) {
          await adminClient
            .from('whatsapp_chats')
            .update({
              unread_count: adminClient.rpc('increment', { chat_id: chatId })
            })
            .eq('id', chatId);
        }

        // Upsert message
        const senderPhone = msg.key?.participant 
          ? normalizePhone(msg.key.participant) 
          : phoneNumber;

        const { error: msgError } = await adminClient
          .from('whatsapp_messages')
          .upsert({
            chat_id: chatId,
            org_id: orgId,
            message_id: messageId,
            content,
            message_type: messageType,
            media_url: mediaUrl,
            mime_type: mimeType,
            file_name: fileName,
            is_from_me: isFromMe,
            sender_name: msg.pushName || null,
            sender_phone: senderPhone,
            timestamp,
            status: 'delivered',
            created_at: timestamp
          }, {
            onConflict: 'message_id,chat_id'
          });

        if (msgError) {
          console.error('Failed to upsert message:', msgError);
        }
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (event === 'connection.update') {
      console.log('Connection update for instance:', instance, data);
      // You can store connection status in org settings if needed
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (event === 'qrcode.updated') {
      console.log('QR code updated for instance:', instance);
      // You can store the QR code in org settings if needed
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Unknown event type - just acknowledge
    console.log('Unknown event type:', event);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (e) {
    console.error('Evolution webhook error:', e);
    // Always return 200 to prevent Evolution API from retrying
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});

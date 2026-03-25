import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function normalizePhone(phone: string): string {
  if (phone.includes('@g.us')) return phone.replace(/@g\.us$/, '-group');
  return phone.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '').replace(/@lid$/, '');
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const event = body.event || body.data?.event;
    const instance = body.instance || body.data?.instance;

    // Only process message events
    if (!['messages.upsert', 'MESSAGES_UPSERT'].includes(event)) {
      return new Response(JSON.stringify({ ok: true, skipped: event }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Find org by instance name
    const instanceName = instance?.instanceName || instance;
    const { data: orgs } = await adminClient.from('organizations').select('id').filter('settings->>evolution_instance', 'eq', instanceName);
    if (!orgs || orgs.length === 0) {
      return new Response(JSON.stringify({ ok: true, skipped: 'no org' }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const orgId = orgs[0].id;

    // Process messages
    const messages = body.data?.message ? [body.data] : (body.data || []);
    
    for (const msgData of (Array.isArray(messages) ? messages : [messages])) {
      const msg = msgData.message ? msgData : { key: msgData.key, message: msgData.message, pushName: msgData.pushName, messageTimestamp: msgData.messageTimestamp, messageType: msgData.messageType };
      if (!msg.key) continue;

      const remoteJid = msg.key.remoteJid || '';
      const phone = normalizePhone(remoteJid);
      const isFromMe = msg.key.fromMe || false;
      const zapiId = msg.key.id || `wh-${Date.now()}`;
      const ts = msg.messageTimestamp ? new Date((msg.messageTimestamp > 9999999999 ? msg.messageTimestamp : msg.messageTimestamp * 1000)).toISOString() : new Date().toISOString();

      // Extract content
      const m = msg.message || {};
      let content = m.conversation || m.extendedTextMessage?.text || '';
      let messageType = 'text';
      let mediaUrl = null;
      let mimeType = null;
      let fileName = null;

      if (m.imageMessage) { messageType = 'image'; content = m.imageMessage.caption || '[Imagem]'; mimeType = m.imageMessage.mimetype; }
      else if (m.videoMessage) { messageType = 'video'; content = m.videoMessage.caption || '[Vídeo]'; mimeType = m.videoMessage.mimetype; }
      else if (m.audioMessage) { messageType = 'audio'; content = '[Áudio]'; mimeType = m.audioMessage.mimetype; }
      else if (m.documentMessage) { messageType = 'document'; content = m.documentMessage.fileName || '[Documento]'; fileName = m.documentMessage.fileName; mimeType = m.documentMessage.mimetype; }
      else if (m.stickerMessage) { messageType = 'sticker'; content = '[Sticker]'; }
      
      if (!content) continue;

      // Upsert chat
      await adminClient.from('whatsapp_chats').upsert({
        org_id: orgId,
        phone_number: phone,
        custom_name: msg.pushName || phone,
        is_group: phone.endsWith('-group'),
        last_message_content: content,
        last_message_at: ts,
        last_message_direction: isFromMe ? 'outbound' : 'inbound',
        last_message_is_read: isFromMe,
        unread_count: isFromMe ? 0 : 1,
        updated_at: new Date().toISOString()
      }, { onConflict: 'org_id,phone_number' });

      // Get chat id
      const { data: chatDb } = await adminClient.from('whatsapp_chats').select('id').eq('org_id', orgId).eq('phone_number', phone).single();
      if (!chatDb) continue;

      // Insert message
      await adminClient.from('whatsapp_messages').insert({
        chat_id: chatDb.id,
        org_id: orgId,
        content,
        message_type: messageType,
        media_url: mediaUrl,
        mime_type: mimeType,
        file_name: fileName,
        direction: isFromMe ? 'outbound' : 'inbound',
        is_read: isFromMe,
        status: 'delivered',
        zapi_message_id: zapiId,
        timestamp: ts,
        participant_phone: msg.key.participant ? normalizePhone(msg.key.participant) : (isFromMe ? null : phone),
        participant_name: msg.pushName || null,
      });
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error('Evolution webhook error:', e);
    return new Response(JSON.stringify({ ok: true, error: e.message }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

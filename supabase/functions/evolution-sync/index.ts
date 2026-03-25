import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const EVO_URL = "http://95.111.236.173:8080";
const EVO_KEY = "raizes-evo-2026-secret";

function normalizePhone(phone: string): string {
  if (phone.includes('@g.us')) return phone.replace(/@g\.us$/, '-group');
  return phone.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '').replace(/@lid$/, '');
}

function extractContent(msg: any): { content: string; messageType: string; mediaUrl: string | null; mimeType: string | null; fileName: string | null } {
  const m = msg.message || {};
  if (m.conversation) return { content: m.conversation, messageType: 'text', mediaUrl: null, mimeType: null, fileName: null };
  if (m.extendedTextMessage?.text) return { content: m.extendedTextMessage.text, messageType: 'text', mediaUrl: null, mimeType: null, fileName: null };
  if (m.imageMessage) return { content: m.imageMessage.caption || '[Imagem]', messageType: 'image', mediaUrl: m.imageMessage.url || null, mimeType: m.imageMessage.mimetype || null, fileName: null };
  if (m.videoMessage) return { content: m.videoMessage.caption || '[Vídeo]', messageType: 'video', mediaUrl: m.videoMessage.url || null, mimeType: m.videoMessage.mimetype || null, fileName: null };
  if (m.audioMessage) return { content: '[Áudio]', messageType: 'audio', mediaUrl: m.audioMessage.url || null, mimeType: m.audioMessage.mimetype || null, fileName: null };
  if (m.documentMessage) return { content: m.documentMessage.fileName || '[Documento]', messageType: 'document', mediaUrl: m.documentMessage.url || null, mimeType: m.documentMessage.mimetype || null, fileName: m.documentMessage.fileName || null };
  if (m.stickerMessage) return { content: '[Sticker]', messageType: 'sticker', mediaUrl: null, mimeType: null, fileName: null };
  if (m.contactMessage) return { content: m.contactMessage.displayName || '[Contato]', messageType: 'contact', mediaUrl: null, mimeType: null, fileName: null };
  if (m.locationMessage) return { content: '[Localização]', messageType: 'location', mediaUrl: null, mimeType: null, fileName: null };
  if (msg.messageType === 'reactionMessage') return { content: '', messageType: 'reaction', mediaUrl: null, mimeType: null, fileName: null };
  return { content: `[${msg.messageType || 'mensagem'}]`, messageType: msg.messageType || 'unknown', mediaUrl: null, mimeType: null, fileName: null };
}

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

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    const { data: profile } = await adminClient.from('users').select('org_id').eq('id', user.id).single();
    if (!profile?.org_id) return new Response(JSON.stringify({ error: "No organization found" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const orgId = profile.org_id;
    const { data: org } = await adminClient.from('organizations').select('settings').eq('id', orgId).single();
    if (!org?.settings?.evolution_instance) return new Response(JSON.stringify({ error: "Evolution instance not configured" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const instanceName = org.settings.evolution_instance;

    // 1. Fetch chats
    const chatsRes = await fetch(`${EVO_URL}/chat/findChats/${instanceName}`, { headers: { "apikey": EVO_KEY } });
    if (!chatsRes.ok) throw new Error(`Failed to fetch chats: ${chatsRes.statusText}`);
    const allChats = await chatsRes.json();

    // 2. Fetch contacts for names
    let contactMap: Record<string, string> = {};
    try {
      const contactsRes = await fetch(`${EVO_URL}/chat/findContacts/${instanceName}`, { headers: { "apikey": EVO_KEY } });
      if (contactsRes.ok) {
        const contacts = await contactsRes.json();
        for (const c of contacts) {
          const phone = normalizePhone(c.id || '');
          contactMap[phone] = c.pushName || c.name || c.verifiedName || phone;
        }
      }
    } catch {}

    // 3. Upsert top 30 chats
    const recentChats = allChats.slice(0, 30);
    const chatRows = recentChats.map((chat: any) => {
      const phone = normalizePhone(chat.id);
      const name = contactMap[phone] || chat.name || chat.pushName || phone;
      return {
        org_id: orgId,
        phone_number: phone,
        custom_name: name,
        is_group: phone.endsWith('-group'),
        group_subject: phone.endsWith('-group') ? (chat.subject || null) : null,
        updated_at: new Date().toISOString()
      };
    });

    const { error: chatErr } = await adminClient.from('whatsapp_chats').upsert(chatRows, { onConflict: 'org_id,phone_number' });
    if (chatErr) console.error('Chat upsert error:', chatErr);
    const syncedChats = chatErr ? 0 : chatRows.length;

    // 4. Fetch messages for top 10 chats (limited to 20 msgs each)
    let syncedMessages = 0;
    const topChats = recentChats.slice(0, 10);

    for (const chat of topChats) {
      const phone = normalizePhone(chat.id);
      try {
        const msgsRes = await fetch(`${EVO_URL}/chat/findMessages/${instanceName}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': EVO_KEY },
          body: JSON.stringify({ where: { key: { remoteJid: chat.id } }, limit: 20 })
        });
        if (!msgsRes.ok) continue;
        const msgs = await msgsRes.json();
        if (!Array.isArray(msgs) || msgs.length === 0) continue;

        // Get chat DB id
        const { data: chatDb } = await adminClient.from('whatsapp_chats').select('id').eq('org_id', orgId).eq('phone_number', phone).single();
        if (!chatDb) continue;

        const msgRows: any[] = [];
        let lastMsg: any = null;

        for (const msg of msgs) {
          const { content, messageType, mediaUrl, mimeType, fileName } = extractContent(msg);
          if (messageType === 'reaction' || !content) continue;

          const isFromMe = msg.key?.fromMe || false;
          const ts = msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000).toISOString() : new Date().toISOString();
          const zapiId = msg.key?.id || `evo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

          msgRows.push({
            chat_id: chatDb.id,
            org_id: orgId,
            content,
            message_type: messageType,
            media_url: mediaUrl,
            mime_type: mimeType,
            file_name: fileName,
            direction: isFromMe ? 'outbound' : 'inbound',
            sent_by: isFromMe ? user.id : null,
            is_read: isFromMe,
            status: 'delivered',
            zapi_message_id: zapiId,
            timestamp: ts,
            participant_phone: msg.key?.participant ? normalizePhone(msg.key.participant) : (isFromMe ? null : phone),
            participant_name: msg.pushName || null,
          });

          if (!lastMsg || new Date(ts) > new Date(lastMsg.ts)) {
            lastMsg = { content, ts, direction: isFromMe ? 'outbound' : 'inbound' };
          }
        }

        if (msgRows.length > 0) {
          // Need unique constraint on zapi_message_id for upsert — use insert with ignoreDuplicates
          const { error: msgErr, count } = await adminClient.from('whatsapp_messages').upsert(msgRows, { onConflict: 'id', ignoreDuplicates: true, count: 'exact' });
          if (msgErr) console.error('Msg insert error:', msgErr);
          else syncedMessages += count || msgRows.length;
        }

        // Update chat last message
        if (lastMsg) {
          await adminClient.from('whatsapp_chats').update({
            last_message_content: lastMsg.content,
            last_message_at: lastMsg.ts,
            last_message_direction: lastMsg.direction,
            updated_at: new Date().toISOString()
          }).eq('id', chatDb.id);
        }
      } catch (e) {
        console.error(`Msg fetch error for ${phone}:`, e);
      }
    }

    return new Response(JSON.stringify({ synced: syncedChats, messages: syncedMessages, total: allChats.length }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error('Evolution sync error:', e);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

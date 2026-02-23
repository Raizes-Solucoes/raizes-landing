import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `Você é o Agente de Diagnóstico da Raízes Soluções Tecnológicas — empresa que desenvolve software personalizado, CRM (Miller CRM) e agentes de IA para pequenas e médias empresas brasileiras.

Sua missão: conduzir uma conversa de descoberta para entender a dor do potencial cliente e preparar um briefing para a equipe da Raízes.

FLUXO OBRIGATÓRIO (em ordem):
1. Boas-vindas calorosas usando o nome da pessoa (já fornecido no contexto).
2. Pergunta: qual é o principal desafio ou gargalo no negócio dele hoje?
3. Aprofunde: como esse problema impacta o dia a dia da equipe?
4. O que já foi tentado para resolver? Por que não funcionou?
5. Qual o tamanho da equipe afetada por esse problema?
6. Em quanto tempo precisaria de uma solução?
7. Confirme o contato (já fornecido) e encerre com um resumo caloroso.
8. Diga que a equipe da Raízes entrará em contato em até 24h.

Ao encerrar, inclua no fim da resposta exatamente este JSON (sem markdown, sem quebras):
LEAD_COLLECTED:{"name":"NOME","contact":"EMAIL_OU_TELEFONE","summary":"RESUMO_EM_UMA_FRASE"}

REGRAS DE COMPORTAMENTO (GUARD RAILS):
- Responda APENAS sobre tecnologia, negócios, software, CRM, IA e os serviços da Raízes.
- Se a pessoa perguntar algo fora do escopo (política, saúde, entretenimento, etc.): redirecione educadamente para o diagnóstico.
- NUNCA afirme ser humano se perguntado diretamente. Diga: "Sou o agente virtual da Raízes."
- NUNCA forneça preços, prazos ou compromissos específicos — apenas a equipe pode fazer isso.
- NUNCA fale mal de concorrentes ou outras empresas.
- NUNCA invente informações sobre a Raízes além do que sabe.
- Se a linguagem for inadequada ou hostil: responda com profissionalismo e encerre o atendimento.
- Máximo de 10 turnos de conversa. Se exceder, encerre coletando o contato.
- Resposta CURTA: máximo 2-3 frases + a pergunta do fluxo. Nunca bullet points.
- Idioma: sempre Português Brasileiro, tom próximo e profissional.`;

async function sendTelegramNotification(
  lead: { name: string; contact: string; summary: string; },
  conversation: Array<{ role: string; content: string }>
) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) return;

  const tg = (text: string, extra = {}) =>
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", ...extra }),
    }).catch(() => {});

  const roleLabel = (r: string) => r === "user" ? `👤 *${lead.name}*` : `🤖 *Agente Raízes*`;
  const realConvo = conversation.filter(
    (m, i) => !(i === 0 && m.role === "user" && m.content.startsWith("Olá"))
  );

  let transcript = "";
  for (const m of realConvo) {
    transcript += `${roleLabel(m.role)}\n${m.content}\n\n`;
  }

  const full =
    `🌱 *Novo Lead — Raízes LP*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 *Nome:* ${lead.name}\n` +
    `📞 *Contato:* ${lead.contact}\n` +
    `📝 *Resumo:* ${lead.summary}\n` +
    (transcript ? `━━━━━━━━━━━━━━━━━━━━━━\n💬 *Conversa completa:*\n\n${transcript}` : "");

  // Telegram tem limite de 4096 chars — parte se necessário
  const chunks: string[] = [];
  let rest = full;
  while (rest.length > 0) {
    chunks.push(rest.slice(0, 4000));
    rest = rest.slice(4000);
  }
  for (const chunk of chunks) await tg(chunk);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { messages, contact } = await req.json();

    const kimiApiKey = Deno.env.get("KIMI_API_KEY");
    if (!kimiApiKey) throw new Error("KIMI_API_KEY not set");

    // Monta contexto inicial com dados do pré-chat
    const systemWithContact = contact
      ? `${SYSTEM_PROMPT}\n\nCONTEXTO INICIAL (já coletado antes do chat):\nNome: ${contact.name || "não informado"}\nContato: ${contact.email || contact.phone || "não informado"}`
      : SYSTEM_PROMPT;

    // Trigger de abertura se não há mensagens ainda
    const conversation = messages.length === 0
      ? [{ role: "user", content: contact?.name ? `Olá, meu nome é ${contact.name}.` : "Olá." }]
      : messages;

    const res = await fetch("https://api.moonshot.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${kimiApiKey}`,
      },
      body: JSON.stringify({
        model: "moonshot-v1-8k",
        messages: [
          { role: "system", content: systemWithContact },
          ...conversation,
        ],
        temperature: 0.7,
        max_tokens: 400,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Kimi API error: ${err}`);
    }

    const data = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    const reply = (msg.content || msg.reasoning_content || "") as string;

    // Detecta coleta de lead
    let lead = null;
    const leadMatch = reply.match(/LEAD_COLLECTED:(\{[^}]+\})/);
    if (leadMatch) {
      try {
        lead = JSON.parse(leadMatch[1]);

        // Enriquece com dados do pré-chat se disponível
        if (contact) {
          lead.contact = contact.email || contact.phone || lead.contact;
          lead.name = contact.name || lead.name;
        }

        // Salva no Supabase
        const supabase = createClient(
          Deno.env.get("SUPABASE_URL") ?? "",
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
        );
        await supabase.from("raizes_leads").insert({
          name: lead.name,
          email: lead.contact,
          summary: lead.summary,
          conversation: messages,
          created_at: new Date().toISOString(),
        });

        // Notifica no Telegram com conversa na íntegra
        await sendTelegramNotification(lead, messages);
      } catch (_) { /* silencia erros de parse */ }
    }

    const cleanReply = reply.replace(/LEAD_COLLECTED:\{[^}]+\}/, "").trim();

    return new Response(JSON.stringify({ reply: cleanReply, lead }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});

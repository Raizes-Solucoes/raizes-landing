import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `Você é o Agente de Diagnóstico da Raízes Soluções Tecnológicas — uma empresa que constrói software personalizado, CRM e agentes de IA.

Sua missão: conduzir uma conversa de descoberta amigável e profissional com potenciais clientes para entender a dor real deles antes de conectá-los com a equipe.

FLUXO OBRIGATÓRIO (em ordem):
1. Boas-vindas calorosas + pergunta: o que trouxe a pessoa até aqui hoje?
2. Aprofunde a dor principal: como isso impacta o dia a dia do negócio?
3. O que já foi tentado para resolver? Por que não funcionou?
4. Quantas pessoas da equipe são afetadas por esse problema?
5. Em quanto tempo precisaria de uma solução?
6. Colete: nome completo e e-mail de contato.
7. Agradeça, faça um resumo caloroso da conversa e diga que a equipe da Raízes entrará em contato em até 24h.

REGRAS:
- Faça UMA pergunta por vez. Nunca duas.
- Respostas curtas: máximo 2-3 frases + a pergunta.
- Tom: próximo, humano, curioso — como um consultor experiente, não um robô.
- Idioma: Português Brasileiro, informal mas profissional.
- Nunca mencione concorrentes.
- Nunca invente dados sobre a Raízes.
- Quando tiver nome + email, inclua no fim da resposta exatamente este JSON (sem markdown):
LEAD_COLLECTED:{"name":"NOME","email":"EMAIL","summary":"RESUMO_DA_CONVERSA"}`;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { messages } = await req.json();

    const kimiApiKey = Deno.env.get("KIMI_API_KEY");
    if (!kimiApiKey) throw new Error("KIMI_API_KEY not set");

    // Se não há mensagens, injeta um trigger para o agente se apresentar
    const conversation = messages.length === 0
      ? [{ role: "user", content: "Olá, gostaria de entender mais sobre os serviços da Raízes." }]
      : messages;

    // Chama a API do Kimi (OpenAI-compatible)
    const res = await fetch("https://api.moonshot.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${kimiApiKey}`,
      },
      body: JSON.stringify({
        model: "kimi-latest",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...conversation,
        ],
        temperature: 1,
        max_tokens: 512,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Kimi API error: ${err}`);
    }

    const data = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    // kimi-k2.5 é reasoning model — content pode vir em reasoning_content
    const reply = (msg.content || msg.reasoning_content || "") as string;

    // Verifica se um lead foi coletado
    let lead = null;
    const leadMatch = reply.match(/LEAD_COLLECTED:(\{.*\})/);
    if (leadMatch) {
      lead = JSON.parse(leadMatch[1]);
      // Salva lead no Supabase
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
      );
      await supabase.from("raizes_leads").insert({
        name: lead.name,
        email: lead.email,
        summary: lead.summary,
        conversation: messages,
        created_at: new Date().toISOString(),
      });
    }

    // Remove o marcador do texto visível
    const cleanReply = reply.replace(/LEAD_COLLECTED:\{.*\}/, "").trim();

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

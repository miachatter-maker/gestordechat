// Proxy serverless (Vercel) para o Google Gemini API — 100% gratuito, sem
// cartão de crédito (Google AI Studio: aistudio.google.com/apikey).
//
// A chave fica só aqui no servidor (variável de ambiente GEMINI_API_KEY),
// nunca no código do navegador. O app.js chama este endpoint (/api/claude)
// exatamente como chamava a API da Anthropic antes — este arquivo traduz
// o pedido/resposta para o formato do Gemini por dentro, então NADA no
// app.js precisa mudar.

// gemini-2.0-flash tem cota gratuita maior que gemini-2.5-flash (mais
// requisições por minuto e por dia, sem custo, sem cartão) — trocado porque
// o app estava batendo no limite de 20 req/min do flash normal com uso leve
// de teste (Mapeamento, ChatLab, Orientação dividem a mesma cota).
// Obs: 'gemini-2.5-flash-lite' foi tentado primeiro mas essa chave/projeto
// não tem acesso a ele ("no longer available to new users").
const GEMINI_MODEL = 'gemini-2.0-flash';

// Se o Gemini responder 429 (limite momentâneo), tenta de novo sozinho
// antes de devolver erro pro app — evita que uma janela de poucos segundos
// de pico vire uma falha visível pra quem está usando. Mantido curto de
// propósito (no máximo ~4s de espera total) pra não estourar o tempo
// limite da função serverless da Vercel (padrão 10s no plano gratuito).
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async function handler(req, res) {
  // CORS — permite chamar este proxy mesmo de outro domínio (ex: GitHub Pages)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido — use POST' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'GEMINI_API_KEY não configurada no servidor. Vá em Vercel → Settings → Environment Variables, adicione GEMINI_API_KEY com a chave gratuita do Google AI Studio (aistudio.google.com/apikey), e faça um redeploy.'
    });
    return;
  }

  try {
    const { max_tokens, system, messages } = req.body || {};
    if (!messages || !messages.length) {
      res.status(400).json({ error: 'Corpo da requisição inválido — faltou "messages"' });
      return;
    }

    // Traduz o formato Anthropic (messages:[{role,content}]) para o formato Gemini (contents:[{role,parts}])
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
    }));

    const geminiBody = {
      contents,
      generationConfig: { maxOutputTokens: max_tokens || 2000 }
    };
    if (system) geminiBody.systemInstruction = { parts: [{ text: system }] };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

    let upstream, data;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody)
      });
      data = await upstream.json();
      if (upstream.status !== 429) break; // só espera e tenta de novo em caso de limite de uso
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
    }

    if (!upstream.ok) {
      const msg = data?.error?.message || 'Erro ao chamar o Gemini';
      let friendly = msg;
      if (upstream.status === 429) {
        // O Gemini manda quanto tempo esperar dentro da própria mensagem
        // de erro (ex: "Please retry in 47.3s") — extrai esse número em vez
        // de um "espere um pouco" genérico, pra dar um tempo real pra pessoa.
        const waitM = msg.match(/retry in ([\d.]+)s/i);
        const waitS = waitM ? Math.ceil(parseFloat(waitM[1])) : null;
        friendly = waitS
          ? `Limite de uso da IA no momento — espere cerca de ${waitS}s e tente de novo.`
          : 'Limite de uso da IA no momento — espere cerca de 1 minuto e tente de novo.';
      }
      res.status(upstream.status).json({ error: friendly });
      return;
    }

    const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    if (!text) {
      // Bloqueio de segurança do Gemini ou resposta vazia
      const blockReason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason;
      res.status(200).json({ error: blockReason ? `Gemini bloqueou a resposta (${blockReason})` : 'Resposta vazia da IA', content: [] });
      return;
    }

    // Devolve no MESMO formato que a API da Anthropic devolveria — app.js não precisa saber a diferença
    res.status(200).json({ content: [{ type: 'text', text }] });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Erro ao chamar a IA' });
  }
}

// Proxy serverless (Vercel) para o Google Gemini API — 100% gratuito, sem
// cartão de crédito (Google AI Studio: aistudio.google.com/apikey).
//
// A chave fica só aqui no servidor (variável de ambiente GEMINI_API_KEY),
// nunca no código do navegador. O app.js chama este endpoint (/api/claude)
// exatamente como chamava a API da Anthropic antes — este arquivo traduz
// o pedido/resposta para o formato do Gemini por dentro, então NADA no
// app.js precisa mudar.

const GEMINI_MODEL = 'gemini-2.5-flash'; // rápido e gratuito; troque para 'gemini-2.5-flash-lite' se precisar de mais requisições/dia

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
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody)
    });
    const data = await upstream.json();

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: data?.error?.message || 'Erro ao chamar o Gemini' });
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

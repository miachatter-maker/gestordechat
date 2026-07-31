// Proxy serverless (Vercel) para o Google Gemini API — 100% gratuito, sem
// cartão de crédito (Google AI Studio: aistudio.google.com/apikey).
//
// A(s) chave(s) ficam só aqui no servidor (variáveis de ambiente
// GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3...), nunca no código
// do navegador. O app.js chama este endpoint (/api/claude) exatamente como
// chamava a API da Anthropic antes — este arquivo traduz o pedido/resposta
// para o formato do Gemini por dentro, então NADA no app.js precisa mudar.

// IMPORTANTE (achado em 25/07/2026): 'gemini-2.0-flash' tinha data de
// desligamento anunciada pro dia 1/jun/2026 — ou seja, já tinha sido
// desligado/fortemente restringido pelo Google havia quase 2 meses, e essa
// é a causa raiz real de "o ChatLab nunca funcionou": não era só cota
// dividida entre as ferramentas, era o modelo em si já obsoleto batendo
// limite quase sempre. Trocado pra 'gemini-3.5-flash' — modelo atual,
// recomendado pelo próprio Google como substituto, com cota gratuita
// confirmada (Free Tier: gratuito) e sem data de desligamento anunciada.
const GEMINI_MODEL = 'gemini-3.5-flash';

// MÚLTIPLAS CHAVES — todas as ferramentas de IA do app (Mapeamento,
// Triagem, Orientação, ChatLab, Pergunte à IA, Análise da Equipe) dividem a
// MESMA cota gratuita de 1 chave (20 req/min), então em dias de uso mais
// pesado qualquer uma delas pode encontrar a cota já estourada por outra.
// Configurando GEMINI_API_KEY_2 (e opcionalmente _3, _4...) em variáveis de
// ambiente separadas na Vercel — de preferência geradas em contas/projetos
// Google DIFERENTES pra não compartilhar a mesma cota — o proxy passa a
// alternar entre elas e, se uma vier com limite excedido, tenta a próxima
// automaticamente antes de desistir. Isso multiplica a cota disponível sem
// custo nenhum. Funciona normalmente com só 1 chave configurada também.
const API_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4
].filter(Boolean);

// Se TODAS as chaves responderem 429 (limite momentâneo) na primeira
// rodada, tenta mais uma rodada completa depois de uma pequena espera —
// evita que uma janela de poucos segundos de pico vire uma falha visível
// pra quem está usando. Mantido curto de propósito (no máximo ~3s de
// espera total) pra não estourar o tempo limite da função serverless da
// Vercel (padrão 10s no plano gratuito).
const MAX_ROUNDS = 2;
const RETRY_DELAY_MS = 2500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Round-robin (não sorteio) entre as chaves. A função serverless costuma
// ficar "quente" (mesma instância reaproveitada) por vários pedidos seguidos
// em pouco tempo — com chave aleatória, pedidos próximos no tempo podem cair
// todos na mesma chave por puro azar do sorteio, estourando o limite por
// minuto dela sozinha mesmo com outras chaves de sobra. Um contador que
// avança a cada pedido garante alternância de verdade entre elas.
let roundRobinCounter = 0;

async function callGemini(apiKey, geminiBody) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(geminiBody)
  });
  const data = await upstream.json();
  return { upstream, data };
}

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

  if (!API_KEYS.length) {
    res.status(500).json({
      error: 'Nenhuma chave de IA configurada no servidor. Vá em Vercel → Settings → Environment Variables, adicione GEMINI_API_KEY com a chave gratuita do Google AI Studio (aistudio.google.com/apikey), e faça um redeploy.'
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

    // gemini-3.5-flash "pensa" por padrão antes de responder (thinking
    // tokens), e esses tokens saem do MESMO orçamento de max_tokens que a
    // resposta final — em prompts grandes (ex: análise completa do ChatLab)
    // isso consumia o orçamento todo só pensando, cortando a resposta visível
    // no meio (JSON quebrado, markdown incompleto sem a seção final).
    // 'low' ainda deixava conversas reais (mais longas que meu teste) cortarem
    // no meio — 'minimal' é o nível mais baixo que o modelo aceita (não
    // garante zero raciocínio em casos complexos, mas chega perto).
    const geminiBody = {
      contents,
      generationConfig: {
        maxOutputTokens: max_tokens || 2000,
        thinkingConfig: { thinkingLevel: 'minimal' }
      }
    };
    if (system) geminiBody.systemInstruction = { parts: [{ text: system }] };

    // Alterna de verdade entre as chaves (round-robin), não sorteio.
    const startIdx = (roundRobinCounter++) % API_KEYS.length;
    let upstream, data;

    // 503 ("model is currently experiencing high demand") é tão transitório
    // quanto o 429 de cota — é uma sobrecarga momentânea do lado do Google,
    // não um problema da nossa chave. Antes só o 429 entrava no loop de
    // retry; um 503 quebrava o loop na hora e virava um "Resposta vazia da
    // IA" confuso pra quem está usando (ex: Mapeamento dos Novos falhando
    // sem motivo aparente). Agora os dois entram no mesmo retry.
    const isRetryable = (status) => status === 429 || status === 503;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (round > 0) await sleep(RETRY_DELAY_MS);
      let allRetryable = true;
      for (let i = 0; i < API_KEYS.length; i++) {
        const key = API_KEYS[(startIdx + i) % API_KEYS.length];
        ({ upstream, data } = await callGemini(key, geminiBody));
        if (!isRetryable(upstream.status)) { allRetryable = false; break; } // sucesso OU erro de outro tipo — não adianta tentar outra chave
      }
      if (!allRetryable) break; // já achou uma chave que respondeu (com sucesso ou erro real)
      // todas as chaves vieram 429/503 nessa rodada — só vale tentar de novo se sobrar rodada
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
          ? `Limite de uso da IA no momento (${API_KEYS.length} chave${API_KEYS.length > 1 ? 's' : ''} configurada${API_KEYS.length > 1 ? 's' : ''}, todas ocupadas) — espere cerca de ${waitS}s e tente de novo.`
          : 'Limite de uso da IA no momento — espere cerca de 1 minuto e tente de novo.';
      } else if (upstream.status === 503 || /high demand|overloaded|sobrecarregad/i.test(msg)) {
        // Sobrecarga momentânea do modelo no Google — mesmo depois das
        // tentativas automáticas. Mensagem clara em vez de "quota" (não é
        // limite da nossa chave) pra não confundir com o aviso de cota.
        friendly = 'O Gemini está com alta demanda no momento (fora do nosso controle) — espere cerca de 20s e tente gerar de novo.';
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

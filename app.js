/* ============================================================
   CENTRAL — GestorPro app logic
   ============================================================ */
const DB='gestorpro_v4';
// IA (ChatLab / Conselheiro) passa por um proxy próprio (função serverless na Vercel,
// arquivo api/claude.js) que usa o Google Gemini (gratuito, sem cartão) e guarda a
// chave em segredo — nunca chamar a API de IA direto do navegador.
// Se você hospedar o front-end em outro domínio que não seja o mesmo da função Vercel,
// troque para a URL completa, ex: 'https://seu-projeto.vercel.app/api/claude'.
const AI_PROXY_URL='/api/claude';
// O free tier do Gemini (usado pelo AI_PROXY_URL) tem limite de 20
// requisições/minuto, compartilhado entre TODAS as telas de IA do app
// (Mapeamento, Triagem, Orientação, ChatLab...). Quando bate no limite, a
// API volta com data.error como STRING (não objeto) contendo "quota" — essa
// função detecta esse caso específico pra dar um aviso claro (em vez de erro
// genérico) e sinalizar que o texto já digitado/gravado continua salvo.
function aiQuotaError(data){
  const raw=typeof data?.error==='string'?data.error:(data?.error?.message||'');
  // Além de "quota"/rate-limit (limite da NOSSA chave), o Gemini também
  // devolve "high demand"/"overloaded" quando o MODELO em si está sobrecarregado
  // do lado do Google (fora do nosso controle) — antes isso caía no erro
  // genérico "Resposta vazia da IA", confuso pra quem está usando (foi a causa
  // real do Mapeamento dos Novos "falhando sem gerar nada" num pico de uso).
  // Trata os dois casos como a mesma situação transitória: mostra a mesma
  // contagem regressiva de espera em vez de um erro seco.
  if(/quota|rate.?limit|high demand|overloaded|sobrecarregad|alta demanda/i.test(raw)){
    // O proxy (api/claude.js) já calcula o tempo real de espera (extraído da
    // própria resposta do Gemini) e manda numa frase tipo "espere cerca de
    // 47s" — extrai esse número aqui pra alimentar uma contagem regressiva
    // real na tela, em vez de um "tente de novo em ~1 minuto" genérico.
    const m=raw.match(/(\d+)\s*s\b/i);
    const err=new Error(raw||'Limite de uso da IA no momento — costuma voltar sozinho em cerca de 1 minuto.');
    err.quota=true;
    err.waitSeconds=m?parseInt(m[1],10):(/high demand|overloaded|sobrecarregad|alta demanda/i.test(raw)?20:60);
    return err;
  }
  return null;
}
// Contagem regressiva ao vivo (atualiza a cada segundo) pra mostrar EXATAMENTE
// quanto falta até a IA liberar de novo, em vez de um texto estático parado.
// mode 'panel' (usado no ChatLab, dentro de áreas de resultado maiores) monta
// um cartão; sem isso, escreve como texto simples (usado nas linhas de status
// do Mapeamento/Triagem/Orientação).
function renderAIWaitCountdown(elId,waitSeconds,opts){
  const el=document.getElementById(elId);
  if(!el)return;
  if(el._aiCountdownIv)clearInterval(el._aiCountdownIv);
  let remaining=Math.max(1,Math.round(waitSeconds||60));
  const prefix=opts?.prefix||'⏳ Limite de uso da IA no momento';
  const suffix=opts?.suffix||'';
  const panel=!!opts?.panel;
  const clockStr=()=>{const mm=Math.floor(remaining/60),ss=remaining%60;return mm>0?`${mm}:${String(ss).padStart(2,'0')}`:`${ss}s`;};
  const paint=()=>{
    const line=`${prefix} — volta em <span style="font-family:var(--font-mono);font-weight:800">${clockStr()}</span>${suffix?' · '+suffix:''}`;
    if(panel)el.innerHTML=`<div class="panel" style="border-color:var(--warn)"><div style="color:var(--warn);font-size:12.5px;font-weight:700">${line}</div></div>`;
    else el.innerHTML=`<span style="color:var(--warn)">${line}</span>`;
  };
  paint();
  el._aiCountdownIv=setInterval(()=>{
    remaining--;
    if(remaining<=0){
      clearInterval(el._aiCountdownIv);
      const doneLine=`✅ Já deve ter liberado — pode tentar de novo${suffix?' ('+suffix+')':''}.`;
      el.innerHTML=panel?`<div class="panel" style="border-color:var(--ok)"><div style="color:var(--ok);font-size:12.5px;font-weight:700">${doneLine}</div></div>`:`<span style="color:var(--ok)">${doneLine}</span>`;
      return;
    }
    paint();
  },1000);
}
const FIREBASE_DOC_ID='central-dados';
const SCHEMA_VERSION=2; // bump this when S structure changes to trigger migrations

// ---------- MIGRATIONS ----------
// When we add new fields to S, old saved data won't have them.
// This function fills in any missing fields with safe defaults.
function migrateState(s){
  // Limpeza de contaminação antiga: em algum momento no passado, o
  // documento inteiro do Firestore (com os campos "payload",
  // "schemaVersion", "updatedAt" que são só do INVÓLUCRO do Firestore)
  // acabou sendo salvo por engano DENTRO do próprio estado do app — cada
  // vez que salvava, isso ficava se aninhando cada vez mais e inchando o
  // documento. Remove sempre, sem excessão, pra nunca mais voltar.
  delete s.payload;
  delete s.schemaVersion;
  delete s.updatedAt;
  if(!s.folgas)s.folgas={};
  if(!s.reportDrafts)s.reportDrafts={};
  if(!s.smartAlertsDone)s.smartAlertsDone={};
  if(!s.alertNotes)s.alertNotes={};
  if(!s.horaExtraSlots)s.horaExtraSlots={};
  if(!s.swaps)s.swaps=[];
  if(!s.problemsToday||!Array.isArray(s.problemsToday))s.problemsToday=[];
  if(!s.demandas)s.demandas={};
  if(!s.trainings)s.trainings=[];
  // Limpa a antiga entrada automática "Aquecimento Discord" que vivia dentro
  // de S.trainings com data presa numa semana (autoRetention) — foi
  // substituída pelo quadro fixo Sexta/Sábado/Domingo (s.treinamentoFixo,
  // abaixo) + o quadro Aquecimento por dia da semana (RETENTION_AGENDA_DAYS,
  // sempre igual, sem data). Treinamentos criados manualmente por você não
  // são afetados por esse filtro.
  s.trainings=s.trainings.filter(t=>!t.autoRetention);
  // Treinamento fixo — sempre toda Sexta/Sábado/Domingo, sem precisar
  // recriar por semana. ID fixo (é um objeto por dia, não array, então não
  // tem risco de duplicar no merge) — só semeia o texto de Sexta que já
  // existia (migração de cargo/filtro final); Sábado e Domingo começam em
  // branco pra você preencher.
  if(!s.treinamentoFixo)s.treinamentoFixo={
    sex:{titulo:'Treinamento — migração de cargo e filtro final',texto:'No Discord: mova quem confirmou do cargo "Inscrito - Vaga de Chatter" pro cargo "Em treinamento". Quem não confirmou, sai. Você tem o controle de quem entra — adicione só quem quiser, poupando seu tempo treinando quem sabe que não vai trazer problema.'},
    sab:{titulo:'',texto:''},
    dom:{titulo:'',texto:''}
  };
  if(!s.weekEvolutions)s.weekEvolutions={};
  if(!s.modelRequests)s.modelRequests={};
  if(!s.weeklyAnalysisDone)s.weeklyAnalysisDone={};
  if(!s.dailyTasksByDay)s.dailyTasksByDay={dom:[],seg:[],ter:[],qua:[],qui:[],sex:[],sab:[]};
  if(!s.weeklyTasks)s.weeklyTasks={};
  if(!s.monthlyTasks)s.monthlyTasks={};
  if(!s.taskDoneLog)s.taskDoneLog={};
  if(!s.triagemCandidatos)s.triagemCandidatos=[];
  if(!s.orientedThisWeek)s.orientedThisWeek={};
  if(!s.weekPrize)s.weekPrize={};
  if(!s.motivational)s.motivational={};
  if(!s.scheduleRequests)s.scheduleRequests={};
  if(!s.chatterFichas)s.chatterFichas={};
  if(!s.chatterWeeklySummaries)s.chatterWeeklySummaries={}; // fatia própria/segura pro link myperformance (ver comentário em SHARD_FIELDS) — nunca leva Dados PJ
  if(!s.chatObservacoes)s.chatObservacoes={};
  if(!s.iaPerguntas||!Array.isArray(s.iaPerguntas))s.iaPerguntas=[];
  if(!s.estudosDraft)s.estudosDraft={};
  if(!s.estudosHistory)s.estudosHistory=[];
  if(!s.managerProfile)s.managerProfile={};
  if(!s.motivacionalHome)s.motivacionalHome={};
  if(!s.chatAnalyses)s.chatAnalyses={};
  if(!s.semanaObjetivos)s.semanaObjetivos={};
  if(!s.modelRequestsSplit)s.modelRequestsSplit={};
  if(!s.demandas2||!Array.isArray(s.demandas2))s.demandas2=[];
  if(!s._tombstones||typeof s._tombstones!=='object')s._tombstones={};
  else{ // limpa marcas de exclusão com mais de 200 dias — não precisam durar pra sempre
    const cutoff=Date.now()-1000*60*60*24*200;
    Object.keys(s._tombstones).forEach(id=>{if(!(s._tombstones[id]>cutoff))delete s._tombstones[id];});
  }
  if(!s._fieldTombstones||typeof s._fieldTombstones!=='object')s._fieldTombstones={};
  else{ // mesma limpeza, pras field tombstones (ver tombstoneField())
    const cutoff=Date.now()-1000*60*60*24*200;
    Object.keys(s._fieldTombstones).forEach(p=>{if(!(s._fieldTombstones[p]>cutoff))delete s._fieldTombstones[p];});
  }
  if(!s.justificativas)s.justificativas={};
  if(!s.chatlabAnalyses)s.chatlabAnalyses=[];
  if(!s.chatlabWeeklyReports)s.chatlabWeeklyReports={};
  if(!s.chatterTraining)s.chatterTraining={};
  if(!s.weekOrients)s.weekOrients=[];
  else{const wk=getWeekKey();s.weekOrients=s.weekOrients.filter(o=>!o.done||o.doneWeek===wk);} // done items vanish on new week
  if(!s.geradorMeu)s.geradorMeu=[];
  if(!s.geradorExt)s.geradorExt=[];
  if(!s.geradorCanal)s.geradorCanal='PRIVACY FREE';
  if(!s.geradorElite)s.geradorElite=[];
  if(!s.testerLogs)s.testerLogs={};
  if(s.recadoPadrinhos==null)s.recadoPadrinhos='';
  if(s.reivindicacaoJanelaExtra===undefined)s.reivindicacaoJanelaExtra=null;
  if(!Array.isArray(s.deserdarHistorico))s.deserdarHistorico=[];
  if(!s.melhoras)s.melhoras=[];
  else{const wk=getWeekKey();s.melhoras=s.melhoras.filter(m=>!m.done||m.doneWeek===wk);}
  if(!s.melhoraHistory)s.melhoraHistory=[];
  if(!s.estudosDraft2)s.estudosDraft2={};
  if(Array.isArray(s.shifts))s.shifts=s.shifts.map(sh=>({start2:'',end2:'',folgaDia:'',folgaDia2:'',modelIds:[],...sh}));
  if(!s.chatterTrainings)s.chatterTrainings=[];
  if(s.hasSeededStudies===undefined)s.hasSeededStudies=false;
  if(!s.chatterWeekGoals)s.chatterWeekGoals={};
  if(!s.weekNotes)s.weekNotes={};
  if(!s.watchAlerts)s.watchAlerts={};
  if(!s.midnightTasks)s.midnightTasks={};
  if(!s.dailyTasks)s.dailyTasks={};
  if(!s.retentionDone)s.retentionDone={};
  if(!s.creativityLog)s.creativityLog={}; // dateKey -> {habitId:true} — reset diário dos hábitos de criatividade
  if(!s.creativityWeekly)s.creativityWeekly={}; // weekKey(seg) -> {done, review:{...}} — desafio semanal + revisão
  if(!s.mapRecordings)s.mapRecordings=[]; // [{id,name,transcript,date,mapped}] — gravações rápidas do novo Mapeamento (6 slots)
  if(!s.mapSlotDrafts)s.mapSlotDrafts={}; // '1'..'6' -> texto em andamento (recuperação se travar no meio da gravação)
  if(!s.mapSlotNames)s.mapSlotNames={}; // '1'..'6' -> nome digitado antes/durante a gravação (a pedido da gestora, em vez de depender só do reconhecimento automático)
  if(!s.tarefasNovatoPorTester)s.tarefasNovatoPorTester={};
  // MIGRAÇÃO ÚNICA (31/07/2026): tira tarefasNovato de dentro de cada
  // chatterFicha e move pra sua fatia própria (ver comentário em
  // SHARD_FIELDS). Só copia se ainda achar dado no lugar antigo — depois da
  // primeira vez que salva, o campo antigo não existe mais e isso vira
  // um no-op sozinho, sem risco de duplicar ou reverter a migração.
  if(s.chatterFichas){
    Object.keys(s.chatterFichas).forEach(cid=>{
      const tn=s.chatterFichas[cid]&&s.chatterFichas[cid].tarefasNovato;
      if(tn&&Object.keys(tn).length){
        s.tarefasNovatoPorTester[cid]={...(s.tarefasNovatoPorTester[cid]||{}),...tn};
      }
      if(s.chatterFichas[cid])delete s.chatterFichas[cid].tarefasNovato;
    });
  }
  if(!s.mapeamentoBatches)s.mapeamentoBatches=[]; // [{id,date,results:[{id,name,recordingId,...campos da IA}]}] — MAPEAMENTO DOS NOVOS
  if(!s.afilhadoClaims)s.afilhadoClaims=[]; // [{id,testerId,testerNome,padrinhoId,padrinhoNome,status:'pendente'|'aprovado'|'reprovado'|'reservado',criadoEm}] — quadro SOLICITAÇÃO DE AFILHADO (Testers)
  if(!s.weekGoals)s.weekGoals={};
  if(!s.revenues)s.revenues={};
  if(!s.models)s.models=[];
  if(!s.quickNotes)s.quickNotes=[];
  // Métricas de Treinamento — preenchidas manualmente pela gestora por turma
  // de recrutamento (não é calculado automaticamente como o resto de
  // Métricas). Semeia o primeiro registro histórico com os números já
  // levantados por ela, só na primeira vez que o app roda (se apagar depois,
  // não volta sozinho). ID FIXO (não Date.now()) de propósito: migrateState
  // roda de novo a cada snapshot do Firestore antes do primeiro save
  // terminar, e o merge de arrays (mergeArraysSafe) dedupe por id — com id
  // fixo, tentativas repetidas de semear viram o MESMO item em vez de
  // duplicar o registro a cada sincronização.
  if(!s.treinamentoMetricas)s.treinamentoMetricas=[{
    id:'tm-seed-inicial',
    criadoEm:new Date().toISOString(),
    totalInscritos:11,
    enviaramMensagem:4,
    confirmaram:3,
    apareceram:7,
    selecionadosTeste:2,
    obs:''
  }];
  if(!s.analiseMensal)s.analiseMensal=[]; // [{id,modelId,modelName,monthKey,importadoEm,totalFaturamento,totalVendas,htCount,htTotal,htComissao,htPctVendas,htPctFaturamento,porTipo,whales,porChatter,naoAtribuidoTotal,naoAtribuidoCount}] — Análise Mensal de Vendas (planilhas importadas por modelo, só o resumo calculado é guardado)
  if(!s.faturamentoFinanceiro)s.faturamentoFinanceiro={}; // {[chatterId]:{[monthKey]:{totalTurno,totalExtra,totalGeral,meta,atingiuMeta,pctMeta,horasTotais,porDiaTurno,porDiaExtra,arquivoNome,nomeNaPlanilha,importadoEm}}} — pedido 04/08/2026: substitui o lançamento manual na Performance Mensal pelas planilhas oficiais do financeiro (uma .xlsx por chatter, com aba Fechamento já calculada)
  // Estratégias de Liderança — substitui o antigo quadro "Motivacional da
  // semana" (texto livre) por uma lista de ações de verdade, organizadas por
  // prazo (imediato/curto/médio/estrutural), cada uma marcável como feita,
  // editável e removível. Semeia com a primeira análise já levantada, só na
  // primeira vez que o app roda. IDs FIXOS de propósito (mesmo motivo do
  // treinamentoMetricas acima): migrateState roda de novo a cada snapshot do
  // Firestore antes do primeiro save terminar, e o merge de arrays dedupe por
  // id — id fixo evita duplicar esse seed a cada sincronização.
  if(!s.liderancaEstrategias)s.liderancaEstrategias=[
    {id:'lid-seed-1',categoria:'imediato',texto:'Conversa individual e direta com Renan e Guilherme. Não em grupo, não por mensagem — conversa real. Os dois tiveram quedas bruscas que não são de conhecimento. Algo aconteceu. Você precisa saber o que é antes de decidir o que fazer com eles. Sem essa conversa você está gerenciando no escuro.',done:false,criadoEm:new Date().toISOString()},
    {id:'lid-seed-2',categoria:'curto',texto:'Investe energia concentrada no Felipe e Eduardo. Eles responderam, estão crescendo e merecem atenção proporcional ao retorno que dão. Cria um momento de desenvolvimento específico para os dois — pode ser uma conversa semanal rápida, um feedback mais próximo, um desafio de meta. Quem responde merece mais de você.',done:false,criadoEm:new Date().toISOString()},
    {id:'lid-seed-3',categoria:'curto',texto:'Para o Charão e José — que têm potencial e tiveram acesso ao Elite — uma cobrança mais direta e específica. Não motivação genérica. Pergunta concreta: "você aprendeu X com o Henrique, por que não está aplicando?" Coloca o espelho na frente.',done:false,criadoEm:new Date().toISOString()},
    {id:'lid-seed-4',categoria:'medio',texto:'Giovana precisa de acompanhamento próximo mas com prazo. Defina internamente até quando você acompanha sem resultado. Não é crueldade — é respeito pelo tempo de vocês duas.',done:false,criadoEm:new Date().toISOString()},
    {id:'lid-seed-5',categoria:'medio',texto:'Observa mais uma semana antes de qualquer movimento.',done:false,criadoEm:new Date().toISOString()},
    {id:'lid-seed-6',categoria:'estrutural',texto:'Para de medir sua liderança pelo resultado de quem não quer crescer. Seu termômetro real são o Felipe e o Eduardo. Eles são o reflexo do que você está construindo.',done:false,criadoEm:new Date().toISOString()}
  ];
  // Conselheiro Executivo — leitura semanal automática (dados reais, sem
  // precisar clicar toda vez) e espaço de apoio pessoal separado (não leva
  // dado de operação, só o texto da gestora — ver rodarConselheiro /
  // gerarConselheiroSemanal / conversarConselheiroPessoal).
  if(!s.conselheiroSemanal)s.conselheiroSemanal={wkey:'',text:'',generatedAt:''};
  if(!s.conselheiroPessoal)s.conselheiroPessoal=[];
  // Detecção de medalha alcançada — guarda a última medalha vista de cada
  // chatter pra saber quando ela SOBE (não avisa em queda), e a lista de
  // avisos gerados (mostrados na Estratégia + Painel até serem marcados como vistos).
  if(!s.chatterLastMedal)s.chatterLastMedal={};
  if(!s.medalAchievements)s.medalAchievements=[];
  if(!s.turnoLog)s.turnoLog={};
  if(!s.chatters)s.chatters=[];
  if(!s.shifts)s.shifts=[];
  if(!s.absences)s.absences=[];
  if(!s.orientations)s.orientations=[];
  if(!s.studies)s.studies=[];
  s.chatters=s.chatters.map(c=>({
    level:'junior',discord:'',notes:'',watchtime:'',createdAt:new Date().toISOString(),
    time:'basico', // 'basico' | 'tester' — 'elite' foi descontinuado (Time Elite só existe hoje dentro do Gerador Elite, em Relatórios, sem precisar marcar o chatter)
    pendenteAprovacao:false, // true = virou Tester mas ainda não teve a solicitação de Afilhado aprovada (só aparece nas Tarefas, não em Testers/Equipe)
    ...c,
    // migração: quem ainda estava marcado 'elite' volta pro Time Base — não existe mais botão/tela pra esse status fora de Relatórios
    ...(c.time==='elite'?{time:'basico'}:{})
  }));
  pruneHeavyData(s);
  return s;
}

// Mantém o documento do Firestore sob controle: remove só o detalhe bruto
// (horário de cada venda individual) de dias com mais de 60 dias — os
// TOTAIS e MÉDIAS daquele dia continuam guardados pra sempre, só o detalhe
// minuto-a-minuto (que só serve pra gráfico de horário de pico recente)
// sai. Também remove snapshots de ficha duplicados no mesmo dia (mantém
// o mais recente de cada data, em vez de acumular repetidos).
function pruneHeavyData(s){
  try{
    // Garante a migração de tarefasNovato pra sua fatia própria mesmo quando
    // chega um snapshot SÓ do shard-fichas (migrateState só roda pro
    // documento central-dados) — sem repetir isso aqui, o merge por união de
    // chaves (deepMergeState) podia reintroduzir o campo antigo vindo de uma
    // cópia remota que ainda não tinha sido sobrescrita, e o próximo save()
    // escrevia ele de volta, num loop que nunca deixava a migração pegar de
    // vez. Roda toda vez, mas só tem efeito enquanto sobrar algo pra mover.
    if(s.chatterFichas){
      if(!s.tarefasNovatoPorTester)s.tarefasNovatoPorTester={};
      Object.keys(s.chatterFichas).forEach(cid=>{
        const tn=s.chatterFichas[cid]&&s.chatterFichas[cid].tarefasNovato;
        if(tn&&Object.keys(tn).length){
          s.tarefasNovatoPorTester[cid]={...(s.tarefasNovatoPorTester[cid]||{}),...tn};
        }
        if(s.chatterFichas[cid])delete s.chatterFichas[cid].tarefasNovato;
      });
    }
    // Remove duplicatas estruturalmente idênticas em arrays sem "id" — o
    // bug antigo de mesclagem duplicava esses itens a cada sincronização.
    // Compara por conteúdo (JSON.stringify), preservando a ordem.
    const dedupeByContent=arr=>{
      if(!Array.isArray(arr)||arr.length<2)return arr;
      const seen=new Set();const out=[];
      arr.forEach(v=>{
        const key=typeof v==='object'&&v!==null?JSON.stringify(v):v;
        if(!seen.has(key)){seen.add(key);out.push(v);}
      });
      return out;
    };
    if(s.turnoLog){
      Object.keys(s.turnoLog).forEach(dk=>{s.turnoLog[dk]=dedupeByContent(s.turnoLog[dk]);});
    }
    if(Array.isArray(s.geradorElite))s.geradorElite=dedupeByContent(s.geradorElite).filter(c=>c&&(c.name||c.salesRaw));
    if(Array.isArray(s.geradorMeu))s.geradorMeu=dedupeByContent(s.geradorMeu);
    if(Array.isArray(s.shifts)&&s.shifts.length>1){
      // Remove turnos duplicados (mesmo chatter, mesmo horário, mesmos dias,
      // mesmas modelos) — mantém só o primeiro. Também tira modelo repetido
      // dentro do mesmo turno, que causava a mesma linha aparecer 2x na escala.
      s.shifts.forEach(sh=>{if(Array.isArray(sh.modelIds))sh.modelIds=[...new Set(sh.modelIds)];});
      const seenShiftKeys=new Set();
      s.shifts=s.shifts.filter(sh=>{
        const key=[sh.chatterId,sh.start,sh.end,sh.start2||'',sh.end2||'',(sh.days||[]).slice().sort().join(','),(sh.modelIds||[]).slice().sort().join(','),sh.folgaDia||'',sh.folgaDia2||''].join('|');
        if(seenShiftKeys.has(key))return false;
        seenShiftKeys.add(key);
        return true;
      });
    }
    if(s.midnightTasks){
      // Mantém só UMA tarefa por (chatter + dia) — a versão marcada como
      // feita ganha, se existir; senão a primeira. Isso corrige conjuntos
      // inteiros que foram gerados de novo várias vezes no mesmo dia.
      Object.keys(s.midnightTasks).forEach(dk=>{
        const list=s.midnightTasks[dk];
        if(!Array.isArray(list)||list.length<2)return;
        const byChatter={};
        list.forEach(t=>{
          if(!t||!t.chatterId)return;
          const existing=byChatter[t.chatterId];
          if(!existing||(!existing.done&&t.done))byChatter[t.chatterId]=t;
        });
        s.midnightTasks[dk]=Object.values(byChatter);
      });
    }

    const cutoff=new Date();cutoff.setDate(cutoff.getDate()-60);
    const cutoffKey=fmt(cutoff);
    Object.values(s.chatterFichas||{}).forEach(f=>{
      const wd=f?.analytics?.weeklyData;
      if(wd){
        Object.keys(wd).forEach(dk=>{
          if(dk<cutoffKey&&wd[dk]&&wd[dk].saleTimes){
            // Calcula o resultado (quantas vendas em cada hora do dia) ANTES
            // de apagar o detalhe bruto — preserva o horário de pico exato
            // ocupando 24 números fixos em vez de uma lista que só cresce.
            if(!wd[dk].hourHistogram){
              const hist=new Array(24).fill(0);
              wd[dk].saleTimes.forEach(mins=>{hist[Math.floor(mins/60)%24]++;});
              wd[dk].hourHistogram=hist;
            }
            delete wd[dk].saleTimes;
          }
        });
      }
      if(Array.isArray(f?.history)&&f.history.length>1){
        const byDate={};
        f.history.forEach(h=>{if(h&&h.date)byDate[h.date]=h;}); // último de cada data vence
        f.history=Object.keys(byDate).sort().map(dk=>byDate[dk]);
      }
    });
    // ChatLab: relatórios de IA são textos longos — mantém só os 5 mais
    // recentes POR CHATTER. Análises antigas raramente são revisitadas e
    // são, de longe, o maior peso do documento.
    if(Array.isArray(s.chatlabAnalyses)&&s.chatlabAnalyses.length){
      const byChatter={};
      s.chatlabAnalyses.forEach(a=>{
        const cid=a.chatterId||'_sem';
        if(!byChatter[cid])byChatter[cid]=[];
        byChatter[cid].push(a);
      });
      let kept=[];
      Object.values(byChatter).forEach(list=>{
        list.sort((a,b)=>(a.date||'').localeCompare(b.date||''));
        kept=kept.concat(list.slice(-5));
      });
      s.chatlabAnalyses=kept;
      // A conversa colada (campo .conv) fica guardada só durante a semana em
      // que foi analisada — na virada da semana (Segunda), some sozinha daqui
      // pra frente (essa função roda a cada save()). O relatório da IA (.raw),
      // IGP, resumo e tags NUNCA são apagados — servem pra comparar evolução
      // pra sempre. Pedido explícito da gestora: só o texto bruto da conversa
      // é temporário, a análise em si é permanente.
      const currentMonKey=fmt(getMondayOfWeek(new Date()));
      s.chatlabAnalyses.forEach(a=>{
        if(a.conv&&a.date){
          const analiseMonKey=fmt(getMondayOfWeek(new Date(a.date)));
          if(analiseMonKey!==currentMonKey)delete a.conv;
        }
      });
    }
    // Fichas órfãs (achado em 31/07/2026): uma limpeza feita direto no estado
    // (fora do deleteChatter, que já cuida disso sozinho) deixou fichas de
    // gente que não existe mais em s.chatters, incluindo prints de PPM em
    // tarefasNovato — pura sobra que nunca aparece pra ninguém (toda função
    // que lê isso já busca o chatter primeiro) mas continuava ocupando
    // espaço no documento sharded. Remove sozinho a cada save(), pra nunca
    // mais precisar caçar isso na mão.
    if(s.chatterFichas&&Array.isArray(s.chatters)){
      const idsValidos=new Set(s.chatters.map(c=>c.id));
      Object.keys(s.chatterFichas).forEach(fid=>{
        if(!idsValidos.has(fid))delete s.chatterFichas[fid];
      });
    }
    if(s.testerLogs&&Array.isArray(s.chatters)){
      const idsValidos=new Set(s.chatters.map(c=>c.id));
      Object.keys(s.testerLogs).forEach(tid=>{
        if(!idsValidos.has(tid))delete s.testerLogs[tid];
      });
    }
    if(s.tarefasNovatoPorTester&&Array.isArray(s.chatters)){
      const idsValidos=new Set(s.chatters.map(c=>c.id));
      Object.keys(s.tarefasNovatoPorTester).forEach(tid=>{
        if(!idsValidos.has(tid))delete s.tarefasNovatoPorTester[tid];
      });
    }
  }catch(e){console.error('Erro ao limpar dados pesados',e);}
  return s;
}

/* ===========================================================
   FIREBASE SYNC
   The localStorage cache lets the app render instantly; Firestore
   is the real source of truth so data survives app updates,
   cache clears, and works across devices.
   =========================================================== */
let fbDb=null;
let fbReady=false;
let fbSaveTimer=null;
let fbSyncStatus='connecting';
let fbIgnoreSnapshotsUntil=0; // timestamp — ignore all snapshots before this time
let fbHasReceivedFirstSnapshot=false;
function hideInitialLoadOverlay(){
  const el=document.getElementById('initial-load-overlay');
  if(el)el.remove();
}
function showLoadOverlayError(err){
  const el=document.getElementById('initial-load-overlay');
  if(!el)return; // já foi liberado — não sobrescreve a tela normal
  const msg=(err&&(err.code?`${err.code} — ${err.message||''}`:err.message))||'Erro desconhecido ao conectar';
  el.innerHTML=`<div style="max-width:320px;text-align:center;padding:0 20px">
    <div style="font-size:28px;margin-bottom:10px">⚠️</div>
    <div style="font-size:13px;font-weight:700;margin-bottom:6px">Não consegui conectar ao banco de dados</div>
    <div style="font-size:11px;color:var(--text3);font-family:var(--font-mono);margin-bottom:16px;word-break:break-word">${msg}</div>
    <button onclick="hideInitialLoadOverlay()" class="btn btn-primary btn-sm">Continuar mesmo assim</button>
  </div>`;
}
let fbLastErrorMessage='';
let fbInitAttempts=0;

function initFirebaseWithRetry(){
  if(typeof firebase==='undefined'&&fbInitAttempts<6){
    fbInitAttempts++;
    setTimeout(initFirebaseWithRetry,600);
    return;
  }
  if(typeof firebase==='undefined'){
    fbSyncStatus='offline';
    updateSyncBadge();
    showLoadOverlayError({message:'O script do Firebase (firebase-bundle.js) não carregou. Verifique se o arquivo está no ar e se o navegador não está bloqueando o script.'});
    return;
  }
  initFirebase();
}

function initFirebase(){
  if(typeof firebase==='undefined'){fbSyncStatus='offline';updateSyncBadge();return;}
  try{
    const firebaseConfig={
      apiKey:"AIzaSyA5Q5MYehtJAU18ixZLvqS4-gQnNJJD3LI",
      authDomain:"agenciaseduct-8fd34.firebaseapp.com",
      projectId:"agenciaseduct-8fd34",
      storageBucket:"agenciaseduct-8fd34.firebasestorage.app",
      messagingSenderId:"232929088781",
      appId:"1:232929088781:web:b278bd92bf9bdc857e4c44"
    };
    const app=firebase.apps&&firebase.apps.length?firebase.app():firebase.initializeApp(firebaseConfig);
    fbDb=firebase.firestore();
    fbReady=true;
    // Se não vier nenhuma resposta (nem sucesso, nem erro) em 8s — rede
    // bloqueada, CORS, etc — mostra isso na tela em vez de falhar em silêncio.
    const t=setTimeout(()=>{
      if(fbSyncStatus!=='online'){
        fbSyncStatus='offline';updateSyncBadge();
        showLoadOverlayError({message:'O Firestore não respondeu em 8 segundos. Pode ser bloqueio de rede/firewall, ou as regras de segurança do Firebase.'});
      }
    },8000);
    listenToFirestore(t);
    listenToAvaliacoesPendentes();
    listenToChatlabPendentes();
    listenToRelatoriosSemanaisPendentes();
    listenToTarefasNovatoPendentes();
    listenToAfilhadoClaimsPendentes();
    listenToTesterAutoInclusaoPendentes();
    listenToTesterDadosPendentes();
    listenToDadosPjPendentes();
    listenToSegundaChancePendentes();
    listenToSegundaChanceDecisoesPendentes();
    listenToExclusoesTesterPendentes();
    listenToExclusoesAfilhadoPendentes();
    listenToDeserdarPendentes();
    listenToHorarioTestePendentes();
    listenToEntrevistaPendentes();
    listenToDiscordPendentes();
    listenToEntrevistaDecisaoPendentes();
  }catch(e){
    fbSyncStatus='offline';
    updateSyncBadge();
    showLoadOverlayError(e);
  }
}

// ---------- GENERIC DEEP MERGE (never lose local data on sync) ----------
// Philosophy: Firestore is convenient for cross-device sync, but a stale or
// empty remote snapshot must NEVER erase real local data. Instead of a
// hand-maintained whitelist of "critical" fields (which is easy to forget
// to update and previously left things like managerProfile/photos and
// daily task checklists unprotected), this merges EVERY field of state
// recursively: local data only ever gets replaced by remote data that is
// actually present; local content is preserved whenever remote is empty,
// missing, or falsy for that same slot.
function isPlainObj(v){return v&&typeof v==='object'&&!Array.isArray(v);}
function mergeArraysSafe(local,remote){
  const loc=Array.isArray(local)?local:[];
  const rem=Array.isArray(remote)?remote:loc;
  if(rem.length===0&&loc.length>0)return loc; // never let empty remote wipe local list
  const locHasIds=loc.length&&loc[0]&&typeof loc[0]==='object'&&loc[0].id!=null;
  const remHasIds=rem.length&&rem[0]&&typeof rem[0]==='object'&&rem[0].id!=null;
  if(!locHasIds&&!remHasIds){
    // Primitive arrays (strings/numbers, ex: lista de chatterIds em folga)
    // OU arrays de objetos sem "id" (ex: histórico de turnos, cards do
    // gerador): nunca dropar um item que só existe local — faz união em
    // vez de só confiar no remoto. IMPORTANTE: pra objetos, "já existe"
    // precisa comparar o CONTEÚDO (JSON.stringify), não a referência —
    // comparar por referência (.includes de objeto) nunca bate depois de
    // um JSON.parse, e isso fazia cada item se duplicar a cada sincronização.
    const seen=new Set(loc.map(v=>typeof v==='object'&&v!==null?JSON.stringify(v):v));
    const union=[...loc];
    rem.forEach(v=>{
      const key=typeof v==='object'&&v!==null?JSON.stringify(v):v;
      if(!seen.has(key)){seen.add(key);union.push(v);}
    });
    return union;
  }
  const order=[];const map=new Map();
  // Um id tombstoned nunca entra no resultado do merge, mesmo que ainda
  // esteja presente no array local — isso é o que faz uma exclusão feita
  // em OUTRO dispositivo (ex: computador) realmente sumir aqui (ex: celular)
  // assim que a tombstone chegar via Firestore, em vez de só bloquear
  // re-adições vindas do remoto no mesmo dispositivo que apagou.
  const tomb=S&&S._tombstones;
  loc.forEach(item=>{if(item&&typeof item==='object'&&item.id!=null){
    if(tomb&&tomb[item.id])return;
    if(!map.has(item.id))order.push(item.id);map.set(item.id,item);
  }});
  rem.forEach(item=>{if(item&&typeof item==='object'&&item.id!=null){
    if(tomb&&tomb[item.id])return;
    const existing=map.get(item.id);
    // Se esse id não existe mais localmente porque foi apagado (tombstone),
    // nunca deixa o merge trazê-lo de volta a partir de um snapshot remoto
    // que ainda não tinha recebido a exclusão (ex: reload antes do push de
    // 600ms terminar). Isso é a causa raiz de itens excluídos "voltarem
    // sozinhos" depois de recarregar a página.
    if(!existing&&tomb&&tomb[item.id])return;
    if(!map.has(item.id))order.push(item.id);
    map.set(item.id,existing?deepMergeState(existing,item):item);
  }});
  return order.map(id=>map.get(id));
}
function deepMergeState(local,remote,path){
  path=path||'';
  // 10/08/2026 — se esse caminho foi marcado como "campo apagado de
  // propósito" (tombstoneField) e o valor local de agora reflete isso
  // (vazio/ausente), NUNCA deixa um remoto atrasado (ainda com o valor
  // antigo) trazer de volta — ver comentário completo em tombstoneField().
  // Sem isso, dava exatamente o bug "os endereços que eu excluo voltam".
  if(S&&S._fieldTombstones&&S._fieldTombstones[path]&&(local===undefined||local===null||local===''||local===false||(isPlainObj(local)&&!Object.keys(local).length))){
    return local;
  }
  if(remote===undefined||remote===null)return local;
  if(local===undefined||local===null)return remote;
  if(Array.isArray(local)||Array.isArray(remote))return mergeArraysSafe(local,remote);
  if(isPlainObj(local)&&isPlainObj(remote)){
    const out={};
    const keys=new Set([...Object.keys(local),...Object.keys(remote)]);
    keys.forEach(k=>{out[k]=deepMergeState(local[k],remote[k],path?path+'.'+k:k);});
    return out;
  }
  // scalars: prefer remote, but a falsy/empty remote never overwrites real local content
  if((remote===''||remote===0||remote===false)&&local!==undefined&&local!==null&&local!==''&&local!==0&&local!==false)return local;
  return remote;
}
// ---------- SHARDING: os campos que mais crescem ficam em documentos
// próprios no Firestore, separados do documento principal. Isso multiplica
// o espaço disponível (~1MB por documento) por vários — sem mudar nada na
// tela: o app continua trabalhando com um único objeto de estado (S) na
// memória, só a gravação/leitura no Firebase é que fica dividida.
// tarefasNovatoPorTester ganhou fatia PRÓPRIA (31/07/2026, a pedido da
// gestora, preocupada com pouco espaço sobrando): antes morava dentro de
// cada chatterFicha, disputando o MESMO ~1MB do documento shard-fichas com
// o histórico de TODO MUNDO já contratado — só 3-4 testers em teste ao
// mesmo tempo já quase estouravam o limite. Com fatia própria, os prints de
// PPM de quem ainda está em teste têm um orçamento de ~1MB SÓ PRA ELES,
// somando na prática mais que o dobro de espaço de sobra sem apagar nada.
// chatterWeeklySummaries (31/07/2026 [sic], pro link myperformance): fatia
// PRÓPRIA e SEPARADA de chatterFichas de propósito — a Ficha guarda Dados PJ
// (CNPJ, pix, endereço), que NUNCA pode chegar num link público. Essa fatia
// nova só tem números já resumidos (faturamento, %HT, ticket médio etc. por
// semana), seguro pra qualquer chatter buscar e ver a própria evolução sem
// expor dado sensível de ninguém.
const SHARD_FIELDS=['chatterFichas','revenues','chatlabAnalyses','chatlabWeeklyReports','tarefasNovatoPorTester','chatterWeeklySummaries'];
const SHARD_DOC_IDS={chatterFichas:'shard-fichas',revenues:'shard-revenues',chatlabAnalyses:'shard-chatlab',chatlabWeeklyReports:'shard-chatlab-semanal',tarefasNovatoPorTester:'shard-tarefas-tester',chatterWeeklySummaries:'shard-weekly-summaries'};
const ALL_SYNC_DOC_IDS=[FIREBASE_DOC_ID,...SHARD_FIELDS.map(f=>SHARD_DOC_IDS[f])];
let fbDocsSeen=new Set();
let fbDocsStatus={}; // docId -> 'ok'|'not-exists'|'error: ...' — pra diagnóstico
function persistLocalCache(){
  try{
    const p=JSON.stringify(S);
    localStorage.setItem(DB,p);
    localStorage.setItem('gestorpro_backup',p);
  }catch(e){
    try{
      localStorage.removeItem('gestorpro_backup');
      localStorage.setItem(DB,JSON.stringify(S));
    }catch(e2){
      localSaveFailCount++;
      console.error('Falha ao salvar localmente',e2);
      if(Date.now()-lastLocalSaveWarningAt>30000){
        lastLocalSaveWarningAt=Date.now();
        toast(`⚠️ Sem espaço para salvar localmente (${e2.name||'erro'}) — seus dados continuam seguros no Firebase, mas libere espaço no navegador quando puder.`,6000);
      }
    }
  }
}
function scheduleRerenderAfterSync(){
  const active=document.activeElement;
  const isTyping=active&&(active.tagName==='INPUT'||active.tagName==='TEXTAREA'||active.tagName==='SELECT');
  if(isTyping){
    const rerenderOnBlur=()=>{
      _rts[currentViewName()]=0;
      renderView(currentViewName());
      active.removeEventListener('blur',rerenderOnBlur);
    };
    active.addEventListener('blur',rerenderOnBlur,{once:true});
  } else {
    const cv=currentViewName();
    const heavy=['evolucao','projecao','pagamento','chatlab','testers'];
    if(heavy.includes(cv)){updateSyncBadge();}
    else{_rts[cv]=0;renderView(cv);}
  }
}
function listenToFirestore(connectTimeout){
  if(!fbDb)return;
  ALL_SYNC_DOC_IDS.forEach(docId=>{
    fbDb.collection('gestorpro').doc(docId).onSnapshot(
      (doc)=>{
        if(connectTimeout)clearTimeout(connectTimeout);
        if(Date.now()<fbIgnoreSnapshotsUntil){
          fbDocsSeen.add(docId);
          if(fbDocsSeen.size>=ALL_SYNC_DOC_IDS.length){fbHasReceivedFirstSnapshot=true;hideInitialLoadOverlay();}
          fbSyncStatus=fbHasReceivedFirstSnapshot?'online':'connecting';updateSyncBadge();
          return;
        }
        let needsInitialPush=false;
        if(doc.exists){
          const remote=doc.data();
          if(remote&&remote.payload){
            try{
              const parsedPart=JSON.parse(remote.payload);
              // Funde as tombstones que vieram desse snapshot ANTES de tudo
              // o resto, pra que o merge de arrays (turnos, trocas etc.)
              // logo abaixo já enxergue as exclusões feitas em outros
              // dispositivos e consiga removê-las também daqui.
              const incomingTomb=parsedPart&&parsedPart._tombstones;
              if(incomingTomb&&typeof incomingTomb==='object'){
                if(!S._tombstones)S._tombstones={};
                Object.keys(incomingTomb).forEach(id=>{
                  if(!S._tombstones[id]||incomingTomb[id]>S._tombstones[id])S._tombstones[id]=incomingTomb[id];
                });
              }
              // Mesma ideia, mas pras field tombstones (campos apagados dentro
              // de objetos, tipo dadosPJ ou padrinhoId) — ver tombstoneField().
              const incomingFieldTomb=parsedPart&&parsedPart._fieldTombstones;
              if(incomingFieldTomb&&typeof incomingFieldTomb==='object'){
                if(!S._fieldTombstones)S._fieldTombstones={};
                Object.keys(incomingFieldTomb).forEach(p=>{
                  if(!S._fieldTombstones[p]||incomingFieldTomb[p]>S._fieldTombstones[p])S._fieldTombstones[p]=incomingFieldTomb[p];
                });
              }
              if(docId===FIREBASE_DOC_ID){
                const migrated=migrateState(parsedPart);
                S=deepMergeState(S,migrated);delete S.payload;delete S.schemaVersion;delete S.updatedAt;
              } else {
                // Shard: parsedPart já vem no formato {campo: valor} — funde só essa fatia
                S=deepMergeState(S,parsedPart);delete S.payload;delete S.schemaVersion;delete S.updatedAt;
                if(docId===SHARD_DOC_IDS.chatterFichas)pruneHeavyData(S); // dedupe/limpa aqui também, não só no load inicial
              }
              persistLocalCache();
              _lastKnownIds=collectAllIds(S); // atualiza a baseline pra não confundir itens novos vindos do remoto com exclusões locais
              scheduleRerenderAfterSync();
              fbDocsStatus[docId]=`ok (${Math.round(remote.payload.length/1024)}KB)`;
            }catch(e){console.error('Erro ao processar snapshot '+docId,e);fbDocsStatus[docId]='erro ao processar: '+e.message;}
          } else {
            fbDocsStatus[docId]='existe mas sem payload';
          }
        } else {
          needsInitialPush=true; // documento ainda não existe (ex: primeiro uso, ou fatia nova do sharding)
          fbDocsStatus[docId]='não existe no Firestore';
        }
        // IMPORTANTE: marca como "visto" ANTES de decidir qualquer coisa.
        // Nunca cria/sobrescreve um documento baseado só no estado local
        // até termos confirmado o que já existe em TODOS os documentos —
        // isso evita que um envio precoce (antes da sincronização inicial
        // terminar) apague dados reais que só existiam no Firestore.
        fbDocsSeen.add(docId);
        const wasAllSeenBefore=fbHasReceivedFirstSnapshot;
        const allSeen=fbDocsSeen.size>=ALL_SYNC_DOC_IDS.length;
        if(allSeen){fbHasReceivedFirstSnapshot=true;hideInitialLoadOverlay();}
        if(needsInitialPush&&allSeen)pushToFirestore();
        else if(allSeen&&!wasAllSeenBefore){pruneHeavyData(S);pushToFirestore();} // sincronização inicial completa agora — limpa qualquer lixo que veio junto e envia a versão corrigida
        fbSyncStatus=fbHasReceivedFirstSnapshot?'online':'connecting';
        updateSyncBadge();
        if(fbHasReceivedFirstSnapshot)runAutoBackupIfNeeded();
      },
      (err)=>{
        if(connectTimeout)clearTimeout(connectTimeout);
        fbSyncStatus='offline';
        updateSyncBadge();
        showLoadOverlayError(err);
      }
    );
  });
}

let lastSizeWarningAt=0;
function pushToFirestore(){
  if(!fbDb||!fbReady)return;
  if(fbDocsSeen.size<ALL_SYNC_DOC_IDS.length){
    // Ainda não confirmamos o que já existe em TODOS os documentos —
    // nunca escreve nada antes disso, pra nunca sobrescrever dados reais
    // com um estado local que ainda não incorporou o que está no Firestore.
    // A próxima ação do usuário (ou o fim da sincronização inicial) vai
    // disparar um novo save() e tentar de novo.
    return;
  }
  // Rede de segurança extra: se TODOS os 4 documentos vierem como "não
  // existe" mas o estado local também está vazio, isso quase certamente é
  // uma sessão nova/com falha de leitura, não o primeiro uso real do app —
  // não escreve nada, pra nunca arriscar apagar dados reais de ninguém.
  const allMissing=ALL_SYNC_DOC_IDS.every(id=>fbDocsStatus[id]==='não existe no Firestore');
  if(allMissing&&(!S.chatters||!S.chatters.length)){
    console.warn('pushToFirestore abortado: todos os documentos vieram vazios e o estado local também está vazio — não é seguro escrever.');
    return;
  }
  // Só ignora os snapshots de eco da NOSSA PRÓPRIA escrita — nunca antes
  // disso (essa era a causa de sessões novas ficarem com tudo vazio: o
  // save() inicial, ainda antes do Firebase conectar, já activava essa
  // janela de 3s e engolia os 4 documentos reais quando chegavam).
  fbIgnoreSnapshotsUntil=Date.now()+3000;
  const core={};
  Object.keys(S).forEach(k=>{if(!SHARD_FIELDS.includes(k))core[k]=S[k];});
  const jobs=[{id:FIREBASE_DOC_ID,data:core}];
  SHARD_FIELDS.forEach(f=>jobs.push({id:SHARD_DOC_IDS[f],data:{[f]:S[f]}}));
  jobs.forEach(({id,data})=>{
    const payload=JSON.stringify(data);
    // O Firestore tem limite de ~1MB por documento. Cada fatia (central,
    // fichas, faturamento, chatlab) é monitorada separadamente — avisamos
    // ANTES de estourar, não só quando já falhou.
    const sizeKB=Math.round(payload.length/1024);
    if(sizeKB>850&&Date.now()-lastSizeWarningAt>60000){
      lastSizeWarningAt=Date.now();
      toast(`⚠️ "${id}" ocupando ${sizeKB}KB de ~1024KB permitidos no Firestore — se passar do limite, essa parte para de sincronizar. Fale comigo se precisar liberar espaço.`,8000);
    }
    fbDb.collection('gestorpro').doc(id).set({
      payload,
      schemaVersion:SCHEMA_VERSION,
      updatedAt:firebase.firestore.FieldValue.serverTimestamp()
    }).then(()=>{
      fbSyncStatus='online';updateSyncBadge();
    }).catch((err)=>{
      console.error('Firestore write error ('+id+')',err);
      fbSyncStatus='offline';
      fbLastErrorMessage=(err&&err.code)?`${id}: ${err.code}`:'Erro ao salvar ('+id+')';
      updateSyncBadge();
      if(err&&(err.code==='invalid-argument'||/exceed|too large|longer than/i.test(err.message||''))){
        toast(`🚨 "${id}" grande demais pra sincronizar! Fale comigo urgente — por enquanto está tudo salvo só neste aparelho.`,10000);
      }
    });
  });
}

function updateSyncBadge(){
  const el=document.getElementById('sync-badge');
  if(!el)return;
  const map={
    connecting:{txt:'⏳ conectando',cls:'pill-flat'},
    online:{txt:'☁ sincronizado',cls:'pill-ok'},
    offline:{txt:'💾 local',cls:'pill-flat'},
    error:{txt:'💾 local',cls:'pill-flat'}
  };
  const s=map[fbSyncStatus]||map.offline;
  el.textContent=s.txt;
  el.className='pill '+s.cls;
  el.style.cursor='pointer';
  el.onclick=function(){
    if(fbSyncStatus==='online'){
      toast('☁ Sincronizado com Firebase');
    } else {
      toast('Tentando reconectar…');
      fbInitAttempts=0;
      initFirebaseWithRetry();
    }
  };
}
function currentViewName(){
  const active=document.querySelector('.view.active');
  return active?active.id.replace('v-',''):'home';
}

// Percorre TODO o estado recursivamente coletando os ids de qualquer objeto
// {id:...} encontrado (inclusive dentro de listas por data/semana, tipo
// turnoLog, demandas, absences, etc). Usado só pra detectar exclusões.
function collectAllIds(node,ids){
  ids=ids||new Set();
  if(Array.isArray(node)){
    node.forEach(item=>{
      if(item&&typeof item==='object'){
        if(item.id!=null)ids.add(item.id);
        collectAllIds(item,ids);
      }
    });
  } else if(node&&typeof node==='object'){
    Object.keys(node).forEach(k=>{if(k!=='_tombstones')collectAllIds(node[k],ids);});
  }
  return ids;
}
let _lastKnownIds=null; // snapshot dos ids vistos no último save() — pra detectar exclusões
// Marca um id como excluído NA HORA, sem depender do diff genérico de save()
// (que só funciona se _lastKnownIds já estiver inicializado). Chamado direto
// de cada função de exclusão explícita (turno, troca, etc) — é o jeito
// garantido de nunca deixar um snapshot remoto atrasado trazer o item de volta.
function markTombstone(id){
  if(id==null)return;
  if(!S._tombstones)S._tombstones={};
  S._tombstones[id]=Date.now();
}
// 10/08/2026 — a pedido da gestora, achado depois dela reclamar que
// "os endereços que eu excluo voltam": a tombstone acima só protege itens de
// LISTA (array com {id:...}, tipo turnos/trocas) — nunca cobria um CAMPO
// apagado dentro de um objeto (ex: delete ficha.dadosPJ, ou padrinhoId
// virando '' no deserdar). Quando ela apagava algo assim num dispositivo e
// um snapshot meio atrasado do OUTRO dispositivo chegava depois (ainda com o
// valor antigo), o deepMergeState (ver abaixo) não tinha como saber que
// aquele "campo vazio" era uma exclusão de propósito — só via um valor vazio
// vs um valor preenchido, e por padrão deixava o remoto (preenchido) vencer.
// Resultado: o dado apagado "ressuscitava" sozinho. tombstoneField funciona
// igual markTombstone, mas por CAMINHO (ex: 'chatterFichas.abc123.dadosPJ')
// em vez de por id — chame toda vez que apagar/zerar um campo que importa.
function tombstoneField(path){
  if(!path)return;
  if(!S._fieldTombstones)S._fieldTombstones={};
  S._fieldTombstones[path]=Date.now();
}

let localSaveFailCount=0;
let lastLocalSaveWarningAt=0;
function save(){
  pruneHeavyData(S); // limpa/dedupe antes de salvar, pra nunca deixar duplicata ir pro Firebase
  // Detecta o que sumiu desde o último save() e marca como excluído
  // (tombstone), pra um snapshot remoto desatualizado nunca conseguir
  // trazer esse item de volta num merge futuro.
  try{
    const currentIds=collectAllIds(S);
    if(_lastKnownIds){
      _lastKnownIds.forEach(id=>{
        if(!currentIds.has(id)){
          if(!S._tombstones)S._tombstones={};
          S._tombstones[id]=Date.now();
        }
      });
    }
    _lastKnownIds=currentIds;
  }catch(e){console.error('Erro ao detectar exclusões pra tombstone',e);}
  try{
    const payload=JSON.stringify(S);
    localStorage.setItem(DB,payload);
    // Always keep a rolling backup in a separate key
    localStorage.setItem('gestorpro_backup',payload);
    localStorage.setItem('gestorpro_backup_ts',Date.now().toString());
    localSaveFailCount=0;
  }catch(e){
    // Sem espaço? Libera a cópia duplicada de backup primeiro e tenta
    // salvar só a principal — melhor ter uma cópia local que nenhuma.
    try{
      localStorage.removeItem('gestorpro_backup');
      const payload=JSON.stringify(S);
      localStorage.setItem(DB,payload);
      localSaveFailCount=0;
    }catch(e2){
      localSaveFailCount++;
      console.error('Falha ao salvar localmente',e2);
      // Nunca falha em silêncio, mas avisa no máximo 1x a cada 30s — senão
      // o aviso repete a cada ação e trava a tela na prática.
      if(Date.now()-lastLocalSaveWarningAt>30000){
        lastLocalSaveWarningAt=Date.now();
        toast(`⚠️ Sem espaço para salvar localmente (${e2.name||'erro'}) — seus dados continuam seguros no Firebase, mas libere espaço no navegador quando puder.`,6000);
      }
    }
  }
  clearTimeout(fbSaveTimer);
  fbSaveTimer=setTimeout(()=>pushToFirestore(),600);
}
function load(){
  let loaded=false;
  // Try primary key first
  try{
    const d=localStorage.getItem(DB);
    if(d){
      const parsed=JSON.parse(d);
      if(parsed&&(parsed.chatters||parsed.models||parsed.revenues)){
        S={...S,...migrateState(parsed)};delete S.payload;delete S.schemaVersion;delete S.updatedAt;
        loaded=true;
      }
    }
  }catch(e){console.warn('Primary load failed, trying backup',e);}
  // Fallback to backup key if primary was empty/corrupt
  if(!loaded){
    try{
      const bk=localStorage.getItem('gestorpro_backup');
      if(bk){
        const parsed=JSON.parse(bk);
        if(parsed&&(parsed.chatters||parsed.models||parsed.revenues)){
          S={...S,...migrateState(parsed)};delete S.payload;delete S.schemaVersion;delete S.updatedAt;
          // Restore primary from backup
          localStorage.setItem(DB,bk);
          loaded=true;
          console.warn('Loaded from backup key');
        }
      }
    }catch(e){console.warn('Backup load also failed',e);}
  }
  // Estabelece a baseline de ids JÁ AQUI (antes de qualquer interação do
  // usuário ou resposta do Firestore). Sem isso, se o usuário excluísse algo
  // antes do primeiro save() ter uma baseline válida, nenhum tombstone era
  // criado e o item podia "voltar sozinho" quando um snapshot remoto atrasado
  // chegasse — essa era a causa raiz do bug de turno excluído reaparecendo.
  _lastKnownIds=collectAllIds(S);
}
let S={
  chatters:[],shifts:[],absences:[],orientations:[],studies:[],revenues:{},models:[],
  quickNotes:[],lastCode:null,
  turnoLog:{},          // date -> [{chatterId, action, time, note, otEnd}]
  midnightTasks:{},     // date -> [{id, chatterId, label, done}]
  dailyTasks:{},        // date -> [{id, text, prio, done}]
  weekGoals:{},         // weekKey -> [{id, text, type, target, current, done}]
  chatterWeekGoals:{},  // weekKey -> {chatterId: targetValue}
  weekNotes:{},         // weekKey -> text
  watchAlerts:{},       // date -> {chatterId: 'pending'|'confirmed'|'missed'}
  chatterTrainings:[],  // [{id, chatterId, title, done, createdAt}]
  hasSeededStudies:false,
  folgas:{},             // date -> [chatterId, ...] — manual day-off registrations
  reportDrafts:{},        // weekKey -> {field: value} — manual fields of weekly report
  reportTesterHidden:{},  // weekKey -> [chatterId,...] — testers removidos manualmente (arrastar pro lado) da seção "Chatters em Teste" daquele relatório
  smartAlertsDone:{},    // dateKey -> [alertId, ...]
  alertNotes:{},         // 'date_alertId' -> text
  horaExtraSlots:{},     // weekKey -> [{...}]
  swaps:[],              // [{id, date, covererId, originalId, ...}]
  problemsToday:[],      // persistent list [{id, text, done}] — does NOT reset daily
  demandas:{},           // dateKey -> [{id, text, done}]
  trainings:[],          // [{id, title, date, days:[{day, script}]}]
  weekEvolutions:{},     // weekKey -> [{id, label, done, missed}]
  modelRequests:{},      // weekKey -> [{id, modelId, text}]
  weeklyAnalysisDone:{}, // weekKey -> [chatterId,...] — quem já foi analisado essa semana
  dailyTasksByDay:{dom:[],seg:[],ter:[],qua:[],qui:[],sex:[],sab:[]}, // recorrentes por dia da semana
  weeklyTasks:{},  // weekKey -> [{id,text,time,urgent,done}]
  monthlyTasks:{}, // monthKey (YYYY-MM) -> [{id,text,time,urgent,done}]
  taskDoneLog:{},  // dateKey -> {taskId:true} — reset diário de tarefas semanais/mensais sem prazo fixo (t.date vazio)
  retentionDone:{}, // 'YYYY-MM-DD' (data daquele dia do ciclo Seg-Sex) -> true/false — feito do quadro de Aquecimento Discord
  creativityLog:{}, // dateKey -> {habitId:true} — hábitos diários do quadro de Exercício de Criatividade (Estudos)
  creativityWeekly:{}, // weekKey(seg) -> {done, review:{...}} — desafio semanal de exploração + revisão semanal
  mapRecordings:[], // [{id,name,transcript,date,mapped}] — gravações rápidas do novo Mapeamento (6 slots)
  mapSlotDrafts:{}, // '1'..'6' -> texto em andamento (recuperação de crash)
  mapeamentoBatches:[], // [{id,date,results:[...]}] — quadro MAPEAMENTO DOS NOVOS
  triagemCandidatos:[], // perfis de triagem ainda não vinculados a um tester — [{id,nome,...,date}]
  orientedThisWeek:{}, // weekKey -> [chatterId,...]
  weekPrize:{},          // weekKey -> {goal, winner, prize}
  motivational:{},       // weekKey -> {idea, chatters:{id:{issue, help}}}
  scheduleRequests:{},   // weekKey -> [{id, chatterId, text}]
  chatterFichas:{},      // chatterId -> {tech, behavior, potential, risk, history}
  estudosDraft:{},       // {fortes1,fortes2,fortes3,fracos1,fracos2,fracos3,foco1,foco2,foco3}
  estudosHistory:[],     // [{date, ...draft}] — snapshots
  managerProfile:{},     // {name, cargo, photoUrl}
  motivacionalHome:{},   // weekKey -> {idea, results}
  chatAnalyses:{},       // dateKey -> [{id, chatterId, ...scores, pontosFracos, pontosFortes}]
  chatlabAnalyses:[],    // ChatLab: [{id, chatterId, date, igp, raw, resumo}]
  chatlabWeeklyReports:{}, // chatterId -> [{weekKey, date, raw, generatedBy, analisesCount}]
  chatterTraining:{},    // chatterId -> texto "como treinar melhor"
  weekOrients:[],        // orientações da semana [{id, chatterId, text, done, doneWeek}]
  geradorMeu:[],         // gerador: chatters do meu time [{name, model, intervals:[{s,e,extra}]}]
  geradorExt:[],         // gerador: time externo
  geradorCanal:'PRIVACY FREE',
  geradorElite:[],         // [{name, model, salesRaw:'', sales:[{hora,bruto}]}]
  melhoras:[],           // [{id,text,how,done,doneWeek,createdWeek}]
  melhoraHistory:[],     // snapshots [{week,items:[{text,how,done}]}]
  estudosDraft2:{},      // misc draft
  semanaObjetivos:{},    // weekKey -> [{id, label, valor, done}]
  modelRequestsSplit:{}, // weekKey -> {modelId: text}
  demandas2:[],          // persistent list [{id,text,date,done}] — does NOT reset daily
  _tombstones:{},        // id -> timestamp da exclusão — impede que um item apagado
                          // localmente seja "ressuscitado" por um merge com um
                          // snapshot remoto (Firestore) que ainda não sabia da exclusão
  _fieldTombstones:{},   // 'caminho.dentro.do.objeto' -> timestamp — mesma ideia, mas
                          // pra um CAMPO apagado dentro de um objeto (ex: dadosPJ de um
                          // tester, ou padrinhoId zerado no deserdar), não um item de lista
                          // inteiro. Ver tombstoneField() e o comentário completo lá.
};

/* ===========================================================
   AUTOMATIC BACKUP — saves a daily snapshot to Firebase under
   gestorpro/backup-{dateKey} once per day. No manual action
   needed. The home screen shows when the last backup ran.
   =========================================================== */
let lastAutoBackupDate='';

function runAutoBackupIfNeeded(){
  if(!fbDb||!fbReady)return;
  const today=todayKey();
  if(lastAutoBackupDate===today)return;
  lastAutoBackupDate=today;
  const core={};
  Object.keys(S).forEach(k=>{if(!SHARD_FIELDS.includes(k))core[k]=S[k];});
  const jobs=[{id:`backup-${today}`,data:core}];
  SHARD_FIELDS.forEach(f=>jobs.push({id:`backup-${today}-${f}`,data:{[f]:S[f]}}));
  Promise.all(jobs.map(({id,data})=>
    fbDb.collection('gestorpro').doc(id).set({
      payload:JSON.stringify(data),
      createdAt:firebase.firestore.FieldValue.serverTimestamp(),
      schemaVersion:SCHEMA_VERSION
    })
  )).then(()=>{
    updateBackupStatus(`Último backup: hoje às ${nowHHMM()}`,'pill-ok');
  }).catch(err=>{
    console.error('Auto backup failed',err);
    updateBackupStatus('Backup falhou — dados principais no Firebase','pill-warn');
  });
}
function updateBackupStatus(msg,pillClass){
  const lb=document.getElementById('backup-status-lb');
  const pill=document.getElementById('backup-status-pill');
  if(lb)lb.textContent=msg;
  if(pill)pill.className='pill '+(pillClass||'pill-ok');
}

const DAYS=['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
const MONTHS=['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
const DAY_KEYS=['dom','seg','ter','qua','qui','sex','sab'];
// Verifica se um chatter NÃO precisava ter relatório/faturamento num dia
// específico — porque estava de folga (recorrente, s.folgaDia/folgaDia2),
// teve falta pontual justificada (S.absences tipo 'falta'), teve o turno
// inteiro repassado via swap pra outra pessoa, ou nem estava escalado
// naquele dia da semana. Usado pra não sinalizar "relatório faltando" em
// dias que a pessoa genuinamente não trabalhou.
function chatterNaoPrecisaDeRelatorio(chatterId,dateKey){
  const dow=new Date(dateKey+'T00:00:00').getDay();
  const dayAbbr=DAY_KEYS[dow];
  const hasFalta=(S.absences||[]).some(a=>a.chatterId===chatterId&&a.date===dateKey&&a.type==='falta');
  if(hasFalta)return true;
  const shifts=(S.shifts||[]).filter(s=>s.chatterId===chatterId&&(s.days||[]).includes(dayAbbr));
  if(!shifts.length)return true; // não estava escalado nesse dia da semana
  return shifts.every(s=>{
    const temBloco2=!!(s.start2&&s.end2);
    const bloco1Off=s.folgaDia===dayAbbr||(S.swaps||[]).some(sw=>sw.date===dateKey&&sw.shiftId===s.id&&sw.originalId===chatterId&&sw.start===s.start&&sw.end===s.end);
    const bloco2Off=!temBloco2||s.folgaDia2===dayAbbr||(S.swaps||[]).some(sw=>sw.date===dateKey&&sw.shiftId===s.id&&sw.originalId===chatterId&&sw.start===s.start2&&sw.end===s.end2);
    return bloco1Off&&bloco2Off;
  });
}
const LVLCLASS={treinamento:'lvl-treinamento',teste:'lvl-teste',junior:'lvl-junior',pleno:'lvl-pleno',senior:'lvl-senior',padrinho:'lvl-padrinho'};
const LVLEMOJI={treinamento:'◆',teste:'○',junior:'▲',pleno:'●',senior:'★',padrinho:'👑'};

// Tabela de metas semanais por categoria (Pagamento) — precisa vir logo no
// início do arquivo porque o Painel (Home) e outras telas já usam isso na
// primeira renderização, antes do resto do script terminar de carregar.
// ATENÇÃO: NÃO mover este bloco pra mais longe no arquivo — isso já causou
// o mesmo bug de "tela travada" 2 vezes nesta sessão.
const PAG_CATS={
  A:{n70:2500,p70:100, n85:3000,p85:120, n100:3500,p100:140},
  B:{n70:3500,p70:175, n85:4000,p85:210, n100:5000,p100:250},
  C:{n70:5000,p70:350, n85:6000,p85:425, n100:7000,p100:500},
  D:{n70:7000,p70:560, n85:8500,p85:680, n100:10000,p100:800},
  E:{n70:10000,p70:900,n85:12000,p85:1100,n100:14000,p100:1300},
};
const PAG_COM={0:0.04,1:0.04,2:0.045,3:0.05,4:0.06};
const PAG_COM_LABEL={0:'4%',1:'4%',2:'4,5%',3:'5%',4:'6%'};
const PAG_PISO={0:1000,1:1200,2:1500,3:1800,4:2500};
const PAG_MEDAL_LABEL={0:'Sem medalha',1:'🥉 Bronze',2:'🥈 Prata',3:'🥇 Ouro',4:'💎 Diamante'};

// ---------- HELPERS ----------
function p2(n){return String(n).padStart(2,'0');}
function fmt(d){return`${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`;}
function nowHHMM(){const n=new Date();return p2(n.getHours())+':'+p2(n.getMinutes());}
function todayKey(){return fmt(new Date());}
function getTodayDayKey(){return DAY_KEYS[new Date().getDay()];}

/* ===========================================================
   CICLO DE TAREFAS DE NOVATO — Sexta/Sábado/Domingo, ciclo fixo do
   calendário (não relativo à data de entrada de cada tester). Toda
   sexta é o "Dia 1", todo sábado "Dia 2", todo domingo "Dia 3" — e o
   prazo de cada dia é 00h00 do dia seguinte (vira bloqueado depois
   disso, é um critério de eliminação conforme pedido pela gestora).
   =========================================================== */
function getSextaDoCiclo(ref){
  const d=new Date(ref);
  const dow=d.getDay(); // 0=dom,5=sex,6=sab
  let diff;
  if(dow===5)diff=0;
  else if(dow===6)diff=1;
  else if(dow===0)diff=2;
  else diff=dow+2; // seg(1)->3,ter(2)->4,qua(3)->5,qui(4)->6 dias desde a sexta anterior
  const sex=new Date(d.getFullYear(),d.getMonth(),d.getDate()-diff);
  return sex;
}
function getCicloNovatoInfo(ref){
  const now=ref?new Date(ref):new Date();
  const sex=getSextaDoCiclo(now);
  const fridayKey=fmt(sex);
  const dias=[1,2,3].map(n=>{
    const dataDia=new Date(sex.getFullYear(),sex.getMonth(),sex.getDate()+(n-1));
    const dataKey=fmt(dataDia);
    const prazo=new Date(dataDia.getFullYear(),dataDia.getMonth(),dataDia.getDate()+1); // 00h do dia seguinte
    return{dia:n,dataKey,prazo,label:['Sexta','Sábado','Domingo'][n-1]};
  });
  return{fridayKey,dias};
}
// status do Dia N (1/2/3) de um tester dentro de um ciclo (fridayKey): 'enviado'|'bloqueado'|'aberto'|'futuro'
function getStatusTarefaNovatoDia(cid,fridayKey,diaN){
  const registro=S.tarefasNovatoPorTester?.[cid]?.[fridayKey]?.['dia'+diaN];
  if(registro&&registro.enviadoEm)return'enviado';
  const sex=new Date(fridayKey+'T12:00:00');
  const dataDia=new Date(sex.getFullYear(),sex.getMonth(),sex.getDate()+(diaN-1));
  const prazo=new Date(dataDia.getFullYear(),dataDia.getMonth(),dataDia.getDate()+1);
  const inicioDia=new Date(dataDia.getFullYear(),dataDia.getMonth(),dataDia.getDate());
  const agora=new Date();
  if(agora>=prazo)return'bloqueado';
  if(agora>=inicioDia)return'aberto';
  return'futuro';
}
// weekOffset: 0=current, -1=last week, -2=two weeks ago, etc.
let weekOffset=0;

// Semana de análise da empresa: SEGUNDA a DOMINGO (não domingo a sábado).
// Ex: 06-12, 13-19, 20-26, 27-2 ... — toda semana começa na segunda-feira.
function getMondayOfWeek(d){
  const dow=d.getDay(); // 0=dom..6=sab
  const diff=dow===0?6:dow-1; // dias desde a última segunda-feira
  const mon=new Date(d);
  mon.setDate(d.getDate()-diff);
  return mon;
}
function getWeekDates(offset){
  const off=offset!==undefined?offset:weekOffset;
  const mon=getMondayOfWeek(new Date());
  mon.setDate(mon.getDate()+off*7);
  return Array.from({length:7},(_,i)=>{const d=new Date(mon);d.setDate(mon.getDate()+i);return d;});
}
function getWeekKey(offset){const wd=getWeekDates(offset!==undefined?offset:weekOffset);return fmt(wd[0]);}
function weekLabel(offset){
  const o=offset!==undefined?offset:weekOffset;
  if(o===0)return'Esta semana';
  if(o===-1)return'Semana passada';
  const wd=getWeekDates(o);
  return wd[0].getDate()+'/'+(wd[0].getMonth()+1)+' – '+wd[6].getDate()+'/'+(wd[6].getMonth()+1);
}
function setWeekOffset(o){
  weekOffset=o;
  // re-render all week-sensitive views
  const v=currentViewName();
  if(v==='semana')renderSemana();
  if(v==='report')renderReport_Weekly();
  if(v==='evolucao')renderEvolucao();
  if(v==='metricas')renderMetricas();
  if(v==='fichas'){const sel=document.getElementById('ficha-chatter-select');if(sel&&sel.value)renderFichaChatter(sel.value);}
  renderWeekNav();
}
function renderWeekNav(){
  document.querySelectorAll('.week-nav').forEach(el=>{
    const now=getWeekDates(0);
    const wd=getWeekDates();
    const label=weekLabel();
    const isNow=weekOffset===0;
    el.innerHTML=`<div style="display:flex;align-items:center;gap:6px">
      <button onclick="setWeekOffset(weekOffset-1)" style="background:var(--bg-soft);border:1px solid var(--line);border-radius:7px;padding:4px 10px;cursor:pointer;font-size:14px;color:var(--text2)">‹</button>
      <div style="font-size:12.5px;font-weight:600;color:var(--text2);min-width:140px;text-align:center">${label}${isNow?' <span style="font-size:10px;color:var(--ok)">(atual)</span>':''}</div>
      <button onclick="setWeekOffset(weekOffset+1)" ${isNow?'disabled style="opacity:.3;cursor:not-allowed"':''} style="background:var(--bg-soft);border:1px solid var(--line);border-radius:7px;padding:4px 10px;cursor:pointer;font-size:14px;color:var(--text2)">›</button>
      ${!isNow?`<button onclick="setWeekOffset(0)" style="background:var(--accent-soft);border:none;border-radius:7px;padding:4px 9px;cursor:pointer;font-size:11px;font-weight:600;color:var(--accent)">hoje</button>`:''}
    </div>`;
  });
}
function money(n){return 'R$ '+ (n||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});}
function moneyShort(n){return 'R$'+(n||0).toLocaleString('pt-BR',{maximumFractionDigits:0});}

// ---------- NAV ----------
const VIEWS=['home','turno','semana','time','fat','report','extra','gerador','gestao','estrategia','fichas','estudos','evolucao','chatlab','testers','reservas','pagamento','metricas','projecao'];
// Render timestamp cache — debounce rapid re-renders (Firebase sync spam)
const _rts={};

function navTo(view){
  if(!view)return;
  VIEWS.forEach(v=>{const el=document.getElementById('v-'+v);if(el)el.classList.remove('active');});
  const target=document.getElementById('v-'+view);
  if(target)target.classList.add('active');
  document.querySelectorAll('.toptab').forEach(t=>t.classList.toggle('active',t.dataset.go===view));
  document.querySelectorAll('.navbtn').forEach(t=>t.classList.toggle('active',t.dataset.go===view));
  _rts[view]=0; // reset so explicit nav always renders
  renderView(view);
  closeAppMenu(); // fecha o menu-drawer (se estiver aberto) toda vez que troca de aba
}

/* ===========================================================
   MENU ESTILO APP (drawer) — abre ao clicar no logo G. Mostra a
   foto de perfil da gestora (mesma S.managerProfile já usada no
   painel de Gestão) + a lista de abas, que viraram uma navegação
   vertical em vez de ficarem sempre fixas no topo.
   =========================================================== */
function toggleAppMenu(){
  const ov=document.getElementById('appmenu-overlay');
  if(!ov)return;
  const opening=!ov.classList.contains('open');
  if(opening)renderAppMenuProfile();
  ov.classList.toggle('open',opening);
}
function closeAppMenu(){
  document.getElementById('appmenu-overlay')?.classList.remove('open');
}
function closeAppMenuIfBackdrop(e){
  if(e.target.id==='appmenu-overlay')closeAppMenu();
}
function renderAppMenuProfile(){
  const p=S.managerProfile||{};
  const av=document.getElementById('appmenu-avatar');
  if(av)av.innerHTML=p.photoUrl?`<img src="${p.photoUrl}" style="width:100%;height:100%;object-fit:cover">`:'G';
  const nm=document.getElementById('appmenu-name');
  if(nm)nm.textContent=p.name||'Mia';
  const cg=document.getElementById('appmenu-cargo');
  if(cg)cg.textContent=p.cargo||'Manager';
}

/* ===========================================================
   SWIPE ENTRE ABAS — arrastar o dedo pra esquerda/direita na tela
   troca de aba, seguindo a mesma ordem em que elas aparecem no
   menu-drawer. Ignora o gesto se: começou dentro de um card que
   já tem seu próprio swipe-pra-excluir (identificado pelo atributo
   data-key, usado por attachSwipeDismiss/attachSwipeToDelete),
   começou num input/textarea/select/botão, ou começou dentro de
   algo que já rola na horizontal (tabela larga, segtabs etc) —
   detectado genericamente por scrollWidth>clientWidth, sem precisar
   listar cada classe manualmente.
   =========================================================== */
function getSwipeViewOrder(){
  return[...document.querySelectorAll('#toptabs .toptab')].map(t=>t.dataset.go).filter(Boolean);
}
function isInsideHorizScroll(el,boundary){
  let node=el;
  while(node&&node!==boundary&&node!==document.body){
    if(node.scrollWidth>node.clientWidth+2)return true;
    node=node.parentElement;
  }
  return false;
}
// V2: a primeira versão só olhava touchstart/touchend — num toque real de
// verdade o dedo quase nunca se move 100% na horizontal, sempre tem um
// pouco de deriva vertical, e como não existia handler de touchmove o
// scroll vertical nativo rolava a página AO MESMO TEMPO, competindo com o
// gesto e fazendo o cálculo final de deltaY ficar grande demais — o que
// descartava o swipe na prática. Agora trava a DIREÇÃO logo nos primeiros
// ~10px de movimento (como qualquer carrossel de app): se for predominante
// horizontal, chama preventDefault nos touchmove seguintes pra impedir o
// scroll vertical de competir; se for vertical, solta o gesto e deixa o
// scroll normal da página acontecer.
(function initViewSwipe(){
  const area=document.querySelector('.main');
  if(!area)return;
  const LOCK_PX=10,NAV_PX=60;
  let sx=0,sy=0,tracking=false,dir=null; // dir: null (ainda decidindo) | 'h' | 'v'
  const onStart=e=>{
    if(e.target.closest('[data-key]')||e.target.closest('input,textarea,select,button,a')){
      tracking=false;dir=null;return;
    }
    const t=e.touches?e.touches[0]:e;
    sx=t.clientX;sy=t.clientY;tracking=true;dir=null;
  };
  const onMove=e=>{
    if(!tracking)return;
    const t=e.touches?e.touches[0]:e;
    const dx=t.clientX-sx,dy=t.clientY-sy;
    if(dir===null){
      if(Math.abs(dx)<LOCK_PX&&Math.abs(dy)<LOCK_PX)return; // ainda pouco movimento pra decidir
      const wantsHoriz=Math.abs(dx)>Math.abs(dy)*1.2;
      // Só trava como swipe horizontal se não estiver dentro de algo que já
      // rola na horizontal por conta própria (tabela larga, segtabs etc).
      dir=(wantsHoriz&&!isInsideHorizScroll(e.target,area))?'h':'v';
      if(dir==='v')tracking=false; // solta o gesto pro scroll nativo assumir
    }
    if(dir==='h'&&e.cancelable)e.preventDefault();
  };
  const onEnd=e=>{
    if(!tracking||dir!=='h'){tracking=false;dir=null;return;}
    tracking=false;
    const t=e.changedTouches?e.changedTouches[0]:e;
    const dx=t.clientX-sx;
    dir=null;
    if(Math.abs(dx)<NAV_PX)return;
    const order=getSwipeViewOrder();
    const cur=document.querySelector('.view.active')?.id?.replace('v-','');
    const idx=order.indexOf(cur);
    if(idx===-1)return;
    if(dx<0&&idx<order.length-1)navTo(order[idx+1]); // arrastou pra esquerda → próxima aba
    else if(dx>0&&idx>0)navTo(order[idx-1]); // arrastou pra direita → aba anterior
  };
  area.addEventListener('touchstart',onStart,{passive:true});
  area.addEventListener('touchmove',onMove,{passive:false});
  area.addEventListener('touchend',onEnd);
})();
function renderView(v){
  // Debounce: skip if same view rendered < 350ms ago (prevents Firebase sync re-render spam)
  const now=Date.now();
  if(_rts[v]&&(now-_rts[v])<350)return;
  _rts[v]=now;
  // Guard: only render if this view is currently active
  const activeId=document.querySelector('.view.active')?.id?.replace('v-','');
  if(activeId&&activeId!==v)return;
  if(v==='home')renderHome();
  else if(v==='turno')renderTurno();
  else if(v==='semana')renderSemana();
  else if(v==='time')renderTeam('all');
  else if(v==='fat')renderFat();
  else if(v==='report')renderReport_Weekly();
  else if(v==='extra')renderExtra();
  else if(v==='gerador')renderGerador();
  else if(v==='gestao')renderGestao();
  else if(v==='estrategia')renderEstrategia();
  else if(v==='fichas')renderFichas();
  else if(v==='estudos')renderEstudos();
  else if(v==='evolucao')renderEvolucao();
  else if(v==='chatlab')renderChatLab();
  else if(v==='testers')renderTesters();
  else if(v==='reservas')renderReservas();
  else if(v==='pagamento')renderPagamento();
  else if(v==='metricas')renderMetricas();
  else if(v==='projecao')renderProjecao();
}
document.querySelectorAll('.toptab,.navbtn').forEach(el=>el.addEventListener('click',()=>navTo(el.dataset.go)));

// ---------- MODAL ----------
function openModal(id){
  document.getElementById(id).classList.add('open');
  if(['m-shift','m-absence','m-orient','m-overtime'].includes(id))populateChatterSelects();
  if(id==='m-swap')initSwapModal();
  if(id==='m-manual-status')openManualStatusModal();
  if(id==='m-shift'){
    populateShiftModelChips();
    if(!document.getElementById('shift-edit-id').value){
      document.getElementById('shift-modal-title').textContent='Escalar chatter';
      document.getElementById('shift-start').value='';
      document.getElementById('shift-end').value='';
      document.getElementById('shift-start2').value='';
      document.getElementById('shift-end2').value='';
      document.querySelectorAll('#m-shift .chip[data-day]').forEach(c=>c.classList.remove('sel'));
      document.querySelectorAll('#m-shift .chip-folga').forEach(c=>c.classList.remove('sel'));
      document.querySelectorAll('#m-shift .chip-folga2').forEach(c=>c.classList.remove('sel'));
      // Default folga chip = "Nenhum"
      const noneChip=document.querySelector('#m-shift .chip-folga[data-folga=""]');
      if(noneChip)noneChip.classList.add('sel');
      const nc2=document.querySelector('#m-shift .chip-folga2[data-folga=""]');
      if(nc2)nc2.classList.add('sel');
    }
    // Folga chips: single-select behavior
    document.querySelectorAll('#m-shift .chip-folga').forEach(chip=>{
      chip.onclick=()=>{
        document.querySelectorAll('#m-shift .chip-folga').forEach(c=>c.classList.remove('sel'));
        chip.classList.add('sel');
      };
    });
    document.querySelectorAll('#m-shift .chip-folga2').forEach(chip=>{
      chip.onclick=()=>{
        document.querySelectorAll('#m-shift .chip-folga2').forEach(c=>c.classList.remove('sel'));
        chip.classList.add('sel');
      };
    });
  }
  if(id==='m-overtime'){document.getElementById('ot-date').value=todayKey();document.getElementById('ot-start').value=nowHHMM();}
  if(id==='m-revreport')buildRevReport();
  if(id==='m-goal'){document.getElementById('goal-text').value='';document.getElementById('goal-target').value='';}
  if(id==='m-pergunte-ia'){
    document.getElementById('ia-pergunta-input').value='';
    document.getElementById('ia-pergunta-resposta').innerHTML='';
    renderIaPerguntaHistorico();
  }
}
function populateShiftModelChips(){
  const el=document.getElementById('shift-model-chips');
  const note=document.getElementById('shift-model-empty-note');
  if(!S.models.length){
    el.innerHTML='';
    note.textContent='Nenhum modelo cadastrado ainda — cadastre na aba Faturamento.';
    return;
  }
  note.textContent='';
  el.innerHTML=S.models.map(m=>`<button class="chip" data-model="${m.id}">${m.emoji||'🧩'} ${m.name}</button>`).join('');
  el.querySelectorAll('.chip').forEach(chip=>chip.addEventListener('click',()=>chip.classList.toggle('sel')));
}
function closeModal(id){
  document.getElementById(id).classList.remove('open');
  if(id==='m-mapeamento')stopMapeamentoRecording(true);
  if(id==='m-shift'){
    document.getElementById('shift-edit-id').value='';
    document.getElementById('shift-modal-title').textContent='Escalar chatter';
    document.getElementById('shift-start2').value='';
    document.getElementById('shift-end2').value='';
    document.querySelectorAll('#m-shift .chip-folga').forEach(c=>c.classList.remove('sel'));
    document.querySelectorAll('#m-shift .chip-folga2').forEach(c=>c.classList.remove('sel'));
    const noneChip=document.querySelector('#m-shift .chip-folga[data-folga=""]');
    if(noneChip)noneChip.classList.add('sel');
    const noneChip2=document.querySelector('#m-shift .chip-folga2[data-folga=""]');
    if(noneChip2)noneChip2.classList.add('sel');
  }
}
document.querySelectorAll('.modalbg').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('open');}));
function toggleGoalTarget(){
  const t=document.getElementById('goal-type').value;
  document.getElementById('goal-target-field').style.display=t==='valor'?'block':'none';
}

// ---------- TOAST ----------
function toast(msg,dur=2300){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),dur);}

// ---------- CLOCK ----------
function updateClock(){
  const now=new Date();
  const elClock=document.getElementById('hd-clock');if(elClock)elClock.textContent=`${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
  const elDate=document.getElementById('hd-date');if(elDate)elDate.textContent=`${DAYS[now.getDay()]}, ${now.getDate()} ${MONTHS[now.getMonth()]}`;
  updateAlarmCountdown();
  checkMidnightGeneration();
  // Refresh escritório every minute — schedule-based status changes on the minute
  if(now.getSeconds()===0){
    renderEscritorioPanel();
    renderSmartAlerts();
  }
}

function getComputedLevelColor(level){
  const map={treinamento:'#6E6AF0',teste:'#8A8A93',junior:'#2F8FE0',pleno:'#C98A1F',senior:'#1F9E6E',padrinho:'#B8860B'};
  return map[level]||'#8A8A93';
}

/* ===========================================================
   FEATURE 2 — DAILY TASKS (general checklist, not chatter-bound)
   =========================================================== */


/* ===========================================================
   FEATURE 3 — WEEKLY GOALS (team-level planning)
   =========================================================== */
function renderSemana(){
  renderWeekNav();
  renderWeekOrients();
  renderMetaRiskBoard();
  renderWeeklyRanking();
  renderGargaloSemana();
  const wk=getWeekDates();
  document.getElementById('semana-range').textContent=`${wk[0].getDate()}/${wk[0].getMonth()+1} – ${wk[6].getDate()}/${wk[6].getMonth()+1}`;
  const notesEl=document.getElementById('week-notes');
  if(notesEl&&!notesEl.value)notesEl.value=S.weekNotes[getWeekKey()]||'';
  renderGoals();
  renderSemanaRevenue();
  renderSemanaDesenvolvimento();
}
// Ranking da semana: maior ticket médio, quem mais lucrou de hora extra,
// quem tá mais perto da meta, e quem vende mais rápido (valor/hora).
function renderGargaloSemana(){
  const el=document.getElementById('gargalo-semana-board');
  if(!el)return;
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  if(!chatters.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Sem chatters no time</div>';return;}
  const wkey=getWeekKey(0);
  const goals=S.chatterWeekGoals[wkey]||{};
  let worst=null,worstPct=101;
  chatters.forEach(c=>{
    const cat=S.chatterFichas?.[c.id]?.pagCategoria||'B';
    const metaManual=parseFloat(goals[c.id])||0;
    const meta=metaManual>0?metaManual:(PAG_CATS[cat]?.n100||0);
    if(!meta)return;
    const rev=getChatterWeekRevenue(c.id,0);
    const pct=rev/meta*100;
    if(pct<worstPct){worstPct=pct;worst=c;}
  });
  if(!worst){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Sem dados suficientes ainda essa semana</div>';return;}
  const f=S.chatterFichas?.[worst.id];
  const analytics=f?.analytics?.weeklyData||{};
  const dates=Object.keys(analytics).sort();
  const latest=dates.length?analytics[dates[dates.length-1]]:null;
  let suggestion='Converse sobre o ritmo da semana e reforce a meta com ela.';
  if(latest){
    if(latest.ticketMedio>0&&latest.ticketMedio<50)suggestion='Foco em ticket médio: treinar upsell e ofertas de maior valor por venda.';
    else if(latest.vendasPorHora>0&&latest.vendasPorHora<10)suggestion='Foco em ritmo: reduzir tempo parado e responder mais rápido no chat.';
    else if(latest.highTicketPct<10)suggestion='Foco em high ticket: incentivar oferecer pacotes acima de R$300 com mais frequência.';
    else if(latest.maxGapMin>60)suggestion='Foco em presença: teve um intervalo grande sem vender — verificar o que aconteceu no turno.';
  }
  el.innerHTML=`<div style="background:var(--bad-soft);border-radius:10px;padding:12px">
    <div style="font-weight:700;font-size:13.5px;margin-bottom:4px">${worst.name} — ${Math.round(worstPct)}% da meta</div>
    <div style="font-size:12.5px;color:var(--text2)">💡 ${suggestion}</div>
    <button class="btn btn-ghost btn-xs" style="margin-top:8px" onclick="openChatterDetail('${worst.id}')">Ver perfil →</button>
  </div>`;
}
function renderWeeklyRanking(){
  const el=document.getElementById('week-ranking-board');
  if(!el)return;
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  if(!chatters.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Sem chatters no time</div>';return;}
  const wkey=getWeekKey(weekOffset);
  const goals=S.chatterWeekGoals[wkey]||{};
  const rows=chatters.map(c=>{
    const f=S.chatterFichas[c.id];
    const wd=getWeekDates(weekOffset);
    const analytics=f?.analytics?.weeklyData||{};
    let ticketSum=0,vphSum=0,days=0,vendasSum=0;
    wd.forEach(d=>{const a=analytics[fmt(d)];if(a&&a.ticketMedio>0){ticketSum+=a.ticketMedio;vphSum+=a.vendasPorHora||0;days++;}if(a)vendasSum+=a.totalVendas||0;});
    const avgTicket=days>0?ticketSum/days:0;
    const avgVph=days>0?vphSum/days:0;
    const rev=getChatterWeekRevenue(c.id,weekOffset);
    const extraFat=getChatterExtraRevenue(c.id,weekOffset);
    const extraBonus=extraFat*0.10;
    const cat=f?.pagCategoria||'B';
    const metaManual=parseFloat(goals[c.id])||0;
    const meta=metaManual>0?metaManual:(PAG_CATS[cat]?.n100||0);
    const pct=meta>0?(rev/meta*100):0;
    // Melhora da semana: compara o % da meta dessa semana com o da semana
    // anterior — quem mais subiu (e já tinha um número real pra comparar).
    const prevGoals=S.chatterWeekGoals[getWeekKey(weekOffset-1)]||{};
    const prevMetaManual=parseFloat(prevGoals[c.id])||0;
    const prevMeta=prevMetaManual>0?prevMetaManual:(PAG_CATS[cat]?.n100||0);
    const prevRev=getChatterWeekRevenue(c.id,weekOffset-1);
    const prevPct=prevMeta>0?(prevRev/prevMeta*100):0;
    const melhora=prevPct>0?pct-prevPct:null;
    const htTotal=getChatterWeekHighTicket(c.id,weekOffset).htTotal;
    // Whales criados essa semana, segundo o diagnóstico do ChatLab (tags.sinalDeWhale).
    const whaleCount=calcMetricasSemana(coletarAnalisesDaSemana(c.id,weekOffset)).whaleCount||0;
    // Melhor conexão da semana — nota de "Conexão Emocional" (0-10) que já
    // fica no Dashboard de cada análise do ChatLab (mesma fonte usada na
    // aba Métricas via getChatLabCategoryAverages/parseChatLabDashboard,
    // lendo o texto salvo — nenhuma chamada nova de IA).
    const conexaoAvg=getChatLabCategoryAverages(coletarAnalisesDaSemana(c.id,weekOffset)).conexao;
    const avgConexao=conexaoAvg!=null?Math.round(conexaoAvg*10)/10:0;
    return{c,avgTicket,avgVph,extraBonus,pct,vendasSum,melhora,prevPct,htTotal,whaleCount,avgConexao};
  });
  // Produto mais vendido da semana (time inteiro): tally por tipo de high
  // ticket (Personalizado/Foto/Vídeo/Mimo) detectado nos relatórios colados.
  const produtoTally={};
  chatters.forEach(c=>{
    const f=S.chatterFichas[c.id];
    const analytics=f?.analytics?.weeklyData||{};
    getWeekDates(weekOffset).forEach(d=>{
      const a=analytics[fmt(d)];
      (a&&a.highTicketItems||[]).forEach(item=>{
        if(!produtoTally[item.tipo])produtoTally[item.tipo]={count:0,total:0};
        produtoTally[item.tipo].count++;
        produtoTally[item.tipo].total+=item.val;
      });
    });
  });
  const produtoSorted=Object.entries(produtoTally).sort((a,b)=>b[1].count-a[1].count);
  const produtoMaisVendido=produtoSorted.length?{name:`${HT_TIPO_ICON[produtoSorted[0][0]]||'💎'} ${produtoSorted[0][0]}`,val:`${produtoSorted[0][1].count} venda${produtoSorted[0][1].count>1?'s':''} · ${money(produtoSorted[0][1].total)}`}:null;
  const top=(key,fmtFn)=>{
    const sorted=[...rows].filter(r=>r[key]>0).sort((a,b)=>b[key]-a[key]);
    if(!sorted.length)return null;
    return{name:sorted[0].c.name,val:fmtFn(sorted[0][key])};
  };
  // Diferente dos outros cards do ranking, "Criou mais whales" sempre
  // aparece — mesmo em 0 — porque é um indicador que a Mia quer acompanhar
  // toda semana, não só quando alguém já criou algum.
  const topWhales=(()=>{
    const sorted=[...rows].sort((a,b)=>b.whaleCount-a.whaleCount);
    if(!sorted.length||!sorted[0].whaleCount)return{name:'—',val:'0 essa semana'};
    return{name:sorted[0].c.name,val:`${sorted[0].whaleCount} whale${sorted[0].whaleCount>1?'s':''}`};
  })();
  const topMelhora=(()=>{
    // Só entra quem estava "mal" (abaixo de 70% da meta na semana anterior)
    // — a ideia é destacar quem vinha com dificuldade e deu um salto, não
    // quem já ia bem e melhorou um pouco mais.
    const sorted=rows.filter(r=>r.melhora!==null&&r.melhora>0&&r.prevPct<70).sort((a,b)=>b.melhora-a.melhora);
    if(!sorted.length)return null;
    return{name:sorted[0].c.name,val:`+${Math.round(sorted[0].melhora)}pp (vinha de ${Math.round(sorted[0].prevPct)}%)`};
  })();
  const cards=[
    {label:'🎫 Maior ticket',data:top('avgTicket',v=>money(v))},
    {label:'🛍️ Mais vendas',data:top('vendasSum',v=>`${v} venda${v>1?'s':''}`)},
    {label:'⚡ Mais lucro em hora extra',data:top('extraBonus',v=>money(v))},
    {label:'🎯 Mais perto da meta',data:top('pct',v=>Math.round(v)+'%')},
    {label:'🚀 Vende mais rápido',data:top('avgVph',v=>money(v)+'/h')},
    {label:'💎 Mais high ticket',data:top('htTotal',v=>money(v))},
    {label:'🐋 Criou mais whales',data:topWhales},
    {label:'💞 Melhor conexão',data:top('avgConexao',v=>`${v}/10`)},
    {label:'🏆 Produto mais vendido',data:produtoMaisVendido},
    {label:'📈 Melhora da semana',data:topMelhora},
  ].filter(x=>x.data);
  if(!cards.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Sem dados suficientes essa semana ainda</div>';return;}
  el.innerHTML=`<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${cards.map(x=>`
    <div style="background:var(--bg-soft);border-radius:9px;padding:9px">
      <div style="font-size:10px;color:var(--text3);margin-bottom:3px">${x.label}</div>
      <div style="font-size:13px;font-weight:700">${x.data.name}</div>
      <div style="font-size:11.5px;color:var(--ok);font-weight:600">${x.data.val}</div>
    </div>`).join('')}</div>`;
}
function renderGoals(){
  const el=document.getElementById('goals-list');
  const wkey=getWeekKey();
  const goals=S.weekGoals[wkey]||[];
  if(!goals.length){el.innerHTML='<div class="empty"><div class="empty-ic">🎯</div><div class="empty-tx">Nenhum objetivo definido para esta semana.<br>Defina metas para guiar o time.</div></div>';return;}
  el.innerHTML=goals.map(g=>{
    if(g.type==='simples'){
      return`<div class="goalcard ${g.done?'met':''}" data-key="${g.id}" style="touch-action:pan-y">
        <div class="goal-top">
          <div class="goal-text" style="${g.done?'text-decoration:line-through;color:var(--text3)':''}">${g.text}</div>
          <button class="tcheck ${g.done?'done':''}" onclick="toggleGoalDone('${g.id}')">${g.done?'✓':''}</button>
        </div>
        <button class="btn btn-icon btn-line" style="margin-top:4px" onclick="deleteGoal('${g.id}')">✕</button>
      </div>`;
    }
    const pct=g.target>0?Math.min(100,Math.round((g.current/g.target)*100)):0;
    const met=pct>=100;
    return`<div class="goalcard ${met?'met':''}" data-key="${g.id}" style="touch-action:pan-y">
      <div class="goal-top">
        <div class="goal-text">${g.text}</div>
        <button class="btn btn-icon btn-line" onclick="deleteGoal('${g.id}')">✕</button>
      </div>
      <div class="goalbar-track"><div class="goalbar-fill" style="width:${pct}%"></div></div>
      <div class="goal-nums">
        <span>${g.current.toLocaleString('pt-BR')} / ${g.target.toLocaleString('pt-BR')}</span>
        <span style="color:${met?'var(--ok)':'var(--warn)'}">${pct}%</span>
      </div>
      <div style="display:flex;gap:6px;margin-top:9px">
        <input type="number" inputmode="decimal" class="finput" style="flex:1" id="goal-update-${g.id}" placeholder="Atualizar valor atual...">
        <button class="btn btn-soft btn-sm" onclick="updateGoalProgress('${g.id}')">Atualizar</button>
      </div>
    </div>`;
  }).join('');
  attachSwipeToDelete(el,'.goalcard',id=>deleteGoal(id),renderGoals);
}
function saveGoal(){
  const text=document.getElementById('goal-text').value.trim();
  if(!text){toast('⚠️ Descreva o objetivo');return;}
  const type=document.getElementById('goal-type').value;
  const target=parseFloat(document.getElementById('goal-target').value)||0;
  const wkey=getWeekKey();
  if(!S.weekGoals[wkey])S.weekGoals[wkey]=[];
  S.weekGoals[wkey].push({id:'g'+Date.now(),text,type,target,current:0,done:false});
  save();closeModal('m-goal');toast('🎯 Objetivo adicionado!');renderGoals();
}
function toggleGoalDone(id){
  const wkey=getWeekKey();
  const g=(S.weekGoals[wkey]||[]).find(x=>x.id===id);
  if(g){g.done=!g.done;save();renderGoals();}
}
function updateGoalProgress(id){
  const wkey=getWeekKey();
  const g=(S.weekGoals[wkey]||[]).find(x=>x.id===id);
  const val=parseFloat(document.getElementById('goal-update-'+id)?.value);
  if(g&&!isNaN(val)){g.current=val;save();toast('📈 Progresso atualizado!');renderGoals();}
}
function deleteGoal(id){
  const wkey=getWeekKey();
  S.weekGoals[wkey]=(S.weekGoals[wkey]||[]).filter(x=>x.id!==id);
  save();renderGoals();toast('Removido');
}
function saveWeekNotes(){
  S.weekNotes[getWeekKey()]=document.getElementById('week-notes').value;
  save();toast('📝 Notas salvas!');
}
function renderSemanaRevenue(){
  const el=document.getElementById('semana-revenue-preview');
  const wd=getWeekDates();
  const chatters=S.chatters.filter(c=>c.time!=='tester'&&c.time!=='elite'&&!isChatterTerminated(c));
  let total=0;
  wd.forEach(d=>chatters.forEach(c=>S.models.forEach(m=>{total+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(d)}`])||0;})));
  el.innerHTML=`<div style="font-family:var(--font-mono);font-size:30px;font-weight:700;color:var(--ok);text-align:center;padding:8px 0">${money(total)}</div>
  <div class="barchart">${['DOM','SEG','TER','QUA','QUI','SEX','SÁB'].map((lb,i)=>{
    let r=0;chatters.forEach(c=>S.models.forEach(m=>{r+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(wd[i])}`])||0;}));
    const max=Math.max(...wd.map(dd=>{let rr=0;chatters.forEach(c=>S.models.forEach(m=>{rr+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(dd)}`])||0;}));return rr;}),1);
    const h=Math.max(3,Math.round((r/max)*46));
    return`<div class="barcol"><div class="barfill" style="height:${h}px"></div><div class="barlb">${lb}</div></div>`;
  }).join('')}</div>`;
}

/* ===========================================================
   MIDNIGHT TASKS (existing feature, kept)
   =========================================================== */
function generateMidnightTasks(dateKey){
  if(S.midnightTasks[dateKey])return;
  const worked=getChattersThatWorkedOn(dateKey);
  if(!worked.length)return;
  S.midnightTasks[dateKey]=worked.map((cid,i)=>{
    const c=S.chatters.find(ch=>ch.id===cid);
    return{id:`mt${Date.now()}${i}${Math.random().toString(36).slice(2,6)}`,chatterId:cid,label:`Relatório: ${c?c.name:'?'}`,done:false};
  });
  save();
}
function getChattersThatWorkedOn(dateKey){
  const log=S.turnoLog[dateKey]||[];
  const ids=new Set();
  log.filter(e=>e.action==='in').forEach(e=>ids.add(e.chatterId));
  const dow=new Date(dateKey+'T12:00:00').getDay();
  const dk=DAY_KEYS[dow];
  S.shifts.filter(s=>s.days&&s.days.includes(dk)).forEach(s=>ids.add(s.chatterId));
  return Array.from(ids).filter(id=>S.chatters.find(c=>c.id===id));
}
function checkMidnightGeneration(){
  // Generate retroactively for yesterday and today regardless of what time
  // the app happens to be open — generateMidnightTasks() is itself a no-op
  // if tasks already exist for that date, so this is safe to call every tick.
  const now=new Date();
  const yest=new Date(now);yest.setDate(yest.getDate()-1);
  generateMidnightTasks(fmt(yest));
  generateMidnightTasks(fmt(now));
  runAutoBackupIfNeeded();
}
function renderMidnightPreviewHome(){
  const yest=new Date();yest.setDate(yest.getDate()-1);
  const key=fmt(yest);
  const tasks=S.midnightTasks[key]||[];
  const pending=tasks.filter(t=>!t.done).length;
  const panel=document.getElementById('home-midnight-panel');
  if(!panel)return;
  if(pending>0){
    panel.style.display='block';
    const prev=document.getElementById('home-midnight-preview');
    if(prev)prev.innerHTML=tasks.filter(t=>!t.done).slice(0,3).map(t=>`
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)">
        <div style="width:7px;height:7px;border-radius:50%;background:var(--warn)"></div>
        <span style="font-size:12.5px">${t.label}</span>
      </div>`).join('');
  } else panel.style.display='none';
}
function renderMidnightList(){
  const el=document.getElementById('midnight-list');
  const badge=document.getElementById('midnight-badge');
  const today=todayKey();
  const yest=new Date();yest.setDate(yest.getDate()-1);const yestKey=fmt(yest);
  let all=[];
  [yestKey,today].forEach(dk=>{(S.midnightTasks[dk]||[]).forEach(t=>all.push({...t,dateKey:dk}));});
  const pending=all.filter(t=>!t.done).length;
  badge.textContent=`${pending} pendentes`;
  badge.className='pill '+(pending>0?'pill-warn':'pill-ok');
  if(!all.length){el.innerHTML='<div class="empty"><div class="empty-tx">Tarefas de relatório aparecem aqui à 00h com os chatters que trabalharam.</div></div>';return;}
  el.innerHTML='<div class="tasklist">'+all.map(t=>{
    const ot=getChatterOvertimeOn(t.chatterId,t.dateKey);
    return`<div class="taskrow ${t.done?'done':''}">
      <div class="tcheck ${t.done?'done':''}" onclick="toggleMidnight('${t.dateKey}','${t.id}')">${t.done?'✓':''}</div>
      <div class="tbody"><div class="ttext">${t.label}</div>
      <div class="tmeta-row"><span class="pill pill-flat">${t.dateKey}</span>${ot>0?`<span class="pill pill-warn">⏱ ${ot}min extra</span>`:''}</div></div>
      ${t.done?'<span class="pill pill-ok">enviado</span>':'<span class="pill pill-warn">pendente</span>'}
    </div>`;
  }).join('')+'</div>';
}
function toggleMidnight(dateKey,id){
  const t=(S.midnightTasks[dateKey]||[]).find(x=>x.id===id);
  if(t){t.done=!t.done;save();renderMidnightList();renderMidnightPreviewHome();updateNavDots();toast(t.done?'✅ Marcado como enviado!':'↩ Desmarcado');}
}

/* ===========================================================
   HOME
   =========================================================== */
/* ===========================================================
   JANELAS DE HORÁRIO — registro manual de folga com 48h de
   antecedência, para dar tempo de postar/anunciar a vaga de
   hora extra a tempo. Painel sempre visível na Home.
   =========================================================== */
function getTomorrowKey(){
  const d=new Date();d.setDate(d.getDate()+1);return fmt(d);
}
// Todas as janelas abertas (folga recorrente da Escala) dentro da semana
// ATUAL — uma por (turno, dia), com o modelo e horário que fica livre.
function getWeekAvailableWindows(){
  const wd=getWeekDates(0); // sempre semana atual, não segue navegação de outras abas
  const windows=[];
  wd.forEach(day=>{
    const dayKey=DAY_KEYS[day.getDay()];
    const dateStr=fmt(day);
    S.shifts.forEach(s=>{
      const c=S.chatters.find(ch=>ch.id===s.chatterId);
      if(!c||c.time==='elite')return;
      if(!(s.days||[]).includes(dayKey))return;
      const hasAbsence=S.absences.some(a=>a.chatterId===c.id&&a.date===dateStr&&a.type==='falta');
      // Não importa se é folga (recorrente) ou falta (pontual) — os dois abrem uma janela do mesmo jeito.
      const opensBlock1=s.folgaDia===dayKey||hasAbsence;
      const opensBlock2=(s.folgaDia2===dayKey||hasAbsence)&&s.start2&&s.end2;
      if(!opensBlock1&&!opensBlock2)return;
      const models=(s.modelIds||[]).map(mid=>S.models.find(m=>m.id===mid)).filter(Boolean);
      const modelStr=models.map(m=>`${m.emoji||'🧩'} ${m.name}`).join(' · ')||'sem modelo';
      if(opensBlock1){
        const existingSwap=S.swaps.find(sw=>sw.date===dateStr&&sw.shiftId===s.id&&sw.originalId===c.id&&sw.start===s.start&&sw.end===s.end);
        windows.push({date:dateStr,dayName:DAYS[day.getDay()],shiftId:s.id,originalId:c.id,originalName:c.name,modelStr,timeStr:`${s.start}–${s.end}`,startSort:s.start,covererId:existingSwap?existingSwap.covererId:''});
      }
      if(opensBlock2){
        const existingSwap=S.swaps.find(sw=>sw.date===dateStr&&sw.shiftId===s.id&&sw.originalId===c.id&&sw.start===s.start2&&sw.end===s.end2);
        windows.push({date:dateStr,dayName:DAYS[day.getDay()],shiftId:s.id,originalId:c.id,originalName:c.name,modelStr,timeStr:`${s.start2}–${s.end2}`,startSort:s.start2,covererId:existingSwap?existingSwap.covererId:''});
      }
    });
  });
  return windows.sort((a,b)=>a.date!==b.date?a.date.localeCompare(b.date):turnoBlockSortVal(a.startSort)-turnoBlockSortVal(b.startSort));
}
/* ===========================================================
   SEM COBERTURA — diferente da "janela livre" acima (que é quando
   alguém que JÁ TEM turno cadastrado falta ou tira folga hoje), isso
   aqui detecta buracos permanentes na escala: horários de uma modelo
   em que NENHUM chatter tem turno cadastrado, nem uma vez — a modelo
   fica sem ninguém previsto naquele horário toda vez que esse dia da
   semana se repetir. Olha só as datas da semana atual (mesmo recorte
   do painel de Janelas Livres).
   =========================================================== */
function timeToMin(t){if(!t)return 0;const[h,m]=t.split(':').map(Number);return h*60+(m||0);}
function minToTimeLabel(m){if(m>=1440)return'24:00';m=((m%1440)+1440)%1440;const h=Math.floor(m/60),mm=m%60;return String(h).padStart(2,'0')+':'+String(mm).padStart(2,'0');}
function getModelCoverageGaps(){
  // A pedido da gestora: só mostra buracos da escala de HOJE e AMANHÃ,
  // rolando dia a dia — ex: hoje sábado mostra sábado+domingo; virou
  // domingo, os buracos de sábado somem e mostra domingo+segunda. Antes
  // mostrava a semana inteira, o que ficava longo demais pra decidir.
  const hoje=new Date();
  const wd=[0,1].map(n=>new Date(hoje.getFullYear(),hoje.getMonth(),hoje.getDate()+n));
  const gaps=[];
  wd.forEach(day=>{
    const dayKey=DAY_KEYS[day.getDay()];
    const dateStr=fmt(day);
    S.models.forEach(m=>{
      const covered=[];
      S.shifts.forEach(s=>{
        if(!(s.days||[]).includes(dayKey))return;
        if(!(s.modelIds||[]).includes(m.id))return;
        const c=S.chatters.find(ch=>ch.id===s.chatterId);
        if(!c||c.time==='elite')return;
        [[s.start,s.end],[s.start2,s.end2]].forEach(([st,en])=>{
          if(!st||!en)return;
          const a=timeToMin(st),b=timeToMin(en);
          if(b<=a){covered.push([a,1440]);covered.push([0,b]);} // vira o dia — cobre as duas pontas
          else covered.push([a,b]);
        });
      });
      covered.sort((x,y)=>x[0]-y[0]);
      const merged=[];
      covered.forEach(([a,b])=>{
        const last=merged[merged.length-1];
        if(last&&a<=last[1])last[1]=Math.max(last[1],b);
        else merged.push([a,b]);
      });
      let cursor=0;
      merged.forEach(([a,b])=>{
        if(a>cursor+15)gaps.push({dateStr,dayName:DAYS[day.getDay()],modelId:m.id,modelName:m.name,modelEmoji:m.emoji||'🧩',start:minToTimeLabel(cursor),end:minToTimeLabel(a)});
        cursor=Math.max(cursor,Math.min(b,1440));
      });
      if(cursor<1440-15)gaps.push({dateStr,dayName:DAYS[day.getDay()],modelId:m.id,modelName:m.name,modelEmoji:m.emoji||'🧩',start:minToTimeLabel(cursor),end:'24:00'});
    });
  });
  return gaps;
}
function assignWindowCover(shiftId,date,originalId,covererId,startTime,endTime){
  S.swaps=S.swaps.filter(sw=>!(sw.date===date&&sw.shiftId===shiftId&&sw.originalId===originalId&&sw.start===startTime&&sw.end===endTime));
  if(covererId){
    const s=S.shifts.find(sh=>sh.id===shiftId);
    if(s){
      S.swaps.push({id:'sw'+Date.now()+Math.random().toString(36).slice(2,5),date,covererId,originalId,start:startTime||s.start,end:endTime||s.end,shiftId:s.id,createdAt:todayKey()});
      const coverer=S.chatters.find(c=>c.id===covererId);
      const original=S.chatters.find(c=>c.id===originalId);
      toast(`✅ ${coverer?.name} vai cobrir ${original?.name} em ${date} — já aparece na escala do dia`);
    }
  }
  save();
  renderAvailWindowsPanel();
  if(typeof renderTurnoSchedule==='function'&&currentViewName()==='turno')renderTurnoSchedule();
}
let windowsDismissed=null;
function renderAvailWindowsPanel(){
  const panel=document.getElementById('home-availwindows-panel');
  const el=document.getElementById('home-availwindows-content');
  if(!panel||!el)return;
  if(!S.chatters.length){panel.style.display='none';return;}
  if(!windowsDismissed)windowsDismissed=new Set();
  // Some da lista assim que alguém cobrir (não é mais "livre") — e também
  // se o usuário arrastou o cartão pro lado pra dispensar.
  const windows=getWeekAvailableWindows()
    .filter(w=>!w.covererId)
    .filter(w=>!windowsDismissed.has(`${w.date}_${w.shiftId}_${w.startSort}`));
  const gaps=getModelCoverageGaps();
  if(!windows.length&&!gaps.length){panel.style.display='none';return;}
  panel.style.display='block';
  el.innerHTML=`
    ${windows.length?`<div style="font-weight:700;font-size:13.5px;margin-bottom:10px;display:flex;align-items:center;gap:6px">🗓️ <span>Janelas livres</span></div>
    <div style="display:flex;flex-direction:column;gap:7px${gaps.length?';margin-bottom:16px':''}">
    ${windows.map(w=>{
      const key=`${w.date}_${w.shiftId}_${w.startSort}`;
      const dayShort=w.dayName.slice(0,3).toUpperCase();
      const modelEmoji=w.modelStr.split(' ')[0];
      const modelName=w.modelStr.replace(/^\S+\s/,'');
      return`<div class="window-row" data-key="${key}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bad-soft);border-radius:10px;touch-action:pan-y">
        <div style="font-size:10px;font-weight:800;color:var(--bad);background:var(--bg);border-radius:6px;padding:4px 7px;flex-shrink:0;letter-spacing:.03em">${dayShort}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13.5px;font-weight:700">${modelEmoji} ${modelName}</div>
          <div style="font-size:11.5px;color:var(--text2);font-family:var(--font-mono)">${w.timeStr}</div>
        </div>
        <button onclick="openWindowQuickAssign('${w.shiftId}','${w.date}','${w.originalId}','${w.startSort}','${w.timeStr.split('–')[1]}')" class="btn btn-primary btn-xs" style="flex-shrink:0">cobrir</button>
      </div>`;
    }).join('')}
    </div>`:''}
    ${gaps.length?`<div style="font-weight:700;font-size:13.5px;margin-bottom:10px;display:flex;align-items:center;gap:6px">🕳️ <span>Sem cobertura</span></div>
    <div style="display:flex;flex-direction:column;gap:7px">
    ${gaps.slice(0,8).map(g=>{
      const dayShort=g.dayName.slice(0,3).toUpperCase();
      return`<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg-soft);border:1px dashed var(--line-strong);border-radius:10px">
        <div style="font-size:10px;font-weight:800;color:var(--text3);background:var(--bg);border-radius:6px;padding:4px 7px;flex-shrink:0;letter-spacing:.03em">${dayShort}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13.5px;font-weight:700">${g.modelEmoji} ${g.modelName}</div>
          <div style="font-size:11.5px;color:var(--text2);font-family:var(--font-mono)">${g.start}–${g.end} · ninguém escalado</div>
        </div>
      </div>`;
    }).join('')}
    ${gaps.length>8?`<div style="font-size:11px;color:var(--text3);text-align:center">+ ${gaps.length-8} outro(s)</div>`:''}
    </div>`:''}
  `;
  attachSwipeDismiss(el,'.window-row',key=>{windowsDismissed.add(key);renderAvailWindowsPanel();});
}
function openWindowQuickAssign(shiftId,date,originalId,startTime,endTime){
  const c=S.chatters.filter(ch=>ch.id!==originalId);
  const names=c.map((ch,i)=>`${i+1}. ${ch.name}`).join('\n');
  const pick=prompt(`Quem vai cobrir esse horário?\n\n${names}\n\nDigite o número (ou deixe vazio pra tirar a cobertura):`);
  if(pick===null)return;
  const idx=parseInt(pick,10)-1;
  const covererId=c[idx]?c[idx].id:'';
  assignWindowCover(shiftId,date,originalId,covererId,startTime,endTime);
}

/* ===========================================================
   SMART ALERTS — cross-reference all data and surface what
   needs the manager's attention right now.
   =========================================================== */
function getSmartAlerts(){
  const alerts=[];
  const today=todayKey();
  const now=new Date();
  const todayDayKey=getTodayDayKey();
  const wd=getWeekDates();
  const wkStart=fmt(wd[0]),wkEnd=fmt(wd[6]);
  const wkey=getWeekKey();
  const goals=S.chatterWeekGoals[wkey]||{};
  const daysLeft=getDaysRemainingInWeek();

  // Tarefas semanais/mensais com data+hora marcadas — avisa a partir de
  // 24h antes do prazo (e continua avisando se já passou e não foi feita).
  const in24h=new Date(now.getTime()+24*3600*1000);
  [{store:S.weeklyTasks[getWeekKey()]||[],scope:'weekly',key:getWeekKey()},
   {store:S.monthlyTasks[todayKey().slice(0,7)]||[],scope:'monthly',key:todayKey().slice(0,7)}].forEach(({store,scope})=>{
    store.forEach(t=>{
      if(t.done||!t.date)return;
      const dt=new Date(`${t.date}T${t.time||'23:59'}:00`);
      if(isNaN(dt.getTime()))return;
      if(dt<=in24h){
        const overdue=dt<now;
        alerts.push({id:`task-${scope}-${t.id}`,type:overdue?'bad':'warn',icon:overdue?'⏰':'🗓',
          title:`${overdue?'Atrasada: ':''}${t.text}`,
          body:`${scope==='weekly'?'Tarefa semanal':'Tarefa mensal'} — prevista para ${t.date.split('-').reverse().join('/')}${t.time?' às '+t.time:''}${t.urgent?' · marcada como urgente':''}`,
          priority:overdue?0:1});
      }
    });
  });

  // Orientações agendadas com horário marcado (via quadro Orientação da
  // Ficha) — avisa a partir de 24h antes, igual às tarefas com prazo acima.
  // Só pega orientações que TÊM .time (as agendadas manualmente); as
  // antigas com só "shift" não entram aqui, continuam só na Agenda.
  S.orientations.filter(o=>o.time&&o.date).forEach(o=>{
    const dt=new Date(`${o.date}T${o.time}:00`);
    if(isNaN(dt.getTime()))return;
    if(dt<=in24h){
      const overdue=dt<now;
      const c=S.chatters.find(ch=>ch.id===o.chatterId);
      alerts.push({id:`orient-agendada-${o.id}`,type:overdue?'bad':'warn',icon:'🎯',
        title:`${overdue?'Atrasada: ':''}Orientação com ${c?c.name:'?'}`,
        body:`${o.text} — prevista para ${o.date.split('-').reverse().join('/')} às ${o.time}`,
        chatterId:o.chatterId,priority:overdue?0:1});
    }
  });

  S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c)).forEach(c=>{
    const id=c.id;
    const target=parseFloat(goals[id])||0;
    const current=getChatterWeekRevenue(id);

    if(target>0){
      const pct=current/target;
      const remaining=target-current;
      const perDay=daysLeft>0?remaining/daysLeft:remaining;

      if(remaining<=0){
        alerts.push({id:`ok-${id}-metabatida`,type:'info',icon:'🎯',
          title:`${c.name} bateu a meta da semana!`,
          body:`Faturou ${moneyShort(current)} de ${moneyShort(target)} (${Math.round(pct*100)}%). Considere um desafio maior.`,
          chatterId:id,priority:4});
      } else if(daysLeft<=3){
        const urgency=daysLeft<=2?'bad':'warn';
        const emoji=daysLeft<=2?'🔴':'⚠️';
        alerts.push({id:`${urgency}-${id}-meta3d`,type:urgency,icon:emoji,
          title:`${c.name} — ${Math.round(pct*100)}% da meta (${daysLeft}d restantes)`,
          body:`Falta ${moneyShort(remaining)}. Precisa fazer ${moneyShort(perDay)}/dia.`,
          chatterId:id,priority:daysLeft<=2?1:2});
      } else if(daysLeft<=5&&pct<0.4){
        alerts.push({id:`warn-${id}-metalong`,type:'warn',icon:'📉',
          title:`${c.name} longe da meta`,
          body:`${Math.round(pct*100)}% atingido (${moneyShort(current)} de ${moneyShort(target)}). Falta ${moneyShort(remaining)} em ${daysLeft} dias.`,
          chatterId:id,priority:2});
      }
    }

    // Trabalhou/escalado hoje mas sem faturamento após 18h
    const trabalhouHoje=(S.turnoLog[today]||[]).some(e=>e.chatterId===id&&e.action==='in');
    const escaladoHoje=S.shifts.some(s=>s.chatterId===id&&s.days&&s.days.includes(todayDayKey));
    const temFaturamento=S.models.some(m=>(parseFloat(S.revenues[`${id}_${m.id}_${today}`])||0)>0);
    if((trabalhouHoje||escaladoHoje)&&!temFaturamento&&S.models.length>0&&now.getHours()>=18){
      alerts.push({id:`warn-${id}-semfat`,type:'warn',icon:'💰',
        title:`Faturamento de ${c.name} não lançado`,
        body:`Trabalhou hoje mas sem faturamento registrado ainda.`,
        chatterId:id,priority:2});
    }

    // --- PRESENÇA ---
    const weekAbsences=S.absences.filter(a=>a.chatterId===id&&a.date>=wkStart&&a.date<=wkEnd);
    const faltas=weekAbsences.filter(a=>a.type==='falta').length;
    const atrasos=weekAbsences.filter(a=>a.type==='atraso').length;
    if(faltas>=2){
      alerts.push({id:`bad-${id}-faltas`,type:'bad',icon:'🚨',
        title:`${c.name} com ${faltas} faltas esta semana`,
        body:`Requer atenção imediata. Considere uma conversa.`,
        chatterId:id,priority:1});
    } else if(faltas===1&&atrasos>=2){
      alerts.push({id:`warn-${id}-ocorrencias`,type:'warn',icon:'⚠️',
        title:`${c.name} com ocorrências repetidas`,
        body:`1 falta + ${atrasos} atrasos esta semana.`,
        chatterId:id,priority:2});
    }

    // Hora extra excessiva na semana
    let totalOT=0;
    wd.forEach(d=>totalOT+=getChatterOvertimeOn(id,fmt(d)));
    if(totalOT>=120){
      alerts.push({id:`info-${id}-horaextra`,type:'info',icon:'⏱️',
        title:`${c.name} com muita hora extra`,
        body:`${totalOT} min de hora extra esta semana. Avalie o equilíbrio.`,
        chatterId:id,priority:3});
    }

    // --- DESENVOLVIMENTO ---
    const yest=new Date(now);yest.setDate(yest.getDate()-1);
    const orientOntem=S.orientations.filter(o=>o.chatterId===id&&o.date===fmt(yest));
    const orientHoje=S.orientations.filter(o=>o.chatterId===id&&o.date===today);
    if(orientOntem.length>0&&orientHoje.length===0&&now.getHours()>=10){
      alerts.push({id:`info-${id}-followup`,type:'info',icon:'🎯',
        title:`Follow-up pendente: ${c.name}`,
        body:`Recebeu orientação ontem mas sem acompanhamento hoje.`,
        chatterId:id,priority:3});
    }

    // Treinamentos pendentes há mais de 7 dias (ID único por treinamento)
    S.chatterTrainings.filter(t=>t.chatterId===id&&!t.done).forEach(t=>{
      const created=new Date(t.createdAt+'T12:00:00');
      const days=Math.floor((now-created)/86400000);
      if(days>=7){
        alerts.push({id:`info-${id}-train-${t.id}`,type:'info',icon:'📚',
          title:`Treinamento atrasado: ${c.name}`,
          body:`"${t.title}" pendente há ${days} dias.`,
          chatterId:id,priority:3});
      }
    });

    // Chatter em teste há mais de 14 dias sem avaliação
    if((c.level==='treinamento'||c.level==='teste')&&c.createdAt){
      const daysInTest=Math.floor((now-new Date(c.createdAt))/86400000);
      if(daysInTest>=14&&!getReportDraft('decisao-'+id)){
        alerts.push({id:`warn-${id}-semavaliacao`,type:'warn',icon:'🔍',
          title:`${c.name} em teste sem avaliação`,
          body:`${daysInTest} dias em teste. Registre a decisão na aba Relatório.`,
          chatterId:id,priority:2});
      }
    }
  });

  // --- OPERACIONAL ---
  const escaladosHoje=S.shifts.filter(s=>s.days&&s.days.includes(todayDayKey));
  const onlineAgora=getCurrentOnline();
  if(escaladosHoje.length>0&&onlineAgora.length===0&&now.getHours()>=8&&now.getHours()<=23){
    alerts.push({id:'warn-ninguem-online',type:'warn',icon:'🔴',
      title:'Nenhum chatter online',
      body:`${escaladosHoje.length} escalado(s) hoje mas ninguém marcou entrada.`,
      priority:1});
  }

  const tomorrow=getTomorrowKey();
  const folgasAmanha=S.folgas[tomorrow]||[];
  if(folgasAmanha.length>0&&now.getHours()>=20){
    const tomorrowDow=new Date(tomorrow+'T12:00:00').getDay();
    const tomorrowDayKey=DAY_KEYS[tomorrowDow];
    const escaladosAmanha=S.shifts.filter(s=>s.days&&s.days.includes(tomorrowDayKey)&&!folgasAmanha.includes(s.chatterId));
    if(escaladosAmanha.length===0){
      alerts.push({id:'bad-turno-descoberto',type:'bad',icon:'🚨',
        title:'Turno de amanhã descoberto',
        body:`${folgasAmanha.length} de folga e ninguém escalado para cobrir.`,
        priority:1});
    }
  }

  // Chatters ativos sem meta definida esta semana
  const chattersAtivos=S.chatters.filter(c=>c.level!=='treinamento'&&c.level!=='teste');
  const semMeta=chattersAtivos.filter(c=>!(parseFloat(goals[c.id])>0));
  if(semMeta.length>0&&chattersAtivos.length>0){
    alerts.push({id:'info-sem-metas',type:'info',icon:'📋',
      title:`${semMeta.length} chatter(s) sem meta definida`,
      body:`Defina metas na aba Faturamento para acompanhar o progresso.`,
      priority:4});
  }

  // --- MODELO SEM ATENDIMENTO ---
  // Para cada modelo que tem chatters escalados hoje, verifica se algum está online
  if(S.models.length>0&&now.getHours()>=8&&now.getHours()<=23){
    S.models.forEach(m=>{
      // Check escalados - only básico chatters have shifts
      const escaladosNaModelo=S.shifts.filter(s=>
        s.days&&s.days.includes(todayDayKey)&&
        (s.modelIds||[]).includes(m.id)
      ).map(s=>s.chatterId).filter(cid=>{
        const ch=S.chatters.find(c=>c.id===cid);
        return ch&&ch.time!=='elite'; // Elite don't work scheduled hours
      });

      if(!escaladosNaModelo.length)return; // modelo sem ninguém escalado hoje — não alerta

      // Verifica se algum está online
      const algumOnline=escaladosNaModelo.some(cid=>
        ['online','overtime'].includes(getChatterStatus(cid,today))
      );

      if(!algumOnline){
        const nomes=escaladosNaModelo.map(cid=>S.chatters.find(c=>c.id===cid)?.name).filter(Boolean);
        alerts.push({id:`bad-modelo-${m.id}-vazia`,type:'bad',icon:'🚨',
          title:`${m.emoji||'🧩'} ${m.name} sem atendimento`,
          body:`Nenhum chatter online agora. Escalados: ${nomes.join(', ')}.`,
          priority:1});
      }
    });
  }

  // --- MISSING REPORTS ALERT (past days this week without revenue) ---
  const wd2=getWeekDates();
  const missingByChatter={};
  wd2.forEach(d=>{
    const dk=fmt(d);
    if(dk>=todayKey())return; // only past days
    S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c)).forEach(c=>{
      const hasRev=S.models.some(m=>(parseFloat(S.revenues[`${c.id}_${m.id}_${dk}`])||0)>0);
      if(!hasRev&&!chatterNaoPrecisaDeRelatorio(c.id,dk)){
        if(!missingByChatter[c.id])missingByChatter[c.id]={c,dates:[]};
        missingByChatter[c.id].dates.push(dk);
      }
    });
  });
  Object.values(missingByChatter).forEach(({c,dates})=>{
    const alertId=`missing-report-${c.id}-${getWeekKey()}`;
    alerts.push({id:alertId,type:'bad',icon:'📋',
      title:`${c.name} sem relatório`,
      body:`Sem faturamento em: ${dates.join(', ')}. Justifique abaixo se foi falta.`,
      chatterId:c.id,priority:2,
      justificativaKey:`just_${c.id}_${getWeekKey()}`});
  });

  return alerts.sort((a,b)=>a.priority-b.priority);
}
function toggleAlertDone(alertId){
  const today=todayKey();
  if(!S.smartAlertsDone[today])S.smartAlertsDone[today]=[];
  const idx=S.smartAlertsDone[today].indexOf(alertId);
  if(idx===-1)S.smartAlertsDone[today].push(alertId);
  else S.smartAlertsDone[today].splice(idx,1);
  save();
  renderSmartAlerts();
}
function saveAlertNote(alertId,value){
  const key=`${todayKey()}_${alertId}`;
  if(!S.alertNotes)S.alertNotes={};
  S.alertNotes[key]=value;
  save();
}
function getAlertNote(alertId){
  const key=`${todayKey()}_${alertId}`;
  return(S.alertNotes&&S.alertNotes[key])||'';
}

function renderSmartAlerts(){
  const panel=document.getElementById('home-smart-alerts');
  const badge=document.getElementById('smart-alerts-badge');
  if(!panel)return;
  const today=todayKey();
  const done=S.smartAlertsDone[today]||[];
  const alerts=getSmartAlerts();

  const pending=alerts.filter(a=>!done.includes(a.id));
  const realized=alerts.filter(a=>done.includes(a.id));

  if(badge){
    badge.textContent=pending.length>0?`${pending.length} pendente${pending.length>1?'s':''}`:realized.length>0?'tudo feito':'';
    badge.className='pill '+(pending.length>0?'pill-bad':realized.length>0?'pill-ok':'pill-flat');
  }

  const colorMap={bad:'var(--bad)',warn:'var(--warn)',info:'var(--info)'};
  const bgMap={bad:'var(--bad-soft)',warn:'var(--warn-soft)',info:'var(--info-soft)'};

  function alertCard(a,isDone){
    const note=getAlertNote(a.id);
    const borderColor=isDone?'var(--ok)':colorMap[a.type]||'var(--line)';
    const bg=isDone?'var(--bg-soft)':bgMap[a.type]||'var(--bg-soft)';
    return`<div ${!isDone?`class="alert-swipe-row" data-key="${a.id}"`:''} style="border-radius:10px;padding:11px 12px;background:${bg};border-left:3px solid ${borderColor};margin-bottom:8px;transition:opacity .2s;touch-action:pan-y">
      <div style="display:flex;align-items:flex-start;gap:10px">
        <button onclick="toggleAlertDone('${a.id}')" style="width:22px;height:22px;border-radius:5px;border:2px solid ${isDone?'var(--ok)':borderColor};background:${isDone?'var(--ok)':'transparent'};cursor:pointer;flex-shrink:0;margin-top:1px;display:flex;align-items:center;justify-content:center;font-size:13px">
          ${isDone?'<span style="color:#fff">✓</span>':''}
        </button>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span style="font-size:16px">${a.icon}</span>
            <span style="font-weight:700;font-size:13px;color:${isDone?'var(--text3)':'var(--text)'};${isDone?'text-decoration:line-through':''}">${a.title}</span>
          </div>
          ${!isDone?`<div style="font-size:12px;color:var(--text2);margin-top:3px">${a.body}</div>`:''}
          ${!isDone?`<div style="display:flex;gap:8px;margin-top:6px;align-items:center">
            ${a.chatterId?`<button onclick="openChatterDetail('${a.chatterId}')" style="font-size:11px;color:var(--accent);background:none;border:none;cursor:pointer;padding:0;font-family:var(--font-display)">Ver perfil →</button>`:''}
            <button onclick="toggleAlertUrgent('${a.id}')" style="font-size:10.5px;padding:3px 8px;border-radius:6px;border:1px solid ${isAlertUrgent(a.id)?'var(--bad)':'var(--line)'};background:${isAlertUrgent(a.id)?'var(--bad-soft)':'transparent'};cursor:pointer;color:${isAlertUrgent(a.id)?'var(--bad)':'var(--text3)'};font-family:var(--font-display)">${isAlertUrgent(a.id)?'📌 fixado':'📌 fixar'}</button>
          </div>`:''}
          ${!isDone?`<div style="margin-top:7px">
            <input class="finput" style="font-size:11.5px;padding:5px 9px"
              placeholder="Ação tomada / observação..."
              value="${note}"
              onblur="saveAlertNote('${a.id}',this.value)"
              onclick="event.stopPropagation()">
          </div>`:''}
          ${isDone&&note?`<div style="font-size:11px;color:var(--text3);font-style:italic;margin-top:2px">"${note}"</div>`:''}
        </div>
      </div>
    </div>`;
  }

  let html='';

  if(!pending.length&&!realized.length){
    html=`<div style="display:flex;align-items:center;gap:10px;padding:4px 0">
      <span style="font-size:18px">✅</span>
      <div style="font-size:13px;color:var(--text2)">Tudo em ordem — nenhuma atenção necessária agora</div>
    </div>`;
  } else {
    // Pending alerts
    if(pending.length){
      html+=pending.map(a=>alertCard(a,false)).join('');
    } else {
      html+=`<div style="display:flex;align-items:center;gap:8px;padding:6px 0;margin-bottom:4px">
        <span style="font-size:16px">✅</span>
        <span style="font-size:13px;color:var(--ok);font-weight:600">Tudo resolvido por hoje!</span>
      </div>`;
    }

    // Realized section — collapsible
    if(realized.length){
      const collapseId='alerts-done-'+today.replace(/-/g,'');
      html+=`<div style="margin-top:8px">
        <button onclick="const el=document.getElementById('${collapseId}');const arr=document.getElementById('${collapseId}-arr');el.style.display=el.style.display==='none'?'block':'none';arr.textContent=el.style.display==='none'?'▸':'▾';" style="display:flex;align-items:center;gap:6px;background:none;border:none;cursor:pointer;font-family:var(--font-display);font-size:12px;color:var(--text3);padding:4px 0;width:100%">
          <span id="${collapseId}-arr">▸</span>
          Realizadas hoje (${realized.length})
        </button>
        <div id="${collapseId}" style="display:none;margin-top:4px">
          ${realized.map(a=>alertCard(a,true)).join('')}
        </div>
      </div>`;
    }
  }

  panel.innerHTML=html;
  attachSwipeDismiss(panel,'.alert-swipe-row',key=>toggleAlertDone(key));
}

// Motor genérico de "arrastar pro lado pra sumir", reusado em avisos,
// janelas livres, etc. onDismiss recebe a data-key do item arrastado.
function attachSwipeDismiss(container,selector,onDismiss){
  container.querySelectorAll(selector).forEach(row=>{
    let startX=0,curX=0,dragging=false;
    const onDown=e=>{
      if(e.target.closest('button')||e.target.closest('input'))return;
      startX=(e.touches?e.touches[0].clientX:e.clientX);dragging=true;row.style.transition='none';
    };
    const onMove=e=>{
      if(!dragging)return;
      curX=(e.touches?e.touches[0].clientX:e.clientX)-startX;
      row.style.transform=`translateX(${curX}px)`;
      row.style.opacity=String(Math.max(0.15,1-Math.abs(curX)/150));
    };
    const onUp=()=>{
      if(!dragging)return;
      dragging=false;
      row.style.transition='transform .2s ease, opacity .2s ease';
      if(Math.abs(curX)>80){
        row.style.transform=`translateX(${curX>0?400:-400}px)`;
        row.style.opacity='0';
        setTimeout(()=>onDismiss(row.dataset.key),180);
      } else {
        row.style.transform='translateX(0)';
        row.style.opacity='1';
      }
      curX=0;
    };
    row.addEventListener('mousedown',onDown);
    row.addEventListener('touchstart',onDown,{passive:true});
    row.addEventListener('mousemove',onMove);
    row.addEventListener('touchmove',onMove,{passive:true});
    row.addEventListener('mouseup',onUp);
    row.addEventListener('mouseleave',onUp);
    row.addEventListener('touchend',onUp);
  });
}

// Wrapper padrão pra "arrastar pro lado = excluir", usado em todas as listas
// do app (metas, orientações, estudos, treinamentos, etc). Reusa o motor de
// attachSwipeDismiss acima. Depois de excluir, sempre re-renderiza a lista —
// isso cobre tanto o caso de sucesso quanto o caso em que deleteFn tem um
// confirm() interno e o usuário cancela (o card volta a aparecer certinho).
function attachSwipeToDelete(container,selector,deleteFn,renderFn){
  if(!container)return;
  attachSwipeDismiss(container,selector,key=>{
    deleteFn(key);
    if(renderFn)setTimeout(renderFn,0);
  });
}

function renderHome(){
  checkMedalAchievements();
  renderMedalNotice('home-medal-notice');
  renderCriticalMetaNotice();
  renderEscritorioPanel();
  renderUrgentPanel();
  renderSmartAlerts();
  renderAvailWindowsPanel();
  render48hAlerts();
  renderMidnightPreviewHome();
}
// Calcula quem está em risco de não bater a meta essa semana — considera
// risco quem está bem abaixo do ritmo esperado pro dia da semana atual.
function getChattersAtMetaRisk(){
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  const wkey=getWeekKey(0);
  const goals=S.chatterWeekGoals[wkey]||{};
  const todayDow=new Date().getDay(); // 0=dom...6=sab
  const daysElapsed=todayDow===0?7:todayDow;
  const atRisk=[];
  chatters.forEach(c=>{
    const cat=S.chatterFichas?.[c.id]?.pagCategoria||'B';
    const metaManual=parseFloat(goals[c.id])||0;
    const meta=metaManual>0?metaManual:(PAG_CATS[cat]?.n100||0);
    if(!meta)return;
    const rev=getChatterWeekRevenue(c.id,0);
    const pct=rev/meta*100;
    const expectedPct=(daysElapsed/7)*100;
    if(pct<expectedPct*0.6&&pct<85){
      atRisk.push({c,pct:Math.round(pct),falta:meta-rev});
    }
  });
  return atRisk.sort((a,b)=>a.pct-b.pct);
}
// Painel: só um aviso pequeno e discreto, do caso MAIS crítico apenas —
// o quadro completo com todo mundo em risco fica na aba Semana.
function renderCriticalMetaNotice(){
  const el=document.getElementById('home-critical-meta');
  if(!el)return;
  const atRisk=getChattersAtMetaRisk();
  if(!atRisk.length){el.innerHTML='';return;}
  const worst=atRisk[0];
  el.innerHTML=`<div style="display:flex;align-items:center;justify-content:space-between;background:var(--bad-soft);border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:12px">
    <span>🔴 <strong>${worst.c.name}</strong> está em situação crítica na meta (${worst.pct}%)${atRisk.length>1?` +${atRisk.length-1} outro${atRisk.length>2?'s':''}`:''}</span>
    <button class="btn btn-ghost btn-xs" onclick="navTo('semana')">ver →</button>
  </div>`;
}
// Semana: quadro completo com todos os chatters em risco de meta.
function renderMetaRiskBoard(){
  const el=document.getElementById('week-meta-risk-board');
  if(!el)return;
  const atRisk=getChattersAtMetaRisk();
  if(!atRisk.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Ninguém em risco crítico essa semana 👍</div>';return;}
  el.innerHTML=atRisk.map(x=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line)">
      <div><span style="font-weight:700">${x.c.name}</span><span style="font-size:11.5px;color:var(--text3);margin-left:8px">${x.pct}% da meta · falta ${money(x.falta)}</span></div>
      <button class="btn btn-ghost btn-xs" onclick="openChatterDetail('${x.c.id}')">ver →</button>
    </div>`).join('');
}

function renderEscritorioPanel(){
  const el=document.getElementById('home-escritorio');
  if(!el)return;
  const todayDK=getTodayDayKey();

  // 100% guiado pela escala prevista — sem status manual de on/off.
  const allOnline=getCurrentOnline();
  const scheduledToday=getCurrentScheduledToday();
  const onlineIds=new Set(allOnline.map(c=>c.id));

  const nextUp=scheduledToday
    .filter(c=>!onlineIds.has(c.id))
    .map(c=>({c,next:getNextShiftToday(c.id),
      models:[...new Set(S.shifts.filter(s=>s.chatterId===c.id&&(s.days||[]).includes(todayDK)).flatMap(s=>s.modelIds||[]))].map(mid=>S.models.find(m=>m.id===mid)).filter(Boolean)
    }))
    .filter(x=>x.next)
    .sort((a,b)=>a.next.localeCompare(b.next));

  el.innerHTML=`
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="font-weight:800;font-size:15px">🖥️ Escritório</div>
      <button class="btn btn-ghost btn-xs" onclick="navTo('turno')">escala →</button>
    </div>

    ${allOnline.length?
      allOnline.map(c=>{
        const shifts=S.shifts.filter(s=>s.chatterId===c.id&&(s.days||[]).includes(todayDK));
        const models=[...new Set(shifts.flatMap(s=>s.modelIds||[]))].map(mid=>S.models.find(m=>m.id===mid)).filter(Boolean);
        const ends=shifts.flatMap(s=>s.end2&&s.end2>s.end?[s.end2]:[s.end]).sort().reverse()[0]||'';
        return`<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)">
          <div style="width:9px;height:9px;border-radius:50%;background:var(--ok);animation:pulse 2s infinite;flex-shrink:0"></div>
          <div style="flex:1">
            <div style="font-weight:700;font-size:14px">${c.name}</div>
            <div style="font-size:11.5px;color:var(--text2)">${models.map(m=>`${m.emoji||''} ${m.name}`).join(' · ')||'online'}${ends?' · até '+ends:''}</div>
          </div>
        </div>`;
      }).join('')
    :`<div style="font-size:13px;color:var(--text3);padding:8px 0">Ninguém online agora</div>`}



    <button onclick="toggleNextTurno()" style="width:100%;margin-top:12px;background:var(--bg-soft);border:1.5px solid var(--line);border-radius:9px;padding:10px 14px;cursor:pointer;font-family:var(--font-display);font-size:13px;font-weight:700;color:var(--text);display:flex;align-items:center;justify-content:space-between">
      <span>⏳ PRÓXIMO TURNO</span>
      <span id="next-turno-arrow" style="font-size:11px;color:var(--text3)">▸</span>
    </button>
    <div id="next-turno-panel" style="display:none;margin-top:2px">
      ${nextUp.length?nextUp.slice(0,3).map(r=>`
        <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)">
          <div style="font-family:var(--font-mono);font-size:15px;font-weight:800;color:var(--warn);min-width:50px">${r.next}</div>
          <div style="font-weight:700;font-size:14px;flex:1">${r.c.name}</div>
          <div style="font-size:17px">${r.models.map(m=>m.emoji||'🧩').join('')}</div>
        </div>`).join('')
      :`<div style="font-size:12.5px;color:var(--text3);padding:10px 0">Nenhum próximo turno agendado</div>`}
    </div>
  `;
}

function toggleManualOnline(chatterId, goOnline){
  const today=todayKey();
  if(!S.turnoLog[today])S.turnoLog[today]=[];
  S.turnoLog[today]=S.turnoLog[today].filter(x=>x.chatterId!==chatterId||x.status==='in'||x.status==='out');
  if(goOnline){
    S.turnoLog[today].push({chatterId,status:'manual_online',time:new Date().toTimeString().slice(0,5)});
  } else {
    S.turnoLog[today].push({chatterId,status:'manual_offline',time:new Date().toTimeString().slice(0,5)});
  }
  save();renderEscritorioPanel();
}
function clearManualOnline(chatterId){
  const today=todayKey();
  if(!S.turnoLog[today])return;
  S.turnoLog[today]=S.turnoLog[today].filter(x=>x.chatterId!==chatterId||x.status==='in'||x.status==='out');
  save();renderEscritorioPanel();
}


/* ===========================================================
   URGENT ALERTS — alerts the user pins to the home screen top
   =========================================================== */
function toggleAlertUrgent(alertId){
  if(!S.alertNotes)S.alertNotes={};
  const key='urgent_'+alertId;
  S.alertNotes[key]=!S.alertNotes[key];
  save();renderSmartAlerts();renderUrgentPanel();
}
function isAlertUrgent(alertId){
  return !!(S.alertNotes&&S.alertNotes['urgent_'+alertId]);
}
function renderUrgentPanel(){
  const panel=document.getElementById('home-urgent-panel');
  const list=document.getElementById('home-urgent-list');
  const badge=document.getElementById('home-urgent-badge');
  if(!panel||!list)return;
  const today=todayKey();
  const done=S.smartAlertsDone[today]||[];
  const alerts=getSmartAlerts().filter(a=>isAlertUrgent(a.id)&&!done.includes(a.id));
  if(!alerts.length){panel.style.display='none';return;}
  panel.style.display='block';
  if(badge)badge.textContent=`${alerts.length} urgente${alerts.length>1?'s':''}`;
  const colorMap={bad:'var(--bad)',warn:'var(--warn)',info:'var(--info)'};
  list.innerHTML=alerts.map(a=>`
    <div style="display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-bottom:1px solid rgba(180,35,52,.15)">
      <span style="font-size:16px;flex-shrink:0">${a.icon}</span>
      <div style="flex:1">
        <div style="font-weight:700;font-size:13px;color:var(--bad)">${a.title}</div>
        <div style="font-size:11.5px;color:var(--text2);margin-top:2px">${a.body}</div>
      </div>
      <button onclick="toggleAlertDone('${a.id}')" style="background:var(--ok);border:none;border-radius:5px;width:24px;height:24px;cursor:pointer;color:#fff;font-size:12px;flex-shrink:0">✓</button>
    </div>`).join('');
}
function saveQuickNote(){const v=document.getElementById('quicknote').value.trim();if(!v)return;S.quickNotes.push({text:v,date:new Date().toISOString()});save();toast('✅ Salvo!');}

// ---------- status helpers ----------
// Returns true if chatter is within their scheduled shift window right now
function isChatterScheduledNow(chatterId){
  const now=new Date();
  const todayDK=getTodayDayKey();
  const nowMins=now.getHours()*60+now.getMinutes();
  const today=todayKey();
  const inWindow=(sm,em)=>em<sm?(nowMins>=sm||nowMins<em):(nowMins>=sm&&nowMins<em); // turno vira a meia-noite (ex 23h-07h)
  const gaveAway=S.swaps.some(sw=>sw.date===today&&sw.originalId===chatterId);
  if(!gaveAway){
    const shifts=S.shifts.filter(s=>s.chatterId===chatterId&&(s.days||[]).includes(todayDK));
    for(const s of shifts){
      const [sh,sm]=s.start.split(':').map(Number);
      const [eh,em]=s.end.split(':').map(Number);
      if(inWindow(sh*60+sm,eh*60+em))return true;
      if(s.start2&&s.end2){
        const [sh2,sm2]=s.start2.split(':').map(Number);
        const [eh2,em2]=s.end2.split(':').map(Number);
        if(inWindow(sh2*60+sm2,eh2*60+em2))return true;
      }
    }
  }
  // Also check swaps for today
  const swapShifts=S.swaps.filter(sw=>sw.date===today&&sw.covererId===chatterId);
  for(const sw of swapShifts){
    const [sh,sm]=(sw.start||'').split(':').map(Number);
    const [eh,em]=(sw.end||'').split(':').map(Number);
    if(!isNaN(sh)&&inWindow(sh*60+sm,eh*60+em))return true;
    if(sw.start2&&sw.end2){
      const [sh2,sm2]=sw.start2.split(':').map(Number);
      const [eh2,em2]=sw.end2.split(':').map(Number);
      if(!isNaN(sh2)&&inWindow(sh2*60+sm2,eh2*60+em2))return true;
    }
  }
  return false;
}

// Returns chatter's next shift start today (or null)
function getNextShiftToday(chatterId){
  const now=new Date();
  const todayDK=getTodayDayKey();
  const nowMins=now.getHours()*60+now.getMinutes();
  let next=null;
  S.shifts.filter(s=>s.chatterId===chatterId&&(s.days||[]).includes(todayDK)).forEach(s=>{
    const [sh,sm]=s.start.split(':').map(Number);
    const startMins=sh*60+sm;
    if(startMins>nowMins&&(next===null||startMins<next))next=startMins;
    if(s.start2){
      const [sh2,sm2]=s.start2.split(':').map(Number);
      const s2=sh2*60+sm2;
      if(s2>nowMins&&(next===null||s2<next))next=s2;
    }
  });
  if(next===null)return null;
  return`${String(Math.floor(next/60)).padStart(2,'0')}:${String(next%60).padStart(2,'0')}`;
}

function getChatterStatus(chatterId,dateKey){
  // Sempre guiado pela hora prevista no turno — sem botão manual de on/off.
  if(dateKey===todayKey()&&isChatterScheduledNow(chatterId))return'online';
  return'offline';
}

function getCurrentOnline(){
  const today=todayKey();
  // Elite chatters work off-schedule — exclude from auto status
  return S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c)&&['online','overtime'].includes(getChatterStatus(c.id,today)));
}
function getCurrentScheduledToday(){
  const todayDK=getTodayDayKey();
  const today=todayKey();
  return S.chatters.filter(c=>{
    if(c.time==='elite'||c.time==='tester')return false; // Elite/Tester off-schedule
    const hasShift=S.shifts.some(s=>s.chatterId===c.id&&(s.days||[]).includes(todayDK));
    const hasSwap=S.swaps.some(sw=>sw.date===today&&sw.covererId===c.id);
    const gaveAway=S.swaps.some(sw=>sw.date===today&&sw.originalId===c.id);
    return(hasShift&&!gaveAway)||hasSwap;
  });
}
function getChatterOvertimeOn(chatterId,dateKey){
  const log=(S.turnoLog[dateKey]||[]).filter(e=>e.chatterId===chatterId&&e.action==='overtime');
  return log.reduce((sum,e)=>{
    if(e.otEnd&&e.time){const[h1,m1]=e.time.split(':').map(Number);const[h2,m2]=e.otEnd.split(':').map(Number);return sum+Math.max(0,(h2*60+m2)-(h1*60+m1));}
    return sum;
  },0);
}

/* ===========================================================
   TURNO
   =========================================================== */
// Ordena blocos do dia começando pelo que atravessa a madrugada (23h-07h),
// depois manhã/tarde, na ordem que a operação realmente funciona — não pela
// hora numérica crua.
function turnoBlockSortVal(time){
  if(!time)return 999;
  const h=parseInt(time.split(':')[0],10);
  return h>=18?h-24:h;
}
// Monta a escala efetiva de UM dia (todas as models, todos os blocos),
// já resolvendo folga/falta (ambos viram "janela") e troca (já resolvida
// mostra o nome de quem cobre). Não depende de check-in manual — só da
// escala prevista + trocas/faltas registradas.
function getEffectiveScheduleForDate(dateObj){
  const dateStr=fmt(dateObj);
  const dayKey=DAY_KEYS[dateObj.getDay()];
  const result={}; // modelId -> [{start,end,name,isWindow,isCovered,shiftId,originalId,chatterId}]
  S.models.forEach(m=>result[m.id]=[]);
  S.shifts.forEach(s=>{
    if(!(s.days||[]).includes(dayKey))return;
    const c=S.chatters.find(ch=>ch.id===s.chatterId);
    if(!c||c.time==='elite')return; // Elite não entra na escala
    const blocks=[{start:s.start,end:s.end,folga:s.folgaDia===dayKey}];
    if(s.start2&&s.end2)blocks.push({start:s.start2,end:s.end2,folga:s.folgaDia2===dayKey});
    (s.modelIds&&s.modelIds.length?s.modelIds:[]).forEach(mid=>{
      if(!result[mid])return;
      blocks.forEach(b=>{
        const hasAbsence=S.absences.some(a=>a.chatterId===c.id&&a.date===dateStr&&a.type==='falta');
        const isOpen=b.folga||hasAbsence;
        const swap=S.swaps.find(sw=>sw.date===dateStr&&sw.shiftId===s.id&&sw.originalId===c.id&&((sw.start===b.start&&sw.end===b.end)||(sw.start2===b.start&&sw.end2===b.end)));
        if(swap){
          const coverer=S.chatters.find(ch=>ch.id===swap.covererId);
          result[mid].push({start:b.start,end:b.end,name:coverer?coverer.name:'?',chatterId:swap.covererId,isWindow:false,isCovered:true,shiftId:s.id,originalId:c.id,originalName:c.name});
        } else if(isOpen){
          result[mid].push({start:b.start,end:b.end,name:'Janela',chatterId:null,isWindow:true,shiftId:s.id,originalId:c.id,originalName:c.name});
        } else {
          result[mid].push({start:b.start,end:b.end,name:c.name,chatterId:c.id,isWindow:false,shiftId:s.id,originalId:c.id,originalName:c.name});
        }
      });
    });
  });
  Object.keys(result).forEach(mid=>result[mid].sort((a,b)=>turnoBlockSortVal(a.start)-turnoBlockSortVal(b.start)));
  return result;
}
let turnoFocusDate=null; // null = hoje
function getTurnoFocusDate(){return turnoFocusDate?new Date(turnoFocusDate+'T12:00:00'):new Date();}
function changeTurnoFocusDay(delta){
  const d=getTurnoFocusDate();
  d.setDate(d.getDate()+delta);
  turnoFocusDate=fmt(d);
  renderTurnoSchedule();
}
let selectedDay='seg';
function toggleNextTurno(){
  const panel=document.getElementById('next-turno-panel');
  const arrow=document.getElementById('next-turno-arrow');
  if(!panel)return;
  const open=panel.style.display==='none';
  panel.style.display=open?'block':'none';
  if(arrow)arrow.textContent=open?'▾ fechar':'▸ ver';
}

function zerarEscalaCompleta(){
  if(!confirm('Isso apaga TODOS os turnos cadastrados (de todos os chatters), pra você recomeçar do zero. As trocas e faltas registradas também são limpas. Essa ação não pode ser desfeita.\n\nTem certeza?'))return;
  if(!confirm('Confirma mesmo? Todos os turnos vão sumir da escala.'))return;
  S.shifts.forEach(s=>markTombstone(s.id));
  S.swaps.forEach(s=>markTombstone(s.id));
  S.shifts=[];
  S.swaps=[];
  save();
  renderTurnoSchedule();
  toast('🗑️ Escala zerada — pode recomeçar');
  clearTimeout(fbSaveTimer);
  pushToFirestore();
}
function renderTurno(){
  renderTurnoSchedule();
  renderAbsenceListWithJustificativa();
}
const DAY_FULL_UP={dom:'DOMINGO',seg:'SEGUNDA',ter:'TERÇA',qua:'QUARTA',qui:'QUINTA',sex:'SEXTA',sab:'SÁBADO'};
function renderTurnoSchedule(){
  const el=document.getElementById('turno-schedule');
  if(!el)return;
  const btn=document.getElementById('turno-edit-toggle-btn');
  if(btn){
    btn.textContent=turnoEditMode?'✅ concluir edição':'✏️ editar';
    btn.className=turnoEditMode?'btn btn-primary btn-xs':'btn btn-ghost btn-xs';
  }
  const addRow=document.getElementById('turno-add-shift-row');
  if(addRow)addRow.style.display=turnoEditMode?'flex':'none';
  if(!S.models.length||!S.chatters.length){
    el.innerHTML='<div class="empty"><div class="empty-tx">Cadastre modelos e chatters primeiro.</div></div>';
    return;
  }
  const day=getTurnoFocusDate();
  const dateStr=fmt(day);
  const dayKey=DAY_KEYS[day.getDay()];
  const isToday=dateStr===todayKey();
  const schedule=getEffectiveScheduleForDate(day);
  const modelsWithShifts=S.models.filter(m=>(schedule[m.id]||[]).length);
  const body=modelsWithShifts.length?modelsWithShifts.map(m=>`
    <div style="margin-bottom:5px">
      <div style="font-size:11px;font-weight:700;color:var(--text3)">${m.emoji||'🧩'} ${m.name}</div>
      ${schedule[m.id].map(b=>{
        const canEditFT=turnoEditMode&&!b.isWindow;
        return`<div style="display:flex;align-items:center;gap:6px;padding:1px 0;font-size:12.5px;flex-wrap:wrap">
          <span style="font-family:var(--font-mono);color:var(--text3);width:90px;flex-shrink:0">${b.start}–${b.end}</span>
          <span style="flex:1;min-width:50px;${b.isWindow?'color:var(--text3)':b.isCovered?'color:var(--info);font-weight:600':'font-weight:600'}">${b.isWindow?'—':b.name}${b.isCovered?` <span style="font-size:9px;color:var(--text3)">(troca)</span>`:''}</span>
          ${turnoEditMode?`<button onclick="event.stopPropagation();openEditShift('${b.shiftId}')" class="btn btn-ghost btn-xs" title="Editar esse turno">✏️</button>`:''}
          ${canEditFT?`<button onclick="event.stopPropagation();openAbsenceForSlot('${b.originalId}','${dateStr}')" class="btn btn-ghost btn-xs" title="Falta">❌</button>
          <button onclick="event.stopPropagation();openSwapForSlot('${b.shiftId}','${b.originalId}','${dateStr}')" class="btn btn-ghost btn-xs" title="Trocar">🔁</button>`:''}
          ${turnoEditMode?`<button onclick="event.stopPropagation();deleteShift('${b.shiftId}')" class="btn btn-ghost btn-xs" title="Excluir esse turno (todos os dias)" style="color:var(--bad)">🗑️</button>`:''}
        </div>`;
      }).join('')}
    </div>`).join(''):'<div style="font-size:12px;color:var(--text3);padding:3px 0">Sem ninguém escalado nesse dia</div>';
  el.innerHTML=`<div id="turno-day-card" style="background:var(--bg-soft);border-radius:12px;padding:10px 12px;touch-action:pan-y">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
      <button onclick="changeTurnoFocusDay(-1)" class="btn btn-ghost btn-xs" style="font-size:15px;padding:2px 8px">‹</button>
      <div style="text-align:center">
        <div style="font-size:12.5px;font-weight:800">${DAY_FULL_UP[dayKey]}${isToday?' · HOJE':''}</div>
        <div style="font-size:10.5px;color:var(--text3)">${day.getDate()}/${day.getMonth()+1}</div>
      </div>
      <button onclick="changeTurnoFocusDay(1)" class="btn btn-ghost btn-xs" style="font-size:15px;padding:2px 8px">›</button>
    </div>
    ${body}
  </div>`;
  attachTurnoDaySwipe();
}
function attachTurnoDaySwipe(){
  const card=document.getElementById('turno-day-card');
  if(!card)return;
  let startX=0,curX=0,dragging=false;
  const onDown=e=>{if(e.target.closest('button'))return;startX=(e.touches?e.touches[0].clientX:e.clientX);dragging=true;card.style.transition='none';};
  const onMove=e=>{
    if(!dragging)return;
    curX=(e.touches?e.touches[0].clientX:e.clientX)-startX;
    card.style.transform=`translateX(${curX}px)`;
    card.style.opacity=String(Math.max(0.4,1-Math.abs(curX)/300));
  };
  const onUp=()=>{
    if(!dragging)return;
    dragging=false;
    card.style.transition='transform .2s ease, opacity .2s ease';
    // Arrasta pra DIREITA = dia seguinte · arrasta pra ESQUERDA = dia anterior
    if(Math.abs(curX)>60){
      changeTurnoFocusDay(curX>0?-1:1);
    } else {
      card.style.transform='translateX(0)';
      card.style.opacity='1';
    }
    curX=0;
  };
  card.addEventListener('mousedown',onDown);
  card.addEventListener('touchstart',onDown,{passive:true});
  card.addEventListener('mousemove',onMove);
  card.addEventListener('touchmove',onMove,{passive:true});
  card.addEventListener('mouseup',onUp);
  card.addEventListener('mouseleave',onUp);
  card.addEventListener('touchend',onUp);
}
function openAbsenceForSlot(chatterId,dateStr){
  openModal('m-absence');
  setTimeout(()=>{
    const ch=document.getElementById('abs-chatter');if(ch)ch.value=chatterId;
    const dt=document.getElementById('abs-date');if(dt)dt.value=dateStr;
    const tp=document.getElementById('abs-type');if(tp)tp.value='falta';
  },30);
}
function openSwapForSlot(shiftId,chatterId,dateStr){
  openModal('m-swap');
  setTimeout(()=>{
    const dt=document.getElementById('swap-date');if(dt)dt.value=dateStr;
    const out=document.getElementById('swap-chatter-out');if(out)out.value=chatterId;
    if(typeof updateSwapPreview==='function')updateSwapPreview();
  },30);
}
function copyTurnoSchedule(){
  const wd=getWeekDates(0);
  let txt='';
  wd.forEach(day=>{
    const dayKey=DAY_KEYS[day.getDay()];
    const schedule=getEffectiveScheduleForDate(day);
    const modelsWithShifts=S.models.filter(m=>(schedule[m.id]||[]).length);
    if(!modelsWithShifts.length)return;
    txt+=`${DAY_FULL_UP[dayKey]} (${day.getDate()}/${day.getMonth()+1})\n`;
    modelsWithShifts.forEach(m=>{
      txt+=`${m.name}:\n`;
      schedule[m.id].forEach(b=>{txt+=`${b.start} - ${b.end}: ${b.name}\n`;});
    });
    txt+='\n';
  });
  navigator.clipboard.writeText(txt.trim()).then(()=>toast('📋 Escala copiada!'));
}

function renderTurnoQuickEditor(){
  const el=document.getElementById('turno-quick-editor');
  if(!el)return;

  if(!S.models.length&&!S.chatters.length){
    el.innerHTML='<div style="color:var(--text3);font-size:13px">Cadastre modelos e chatters primeiro</div>';
    return;
  }

  // Group existing shifts by model for display
  const DAY_KEYS=['seg','ter','qua','qui','sex','sab','dom'];
  const DAY_LABEL={seg:'Seg',ter:'Ter',qua:'Qua',qui:'Qui',sex:'Sex',sab:'Sáb',dom:'Dom'};

  if(!S.shifts.length){
    el.innerHTML=`<div style="color:var(--text3);font-size:13px;padding:8px 0">
      Nenhum turno configurado ainda.<br>
      <button class="btn btn-primary btn-sm" style="margin-top:8px" onclick="openModal('m-shift')">+ Adicionar primeiro turno</button>
    </div>`;
    return;
  }

  // Show shifts grouped by model with inline edit/delete
  const modelGroups={};
  S.models.forEach(m=>modelGroups[m.id]={model:m,shifts:[]});
  modelGroups['_']={model:null,shifts:[]};
  S.shifts.forEach(s=>{
    const mids=s.modelIds&&s.modelIds.length?s.modelIds:['_'];
    mids.forEach(mid=>{
      const key=S.models.find(m=>m.id===mid)?mid:'_';
      if(!modelGroups[key])modelGroups[key]={model:null,shifts:[]};
      if(!modelGroups[key].shifts.find(x=>x.id===s.id))
        modelGroups[key].shifts.push(s);
    });
  });

  el.innerHTML=Object.values(modelGroups).filter(g=>g.shifts.length).map(g=>{
    const m=g.model;
    const sorted=[...g.shifts].sort((a,b)=>{
      const toM=t=>{if(!t)return 9999;const[h,mn]=t.split(':').map(Number);return h<7?h*60+mn+1440:h*60+mn;};
      return toM(a.start)-toM(b.start);
    });
    return`<div style="margin-bottom:12px">
      <div style="font-size:13px;font-weight:800;margin-bottom:6px">${m?`${m.emoji||'🧩'} ${m.name}`:'Sem modelo'}</div>
      ${sorted.map(s=>{
        const c=S.chatters.find(ch=>ch.id===s.chatterId);
        const days=(s.days||[]).map(d=>DAY_LABEL[d]).join(' ');
        const t2=s.start2&&s.end2?` + ${s.start2}–${s.end2}`:'';
        const folga=s.folgaDia?` · folga ${DAY_LABEL[s.folgaDia]||s.folgaDia}`:'';
        return`<div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg-soft);border-radius:8px;margin-bottom:5px">
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:13.5px">${c?c.name:'— vago'}</div>
            <div style="font-size:11.5px;color:var(--text2);margin-top:1px">
              <span style="font-family:var(--font-mono);color:var(--warn)">${s.start}–${s.end}${t2}</span>
              ${days?` · ${days}`:''}${folga}
            </div>
          </div>
          <button onclick="openEditShiftFromProfile('${s.id}','${s.chatterId}')" style="background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px;font-family:var(--font-display)">✏️ editar</button>
          <button onclick="deleteShift('${s.id}')" style="background:none;border:none;color:var(--bad);cursor:pointer;font-size:15px;padding:0 4px">✕</button>
        </div>`;
      }).join('')}
    </div>`;
  }).join('')+`<button class="btn btn-ghost btn-block btn-sm" style="margin-top:4px" onclick="openModal('m-shift')">+ adicionar turno</button>`;
}

function renderTurnoDay(){
  const today=todayKey();
  const todayDK=getTodayDayKey();
  const now=new Date();
  const nowMins=now.getHours()*60+now.getMinutes();
  const DAY_FULL={seg:'Segunda',ter:'Terça',qua:'Quarta',qui:'Quinta',sex:'Sexta',sab:'Sábado',dom:'Domingo'};
  const titleEl=document.getElementById('turno-day-title');
  if(titleEl)titleEl.textContent=`Hoje · ${DAY_FULL[todayDK]||todayDK}`;

  const el=document.getElementById('turno-day-list');
  if(!el)return;

  // Collect today's effective roster (shifts + swaps)
  const seen=new Set();
  const rows=[];

  S.shifts.filter(s=>(s.days||[]).includes(todayDK)).forEach(s=>{
    if(seen.has(s.chatterId))return;
    seen.add(s.chatterId);
    const gaveAway=S.swaps.some(sw=>sw.date===today&&sw.originalId===s.chatterId);
    if(gaveAway)return;
    const c=S.chatters.find(ch=>ch.id===s.chatterId);
    if(!c||c.time==='elite'||c.time==='tester')return; // Elite/Tester off-schedule
    const allShifts=S.shifts.filter(x=>x.chatterId===c.id&&(x.days||[]).includes(todayDK));
    const models=[...new Set(allShifts.flatMap(x=>x.modelIds||[]))].map(mid=>S.models.find(m=>m.id===mid)).filter(Boolean);
    const windows=allShifts.flatMap(x=>{
      const w=[{start:x.start,end:x.end}];
      if(x.start2&&x.end2)w.push({start:x.start2,end:x.end2});
      return w;
    }).sort((a,b)=>a.start.localeCompare(b.start));
    const isOn=['online','overtime'].includes(getChatterStatus(c.id,today));
    const firstStart=windows[0]?.start||'';
    const [sh,sm]=(firstStart).split(':').map(Number);
    const startMins=sh*60+sm;
    const status=startMins>nowMins?'next':isOn?'on':'done';
    rows.push({c,windows,models,status,shiftId:allShifts[0]?.id});
  });

  // Add swaps covering today
  S.swaps.filter(sw=>sw.date===today).forEach(sw=>{
    const c=S.chatters.find(ch=>ch.id===sw.covererId);
    if(!c)return;
    const orig=S.chatters.find(ch=>ch.id===sw.originalId);
    const isOn=['online','overtime'].includes(getChatterStatus(c.id,today));
    rows.push({c,windows:[{start:sw.start,end:sw.end}],models:[],status:isOn?'on':'next',isSwap:true,origName:orig?.name,shiftId:sw.id});
  });

  rows.sort((a,b)=>(a.windows[0]?.start||'').localeCompare(b.windows[0]?.start||''));

  if(!rows.length){
    el.innerHTML='<div style="color:var(--text3);font-size:13px;padding:12px 0;text-align:center">Nenhum chatter escalado hoje<br><span style="font-size:11.5px">Use o botão + adicionar acima</span></div>';
    return;
  }

  const statusColors={on:'var(--ok)',next:'var(--warn)',done:'var(--text3)'};
  const statusIcons={on:'🟢',next:'⏳',done:'⚫'};

  const renderRow=r=>{
    const timeStr=r.windows.map(w=>`${w.start}–${w.end}`).join(' · ');
    const modelStr=r.models.map(m=>`${m.emoji||'🧩'} ${m.name}`).join(' · ');
    const isManualOn=(S.turnoLog[today]||[]).some(x=>x.chatterId===r.c.id&&x.status==='manual_online');
    const isManualOff=(S.turnoLog[today]||[]).some(x=>x.chatterId===r.c.id&&x.status==='manual_offline');
    const hasManual=isManualOn||isManualOff;
    const effectiveStatus=isManualOn?'on':isManualOff?'done':r.status;
    const isOnline=effectiveStatus==='on';
    const statusLabel={on:'online',next:'aguardando',done:'encerrado'}[effectiveStatus]||effectiveStatus;
    const statusColor=statusColors[effectiveStatus];
    return`<div style="display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--line)">
      <div style="font-size:17px;flex-shrink:0">${statusIcons[effectiveStatus]}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:14px">${r.c.name}${r.isSwap?` <span style="font-size:10px;color:var(--info)">(troca p/ ${r.origName||'?'})</span>`:''}</div>
        <div style="font-size:12px;color:var(--text2);margin-top:1px">${timeStr}${modelStr?' · '+modelStr:''}</div>
      </div>
      ${hasManual
        ?`<button onclick="clearManualOnline('${r.c.id}');renderTurnoDay();"
            style="padding:4px 10px;border-radius:16px;border:1px solid var(--line);background:transparent;cursor:pointer;font-size:11px;color:var(--text3)">auto</button>`
        :`<button onclick="toggleManualOnline('${r.c.id}',${!isOnline});renderTurnoDay();"
            style="padding:4px 10px;border-radius:16px;border:1.5px solid ${statusColor};background:transparent;cursor:pointer;font-size:11px;font-weight:600;color:${statusColor}">
            ${statusLabel}
          </button>`}
    </div>`;
  };

  const basico=rows.filter(r=>r.c.time!=='elite');

  let html='';
  if(!basico.length){
    html='<div style="color:var(--text3);font-size:13px;padding:12px 0;text-align:center">Nenhum chatter do Time Base escalado hoje</div>';
  } else {
    html+=basico.map(renderRow).join('');
  }
  el.innerHTML=html;
}

function renderTurnoWeek(){
  const el=document.getElementById('turno-week-list');
  if(!el)return;

  if(!S.shifts.length){
    el.innerHTML='<div style="color:var(--text3);font-size:13px;padding:8px 0">Nenhum turno cadastrado ainda.<br>Use o botão + adicionar acima.</div>';
    return;
  }

  // Group shifts by model — each model gets a block
  // Shifts with no model go to a "Sem modelo" group
  const modelGroups={};
  S.models.forEach(m=>{ modelGroups[m.id]={model:m,shifts:[]}; });
  modelGroups['_none']={model:null,shifts:[]};

  S.shifts.forEach(s=>{
    const mids=s.modelIds&&s.modelIds.length?s.modelIds:[null];
    mids.forEach(mid=>{
      const key=mid||'_none';
      if(!modelGroups[key])modelGroups[key]={model:S.models.find(m=>m.id===mid)||null,shifts:[]};
      if(!modelGroups[key].shifts.find(x=>x.id===s.id))
        modelGroups[key].shifts.push(s);
    });
  });

  const blocks=Object.values(modelGroups).filter(g=>g.shifts.length);

  // If no blocks (e.g. all elite or no model assigned), show all shifts directly
  if(!blocks.length){
    const allShifts=S.shifts.filter(s=>{
      const c=S.chatters.find(ch=>ch.id===s.chatterId);
      return !c||c.time!=='elite';
    });
    if(!allShifts.length){
      el.innerHTML='<div style="color:var(--text3);font-size:13px;padding:8px 0">Nenhum turno cadastrado ainda.</div>';
      return;
    }
    // Show without model grouping
    const sorted=allShifts.sort((a,b)=>{
      const toM=t=>{if(!t)return 9999;const[h,mn]=t.split(':').map(Number);return h<7?h*60+mn+1440:h*60+mn;};
      return toM(a.start)-toM(b.start);
    });
    el.innerHTML=sorted.map(s=>{
      const c=S.chatters.find(ch=>ch.id===s.chatterId);
      const t1=`${s.start}–${s.end}`;
      const t2=s.start2&&s.end2?`${s.start2}–${s.end2}`:'';
      const days=(s.days||[]).map(d=>({seg:'Seg',ter:'Ter',qua:'Qua',qui:'Qui',sex:'Sex',sab:'Sáb',dom:'Dom'}[d]||d)).join(' ');
      if(turnoEditMode)return`<div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg-soft);border-radius:8px;margin-bottom:5px">
        <div style="flex:1"><div style="font-weight:700;font-size:13.5px">${c?c.name:'—'}</div>
        <div style="font-size:11.5px;color:var(--text2)"><span style="font-family:var(--font-mono);color:var(--warn)">${t1}${t2?' · '+t2:''}</span>${days?' · '+days:''}</div></div>
        <button onclick="openEditShiftFromProfile('${s.id}','${s.chatterId}')" style="background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px">✏️</button>
        <button onclick="deleteShift('${s.id}')" style="background:none;border:none;color:var(--bad);cursor:pointer;font-size:15px;padding:0 4px">✕</button>
      </div>`;
      return`<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--line)">
        <div style="font-family:var(--font-mono);font-size:12.5px;color:var(--warn);min-width:110px;flex-shrink:0">${t1}${t2?' · '+t2:''}</div>
        <div style="font-size:13.5px;font-weight:700;flex:1">${c?c.name:'—'}</div>
      </div>`;
    }).join('');
    el.innerHTML+=turnoEditMode
      ?`<button onclick="toggleTurnoEditMode()" style="width:100%;margin-top:4px;padding:8px;background:var(--ok-soft);border:1px solid var(--ok);border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;color:var(--ok)">✅ Concluir edição</button>`
      :`<button onclick="toggleTurnoEditMode()" style="width:100%;margin-top:4px;padding:8px;background:transparent;border:1px dashed var(--line);border-radius:8px;cursor:pointer;font-size:12px;color:var(--text3)">✏️ editar escala</button>`;
    return;
  }

  el.innerHTML=blocks.map(g=>{
    const m=g.model;
    // Sort shifts by start time
    const sorted=[...g.shifts].sort((a,b)=>a.start.localeCompare(b.start));

    const sorted2=sorted
      .filter(s=>{const c=S.chatters.find(ch=>ch.id===s.chatterId);return !c||c.time!=='elite';})
      .sort((a,b)=>{
        const toMins=t=>{if(!t)return 9999;const[h,m]=t.split(':').map(Number);return h<7?h*60+m+1440:h*60+m;};
        return toMins(a.start)-toMins(b.start);
      });
    const rows=sorted2.map(s=>{
      const c=S.chatters.find(ch=>ch.id===s.chatterId);
      const name=c?c.name:'—';
      const t1=`${s.start}–${s.end}`;
      const t2=s.start2&&s.end2?`${s.start2}–${s.end2}`:'';
      const days=(s.days||[]).map(d=>({seg:'Seg',ter:'Ter',qua:'Qua',qui:'Qui',sex:'Sex',sab:'Sáb',dom:'Dom'}[d]||d)).join(' ');
      const _fds=[s.folgaDia,s.folgaDia2].filter(Boolean).map(d=>({seg:'Seg',ter:'Ter',qua:'Qua',qui:'Qui',sex:'Sex',sab:'Sáb',dom:'Dom'}[d]||d)).join('+');
      const folgaLabel=_fds?` <span style="font-size:10px;color:var(--bad)">(folga ${_fds})</span>`:'';
      if(turnoEditMode){
        return`<div style="display:flex;align-items:center;gap:8px;padding:8px;background:var(--bg-soft);border-radius:8px;margin-bottom:5px">
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:13.5px">${name}${folgaLabel}</div>
            <div style="font-size:11.5px;color:var(--text2);margin-top:1px"><span style="font-family:var(--font-mono);color:var(--warn)">${t1}${t2?' · '+t2:''}</span>${days?' · '+days:''}</div>
          </div>
          <button onclick="openEditShiftFromProfile('${s.id}','${s.chatterId}')" style="background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px">✏️</button>
          <button onclick="deleteShift('${s.id}')" style="background:none;border:none;color:var(--bad);cursor:pointer;font-size:15px;padding:0 4px">✕</button>
        </div>`;
      }
      return`<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--line)">
        <div style="font-family:var(--font-mono);font-size:12.5px;color:var(--warn);min-width:110px;flex-shrink:0">${t1}${t2?' · '+t2:''}</div>
        <div style="font-size:13.5px;font-weight:700;flex:1">${name}${folgaLabel}</div>
      </div>`;
    }).join('');

    return`<div style="margin-bottom:18px">
      <div style="font-size:14px;font-weight:800;margin-bottom:8px;padding-bottom:5px;border-bottom:2px solid var(--line)">
        ${m?`${m.emoji||'🧩'} ${m.name}`:'Sem modelo'}
      </div>
      ${rows}
    </div>`;
  }).join('');

  // Add pencil button at bottom
  el.innerHTML+= turnoEditMode
    ? `<button onclick="toggleTurnoEditMode()" style="width:100%;margin-top:4px;padding:8px;background:var(--ok-soft);border:1px solid var(--ok);border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;color:var(--ok)">✅ Concluir edição</button>`
    : `<button onclick="toggleTurnoEditMode()" style="width:100%;margin-top:4px;padding:8px;background:transparent;border:1px dashed var(--line);border-radius:8px;cursor:pointer;font-size:12px;color:var(--text3)">✏️ editar escala</button>`;
}
/* ===========================================================
   EDIT PUNCH — correct a check-in/out/overtime time that was
   recorded automatically but doesn't match what really happened
   (chatters often clock in/out at slightly different times).
   =========================================================== */
function openEditPunch(dateKey,entryId){
  const entry=(S.turnoLog[dateKey]||[]).find(e=>e.id===entryId);
  if(!entry)return;
  const c=S.chatters.find(ch=>ch.id===entry.chatterId);
  const actLabel={in:'Entrada',out:'Saída',overtime:'Hora extra'}[entry.action]||entry.action;
  document.getElementById('punch-edit-title').textContent=`Editar ${actLabel.toLowerCase()} — ${c?c.name:'?'}`;
  document.getElementById('punch-edit-date').textContent=dateKey;
  document.getElementById('punch-edit-time').value=entry.time||'';
  document.getElementById('punch-edit-otend-field').style.display=entry.action==='overtime'?'block':'none';
  document.getElementById('punch-edit-otend').value=entry.otEnd||'';
  document.getElementById('punch-edit-confirm').onclick=function(){
    const newTime=document.getElementById('punch-edit-time').value;
    if(!newTime){toast('⚠️ Informe um horário');return;}
    entry.time=newTime;
    if(entry.action==='overtime'){
      entry.otEnd=document.getElementById('punch-edit-otend').value||entry.otEnd;
    }
    save();
    closeModal('m-punch-edit');
    toast('✅ Horário corrigido!');
    renderTodayWorkedList();renderTurnoBoard();renderHome();
  };
  document.getElementById('punch-edit-delete').onclick=function(){
    if(!confirm('Remover esse registro de ponto?'))return;
    S.turnoLog[dateKey]=(S.turnoLog[dateKey]||[]).filter(e=>e.id!==entryId);
    save();
    closeModal('m-punch-edit');
    toast('Registro removido');
    renderTodayWorkedList();renderTurnoBoard();renderHome();
  };
  openModal('m-punch-edit');
}

function renderTodayWorkedList(){
  const el=document.getElementById('today-worked-list');
  if(!el)return;
  const today=todayKey();
  const workedIds=new Set(getChattersThatWorkedOn(today));
  const chatters=S.chatters.filter(c=>workedIds.has(c.id));
  const badge=document.getElementById('today-worked-badge');
  if(badge)badge.textContent=`${chatters.length} hoje`;

  if(!chatters.length){
    el.innerHTML='<div class="empty"><div class="empty-tx">Nenhum chatter escalado ou com entrada registrada hoje</div></div>';
    return;
  }
  el.innerHTML='<div class="roster">'+chatters.map(c=>{
    const color=getComputedLevelColor(c.level);
    const status=getChatterStatus(c.id,today);
    const log=(S.turnoLog[today]||[]).filter(e=>e.chatterId===c.id);
    const todaysShifts=S.shifts.filter(s=>s.chatterId===c.id&&s.days&&s.days.includes(getTodayDayKey())).sort((a,b)=>a.start.localeCompare(b.start));
    const shiftsLabel=todaysShifts.length?todaysShifts.map(s=>`${s.start}–${s.end}`).join(' · '):'';
    const allModelIds=new Set();
    todaysShifts.forEach(s=>(s.modelIds||[]).forEach(mid=>allModelIds.add(mid)));
    const modelNames=Array.from(allModelIds).map(mid=>{const m=S.models.find(mm=>mm.id===mid);return m?`${m.emoji||'🧩'} ${m.name}`:null;}).filter(Boolean);
    const historyChips=log.length?log.map(e=>{
      const actLabel=e.action==='in'?'entrou':e.action==='out'?'saiu':'h.extra';
      return`<span class="pill pill-flat" style="cursor:pointer;margin:2px 3px 2px 0" onclick="openEditPunch('${today}','${e.id}')">${actLabel} ${e.time} ✎</span>`;
    }).join(''):'<span style="font-size:11.5px;color:var(--text3)">sem registro de ponto ainda</span>';
    return`<div class="rrow ${status==='online'?'on':status==='overtime'?'ot':'off'}">
      <div class="ravatar" style="background:${color}22;color:${color}">${c.name.slice(0,2).toUpperCase()}</div>
      <div class="rinfo">
        <div class="rname">${c.name}</div>
        <div class="rmeta">${shiftsLabel?`previsto: ${shiftsLabel}`:'sem horário fixo'}</div>
        ${modelNames.length?`<div class="rmeta" style="margin-top:2px">🧩 ${modelNames.join(' · ')}</div>`:''}
        <div style="margin-top:4px">${historyChips}</div>
      </div>
      <span class="pill ${status==='online'?'pill-ok':status==='overtime'?'pill-warn':'pill-flat'}">${status==='online'?'online':status==='overtime'?'h.extra':'offline'}</span>
    </div>`;
  }).join('')+'</div>';
}
function renderTurnoBoard(){
  const el=document.getElementById('turno-board');
  if(!S.chatters.length){el.innerHTML='<div class="empty"><div class="empty-tx">Cadastre chatters na aba Equipe</div></div>';return;}
  const today=todayKey();
  const todayDayKey=getTodayDayKey();
  el.innerHTML='<div class="roster">'+S.chatters.map(c=>{
    const status=getChatterStatus(c.id,today);
    const color=getComputedLevelColor(c.level);
    const log=(S.turnoLog[today]||[]).filter(e=>e.chatterId===c.id);
    const last=log.length?log[log.length-1]:null;
    const since=last&&last.action==='in'?` · desde ${last.time}`:'';
    const otMins=getChatterOvertimeOn(c.id,today);
    const todaysShifts=S.shifts.filter(s=>s.chatterId===c.id&&s.days&&s.days.includes(todayDayKey)).sort((a,b)=>a.start.localeCompare(b.start));
    const shiftsLabel=todaysShifts.length?todaysShifts.map(s=>`${s.start}-${s.end}`).join(' · '):'';
    let actions='';
    if(status==='offline'){
      actions=`<button class="btn btn-primary btn-xs" onclick="doCheckin('${c.id}','in')">▶ entrou</button>`;
    } else if(status==='online'){
      actions=`<button class="btn btn-danger btn-xs" onclick="doCheckin('${c.id}','out')">■ saiu</button><button class="btn btn-soft btn-xs" onclick="doCheckin('${c.id}','overtime')">⏱</button>`;
    } else if(status==='overtime'){
      actions=`<button class="btn btn-danger btn-xs" onclick="doCheckin('${c.id}','out')">■ saiu</button>`;
    }
    return`<div class="rrow ${status==='online'?'on':status==='overtime'?'ot':'off'}">
      <div class="ravatar" style="background:${color}22;color:${color}">${c.name.slice(0,2).toUpperCase()}</div>
      <div class="rinfo"><div class="rname">${c.name}${todaysShifts.length>1?' <span class="pill pill-info" style="font-size:9px">2 turnos</span>':''}</div>
      <div class="rmeta">${status==='online'?'online'+since:status==='overtime'?'hora extra':'offline'}${otMins>0?` · +${otMins}min`:''}${shiftsLabel?` · prev: ${shiftsLabel}`:''}</div></div>
      <div class="ractions">${actions}</div>
    </div>`;
  }).join('')+'</div>';
}
function doCheckin(chatterId,action){
  const c=S.chatters.find(ch=>ch.id===chatterId);if(!c)return;
  const today=todayKey();
  if(!S.turnoLog[today])S.turnoLog[today]=[];
  if(action==='overtime'){
    populateChatterSelects();
    document.getElementById('ot-date').value=today;document.getElementById('ot-start').value=nowHHMM();
    setTimeout(()=>{const sel=document.getElementById('ot-chatter');if(sel)sel.value=chatterId;},40);
    openModal('m-overtime');return;
  }
  if(action==='out'){
    S.turnoLog[today].push({id:'tl'+Date.now()+Math.random().toString(36).slice(2,6),chatterId,action:'out',time:nowHHMM()});
    save();toast(`${c.name} marcou saída`);renderTurnoBoard();renderTodayWorkedList();renderHome();
    return;
  }
  // action === 'in'
  S.turnoLog[today].push({id:'tl'+Date.now()+Math.random().toString(36).slice(2,6),chatterId,action:'in',time:nowHHMM()});
  save();toast(`✅ ${c.name} marcado como online`);renderTurnoBoard();renderTodayWorkedList();renderHome();
}
function openCheckinOut(chatterId){
  const c=S.chatters.find(ch=>ch.id===chatterId);
  document.getElementById('checkin-title').textContent=`Saída — ${c.name}`;
  const others=S.chatters.filter(ch=>ch.id!==chatterId&&getChatterStatus(ch.id,todayKey())==='offline');
  document.getElementById('checkin-body').innerHTML=`
    <p style="font-size:13px;color:var(--text2);margin-bottom:12px">Quem entrou no lugar de <strong style="color:var(--text)">${c.name}</strong>?</p>
    <div id="rep-list">
      ${others.map(ch=>`<div class="taskrow" style="cursor:pointer" onclick="selectRep('${ch.id}')">
        <div class="tcheck" id="rep-${ch.id}"></div>
        <div class="tbody"><div class="ttext">${ch.name}</div><div class="tmeta-row"><span class="pill pill-flat">${ch.level}</span></div></div>
      </div>`).join('')}
      <div class="taskrow" style="cursor:pointer" onclick="selectRep('none')">
        <div class="tcheck" id="rep-none"></div>
        <div class="tbody"><div class="ttext" style="color:var(--text2)">Ninguém entrou</div></div>
      </div>
    </div>`;
  let rep=null;
  window.selectRep=function(id){
    document.querySelectorAll('#rep-list .tcheck').forEach(e=>{e.classList.remove('done');e.textContent='';});
    document.getElementById('rep-'+id).classList.add('done');document.getElementById('rep-'+id).textContent='✓';
    rep=id;
  };
  document.getElementById('checkin-confirm').onclick=function(){
    const today=todayKey();if(!S.turnoLog[today])S.turnoLog[today]=[];
    S.turnoLog[today].push({id:'tl'+Date.now()+Math.random().toString(36).slice(2,6),chatterId,action:'out',time:nowHHMM()});
    if(rep&&rep!=='none'){
      S.turnoLog[today].push({id:'tl'+Date.now()+Math.random().toString(36).slice(2,6),chatterId:rep,action:'in',time:nowHHMM()});
      const r=S.chatters.find(ch=>ch.id===rep);
      toast(`✅ ${c.name} saiu · ${r?r.name:'?'} entrou`);
    } else toast(`✅ ${c.name} saiu`);
    save();closeModal('m-checkin');renderTurnoBoard();renderHome();
  };
  openModal('m-checkin');
}
function renderScheduleForDay(day){
  const list=document.getElementById('schedule-list');
  const shifts=S.shifts.filter(s=>s.days&&s.days.includes(day));

  // Find the actual date for this day in the current week (for swap lookup)
  const wd=getWeekDates();
  const dayKeyIndex={seg:0,ter:1,qua:2,qui:3,sex:4,sab:5,dom:6}[day];
  const dateForDay=dayKeyIndex!==undefined?fmt(wd[dayKeyIndex]):null;

  // Get swaps for this specific date
  const swapsForDay=dateForDay?S.swaps.filter(sw=>sw.date===dateForDay):[];

  if(!shifts.length&&!swapsForDay.length){
    list.innerHTML='<div class="empty"><div class="empty-tx">Nenhum turno cadastrado</div></div>';return;
  }

  // Build effective roster: original shifts minus given-away + covered swaps
  const byChatter={};
  shifts.forEach(s=>{
    // Skip if this chatter gave away their shift today via swap
    const gaveAway=swapsForDay.some(sw=>sw.originalId===s.chatterId&&sw.shiftId===s.id);
    if(gaveAway)return;
    if(!byChatter[s.chatterId])byChatter[s.chatterId]=[];
    byChatter[s.chatterId].push(s);
  });
  // Add swap coverers
  swapsForDay.forEach(sw=>{
    const origShift=S.shifts.find(s=>s.id===sw.shiftId);
    const swapEntry={...(origShift||{}),id:sw.id,start:sw.start,end:sw.end,start2:sw.start2||'',end2:sw.end2||'',isSwap:true,swapOriginalId:sw.originalId};
    if(!byChatter[sw.covererId])byChatter[sw.covererId]=[];
    byChatter[sw.covererId].push(swapEntry);
  });

  const groups=Object.entries(byChatter).map(([chatterId,list])=>{
    const c=S.chatters.find(ch=>ch.id===chatterId);
    const earliest=list.slice().sort((a,b)=>a.start.localeCompare(b.start))[0];
    return{chatterId,chatter:c,shifts:list.sort((a,b)=>a.start.localeCompare(b.start)),sortKey:earliest?earliest.start:'99:99'};
  }).filter(g=>g.chatter).sort((a,b)=>a.sortKey.localeCompare(b.sortKey));

  const DAY_LABELS={seg:'Seg',ter:'Ter',qua:'Qua',qui:'Qui',sex:'Sex',sab:'Sáb',dom:'Dom'};

  list.innerHTML='<div style="display:flex;flex-direction:column;gap:8px">'+groups.map(g=>{
    const c=g.chatter;
    const multi=g.shifts.length>1;
    const timeBlocks=g.shifts.map(s=>{
      const modelNames=(s.modelIds||[]).map(mid=>{const m=S.models.find(mm=>mm.id===mid);return m?`${m.emoji||'🧩'} ${m.name}`:null;}).filter(Boolean);
      const hasSecond=s.start2&&s.end2;
      const origChatter=s.swapOriginalId?S.chatters.find(c=>c.id===s.swapOriginalId):null;
      const timeLabel=`${s.start}–${s.end}${hasSecond?' · '+s.start2+'–'+s.end2:''}`;
      const timeDiv=s.isSwap
        ?`<div style="font-family:var(--font-mono);background:var(--info-soft);border-radius:7px;padding:5px 9px;font-size:11.5px;font-weight:700;color:var(--info);white-space:nowrap">${timeLabel}</div>`
        :`<div style="font-family:var(--font-mono);background:var(--bg-soft);border-radius:7px;padding:5px 9px;font-size:11.5px;font-weight:700;color:var(--warn);white-space:nowrap;cursor:pointer" onclick="openEditShift('${s.id}')">${timeLabel} ✎</div>`;
      const delBtn=s.isSwap
        ?`<button class="btn btn-icon btn-line" style="width:22px;height:22px;flex-shrink:0" onclick="deleteSwap('${s.id}')">✕</button>`
        :`<button class="btn btn-icon btn-line" style="width:22px;height:22px;flex-shrink:0" onclick="deleteShift('${s.id}')">✕</button>`;
      return`<div>
        <div style="display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap">${timeDiv}${delBtn}</div>
        ${s.isSwap&&origChatter?`<div style="font-size:10.5px;color:var(--info);margin-top:2px">troca: cobrindo `+origChatter.name+`</div>`:''}
        ${s.folgaDia&&!s.isSwap?`<div style="font-size:10.5px;color:var(--bad);margin-top:2px">folga: ${DAY_LABELS[s.folgaDia]||s.folgaDia}</div>`:''}
        ${modelNames.length?`<div style="font-size:10.5px;color:var(--text3);margin-top:2px">${modelNames.join(' · ')}</div>`:''}
      </div>`;}).join('');
    return`<div class="rrow" style="align-items:flex-start">
      <div style="display:flex;flex-wrap:wrap;gap:8px;max-width:175px">${timeBlocks}</div>
      <div class="rinfo">
        <div class="rname">${c.name}${multi?` <span class="pill pill-info" style="margin-left:5px;font-size:9.5px">2 turnos</span>`:''}${g.shifts.some(s=>s.isSwap)?` <span class="pill pill-info" style="margin-left:5px;font-size:9.5px">⇄ troca</span>`:''}</div>
        <span class="pill ${LVLCLASS[c.level]}" style="border:1px solid;margin-top:4px">${c.level}</span>
      </div>
    </div>`;
  }).join('')+'</div>';
}
function renderAlarmList(){
  const times=getShiftTimes();
  document.getElementById('alarm-badge').textContent=`${times.length} horários`;
  document.getElementById('alarm-times').innerHTML=times.length?times.map(t=>`<span class="pill pill-warn" style="margin:2px">${t}</span>`).join(''):'<span style="color:var(--text3);font-size:12px">Nenhum horário</span>';
}
function renderAbsenceList(){
  const el=document.getElementById('absence-list');
  const week=getWeekAbsencesData();
  if(!week.length){el.innerHTML='<div class="empty"><div class="empty-tx">Nenhuma ocorrência esta semana</div></div>';return;}
  const tb={falta:'pill-bad',atraso:'pill-warn',saida_antecipada:'pill-info'};
  const tl={falta:'Falta',atraso:'Atraso',saida_antecipada:'Saída antecip.'};
  el.innerHTML=week.slice(0,6).map(a=>{
    const c=S.chatters.find(ch=>ch.id===a.chatterId);
    return`<div class="reprow"><div><div style="font-size:13px;font-weight:700">${c?c.name:'?'}</div><div style="font-size:11px;color:var(--text2)">${a.date}${a.note?' · '+a.note:''}</div></div><span class="pill ${tb[a.type]||'pill-flat'}">${tl[a.type]||a.type}</span></div>`;
  }).join('');
}

// ---------- alarm (shift change) ----------
let alarmActive=false;
function getShiftTimes(){const t=new Set();S.shifts.forEach(s=>{if(s.start)t.add(s.start);if(s.end)t.add(s.end);});return Array.from(t).sort();}
function getNextAlarmTime(){
  const times=getShiftTimes();if(!times.length)return null;
  const hhmm=nowHHMM();for(const t of times){if(t>hhmm)return t;}return times[0];
}
function updateAlarmCountdown(){
  const next=getNextAlarmTime();
  ['home-countdown','turno-countdown'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent='--:--:--';});
  if(!next)return;
  const now=new Date();let[th,tm]=next.split(':').map(Number);
  let target=new Date(now);target.setHours(th,tm,0,0);if(target<=now)target.setDate(target.getDate()+1);
  let diff=Math.floor((target-now)/1000);
  const h=Math.floor(diff/3600),m=Math.floor((diff%3600)/60),s=diff%60;
  const str=`${p2(h)}:${p2(m)}:${p2(s)}`;
  ['home-countdown','turno-countdown'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent=str;});
  const nl=document.getElementById('home-next-lb');if(nl)nl.textContent=`próxima troca · ${next}`;
  const nl2=document.getElementById('turno-next-lb');if(nl2)nl2.textContent=`para a troca das ${next}`;
  if(diff===0&&!alarmActive)triggerShiftAlarm(next);
}
function triggerShiftAlarm(time){
  alarmActive=true;const code=genCode();S.lastCode={code,time,date:new Date().toISOString()};save();
  ['home-codebox','turno-codebox'].forEach(id=>{const el=document.getElementById(id);if(el){el.style.display='block';el.textContent=code;}});
  const ring=document.getElementById('turno-ring');if(ring)ring.classList.add('ringing');
  toast(`🔔 Troca de turno! Código: ${code}`,8000);
  setTimeout(()=>{alarmActive=false;if(ring)ring.classList.remove('ringing');},30000);
}
function genCode(){const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let r='';for(let i=0;i<6;i++)r+=c[Math.floor(Math.random()*c.length)];return r;}
function generateCode(){
  const code=genCode();S.lastCode={code,time:'manual',date:new Date().toISOString()};save();
  ['home-codebox','turno-codebox'].forEach(id=>{const el=document.getElementById(id);if(el){el.style.display='block';el.textContent=code;}});
  toast(`🔑 Código: ${code}`);
}

/* ===========================================================
   EXPORT TO CALENDAR (.ics) — real phone notifications
   Generates one recurring weekly event per shift-change time
   already registered in the weekly schedule (S.shifts).
   The person imports this into iPhone Calendar so they get a
   real push alert even with the app closed.
   =========================================================== */
const ICS_DAY_MAP={dom:'SU',seg:'MO',ter:'TU',qua:'WE',qui:'TH',sex:'FR',sab:'SA'};
function icsEscape(str){
  return String(str)
    .split('\\').join('\\\\')
    .split(';').join('\\;')
    .split(',').join('\\,')
    .split('\n').join('\\n');
}
function icsDateTimeFromTime(hhmm){
  // Build the first upcoming occurrence date for a given HH:MM, returns {dtstart, byday}
  const [h,m]=hhmm.split(':').map(Number);
  const now=new Date();
  const d=new Date(now);d.setHours(h,m,0,0);
  if(d<=now)d.setDate(d.getDate()+1);
  return d;
}
function fmtICSDate(d){
  return `${d.getFullYear()}${p2(d.getMonth()+1)}${p2(d.getDate())}T${p2(d.getHours())}${p2(d.getMinutes())}00`;
}
function buildICSCalendar(){
  // Group shifts by time -> collect which weekdays use that time (for entry and for exit)
  const timeDays={}; // 'HH:MM' -> Set of ics day codes
  S.shifts.forEach(s=>{
    if(s.start&&s.days){
      if(!timeDays[s.start])timeDays[s.start]=new Set();
      s.days.forEach(d=>timeDays[s.start].add(ICS_DAY_MAP[d]));
    }
    if(s.end&&s.days){
      if(!timeDays[s.end])timeDays[s.end]=new Set();
      s.days.forEach(d=>timeDays[s.end].add(ICS_DAY_MAP[d]));
    }
  });
  const times=Object.keys(timeDays).sort();
  if(!times.length)return null;

  let ics=[
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//GestorPro//Turno//PT-BR','CALSCALE:GREGORIAN'
  ];
  times.forEach((t,idx)=>{
    const days=Array.from(timeDays[t]).join(',');
    const startDate=icsDateTimeFromTime(t);
    const endDate=new Date(startDate.getTime()+15*60000); // 15min duration
    const uid=`gestorpro-turno-${idx}-${Date.now()}@gestorpro.local`;
    ics.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${fmtICSDate(new Date())}Z`,
      `DTSTART:${fmtICSDate(startDate)}`,
      `DTEND:${fmtICSDate(endDate)}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${days}`,
      `SUMMARY:${icsEscape('🔔 Troca de turno · '+t)}`,
      `DESCRIPTION:${icsEscape('Verificar entradas e saídas dos chatters no horário de '+t+'. Gerar código de acesso.')}`,
      'BEGIN:VALARM','ACTION:DISPLAY','DESCRIPTION:Troca de turno agora','TRIGGER:-PT0M','END:VALARM',
      'END:VEVENT'
    );
  });
  ics.push('END:VCALENDAR');
  return ics.join('\r\n');
}
function exportCalendar(){
  const ics=buildICSCalendar();
  if(!ics){toast('⚠️ Cadastre horários na escala semanal primeiro');return;}
  const blob=new Blob([ics],{type:'text/calendar;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download='turnos-gestorpro.ics';
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),2000);
  toast('📅 Calendário exportado! Abra o arquivo para importar.');
}

/* ===========================================================
   AGENDA
   =========================================================== */
function renderAgenda(){renderStudyList();renderOrientList();renderMidnightList();}
function renderOrientList(){
  const el=document.getElementById('orient-list');
  const today=todayKey();const todayO=S.orientations.filter(o=>o.date===today);
  const yest=new Date();yest.setDate(yest.getDate()-1);const yKey=fmt(yest);const yO=S.orientations.filter(o=>o.date===yKey);
  // Orientações com mais de 1 dia de atraso e ainda não feitas — continuam
  // visíveis e clicáveis aqui (não só em Tarefas Diárias) até serem feitas
  // ou apagadas, pra nunca "sumir" de vez.
  const overdueO=S.orientations.filter(o=>o.date<yKey&&!o.done);
  let html='';
  // Clicar no texto da orientação abre "como aplicar" (abordagem sugerida,
  // roteiro, frase de abertura) quando ela veio do 🤖 Gerar orientação
  // assertiva — os botões de ação usam stopPropagation pra não abrir o
  // modal sem querer ao marcar feita ou apagar.
  if(overdueO.length){
    html+=`<div style="margin-bottom:12px"><div class="sectionlb" style="color:var(--bad)">⚠️ atrasadas</div>
    ${overdueO.map(o=>{const c=S.chatters.find(ch=>ch.id===o.chatterId);
      return`<div class="logitem orient-swipe-row" data-key="${o.id}" style="touch-action:pan-y;border-left:3px solid var(--bad);cursor:pointer" onclick="openOrientView('${o.id}')">
      <div class="logdate">${c?c.name:'?'} · ${o.date.split('-').reverse().join('/')}${o.time?` ⏰ ${o.time}`:''}</div><div class="logtext" style="text-decoration:underline;text-decoration-style:dotted">${o.text}</div>
      <button class="btn btn-primary btn-xs" style="margin-top:8px" onclick="event.stopPropagation();toggleOrientationDone('${o.id}')">✓ Marcar como feita</button>
      <button class="btn btn-icon btn-line" style="margin-top:8px" onclick="event.stopPropagation();deleteOrientation('${o.id}')">✕</button></div>`;}).join('')}</div>`;
  }
  if(yO.length){
    html+=`<div style="margin-bottom:12px"><div class="sectionlb" style="color:var(--warn)">↻ follow-up de ontem</div>
    ${yO.map(o=>{const c=S.chatters.find(ch=>ch.id===o.chatterId);return`<div class="logitem alt" style="cursor:pointer" onclick="openOrientView('${o.id}')"><div class="logdate">${c?c.name:'?'} · ${o.shift}</div><div class="logtext" style="text-decoration:underline;text-decoration-style:dotted">${o.text}</div></div>`;}).join('')}</div>`;
  }
  if(!todayO.length){html+='<div class="empty"><div class="empty-ic">🎯</div><div class="empty-tx">Nenhuma orientação hoje</div></div>';}
  else{
    html+='<div class="sectionlb">hoje</div>';
    html+=todayO.map(o=>{const c=S.chatters.find(ch=>ch.id===o.chatterId);
      return`<div class="logitem orient-swipe-row" data-key="${o.id}" style="touch-action:pan-y;cursor:pointer" onclick="openOrientView('${o.id}')"><div class="logdate">${c?c.name:'?'} · ${o.time?`⏰ ${o.time}`:`turno ${o.shift}`}</div><div class="logtext" style="text-decoration:underline;text-decoration-style:dotted">${o.text}</div>
      ${o.goal?`<div style="margin-top:5px;font-family:var(--font-mono);font-size:12px;color:var(--ok)">meta: ${money(parseFloat(o.goal))}</div>`:''}
      <button class="btn btn-icon btn-line" style="margin-top:8px" onclick="event.stopPropagation();deleteOrientation('${o.id}')">✕</button></div>`;
    }).join('');
  }
  el.innerHTML=html;
  attachSwipeToDelete(el,'.orient-swipe-row',id=>deleteOrientation(id),renderOrientList);
}
function renderStudyList(){
  const el=document.getElementById('study-list');
  if(!S.studies.length){el.innerHTML='<div class="empty"><div class="empty-ic">📚</div><div class="empty-tx">Adicione itens de estudo</div></div>';return;}
  const pb={alta:'pill-bad',media:'pill-warn',baixa:'pill-flat'};
  el.innerHTML='<div class="tasklist">'+S.studies.map(s=>`<div class="taskrow ${s.done?'done':''}" data-key="${s.id}" style="touch-action:pan-y">
    <div class="tcheck ${s.done?'done':''}" onclick="toggleStudy('${s.id}')">${s.done?'✓':''}</div>
    <div class="tbody"><div class="ttext">${s.title}</div>
    <div class="tmeta-row"><span class="pill pill-info">${s.category}</span><span class="pill ${pb[s.priority]||'pill-flat'}">${s.priority}</span></div></div>
    <button class="btn btn-icon btn-line" onclick="deleteStudy('${s.id}')">✕</button>
  </div>`).join('')+'</div>';
  attachSwipeToDelete(el,'.taskrow',id=>deleteStudy(id),renderStudyList);
}

/* ===========================================================
   TEAM
   =========================================================== */
let teamFilter='all';
document.getElementById('team-filter-tabs').addEventListener('click',e=>{
  const b=e.target.closest('.segtab');if(!b)return;
  teamFilter=b.dataset.lvl;
  document.querySelectorAll('#team-filter-tabs .segtab').forEach(x=>x.classList.remove('active'));b.classList.add('active');
  renderTeam(teamFilter);
});
function renderTeam(filter){
  teamFilter=filter;
  const list=document.getElementById('team-list');
  let chatters=S.chatters;
  // 'padrinho' também pega quem acumula o 2º cargo (isPadrinho) mesmo se o
  // nível principal for outro (ex: Sênior + Padrinho).
  if(filter==='padrinho')chatters=chatters.filter(c=>c.level==='padrinho'||c.isPadrinho);
  else if(filter!=='all')chatters=chatters.filter(c=>c.level===filter);
  if(!chatters.length){list.innerHTML='<div class="empty"><div class="empty-ic">▦</div><div class="empty-tx">Nenhum chatter encontrado</div></div>';return;}

  const basicoGroup=chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));

  const renderCard=c=>{
    const isReserva=S.chatterFichas?.[c.id]?.testerDecision==='espera';
    const color=isReserva?'var(--bad)':getComputedLevelColor(c.level);
    const revWeek=getChatterWeekRevenue(c.id,0);
    const extraWeek=getChatterExtraRevenue(c.id,0);
    const {avgHtPct,htTotal}=getChatterWeekHighTicket(c.id,0);
    const status=getChatterStatus(c.id,todayKey());
    const otMins=getChatterOvertimeOn(c.id,todayKey());
    const dotColor=status==='online'?'var(--ok)':status==='overtime'?'var(--warn)':'var(--text3)';
    const timeBadge=c.time==='tester'?`<span class="pill pill-bad" style="font-size:9px">${isReserva?'🔵 Reserva':'🧪 Tester'}</span>`:`<span class="pill pill-flat" style="font-size:9px">Base</span>`;
    return`<div class="teamcard" onclick="openChatterDetail('${c.id}')" style="${isReserva?'border-left:3px solid var(--bad)':''}">
      <div class="ravatar" style="width:42px;height:42px;background:${color}22;color:${color}">${c.name.slice(0,2).toUpperCase()}</div>
      <div class="rinfo">
        <div style="display:flex;align-items:center;gap:6px"><span class="rname" style="${isReserva?'color:var(--bad)':''}">${c.name}</span><div class="tc-status" style="background:${dotColor}"></div></div>
        <div class="rmeta">${c.discord||''} · ${moneyShort(revWeek)} semana${extraWeek>0?` · ⚡${moneyShort(extraWeek)} extra`:''}${htTotal>0?` · 🎯${avgHtPct}% HT (${moneyShort(htTotal)})`:''}</div>
        <div class="tmeta-row">${timeBadge}<span class="pill ${LVLCLASS[c.level]}" style="border:1px solid">${c.level}</span>${c.isPadrinho&&c.level!=='padrinho'?`<span class="pill" style="border:1px solid;color:#B8860B;background:rgba(184,134,11,.16)">👑 Padrinho</span>`:''}${otMins>0?`<span class="pill pill-warn">+${otMins}min`:''}</div>
      </div>
      <span style="color:var(--text3);font-size:18px">›</span>
    </div>`;
  };

  let html='';
  if(basicoGroup.length){
    html+=`<div class="roster-group-label" style="font-size:11px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin:4px 0 8px">Time Base (${basicoGroup.length})</div>`;
    html+=basicoGroup.map(renderCard).join('');
  }
  list.innerHTML=html;
}
function generateWeeklyReport(chatterId){
  const c=S.chatters.find(ch=>ch.id===chatterId);
  if(!c)return;
  const wd=getWeekDates();
  const wkStart=`${wd[0].getDate()}/${wd[0].getMonth()+1}`;
  const wkEnd=`${wd[6].getDate()}/${wd[6].getMonth()+1}`;
  const wkey=getWeekKey();
  const now=new Date();
  const DAYS_BR=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const MONTHS_BR=['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

  // --- Presença ---
  const weekAbsences=S.absences.filter(a=>a.chatterId===chatterId&&a.date>=fmt(wd[0])&&a.date<=fmt(wd[6]));
  const faltas=weekAbsences.filter(a=>a.type==='falta');
  const atrasos=weekAbsences.filter(a=>a.type==='atraso');
  const saidasAntes=weekAbsences.filter(a=>a.type==='saida_antecipada');

  // --- Hora extra ---
  let totalOT=0;
  wd.forEach(d=>totalOT+=getChatterOvertimeOn(chatterId,fmt(d)));

  // --- Faturamento ---
  const revWeek=getChatterWeekRevenue(chatterId);
  const meta=parseFloat((S.chatterWeekGoals[wkey]||{})[chatterId])||0;
  const metaPct=meta>0?Math.round((revWeek/meta)*100):null;
  const revByDay=wd.map(d=>{
    let v=0;S.models.forEach(m=>{v+=parseFloat(S.revenues[`${chatterId}_${m.id}_${fmt(d)}`])||0;});
    return{day:DAYS_BR[d.getDay()],date:`${d.getDate()}/${d.getMonth()+1}`,value:v};
  }).filter(d=>d.value>0);

  // --- Orientações da semana ---
  const orients=S.orientations.filter(o=>o.chatterId===chatterId&&o.date>=fmt(wd[0])&&o.date<=fmt(wd[6]));

  // --- Treinamentos ---
  const trainings=S.chatterTrainings.filter(t=>t.chatterId===chatterId);
  const trainingsDone=trainings.filter(t=>t.done);
  const trainingsPending=trainings.filter(t=>!t.done);

  // --- Build report ---
  const lines=[];
  lines.push(`**📊 Relatório de Desenvolvimento Semanal**`);
  lines.push(`**${c.name}** · ${c.level} · Semana ${wkStart}–${wkEnd}`);
  lines.push(``);

  // Presença
  lines.push(`**📋 Presença**`);
  if(!weekAbsences.length&&totalOT===0){
    lines.push(`✅ Semana completa, sem ocorrências`);
  } else {
    if(faltas.length) lines.push(`❌ Faltas: ${faltas.length}${faltas.some(f=>f.note)?` — ${faltas.map(f=>f.note).filter(Boolean).join(', ')}`:''}` );
    if(atrasos.length) lines.push(`⚠️ Atrasos: ${atrasos.length}${atrasos.some(a=>a.note)?` — ${atrasos.map(a=>a.note).filter(Boolean).join(', ')}`:''}` );
    if(saidasAntes.length) lines.push(`🔸 Saídas antecipadas: ${saidasAntes.length}`);
    if(totalOT>0) lines.push(`⏱️ Hora extra: ${totalOT} min`);
  }
  lines.push(``);

  // Faturamento
  lines.push(`**💰 Faturamento**`);
  lines.push(`Total da semana: **R$ ${revWeek.toLocaleString('pt-BR',{minimumFractionDigits:2})}**`);
  if(meta>0){
    const emoji=metaPct>=100?'🎯':metaPct>=75?'📈':'📉';
    lines.push(`${emoji} Meta: R$ ${meta.toLocaleString('pt-BR',{minimumFractionDigits:2})} · Atingido: ${metaPct}%`);
  }
  if(revByDay.length){
    lines.push(`Detalhe por dia:`);
    revByDay.forEach(d=>lines.push(`  ${d.day} (${d.date}): R$ ${d.value.toLocaleString('pt-BR',{minimumFractionDigits:2})}`));
  }
  lines.push(``);

  // Orientações
  if(orients.length){
    lines.push(`**🎯 Orientações recebidas**`);
    orients.forEach(o=>{
      lines.push(`• ${o.date} (${o.shift}): ${o.text}${o.goal?` _(meta R$ ${parseFloat(o.goal).toLocaleString('pt-BR')})_`:''}`);
    });
    lines.push(``);
  }

  // Treinamentos
  if(trainings.length){
    lines.push(`**📚 Treinamentos**`);
    if(trainingsDone.length) trainingsDone.forEach(t=>lines.push(`✅ ${t.title}`));
    if(trainingsPending.length) trainingsPending.forEach(t=>lines.push(`⏳ ${t.title}`));
    lines.push(``);
  }

  // Notas do gestor
  if(c.notes&&c.notes.trim()){
    lines.push(`**📝 Observações do gestor**`);
    lines.push(c.notes.trim());
    lines.push(``);
  }

  lines.push(`_Gerado em ${now.getDate()} ${MONTHS_BR[now.getMonth()]} ${now.getFullYear()} às ${p2(now.getHours())}:${p2(now.getMinutes())}_`);

  const text=lines.join('\n');

  // Show in modal with copy button
  document.getElementById('report-discord-name').textContent=c.name;
  document.getElementById('report-discord-text').value=text;
  openModal('m-discord-report');
}
function copyDiscordReport(){
  const ta=document.getElementById('report-discord-text');
  ta.select();ta.setSelectionRange(0,999999);
  try{
    document.execCommand('copy');
    toast('✅ Copiado! Cole no Discord.');
  }catch(e){
    // Fallback for mobile: try clipboard API
    if(navigator.clipboard){
      navigator.clipboard.writeText(ta.value).then(()=>toast('✅ Copiado! Cole no Discord.')).catch(()=>toast('Selecione o texto manualmente e copie'));
    }
  }
}
const PERFIL_LABEL={analitica:'🔍 Analítica',criativa:'🎨 Criativa',executora:'⚡ Executora'};
function mapeamentoSummaryHtml(id){
  const m=S.chatterFichas?.[id]?.mapeamento;
  if(!m||!(m.resumo||m.motivacao||m.perfil||m.comoLiderar||m.naoFazer))return'';
  return`<div style="background:var(--accent-soft);border-radius:10px;padding:12px;margin-bottom:14px">
    <div style="font-size:11px;font-weight:800;color:var(--accent);text-transform:uppercase;letter-spacing:.04em;margin-bottom:7px">🧭 Mapeamento de perfil</div>
    ${m.resumo?`<div style="font-size:12.5px;margin-bottom:5px"><strong>História:</strong> ${m.resumo}</div>`:''}
    ${m.motivacao?`<div style="font-size:12.5px;margin-bottom:5px"><strong>Motivação:</strong> ${m.motivacao}</div>`:''}
    ${m.perfil?`<div style="font-size:12.5px;margin-bottom:5px"><strong>Perfil:</strong> ${PERFIL_LABEL[m.perfil]||m.perfil}</div>`:''}
    ${m.comoLiderar?`<div style="font-size:12.5px;margin-bottom:5px;color:var(--ok)"><strong>✅ Como liderar:</strong> ${m.comoLiderar}</div>`:''}
    ${m.naoFazer?`<div style="font-size:12.5px;color:var(--bad)"><strong>🚫 Não fazer:</strong> ${m.naoFazer}</div>`:''}
  </div>`;
}
function openChatterDetail(id){
  const c=S.chatters.find(ch=>ch.id===id);if(!c)return;
  const color=getComputedLevelColor(c.level);
  const orients=S.orientations.filter(o=>o.chatterId===id).slice(-8).reverse();
  const absencesAll=S.absences.filter(a=>a.chatterId===id).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,10);
  const revWeek=getChatterWeekRevenueTotal(id);
  const today=todayKey();
  const weekDates=getWeekDates();let weekOT=0;weekDates.forEach(d=>weekOT+=getChatterOvertimeOn(id,fmt(d)));
  const monthlyGoals=getChatterMonthlyGoalHistory(id);

  const revRows=S.models.map(m=>{
    const key=`${id}_${m.id}_${today}`;const val=S.revenues[key]||'';
    return`<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px">
      <span style="font-size:13px;color:var(--text2)">${m.emoji||'🧩'} ${m.name}</span>
      <div style="display:flex;align-items:center;gap:5px"><span style="font-family:var(--font-mono);color:var(--text3);font-size:12px">R$</span>
      <input type="number" inputmode="decimal" class="finput" style="width:84px;text-align:right;padding:6px 8px;font-size:13px;font-family:var(--font-mono)" value="${val}" placeholder="0" oninput="saveRevenue('${id}','${m.id}',this.value)"></div>
    </div>`;
  }).join('');

  const tb={falta:'pill-bad',atraso:'pill-warn',saida_antecipada:'pill-info'};
  const tl={falta:'Falta',atraso:'Atraso',saida_antecipada:'Saída antecip.'};
  const absencesHtml=absencesAll.length?absencesAll.map(a=>`
    <div class="reprow">
      <div><div class="replb">${a.date}</div>${a.note?`<div style="font-size:11px;color:var(--text3)">${a.note}</div>`:''}</div>
      <span class="pill ${tb[a.type]||'pill-flat'}">${tl[a.type]||a.type}</span>
    </div>`).join(''):'<div style="font-size:12px;color:var(--text3)">Nenhuma ocorrência registrada</div>';

  const monthlyGoalsHtml=monthlyGoals.length?monthlyGoals.map(g=>`
    <div class="reprow">
      <div class="replb">Semana de ${g.weekStart}</div>
      <div style="text-align:right">
        <span class="pill ${g.met?'pill-ok':'pill-bad'}">${g.met?'✓ bateu':'✕ não bateu'}</span>
        <div style="font-family:var(--font-mono);font-size:11px;color:var(--text3);margin-top:2px">${money(g.achieved)} / ${money(g.target)}</div>
      </div>
    </div>`).join(''):'<div style="font-size:12px;color:var(--text3)">Nenhuma meta definida este mês</div>';

  document.getElementById('chatter-detail-body').innerHTML=`
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
      <div class="ravatar" style="width:50px;height:50px;font-size:19px;background:${color}22;color:${color}">${c.name.slice(0,2).toUpperCase()}</div>
      <div><div style="font-size:17px;font-weight:700">${c.name}</div><div style="font-size:12px;color:var(--text2)">${c.discord||'sem discord'}</div>
      <span class="pill ${LVLCLASS[c.level]}" style="border:1px solid;margin-top:4px">${c.level}</span>${c.isPadrinho&&c.level!=='padrinho'?` <span class="pill" style="border:1px solid;margin-top:4px;color:#B8860B;background:rgba(184,134,11,.16)">👑 Padrinho</span>`:''}</div>
    </div>
    ${mapeamentoSummaryHtml(id)}
    <div class="statgrid">
      <div class="statcell"><div class="statval" style="font-size:18px;color:var(--ok)">${moneyShort(revWeek)}</div><div class="statlb">Semana</div></div>
      <div class="statcell"><div class="statval" style="font-size:18px;color:var(--warn)">${weekOT}min</div><div class="statlb">H.Extra sem.</div></div>
    </div>
    ${S.models.length?`<div class="field"><label class="flabel">Faturamento hoje por modelo</label>${revRows}</div>`:''}
    <div class="field"><label class="flabel">Nível</label>
      <select class="fselect" id="dl-level-${id}">
        <option value="treinamento" ${c.level==='treinamento'?'selected':''}>Treinamento</option>
        <option value="teste" ${c.level==='teste'?'selected':''}>Teste</option>
        <option value="junior" ${c.level==='junior'?'selected':''}>Júnior</option>
        <option value="pleno" ${c.level==='pleno'?'selected':''}>Pleno</option>
        <option value="senior" ${c.level==='senior'?'selected':''}>Sênior</option>
        <option value="padrinho" ${c.level==='padrinho'?'selected':''}>👑 Padrinho</option>
      </select>
    </div>
    <div class="field">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--text2)">
        <input type="checkbox" id="dl-padrinho-${id}" ${c.isPadrinho?'checked':''} style="width:17px;height:17px;accent-color:var(--accent);cursor:pointer">
        👑 Também é Padrinho <span style="color:var(--text3);font-size:11px">(acumula com o nível acima — ex: Sênior + Padrinho)</span>
      </label>
    </div>
    <div class="field"><label class="flabel">Time</label>
      <div style="display:flex;gap:8px">
        <button id="dl-time-basico-${id}" onclick="setChatterTime('${id}','basico')" style="flex:1;padding:8px;border-radius:8px;border:2px solid ${(c.time||'basico')==='basico'?'var(--info)':'var(--line)'};background:${(c.time||'basico')==='basico'?'var(--info-soft)':'transparent'};cursor:pointer;font-family:var(--font-display);font-weight:700;font-size:12.5px;color:${(c.time||'basico')==='basico'?'var(--info)':'var(--text2)'}">Time Base</button>
        <button id="dl-time-tester-${id}" onclick="setChatterTime('${id}','tester')" style="flex:1;padding:8px;border-radius:8px;border:2px solid ${c.time==='tester'?'var(--bad)':'var(--line)'};background:${c.time==='tester'?'var(--bad-soft)':'transparent'};cursor:pointer;font-family:var(--font-display);font-weight:700;font-size:12.5px;color:${c.time==='tester'?'var(--bad)':'var(--text2)'}">🧪 Tester</button>
      </div>
    </div>
    <div class="field"><label class="flabel">Mapeamento / notas</label><textarea class="ftext" id="dl-notes-${id}">${c.notes||''}</textarea></div>
    <button class="btn btn-primary btn-block" style="margin-bottom:12px" onclick="saveChatterDetail('${id}')">Salvar alterações</button>

    <div class="divider"></div>
    <div class="sectionlb">📅 turnos desta semana</div>
    <div id="dl-shifts-${id}" style="margin-bottom:10px"></div>
    <button class="btn btn-ghost btn-block btn-sm" onclick="openAddShiftForChatter('${id}')">+ adicionar turno</button>

    <div class="divider"></div>
    <div class="sectionlb">🎯 orientações recentes</div>
    ${orients.length?orients.map(o=>`<div class="logitem"><div class="logdate">${o.date} · ${o.shift||''}</div><div class="logtext">${o.text}</div>${o.goal?`<div style="margin-top:4px;font-family:var(--font-mono);font-size:11.5px;color:var(--ok)">meta do dia: ${money(parseFloat(o.goal))}</div>`:''}</div>`).join(''):'<div style="color:var(--text3);font-size:13px">Nenhuma orientação</div>'}

    <div class="divider"></div>
    <div class="sectionlb">📚 treinamentos pendentes / feitos</div>
    <div id="training-list-${id}" style="margin-bottom:8px"></div>
    <div style="display:flex;gap:6px">
      <input class="finput" id="new-training-${id}" placeholder="Novo treinamento..." style="flex:1">
      <button class="btn btn-primary btn-sm" onclick="addChatterTraining('${id}')">+</button>
    </div>

    <div class="divider"></div>
    <div class="sectionlb">📊 faltas e atrasos</div>
    ${absencesHtml}

    <div class="divider"></div>
    <div class="sectionlb">🎯 metas do mês</div>
    ${monthlyGoalsHtml}

    <button class="btn btn-primary btn-block" style="margin-top:12px" onclick="generateWeeklyReport('${id}')">📊 Gerar relatório semanal para Discord</button>
    <button class="btn btn-danger btn-block" style="margin-top:8px" onclick="deleteChatter('${id}')">Remover chatter</button>
  `;
  openModal('m-chatter-detail');
  refreshChatterDetailTrainings(id);
  renderChatterShifts(id);
}
/* ===========================================================
   CHATTER PROFILE — shift management inline
   =========================================================== */
function renderChatterShifts(chatterId){
  const el=document.getElementById('dl-shifts-'+chatterId);
  if(!el)return;
  const shifts=S.shifts.filter(s=>s.chatterId===chatterId);
  const DAY_LABEL={seg:'Seg',ter:'Ter',qua:'Qua',qui:'Qui',sex:'Sex',sab:'Sáb',dom:'Dom'};
  if(!shifts.length){
    el.innerHTML='<div style="font-size:12.5px;color:var(--text3)">Nenhum turno cadastrado</div>';
    return;
  }
  el.innerHTML=shifts.map(s=>{
    const days=(s.days||[]).map(d=>DAY_LABEL[d]||d).join(', ');
    const t2=s.start2&&s.end2?` + ${s.start2}–${s.end2}`:'';
    const folga=s.folgaDia?` · folga: ${DAY_LABEL[s.folgaDia]||s.folgaDia}`:'';
    const models=(s.modelIds||[]).map(mid=>S.models.find(m=>m.id===mid)?.name).filter(Boolean).join(', ');
    return`<div style="background:var(--bg-soft);border-radius:9px;padding:10px 12px;margin-bottom:7px;display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
      <div style="flex:1;min-width:0">
        <div style="font-family:var(--font-mono);font-weight:700;font-size:12.5px;color:var(--warn)">${s.start}–${s.end}${t2}</div>
        <div style="font-size:11.5px;color:var(--text2);margin-top:2px">${days}${folga}</div>
        ${models?`<div style="font-size:11px;color:var(--text3);margin-top:1px">🧩 ${models}</div>`:''}
      </div>
      <div style="display:flex;gap:5px;flex-shrink:0">
        <button class="btn btn-ghost btn-xs" onclick="openEditShiftFromProfile('${s.id}','${chatterId}')">✎</button>
        <button class="btn btn-danger btn-xs" onclick="deleteShiftFromProfile('${s.id}','${chatterId}')">✕</button>
      </div>
    </div>`;
  }).join('');
}
function openAddShiftForChatter(chatterId){
  // Pre-select this chatter in the shift modal and open it
  document.getElementById('shift-edit-id').value='';
  openModal('m-shift');
  document.getElementById('shift-modal-title').textContent='Novo turno';
  setTimeout(()=>{
    document.getElementById('shift-chatter').value=chatterId;
  },40);
}
function openEditShiftFromProfile(shiftId,chatterId){
  openEditShift(shiftId);
  // After saving, re-render the profile shifts
  const origSave=window._profileSaveCallback;
  window._profileChaterId=chatterId;
}
function deleteShiftFromProfile(shiftId,chatterId){
  markTombstone(shiftId);
  S.shifts=S.shifts.filter(s=>s.id!==shiftId);
  save();
  toast('Turno removido');
  renderChatterShifts(chatterId);
  renderScheduleForDay(selectedDay);
  clearTimeout(fbSaveTimer);
  pushToFirestore();
}

function saveChatterDetail(id){
  const c=S.chatters.find(ch=>ch.id===id);if(!c)return;
  const levelEl=document.getElementById('dl-level-'+id);
  const notesEl=document.getElementById('dl-notes-'+id);
  const padrinhoEl=document.getElementById('dl-padrinho-'+id);
  if(levelEl)c.level=levelEl.value||c.level;
  if(notesEl)c.notes=notesEl.value; // intentional: allow clearing notes
  if(padrinhoEl)c.isPadrinho=!!padrinhoEl.checked; // 2º cargo acumulável (ex: Sênior + Padrinho)
  save();toast('✅ Atualizado!');renderTeam(teamFilter);
}
function deleteChatter(id){
  if(!confirm('Remover chatter? Isso apaga TUDO relacionado a ele em todas as abas (fichas, faltas, orientações, treinamentos, ponto, hora extra, análises, etc). Se quiser manter o histórico visível em algum lugar, use "Reservas" em vez de excluir.'))return;
  S.chatters=S.chatters.filter(c=>c.id!==id);
  S.shifts=S.shifts.filter(s=>s.chatterId!==id);
  S.absences=S.absences.filter(a=>a.chatterId!==id);
  S.orientations=S.orientations.filter(o=>o.chatterId!==id);
  S.chatterTrainings=S.chatterTrainings.filter(t=>t.chatterId!==id);
  S.chatlabAnalyses=(S.chatlabAnalyses||[]).filter(a=>a.chatterId!==id);
  delete S.chatterFichas[id];
  tombstoneField('chatterFichas.'+id);
  delete S.testerLogs[id];
  Object.keys(S.turnoLog).forEach(dateKey=>{
    S.turnoLog[dateKey]=S.turnoLog[dateKey].filter(e=>e.chatterId!==id);
  });
  Object.keys(S.midnightTasks).forEach(dateKey=>{
    S.midnightTasks[dateKey]=S.midnightTasks[dateKey].filter(t=>t.chatterId!==id);
  });
  Object.keys(S.chatterWeekGoals).forEach(wkey=>{
    delete S.chatterWeekGoals[wkey][id];
  });
  Object.keys(S.watchAlerts).forEach(dateKey=>{
    delete S.watchAlerts[dateKey][id];
  });
  Object.keys(S.folgas).forEach(dateKey=>{
    S.folgas[dateKey]=(S.folgas[dateKey]||[]).filter(cid=>cid!==id);
  });
  Object.keys(S.horaExtraSlots).forEach(wkey=>{
    S.horaExtraSlots[wkey]=(S.horaExtraSlots[wkey]||[]).filter(x=>x.chatterId!==id);
  });
  Object.keys(S.weeklyAnalysisDone).forEach(wkey=>{
    S.weeklyAnalysisDone[wkey]=(S.weeklyAnalysisDone[wkey]||[]).filter(cid=>cid!==id);
  });
  Object.keys(S.orientedThisWeek||{}).forEach(wkey=>{
    S.orientedThisWeek[wkey]=(S.orientedThisWeek[wkey]||[]).filter(cid=>cid!==id);
  });
  Object.keys(S.scheduleRequests||{}).forEach(wkey=>{
    S.scheduleRequests[wkey]=(S.scheduleRequests[wkey]||[]).filter(x=>x.chatterId!==id);
  });
  Object.keys(S.motivational||{}).forEach(wkey=>{
    if(S.motivational[wkey]?.chatters)delete S.motivational[wkey].chatters[id];
  });
  S.swaps=(S.swaps||[]).filter(sw=>sw.covererId!==id&&sw.originalId!==id);
  Object.keys(S.justificativas||{}).forEach(key=>{
    if(key.includes(id))delete S.justificativas[key];
  });
  Object.keys(S.alertNotes||{}).forEach(key=>{
    if(key.includes(id))delete S.alertNotes[key];
  });
  Object.keys(S.revenues).forEach(key=>{
    if(key.startsWith(id+'_'))delete S.revenues[key];
  });
  save();closeModal('m-chatter-detail');toast('Chatter e todo histórico removidos de todas as abas');renderTeam(teamFilter);
}

/* ===========================================================
   CHATTER TRAININGS — pending/done list per chatter, separate
   from free-text notes, so the manager can track concrete
   to-dos for each person's development.
   =========================================================== */
function addChatterTraining(chatterId){
  const input=document.getElementById('new-training-'+chatterId);
  const title=input.value.trim();
  if(!title){toast('⚠️ Descreva o treinamento');return;}
  S.chatterTrainings.push({id:'tr'+Date.now(),chatterId,title,done:false,createdAt:todayKey()});
  save();
  input.value='';
  toast('✅ Treinamento adicionado!');
  refreshChatterDetailTrainings(chatterId);
}
function toggleChatterTraining(trainingId,chatterId){
  const t=S.chatterTrainings.find(x=>x.id===trainingId);
  if(t){
    t.done=!t.done;
    t.doneAt=t.done?todayKey():null; // record when marked done
    save();refreshChatterDetailTrainings(chatterId);
  }
}
function deleteChatterTraining(trainingId,chatterId){
  S.chatterTrainings=S.chatterTrainings.filter(x=>x.id!==trainingId);
  save();toast('Removido');refreshChatterDetailTrainings(chatterId);
}
function refreshChatterDetailTrainings(chatterId){
  const el=document.getElementById('training-list-'+chatterId);
  if(!el)return;
  const items=S.chatterTrainings.filter(t=>t.chatterId===chatterId);
  if(!items.length){el.innerHTML='<div style="font-size:12px;color:var(--text3)">Nenhum treinamento cadastrado</div>';return;}
  el.innerHTML=items.map(t=>`
    <div class="taskrow ${t.done?'done':''}" data-key="${t.id}" style="margin-bottom:6px;touch-action:pan-y">
      <div class="tcheck ${t.done?'done':''}" onclick="toggleChatterTraining('${t.id}','${chatterId}')">${t.done?'✓':''}</div>
      <div class="tbody"><div class="ttext" style="font-size:12.5px">${t.title}</div></div>
      <button class="btn btn-icon btn-line" onclick="deleteChatterTraining('${t.id}','${chatterId}')">✕</button>
    </div>`).join('');
  attachSwipeToDelete(el,'.taskrow',id=>deleteChatterTraining(id,chatterId),()=>refreshChatterDetailTrainings(chatterId));
}

/* ===========================================================
   FATURAMENTO
   =========================================================== */
/* ===========================================================
   RELATÓRIO SEMANAL COMPLETO
   Seções 1-4 e 6 são preenchidas automaticamente a partir dos
   dados do app. Seções 5, 7, 8 são manuais (com rascunho salvo).
   =========================================================== */
function renderReport_Weekly(){
  renderWeekNav();
  const wd=getWeekDates();
  const wkey=getWeekKey();
  const goals=S.chatterWeekGoals[wkey]||{};
  const wkStart=fmt(wd[0]),wkEnd=fmt(wd[6]);

  // Sempre sincroniza os campos manuais com o rascunho da semana ATUAL logo de
  // cara (antes de qualquer outra lógica que confira se estão vazios) — antes
  // isso só rodava no fim da função e só quando o campo já estava vazio, então
  // ao trocar de semana o texto da semana anterior ficava "preso" no campo em
  // vez de mostrar (ou esvaziar para) o rascunho da nova semana.
  ['erro1','erro2','erro3','prob1','prob2','plano1','plano2','plano3','ajustes'].forEach(key=>{
    const el=document.getElementById('rpt-'+key);
    if(el)el.value=getReportDraft(key)||'';
  });

  // Update week range header
  const rangeEl=document.getElementById('report-wk-range');
  if(rangeEl)rangeEl.textContent=`${wd[0].getDate()}/${wd[0].getMonth()+1} a ${wd[6].getDate()}/${wd[6].getMonth()+1}`;

  // ---- Section 1: Visão Geral ----
  let totalRev=0;
  const chatterRevs=S.chatters.filter(c=>c.time!=='tester'&&c.time!=='elite'&&!isChatterTerminated(c)).map(c=>{
    let r=0;wd.forEach(wdate=>S.models.forEach(m=>{r+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(wdate)}`])||0;}));
    return{c,r};
  }).filter(x=>x.r>0).sort((a,b)=>b.r-a.r);
  chatterRevs.forEach(x=>totalRev+=x.r);
  const avgRev=chatterRevs.length?totalRev/chatterRevs.length:0;
  const best=chatterRevs[0];
  const worst=chatterRevs[chatterRevs.length-1];
  const s1=document.getElementById('rpt-visao-geral');
  if(s1)s1.innerHTML=`
    <div class="reprow"><div class="replb">Faturamento total bruto</div><div class="repval" style="color:var(--ok);font-weight:800">${money(totalRev)}</div></div>
    <div class="reprow"><div class="replb">Média por chatter</div><div class="repval">${money(avgRev)}</div></div>
    <div class="reprow"><div class="replb">Melhor chatter</div><div class="repval" style="color:var(--ok)">${best?`${best.c.name} (${moneyShort(best.r)})`:'—'}</div></div>
    <div class="reprow"><div class="replb">Pior chatter</div><div class="repval" style="color:var(--bad)">${worst&&worst!==best?`${worst.c.name} (${moneyShort(worst.r)})`:'—'}</div></div>
  `;

  // ---- Section 2: Performance por Chatter ----
  const s2=document.getElementById('rpt-performance');
  if(s2){
    const ativos=S.chatters.filter(c=>c.level!=='treinamento'&&c.level!=='teste'&&c.time!=='tester'&&c.time!=='elite'&&!isChatterTerminated(c));
    if(!ativos.length){s2.innerHTML='<div style="color:var(--text3);font-size:12px">Nenhum chatter ativo cadastrado</div>';}
    else s2.innerHTML=ativos.map(c=>{
      let rev=0;let daysWorked=0;
      wd.forEach(wdate=>{
        let dayRev=0;S.models.forEach(m=>{dayRev+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(wdate)}`])||0;});
        rev+=dayRev;if(dayRev>0)daysWorked++;
      });
      const extra=getChatterExtraRevenue(c.id);
      const revTotal=rev+extra;
      const avg=daysWorked>0?rev/daysWorked:0;
      const weekAbs=S.absences.filter(a=>a.chatterId===c.id&&a.date>=fmt(wd[0])&&a.date<=fmt(wd[6]));
      const orients=S.orientations.filter(o=>o.chatterId===c.id&&o.date>=fmt(wd[0])&&o.date<=fmt(wd[6]));
      const target=parseFloat(goals[c.id])||0;
      const pct=target>0?Math.round((rev/target)*100):null; // meta uses rev only, not extra
      const statusColor=weekAbs.filter(a=>a.type==='falta').length>=2?'var(--bad)':rev<avgRev*0.6?'var(--warn)':'var(--ok)';
      const statusLabel=weekAbs.filter(a=>a.type==='falta').length>=2?'Atenção':rev===0?'Atenção':'Ativo';
      const modelsWorked=[...new Set(S.shifts.filter(s=>s.chatterId===c.id&&s.days&&s.days.some(dk=>wd.map(w=>DAY_KEYS[w.getDay()]).includes(dk))).flatMap(s=>s.modelIds||[]))].map(mid=>S.models.find(m=>m.id===mid)?.name).filter(Boolean);
      return`<div style="background:var(--bg-soft);border-radius:10px;padding:12px;margin-bottom:10px;border-left:3px solid ${statusColor}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div style="font-weight:700;font-size:14px">${c.name}</div>
          <span class="pill" style="background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}">${statusLabel}</span>
        </div>
        <div class="reprow"><div class="replb">Cargo / Nível</div><div class="repval">${c.level}</div></div>
        <div class="reprow"><div class="replb">Modelo(s)</div><div class="repval">${modelsWorked.length?modelsWorked.join(', '):'—'}</div></div>
        <div class="reprow"><div class="replb">Faturamento semanal</div><div class="repval">${money(rev)}${pct!==null?` <span style="font-size:11px;color:${pct>=100?'var(--ok)':'var(--warn)'}">(${pct}% da meta)</span>`:''}</div></div>
        ${extra>0?`<div class="reprow"><div class="replb">⚡ Hora extra</div><div class="repval" style="color:var(--info)">${money(extra)}</div></div>`:''}
        ${extra>0?`<div class="reprow"><div class="replb">Total (incl. extra)</div><div class="repval" style="font-weight:800">${money(revTotal)}</div></div>`:''}
        <div class="reprow"><div class="replb">Média diária</div><div class="repval">${money(avg)}</div></div>
        ${(()=>{
          const f=S.chatterFichas[c.id];const aw=f?.analytics?.weeklyData||{};
          const wks=wd.map(d=>fmt(d)).filter(dk=>aw[dk]);
          if(!wks.length)return'';
          let tkt=0,vph=0,htp=0,days=0,maxG=0;
          wks.forEach(dk=>{const a=aw[dk];if(a.ticketMedio>0){tkt+=a.ticketMedio;vph+=a.vendasPorHora||0;htp+=a.highTicketPct||0;days++;}if((a.maxGapMin||0)>maxG)maxG=a.maxGapMin||0;});
          const at=days>0?tkt/days:0,av=days>0?Math.round(vph/days*100)/100:0,ah=days>0?Math.round(htp/days):0;
          return`<div class="reprow"><div class="replb">Ticket médio</div><div class="repval">${money(at)}</div></div>
          <div class="reprow"><div class="replb">Valor/hora</div><div class="repval" style="color:${av>=20?'var(--ok)':av>=10?'var(--warn)':'var(--bad)'}">${money(av)}/h</div></div>
          <div class="reprow"><div class="replb">% High ticket</div><div class="repval" style="color:${ah>=30?'var(--ok)':ah>=15?'var(--warn)':'var(--bad)'}">${ah}%</div></div>
          ${maxG>0?`<div class="reprow"><div class="replb">Maior gap sem venda</div><div class="repval" style="color:${maxG>60?'var(--bad)':maxG>30?'var(--warn)':'var(--ok)'}">${maxG}min</div></div>`:''}`;
        })()}
        <div class="reprow"><div class="replb">Ocorrências</div><div class="repval">${weekAbs.length?weekAbs.map(a=>({falta:'Falta',atraso:'Atraso',saida_antecipada:'Saída antecip.'})[a.type]||a.type).join(', '):'Nenhuma'}</div></div>
        <div class="field" style="margin-top:8px"><label class="flabel">Principal erro</label><input class="finput" id="rpt-erro-${c.id}" value="${getReportDraft('erro-'+c.id)}" placeholder="Descreva o erro principal..." onblur="saveReportDraftField('erro-${c.id}',this.value)"></div>
        <div class="field"><label class="flabel">Ação tomada</label><input class="finput" id="rpt-acao-${c.id}" value="${getReportDraft('acao-'+c.id)}" placeholder="O que você fez a respeito..." onblur="saveReportDraftField('acao-${c.id}',this.value)"></div>
        ${orients.length?`<div style="margin-top:6px;font-size:11.5px;color:var(--text2)">📋 ${orients.length} orientação(ões) esta semana</div>`:''}
      </div>`;
    }).join('');
  }

  // ---- Section 3: Chatters em Teste ----
  // Só entra quem já existia até o fim dessa semana (não dá pra "estar em
  // teste" numa semana antes de ter sido cadastrado) e quem não foi removido
  // manualmente (arrastar pro lado) desse relatório específico — cobre os
  // casos que o filtro automático não pega.
  const hiddenTestersWk=(S.reportTesterHidden&&S.reportTesterHidden[wkey])||[];
  const testersRep=S.chatters.filter(c=>{
    if(!(c.time==='tester'||S.chatterFichas?.[c.id]?.testerDecision))return false;
    if(hiddenTestersWk.includes(c.id))return false;
    if(c.createdAt&&c.createdAt.slice(0,10)>wkEnd)return false;
    return true;
  });
  const s3=document.getElementById('rpt-testers');
  if(s3){
    if(!testersRep.length){s3.innerHTML='<div style="color:var(--text3);font-size:12px">Nenhum tester em teste esta semana</div>';}
    else{
      s3.innerHTML=testersRep.map(c=>{
        const f=S.chatterFichas?.[c.id]||{};
        const decision=f.testerDecision||'';
        const decLabel={aprovado:'✅ Aprovado',espera:'🔵 Continuar (reservas)',reprovado:'❌ Reprovado','':'⏳ Pendente'}[decision];
        const decColor={aprovado:'var(--ok)',espera:'var(--warn)',reprovado:'var(--bad)','':'var(--text3)'}[decision];
        const daysInTest=c.createdAt?Math.floor((new Date()-new Date(c.createdAt))/86400000):0;
        let rev=0;wd.forEach(dd=>{S.models.forEach(m=>{rev+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(dd)}`])||0;});});
        return`<div class="tester-report-row" data-key="${c.id}" style="background:var(--bg-soft);border-radius:10px;padding:12px;margin-bottom:10px;border-left:3px solid ${decColor};touch-action:pan-y">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <div style="font-weight:700;font-size:14px">${c.name}</div>
            <span class="pill" style="background:${decColor}22;color:${decColor};border:1px solid ${decColor}">${decLabel}</span>
          </div>
          <div class="reprow"><div class="replb">Dias em teste</div><div class="repval">${daysInTest}</div></div>
          <div class="reprow"><div class="replb">Faturamento (semana)</div><div class="repval">${money(rev)}</div></div>
          <div class="field" style="margin-top:8px">
            <label class="flabel">Evolução</label>
            <div style="display:flex;gap:6px">
              ${['Boa','Média','Ruim'].map(op=>`<button id="rpt-evol-${c.id}-${op}" onclick="setReportToggle('evoltest-${c.id}','${op}','rpt-evol-${c.id}',['Boa','Média','Ruim'])" style="flex:1;padding:6px 4px;border-radius:8px;border:1px solid var(--line);background:var(--bg);cursor:pointer;font-family:var(--font-display);font-weight:700;font-size:11.5px;color:var(--text2)">${op}</button>`).join('')}
            </div>
          </div>
          <div class="field"><label class="flabel">Principais erros</label><input class="finput" id="rpt-erroteste-${c.id}" value="${getReportDraft('erroteste-'+c.id)}" placeholder="Descreva os principais erros..." onblur="saveReportDraftField('erroteste-${c.id}',this.value)"></div>
          ${decision===''?`<div style="font-size:11px;color:var(--text3);margin-top:4px">Decisão (Aprovar/Continuar/Reprovar) é definida na aba Testers</div>`:''}
          <div style="font-size:10.5px;color:var(--text3);margin-top:6px">⇠ arraste pro lado se ele não estava nessa semana</div>
        </div>`;
      }).join('');
      testersRep.forEach(c=>applyReportToggleVisual(getReportDraft('evoltest-'+c.id),`rpt-evol-${c.id}`,['Boa','Média','Ruim']));
      attachSwipeToDelete(s3,'.tester-report-row',id=>hideTesterFromReport(id),renderReport_Weekly);
    }
  }

  // ---- Section 4: Evolução dos Novos (Resumo) ----
  const s4=document.getElementById('rpt-novos-resumo');
  if(s4){
    const entraram=testersRep.filter(c=>c.createdAt&&c.createdAt.slice(0,10)>=wkStart&&c.createdAt.slice(0,10)<=wkEnd).length;
    const aprovadosWeek=testersRep.filter(c=>{const f=S.chatterFichas?.[c.id];return f?.testerDecision==='aprovado'&&f.testerDecisionDate>=wkStart&&f.testerDecisionDate<=wkEnd;}).length;
    const reprovadosWeek=testersRep.filter(c=>{const f=S.chatterFichas?.[c.id];return f?.testerDecision==='reprovado'&&f.testerDecisionDate>=wkStart&&f.testerDecisionDate<=wkEnd;}).length;
    const comDificuldade=testersRep.filter(c=>{
      const dec=S.chatterFichas?.[c.id]?.testerDecision;
      if(dec==='aprovado'||dec==='reprovado')return false;
      const ev=getReportDraft('evoltest-'+c.id);
      return ev==='Ruim'||ev==='Média';
    }).length;
    s4.innerHTML=`
      ${reportMetricRow('Quantos entraram',entraram,'novos-entraram')}
      ${reportMetricRow('Quantos evoluíram bem',aprovadosWeek,'novos-bem')}
      ${reportMetricRow('Quantos estão com dificuldade',comDificuldade,'novos-dificuldade')}
      ${reportMetricRow('Quantos foram reprovados',reprovadosWeek,'novos-reprovados')}
    `;
  }

  // ---- Section 6: Ações Realizadas ----
  const s6=document.getElementById('rpt-acoes');
  if(s6){
    // Count trainings marked done this week (use doneAt if available, else createdAt)
    const trainsDone=S.chatterTrainings.filter(t=>{
      if(!t.done)return false;
      const doneDate=t.doneAt||t.createdAt||'';
      return doneDate>=wkStart&&doneDate<=wkEnd;
    }).length;
    const corrections=S.orientations.filter(o=>o.date>=wkStart&&o.date<=wkEnd).length;
    const swapsWeek=S.swaps.filter(sw=>sw.date>=wkStart&&sw.date<=wkEnd).length;
    const decisionsWeek=Object.values(S.chatterFichas||{}).filter(f=>f.testerDecisionDate>=wkStart&&f.testerDecisionDate<=wkEnd).length;
    const catsSetWeek=Object.values(S.chatterFichas||{}).filter(f=>f.pagCategoria).length;
    s6.innerHTML=`
      ${reportMetricRow('Treinamentos feitos',trainsDone,'acoes-treinos')}
      ${reportMetricRow('Orientações/correções',corrections,'acoes-correcoes')}
      ${reportMetricRow('Trocas de turno cobertas',swapsWeek,'acoes-trocas')}
      ${reportMetricRow('Decisões de teste (aprovado/reprovado)',decisionsWeek,'acoes-decisoes')}
      ${reportMetricRow('Categorias de pagamento definidas',catsSetWeek,'acoes-categorias')}
    `;
    // Auto-preenche "Ajustes na operação" com um resumo, só se estiver vazio
    const ajustesEl=document.getElementById('rpt-ajustes');
    if(ajustesEl&&!ajustesEl.value&&!getReportDraft('ajustes')){
      const parts=[];
      if(swapsWeek)parts.push(`${swapsWeek} troca${swapsWeek>1?'s':''} de turno registrada${swapsWeek>1?'s':''}`);
      if(decisionsWeek)parts.push(`${decisionsWeek} decisão${decisionsWeek>1?'ões':''} de teste tomada${decisionsWeek>1?'s':''}`);
      if(trainsDone)parts.push(`${trainsDone} treinamento${trainsDone>1?'s':''} concluído${trainsDone>1?'s':''}`);
      if(parts.length)ajustesEl.value='Sugestão automática: '+parts.join('; ')+'. (edite ou complete)';
    }
  }

  // ---- Auto-sugestão para Seção 5 (Erros) e Seção 7 (Problemas) ----
  // Só preenche campos vazios — nunca sobrescreve o que o gestor já escreveu.
  autoSuggestReportIssues(wd);
}

// Analisa dados reais do app (faltas sem justificativa, metas não batidas,
// relatórios não enviados, orientações pendentes) e sugere conteúdo pras
// seções "Principais Erros" e "Problemas Encontrados" — só quando o campo
// ainda está vazio, pra nunca sobrescrever o que o gestor já escreveu.
function autoSuggestReportIssues(wd){
  const wkStart=fmt(wd[0]),wkEnd=fmt(wd[6]);
  const problems=[];
  const errors=[];

  // Faltas sem justificativa essa semana
  const faltasSemJust=S.absences.filter(a=>a.date>=wkStart&&a.date<=wkEnd&&a.type==='falta'&&!a.justificativa);
  if(faltasSemJust.length){
    const nomes=faltasSemJust.map(a=>S.chatters.find(c=>c.id===a.chatterId)?.name).filter(Boolean);
    problems.push(`Faltas sem justificativa: ${[...new Set(nomes)].join(', ')} (${faltasSemJust.length} falta${faltasSemJust.length>1?'s':''})`);
  }

  // Chatters muito abaixo da meta (< 70%) essa semana
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  const abaixoMeta=chatters.filter(c=>{
    const meta=parseFloat((S.chatterWeekGoals[getWeekKey(0)]||{})[c.id])||0;
    if(!meta)return false;
    const rev=getChatterWeekRevenue(c.id,0);
    return rev/meta<0.7;
  });
  if(abaixoMeta.length){
    errors.push(`${abaixoMeta.length} chatter${abaixoMeta.length>1?'s':''} abaixo de 70% da meta: ${abaixoMeta.map(c=>c.name).join(', ')} — vale reforçar acompanhamento`);
  }

  // Orientações pendentes há mais de 7 dias
  const oldOrients=(S.weekOrients||[]).filter(o=>!o.done&&o.date&&(new Date()-new Date(o.date+'T12:00:00'))>7*86400000);
  if(oldOrients.length){
    problems.push(`${oldOrients.length} orientação${oldOrients.length>1?'ões':''} pendente${oldOrients.length>1?'s':''} há mais de 7 dias`);
  }

  // Turnos sem chatter escalado
  S.models.forEach(m=>{
    DAY_KEYS.forEach(dk=>{
      const covered=S.shifts.some(s=>(s.days||[]).includes(dk)&&(s.modelIds||[]).includes(m.id)&&s.chatterId);
      if(!covered)errors.push(`${m.name} sem cobertura cadastrada em ${dk.toUpperCase()}`);
    });
  });

  const errorIds=['erro1','erro2','erro3'];
  errors.slice(0,3).forEach((txt,i)=>{
    const el=document.getElementById('rpt-'+errorIds[i]);
    if(el&&!el.value&&!getReportDraft(errorIds[i]))el.value=txt;
  });
  const probIds=['prob1','prob2'];
  problems.slice(0,2).forEach((txt,i)=>{
    const el=document.getElementById('rpt-'+probIds[i]);
    if(el&&!el.value&&!getReportDraft(probIds[i]))el.value=txt;
  });
}

// Linha de métrica usada nas seções "Evolução dos Novos" e "Ações Realizadas"
// do relatório: sempre editável. Mostra o valor automático detectado pelo
// app, mas o gestor pode corrigir a qualquer momento — se ele digitar um
// valor diferente do automático, essa correção fica salva (é o "não
// reconheceu automaticamente, preciso colocar"). Se ele deixar igual ao
// automático (ou apagar), volta a acompanhar o número calculado pelo app.
function reportMetricRow(label,autoVal,draftKey){
  const manual=getReportDraft(draftKey);
  const hasManual=manual!==''&&manual!==undefined&&manual!==null;
  const val=hasManual?manual:autoVal;
  return`<div class="reprow"><div class="replb">${label}</div><input type="number" inputmode="decimal" class="finput" style="width:64px;text-align:right;padding:4px 8px;flex:none" id="rpt-${draftKey}" value="${val}" data-auto="${autoVal}" onblur="saveReportMetric('${draftKey}',this)"></div>`;
}
function saveReportMetric(draftKey,el){
  const auto=parseInt(el.dataset.auto)||0;
  const typed=el.value.trim();
  if(typed===''||parseInt(typed)===auto){
    saveReportDraftField(draftKey,'');
  } else {
    saveReportDraftField(draftKey,typed);
  }
}
function getReportMetric(autoVal,draftKey){
  const manual=getReportDraft(draftKey);
  if(manual!==''&&manual!==undefined&&manual!==null)return parseInt(manual)||0;
  return autoVal;
}
function getReportDraft(key){
  const wkey=getWeekKey();
  return(S.reportDrafts&&S.reportDrafts[wkey]&&S.reportDrafts[wkey][key])||'';
}
function saveReportDraftField(key,value){
  const wkey=getWeekKey();
  if(!S.reportDrafts)S.reportDrafts={};
  if(!S.reportDrafts[wkey])S.reportDrafts[wkey]={};
  S.reportDrafts[wkey][key]=value;
  save();
}
// Arrastar pro lado na seção "Chatters em Teste" do relatório: não apaga o
// tester (ele continua existindo normalmente em Testers/Fichas/etc), só some
// dele NESSE relatório específico — pra quando o filtro automático (data de
// cadastro) não pega o caso (ex: tester antigo que não estava ativo naquela
// semana por outro motivo).
function hideTesterFromReport(chatterId){
  const wkey=getWeekKey();
  if(!S.reportTesterHidden)S.reportTesterHidden={};
  if(!S.reportTesterHidden[wkey])S.reportTesterHidden[wkey]=[];
  if(!S.reportTesterHidden[wkey].includes(chatterId))S.reportTesterHidden[wkey].push(chatterId);
  save();
  toast('Removido desse relatório');
}
function applyReportToggleVisual(value,btnGroupPrefix,options){
  const colorMap={
    Boa:'var(--ok)',Média:'var(--warn)',Ruim:'var(--bad)',
    Aprovar:'var(--ok)',Continuar:'var(--warn)',Reprovar:'var(--bad)'
  };
  const bgMap={
    Boa:'var(--ok-soft)',Média:'var(--warn-soft)',Ruim:'var(--bad-soft)',
    Aprovar:'var(--ok-soft)',Continuar:'var(--warn-soft)',Reprovar:'var(--bad-soft)'
  };
  options.forEach(op=>{
    const btn=document.getElementById(`${btnGroupPrefix}-${op}`);
    if(!btn)return;
    const sel=op===value;
    btn.style.borderColor=sel?colorMap[op]:'var(--line)';
    btn.style.background=sel?bgMap[op]:'var(--bg)';
    btn.style.color=sel?colorMap[op]:'var(--text2)';
  });
}
function setReportToggle(draftKey,value,btnGroupPrefix,options){
  saveReportDraftField(draftKey,value);
  applyReportToggleVisual(value,btnGroupPrefix,options||(value==='Boa'||value==='Ruim'||value==='Média'?['Boa','Média','Ruim']:['Aprovar','Continuar','Reprovar']));
}
function saveReportDraft(){
  const wkey=getWeekKey();
  if(!S.reportDrafts)S.reportDrafts={};
  if(!S.reportDrafts[wkey])S.reportDrafts[wkey]={};
  const fields=['erro1','erro2','erro3','prob1','prob2','plano1','plano2','plano3','ajustes'];
  fields.forEach(key=>{
    const el=document.getElementById('rpt-'+key);
    if(el)S.reportDrafts[wkey][key]=el.value;
  });
  // Save chatter-level text fields (evolucao/decisao are saved immediately via setReportToggle)
  S.chatters.forEach(c=>{
    ['erro','acao','erroteste'].forEach(f=>{
      const el=document.getElementById(`rpt-${f}-${c.id}`);
      if(el)S.reportDrafts[wkey][`${f}-${c.id}`]=el.value;
    });
  });
  save();
  toast('💾 Rascunho salvo!');
}
function buildReportLines(){
  const wd=getWeekDates();
  const wkey=getWeekKey();
  const goals=S.chatterWeekGoals[wkey]||{};
  const d=key=>getReportDraft(key);
  const wkStart=fmt(wd[0]),wkEnd=fmt(wd[6]);

  // Mesmo filtro da tela (renderReport_Weekly) — exclui tester/elite/desligado
  // e só considera quem faturou, senão o PDF e a tela mostram números
  // diferentes de faturamento total/melhor/pior chatter.
  let totalRev=0;
  const chatterRevs=S.chatters.filter(c=>c.time!=='tester'&&c.time!=='elite'&&!isChatterTerminated(c)).map(c=>{
    let r=0;wd.forEach(wdate=>S.models.forEach(m=>{r+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(wdate)}`])||0;}));
    return{c,r};
  }).filter(x=>x.r>0).sort((a,b)=>b.r-a.r);
  chatterRevs.forEach(x=>totalRev+=x.r);
  const avgRev=chatterRevs.length?totalRev/chatterRevs.length:0;
  const best=chatterRevs[0];
  const worst=chatterRevs[chatterRevs.length-1];

  const lines=[];
  lines.push(`📊 RELATÓRIO SEMANAL CHAT`);
  lines.push(`(DATA: ${wd[0].getDate()}/${wd[0].getMonth()+1} à ${wd[6].getDate()}/${wd[6].getMonth()+1})`);
  lines.push(``);
  lines.push(`1. VISÃO GERAL`);
  lines.push(`● Faturamento total (bruto): ${money(totalRev)}`);
  lines.push(`● Média por chatter: ${money(avgRev)}`);
  lines.push(`● Melhor chatter: ${best?`${best.c.name} (${moneyShort(best.r)})`:'—'}`);
  lines.push(`● Pior chatter: ${worst&&worst!==best?`${worst.c.name} (${moneyShort(worst.r)})`:'—'}`);
  lines.push(``);
  lines.push(`2. PERFORMANCE POR CHATTER`);
  const ativos=S.chatters.filter(c=>c.level!=='treinamento'&&c.level!=='teste'&&c.time!=='tester'&&c.time!=='elite'&&!isChatterTerminated(c));
  ativos.forEach(c=>{
    let rev=0;let daysWorked=0;
    wd.forEach(dd=>{let dr=0;S.models.forEach(m=>{dr+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(dd)}`])||0;});rev+=dr;if(dr>0)daysWorked++;});
    const avg=daysWorked>0?rev/daysWorked:0;
    const weekAbs=S.absences.filter(a=>a.chatterId===c.id&&a.date>=wkStart&&a.date<=wkEnd);
    const target=parseFloat(goals[c.id])||0;
    const pct=target>0?`${Math.round((rev/target)*100)}% da meta`:'sem meta definida';
    const statusLabel=weekAbs.filter(a=>a.type==='falta').length>=2?'Atenção':rev===0?'Atenção':'Ativo';
    const modelsWorked=[...new Set(S.shifts.filter(s=>s.chatterId===c.id&&s.days&&s.days.some(dk=>wd.map(w=>DAY_KEYS[w.getDay()]).includes(dk))).flatMap(s=>s.modelIds||[]))].map(mid=>S.models.find(m=>m.id===mid)?.name).filter(Boolean);
    lines.push(`Nome: ${c.name}`);
    lines.push(`● Status: ${statusLabel}`);
    lines.push(`● Cargo: ${c.level}`);
    lines.push(`● Modelo: ${modelsWorked.length?modelsWorked.join(', '):'—'}`);
    lines.push(`● Faturamento semanal: ${money(rev)} (${pct})`);
    lines.push(`● Média diária: ${money(avg)}`);
    lines.push(`● Principal erro: ${d('erro-'+c.id)||'—'}`);
    lines.push(`● Ação tomada: ${d('acao-'+c.id)||'—'}`);
    lines.push(``);
  });

  lines.push(`3. CHATTERS EM TESTE`);
  // Mesmo filtro da tela: exclui quem foi arrastado pra fora desse relatório
  // específico e quem ainda nem existia até o fim dessa semana.
  const hiddenTestersWk=(S.reportTesterHidden&&S.reportTesterHidden[wkey])||[];
  const testersRep=S.chatters.filter(c=>{
    if(!(c.time==='tester'||S.chatterFichas?.[c.id]?.testerDecision))return false;
    if(hiddenTestersWk.includes(c.id))return false;
    if(c.createdAt&&c.createdAt.slice(0,10)>wkEnd)return false;
    return true;
  });
  if(!testersRep.length){
    lines.push(`Nenhum tester em teste esta semana.`);
    lines.push(``);
  } else {
    testersRep.forEach(c=>{
      const f=S.chatterFichas?.[c.id]||{};
      const decision=f.testerDecision||'';
      const decLabel={aprovado:'Aprovar',espera:'Continuar',reprovado:'Reprovar','':'Pendente'}[decision];
      const daysInTest=c.createdAt?Math.floor((new Date()-new Date(c.createdAt))/86400000):0;
      let rev=0;wd.forEach(dd=>{S.models.forEach(m=>{rev+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(dd)}`])||0;});});
      lines.push(`Nome: ${c.name}`);
      lines.push(`● Dias em teste: ${daysInTest}`);
      lines.push(`● Faturamento: ${money(rev)}`);
      lines.push(`● Evolução: ${d('evoltest-'+c.id)||'—'}`);
      lines.push(`● Principais erros: ${d('erroteste-'+c.id)||'—'}`);
      lines.push(`● Decisão: ${decLabel}`);
      lines.push(``);
    });
  }

  lines.push(`4. EVOLUÇÃO DOS NOVOS (RESUMO)`);
  const entraram=testersRep.filter(c=>c.createdAt&&c.createdAt.slice(0,10)>=wkStart&&c.createdAt.slice(0,10)<=wkEnd).length;
  const aprovadosWeek=testersRep.filter(c=>{const f=S.chatterFichas?.[c.id];return f?.testerDecision==='aprovado'&&f.testerDecisionDate>=wkStart&&f.testerDecisionDate<=wkEnd;}).length;
  const reprovadosWeek=testersRep.filter(c=>{const f=S.chatterFichas?.[c.id];return f?.testerDecision==='reprovado'&&f.testerDecisionDate>=wkStart&&f.testerDecisionDate<=wkEnd;}).length;
  const comDificuldade=testersRep.filter(c=>{
    const dec=S.chatterFichas?.[c.id]?.testerDecision;
    if(dec==='aprovado'||dec==='reprovado')return false;
    const ev=d('evoltest-'+c.id);
    return ev==='Ruim'||ev==='Média';
  }).length;
  lines.push(`● Quantos entraram: ${getReportMetric(entraram,'novos-entraram')}`);
  lines.push(`● Quantos evoluíram bem: ${getReportMetric(aprovadosWeek,'novos-bem')}`);
  lines.push(`● Quantos estão com dificuldade: ${getReportMetric(comDificuldade,'novos-dificuldade')}`);
  lines.push(`● Quantos foram reprovados: ${getReportMetric(reprovadosWeek,'novos-reprovados')}`);
  lines.push(``);

  lines.push(`5. SEUS PRINCIPAIS ERROS DA SEMANA`);
  lines.push(`● Erro 1: ${d('erro1')||'—'}`);
  lines.push(`● Erro 2: ${d('erro2')||'—'}`);
  lines.push(`● Erro 3: ${d('erro3')||'—'}`);
  lines.push(``);
  const trainsDone=S.chatterTrainings.filter(t=>{
    if(!t.done)return false;
    const doneDate=t.doneAt||t.createdAt||'';
    return doneDate>=wkStart&&doneDate<=wkEnd;
  }).length;
  const corrections=S.orientations.filter(o=>o.date>=wkStart&&o.date<=wkEnd).length;
  lines.push(`6. AÇÕES REALIZADAS`);
  lines.push(`● Treinamentos feitos: ${getReportMetric(trainsDone,'acoes-treinos')}`);
  lines.push(`● Correções aplicadas: ${getReportMetric(corrections,'acoes-correcoes')}`);
  lines.push(`● Ajustes na operação: ${d('ajustes')||'—'}`);
  lines.push(``);
  lines.push(`7. PROBLEMAS ENCONTRADOS`);
  lines.push(`● Problema 1: ${d('prob1')||'—'}`);
  lines.push(`● Problema 2: ${d('prob2')||'—'}`);
  lines.push(``);
  lines.push(`8. PLANO PARA PRÓXIMA SEMANA`);
  lines.push(`● Ação 1: ${d('plano1')||'—'}`);
  lines.push(`● Ação 2: ${d('plano2')||'—'}`);
  lines.push(`● Ação 3: ${d('plano3')||'—'}`);

  return lines;
}
function generateFullReport(){
  saveReportDraft();
  const lines=buildReportLines();
  const text=lines.join('\n');
  document.getElementById('rpt-output').value=text;
  document.getElementById('rpt-output-panel').style.display='block';
  document.getElementById('rpt-output-panel').scrollIntoView({behavior:'smooth'});
  toast('✅ Relatório gerado!');
}
function downloadReportPDF(){
  saveReportDraft();
  if(!window.jspdf||!window.jspdf.jsPDF){
    toast('⏳ PDF ainda carregando, tente de novo em instantes');
    return;
  }
  const lines=buildReportLines();
  const {jsPDF}=window.jspdf;
  const doc=new jsPDF({unit:'pt',format:'a4'});
  const marginL=42,marginR=42;
  const pageW=doc.internal.pageSize.getWidth();
  const pageH=doc.internal.pageSize.getHeight();
  const maxW=pageW-marginL-marginR;
  const lineH=14;
  let y=48;
  lines.forEach((raw,i)=>{
    if(raw===''){y+=lineH*0.6;return;}
    const isMainTitle=i===0;
    const isSectionTitle=/^\d+\.\s/.test(raw);
    const isName=/^Nome:/.test(raw);
    doc.setFontSize(isMainTitle?14:isSectionTitle?11.5:10);
    doc.setFont('helvetica',isMainTitle||isSectionTitle||isName?'bold':'normal');
    const wrapped=doc.splitTextToSize(raw,maxW);
    wrapped.forEach(wl=>{
      if(y>pageH-50){doc.addPage();y=48;}
      doc.text(wl,marginL,y);
      y+=lineH;
    });
    if(isSectionTitle)y+=2;
  });
  const wd=getWeekDates();
  const fname=`relatorio-semanal_${fmt(wd[0])}_a_${fmt(wd[6])}.pdf`;
  doc.save(fname);
  toast('✅ PDF baixado!');
}
function copyFullReport(){
  const ta=document.getElementById('rpt-output');
  ta.select();ta.setSelectionRange(0,999999);
  try{
    document.execCommand('copy');
    toast('✅ Copiado! Cole no Discord.');
  }catch(e){
    if(navigator.clipboard)navigator.clipboard.writeText(ta.value).then(()=>toast('✅ Copiado!')).catch(()=>toast('Selecione o texto manualmente'));
  }
}

let selectedFatDate=todayKey(); // currently selected date for revenue entry

function renderFat(){
  renderModelsList();
  const picker=document.getElementById('fat-date-picker');
  if(picker)picker.value=selectedFatDate;
  const dateLb=document.getElementById('fat-date-lb');
  if(dateLb)dateLb.textContent=selectedFatDate===todayKey()?'Hoje · '+selectedFatDate:selectedFatDate;
  renderRevenueTable();
  renderExtraProgress();
  renderReport('week');
  renderDailyByModel();
  renderDailyByChatter();
}
function changeFatDate(offset){
  const d=new Date(selectedFatDate+'T12:00:00');
  d.setDate(d.getDate()+offset);
  selectedFatDate=fmt(d);
  renderFat();
}
function setFatDate(val){
  if(val)selectedFatDate=val;
  renderFat();
}
function renderModelsList(){
  const el=document.getElementById('models-list');
  if(!S.models.length){el.innerHTML='<div style="color:var(--text3);font-size:13px">Nenhum modelo. Clique + modelo.</div>';return;}
  el.innerHTML='<div style="display:flex;flex-wrap:wrap;gap:6px">'+S.models.map(m=>`<div style="display:inline-flex;align-items:center;gap:6px;background:var(--bg-soft);border:1px solid var(--line);border-radius:8px;padding:5px 10px">
    <span>${m.emoji||'🧩'}</span><span style="font-size:13px;font-weight:600">${m.name}</span>
    <button onclick="deleteModel('${m.id}')" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:13px">✕</button>
  </div>`).join('')+'</div>';
}
// Chatter "demitido": some do time ativo (faturamento, pagamento, projeção,
// ranking, escalas futuras) a partir da data de demissão, mas o histórico
// (fichas, relatórios, evolução) continua intacto pra sempre.
function isChatterTerminated(c){
  return!!c.terminatedDate&&c.terminatedDate<=todayKey();
}
// Modelo(s) escalado(s) pra um chatter num dia específico (a partir da
// escala/turno) — na prática quase sempre é só 1, já que ninguém atende mais
// de uma modelo ao mesmo tempo. Usado pra saber automaticamente qual modelo
// preencher no lançamento de faturamento, sem precisar de 1 coluna por modelo.
function getChatterModelsForDate(cid,dateKey){
  const dayKey=DAY_KEYS[new Date(dateKey+'T12:00:00').getDay()];
  const ids=[...new Set(S.shifts.filter(s=>s.chatterId===cid&&(s.days||[]).includes(dayKey)&&s.folgaDia!==dayKey).flatMap(s=>s.modelIds||[]))];
  return ids.map(mid=>S.models.find(m=>m.id===mid)).filter(Boolean);
}
// Chamado pelo input de receita da linha — descobre a modelo certa (fixa, se
// só tem 1 escalada, ou pelo <select> quando tem 0/2+) e salva nessa chave.
function saveRevenueRow(chatterId,dateKey,inputEl){
  const row=inputEl.closest('tr');
  const fixedModelId=row?.dataset.fixedModel;
  const select=row?.querySelector('select[data-fat-model]');
  const modelId=fixedModelId||select?.value;
  if(!modelId){toast('⚠️ Selecione a modelo antes de lançar');return;}
  saveRevenue(chatterId,modelId,inputEl.value,dateKey);
}
function renderRevenueTable(){
  const el=document.getElementById('revenue-table');
  if(!el)return;
  if(!S.models.length){el.innerHTML='<div class="empty"><div class="empty-tx">Cadastre modelos para lançar faturamento</div></div>';return;}
  if(!S.chatters.length){el.innerHTML='<div class="empty"><div class="empty-tx">Cadastre chatters para lançar faturamento</div></div>';return;}
  const dateKey=selectedFatDate;

  // Show all chatters do time base — elite e testers/reservas têm seu
  // próprio fluxo de faturamento (Gerador Elite / Testers / Reservas)
  const allChatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));

  let html='';

  // Table header — 1 coluna de receita só, já que cada chatter atende 1
  // modelo por vez (a modelo é detectada da escala, não escolhida por coluna)
  html+=`<div style="overflow-x:auto"><table class="rtable">
    <thead><tr>
      <th>Chatter</th>
      <th>Modelo</th>
      <th style="text-align:right;color:var(--ok)">Receita (R$)</th>
    </tr></thead><tbody>`;

  let dayTotal=0;
  allChatters.forEach(c=>{
    const scheduled=getChatterModelsForDate(c.id,dateKey);
    let modelCell='',valueCell='',rowVal=0,fixedAttr='';
    if(scheduled.length===1){
      const m=scheduled[0];
      fixedAttr=`data-fixed-model="${m.id}"`;
      rowVal=parseFloat(S.revenues[`${c.id}_${m.id}_${dateKey}`])||0;
      modelCell=`<div style="font-size:12.5px">${m.emoji||'🧩'} ${m.name}</div>`;
      valueCell=`<input type="number" inputmode="decimal" class="rinput" value="${rowVal||''}" placeholder="—"
          oninput="saveRevenueRow('${c.id}','${dateKey}',this)">`;
    } else if(scheduled.length===2){
      // Trabalhou com 2 modelos dentro do turno normal dele hoje (não é hora
      // extra) — conta faturamento de AMBAS pra meta dele, então mostra os
      // dois campos lado a lado em vez de forçar escolher só uma no seletor.
      const vals=scheduled.map(m=>parseFloat(S.revenues[`${c.id}_${m.id}_${dateKey}`])||0);
      rowVal=vals[0]+vals[1];
      modelCell=scheduled.map(m=>`<div style="font-size:11.5px;padding:3px 0">${m.emoji||'🧩'} ${m.name}</div>`).join('');
      valueCell=scheduled.map((m,i)=>`<div style="padding:2px 0"><input type="number" inputmode="decimal" class="rinput" value="${vals[i]||''}" placeholder="—"
          oninput="saveRevenue('${c.id}','${m.id}',this.value,'${dateKey}');renderRevenueTable()"></div>`).join('');
    } else {
      // 0 modelos escalados (folga/sem turno hoje) ou 3+ (bem raro) — só
      // nesses casos aparece um seletor manual escolhendo 1 modelo por vez.
      const options=scheduled.length?scheduled:S.models;
      const withRev=options.find(m=>(parseFloat(S.revenues[`${c.id}_${m.id}_${dateKey}`])||0)>0);
      const selectedModel=withRev||options[0];
      rowVal=selectedModel?parseFloat(S.revenues[`${c.id}_${selectedModel.id}_${dateKey}`])||0:0;
      modelCell=`<select data-fat-model onchange="renderRevenueTable()" style="font-size:11.5px;padding:3px 5px;border-radius:6px;border:1px solid var(--line);background:var(--bg-soft);color:var(--text)">
        ${options.map(m=>`<option value="${m.id}" ${selectedModel&&m.id===selectedModel.id?'selected':''}>${m.emoji||'🧩'} ${m.name}</option>`).join('')}
      </select>${!scheduled.length?'<div style="font-size:9px;color:var(--text3);margin-top:2px">sem escala hoje</div>':''}`;
      valueCell=`<input type="number" inputmode="decimal" class="rinput" value="${rowVal||''}" placeholder="—"
          oninput="saveRevenueRow('${c.id}','${dateKey}',this)">`;
    }
    dayTotal+=rowVal;
    const rowColor=rowVal>0?'':'opacity:0.5';
    html+=`<tr class="chatter-fire-row" data-key="${c.id}" ${fixedAttr} style="${rowColor};touch-action:pan-y">
      <td><div style="font-weight:700;font-size:13px">${c.name}</div></td>
      <td>${modelCell}</td>
      <td style="text-align:right">
        ${valueCell}
      </td>
    </tr>`;
  });

  // Total row — resultado do dia é o número mais importante da tela, então
  // fica bem maior e destacado (fundo suave) em vez de se misturar com as
  // linhas normais da tabela.
  html+=`<tr class="rtotalrow" style="background:var(--ok-soft)"><td colspan="2" style="font-size:14px"><strong>TOTAL DIA</strong></td>
    <td style="text-align:right;font-family:var(--font-mono);font-weight:800;font-size:22px;color:var(--ok);padding:10px 8px">${dayTotal>0?money(dayTotal):'—'}</td></tr>`;
  html+='</tbody></table></div>';
  html+='<div style="font-size:10.5px;color:var(--text3);margin-top:6px">Arraste o nome de alguém pro lado pra demitir (some do faturamento a partir de hoje). A modelo é detectada automaticamente pela escala do dia — só aparece pra escolher quando não tem escala ou tem mais de uma no mesmo dia.</div>';

  el.innerHTML=html;
  attachSwipeDismiss(el,'.chatter-fire-row',key=>fireChatterFromFaturamento(key));
}
function fireChatterFromFaturamento(chatterId){
  const c=S.chatters.find(ch=>ch.id===chatterId);
  if(!c)return;
  const ok=confirm(`Demitir ${c.name}?\n\nA partir de HOJE ele não aparece mais no faturamento, pagamento, projeção, ranking semanal nem nas escalas futuras. O histórico até hoje continua intacto nas fichas, relatórios e evolução.`);
  if(!ok){renderRevenueTable();return;} // desfaz a animação de arrastar
  c.terminatedDate=todayKey();
  S.shifts=S.shifts.filter(s=>s.chatterId!==chatterId); // não trabalha mais, tira da escala futura
  save();
  toast(`${c.name} foi demitido — histórico preservado, some do time ativo a partir de hoje`);
  renderRevenueTable();
  renderDailyByModel();renderDailyByChatter();
}
function openSubstituteReport(dateKey){
  // Pre-fill the substitute modal with the date
  const el=document.getElementById('substitute-report-input');
  const dateLb=document.getElementById('substitute-report-date');
  if(dateLb)dateLb.textContent=dateKey;
  if(el)el.value='';
  openModal('m-substitute-report');
}

function processSubstituteReport(){
  const dateEl=document.getElementById('substitute-report-date');
  const inputEl=document.getElementById('substitute-report-input');
  if(!inputEl?.value.trim()){toast('⚠️ Cole o relatório antes de substituir');return;}

  const dateKey=dateEl?.textContent||selectedFatDate;

  // 1. Clear all existing revenue for this date
  S.chatters.forEach(c=>{
    S.models.forEach(m=>{
      delete S.revenues[`${c.id}_${m.id}_${dateKey}`];
    });
  });
  // Clear hora extra for this date
  Object.keys(S.horaExtraSlots).forEach(wk=>{
    S.horaExtraSlots[wk]=(S.horaExtraSlots[wk]||[]).filter(x=>x.dateKey!==dateKey);
  });
  // Clear analytics for this date
  S.chatters.forEach(c=>{
    const f=S.chatterFichas[c.id];
    if(f?.analytics?.weeklyData)delete f.analytics.weeklyData[dateKey];
  });

  // 2. Re-parse using the new report content
  // Temporarily replace the teamreport-input value and process
  const originalInput=document.getElementById('teamreport-input');
  const originalValue=originalInput?.value||'';
  if(originalInput)originalInput.value=inputEl.value;

  parseTeamReports();

  if(originalInput)originalInput.value=originalValue;

  closeModal('m-substitute-report');
  toast(`✅ Relatório de ${dateKey} substituído com sucesso!`,4000);
  renderFat();
}

function toggleRestChatters(){
  if(p)p.style.display=p.style.display==='none'?'block':'none';
}
function forceAddToday(chatterId){
  // Manually mark as "in" today so they appear in the revenue table without affecting shift schedule
  const today=todayKey();
  if(!S.turnoLog[today])S.turnoLog[today]=[];
  S.turnoLog[today].push({id:'tl'+Date.now()+Math.random().toString(36).slice(2,6),chatterId,action:'in',time:nowHHMM(),manualAdd:true});
  save();renderRevenueTable();renderTurnoBoard();renderHome();
  const c=S.chatters.find(ch=>ch.id===chatterId);
  toast(`✅ ${c?c.name:'?'} adicionado ao lançamento de hoje`);
}
document.getElementById('report-period-tabs').addEventListener('click',e=>{
  const b=e.target.closest('.segtab');if(!b)return;
  document.getElementById('report-period-tabs').querySelectorAll('.segtab').forEach(x=>x.classList.remove('active'));b.classList.add('active');
  renderReport(b.dataset.rep);
});
function renderReport(period){
  const el=document.getElementById('report-body');
  const wd=getWeekDates();const today=new Date();
  const teamChatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  if(period==='week'){
    let total=0;wd.forEach(d=>teamChatters.forEach(c=>S.models.forEach(m=>{total+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(d)}`])||0;})));
    el.innerHTML=`<div style="font-family:var(--font-mono);font-size:26px;font-weight:700;color:var(--ok);text-align:center;padding:6px 0">${money(total)}</div>
    <div class="divider"></div><div class="sectionlb">por modelo</div>
    ${S.models.map(m=>{let r=0;wd.forEach(d=>teamChatters.forEach(c=>{r+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(d)}`])||0;}));return`<div class="reprow"><div class="replb">${m.emoji} ${m.name}</div><div class="repval">${money(r)}</div></div>`;}).join('')}
    <div class="divider"></div><div class="sectionlb">por chatter</div>
    ${teamChatters.map(c=>`<div class="reprow"><div class="replb">${c.name}</div><div class="repval">${money(getChatterWeekRevenueTotal(c.id))}</div></div>`).join('')}`;
  } else {
    const year=today.getFullYear(),month=today.getMonth();
    const daysInMonthSoFar=Array.from({length:today.getDate()},(_,i)=>new Date(year,month,i+1));
    let total=0;daysInMonthSoFar.forEach(d=>{const key=fmt(d);teamChatters.forEach(c=>S.models.forEach(m=>{total+=parseFloat(S.revenues[`${c.id}_${m.id}_${key}`])||0;}));});
    el.innerHTML=`<div style="font-family:var(--font-mono);font-size:26px;font-weight:700;color:var(--ok);text-align:center;padding:6px 0">${money(total)}</div>
    <div style="text-align:center;font-size:12px;color:var(--text2);margin-bottom:8px">${MONTHS[month]} ${year}</div>
    <div class="divider"></div><div class="sectionlb">por modelo</div>
    ${S.models.map(m=>{let r=0;daysInMonthSoFar.forEach(d=>{const key=fmt(d);teamChatters.forEach(c=>{r+=parseFloat(S.revenues[`${c.id}_${m.id}_${key}`])||0;});});return`<div class="reprow"><div class="replb">${m.emoji} ${m.name}</div><div class="repval">${money(r)}</div></div>`;}).join('')}
    <div class="divider"></div><div class="sectionlb">por chatter</div>
    ${teamChatters.map(c=>{let r=0;daysInMonthSoFar.forEach(d=>{const key=fmt(d);S.models.forEach(m=>{r+=parseFloat(S.revenues[`${c.id}_${m.id}_${key}`])||0;});});return`<div class="reprow"><div class="replb">${c.name}</div><div class="repval">${money(r)}</div></div>`;}).join('')}`;
  }
}
function buildRevReport(){
  const el=document.getElementById('revreport-body');
  const wd=getWeekDates();let html='';
  wd.forEach((d,i)=>{
    const key=fmt(d);let dayTotal=0;
    const breakdown=S.models.map(m=>{let mt=0;S.chatters.forEach(c=>{mt+=parseFloat(S.revenues[`${c.id}_${m.id}_${key}`])||0;});dayTotal+=mt;
      return mt>0?`<div style="display:flex;justify-content:space-between;padding:3px 0 3px 10px"><span style="font-size:12px;color:var(--text2)">${m.emoji} ${m.name}</span><span style="font-family:var(--font-mono);font-size:12px">${money(mt)}</span></div>`:'';}).join('');
    html+=`<div class="reprow" style="flex-direction:column;align-items:stretch"><div style="display:flex;justify-content:space-between"><span style="font-weight:700">${['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'][i]} ${d.getDate()}/${d.getMonth()+1}</span><span style="font-family:var(--font-mono);font-weight:800;color:var(--ok)">${money(dayTotal)}</span></div>${breakdown}</div>`;
  });
  el.innerHTML=html||'<div class="empty"><div class="empty-tx">Nenhum lançamento</div></div>';
}

/* ===========================================================
   DAILY BREAKDOWN BY MODEL — day-by-day table for each model,
   across the current week.
   =========================================================== */
function renderDailyByModel(){
  const el=document.getElementById('daily-by-model');
  if(!el)return;
  if(!S.models.length){el.innerHTML='<div class="empty"><div class="empty-tx">Cadastre modelos para ver o diário</div></div>';return;}
  const teamChatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  const wd=getWeekDates();
  const dayLabels=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  let html=`<div style="overflow-x:auto"><table class="rtable"><thead><tr><th>Modelo</th>${dayLabels.map(d=>`<th style="text-align:right">${d}</th>`).join('')}<th style="text-align:right;color:var(--ok)">Total</th></tr></thead><tbody>`;
  S.models.forEach(m=>{
    let rowTotal=0;
    const cells=wd.map(d=>{
      let v=0;teamChatters.forEach(c=>{v+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(d)}`])||0;});
      rowTotal+=v;
      return`<td style="text-align:right;font-family:var(--font-mono);font-size:11.5px">${v>0?v.toLocaleString('pt-BR',{maximumFractionDigits:0}):'—'}</td>`;
    }).join('');
    html+=`<tr><td><div style="font-weight:700;font-size:13px">${m.emoji} ${m.name}</div></td>${cells}<td style="text-align:right;font-family:var(--font-mono);font-weight:800;color:var(--ok)">${moneyShort(rowTotal)}</td></tr>`;
  });
  html+='<tr class="rtotalrow"><td>TOTAL</td>';
  wd.forEach(d=>{
    let dayTotal=0;teamChatters.forEach(c=>S.models.forEach(m=>{dayTotal+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(d)}`])||0;}));
    html+=`<td style="text-align:right;font-size:11.5px">${dayTotal>0?dayTotal.toLocaleString('pt-BR',{maximumFractionDigits:0}):'—'}</td>`;
  });
  html+=`<td style="text-align:right">${moneyShort(getWeekTotalRevenue())}</td></tr></tbody></table></div>`;
  el.innerHTML=html;
}

/* ===========================================================
   DAILY BREAKDOWN BY CHATTER — day-by-day table for each
   chatter, across the current week.
   =========================================================== */
function renderDailyByChatter(){
  const el=document.getElementById('daily-by-chatter');
  if(!el)return;
  if(!S.models.length){el.innerHTML='<div class="empty"><div class="empty-tx">Cadastre modelos para ver o diário</div></div>';return;}

  const dateKey=selectedFatDate||todayKey();

  // Build model -> chatters map from shifts
  const teamChatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  const modelChatters={};
  S.models.forEach(m=>{ modelChatters[m.id]=new Set(); });
  S.shifts.forEach(s=>{
    (s.modelIds||[]).forEach(mid=>{
      if(modelChatters[mid])modelChatters[mid].add(s.chatterId);
    });
  });

  let html='';

  S.models.forEach(m=>{
    const chatterIds=[...modelChatters[m.id]];
    // Also include chatters who have revenue for this model on the selected date
    teamChatters.forEach(c=>{
      const rev=parseFloat(S.revenues[`${c.id}_${m.id}_${dateKey}`])||0;
      if(rev>0)chatterIds.push(c.id);
    });
    const uniqueIds=[...new Set(chatterIds)].filter(cid=>teamChatters.some(c=>c.id===cid));
    if(!uniqueIds.length)return;

    const chattersData=uniqueIds.map(cid=>{
      const c=teamChatters.find(ch=>ch.id===cid);
      if(!c)return null;
      const rev=parseFloat(S.revenues[`${c.id}_${m.id}_${dateKey}`])||0;
      return{c,rev};
    }).filter(Boolean).sort((a,b)=>b.rev-a.rev);

    const modelTotal=chattersData.reduce((s,x)=>s+x.rev,0);

    html+=`<div style="background:var(--bg-soft);border-radius:12px;padding:14px;margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:15px;font-weight:700">${m.emoji||'🧩'} ${m.name}</div>
        <div style="font-family:var(--font-mono);font-weight:800;font-size:15px;color:var(--ok)">${money(modelTotal)}</div>
      </div>
      ${chattersData.map(({c,rev},i)=>`
        <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 0;${i<chattersData.length-1?'border-bottom:1px solid var(--line)':''}">
          <div style="font-size:13.5px;font-weight:600">${c.name}</div>
          <div style="display:flex;align-items:center;gap:8px">
            <input type="number" inputmode="decimal" class="finput" style="width:90px;text-align:right;padding:5px 8px;font-size:13px;font-family:var(--font-mono)"
              value="${rev||''}" placeholder="0"
              oninput="saveRevenue('${c.id}','${m.id}',this.value,'${dateKey}')">
          </div>
        </div>`).join('')}
    </div>`;
  });

  if(!html)html='<div style="font-size:12.5px;color:var(--text3);padding:8px 0">Nenhum chatter vinculado a modelos — configure os turnos na aba Turno</div>';
  el.innerHTML=html;
}
function getWeekTotalRevenue(){
  const teamChatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  let t=0;
  getWeekDates().forEach(d=>teamChatters.forEach(c=>S.models.forEach(m=>{t+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(d)}`])||0;})));
  // Include hora extra from parsed reports in the grand total display
  const wkey=getWeekKey();
  (S.horaExtraSlots[wkey]||[]).filter(x=>x.shiftId==='parsed').forEach(x=>t+=parseFloat(x.revenue)||0);
  return t;
}
function getWeekExtraRevenue(){
  const wkey=getWeekKey();
  return (S.horaExtraSlots[wkey]||[]).filter(x=>x.shiftId==='parsed').reduce((s,x)=>s+(parseFloat(x.revenue)||0),0);
}
function getChatterExtraRevenue(chatterId,offset){
  const wkey=getWeekKey(offset);
  const isReserva=S.chatterFichas?.[chatterId]?.testerDecision==='espera';
  if(isReserva)return getChatterWeekRevenue(chatterId,offset); // reserva: 100% do faturamento conta como hora extra
  const slots=(S.horaExtraSlots[wkey]||[]).filter(x=>x.shiftId==='parsed'&&x.chatterId===chatterId);
  let t=0;
  getWeekDates(offset).forEach(d=>{
    const dk=fmt(d);
    const fin=getChatterDayRevenueFinanceiro(chatterId,dk);
    if(fin){t+=fin.extra;return;}
    t+=slots.filter(x=>x.dateKey===dk).reduce((s,x)=>s+(parseFloat(x.revenue)||0),0);
  });
  return t;
}

/* ===========================================================
   PER-CHATTER WEEKLY GOALS — manager sets a weekly revenue
   target for each chatter; app computes progress, remaining
   amount, and how much they need per remaining day to hit it.
   =========================================================== */
function getDaysRemainingInWeek(){
  // Week runs Sunday→Saturday. Counts today + days left until Saturday.
  const dow=new Date().getDay(); // 0=Dom..6=Sáb
  return Math.max(1,7-dow);
}
function renderChatterGoals(){
  const el=document.getElementById('chatter-goals-list');
  if(!el)return;
  if(!S.chatters.length){el.innerHTML='<div class="empty"><div class="empty-tx">Cadastre chatters para definir metas</div></div>';return;}
  const wkey=getWeekKey();
  const goals=S.chatterWeekGoals[wkey]||{};
  const daysLeft=getDaysRemainingInWeek();
  el.innerHTML=S.chatters.map(c=>{
    const target=parseFloat(goals[c.id])||0;
    const current=getChatterWeekRevenue(c.id);
    const remaining=Math.max(0,target-current);
    const pct=target>0?Math.min(100,Math.round((current/target)*100)):0;
    const perDay=remaining>0?remaining/daysLeft:0;
    const met=target>0&&current>=target;
    return`<div class="goalcard ${met?'met':''}">
      <div class="goal-top">
        <div class="goal-text">${c.name}</div>
        <div style="display:flex;align-items:center;gap:5px">
          <span style="font-size:11px;color:var(--text3)">meta:</span>
          <input type="number" inputmode="decimal" class="finput" style="width:90px;text-align:right;padding:5px 8px;font-size:12.5px" value="${target||''}" placeholder="0"
            onchange="saveChatterGoal('${c.id}',this.value)">
        </div>
      </div>
      ${target>0?`
        <div class="goalbar-track"><div class="goalbar-fill" style="width:${pct}%"></div></div>
        <div class="goal-nums">
          <span>${money(current)} de ${money(target)}</span>
          <span style="color:${met?'var(--ok)':'var(--warn)'}">${pct}%</span>
        </div>
        ${met?
          `<div style="margin-top:8px;font-size:12px;color:var(--ok);font-weight:600">🎉 Meta da semana batida!</div>`
          :`<div style="margin-top:8px;display:flex;gap:8px">
            <div style="flex:1;background:var(--bg-soft);border-radius:8px;padding:8px 10px">
              <div style="font-size:10px;color:var(--text3);font-weight:700;text-transform:uppercase">Falta</div>
              <div style="font-family:var(--font-mono);font-size:14px;font-weight:700;color:var(--bad)">${money(remaining)}</div>
            </div>
            <div style="flex:1;background:var(--bg-soft);border-radius:8px;padding:8px 10px">
              <div style="font-size:10px;color:var(--text3);font-weight:700;text-transform:uppercase">Por dia (${daysLeft}d restantes)</div>
              <div style="font-family:var(--font-mono);font-size:14px;font-weight:700;color:var(--accent)">${money(perDay)}</div>
            </div>
          </div>`}
      `:'<div style="font-size:11.5px;color:var(--text3);margin-top:6px">Defina uma meta para acompanhar o progresso</div>'}
    </div>`;
  }).join('');
}
function saveChatterGoal(chatterId,value){
  const wkey=getWeekKey();
  if(!S.chatterWeekGoals[wkey])S.chatterWeekGoals[wkey]={};
  S.chatterWeekGoals[wkey][chatterId]=parseFloat(value)||0;
  save();
  toast('🎯 Meta definida!');
  renderChatterGoals();
}

/* ===========================================================
   MONTHLY GOAL HISTORY — for a given chatter, walk back through
   every week key stored this month and report hit/miss + values.
   =========================================================== */
function getChatterMonthlyGoalHistory(chatterId){
  const now=new Date();
  const month=now.getMonth(),year=now.getFullYear();
  const results=[];
  Object.keys(S.chatterWeekGoals).forEach(wkey=>{
    const weekStart=new Date(wkey+'T12:00:00');
    if(isNaN(weekStart.getTime()))return;
    // Only include weeks that start in the current month (good enough granularity for a manager's monthly view)
    if(weekStart.getMonth()!==month||weekStart.getFullYear()!==year)return;
    const target=parseFloat(S.chatterWeekGoals[wkey][chatterId])||0;
    if(!target)return;
    const weekEnd=new Date(weekStart);weekEnd.setDate(weekStart.getDate()+6);
    let achieved=0;
    for(let d=new Date(weekStart);d<=weekEnd;d.setDate(d.getDate()+1)){
      S.models.forEach(m=>{achieved+=parseFloat(S.revenues[`${chatterId}_${m.id}_${fmt(d)}`])||0;});
    }
    results.push({weekStart:fmt(weekStart),target,achieved,met:achieved>=target});
  });
  return results.sort((a,b)=>a.weekStart.localeCompare(b.weekStart));
}

/* ===========================================================
   CRUD
   =========================================================== */
function populateChatterSelects(){
  ['abs-chatter','orient-chatter','ot-chatter'].forEach(id=>{
    const el=document.getElementById(id);if(!el)return;
    el.innerHTML=S.chatters.length?S.chatters.map(c=>`<option value="${c.id}">${c.name}</option>`).join(''):'<option value="">Nenhum chatter</option>';
  });
  // Elite é só cadastro — não faz parte da escala/turno
  const shiftSel=document.getElementById('shift-chatter');
  if(shiftSel){
    const notElite=S.chatters.filter(c=>c.time!=='elite');
    shiftSel.innerHTML=notElite.length?notElite.map(c=>`<option value="${c.id}">${c.name}</option>`).join(''):'<option value="">Nenhum chatter</option>';
  }
}
function saveModel(){
  const name=document.getElementById('model-name').value.trim();if(!name){toast('⚠️ Nome obrigatório');return;}
  S.models.push({id:'m'+Date.now(),name,emoji:document.getElementById('model-emoji').value.trim()||'🧩'});
  save();closeModal('m-model');document.getElementById('model-name').value='';document.getElementById('model-emoji').value='';
  toast('✅ Modelo adicionado!');renderFat();
}
function deleteModel(id){if(!confirm('Remover modelo?'))return;S.models=S.models.filter(m=>m.id!==id);save();toast('Removido');renderFat();}
function saveChatter(){
  const name=document.getElementById('ch-name').value.trim();if(!name){toast('⚠️ Nome obrigatório');return;}
  S.chatters.push({id:'c'+Date.now(),name,discord:document.getElementById('ch-discord').value.trim(),level:document.getElementById('ch-level').value,notes:document.getElementById('ch-notes').value.trim(),createdAt:new Date().toISOString()});
  save();closeModal('m-chatter');['ch-name','ch-discord','ch-notes'].forEach(id=>document.getElementById(id).value='');
  toast('✅ Chatter adicionado!');renderTeam(teamFilter);renderHome();
}
function saveShift(){
  const chatterId=document.getElementById('shift-chatter').value;
  const start=document.getElementById('shift-start').value;
  const end=document.getElementById('shift-end').value;
  const start2=document.getElementById('shift-start2').value||'';
  const end2=document.getElementById('shift-end2').value||'';
  const days=Array.from(document.querySelectorAll('#m-shift .chip[data-day].sel')).map(c=>c.dataset.day);
  const modelIds=Array.from(document.querySelectorAll('#m-shift .chip[data-model].sel')).map(c=>c.dataset.model);
  const folgaDia=Array.from(document.querySelectorAll('#m-shift .chip-folga.sel')).map(c=>c.dataset.folga).find(v=>v!==undefined)||'';
  const folgaDia2=Array.from(document.querySelectorAll('#m-shift .chip-folga2.sel')).map(c=>c.dataset.folga).find(v=>v!==undefined)||'';
  if(!chatterId||!start||!end||!days.length){toast('⚠️ Preencha chatter, 1º horário e dias');return;}
  const editId=document.getElementById('shift-edit-id').value;
  if(editId){
    const s=S.shifts.find(sh=>sh.id===editId);
    if(s){s.chatterId=chatterId;s.start=start;s.end=end;s.start2=start2;s.end2=end2;s.days=days;s.modelIds=modelIds;s.folgaDia=folgaDia;s.folgaDia2=folgaDia2;toast('✅ Turno atualizado!');}
  } else {
    S.shifts.push({id:'s'+Date.now(),chatterId,start,end,start2,end2,days,modelIds,folgaDia,folgaDia2});
    toast('✅ Turno adicionado!');
  }
  save();
  closeModal('m-shift');
  document.querySelectorAll('#m-shift .chip').forEach(c=>c.classList.remove('sel'));
  document.querySelectorAll('#m-shift .chip-folga').forEach(c=>c.classList.remove('sel'));
  document.querySelectorAll('#m-shift .chip-folga2').forEach(c=>c.classList.remove('sel'));
  document.getElementById('shift-edit-id').value='';
  document.getElementById('shift-modal-title').textContent='Escalar chatter';
  renderTurno();
  if(currentViewName()==='extra')renderExtra();
  // If a chatter profile is open, refresh its shift list
  renderChatterShifts(chatterId);
}
function openEditShift(shiftId){
  const s=S.shifts.find(sh=>sh.id===shiftId);
  if(!s)return;
  document.getElementById('shift-edit-id').value=s.id;
  openModal('m-shift');
  document.getElementById('shift-modal-title').textContent='Editar turno';
  setTimeout(()=>{
    document.getElementById('shift-chatter').value=s.chatterId;
    document.getElementById('shift-start').value=s.start||'';
    document.getElementById('shift-end').value=s.end||'';
    document.getElementById('shift-start2').value=s.start2||'';
    document.getElementById('shift-end2').value=s.end2||'';
    document.querySelectorAll('#m-shift .chip[data-day]').forEach(c=>c.classList.toggle('sel',(s.days||[]).includes(c.dataset.day)));
    document.querySelectorAll('#m-shift .chip[data-model]').forEach(c=>c.classList.toggle('sel',(s.modelIds||[]).includes(c.dataset.model)));
    document.querySelectorAll('#m-shift .chip-folga').forEach(c=>c.classList.toggle('sel',c.dataset.folga===(s.folgaDia||'')));
    document.querySelectorAll('#m-shift .chip-folga2').forEach(c=>c.classList.toggle('sel',c.dataset.folga===(s.folgaDia2||'')));
  },40);
}

/* ===========================================================
   TROCAS DE HORÁRIO
   Pontual: chatter A cobre o turno de B num dia específico.
   Aparece na escala daquele dia no lugar de B.
   =========================================================== */
function initSwapModal(){
  populateChatterSelects();
  ['swap-chatter-in','swap-chatter-out'].forEach(id=>{
    const el=document.getElementById(id);
    if(!el)return;
    el.innerHTML=S.chatters.length?S.chatters.map(c=>`<option value="${c.id}">${c.name}</option>`).join(''):'<option value="">Nenhum chatter</option>';
  });
  document.getElementById('swap-date').value=todayKey();
  document.querySelectorAll('#swap-type-chips .chip').forEach(chip=>{
    chip.onclick=()=>{
      document.querySelectorAll('#swap-type-chips .chip').forEach(c=>c.classList.remove('sel'));
      chip.classList.add('sel');
      const type=chip.dataset.swapType;
      document.getElementById('swap-pontual-fields').style.display=type==='pontual'?'block':'none';
      document.getElementById('swap-definitiva-fields').style.display=type==='definitiva'?'block':'none';
      document.getElementById('swap-btns').style.display=type==='pontual'?'flex':'none';
    };
  });
  document.getElementById('swap-chatter-out').onchange=updateSwapPreview;
  document.getElementById('swap-date').onchange=updateSwapPreview;
  updateSwapPreview();
}
function updateSwapPreview(){
  const chatterId=document.getElementById('swap-chatter-out')?.value;
  const date=document.getElementById('swap-date')?.value;
  const preview=document.getElementById('swap-shift-preview');
  if(!preview||!chatterId||!date)return;
  const d=new Date(date+'T12:00:00');
  const dayKey=DAY_KEYS[d.getDay()];
  const shifts=S.shifts.filter(s=>s.chatterId===chatterId&&s.days&&s.days.includes(dayKey));
  if(!shifts.length){
    preview.style.display='block';
    preview.textContent='Chatter nao tem turno nesse dia da semana';
    preview.style.color='var(--warn)';
  } else {
    const c=S.chatters.find(ch=>ch.id===chatterId);
    const timeStr=shifts.map(s=>s.start2&&s.end2?`${s.start}-${s.end} e ${s.start2}-${s.end2}`:`${s.start}-${s.end}`).join(', ');
    preview.style.display='block';
    preview.style.color='var(--text2)';
    preview.textContent=`Turno de ${c?c.name:'?'}: ${timeStr}`;
  }
}
function saveSwap(){
  const date=document.getElementById('swap-date').value;
  const covererId=document.getElementById('swap-chatter-in').value;
  const originalId=document.getElementById('swap-chatter-out').value;
  if(!date||!covererId||!originalId){toast('Preencha todos os campos');return;}
  if(covererId===originalId){toast('Selecione chatters diferentes');return;}
  const d=new Date(date+'T12:00:00');
  const dayKey=DAY_KEYS[d.getDay()];
  const shifts=S.shifts.filter(s=>s.chatterId===originalId&&s.days&&s.days.includes(dayKey));
  if(!shifts.length){toast('Chatter nao tem turno nesse dia');return;}
  S.swaps=S.swaps.filter(sw=>!(sw.date===date&&sw.originalId===originalId));
  shifts.forEach(s=>{
    S.swaps.push({id:'sw'+Date.now()+Math.random().toString(36).slice(2,5),date,covererId,originalId,start:s.start,end:s.end,start2:s.start2||'',end2:s.end2||'',shiftId:s.id,createdAt:todayKey()});
  });
  save();
  closeModal('m-swap');
  const coverer=S.chatters.find(c=>c.id===covererId);
  const original=S.chatters.find(c=>c.id===originalId);
  toast('Troca registrada: '+coverer.name+' cobre '+original.name+' em '+date);
  renderTurno();
}
function deleteSwap(swapId){S.swaps=S.swaps.filter(sw=>sw.id!==swapId);save();toast('Troca removida');renderTurno();}
function getEffectiveShiftsForDate(chatterId,dateKey){
  const d=new Date(dateKey+'T12:00:00');
  const dayKey=DAY_KEYS[d.getDay()];
  const gaveAway=S.swaps.filter(sw=>sw.date===dateKey&&sw.originalId===chatterId);
  let ownShifts=gaveAway.length?[]:S.shifts.filter(s=>s.chatterId===chatterId&&s.days&&s.days.includes(dayKey));
  const covered=S.swaps.filter(sw=>sw.date===dateKey&&sw.covererId===chatterId);
  const swapShifts=covered.map(sw=>({...(S.shifts.find(s=>s.id===sw.shiftId)||{}),id:sw.id,start:sw.start,end:sw.end,start2:sw.start2,end2:sw.end2,isSwap:true,swapOriginalId:sw.originalId}));
  return[...ownShifts,...swapShifts];
}

/* ===========================================================
   HORA EXTRA — separate from general revenue.
   Vagas are generated automatically from shifts that have a
   folgaDia set. Manager assigns a chatter + logs revenue per slot.
   =========================================================== */
function getHoraExtraVagas(){
  // Collect all shifts that have a folga day — each becomes an "available slot"
  const vagas=[];
  S.shifts.forEach(s=>{
    if(!s.folgaDia)return;
    const c=S.chatters.find(ch=>ch.id===s.chatterId);
    if(!c)return;
    // Slot 1: always the main shift time
    vagas.push({shiftId:s.id,chatterId:s.chatterId,chatterName:c.name,folgaDia:s.folgaDia,
      start:s.start,end:s.end,slotIdx:1,
      label:`${c.name} — ${s.folgaDia.toUpperCase()} (${s.start}–${s.end})`});
    // Slot 2: if second time exists
    if(s.start2&&s.end2){
      vagas.push({shiftId:s.id,chatterId:s.chatterId,chatterName:c.name,folgaDia:s.folgaDia,
        start:s.start2,end:s.end2,slotIdx:2,
        label:`${c.name} — ${s.folgaDia.toUpperCase()} (${s.start2}–${s.end2})`});
    }
  });
  return vagas.sort((a,b)=>a.folgaDia.localeCompare(b.folgaDia)||a.start.localeCompare(b.start));
}
function getExtraSlotId(shiftId,slotIdx){
  const wkey=getWeekKey();
  const slots=S.horaExtraSlots[wkey]||[];
  return slots.find(x=>x.shiftId===shiftId&&x.slotIdx===slotIdx);
}
function saveExtraSlot(shiftId,slotIdx,field,value){
  const wkey=getWeekKey();
  if(!S.horaExtraSlots[wkey])S.horaExtraSlots[wkey]=[];
  let slot=S.horaExtraSlots[wkey].find(x=>x.shiftId===shiftId&&x.slotIdx===slotIdx);
  if(!slot){
    slot={id:'ex'+Date.now(),shiftId,slotIdx,chatterId:'',revenue:0,done:false};
    S.horaExtraSlots[wkey].push(slot);
  }
  slot[field]=value;
  save();
  renderExtra();
}
function toggleExtraDone(shiftId,slotIdx){
  const wkey=getWeekKey();
  if(!S.horaExtraSlots[wkey])S.horaExtraSlots[wkey]=[];
  let slot=S.horaExtraSlots[wkey].find(x=>x.shiftId===shiftId&&x.slotIdx===slotIdx);
  if(!slot){slot={id:'ex'+Date.now(),shiftId,slotIdx,chatterId:'',revenue:0,done:true};S.horaExtraSlots[wkey].push(slot);}
  else slot.done=!slot.done;
  save();renderExtra();
}
/* ===========================================================
   RELATÓRIOS DA EQUIPE
   Parses reports sent by chatters (from external system) and
   cross-references with S.chatters, S.models, S.chatterWeekGoals
   to auto-fill revenue and show goal progress.
   Format expected:
     Data: DD/MM/YYYY
     Nome: [chatter name]
     [MODEL NAME]
     HH:MM - R$ XX,XX
     Total de comissões: R$ XX,XX
   =========================================================== */
// Remove acentos e caixa pra comparar nomes com tolerância — "Jose Martins"
// (sem acento, como às vezes vem no relatório colado) precisa casar com o
// chatter cadastrado como "José Martins".
function normalizeName(s){
  return (s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().trim();
}
// Categorias de venda "high ticket" reconhecidas quando a linha da venda
// vem com um link + rótulo no final (ex: "15:38 - R$ 800,00 - https://... - Personalizado").
const HT_TIPO_ICON={Personalizado:'🎨',Foto:'📸',Vídeo:'🎥',Mimo:'🎁'};
function normalizeHighTicketTipo(raw){
  const n=normalizeName(raw);
  if(n.startsWith('personaliz'))return'Personalizado';
  if(n.startsWith('foto'))return'Foto';
  if(n.startsWith('video'))return'Vídeo';
  if(n.startsWith('mimo'))return'Mimo';
  return(raw||'').trim();
}
function renderTeamReports(){
  // Just ensure the input area is visible — processing happens on button click
}

function parseTeamReports(){parseTeamReportsCore(false);}
function parseTeamReportsAsExtra(){parseTeamReportsCore(true);}
function parseTeamReportsCore(forceExtra){
  const raw=document.getElementById('teamreport-input').value.trim();
  if(!raw){document.getElementById('teamreport-results').innerHTML='<div style="color:var(--text3);font-size:13px;padding:8px 0">Cole o conteúdo antes de processar</div>';return;}

  // Parser tolerante: funciona com o relatório colado em várias linhas OU
  // tudo espremido numa linha só (comum quando se copia de certos apps de
  // chat, que colapsam as quebras de linha). Em vez de andar linha a linha,
  // busca os padrões (Data, Nome, Modelo, horário, vendas) direto no texto
  // inteiro, então não depende de onde as quebras de linha caem.
  const normalized=raw.replace(/\r/g,' ');
  const rawBlocks=normalized.split(/(?=Data\s*:\s*\d)/i).map(b=>b.trim()).filter(b=>b);
  const blocks=[];
  rawBlocks.forEach(text=>{
    const dateMatch=text.match(/Data\s*:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    const nameMatch=text.match(/Nome\s*:\s*((?:[A-ZÀ-Ú][a-zà-ÿ'.]+\s*)+)/);
    if(!dateMatch||!nameMatch)return;
    const dateRaw=dateMatch[1];
    const name=nameMatch[1].trim();
    const afterName=text.slice(nameMatch.index+nameMatch[0].length);
    const modelBlocks=[];
    // Cada bloco de modelo: NOME EM MAIÚSCULA (pode ter "-" e espaços) seguido,
    // em algum ponto, de "HH:MM às HH:MM" (o turno), depois vendas e o total.
    const modelRegex=/([A-ZÀ-Ú][A-ZÀ-Ú0-9\s-]*?)\s+(\d{2}:\d{2})\s+às\s+(\d{2}:\d{2})([\s\S]*?)(?=[A-ZÀ-Ú][A-ZÀ-Ú0-9\s-]*?\s+\d{2}:\d{2}\s+às\s+\d{2}:\d{2}|$)/g;
    let mm;
    while((mm=modelRegex.exec(afterName))!==null){
      const modelName=mm[1].trim();
      const shiftStart=mm[2],shiftEnd=mm[3];
      const body=mm[4];
      const sales=[],saleTimes=[],highTicketItems=[];
      const saleRegex=/(\d{2}:\d{2})\s*-\s*R\$\s*([\d.,]+)/g;
      const saleMatches=[];
      let sm;
      while((sm=saleRegex.exec(body))!==null){
        saleMatches.push({time:sm[1],valRaw:sm[2],idx:sm.index,endIdx:sm.index+sm[0].length});
      }
      const totalIdxInBody=body.search(/Total de comiss[õo]es/i);
      saleMatches.forEach((sMatch,i)=>{
        const val=parseFloat(sMatch.valRaw.replace(/\./g,'').replace(',','.'));
        if(!(val>0))return;
        sales.push(val);saleTimes.push(sMatch.time);
        // Vendas "high ticket" vêm com um link + categoria colados logo depois
        // do valor (ex: "- https://... - Personalizado"), antes da próxima
        // venda ou do "Total de comissões". Se achar essa marcação, guarda o
        // tipo (Personalizado/Foto/Vídeo/Mimo) pra análises e ranking.
        const nextIdx=i+1<saleMatches.length?saleMatches[i+1].idx:(totalIdxInBody>=0?totalIdxInBody:body.length);
        const tail=body.slice(sMatch.endIdx,nextIdx);
        const catMatch=tail.match(/\b(Personalizad[oa]s?|Fotos?|V[ií]deos?|Mimos?)\b/i);
        if(catMatch){
          const linkMatch=tail.match(/https?:\/\/\S+/);
          highTicketItems.push({time:sMatch.time,val,tipo:normalizeHighTicketTipo(catMatch[1]),link:linkMatch?linkMatch[0]:''});
        }
      });
      const totalMatch=body.match(/Total de comiss[õo]es\s*:\s*R\$\s*([\d.,]+)/i);
      const total=totalMatch?parseFloat(totalMatch[1].replace(/\./g,'').replace(',','.')):undefined;
      if(modelName)modelBlocks.push({name:modelName,sales,saleTimes,shiftStart,shiftEnd,total,highTicketItems});
    }
    blocks.push({dateRaw,name,modelBlocks,rawSales:[]});
  });

  if(!blocks.length){
    document.getElementById('teamreport-results').innerHTML='<div style="color:var(--warn);font-size:13px;padding:8px 0">⚠️ Nenhum relatório reconhecido. Verifique o formato.</div>';
    return;
  }

  const wkey=getWeekKey();
  const goals=S.chatterWeekGoals[wkey]||{};
  let exportLines=['📊 RELATÓRIOS DA EQUIPE — '+wkey,''];
  let totalEquipe=0;

  const resultsHtml=blocks.map(block=>{
    const chatter=S.chatters.find(c=>normalizeName(c.name)===normalizeName(block.name))||
      S.chatters.find(c=>normalizeName(block.name).includes(normalizeName(c.name).split(' ')[0]))||
      S.chatters.find(c=>normalizeName(c.name).includes(normalizeName(block.name).split(' ')[0]));

    let dateKey=todayKey();
    if(block.dateRaw){
      const parts=block.dateRaw.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      if(parts){
        const year=parts[3].length===2?'20'+parts[3]:parts[3];
        dateKey=`${year}-${parts[2].padStart(2,'0')}-${parts[1].padStart(2,'0')}`;
      }
    }

    let chatterTotal=0,extraTotal=0;
    let anyMerge=false; // true se o usuário escolheu SOMAR em algum conflito — funde com o que já existia em vez de substituir as métricas do dia
    const allSales=[];
    const allHighTicketItems=[];
    const modelResults=block.modelBlocks.map(mb=>{
      const total=mb.total||mb.sales.reduce((s,v)=>s+v,0);
      const isExtra=forceExtra||/hora extra/i.test(mb.name);
      if(isExtra)extraTotal+=total; else chatterTotal+=total;
      mb.sales.forEach((v,i)=>allSales.push({val:v,time:mb.saleTimes[i]||null,isExtra}));
      (mb.highTicketItems||[]).forEach(hti=>allHighTicketItems.push({...hti,model:mb.name.replace(/hora extra/gi,'').trim()}));

      const cleanName=mb.name.replace(/hora extra/gi,'').trim();
      // Try multiple matching strategies:
      // 1. Exact contains match
      // 2. Any word from report name matches model name
      // 3. Model name words appear in report name
      const words=cleanName.toLowerCase().split(/\s+/).filter(w=>w.length>2);
      const model=S.models.find(m=>{
        const mn=m.name.toLowerCase();
        const mwords=mn.split(/\s+/).filter(w=>w.length>2);
        return cleanName.toLowerCase().includes(mn)||
          mn.includes(cleanName.toLowerCase())||
          words.some(w=>mn.includes(w)||w.includes(mn))||
          mwords.some(w=>cleanName.toLowerCase().includes(w));
      });

      if(chatter&&model){
        if(isExtra){
          const wkeyLocal=getWeekKey();
          if(!S.horaExtraSlots[wkeyLocal])S.horaExtraSlots[wkeyLocal]=[];
          const slotId=`parsed_${chatter.id}_${model.id}_${dateKey}`;
          let slot=S.horaExtraSlots[wkeyLocal].find(x=>x.id===slotId);
          if(!slot){slot={id:slotId,shiftId:'parsed',slotIdx:0,chatterId:chatter.id,modelId:model.id,revenue:0,done:true,dateKey};S.horaExtraSlots[wkeyLocal].push(slot);}
          const existingExtra=parseFloat(slot.revenue)||0;
          if(existingExtra>0&&Math.abs(existingExtra-total)>0.01){
            const choice=prompt(`Já existe ${money(existingExtra)} de hora extra pra ${chatter.name} · ${model.name} em ${dateKey.split('-').reverse().join('/')}.\n\nEsse relatório novo é de ${money(total)}. O que fazer?\n\n1 = SOMAR (é outro turno extra do mesmo dia — ficará ${money(existingExtra+total)})\n2 = SUBSTITUIR (é o mesmo relatório de novo, corrigido)\n3 = Cancelar\n\nDigite 1, 2 ou 3:`);
            if(choice==='1'){slot.revenue=existingExtra+total;anyMerge=true;}
            else if(choice==='2'){slot.revenue=total;}
            else{
              const normalKeySkip=`${chatter.id}_${model.id}_${dateKey}`;
              return{name:mb.name,total:existingExtra,model,matched:!!model,isExtra,skipped:true};
            }
          } else {
            slot.revenue=total;
          }
          // Se esse mesmo dia+modelo+pessoa já tinha sido lançado como
          // faturamento NORMAL antes (ex: alguém processou no botão errado
          // da primeira vez), limpa o normal pra não ficar contando 2x.
          const normalKey=`${chatter.id}_${model.id}_${dateKey}`;
          if(S.revenues[normalKey])delete S.revenues[normalKey];
        } else {
          const key=`${chatter.id}_${model.id}_${dateKey}`;
          // Se esse mesmo dia+modelo+pessoa já tinha ido pra Hora Extra por
          // engano, tira de lá — o valor agora é faturamento normal.
          const wkeyLocal2=getWeekKey();
          const extraSlotId=`parsed_${chatter.id}_${model.id}_${dateKey}`;
          if(S.horaExtraSlots[wkeyLocal2])S.horaExtraSlots[wkeyLocal2]=S.horaExtraSlots[wkeyLocal2].filter(x=>x.id!==extraSlotId);
          const existing=parseFloat(S.revenues[key])||0;
          if(existing>0&&Math.abs(existing-total)>0.01){
            const choice=prompt(`Já existe ${money(existing)} para ${chatter.name} · ${model.name} em ${dateKey.split('-').reverse().join('/')}.\n\nEsse relatório novo é de ${money(total)}. O que fazer?\n\n1 = SOMAR (é outro turno do mesmo dia — ficará ${money(existing+total)})\n2 = SUBSTITUIR (é o mesmo relatório de novo, corrigido — troca pra ${money(total)})\n3 = Cancelar, não mexe em nada\n\nDigite 1, 2 ou 3:`);
            if(choice==='1'){
              S.revenues[key]=existing+total;
              anyMerge=true;
              return{name:mb.name,total:existing+total,model,matched:!!model,isExtra,summed:true};
            } else if(choice==='2'){
              S.revenues[key]=total;
            } else {
              return{name:mb.name,total:existing,model,matched:!!model,isExtra,skipped:true};
            }
          } else {
            S.revenues[key]=total;
          }
        }
      }
      return{name:mb.name,total,model,matched:!!model,isExtra};
    });

    // ---- Analytics ----
    // Ticket médio, high ticket e ritmo de vendas contam TODAS as vendas do
    // dia (normais + hora extra) — desempenho é desempenho, independente de
    // qual "caixinha" a venda cai pra fins de pagamento. Só a meta semanal
    // (chatterTotal x extraTotal) continua separada, porque isso sim tem
    // regra de pagamento diferente.
    const allSalesForMetrics=allSales;
    const combinedTotal=chatterTotal+extraTotal;
    const ticketMedio=allSalesForMetrics.length>0?combinedTotal/allSalesForMetrics.length:0;
    const HIGH_TICKET_MIN=300; // limiar fixo — vendas a partir desse valor dão 8% de bônus diário
    const highTicketSales=allSalesForMetrics.filter(s=>s.val>=HIGH_TICKET_MIN);
    const highTicketPct=allSalesForMetrics.length>0?Math.round((highTicketSales.length/allSalesForMetrics.length)*100):0;
    const highTicketTotal=highTicketSales.reduce((s,v)=>s+v.val,0); // valor exato em R$, não estimativa

    // Vendas por hora — usa a janela de turno "HH:MM às HH:MM" de TODOS os
    // blocos (normais e hora extra), já que o tempo trabalhado extra também
    // conta pro ritmo de vendas por hora.
    let shiftHours=0;
    block.modelBlocks.forEach(mb=>{
      if(mb.shiftStart&&mb.shiftEnd){
        const[h1,m1]=mb.shiftStart.split(':').map(Number);
        const[h2,m2]=mb.shiftEnd.split(':').map(Number);
        let endMins=h2*60+m2,startMins=h1*60+m1;
        if(endMins<startMins)endMins+=24*60;
        shiftHours+=(endMins-startMins)/60;
      }
    });
    if(!shiftHours)shiftHours=8; // fallback if no shift window found
    const vendasPorHora=shiftHours>0?Math.round((combinedTotal/shiftHours)*100)/100:0; // R$/hora

    // Tempo máximo sem venda (gap between sale times) — todos os blocos
    let maxGapMin=0;
    const saleTsAll=[];
    block.modelBlocks.forEach(mb=>{
      (mb.saleTimes||[]).forEach(t=>{const[h,m]=t.split(':').map(Number);saleTsAll.push(h*60+m);});
    });
    saleTsAll.sort((a,b)=>a-b);
    if(saleTsAll.length>1){
      for(let i=1;i<saleTsAll.length;i++){
        const gap=saleTsAll[i]-saleTsAll[i-1];
        if(gap>maxGapMin)maxGapMin=gap;
      }
    }

    // Save analytics to chatter ficha + update tech fields
    if(chatter){
      if(!S.chatterFichas[chatter.id])S.chatterFichas[chatter.id]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
      if(!S.chatterFichas[chatter.id].analytics)S.chatterFichas[chatter.id].analytics={};
      const a=S.chatterFichas[chatter.id].analytics;
      if(!a.weeklyData)a.weeklyData={};
      const prevDay=anyMerge?a.weeklyData[dateKey]:null;
      let dayEntry;
      if(prevDay){
        // Somando com um turno já processado nesse mesmo dia — junta as
        // vendas, refaz a média ponderada, soma horas/valores, e pega o
        // maior "tempo parado" entre os dois turnos.
        const combChatterTotal=prevDay.chatterTotal+chatterTotal;
        const combExtraTotal=prevDay.extraTotal+extraTotal;
        const combVendas=prevDay.totalVendas+allSalesForMetrics.length;
        const combRevenue=combChatterTotal+combExtraTotal;
        const combHtTotal=(prevDay.highTicketTotal||0)+highTicketTotal;
        dayEntry={
          ticketMedio:combVendas>0?combRevenue/combVendas:0,
          vendasPorHora:(prevDay.shiftHours+shiftHours)>0?Math.round((combRevenue/(prevDay.shiftHours+shiftHours))*100)/100:0,
          highTicketPct:combRevenue>0?Math.round((combHtTotal/combRevenue)*100):0,
          highTicketTotal:combHtTotal,
          maxGapMin:Math.max(prevDay.maxGapMin||0,maxGapMin),
          totalVendas:combVendas,
          chatterTotal:combChatterTotal,
          extraTotal:combExtraTotal,
          shiftHours:prevDay.shiftHours+shiftHours,
          saleTimes:[...(prevDay.saleTimes||[]),...saleTsAll].sort((x,y)=>x-y),
          highTicketItems:[...(prevDay.highTicketItems||[]),...allHighTicketItems],
        };
      } else {
        dayEntry={ticketMedio,vendasPorHora,highTicketPct,highTicketTotal,maxGapMin,totalVendas:allSalesForMetrics.length,chatterTotal,extraTotal,shiftHours,saleTimes:saleTsAll,highTicketItems:allHighTicketItems};
      }
      a.weeklyData[dateKey]=dayEntry;
      // Auto-fill ficha técnica from analytics
      const f=S.chatterFichas[chatter.id];
      // Valor/hora: 0.3=regular, 0.5=bom, 0.8=ótimo, 1+=excelente
      const scoreLabel=n=>n>=5?'Excelente':n>=4?'Ótimo':n>=3?'Bom':n>=2?'Regular':'Fraco';
      const convScore=vendasPorHora>=30?5:vendasPorHora>=20?4:vendasPorHora>=10?3:vendasPorHora>=5?2:1; // R$/hora scale
      const ticketScore=ticketMedio>=150?5:ticketMedio>=80?4:ticketMedio>=40?3:ticketMedio>=20?2:1;
      f.tech.conversao=scoreLabel(convScore);
      f.tech.ticket=scoreLabel(ticketScore);
    }

    totalEquipe+=chatterTotal;

    const meta=chatter?parseFloat(goals[chatter.id])||0:0;
    const weekRev=chatter?getChatterWeekRevenue(chatter.id):0;
    const pct=meta>0?Math.round((weekRev/meta)*100):null;
    const falta=meta>0?Math.max(0,meta-weekRev):0;

    exportLines.push(`👤 ${block.name}${block.dateRaw?' ('+block.dateRaw+')':''}`);
    modelResults.filter(mr=>forceExtra||!mr.isExtra).forEach(mr=>exportLines.push(`  ${mr.name}: ${money(mr.total)}`));
    if(chatterTotal>0)exportLines.push(`  Total: ${money(chatterTotal)} | Ticket médio: ${money(ticketMedio)} | High ticket: ${highTicketPct}% | Valor/hora: ${vendasPorHora}`);
    if(extraTotal>0)exportLines.push(`  ⚡ Hora extra: ${money(extraTotal)}`);
    if(meta>0)exportLines.push(`  Meta: ${money(meta)} | Atingido: ${money(weekRev)} (${pct}%)${falta>0?` | Falta: ${money(falta)}`:' ✅'}`);
    exportLines.push('');

    const matchColor=chatter?'var(--ok)':'var(--bad)';
    const notFoundMsg=!chatter?`<div style="background:#fff0f0;border-radius:7px;padding:8px 10px;margin-bottom:8px;font-size:12px;color:var(--bad)">
      ❌ "${block.name}" não encontrado na aba Equipe.<br>
      <strong>Chatters cadastrados:</strong> ${S.chatters.map(c=>c.name).join(', ')||'nenhum'}.<br>
      O nome no relatório precisa ser igual ao cadastrado.
    </div>`:'';
    return`<div style="background:var(--bg-soft);border-radius:10px;padding:13px;margin-bottom:10px;border-left:3px solid ${matchColor}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div>
          <div style="font-weight:700;font-size:14px">${block.name} ${chatter?'<span style="color:var(--ok);font-size:11px">✅ vinculado</span>':'<span style="color:var(--bad);font-size:11px">❌ não encontrado</span>'}</div>
          <div style="font-size:11.5px;color:var(--text3)">${block.dateRaw||dateKey}</div>
        </div>
        <div style="text-align:right">
          ${chatterTotal>0?`<div style="font-family:var(--font-mono);font-weight:800;font-size:15px;color:var(--ok)">${money(chatterTotal)}</div>`:''}
          ${extraTotal>0?`<div style="font-size:12px;color:var(--info)">⚡ ${money(extraTotal)}</div>`:''}
        </div>
      </div>
      ${notFoundMsg}
      ${modelResults.filter(mr=>forceExtra||!mr.isExtra).map(mr=>`
        <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12.5px;border-bottom:1px solid var(--line)">
          <span style="color:${mr.matched?'var(--text)':'var(--warn)'}">${mr.name}${!mr.matched?' ⚠️':''}</span>
          <span style="font-family:var(--font-mono);font-weight:700">${money(mr.total)}</span>
        </div>`).join('')}
      ${chatter&&chatterTotal>0?`<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin-top:10px">
        <div style="background:var(--bg);border-radius:7px;padding:7px;text-align:center">
          <div style="font-size:10px;color:var(--text3)">Ticket médio</div>
          <div style="font-size:13px;font-weight:700;font-family:var(--font-mono)">${money(ticketMedio)}</div>
        </div>
        <div style="background:var(--bg);border-radius:7px;padding:7px;text-align:center">
          <div style="font-size:10px;color:var(--text3)">High ticket</div>
          <div style="font-size:13px;font-weight:700;color:${highTicketPct>=30?'var(--ok)':'var(--warn)'}">${highTicketPct}%</div>
        </div>
        <div style="background:var(--bg);border-radius:7px;padding:7px;text-align:center">
          <div style="font-size:10px;color:var(--text3)">Valor/hora</div>
          <div style="font-size:13px;font-weight:700;color:${vendasPorHora>=20?'var(--ok)':vendasPorHora>=10?'var(--warn)':'var(--bad)'}">${money(vendasPorHora)}/h</div>
        </div>
        <div style="background:var(--bg);border-radius:7px;padding:7px;text-align:center">
          <div style="font-size:10px;color:var(--text3)">Maior gap</div>
          <div style="font-size:13px;font-weight:700;color:${maxGapMin>60?'var(--bad)':maxGapMin>30?'var(--warn)':'var(--ok)'}">${maxGapMin?maxGapMin+'min':'—'}</div>
        </div>
      </div>
      ${meta>0?`<div style="margin-top:10px">
        <div style="background:var(--line);border-radius:4px;height:6px;overflow:hidden;margin-bottom:4px">
          <div style="height:6px;border-radius:4px;background:${pct>=100?'var(--ok)':pct>=60?'var(--warn)':'var(--bad)'};width:${Math.min(100,pct||0)}%"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text3)">
          <span>${pct}% da meta semanal (${money(weekRev)} / ${money(meta)})</span>
          ${falta>0?`<span style="color:var(--bad)">falta ${money(falta)}</span>`:`<span style="color:var(--ok)">✅ batida!</span>`}
        </div>
      </div>`:''}`:''}
    </div>`;
  }).join('');

  save();

  // Collect unique dates from parsed blocks
  const parsedDates=[...new Set(blocks.map(b=>{
    if(!b.dateRaw)return null;
    const p=b.dateRaw.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if(!p)return null;
    const yr=p[3].length===2?'20'+p[3]:p[3];
    return`${yr}-${p[2].padStart(2,'0')}-${p[1].padStart(2,'0')}`;
  }).filter(Boolean))].sort();

  // Navigate faturamento to the most recent parsed date
  if(parsedDates.length){
    selectedFatDate=parsedDates[parsedDates.length-1];
    const picker=document.getElementById('fat-date-picker');
    if(picker)picker.value=selectedFatDate;
  }

  const safeRender=(fn,name)=>{try{fn();}catch(e){console.warn('renderError',name,e);}};
  safeRender(renderExtraProgress,'extra');
  safeRender(renderGestaoMissingReports,'missing-reports');
  const cv=currentViewName();
  _rts[cv]=0;
  safeRender(()=>renderView(cv),'current-view');

  exportLines.push(`TOTAL EQUIPE: ${money(totalEquipe)}`);

  const datesInfo=parsedDates.length?`<div style="margin-top:8px;font-size:12px;color:var(--text2)">
    📅 Dias processados: ${parsedDates.join(', ')}
    <button class="btn btn-ghost btn-xs" style="margin-left:8px" onclick="navTo('fat')">Ver no Faturamento →</button>
  </div>`:'';

  document.getElementById('teamreport-results').innerHTML=
    `<div style="font-size:12px;background:${forceExtra?'var(--info-soft)':'var(--ok-soft)'};border-radius:8px;padding:10px;margin-bottom:12px">
      ${forceExtra?'⚡':'✅'} <strong>${blocks.length} relatório(s) processado(s)</strong> — ${forceExtra?'dados salvos como HORA EXTRA (não contam como meta)':'dados salvos em faturamento, fichas e semana'}.
      ${datesInfo}
    </div>`+resultsHtml;
  const summaryEl=document.getElementById('teamreport-summary');
  const exportEl=document.getElementById('teamreport-export');
  if(summaryEl)summaryEl.style.display='block';
  if(exportEl)exportEl.value=exportLines.join('\n');

  toast(forceExtra?'⚡ Dados salvos como hora extra!':'✅ Dados salvos! Faturamento e fichas atualizados.',4000);
}

function copyTeamReport(){
  const ta=document.getElementById('teamreport-export');
  if(!ta)return;
  ta.select();ta.setSelectionRange(0,999999);
  try{document.execCommand('copy');toast('✅ Copiado!');}
  catch(e){if(navigator.clipboard)navigator.clipboard.writeText(ta.value).then(()=>toast('✅ Copiado!'));}
}

function openManualStatusModal(){
  const today=todayKey();
  const el=document.getElementById('manual-status-body');
  if(!el)return;
  el.innerHTML=S.chatters.map(c=>{
    const status=getChatterStatus(c.id,today);
    const isOn=status==='online'||status==='overtime';
    return`<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line)">
      <div>
        <div style="font-weight:700;font-size:13.5px">${c.name}</div>
        <div style="font-size:11.5px;color:${isOn?'var(--ok)':'var(--text3)'}">${isOn?'🟢 online':'⚫ offline'}</div>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-xs ${isOn?'btn-ghost':'btn-primary'}" onclick="doCheckin('${c.id}','in');openManualStatusModal()">Entrou</button>
        <button class="btn btn-xs ${isOn?'btn-danger':'btn-ghost'}" onclick="doCheckin('${c.id}','out');openManualStatusModal()">Saiu</button>
      </div>
    </div>`;
  }).join('');
}

/* ===========================================================
   GESTÃO — problems, demands, training,
   evolutions, prize, motivational, requests, schedules
   =========================================================== */


// ---- DAILY TASK LIST HELPER (problems + demandas) ----
function renderDailyList(storeKey,listId,badgeId){
  const el=document.getElementById(listId);
  if(!el)return;
  const items=Array.isArray(S[storeKey])?S[storeKey]:(S[storeKey][todayKey()]||[]);
  const badge=document.getElementById(badgeId);
  const pending=items.filter(x=>!x.done).length;
  if(badge)badge.textContent=pending>0?`${pending} pendente${pending>1?'s':''}` :'';
  if(!items.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Nenhum item</div>';return;}
  el.innerHTML=items.map(item=>`
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">
      <button onclick="toggleDailyItem('${storeKey}','${item.id}')" style="width:22px;height:22px;border-radius:5px;border:2px solid ${item.done?'var(--ok)':'var(--line)'};background:${item.done?'var(--ok)':'transparent'};cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:12px">${item.done?'<span style="color:#fff">✓</span>':''}</button>
      <span style="flex:1;font-size:13.5px;${item.done?'text-decoration:line-through;color:var(--text3)':''}">${item.text}</span>
      <button onclick="removeDailyItem('${storeKey}','${item.id}')" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:13px">✕</button>
    </div>`).join('');
}
function toggleDailyItem(store,id){
  let items=Array.isArray(S[store])?S[store]:(S[store][todayKey()]||[]);
  const item=items.find(x=>x.id===id);
  if(item)item.done=!item.done;
  save();renderGestao();
}
function removeDailyItem(store,id){
  if(Array.isArray(S[store])){S[store]=S[store].filter(x=>x.id!==id);}
  else{const t=todayKey();S[store][t]=(S[store][t]||[]).filter(x=>x.id!==id);}
  save();renderGestao();
}
function addEventAction(){
  const evInp=document.getElementById('event-input');
  const acInp=document.getElementById('action-input');
  const event=evInp?.value.trim();
  const action=acInp?.value.trim();
  if(!event){toast('⚠️ Descreva o que aconteceu');return;}
  if(!Array.isArray(S.problemsToday))S.problemsToday=[];
  S.problemsToday.push({id:'p'+Date.now(),event,action,date:todayKey()});
  evInp.value='';if(acInp)acInp.value='';
  save();renderEventActionList();
}
function deleteEventAction(id){
  S.problemsToday=(S.problemsToday||[]).filter(x=>x.id!==id);
  save();renderEventActionList();
}
function renderEventActionList(){
  const el=document.getElementById('daily-problems-list');
  if(!el)return;
  const list=(S.problemsToday||[]).slice().reverse();
  if(!list.length){el.innerHTML='<div style="font-size:12px;color:var(--text3);padding:4px 0">Nenhum registro ainda</div>';return;}
  el.innerHTML=list.map(x=>`<div class="eventaction-row" data-key="${x.id}" style="padding:8px 0;border-bottom:1px solid var(--line);touch-action:pan-y">
    <div style="display:flex;justify-content:space-between;gap:8px">
      <div style="font-size:13px;font-weight:600;flex:1">${x.event}</div>
      <button onclick="deleteEventAction('${x.id}')" style="background:none;border:none;color:var(--text3);cursor:pointer;flex-shrink:0">✕</button>
    </div>
    ${x.action?`<div style="font-size:12px;color:var(--ok);margin-top:2px">✅ ${x.action}</div>`:'<div style="font-size:11.5px;color:var(--text3);margin-top:2px;font-style:italic">sem ação registrada ainda</div>'}
    <div style="font-size:10px;color:var(--text3);margin-top:2px">${(x.date||'').split('-').reverse().join('/')}</div>
  </div>`).join('');
  attachSwipeToDelete(el,'.eventaction-row',id=>deleteEventAction(id),renderEventActionList);
}
function addDemanda(){
  const inp=document.getElementById('demandas-input');
  if(!inp)return;
  const text=inp?.value.trim();if(!text)return;
  const today=todayKey();
  if(!S.demandas[today])S.demandas[today]=[];
  S.demandas[today].push({id:'d'+Date.now(),text,done:false});
  inp.value='';save();renderGestao();
}

// ---- TREINAMENTO ----
function saveTraining(){
  const title=document.getElementById('train-title')?.value.trim();
  const date=document.getElementById('train-date')?.value;
  const script=document.getElementById('train-script')?.value.trim();
  if(!title||!date){toast('⚠️ Preencha título e data');return;}
  S.trainings.push({id:'tr'+Date.now(),title,date,days:[{day:1,script:script||''}]});
  save();closeModal('m-add-training');renderGestao();toast('✅ Treinamento criado!');
}
function renderTrainings(){
  const el=document.getElementById('training-list');
  if(!el)return;
  if(!S.trainings.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Nenhum treinamento. Use + novo acima.</div>';return;}
  el.innerHTML=S.trainings.map(t=>{
    const today=todayKey();
    const daysAgo=Math.floor((new Date(today)-new Date(t.date))/86400000);
    const currentDay=daysAgo>=0?daysAgo+1:null;
    const dayScript=currentDay?t.days.find(d=>d.day===currentDay)?.script||null:null;
    // O ciclo de Aquecimento Discord é recorrente (toda semana, Segunda a
    // Quinta — a Sexta já é o Treinamento em si), não um evento de UM dia só
    // — mostrar a data ISO crua (ex: 2026-07-27) dava a entender erradamente
    // que era um compromisso de dia único, então pra essa entrada específica
    // mostra a cadência em vez da data.
    const subtitle=t.autoRetention
      ?`Toda semana: Segunda a Sexta${currentDay?` · Dia ${currentDay}`:' · não iniciado'}`
      :`${t.date}${currentDay?` · Dia ${currentDay}`:' · não iniciado'}`;
    return`<div class="training-swipe-row" data-key="${t.id}" style="background:var(--warn-soft);border-radius:10px;padding:12px;margin-bottom:8px;border-left:3px solid var(--warn);touch-action:pan-y">
      <div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="toggleTrainingDetail('${t.id}')">
        <div>
          <div style="font-weight:700;font-size:14px">🎓 ${t.title}</div>
          <div style="font-size:11.5px;color:var(--text2)">${subtitle}</div>
        </div>
        <span style="font-size:11px;color:var(--warn)">▸</span>
      </div>
      <div id="train-detail-${t.id}" style="display:none;margin-top:10px">
        ${currentDay&&dayScript?`<div style="background:var(--bg-soft);border-radius:8px;padding:10px;font-size:13px;margin-bottom:8px"><strong>Roteiro do dia ${currentDay}:</strong><br>${dayScript}</div>`:''}
        ${currentDay&&!dayScript?`<div style="font-size:12.5px;color:var(--text3);margin-bottom:8px">Sem roteiro para o dia ${currentDay}. Adicione abaixo:</div>`:''}
        <textarea class="ftext" placeholder="Roteiro do dia ${currentDay||1}..." style="min-height:60px;font-size:12px" id="train-script-${t.id}"></textarea>
        <div style="display:flex;gap:6px;margin-top:6px">
          <button class="btn btn-soft btn-sm" onclick="saveTrainingDayScript('${t.id}',${currentDay||1})">💾 Salvar roteiro</button>
          <button class="btn btn-ghost btn-sm" onclick="deleteTraining('${t.id}')">Excluir</button>
        </div>
      </div>
    </div>`;
  }).join('');
  attachSwipeToDelete(el,'.training-swipe-row',id=>deleteTraining(id),renderTrainings);
}
function toggleTrainingDetail(id){const el=document.getElementById('train-detail-'+id);if(el)el.style.display=el.style.display==='none'?'block':'none';}
function saveTrainingDayScript(trainingId,day){
  const t=S.trainings.find(x=>x.id===trainingId);if(!t)return;
  const script=document.getElementById('train-script-'+trainingId)?.value.trim()||'';
  const existing=t.days.find(d=>d.day===day);
  if(existing)existing.script=script;else t.days.push({day,script});
  save();renderTrainings();toast('✅ Roteiro salvo!');
}
function deleteTraining(id){if(!confirm('Excluir treinamento?'))return;S.trainings=S.trainings.filter(t=>t.id!==id);save();renderGestao();}

// ---- EVOLUÇÕES SEMANAIS ----
function renderWeekEvolutions(){
  const el=document.getElementById('week-evolution-list');
  if(!el)return; // removed from UI
  const wkey=getWeekKey();
  const items=S.weekEvolutions[wkey]||[];
  if(!items.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Adicione itens de evolução. Ao fim da semana um aviso aparecerá para os não feitos.</div>';return;}
  el.innerHTML=items.map(item=>`
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">
      <button onclick="toggleEvolution('${item.id}')" style="width:26px;height:26px;border-radius:6px;border:2px solid ${item.done?'var(--ok)':item.missed?'var(--bad)':'var(--line)'};background:${item.done?'var(--ok)':item.missed?'var(--bad)':'transparent'};cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:13px">${item.done?'<span style="color:#fff">✓</span>':item.missed?'<span style="color:#fff">✕</span>':''}</button>
      <span style="flex:1;font-size:13.5px;color:${item.done?'var(--ok)':item.missed?'var(--bad)':'var(--text)'}">${item.label}</span>
      <button onclick="removeEvolution('${item.id}')" style="background:none;border:none;color:var(--text3);cursor:pointer">✕</button>
    </div>`).join('');
}
function toggleEvolution(id){
  const wkey=getWeekKey();
  const items=S.weekEvolutions[wkey]||[];
  const item=items.find(x=>x.id===id);if(!item)return;
  if(!item.done&&!item.missed){item.done=true;item.missed=false;}
  else if(item.done){item.done=false;item.missed=true;}
  else{item.done=false;item.missed=false;}
  save();renderWeekEvolutions();
}
function removeEvolution(id){const wkey=getWeekKey();S.weekEvolutions[wkey]=(S.weekEvolutions[wkey]||[]).filter(x=>x.id!==id);save();renderWeekEvolutions();}
function addWeekEvolution(){
  const label=prompt('Nome do item de evolução:');if(!label)return;
  const wkey=getWeekKey();
  if(!S.weekEvolutions[wkey])S.weekEvolutions[wkey]=[];
  S.weekEvolutions[wkey].push({id:'ev'+Date.now(),label,done:false,missed:false});
  save();renderWeekEvolutions();
}

// ---- PREMIAÇÃO ----
function renderPrizePanel(){
  const el=document.getElementById('prize-panel');if(!el)return;
  const wkey=getWeekKey();
  const prize=S.weekPrize[wkey]||{goal:'',winner:'',prize:''};
  el.innerHTML=`
    <div class="field"><label class="flabel">Objetivo da semana</label><input class="finput" id="prize-goal" value="${prize.goal||''}" placeholder="Ex: bater R$10k em equipe" onblur="savePrize()"></div>
    <div class="field"><label class="flabel">Prêmio</label><input class="finput" id="prize-prize" value="${prize.prize||''}" placeholder="Ex: R$50 bônus" onblur="savePrize()"></div>
    <div class="field"><label class="flabel">Vencedor (preencher ao fim da semana)</label>
      <select class="fselect" id="prize-winner" onchange="savePrize()">
        <option value="">— selecionar —</option>
        ${S.chatters.map(c=>`<option value="${c.id}" ${prize.winner===c.id?'selected':''}>${c.name}</option>`).join('')}
      </select>
    </div>
    ${prize.winner?`<div style="text-align:center;padding:10px;background:var(--ok-soft);border-radius:10px;font-size:15px;font-weight:800;color:var(--ok)">🏆 ${S.chatters.find(c=>c.id===prize.winner)?.name||'?'}</div>`:''}`;
}
function savePrize(){
  const wkey=getWeekKey();
  S.weekPrize[wkey]={
    goal:document.getElementById('prize-goal')?.value||'',
    prize:document.getElementById('prize-prize')?.value||'',
    winner:document.getElementById('prize-winner')?.value||''
  };save();
}

// ---- MOTIVACIONAL ----
function renderMotivacional(){
  const el=document.getElementById('motivational-panel');
  if(!el)return;
  const wkey=getWeekKey();
  if(!S.motivational[wkey])S.motivational[wkey]={idea:'',chatters:{}};
  const data=S.motivational[wkey];
  el.innerHTML=`
    <div class="field"><label class="flabel">💡 Ideia motivacional da semana (para a equipe toda)</label>
      <textarea class="ftext" id="motiv-idea" placeholder="Ex: esta semana o foco é energia e ritmo..." style="min-height:60px" onblur="saveMotivacional()">${data.idea||''}</textarea>
    </div>
    <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin:10px 0 8px">Dificuldades individuais</div>
    ${S.chatters.map(c=>{
      const cd=data.chatters[c.id]||{issue:'',help:''};
      return`<div style="background:var(--bg-soft);border-radius:9px;padding:10px;margin-bottom:8px">
        <div style="font-weight:700;font-size:13px;margin-bottom:7px">${c.name}</div>
        <div class="field"><label class="flabel">Dificuldade</label><input class="finput" id="motiv-issue-${c.id}" value="${cd.issue||''}" placeholder="O que está com dificuldade..." onblur="saveMotivacional()"></div>
        <div class="field"><label class="flabel">O que fiz pra ajudar</label><input class="finput" id="motiv-help-${c.id}" value="${cd.help||''}" placeholder="Ação tomada..." onblur="saveMotivacional()"></div>
      </div>`;
    }).join('')}`;
}
function saveMotivacional(){
  const wkey=getWeekKey();
  if(!S.motivational[wkey])S.motivational[wkey]={idea:'',chatters:{}};
  S.motivational[wkey].idea=document.getElementById('motiv-idea')?.value||'';
  S.chatters.forEach(c=>{
    S.motivational[wkey].chatters[c.id]={
      issue:document.getElementById('motiv-issue-'+c.id)?.value||'',
      help:document.getElementById('motiv-help-'+c.id)?.value||''
    };
  });save();
}

// ---- REQUISIÇÕES DE HORÁRIOS ----
function renderScheduleRequests(){
  const el=document.getElementById('schedule-requests-list');if(!el)return;
  const wkey=getWeekKey();
  const items=S.scheduleRequests[wkey]||[];
  if(!items.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Nenhuma requisição</div>';return;}
  el.innerHTML=items.map(item=>{
    const c=S.chatters.find(ch=>ch.id===item.chatterId);
    return`<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">
      <div style="flex:1"><span style="font-weight:700">${c?c.name:'?'}</span><span style="font-size:12px;color:var(--text2);margin-left:8px">${item.text}</span></div>
      <button onclick="removeScheduleRequest('${item.id}')" style="background:none;border:none;color:var(--text3);cursor:pointer">✕</button>
    </div>`;
  }).join('');
  // Populate chatter select
  const sel=document.getElementById('sched-req-chatter');
  if(sel&&!sel.options.length){sel.innerHTML=S.chatters.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');}
}
function addScheduleRequest(){
  const cid=document.getElementById('sched-req-chatter')?.value;
  const text=document.getElementById('sched-req-text')?.value.trim();
  if(!cid||!text)return;
  const wkey=getWeekKey();
  if(!S.scheduleRequests[wkey])S.scheduleRequests[wkey]=[];
  S.scheduleRequests[wkey].push({id:'sr'+Date.now(),chatterId:cid,text});
  document.getElementById('sched-req-text').value='';
  save();renderScheduleRequests();
}
function removeScheduleRequest(id){const wkey=getWeekKey();S.scheduleRequests[wkey]=(S.scheduleRequests[wkey]||[]).filter(x=>x.id!==id);save();renderScheduleRequests();}


/* ===========================================================
   FICHAS DOS CHATTERS — ficha seduct format with history
   =========================================================== */
/* ===========================================================
   ESTUDOS — personal development tracking with snapshots
   =========================================================== */

function setChatterTime(chatterId,time){
  const c=S.chatters.find(ch=>ch.id===chatterId);
  if(!c)return;
  c.time=time;
  // Virar Tester manualmente também exige aprovação da solicitação de
  // Afilhado antes de contar como Tester de fato (mesma regra do botão de
  // criar tester no Mapeamento) — só sai do quadro de pendente quando a
  // gestora aprovar em Solicitação de Afilhado.
  c.pendenteAprovacao=time==='tester';
  save();
  const basicoBtn=document.getElementById('dl-time-basico-'+chatterId);
  const testerBtn=document.getElementById('dl-time-tester-'+chatterId);
  if(basicoBtn){basicoBtn.style.borderColor=time==='basico'?'var(--info)':'var(--line)';basicoBtn.style.background=time==='basico'?'var(--info-soft)':'transparent';basicoBtn.style.color=time==='basico'?'var(--info)':'var(--text2)';}
  if(testerBtn){testerBtn.style.borderColor=time==='tester'?'var(--bad)':'var(--line)';testerBtn.style.background=time==='tester'?'var(--bad-soft)':'transparent';testerBtn.style.color=time==='tester'?'var(--bad)':'var(--text2)';}
  toast(`✅ ${c.name} → ${time==='tester'?'🧪 Tester (aguardando aprovação do padrinho)':'Time Base'}`);
  renderTeam(teamFilter);
  renderTesters();
}



function renderFichas(){
  renderWeekNav();
  const sel=document.getElementById('ficha-chatter-select');
  if(!sel)return;
  if(!S.chatters.length){
    document.getElementById('ficha-content').innerHTML='<div style="color:var(--text3);font-size:13px">Cadastre chatters na aba Equipe primeiro</div>';
    return;
  }
  sel.innerHTML=S.chatters.filter(c=>c.time!=='tester').map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
  renderFichaChatter(sel.value);
}
// Cruza os dados semanais (faturamento/ticket/valor-hora) e os snapshots de
// ficha para descrever, em texto, como foi a evolução do chatter — sempre
// respeitando a semana selecionada no navegador de semana (weekOffset).
function renderFichaCruzamento(chatterId){
  const f=S.chatterFichas[chatterId]||{};
  const analytics=f.analytics?.weeklyData||{};
  const c=S.chatters.find(ch=>ch.id===chatterId);
  if(!c)return'';
  const weekGroups={};
  Object.keys(analytics).forEach(dk=>{
    const d=new Date(dk+'T12:00:00');
    const wk=fmt(getMondayOfWeek(d));
    if(!weekGroups[wk])weekGroups[wk]={rev:0,tickets:[],vphs:[]};
    const a=analytics[dk];
    weekGroups[wk].rev+=a.chatterTotal||0;
    if(a.ticketMedio>0){weekGroups[wk].tickets.push(a.ticketMedio);weekGroups[wk].vphs.push(a.vendasPorHora||0);}
  });
  const weekKeysSorted=Object.keys(weekGroups).sort();
  if(!weekKeysSorted.length){
    return`<div class="panel" style="margin-top:14px;border:2px solid var(--info)">
      <div class="panel-head"><div class="panel-title">🔎 Evolução — cruzamento semanal</div></div>
      <div style="font-size:12.5px;color:var(--text3)">Ainda não há dados semanais suficientes para cruzar. Continue processando relatórios e salvando snapshots.</div>
    </div>`;
  }
  const avg=arr=>arr.length?arr.reduce((s,v)=>s+v,0)/arr.length:0;
  const curWk=getWeekKey(); // respeita a semana selecionada no topo
  const curIdx=weekKeysSorted.indexOf(curWk);
  const effIdx=curIdx!==-1?curIdx:weekKeysSorted.length-1;
  const thisWeek=weekGroups[weekKeysSorted[effIdx]];
  const prevWeek=effIdx>0?weekGroups[weekKeysSorted[effIdx-1]]:null;

  let narrative;
  if(!prevWeek){
    narrative=`Essa é a primeira semana com dados registrados para ${c.name.split(' ')[0]} — ainda não há semana anterior para comparar a evolução.`;
  } else {
    const revDiff=prevWeek.rev>0?Math.round((thisWeek.rev-prevWeek.rev)/prevWeek.rev*100):null;
    const ticketDiff=avg(prevWeek.tickets)>0?Math.round((avg(thisWeek.tickets)-avg(prevWeek.tickets))/avg(prevWeek.tickets)*100):null;
    const vphDiff=avg(prevWeek.vphs)>0?Math.round((avg(thisWeek.vphs)-avg(prevWeek.vphs))/avg(prevWeek.vphs)*100):null;
    const parts=[];
    if(revDiff!==null)parts.push(revDiff>=10?`o faturamento melhorou bastante (${money(thisWeek.rev)} contra ${money(prevWeek.rev)} da semana anterior)`:revDiff>=0?`o faturamento ficou estável, com leve alta (${money(thisWeek.rev)})`:revDiff>=-15?`o faturamento caiu um pouco (${money(thisWeek.rev)} contra ${money(prevWeek.rev)})`:`o faturamento caiu bastante (${money(thisWeek.rev)} contra ${money(prevWeek.rev)}) — vale uma conversa`);
    if(ticketDiff!==null)parts.push(ticketDiff>=10?'o ticket médio subiu de forma consistente':ticketDiff>=-10?'o ticket médio ficou estável':'o ticket médio caiu — vale reforçar a técnica de venda de valor mais alto');
    if(vphDiff!==null)parts.push(vphDiff>=10?'o valor por hora melhorou':vphDiff>=-10?'o valor por hora ficou parecido':'o valor por hora caiu — pode ser volume de leads ou abordagem');
    narrative=parts.length?`Cruzando as fichas semanais: ${parts.join('; ')}.`:'Ainda não há métricas suficientes nas duas semanas para uma comparação completa.';
  }

  // Cruzamento qualitativo — compara o snapshot mais antigo com o mais recente
  const hist=[...(f.history||[])].sort((a,b)=>a.date.localeCompare(b.date));
  let qualNote='';
  if(hist.length>=2){
    const first=hist[0],last=hist[hist.length-1];
    const changed=[];
    ['tech','behavior'].forEach(store=>{
      Object.keys(last[store]||{}).forEach(k=>{
        const beforeVal=first[store]?.[k];
        const afterVal=last[store]?.[k];
        if(beforeVal&&afterVal&&beforeVal!==afterVal)changed.push(`${k} passou de "${beforeVal}" para "${afterVal}"`);
      });
    });
    qualNote=changed.length?` Nas fichas registradas, ${changed.slice(0,3).join('; ')}.`:'';
  }

  return`<div class="panel" style="margin-top:14px;border:2px solid var(--info)">
    <div class="panel-head"><div class="panel-title">🔎 Evolução — cruzamento semanal</div></div>
    <div style="font-size:13px;color:var(--text);line-height:1.6">${narrative}${qualNote}</div>
  </div>`;
}
// Painéis colapsáveis da Ficha: todos começam fechados e só abrem ao
// clicar no cabeçalho. `id` precisa ser único por painel (ex: inclui o
// chatterId) pra não conflitar entre fichas diferentes já renderizadas.
function toggleFichaPanel(id){
  const body=document.getElementById('fpbody-'+id);
  const chev=document.getElementById('fpchev-'+id);
  if(!body)return;
  const willOpen=body.style.display==='none';
  body.style.display=willOpen?'block':'none';
  if(chev)chev.style.transform=willOpen?'rotate(90deg)':'rotate(0deg)';
}
function fichaAccordion(id,extraStyle,headHtml,bodyHtml){
  return `<div class="panel" style="${extraStyle||''}">
    <div class="panel-head" style="cursor:pointer;margin-bottom:0" onclick="if(event.target.closest('[data-noaccordion]'))return;toggleFichaPanel('${id}')">
      ${headHtml}
      <span id="fpchev-${id}" style="transition:transform .18s;display:inline-block;color:var(--text3);flex-shrink:0;padding-top:2px">▸</span>
    </div>
    <div id="fpbody-${id}" style="display:none;margin-top:13px">${bodyHtml}</div>
  </div>`;
}
// Gráfico de barras simples (sem lib externa, consistente com o resto do
// app) com o faturamento dia a dia da semana atual — substitui a antiga
// lista de números soltos por algo que dá pra bater o olho rapidinho.
function renderWeeklyPerformanceChart(chatterId){
  const f=S.chatterFichas[chatterId];
  const weekly=f&&f.analytics&&f.analytics.weeklyData||{};
  if(!Object.keys(weekly).length)return '<div style="color:var(--text3);font-size:12.5px">Sem dados dessa semana ainda</div>';
  const wd=getWeekDates(0);
  const DAY_SHORT={0:'Dom',1:'Seg',2:'Ter',3:'Qua',4:'Qui',5:'Sex',6:'Sáb'};
  const days=wd.map(d=>{
    const dk=fmt(d);
    const a=weekly[dk];
    const total=a?((a.chatterTotal||0)+(a.extraTotal||0)):0;
    return{dk,label:DAY_SHORT[d.getDay()],total,a};
  });
  const max=Math.max(1,...days.map(d=>d.total));
  const bars=days.map(d=>`
    <div style="display:flex;flex-direction:column;align-items:center;flex:1;gap:4px;min-width:0">
      <div style="font-size:9px;color:var(--text3);font-family:var(--font-mono);white-space:nowrap">${d.total>0?moneyShort(d.total):''}</div>
      <div style="width:100%;max-width:26px;height:90px;display:flex;align-items:flex-end;background:var(--bg-soft);border-radius:5px;overflow:hidden">
        <div style="width:100%;height:${Math.max(3,Math.round(d.total/max*100))}%;background:${d.total>0?'var(--accent)':'transparent'};border-radius:5px 5px 0 0"></div>
      </div>
      <div style="font-size:10px;color:var(--text3);font-weight:700">${d.label}</div>
    </div>`).join('');
  const weekTotal=days.reduce((s,d)=>s+d.total,0);
  const withTicket=days.filter(d=>d.a&&d.a.ticketMedio>0);
  const avgTicket=withTicket.length?withTicket.reduce((s,d)=>s+d.a.ticketMedio,0)/withTicket.length:0;
  // High ticket vendido essa semana, por tipo (Personalizado/Foto/Vídeo/Mimo) —
  // vem das vendas marcadas com link+categoria no relatório colado.
  const htTally={};
  days.forEach(d=>{
    (d.a&&d.a.highTicketItems||[]).forEach(item=>{
      if(!htTally[item.tipo])htTally[item.tipo]={count:0,total:0};
      htTally[item.tipo].count++;
      htTally[item.tipo].total+=item.val;
    });
  });
  const htEntries=Object.entries(htTally).sort((a,b)=>b[1].total-a[1].total);
  const htHtml=htEntries.length?`<div style="margin-top:10px">
    <div style="font-size:10px;color:var(--text3);margin-bottom:6px">💎 High ticket vendido essa semana</div>
    ${htEntries.map(([tipo,v])=>`<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12.5px;border-bottom:1px solid var(--line)">
      <span>${HT_TIPO_ICON[tipo]||'💎'} ${tipo}</span>
      <span style="font-family:var(--font-mono);font-weight:700">${v.count}x · ${money(v.total)}</span>
    </div>`).join('')}
  </div>`:'';
  return`
    <div style="display:flex;gap:6px;margin-bottom:12px">${bars}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div style="text-align:center;background:var(--bg-soft);border-radius:8px;padding:8px">
        <div style="font-size:9px;color:var(--text3)">Total da semana</div>
        <div style="font-size:14px;font-weight:800;font-family:var(--font-mono)">${moneyShort(weekTotal)}</div>
      </div>
      <div style="text-align:center;background:var(--bg-soft);border-radius:8px;padding:8px">
        <div style="font-size:9px;color:var(--text3)">Ticket médio</div>
        <div style="font-size:14px;font-weight:800;font-family:var(--font-mono)">${moneyShort(avgTicket)}</div>
      </div>
    </div>
    ${htHtml}`;
}
// Resumo do ChatLab pra Ficha individual — junta TODAS as análises já
// feitas dessa pessoa (não só a semana) e monta, sem IA nova nenhuma (só
// reaproveitando parseChatLabDashboard/tags que cada análise já salvou):
// maiores erros, pontos fortes/fracos, o que melhorou/piorou (metade mais
// antiga vs metade mais recente das análises) e um diagnóstico textual de
// evolução do atendimento em geral.
function chatlabResumoFichaHtml(cid){
  const todas=(S.chatlabAnalyses||[]).filter(a=>a.chatterId===cid).sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  if(!todas.length){
    return fichaAccordion('chatlabresumo-'+cid,'','<div class="panel-title">🧪 Resumo do ChatLab</div>',
      '<div style="font-size:12.5px;color:var(--text3)">Ainda não há conversas analisadas no ChatLab pra essa pessoa.</div>');
  }
  const meio=Math.floor(todas.length/2);
  const antigas=todas.slice(0,meio);
  const recentes=todas.slice(meio);

  const avgIgp=arr=>{const v=arr.filter(a=>a.igp!=null);return v.length?Math.round(v.reduce((s,a)=>s+a.igp,0)/v.length):null;};
  const igpTodas=avgIgp(todas);
  const igpAntigas=avgIgp(antigas);
  const igpRecentes=avgIgp(recentes);

  const catAvgsTodas=getChatLabCategoryAverages(todas);
  const catAvgsAntigas=antigas.length?getChatLabCategoryAverages(antigas):{};
  const catAvgsRecentes=getChatLabCategoryAverages(recentes);

  const catEntries=CHATLAB_CATEGORIAS.map(cat=>({label:cat.label,val:catAvgsTodas[cat.key]})).filter(c=>c.val!=null);
  const fortes=[...catEntries].sort((a,b)=>b.val-a.val).slice(0,2);
  const fracos=[...catEntries].sort((a,b)=>a.val-b.val).slice(0,2);

  const deltas=antigas.length?CHATLAB_CATEGORIAS.map(cat=>{
    const antes=catAvgsAntigas[cat.key],depois=catAvgsRecentes[cat.key];
    if(antes==null||depois==null)return null;
    return{label:cat.label,delta:depois-antes};
  }).filter(Boolean):[];
  const melhorou=[...deltas].sort((a,b)=>b.delta-a.delta).filter(d=>d.delta>0.3).slice(0,2);
  const piorou=[...deltas].sort((a,b)=>a.delta-b.delta).filter(d=>d.delta<-0.3).slice(0,2);

  const errosTally={};
  todas.forEach(a=>{if(a.tags?.principalErro)errosTally[a.tags.principalErro]=(errosTally[a.tags.principalErro]||0)+1;});
  const maioresErros=Object.entries(errosTally).sort((a,b)=>b[1]-a[1]).slice(0,3);

  const taggedTodas=todas.filter(a=>a.tags);
  const taxaConvTodas=taggedTodas.length?Math.round(taggedTodas.filter(a=>a.tags.converteu==='sim').length/taggedTodas.length*100):null;

  const nomeCurto=(S.chatters.find(c=>c.id===cid)?.name||'').split(' ')[0]||'';
  const partes=[];
  if(igpAntigas!=null&&igpRecentes!=null){
    const diff=igpRecentes-igpAntigas;
    if(diff>=5)partes.push(`o atendimento de ${nomeCurto} melhorou de forma consistente — o IGP médio foi de ${igpAntigas} para ${igpRecentes}`);
    else if(diff<=-5)partes.push(`o atendimento de ${nomeCurto} piorou — o IGP médio caiu de ${igpAntigas} para ${igpRecentes}`);
    else partes.push(`o atendimento de ${nomeCurto} está estável (IGP médio de ${igpAntigas} pra ${igpRecentes})`);
  } else if(igpTodas!=null){
    partes.push(`${nomeCurto} tem IGP médio de ${igpTodas} nas ${todas.length} análise${todas.length>1?'s':''} já feita${todas.length>1?'s':''}, ainda sem histórico suficiente pra comparar evolução`);
  }
  if(fortes.length)partes.push(`os pontos mais fortes são ${fortes.map(f=>f.label).join(' e ')}`);
  if(melhorou.length)partes.push(`o que mais melhorou foi ${melhorou.map(m=>m.label).join(' e ')}`);
  if(piorou.length)partes.push(`o que mais piorou foi ${piorou.map(m=>m.label).join(' e ')} — vale atenção`);
  if(maioresErros.length)partes.push(`o erro mais recorrente é "${maioresErros[0][0]}"${maioresErros[0][1]>1?` (apareceu ${maioresErros[0][1]}x)`:''}`);
  const diagnostico=partes.length?partes.join('; ')+'.':'Ainda não há dados suficientes pra montar um diagnóstico completo.';

  const catBox=(label,val,suffix)=>`<div style="background:var(--bg-soft);border-radius:8px;padding:8px 10px">
    <div style="font-size:9.5px;color:var(--text3);text-transform:uppercase">${label}</div>
    <div style="font-weight:800;font-family:var(--font-mono);font-size:14px">${val!=null?val+(suffix||''):'—'}</div>
  </div>`;

  const body=`
    <div style="font-size:13px;color:var(--text);line-height:1.6;background:var(--info-soft);border-radius:9px;padding:10px 12px;margin-bottom:12px">🩺 <strong>Diagnóstico de Evolução:</strong> ${diagnostico}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
      ${catBox('IGP médio (geral)',igpTodas)}
      ${catBox('Taxa de conversão',taxaConvTodas,'%')}
    </div>
    ${fortes.length?`<div style="margin-bottom:10px"><div style="font-size:11px;font-weight:700;color:var(--ok);text-transform:uppercase;margin-bottom:4px">💪 Pontos fortes</div>${fortes.map(f=>`<div style="font-size:12.5px;padding:3px 0">${f.label} — ${f.val.toFixed(1)}/10</div>`).join('')}</div>`:''}
    ${fracos.length?`<div style="margin-bottom:10px"><div style="font-size:11px;font-weight:700;color:var(--bad);text-transform:uppercase;margin-bottom:4px">⚠️ Pontos fracos</div>${fracos.map(f=>`<div style="font-size:12.5px;padding:3px 0">${f.label} — ${f.val.toFixed(1)}/10</div>`).join('')}</div>`:''}
    ${melhorou.length?`<div style="margin-bottom:10px"><div style="font-size:11px;font-weight:700;color:var(--ok);text-transform:uppercase;margin-bottom:4px">📈 O que melhorou</div>${melhorou.map(m=>`<div style="font-size:12.5px;padding:3px 0">${m.label} (+${m.delta.toFixed(1)})</div>`).join('')}</div>`:''}
    ${piorou.length?`<div style="margin-bottom:10px"><div style="font-size:11px;font-weight:700;color:var(--bad);text-transform:uppercase;margin-bottom:4px">📉 O que piorou</div>${piorou.map(m=>`<div style="font-size:12.5px;padding:3px 0">${m.label} (${m.delta.toFixed(1)})</div>`).join('')}</div>`:''}
    ${maioresErros.length?`<div><div style="font-size:11px;font-weight:700;color:var(--warn);text-transform:uppercase;margin-bottom:4px">🔴 Maiores erros</div>${maioresErros.map(([erro,n])=>`<div style="font-size:12.5px;padding:3px 0">${erro}${n>1?` <span style="color:var(--text3)">(${n}x)</span>`:''}</div>`).join('')}</div>`:''}
    <div style="font-size:10px;color:var(--text3);margin-top:10px">Baseado em ${todas.length} análise${todas.length>1?'s':''} do ChatLab já salva${todas.length>1?'s':''} — sem chamada nova de IA.</div>
  `;
  return fichaAccordion('chatlabresumo-'+cid,'','<div><div class="panel-title">🧪 Resumo do ChatLab</div><div class="panel-note">Erros, acertos, evolução e diagnóstico — direto das conversas já analisadas</div></div>',body);
}
function renderFichaChatter(chatterId){
  const el=document.getElementById('ficha-content');if(!el)return;
  const c=S.chatters.find(ch=>ch.id===chatterId);if(!c){el.innerHTML='';return;}
  if(!S.chatterFichas[chatterId])S.chatterFichas[chatterId]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
  const f=S.chatterFichas[chatterId];

  const txtField=(key,label,store,ph)=>`<div class="field">
    <label class="flabel">${label}</label>
    <textarea class="ftext" style="min-height:52px" placeholder="${ph||'Escreva uma observação...'}"
      onblur="saveFichaText('${chatterId}','${store}','${key}',this.value)">${(f[store]&&f[store][key])||''}</textarea>
  </div>`;

  const history=f.history||[];

  const falaInglesFicha=f.falaIngles||f.dadosPJ?.falaIngles||'';
  el.innerHTML=`
    <div style="background:var(--bg-soft);border-radius:12px;padding:14px;margin-bottom:12px">
      <div style="font-weight:800;font-size:16px;margin-bottom:4px">${c.name}</div>
      <div style="font-size:12px;color:var(--text3)">${c.level} · desde ${c.createdAt?c.createdAt.slice(0,10):'?'}${falaInglesFicha?` · 🗣️ ${falaInglesFicha}`:''}</div>
    </div>

    ${renderMapeamentoPanel(chatterId)}

    ${fichaAccordion('tech-'+chatterId,'','<div class="panel-title">⚡ Técnica</div>',`
      ${txtField('conversao','Conversão','tech','Como está a conversão? Pontos fortes e fracos...')}
      ${txtField('ticket','Ticket médio','tech','Observações sobre ticket e high ticket...')}
      ${txtField('resposta','Tempo de resposta','tech','Como está a agilidade nas respostas?')}
      ${txtField('evolucao','Evolução','tech','Como tem evoluído nas últimas semanas?')}
    `)}

    ${fichaAccordion('behavior-'+chatterId,'','<div class="panel-title">🧠 Comportamento</div>',`
      ${txtField('intensidade','Intensidade','behavior','Como está o nível de dedicação?')}
      ${txtField('comunicacao','Comunicação','behavior','Como se comunica com a gestão?')}
      ${txtField('comprometimento','Comprometimento','behavior','É pontual? Cumpre metas e combinados?')}
      ${txtField('energia','Energia','behavior','Como está o nível de energia e motivação?')}
    `)}

    ${fichaAccordion('potential-'+chatterId,'','<div class="panel-title">🚀 Potencial e Risco</div>',`
      ${txtField('potencial','Pontos fortes e potencial','potential','O que essa pessoa tem de melhor? Onde pode chegar?')}
      ${txtField('riscos','Pontos de atenção e riscos','risk','O que precisa melhorar? Quais riscos observados?')}
      ${txtField('proximos','Próximos passos','potential','O que vou trabalhar com essa pessoa?')}
    `)}

    ${renderChatObsPanel(chatterId)}

    ${fichaAccordion('relatorio-'+chatterId,'','<div><div class="panel-title">📊 Desempenho da semana</div><div class="panel-note">Gráfico gerado automaticamente</div></div>',
      renderWeeklyPerformanceChart(chatterId)
    )}

    ${renderOrientacaoPanel(chatterId)}

    ${chatlabResumoFichaHtml(chatterId)}

    ${renderFichaCruzamento(chatterId)}

    <button class="btn btn-primary btn-block" style="margin-top:4px" onclick="saveFichaSnapshot('${chatterId}')">💾 Salvar</button>
  `;
  attachMapeamentoSwipe(chatterId);
  attachOrientacaoSwipe(chatterId);
}
const CHAT_OBS_ITEMS=[
  ['chamouNome','Chamou o cliente pelo nome'],
  ['respondeuNaoLidas','Respondeu as mensagens não lidas'],
  ['tempoRespostaBom','Tempo de resposta bom'],
  ['checouConversao','Checou a conversão das últimas vendas'],
  ['analiseConversa','Analisou alguma conversa']
];
function ensureChatObsEntry(chatterId,dateKey){
  if(!S.chatObservacoes)S.chatObservacoes={};
  if(!S.chatObservacoes[chatterId])S.chatObservacoes[chatterId]={};
  if(!S.chatObservacoes[chatterId][dateKey]){
    const e={anotacao:''};
    CHAT_OBS_ITEMS.forEach(([k])=>e[k]=false);
    S.chatObservacoes[chatterId][dateKey]=e;
  }
  return S.chatObservacoes[chatterId][dateKey];
}
function saveChatObsCheck(chatterId,dateKey,field,val){
  const e=ensureChatObsEntry(chatterId,dateKey);
  e[field]=val;
  save();
}
function saveChatObsNote(chatterId,dateKey,val){
  const e=ensureChatObsEntry(chatterId,dateKey);
  e.anotacao=val;
  save();
}
function toggleChatObsHistory(chatterId){
  const div=document.getElementById('chatobs-hist-'+chatterId);
  if(!div)return;
  div.style.display=div.style.display==='none'?'block':'none';
}
function chatObsChecklistSummary(e){
  return CHAT_OBS_ITEMS.map(([k,label])=>`<span style="display:inline-block;margin:0 8px 4px 0;font-size:11px;color:${e[k]?'var(--ok)':'var(--text3)'}">${e[k]?'✅':'▫️'} ${label}</span>`).join('');
}
// Quadro "Observações de Chat": checklist diário de acompanhamento (lembrete do
// que avaliar em cada chatter todo dia) + histórico por dia dentro da ficha.
function renderChatObsPanel(chatterId){
  const dateKey=todayKey();
  const entry=ensureChatObsEntry(chatterId,dateKey);
  const all=(S.chatObservacoes[chatterId])||{};
  const pastDates=Object.keys(all).filter(d=>d!==dateKey).sort((a,b)=>b.localeCompare(a));
  const body=`
    <div style="font-size:11px;font-weight:700;color:var(--text3);margin-bottom:8px">HOJE · ${dateKey}</div>
    ${CHAT_OBS_ITEMS.map(([k,label])=>`
    <label style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;color:var(--text2)">
      <input type="checkbox" style="width:auto" ${entry[k]?'checked':''} onchange="saveChatObsCheck('${chatterId}','${dateKey}','${k}',this.checked)">${label}
    </label>`).join('')}
    <div class="field" style="margin-top:6px">
      <label class="flabel">Anotação do dia</label>
      <textarea class="ftext" style="min-height:52px" placeholder="O que se destacou hoje nas conversas desse chatter..."
        onblur="saveChatObsNote('${chatterId}','${dateKey}',this.value)">${entry.anotacao||''}</textarea>
    </div>
    ${pastDates.length?`
    <button data-noaccordion class="btn btn-ghost btn-xs" style="margin-top:4px" onclick="toggleChatObsHistory('${chatterId}')">📅 Ver histórico (${pastDates.length} ${pastDates.length===1?'dia':'dias'})</button>
    <div id="chatobs-hist-${chatterId}" style="display:none;margin-top:8px">
      ${pastDates.map(date=>{const e=all[date];return `
      <div style="padding:8px 0;border-bottom:1px solid var(--line)">
        <div style="font-weight:700;font-size:12px;color:var(--text3);margin-bottom:4px">${date}</div>
        <div style="margin-bottom:4px">${chatObsChecklistSummary(e)}</div>
        ${e.anotacao?`<div style="font-size:12.5px;color:var(--text2)">${e.anotacao}</div>`:''}
      </div>`;}).join('')}
    </div>`:''}
  `;
  return fichaAccordion('chatobs-'+chatterId,'','<div><div class="panel-title">💬 Observações de Chat</div><div class="panel-note">Checklist diário — o que avaliar hoje nesse chatter</div></div>',body);
}
/* ===========================================================
   MAPEAMENTO DE PERFORMANCE — entrevista guiada (roteiro fixo,
   perguntas conversacionais em 6 blocos, alguns com mais de uma
   pergunta) + gravação/transcrição + análise por IA.
   Gera perfil (Executor/Criativo/Líder/Analítico híbrido), scores de
   comunicação e inteligência emocional, motivadores, estilo de liderança
   ideal e um radar de 10 competências (0-10). Fica salvo na ficha do
   chatter em S.chatterFichas[chatterId].mapeamentoIA.
   =========================================================== */
let _mapRecognition=null;
let _mapMediaRecorder=null;
let _mapMediaStream=null;
let _mapRecording=false;

function openMapeamentoModal(chatterId){
  // chatterId pode ser null/undefined — nesse caso abre o modal "em branco"
  // pra permitir nomear a pessoa antes ou durante a gravação (a pedido da
  // gestora), em vez de exigir uma Ficha já existente pra começar.
  const c=chatterId?S.chatters.find(ch=>ch.id===chatterId):null;
  if(chatterId&&!c)return;
  window._mapeamentoChatterId=chatterId||null;
  const nameEl=document.getElementById('mapeamento-modal-name');
  if(nameEl)nameEl.value=c?c.name:'';
  const draft=(c&&S.chatterFichas[chatterId]&&S.chatterFichas[chatterId].mapeamentoDraftTranscript)||'';
  const ta=document.getElementById('mapeamento-transcript');
  if(ta)ta.value=draft;
  const st=document.getElementById('mapeamento-status');
  if(st)st.textContent='';
  const gerarBtn=document.getElementById('mapeamento-gerar-btn');
  if(gerarBtn){gerarBtn.disabled=!draft.trim();gerarBtn.textContent='🤖 Gerar Mapeamento com IA';}
  const recBtn=document.getElementById('mapeamento-rec-btn');
  if(recBtn)recBtn.textContent='🎙️ Iniciar gravação';
  openModal('m-mapeamento');
  if(nameEl&&!c)setTimeout(()=>nameEl.focus(),50);
}

// Garante que exista um chatterId associado ao mapeamento em andamento,
// lendo o nome digitado no campo (agora editável) do modal. Se ainda não
// havia um chatterId (mapeamento aberto "em branco", sem Ficha prévia),
// cria um chatter novo com esse nome. Se já havia um chatterId mas a pessoa
// mudou o nome no campo, renomeia o chatter existente. Assim dá pra nomear
// a pessoa antes OU durante a gravação, como pedido pela gestora.
function ensureMapeamentoChatterId(){
  const nameEl=document.getElementById('mapeamento-modal-name');
  const digitado=(nameEl?nameEl.value:'').trim();
  let chatterId=window._mapeamentoChatterId;
  if(chatterId){
    const c=S.chatters.find(ch=>ch.id===chatterId);
    if(c&&digitado&&c.name!==digitado){c.name=digitado;save();}
    return chatterId;
  }
  if(!digitado){
    toast('Digite o nome da pessoa antes de começar.');
    return null;
  }
  chatterId='c'+Date.now()+Math.random().toString(36).slice(2,4);
  S.chatters.push({id:chatterId,name:digitado,discord:'',level:'treinamento',time:'',notes:'Criado direto pelo Mapeamento de Performance.',watchtime:'',createdAt:new Date().toISOString()});
  window._mapeamentoChatterId=chatterId;
  save();
  return chatterId;
}

function toggleMapeamentoRecording(){
  if(_mapRecording)stopMapeamentoRecording();else startMapeamentoRecording();
}

function startMapeamentoRecording(){
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    toast('⚠️ Seu navegador não suporta gravação de áudio — cole a conversa manualmente no campo de texto.');
    return;
  }
  if(!ensureMapeamentoChatterId())return;
  navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{
    _mapMediaStream=stream;
    try{ _mapMediaRecorder=new MediaRecorder(stream); _mapMediaRecorder.start(); }catch(e){ console.warn('MediaRecorder indisponível',e); }
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    const ta=document.getElementById('mapeamento-transcript');
    if(SR&&ta){
      _mapRecognition=new SR();
      _mapRecognition.lang='pt-BR';
      _mapRecognition.continuous=true;
      _mapRecognition.interimResults=true;
      let baseText=ta.value;
      if(baseText&&!/\s$/.test(baseText))baseText+=' ';
      _mapRecognition.onresult=(ev)=>{
        let finalTxt='';let interimTxt='';
        for(let i=ev.resultIndex;i<ev.results.length;i++){
          const t=ev.results[i][0].transcript;
          if(ev.results[i].isFinal){
            // O reconhecimento de voz do navegador não pontua sozinho —
            // fecha cada trecho final com ponto e maiúscula (mesmo ajuste
            // do Mapeamento dos Novos, achado em 31/07/2026).
            let piece=(t||'').trim();
            if(piece){
              piece=piece.charAt(0).toUpperCase()+piece.slice(1);
              if(!/[.!?…]$/.test(piece))piece+='.';
              finalTxt+=piece+' ';
            }
          }else interimTxt+=t;
        }
        if(finalTxt){
          baseText+=finalTxt;
          // Salva a cada frase finalizada (não a cada palavra parcial) —
          // se a aba travar/recarregar no meio da gravação, o que já foi
          // dito não se perde mais, só o pedacinho ainda em andamento.
          const cid=window._mapeamentoChatterId;
          if(cid){
            if(!S.chatterFichas[cid])S.chatterFichas[cid]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
            S.chatterFichas[cid].mapeamentoDraftTranscript=baseText;
            save();
          }
        }
        ta.value=baseText+interimTxt;
      };
      _mapRecognition.onerror=(ev)=>console.warn('Erro no reconhecimento de voz',ev.error);
      _mapRecognition.onend=()=>{ if(_mapRecording){ try{_mapRecognition.start();}catch(e){} } }; // o navegador corta sessões longas sozinho — reinicia automaticamente enquanto estiver gravando
      try{_mapRecognition.start();}catch(e){console.warn(e);}
    } else {
      toast('⚠️ Transcrição automática não é suportada nesse navegador (funciona melhor no Chrome/Android) — grave normalmente e depois cole/edite o texto da conversa no campo abaixo.');
    }
    _mapRecording=true;
    const recBtn=document.getElementById('mapeamento-rec-btn');
    if(recBtn)recBtn.textContent='⏹️ Parar gravação';
    const st=document.getElementById('mapeamento-status');
    if(st)st.textContent='🔴 Gravando... fale perto do microfone.';
  }).catch(err=>{
    console.error(err);
    toast('⚠️ Não foi possível acessar o microfone. Verifique a permissão do navegador.');
  });
}

function stopMapeamentoRecording(silent){
  _mapRecording=false;
  if(_mapRecognition){ try{_mapRecognition.onend=null;_mapRecognition.stop();}catch(e){} _mapRecognition=null; }
  if(_mapMediaRecorder){ try{_mapMediaRecorder.stop();}catch(e){} _mapMediaRecorder=null; }
  if(_mapMediaStream){ try{_mapMediaStream.getTracks().forEach(t=>t.stop());}catch(e){} _mapMediaStream=null; }
  const recBtn=document.getElementById('mapeamento-rec-btn');
  if(recBtn)recBtn.textContent='🎙️ Iniciar gravação';
  const ta=document.getElementById('mapeamento-transcript');
  const st=document.getElementById('mapeamento-status');
  if(st&&!silent)st.textContent='⏸️ Gravação parada — revise o texto abaixo antes de gerar o mapeamento.';
  const gerarBtn=document.getElementById('mapeamento-gerar-btn');
  if(gerarBtn&&ta)gerarBtn.disabled=!ta.value.trim();
  const chatterId=window._mapeamentoChatterId;
  if(chatterId&&ta){
    if(!S.chatterFichas[chatterId])S.chatterFichas[chatterId]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
    S.chatterFichas[chatterId].mapeamentoDraftTranscript=ta.value;
    save();
  }
}

const MAPEAMENTO_SYSTEM=`Você é um psicólogo organizacional e analista de performance sênior, especialista em mapeamento comportamental de equipes de vendas/atendimento (chatters de OnlyFans/redes sociais). Você recebe a TRANSCRIÇÃO de uma entrevista conversacional guiada por 6 blocos (Vida pessoal, Autoridade, Motivação real, Como aprende de verdade, Personalidade e talento, Ambição) — poucas perguntas fáceis e abertas por bloco (alguns blocos têm mais de uma), de boa, tipo papo, mas cada uma pensada pra deixar a pessoa desenvolver naturalmente e revelar algo específico e difícil de fingir:
- Vida pessoal: dados básicos (idade, onde mora, com quem mora) e um resumo em estilo "sinopse de filme" da trajetória — o que já trabalhou, o que aprendeu e o que estava buscando até chegar aqui.
- Autoridade: que tipo de cobrança funciona com essa pessoa, o que a desmotiva, e também o que realmente a motivou ou marcou positivamente (não julgue só pelo que ela quer evitar).
- Motivação real: inclui uma pergunta hipotética ("se ganhasse na loteria, continuaria trabalhando?") que ajuda a distinguir motivação intrínseca de motivação puramente financeira, além do que a mantém dando o melhor em dias difíceis.
- Como aprende de verdade: como ela aprende algo novo na prática.
- Personalidade e talento: inclui um "Desafio GPT" opcional, onde a pessoa pode trazer uma descrição do próprio talento e uma metodologia de ensino/aprendizagem que ela mesma obteve conversando com uma IA — trate isso como um sinal rico de autoconhecimento e familiaridade com ferramentas de IA, não como resposta "menos genuína" por ter vindo de uma IA.
- Ambição: onde se imagina daqui a uns 2 anos e o que falta pra chegar lá.

Sua análise deve ser baseada PRINCIPALMENTE no CONTEÚDO literal do que a pessoa disse — o que ela contou, escolheu falar, priorizou e deixou de mencionar é a fonte principal de evidência. Sinais de tom de voz/emoção (segurança, hesitação, entusiasmo, ansiedade etc.) podem ser citados como detalhe secundário SE forem muito evidentes no texto transcrito, mas nunca como base principal de um julgamento nem para inventar estado emocional que o texto não sustenta — não exagere nem superinterprete emoção a partir de poucas palavras. Preste atenção especial às respostas sobre autoridade (pra preencher liderancaIdeal com precisão) e sobre motivação real, incluindo a resposta da pergunta da loteria (pra preencher comoMotivar e motivadores de forma específica, não genérica), sempre priorizando o que foi dito de fato sobre como foi dito.

IMPORTANTE — cuidado e sensibilidade na análise: essa pessoa está sendo avaliada de verdade pela liderança, então o mapeamento tem peso real sobre como ela vai ser tratada. Evite julgamentos genéricos, duros ou definitivos com base em pouca informação — uma entrevista curta não define uma pessoa por completo. Brevidade, nervosismo ou respostas mais tímidas NÃO são sinal automático de baixo potencial ou fraqueza — considere que entrevistas são situações de pressão e trate isso com contexto, não como defeito de personalidade. Busque nuance: quase ninguém é só uma coisa. Prefira descrever potencial e condições de sucesso ("funciona bem quando...") a rótulos negativos fechados ("é fraco em..."). Sempre que apontar um ponto de atenção, baseie-se em algo específico que a pessoa realmente disse ou demonstrou na transcrição — nunca em suposição ou estereótipo. O objetivo final é ajudar essa pessoa a crescer, não catalogá-la.

Responda SOMENTE com um objeto JSON válido (sem markdown, sem \`\`\`, sem nenhum texto antes ou depois), seguindo EXATAMENTE este formato:
{
  "personalidadeUmaFrase": "desafio: descreva a personalidade dessa pessoa em UMA ÚNICA FRASE curta, direta e específica — nada de clichê genérico tipo 'pessoa esforçada e comunicativa', tem que soar como algo que só se diria sobre ELA",
  "dadosPessoais": {
    "idade": "idade que a pessoa mencionou (ex: '24 anos') ou 'não informado' se não foi dito",
    "ondeMora": "cidade e/ou estado que a pessoa mencionou ou 'não informado' se não foi dito",
    "comQuemMora": "com quem a pessoa mora (ex: 'sozinha', 'com os pais', 'com o marido e um filho') ou 'não informado' se não foi dito",
    "sobre": "resumo curto (1-2 frases) de outras informações pessoais reais ditas na entrevista (ex: o que fazia antes, situação familiar, contexto de vida) — só o que foi realmente dito, nunca invente nem deduza além do que está na transcrição"
  },
  "resumoHistoria": "resumo objetivo em 2-4 frases, como se fosse a sinopse de um filme sobre a trajetória da pessoa: de onde veio, o que já trabalhou, o que aprendeu no caminho e o que estava buscando até chegar aqui",
  "respostaDesafioGpt": "se a pessoa fez o Desafio GPT (levou uma resposta de uma IA sobre o próprio talento/metodologia de aprendizagem), TRANSCREVA a resposta da IA de forma COMPLETA e LITERAL, exatamente como a pessoa contou na entrevista — NUNCA resuma, parafraseie ou corte, é um dos sinais mais relevantes do mapeamento. Se ela não fez o desafio ou não trouxe uma resposta de IA, use 'não fez o Desafio GPT'.",
  "comunicacao": (número de 0 a 100),
  "inteligenciaEmocional": (número de 0 a 100),
  "aprendizagem": "vendo" | "fazendo" | "ouvindo" | "repetindo" | "explorando",
  "perfis": [ {"tipo":"Executor"|"Criativo"|"Líder"|"Analítico","pct":(número)} ],
  "motivadores": ["até 3 motivadores ranqueados do maior pro menor, escolhidos entre: dinheiro, reconhecimento, competição, estabilidade, aprendizado, propósito, liberdade, status, crescimento, impacto, pertencimento"],
  "liderancaIdeal": {
    "estilo": "nome curto do estilo de liderança recomendado",
    "funcionaQuando": ["3 a 5 recomendações objetivas do que fazer com essa pessoa"],
    "evite": ["3 a 5 coisas a evitar com essa pessoa"]
  },
  "radar": {"Execução":(0-10),"Criatividade":(0-10),"Liderança":(0-10),"Comunicação":(0-10),"Autonomia":(0-10),"Disciplina":(0-10),"Inteligência emocional":(0-10),"Adaptabilidade":(0-10),"Resolução de problemas":(0-10),"Influência":(0-10)},
  "comoMotivar": "2-4 frases objetivas de como motivar essa pessoa no dia a dia",
  "comoLiderar": "2-4 frases de como liderar essa pessoa e que tipo de autoridade usar",
  "oQueNaoFazer": "2-4 frases do que evitar — o que desmotivaria essa pessoa"
}

O campo "perfis" deve ter 1 a 3 itens (perfis híbridos são comuns, ex: Executor 82% / Líder 18%), com a soma dos "pct" próxima de 100, ordenados do maior pro menor. Se a transcrição não trouxer informação suficiente para algum campo, use seu melhor julgamento clínico com base no que foi dito — nunca deixe um campo vazio, nulo ou fora do formato pedido.`;

async function gerarMapeamentoIA(){
  const ta=document.getElementById('mapeamento-transcript');
  const transcript=(ta?ta.value:'').trim();
  if(!transcript){toast('Grave ou cole a conversa antes de gerar o mapeamento.');return;}
  const chatterId=ensureMapeamentoChatterId();if(!chatterId)return;
  const c=S.chatters.find(ch=>ch.id===chatterId);if(!c)return;
  stopMapeamentoRecording(true);
  const btn=document.getElementById('mapeamento-gerar-btn');
  const st=document.getElementById('mapeamento-status');
  if(btn){btn.disabled=true;btn.textContent='🤖 Analisando...';}
  if(st)st.textContent='Enviando pra IA, isso pode levar alguns segundos...';
  try{
    const prompt=`Chatter: ${c.name} (nível: ${c.level})\n\nTranscrição da entrevista de mapeamento:\n\n${transcript}`;
    // max_tokens generoso: o JSON pedido é grande (radar de 10 competências,
    // 2 arrays de 3-5 itens, 4 campos de texto livre) e com um valor baixo
    // (2500) a resposta vinha sendo cortada no meio, quebrando o JSON.parse
    // mesmo com uma transcrição curta.
    const res=await fetch(AI_PROXY_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:6000,system:MAPEAMENTO_SYSTEM,messages:[{role:'user',content:prompt}]})
    });
    const data=await res.json();
    let text=data.content?.map(b=>b.type==='text'?b.text:'').join('')||'';
    if(!text)throw aiQuotaError(data)||new Error('Resposta vazia da IA');
    text=text.trim().replace(/^```json/i,'').replace(/^```/,'').replace(/```$/,'').trim();
    const jsonStart=text.indexOf('{');const jsonEnd=text.lastIndexOf('}');
    if(jsonStart===-1||jsonEnd===-1)throw new Error('A IA não retornou um JSON válido — tente gerar de novo.');
    let parsed;
    try{
      parsed=JSON.parse(text.slice(jsonStart,jsonEnd+1));
    }catch(parseErr){
      // Se a resposta foi cortada (ex: acabou o max_tokens no meio de um
      // array/objeto), o trecho entre a 1ª "{" e a última "}" não fecha
      // corretamente. Detecta esse caso pra dar um erro claro em vez de só
      // "JSON parse error", e sugere tentar de novo.
      const looksTruncated=data.stop_reason==='max_tokens'||jsonEnd<text.length-3;
      throw new Error(looksTruncated
        ?'A resposta da IA veio incompleta (cortada no meio). Tente gerar novamente — o texto gravado/colado continua salvo.'
        :'Não consegui interpretar o JSON da IA ('+parseErr.message+'). Tente gerar novamente.');
    }
    if(!S.chatterFichas[chatterId])S.chatterFichas[chatterId]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
    S.chatterFichas[chatterId].mapeamentoIA={...parsed,transcricao:transcript,date:todayKey()};
    delete S.chatterFichas[chatterId].mapeamentoDraftTranscript;
    save();
    toast('🎯 Mapeamento gerado!');
    closeModal('m-mapeamento');
    // Se o mapeamento criou um chatter novo (fluxo "nomear antes/durante a
    // gravação"), o <select> de Fichas ainda não tem essa opção — repopula
    // antes de selecionar, senão a Ficha some da tela até trocar de aba.
    renderFichas();
    const sel=document.getElementById('ficha-chatter-select');
    if(sel)sel.value=chatterId;
    renderFichaChatter(chatterId);
    renderTeam(typeof teamFilter!=='undefined'?teamFilter:'todos');
  }catch(e){
    console.error('Erro ao gerar mapeamento',e);
    // A transcrição já foi salva em mapeamentoDraftTranscript (stopMapeamentoRecording
    // no início da função) — então em QUALQUER erro, inclusive limite de uso da IA,
    // ela não se perde. Só avisa diferente quando for especificamente limite de uso.
    if(e.quota){
      toast('⏳ Limite de uso da IA no momento — sua transcrição já está salva.');
    }else{
      toast('⚠️ Erro ao gerar mapeamento: '+e.message+' — sua transcrição continua salva.');
    }
    window._mapLastErrQuota=!!e.quota;
    window._mapLastErrWait=e.waitSeconds;
    window._mapLastErrMsg=e.quota?'':e.message;
  }finally{
    if(btn){btn.disabled=false;btn.textContent='🤖 Gerar Mapeamento com IA';}
    if(window._mapLastErrQuota&&st){
      renderAIWaitCountdown('mapeamento-status',window._mapLastErrWait,{prefix:'⏳ Limite de uso da IA',suffix:'transcrição já está salva'});
    }else if(st){
      st.textContent=window._mapLastErrMsg?`⚠️ ${window._mapLastErrMsg} Sua transcrição está salva — feche e abra esse mapeamento de novo quando quiser tentar.`:'';
    }
    window._mapLastErrMsg=null;window._mapLastErrQuota=false;window._mapLastErrWait=null;
  }
}

// Excluir ou mover (trocar de pessoa) um mapeamento gerado/gravado no
// chatter errado. Acessado arrastando o card do Mapeamento pra direita,
// o que revela os botões "Excluir" e "Trocar pessoa" atrás do card.
function excluirMapeamentoIA(chatterId){
  const f=S.chatterFichas[chatterId];
  if(!f||!f.mapeamentoIA)return;
  if(!confirm('Excluir o mapeamento de performance dessa pessoa? Essa ação não pode ser desfeita.'))return;
  delete f.mapeamentoIA;
  save();
  toast('Mapeamento excluído');
  renderFichaChatter(chatterId);
}

/* ===========================================================
   ORIENTAÇÃO — planejamento assistido por IA de como aplicar uma
   orientação específica (material teórico + finalidade) numa pessoa,
   levando em conta o perfil dela (fichas técnica/comportamento/
   potencial/risco + Mapeamento de Performance, se já existir). Fica
   no lugar do antigo quadro "Histórico" na Ficha — o mecanismo de
   snapshot semanal (f.history) continua existindo por baixo, só não
   tem mais uma lista bruta exibida (a Evolução/cruzamento ainda usa).
   =========================================================== */
const ORIENTACAO_SYSTEM=`Você é uma consultora sênior de desenvolvimento de pessoas e liderança situacional, especialista em treinar chatters de operações de vendas por chat (atendimento/vendas de conteúdo adulto). Você recebe o perfil de UM chatter — observações técnicas, comportamentais, de potencial e de risco registradas na ficha dele, e opcionalmente um Mapeamento de Performance já feito por IA (perfil comportamental, motivadores, estilo de liderança ideal, radar de competências) — além da descrição do material teórico que a gestora vai mostrar pra essa pessoa e a finalidade dessa orientação.

Sua tarefa é dizer, de forma bem específica e prática, COMO aplicar essa orientação especificamente com ESSA pessoa (nunca uma orientação genérica) — de um jeito que a motive a melhorar e garanta que ela realmente entenda, usando o que se sabe do perfil dela a favor da conversa.

Responda SOMENTE com um objeto JSON válido (sem markdown, sem \`\`\`, sem nenhum texto antes ou depois), seguindo EXATAMENTE este formato:
{
  "abordagemSugerida": "3 a 5 frases de como conduzir a conversa com essa pessoa especificamente, considerando o perfil dela",
  "comoConectarComPerfil": "2 a 4 frases citando explicitamente traços do perfil (motivadores, estilo de liderança ideal, comportamento registrado) e como usar isso a favor dessa orientação",
  "roteiroSugerido": ["passo 1 objetivo", "passo 2", "passo 3"] (3 a 6 passos de como estruturar a apresentação do material teórico),
  "fraseDeAbertura": "uma sugestão de frase ou pergunta de abertura que já conecta com o que motiva essa pessoa",
  "oQueEvitar": "2 a 3 frases do que evitar especificamente com essa pessoa nessa conversa"
}

Se faltar informação de perfil (fichas vazias, sem mapeamento), diga isso dentro dos campos e dê recomendações mais genéricas mas ainda assim úteis — nunca deixe um campo vazio, nulo ou fora do formato pedido.`;

async function gerarOrientacaoIA(chatterId){
  const c=S.chatters.find(ch=>ch.id===chatterId);if(!c)return;
  const material=(document.getElementById('orient-material-'+chatterId)?.value||'').trim();
  const finalidade=(document.getElementById('orient-finalidade-'+chatterId)?.value||'').trim();
  if(!material||!finalidade){toast('⚠️ Descreva o material teórico e a finalidade antes de gerar.');return;}
  const btn=document.getElementById('orient-gerar-btn-'+chatterId);
  const st=document.getElementById('orient-status-'+chatterId);
  if(btn){btn.disabled=true;btn.textContent='🤖 Analisando...';}
  if(st)st.textContent='Enviando pra IA, isso pode levar alguns segundos...';
  try{
    const f=S.chatterFichas[chatterId]||{};
    let perfilTxt='';
    if(f.mapeamentoIA){
      const m=f.mapeamentoIA;
      perfilTxt+=`Mapeamento de Performance (IA):\n`+
        `Perfil: ${(m.perfis||[]).map(p=>`${p.tipo} ${p.pct}%`).join(', ')||'—'}\n`+
        `Motivadores: ${(m.motivadores||[]).join(', ')||'—'}\n`+
        `Estilo de liderança ideal: ${m.liderancaIdeal?.estilo||'—'}\n`+
        `Funciona quando: ${(m.liderancaIdeal?.funcionaQuando||[]).join('; ')||'—'}\n`+
        `Evite: ${(m.liderancaIdeal?.evite||[]).join('; ')||'—'}\n`+
        `Como motivar: ${m.comoMotivar||'—'}\n`+
        `Como liderar: ${m.comoLiderar||'—'}\n`+
        `O que não fazer: ${m.oQueNaoFazer||'—'}\n\n`;
    }
    const fichaTxt=['tech','behavior','potential','risk'].map(store=>{
      const entries=Object.entries(f[store]||{}).filter(([,v])=>v);
      if(!entries.length)return'';
      return`${store.toUpperCase()}:\n`+entries.map(([k,v])=>`- ${k}: ${v}`).join('\n');
    }).filter(Boolean).join('\n\n');
    const prompt=`Chatter: ${c.name} (nível: ${c.level})\n\n${perfilTxt}${fichaTxt||'Sem observações registradas na ficha ainda.'}\n\n---\nMaterial teórico que a gestora vai mostrar: ${material}\n\nFinalidade / o que ela quer alcançar com isso: ${finalidade}`;
    const res=await fetch(AI_PROXY_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:3500,system:ORIENTACAO_SYSTEM,messages:[{role:'user',content:prompt}]})
    });
    const data=await res.json();
    let text=data.content?.map(b=>b.type==='text'?b.text:'').join('')||'';
    if(!text)throw aiQuotaError(data)||new Error('Resposta vazia da IA');
    text=text.trim().replace(/^```json/i,'').replace(/^```/,'').replace(/```$/,'').trim();
    const jsonStart=text.indexOf('{');const jsonEnd=text.lastIndexOf('}');
    if(jsonStart===-1||jsonEnd===-1)throw new Error('A IA não retornou um JSON válido — tente gerar de novo.');
    let parsed;
    try{
      parsed=JSON.parse(text.slice(jsonStart,jsonEnd+1));
    }catch(parseErr){
      const looksTruncated=data.stop_reason==='max_tokens'||jsonEnd<text.length-3;
      throw new Error(looksTruncated
        ?'A resposta da IA veio incompleta (cortada no meio). Tente gerar novamente.'
        :'Não consegui interpretar o JSON da IA ('+parseErr.message+'). Tente gerar novamente.');
    }
    if(!S.chatterFichas[chatterId])S.chatterFichas[chatterId]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
    if(!S.chatterFichas[chatterId].orientacoes)S.chatterFichas[chatterId].orientacoes=[];
    S.chatterFichas[chatterId].orientacoes.push({id:'or'+Date.now(),date:todayKey(),material,finalidade,sugestao:parsed});
    save();
    toast('🎯 Orientação gerada!');
    renderFichaChatter(chatterId);
  }catch(e){
    console.error('Erro ao gerar orientação',e);
    // O material/finalidade digitados continuam no formulário (não recarrega
    // a página) — só o aviso muda quando é especificamente limite de uso da IA.
    if(e.quota){
      toast('⏳ Limite de uso da IA no momento — o que você escreveu continua no formulário.');
    }else{
      toast('⚠️ Erro ao gerar orientação: '+e.message);
    }
    const btn2=document.getElementById('orient-gerar-btn-'+chatterId);
    const st2=document.getElementById('orient-status-'+chatterId);
    if(btn2){btn2.disabled=false;btn2.textContent='🤖 Gerar orientação assertiva';}
    if(st2){
      if(e.quota)renderAIWaitCountdown('orient-status-'+chatterId,e.waitSeconds,{prefix:'⏳ Limite de uso da IA',suffix:'texto continua no formulário'});
      else st2.textContent='';
    }
  }
}
function excluirOrientacao(chatterId,orientId){
  const f=S.chatterFichas[chatterId];
  if(!f||!f.orientacoes)return;
  f.orientacoes=f.orientacoes.filter(o=>o.id!==orientId);
  save();
  toast('Orientação removida');
  renderFichaChatter(chatterId);
}
function orientacaoCardHtml(chatterId,o){
  const s=o.sugestao||{};
  const dateBR=o.date?o.date.split('-').reverse().join('/'):'';
  const scheduledBadge=o.scheduledDate?`<div style="margin-top:8px;font-size:11px;color:var(--ok);font-weight:700">📅 Agendado para ${o.scheduledDate.split('-').reverse().join('/')} às ${o.scheduledTime}</div>`:'';
  return`<div class="orient-card" data-key="${o.id}" style="background:var(--bg-soft);border-radius:10px;padding:12px;margin-bottom:10px;touch-action:pan-y">
    <div style="font-size:11px;color:var(--text3);margin-bottom:6px">${dateBR}</div>
    <div style="font-size:12.5px;margin-bottom:6px"><strong>Material:</strong> ${o.material}</div>
    <div style="font-size:12.5px;margin-bottom:6px"><strong>Finalidade:</strong> ${o.finalidade}</div>
    ${s.abordagemSugerida?`<div style="margin-top:8px"><div style="font-size:10.5px;font-weight:700;color:var(--text3)">ABORDAGEM SUGERIDA</div><div style="font-size:12.5px;color:var(--text2);margin-top:2px">${s.abordagemSugerida}</div></div>`:''}
    ${s.comoConectarComPerfil?`<div style="margin-top:8px"><div style="font-size:10.5px;font-weight:700;color:var(--text3)">COMO CONECTAR COM O PERFIL DELA</div><div style="font-size:12.5px;color:var(--text2);margin-top:2px">${s.comoConectarComPerfil}</div></div>`:''}
    ${s.fraseDeAbertura?`<div style="margin-top:8px"><div style="font-size:10.5px;font-weight:700;color:var(--text3)">FRASE DE ABERTURA</div><div style="font-size:12.5px;color:var(--accent);margin-top:2px;font-style:italic">"${s.fraseDeAbertura}"</div></div>`:''}
    ${Array.isArray(s.roteiroSugerido)&&s.roteiroSugerido.length?`<div style="margin-top:8px"><div style="font-size:10.5px;font-weight:700;color:var(--text3)">ROTEIRO</div><ol style="margin:4px 0 0 18px;padding:0;font-size:12.5px;color:var(--text2)">${s.roteiroSugerido.map(step=>`<li style="margin-bottom:3px">${step}</li>`).join('')}</ol></div>`:''}
    ${s.oQueEvitar?`<div style="margin-top:8px"><div style="font-size:10.5px;font-weight:700;color:var(--bad)">O QUE EVITAR</div><div style="font-size:12.5px;color:var(--text2);margin-top:2px">${s.oQueEvitar}</div></div>`:''}
    ${scheduledBadge}
    <button class="btn btn-ghost btn-xs" style="margin-top:8px" onclick="event.stopPropagation();toggleOrientSchedule('${o.id}')">📅 ${o.scheduledDate?'Reagendar':'Agendar horário'}</button>
    <div id="orient-schedule-${o.id}" style="display:none;gap:8px;margin-top:8px;align-items:center">
      <input type="date" class="finput" id="orient-sched-date-${o.id}" value="${o.scheduledDate||todayKey()}" style="flex:1">
      <input type="time" class="finput" id="orient-sched-time-${o.id}" value="${o.scheduledTime||''}" style="flex:1">
      <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();agendarOrientacao('${chatterId}','${o.id}')">OK</button>
    </div>
  </div>`;
}
function toggleOrientSchedule(orientId){
  const el=document.getElementById('orient-schedule-'+orientId);
  if(!el)return;
  el.style.display=el.style.display==='none'?'flex':'none';
}
// Agenda a orientação (data+horário) e reflete em 3 lugares que já existem no
// app: Agenda (S.orientations, aba "Agenda"), quadro da Semana (S.weekOrients)
// e alerta no painel Home (getSmartAlerts, via S.orientations com .time). Se
// já estava agendada antes, substitui o agendamento anterior em vez de duplicar.
function agendarOrientacao(chatterId,orientId){
  const f=S.chatterFichas[chatterId];
  const o=f&&f.orientacoes&&f.orientacoes.find(x=>x.id===orientId);
  if(!o)return;
  const date=document.getElementById('orient-sched-date-'+orientId)?.value;
  const time=document.getElementById('orient-sched-time-'+orientId)?.value;
  if(!date||!time){toast('⚠️ Escolha data e horário');return;}
  const label=o.material.length>60?o.material.slice(0,60)+'…':o.material;
  S.orientations=S.orientations.filter(x=>x.linkedOrientId!==orientId);
  S.weekOrients=S.weekOrients.filter(x=>x.linkedOrientId!==orientId);
  S.orientations.push({id:'o'+Date.now(),chatterId,text:label,date,time,shift:'',goal:'',linkedOrientId:orientId});
  S.weekOrients.push({id:'wo'+Date.now(),chatterId,text:label,done:false,doneWeek:null,date,time,linkedOrientId:orientId});
  o.scheduledDate=date;
  o.scheduledTime=time;
  save();
  toast('📅 Agendado! Já aparece na Agenda, no quadro da Semana e vai avisar no painel perto do horário.');
  renderFichaChatter(chatterId);
}
// Abre o "como aplicar" de uma orientação agendada (S.orientations) — clicado
// em Tarefas Diárias ou na Agenda. Se ela foi agendada a partir do 🤖 Gerar
// orientação assertiva (linkedOrientId aponta pra S.chatterFichas[].orientacoes),
// mostra a abordagem sugerida, roteiro, frase de abertura e o que evitar que a
// IA já gerou. Se foi criada como nota rápida (sem IA), mostra o texto simples
// e avisa que não tem esse roteiro pronto.
function openOrientView(orientId){
  const o=S.orientations.find(x=>x.id===orientId);
  if(!o){toast('⚠️ Essa orientação não existe mais — pode já ter sido concluída ou apagada.');return;}
  const c=S.chatters.find(ch=>ch.id===o.chatterId);
  const linked=o.linkedOrientId?(S.chatterFichas[o.chatterId]?.orientacoes||[]).find(x=>x.id===o.linkedOrientId):null;
  const el=document.getElementById('orient-view-body');
  if(!el)return;
  const dateBR=o.date?o.date.split('-').reverse().join('/'):'';
  const header=`<div style="margin-bottom:12px">
    <div style="font-weight:800;font-size:15px">${c?c.name:'?'}</div>
    <div style="font-size:12px;color:var(--text3)">${dateBR}${o.time?` · ⏰ ${o.time}`:''}</div>
  </div>`;
  let body;
  if(linked){
    const s=linked.sugestao||{};
    const hasSugestao=s.abordagemSugerida||s.comoConectarComPerfil||s.fraseDeAbertura||(Array.isArray(s.roteiroSugerido)&&s.roteiroSugerido.length)||s.oQueEvitar;
    body=`
      <div style="font-size:12.5px;margin-bottom:8px"><strong>Material:</strong> ${linked.material||'—'}</div>
      <div style="font-size:12.5px;margin-bottom:10px"><strong>Finalidade:</strong> ${linked.finalidade||'—'}</div>
      ${s.abordagemSugerida?`<div style="margin-top:8px"><div style="font-size:10.5px;font-weight:700;color:var(--text3)">ABORDAGEM SUGERIDA</div><div style="font-size:13px;color:var(--text2);margin-top:2px;line-height:1.55">${s.abordagemSugerida}</div></div>`:''}
      ${s.comoConectarComPerfil?`<div style="margin-top:10px"><div style="font-size:10.5px;font-weight:700;color:var(--text3)">COMO CONECTAR COM O PERFIL DELA</div><div style="font-size:13px;color:var(--text2);margin-top:2px;line-height:1.55">${s.comoConectarComPerfil}</div></div>`:''}
      ${s.fraseDeAbertura?`<div style="margin-top:10px"><div style="font-size:10.5px;font-weight:700;color:var(--text3)">FRASE DE ABERTURA</div><div style="font-size:13px;color:var(--accent);margin-top:2px;font-style:italic">"${s.fraseDeAbertura}"</div></div>`:''}
      ${Array.isArray(s.roteiroSugerido)&&s.roteiroSugerido.length?`<div style="margin-top:10px"><div style="font-size:10.5px;font-weight:700;color:var(--text3)">ROTEIRO</div><ol style="margin:4px 0 0 18px;padding:0;font-size:13px;color:var(--text2);line-height:1.6">${s.roteiroSugerido.map(step=>`<li style="margin-bottom:4px">${step}</li>`).join('')}</ol></div>`:''}
      ${s.oQueEvitar?`<div style="margin-top:10px"><div style="font-size:10.5px;font-weight:700;color:var(--bad)">O QUE EVITAR</div><div style="font-size:13px;color:var(--text2);margin-top:2px;line-height:1.55">${s.oQueEvitar}</div></div>`:''}
      ${!hasSugestao?'<div style="font-size:12.5px;color:var(--text3);margin-top:10px">Essa orientação ainda não tem a sugestão da IA de como aplicar — abra a Ficha dessa pessoa e gere pelo botão 🤖 Gerar orientação assertiva.</div>':''}
    `;
  } else {
    body=`
      <div style="font-size:12.5px;margin-bottom:8px">${o.text}</div>
      ${o.goal?`<div style="font-size:12.5px;color:var(--ok);font-family:var(--font-mono)">meta: ${money(parseFloat(o.goal))}</div>`:''}
      <div style="font-size:12px;color:var(--text3);margin-top:10px">Essa orientação foi criada direto na Agenda (sem IA) — não tem um roteiro de "como aplicar". Pra ter isso, crie a orientação pela Ficha da pessoa usando o 🤖 Gerar orientação assertiva.</div>
    `;
  }
  el.innerHTML=header+body+`<button class="btn ${o.done?'btn-ghost':'btn-primary'} btn-block" style="margin-top:14px" onclick="toggleOrientationDone('${o.id}');closeModal('m-orient-view');">${o.done?'↺ Desmarcar como feita':'✓ Marcar como feita'}</button>`;
  openModal('m-orient-view');
}
function renderOrientacaoPanel(chatterId){
  const f=S.chatterFichas[chatterId]||{};
  const list=(f.orientacoes||[]).slice().reverse();
  const body=`
    <div class="field">
      <label class="flabel">Material teórico que vou mostrar</label>
      <textarea class="ftext" id="orient-material-${chatterId}" placeholder="Descreva exatamente o que você vai apresentar (ex: vídeo sobre upsell, texto sobre gatilhos de urgência...)"></textarea>
    </div>
    <div class="field">
      <label class="flabel">Finalidade — o que você quer alcançar com isso</label>
      <textarea class="ftext" id="orient-finalidade-${chatterId}" placeholder="Por que está mostrando isso agora e o que espera que mude..."></textarea>
    </div>
    <button class="btn btn-primary btn-block" id="orient-gerar-btn-${chatterId}" onclick="gerarOrientacaoIA('${chatterId}')">🤖 Gerar orientação assertiva</button>
    <div id="orient-status-${chatterId}" style="font-size:11.5px;color:var(--text3);text-align:center;margin-top:6px"></div>
    ${list.length?`<div style="margin-top:16px">
      <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Orientações já planejadas</div>
      ${list.map(o=>orientacaoCardHtml(chatterId,o)).join('')}
    </div>`:''}
  `;
  return fichaAccordion('orientacao-'+chatterId,'','<div><div class="panel-title">🎯 Orientação</div><div class="panel-note">Planeje com a IA como aplicar essa orientação de forma assertiva pra essa pessoa</div></div>',body);
}
function attachOrientacaoSwipe(chatterId){
  const container=document.getElementById('ficha-content');
  if(!container)return;
  attachSwipeToDelete(container,'.orient-card',id=>excluirOrientacao(chatterId,id),()=>renderFichaChatter(chatterId));
}

/* ===========================================================
   MAPEAMENTO DE TRIAGEM — diferente do Mapeamento de Performance
   (que analisa 1 chatter já contratado com roteiro de 11 perguntas).
   Esse aqui é usado numa CALL EM GRUPO com vários candidatos ainda não
   contratados: você fala o nome de cada um e pergunta onde mora, o que
   faz, se conhece o mercado e a pretensão salarial. A IA transcreve tudo
   de uma vez e separa por pessoa, com foco em risco/potencial de
   contratação (não em desenvolvimento de quem já está no time).
   Perfis gerados ficam numa pool (S.triagemCandidatos) até serem
   vinculados a um tester — aí viram S.chatterFichas[id].triagemIA.
   Se o tester for efetivado, a triagem some (substituída, no tempo, pelo
   Mapeamento de Performance de verdade, feito já como chatter contratado).
   =========================================================== */
let _triRecognition=null;
let _triMediaRecorder=null;
let _triMediaStream=null;
let _triRecording=false;

function openTriagemModal(){
  const ta=document.getElementById('triagem-transcript');
  if(ta)ta.value=S.triagemDraftTranscript||'';
  const st=document.getElementById('triagem-status');
  if(st)st.textContent='';
  const gerarBtn=document.getElementById('triagem-gerar-btn');
  if(gerarBtn){gerarBtn.disabled=!(S.triagemDraftTranscript||'').trim();gerarBtn.textContent='🤖 Gerar perfis com IA';}
  const recBtn=document.getElementById('triagem-rec-btn');
  if(recBtn)recBtn.textContent='🎙️ Iniciar gravação';
  openModal('m-triagem');
}

function toggleTriagemRecording(){
  if(_triRecording)stopTriagemRecording();else startTriagemRecording();
}

function startTriagemRecording(){
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    toast('⚠️ Seu navegador não suporta gravação de áudio — cole a conversa manualmente no campo de texto.');
    return;
  }
  navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{
    _triMediaStream=stream;
    try{ _triMediaRecorder=new MediaRecorder(stream); _triMediaRecorder.start(); }catch(e){ console.warn('MediaRecorder indisponível',e); }
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    const ta=document.getElementById('triagem-transcript');
    if(SR&&ta){
      _triRecognition=new SR();
      _triRecognition.lang='pt-BR';
      _triRecognition.continuous=true;
      _triRecognition.interimResults=true;
      let baseText=ta.value;
      if(baseText&&!/\s$/.test(baseText))baseText+=' ';
      _triRecognition.onresult=(ev)=>{
        let finalTxt='';let interimTxt='';
        for(let i=ev.resultIndex;i<ev.results.length;i++){
          const t=ev.results[i][0].transcript;
          if(ev.results[i].isFinal){
            // Mesmo ajuste de pontuação do Mapeamento (achado em 31/07/2026).
            let piece=(t||'').trim();
            if(piece){
              piece=piece.charAt(0).toUpperCase()+piece.slice(1);
              if(!/[.!?…]$/.test(piece))piece+='.';
              finalTxt+=piece+' ';
            }
          }else interimTxt+=t;
        }
        if(finalTxt){
          baseText+=finalTxt;
          // Mesma lógica do Mapeamento — salva a cada frase finalizada, não
          // só quando clica em Parar, pra sobreviver a crash/reload no meio.
          S.triagemDraftTranscript=baseText;
          save();
        }
        ta.value=baseText+interimTxt;
      };
      _triRecognition.onerror=(ev)=>console.warn('Erro no reconhecimento de voz',ev.error);
      _triRecognition.onend=()=>{ if(_triRecording){ try{_triRecognition.start();}catch(e){} } };
      try{_triRecognition.start();}catch(e){console.warn(e);}
    } else {
      toast('⚠️ Transcrição automática não é suportada nesse navegador (funciona melhor no Chrome/Android) — grave normalmente e depois cole/edite o texto da conversa no campo abaixo.');
    }
    _triRecording=true;
    const recBtn=document.getElementById('triagem-rec-btn');
    if(recBtn)recBtn.textContent='⏹️ Parar gravação';
    const st=document.getElementById('triagem-status');
    if(st)st.textContent='🔴 Gravando... diga o nome de cada pessoa antes de perguntar.';
  }).catch(err=>{
    console.error(err);
    toast('⚠️ Não foi possível acessar o microfone. Verifique a permissão do navegador.');
  });
}

function stopTriagemRecording(silent){
  _triRecording=false;
  if(_triRecognition){ try{_triRecognition.onend=null;_triRecognition.stop();}catch(e){} _triRecognition=null; }
  if(_triMediaRecorder){ try{_triMediaRecorder.stop();}catch(e){} _triMediaRecorder=null; }
  if(_triMediaStream){ try{_triMediaStream.getTracks().forEach(t=>t.stop());}catch(e){} _triMediaStream=null; }
  const recBtn=document.getElementById('triagem-rec-btn');
  if(recBtn)recBtn.textContent='🎙️ Iniciar gravação';
  const ta=document.getElementById('triagem-transcript');
  const st=document.getElementById('triagem-status');
  if(st&&!silent)st.textContent='⏸️ Gravação parada — revise o texto abaixo antes de gerar os perfis.';
  const gerarBtn=document.getElementById('triagem-gerar-btn');
  if(gerarBtn&&ta)gerarBtn.disabled=!ta.value.trim();
  if(ta){S.triagemDraftTranscript=ta.value;save();}
}

const TRIAGEM_SYSTEM=`Você é um recrutador sênior especialista em triagem de candidatos para vagas de chatter/atendimento em redes sociais (OnlyFans). Você recebe a TRANSCRIÇÃO de uma call em grupo, onde o recrutador fala com VÁRIAS pessoas diferentes, uma de cada vez, geralmente dizendo o nome da pessoa antes de perguntar: onde mora, o que faz, se conhece o mercado, e pretensão salarial.

Sua tarefa é separar a transcrição POR PESSOA (usando os nomes citados como referência) e, para cada uma, montar um perfil de triagem focado em risco de contratação — isso é DIFERENTE de uma análise de desenvolvimento de alguém que já está no time: aqui o objetivo é decidir quem vale a pena colocar pra testar.

Responda SOMENTE com um objeto JSON válido (sem markdown, sem \`\`\`, sem nenhum texto antes ou depois), seguindo EXATAMENTE este formato:
{
  "candidatos": [
    {
      "nome": "nome da pessoa como foi dito na conversa",
      "ondeMora": "cidade/estado mencionados, ou 'não informado'",
      "oQueFaz": "resumo objetivo da ocupação/situação atual dela",
      "conheceMercado": "não conhece" | "conhece pouco" | "conhece bem" | "já trabalhou no mercado",
      "pretensaoSalarial": "valor/faixa mencionada, ou 'não informado'",
      "padraoFala": "resumo curto (1 frase) do jeito de falar: direto, enrolado, confiante, inseguro, animado, monótono etc — baseado em como ela respondeu, não só no conteúdo",
      "autoridade": "baixa" | "média" | "alta",
      "autoridadeMotivo": "1-2 frases justificando o nível de autoridade percebido (se ela se posiciona, impõe ritmo na conversa, ou se é mais passiva/deixa o recrutador conduzir tudo)",
      "engajamento": "baixo" | "médio" | "alto",
      "engajamentoMotivo": "1-2 frases justificando (entusiasmo, iniciativa, perguntas que ela fez de volta, objetividade nas respostas)",
      "classificacao": "Alto potencial · baixo risco" | "Alto potencial · risco médio" | "Potencial médio · baixo risco" | "Potencial médio · risco médio" | "Baixo potencial" | "Alto risco — não recomendado",
      "resumo": "2-4 frases de parecer geral sobre colocar essa pessoa pra testar, considerando tudo acima"
    }
  ]
}

O array "candidatos" deve ter uma entrada pra cada pessoa diferente identificada na transcrição (pode ser 1 ou várias). Se a transcrição não trouxer informação suficiente pra algum campo, use seu melhor julgamento com base no que foi dito e no tom da conversa — nunca deixe um campo vazio ou fora do formato pedido. Nunca invente pessoas que não foram mencionadas.`;

async function gerarTriagemIA(){
  const ta=document.getElementById('triagem-transcript');
  const transcript=(ta?ta.value:'').trim();
  if(!transcript){toast('Grave ou cole a call antes de gerar os perfis.');return;}
  stopTriagemRecording(true);
  const btn=document.getElementById('triagem-gerar-btn');
  const st=document.getElementById('triagem-status');
  if(btn){btn.disabled=true;btn.textContent='🤖 Analisando...';}
  if(st)st.textContent='Enviando pra IA, isso pode levar alguns segundos...';
  try{
    const prompt=`Transcrição da call de triagem em grupo:\n\n${transcript}`;
    const res=await fetch(AI_PROXY_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:6000,system:TRIAGEM_SYSTEM,messages:[{role:'user',content:prompt}]})
    });
    const data=await res.json();
    let text=data.content?.map(b=>b.type==='text'?b.text:'').join('')||'';
    if(!text)throw aiQuotaError(data)||new Error('Resposta vazia da IA');
    text=text.trim().replace(/^```json/i,'').replace(/^```/,'').replace(/```$/,'').trim();
    const jsonStart=text.indexOf('{');const jsonEnd=text.lastIndexOf('}');
    if(jsonStart===-1||jsonEnd===-1)throw new Error('A IA não retornou um JSON válido — tente gerar de novo.');
    let parsed;
    try{
      parsed=JSON.parse(text.slice(jsonStart,jsonEnd+1));
    }catch(parseErr){
      const looksTruncated=data.stop_reason==='max_tokens'||jsonEnd<text.length-3;
      throw new Error(looksTruncated
        ?'A resposta da IA veio incompleta (cortada no meio). Tente gerar novamente — o texto gravado/colado continua salvo.'
        :'Não consegui interpretar o JSON da IA ('+parseErr.message+'). Tente gerar novamente.');
    }
    const candidatos=Array.isArray(parsed.candidatos)?parsed.candidatos:[];
    if(!candidatos.length)throw new Error('Não encontrei nenhuma pessoa identificável na transcrição.');
    candidatos.forEach(cand=>{
      S.triagemCandidatos.push({id:'tri'+Date.now()+Math.random().toString(36).slice(2,5),...cand,date:todayKey()});
    });
    delete S.triagemDraftTranscript;
    save();
    toast('🔍 '+candidatos.length+' perfil'+(candidatos.length>1?'is':'')+' de triagem gerado'+(candidatos.length>1?'s':'')+'!');
    closeModal('m-triagem');
    renderTriagemPool();
  }catch(e){
    console.error('Erro ao gerar triagem',e);
    // A transcrição já foi salva em S.triagemDraftTranscript (stopTriagemRecording no
    // início da função) — em qualquer erro, inclusive limite de uso da IA, ela não se perde.
    if(e.quota){
      toast('⏳ Limite de uso da IA no momento — sua transcrição já está salva.');
    }else{
      toast('⚠️ Erro ao gerar triagem: '+e.message+' — sua transcrição continua salva.');
    }
    window._triLastErrQuota=!!e.quota;
    window._triLastErrWait=e.waitSeconds;
    window._triLastErrMsg=e.quota?'':e.message;
  }finally{
    if(btn){btn.disabled=false;btn.textContent='🤖 Gerar perfis com IA';}
    if(window._triLastErrQuota&&st){
      renderAIWaitCountdown('triagem-status',window._triLastErrWait,{prefix:'⏳ Limite de uso da IA',suffix:'transcrição já está salva'});
    }else if(st){
      st.textContent=window._triLastErrMsg?`⚠️ ${window._triLastErrMsg} Sua transcrição está salva — feche e abra a triagem de novo quando quiser tentar.`:'';
    }
    window._triLastErrMsg=null;window._triLastErrQuota=false;window._triLastErrWait=null;
  }
}

/* ===========================================================
   MAPEAMENTO — gravações rápidas em 6 slots + Transcrições +
   MAPEAMENTO DOS NOVOS.
   Substitui o fluxo antigo de mapeamento por roteiro fixo pra NOVOS
   candidatos: 6 gravadores independentes, sem roteiro, cada um
   transcreve ao vivo e SALVA sozinho ao clicar em "Terminar gravação"
   (o próprio botão já é o salvar). O nome da pessoa é reconhecido a
   partir do que ela fala (ex: "aqui é o Felipe") — se não reconhecer,
   entra como "Pessoa sem nome" e dá pra renomear na mão. Assim que
   salva, o slot volta vazio pra gravar a próxima pessoa na sequência,
   sem travar pedindo permissão de microfone de novo (o navegador já
   lembra a permissão depois da primeira vez nesse site).
   Depois, o botão "Gerar Mapeamento" em Transcrições manda TODOS os
   nomes pendentes de uma vez só pra IA (1 request só, economiza cota),
   e o resultado vira um novo lote em MAPEAMENTO DOS NOVOS — com quem
   deu sinal de risco em vermelho e os melhores nomes pra vaga em
   destaque (peso extra pra quem responde bem à autoridade e traços de
   personalidade sutis captados na fala).
   =========================================================== */
let _mapSlotRecognition={}; // slotId -> SpeechRecognition ativo
let _mapSlotStream={};      // slotId -> MediaStream ativo
let _mapSlotRecording={};   // slotId -> bool

// Tenta reconhecer o nome da pessoa a partir do início da fala dela —
// funciona bem quando ela se apresenta ("aqui é o Felipe", "meu nome é
// Ana", "pode me chamar de Bia"). Se não achar nenhum padrão, devolve
// null e a gravação entra como "Pessoa sem nome" (dá pra renomear).
function detectNameFromTranscript(text){
  if(!text)return null;
  const patterns=[
    /\bme chamo\s+([A-ZÀ-Ú][a-zà-ú]+)/i,
    /\bmeu nome é\s+([A-ZÀ-Ú][a-zà-ú]+)/i,
    /\bpode me chamar de\s+([A-ZÀ-Ú][a-zà-ú]+)/i,
    /\baqui é (?:o|a)\s+([A-ZÀ-Ú][a-zà-ú]+)/i,
    /\baqui quem fala é (?:o|a)\s+([A-ZÀ-Ú][a-zà-ú]+)/i,
    /\beu sou (?:o|a)\s+([A-ZÀ-Ú][a-zà-ú]+)/i,
    /\bsou (?:o|a)\s+([A-ZÀ-Ú][a-zà-ú]+)/i,
  ];
  for(const re of patterns){
    const m=text.match(re);
    if(m&&m[1])return m[1].charAt(0).toUpperCase()+m[1].slice(1).toLowerCase();
  }
  return null;
}
function renderMapSlots(){
  const el=document.getElementById('map-slots');
  if(!el)return;
  // Um gravador só: grave uma pessoa, "Terminar gravação" já salva sozinho
  // em Transcrições e libera aqui na mesma hora pra gravar a próxima.
  el.innerHTML=[1].map(slotId=>{
    const recording=!!_mapSlotRecording[slotId];
    const draft=S.mapSlotDrafts[slotId]||'';
    const nome=S.mapSlotNames[slotId]||'';
    return`<div style="border:1px solid var(--line);border-radius:9px;padding:11px 13px;margin-bottom:9px;${recording?'border-color:var(--bad)':''}">
      <div class="field" style="margin-bottom:8px">
        <label class="flabel">Nome da pessoa (dá pra preencher ou trocar antes ou durante a gravação)</label>
        <input class="finput" id="map-slot-name-${slotId}" placeholder="Digite o nome — se deixar em branco, tenta reconhecer pela fala" value="${nome.replace(/"/g,'&quot;')}" oninput="onMapSlotNameInput(${slotId},this.value)">
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div style="font-size:11px;font-weight:700;color:var(--text3)">🎙️ GRAVAR CANDIDATO${draft&&!recording?' · rascunho recuperado':''}</div>
        <button class="btn ${recording?'btn-danger':'btn-primary'} btn-xs" onclick="toggleMapSlotRecording(${slotId})">${recording?'⏹️ Terminar gravação':'🎙️ Gravar'}</button>
      </div>
      ${recording?`<div style="font-size:11.5px;color:var(--bad);margin-top:6px">🔴 Gravando… fale perto do microfone. Se não digitou o nome acima, peça pra pessoa se apresentar.</div>`:''}
      ${draft&&!recording?`<div style="font-size:11.5px;color:var(--text3);margin-top:6px">Tem um rascunho aqui — clique em Gravar pra continuar ou vai se perder ao gravar a próxima pessoa.</div>`:''}
    </div>`;
  }).join('');
}
function onMapSlotNameInput(slotId,val){
  S.mapSlotNames[slotId]=val;
  save();
}
function toggleMapSlotRecording(slotId){
  if(_mapSlotRecording[slotId])stopMapSlotRecording(slotId);else startMapSlotRecording(slotId);
}
function startMapSlotRecording(slotId){
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    toast('⚠️ Seu navegador não suporta gravação de áudio.');
    return;
  }
  navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{
    _mapSlotStream[slotId]=stream;
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR){
      toast('⚠️ Transcrição automática não é suportada nesse navegador (funciona melhor no Chrome/Android).');
      try{stream.getTracks().forEach(t=>t.stop());}catch(e){}
      return;
    }
    const rec=new SR();
    rec.lang='pt-BR';rec.continuous=true;rec.interimResults=true;
    let baseText=S.mapSlotDrafts[slotId]||'';
    if(baseText&&!/\s$/.test(baseText))baseText+=' ';
    rec.onresult=(ev)=>{
      let finalTxt='';
      for(let i=ev.resultIndex;i<ev.results.length;i++){
        if(!ev.results[i].isFinal)continue;
        // O reconhecimento de voz do navegador NÃO pontua sozinho — sem
        // isso, tudo sai grudado numa frase só, ilegível (achado em
        // 31/07/2026, a pedido da gestora). Cada resultado "final" já
        // corresponde a uma pausa natural da fala, então é o lugar certo
        // pra fechar com ponto e começar a próxima frase com maiúscula.
        let piece=(ev.results[i][0].transcript||'').trim();
        if(!piece)continue;
        piece=piece.charAt(0).toUpperCase()+piece.slice(1);
        if(!/[.!?…]$/.test(piece))piece+='.';
        finalTxt+=piece+' ';
      }
      if(finalTxt){
        baseText+=finalTxt;
        // Salva a cada frase finalizada — se travar no meio, o slot
        // recupera o rascunho na próxima abertura em vez de sumir.
        S.mapSlotDrafts[slotId]=baseText;
        save();
      }
    };
    rec.onerror=(ev)=>console.warn('Erro no reconhecimento de voz (slot '+slotId+')',ev.error);
    rec.onend=()=>{ if(_mapSlotRecording[slotId]){ try{rec.start();}catch(e){} } };
    try{rec.start();}catch(e){console.warn(e);}
    _mapSlotRecognition[slotId]=rec;
    _mapSlotRecording[slotId]=true;
    renderMapSlots();
  }).catch(err=>{
    console.error(err);
    toast('⚠️ Não foi possível acessar o microfone. Verifique a permissão do navegador.');
  });
}
// "Terminar gravação" já É o salvar — para a gravação, reconhece o nome
// pelo que foi dito, cria a entrada em Transcrições e esvazia o slot na
// hora, pronta pra gravar a próxima pessoa sem pedir nada de novo.
function stopMapSlotRecording(slotId){
  _mapSlotRecording[slotId]=false;
  const rec=_mapSlotRecognition[slotId];
  if(rec){try{rec.onend=null;rec.stop();}catch(e){} delete _mapSlotRecognition[slotId];}
  const stream=_mapSlotStream[slotId];
  if(stream){try{stream.getTracks().forEach(t=>t.stop());}catch(e){} delete _mapSlotStream[slotId];}
  const transcript=(S.mapSlotDrafts[slotId]||'').trim();
  delete S.mapSlotDrafts[slotId];
  const nomeDigitado=(S.mapSlotNames[slotId]||'').trim();
  if(!transcript){delete S.mapSlotNames[slotId];save();renderMapSlots();return;}
  // Prioriza o nome digitado à mão (antes ou durante a gravação) — só cai
  // pro reconhecimento automático pela fala se a gestora não tiver digitado
  // nada, e só vira "Pessoa sem nome" em último caso.
  const name=nomeDigitado||detectNameFromTranscript(transcript)||('Pessoa sem nome '+(S.mapRecordings.filter(r=>/^Pessoa sem nome/.test(r.name)).length+1));
  S.mapRecordings.push({id:'mr'+Date.now()+Math.random().toString(36).slice(2,5),name,transcript,date:todayKey(),mapped:false});
  delete S.mapSlotNames[slotId];
  save();
  toast(`✅ Gravação salva em Transcrições — "${name}"`);
  renderMapSlots();
  renderMapTranscricoes();
}
function renameMapRecording(id){
  const r=S.mapRecordings.find(x=>x.id===id);
  if(!r)return;
  const novo=prompt('Nome dessa pessoa:',r.name);
  if(!novo||!novo.trim())return;
  r.name=novo.trim();
  save();
  renderMapTranscricoes();
}
function deleteMapRecording(id){
  if(!confirm('Excluir essa gravação/transcrição? Essa ação não pode ser desfeita.'))return;
  S.mapRecordings=S.mapRecordings.filter(r=>r.id!==id);
  save();
  renderMapTranscricoes();
}
// Abre/fecha os quadros aninhados (Transcrições / MAPEAMENTO DOS NOVOS)
// dentro do painel único de Mapeamento na aba Testers.
function toggleMapSection(name){
  const b=document.getElementById('map-section-body-'+name),ic=document.getElementById('map-section-ic-'+name);
  if(!b)return;
  const open=b.style.display!=='none';
  b.style.display=open?'none':'block';
  if(ic)ic.textContent=open?'▼':'▲';
}
function toggleMapTranscript(id){
  const b=document.getElementById('map-tr-body-'+id),ic=document.getElementById('map-tr-ic-'+id);
  if(!b)return;
  const open=b.style.display!=='none';
  b.style.display=open?'none':'block';
  if(ic)ic.textContent=open?'▼':'▲';
}
function renderMapTranscricoes(){
  const el=document.getElementById('map-transcricoes-list');
  if(!el)return;
  const pendentes=S.mapRecordings.filter(r=>!r.mapped);
  if(!pendentes.length){
    el.innerHTML='<div style="color:var(--text3);font-size:12.5px;padding:6px 0">Nenhuma transcrição pendente — grave alguém acima pra aparecer aqui.</div>';
    const gbtn=document.getElementById('map-gerar-btn');if(gbtn)gbtn.disabled=true;
    return;
  }
  const gbtn=document.getElementById('map-gerar-btn');if(gbtn)gbtn.disabled=false;
  el.innerHTML=pendentes.map(r=>`<div style="border:1px solid var(--line);border-radius:9px;margin-bottom:8px;overflow:hidden">
    <div style="padding:10px 13px;background:var(--bg-soft);display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="toggleMapTranscript('${r.id}')">
      <div style="font-size:13px;font-weight:700">${r.name}</div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:9.5px;color:var(--text3)" id="map-tr-ic-${r.id}">▼</span>
      </div>
    </div>
    <div id="map-tr-body-${r.id}" style="display:none;padding:12px">
      <div style="font-size:12.5px;color:var(--text2);line-height:1.55;margin-bottom:10px">${r.transcript}</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();renameMapRecording('${r.id}')">✏️ Renomear</button>
        <button class="btn btn-ghost btn-xs" style="color:var(--bad);border-color:var(--bad)" onclick="event.stopPropagation();deleteMapRecording('${r.id}')">🗑️ Excluir</button>
      </div>
    </div>
  </div>`).join('');
}
const MAPEAMENTO_NOVOS_SYSTEM=`Você é uma psicóloga organizacional e recrutadora sênior especialista em avaliar candidatos NOVOS pra vaga de chatter/atendimento em redes sociais (OnlyFans), a partir de uma breve auto-apresentação gravada (não é uma entrevista estruturada — pode ser curta e informal). Você recebe uma lista de pessoas diferentes, cada uma com nome e sua transcrição individual.

Pra cada pessoa, analise o CONTEÚDO do que foi dito e também sinais de linguagem (segurança, clareza, hesitação, entusiasmo, tom) — preste atenção especial a: (1) como essa pessoa tende a responder à autoridade/liderança (se posiciona, é dócil, questiona, busca aprovação), (2) traços SUTIS de personalidade que não estão explícitos no conteúdo, só no JEITO de falar, e (3) a experiência profissional que ela relatou (empregos anteriores, tempo de experiência, se já trabalhou com atendimento/vendas/redes sociais, se tem histórico de instabilidade ou passagens curtas) — avalie objetivamente se essa bagagem profissional é BOA, MÉDIA ou FRACA pra essa vaga especificamente, e por quê.

IMPORTANTE — cuidado e sensibilidade: é uma auto-apresentação curta e informal, gravada muitas vezes com nervosismo por ser uma candidata a uma vaga nova — não trate hesitação, timidez ou uma gravação mais curta/desorganizada como sinal automático de fraqueza ou baixo potencial; considere que é uma situação de pressão pra quem está gravando. Evite rótulos duros ou definitivos ("essa pessoa é X") com base em pouquíssima informação — prefira descrições específicas e com nuance, e só marque riscoDetectado=true quando houver um sinal CONCRETO no que foi dito (não um palpite ou estereótipo). O objetivo é dar à liderança uma leitura justa e útil pra decidir, não descartar alguém de forma precipitada.

Responda SOMENTE com um objeto JSON válido (sem markdown, sem \`\`\`, sem nenhum texto antes ou depois), seguindo EXATAMENTE este formato:
{
  "candidatos": [
    {
      "nome": "nome exatamente como foi passado",
      "personalidadeUmaFrase": "a personalidade dessa pessoa em UMA frase curta e específica, nada de clichê genérico",
      "tracoSutil": "1-2 frases sobre um traço sutil percebido no JEITO de falar (hesitação, confiança, humor, ansiedade, formalidade etc), não no conteúdo",
      "autoridade": "baixa" | "média" | "alta",
      "autoridadeMotivo": "1-2 frases justificando como essa pessoa tende a responder a comandos/liderança",
      "comunicacao": (0-100),
      "inteligenciaEmocional": (0-100),
      "experienciaProfissional": "boa" | "média" | "fraca",
      "experienciaProfissionalMotivo": "1-3 frases explicando por que a experiência profissional relatada é boa/média/fraca pra essa vaga específica — cite o que ela contou (ou a falta disso)",
      "motivadores": ["até 3, entre: dinheiro, reconhecimento, competição, estabilidade, aprendizado, propósito, liberdade, status, crescimento, impacto, pertencimento"],
      "riscoDetectado": true|false,
      "motivoRisco": "se riscoDetectado=true, explique objetivamente o sinal de risco (instabilidade, discurso contraditório, desonestidade percebida, falta de comprometimento etc); se false, deixe string vazia",
      "pontuacaoGeral": (0-100, o quanto essa pessoa parece um bom encaixe pra vaga, considerando tudo acima),
      "recomendacao": "forte candidato" | "candidato razoável" | "não recomendado",
      "resumo": "2-4 frases de parecer geral sobre colocar essa pessoa pra testar"
    }
  ]
}
O array "candidatos" deve ter uma entrada pra cada pessoa da lista, na mesma ordem, usando o nome exatamente como foi passado. Nunca deixe um campo vazio ou fora do formato pedido — use seu melhor julgamento clínico com base no que foi dito e no tom.`;
async function gerarMapeamentoBatch(){
  const pendentes=S.mapRecordings.filter(r=>!r.mapped);
  if(!pendentes.length){toast('⚠️ Nenhuma transcrição pendente pra mapear.');return;}
  const btn=document.getElementById('map-gerar-btn');
  const st=document.getElementById('map-gerar-status');
  if(btn){btn.disabled=true;btn.textContent='🤖 Mapeando...';}
  if(st)st.textContent='Enviando pra IA, isso pode levar alguns segundos...';
  try{
    const prompt=pendentes.map((r,i)=>`PESSOA ${i+1} — Nome: ${r.name}\nTranscrição:\n${r.transcript}`).join('\n\n---\n\n');
    const res=await fetch(AI_PROXY_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:6000,system:MAPEAMENTO_NOVOS_SYSTEM,messages:[{role:'user',content:prompt}]})
    });
    const data=await res.json();
    let text=data.content?.map(b=>b.type==='text'?b.text:'').join('')||'';
    if(!text)throw aiQuotaError(data)||new Error('Resposta vazia da IA');
    text=text.trim().replace(/^```json/i,'').replace(/^```/,'').replace(/```$/,'').trim();
    const jsonStart=text.indexOf('{');const jsonEnd=text.lastIndexOf('}');
    if(jsonStart===-1||jsonEnd===-1)throw new Error('A IA não retornou um JSON válido — tente gerar de novo.');
    let parsed;
    try{
      parsed=JSON.parse(text.slice(jsonStart,jsonEnd+1));
    }catch(parseErr){
      const looksTruncated=jsonEnd<text.length-3;
      throw new Error(looksTruncated
        ?'A resposta da IA veio incompleta (cortada no meio). Tente gerar novamente — as transcrições continuam salvas.'
        :'Não consegui interpretar o JSON da IA ('+parseErr.message+'). Tente gerar novamente.');
    }
    const candidatos=Array.isArray(parsed.candidatos)?parsed.candidatos:[];
    if(!candidatos.length)throw new Error('A IA não retornou nenhum candidato mapeado.');
    const results=candidatos.map((cand,i)=>({id:'mb'+Date.now()+i,recordingId:pendentes[i]?.id,...cand}));
    S.mapeamentoBatches.push({id:'batch'+Date.now(),date:todayKey(),results});
    pendentes.forEach(r=>{r.mapped=true;});
    save();
    toast(`🎯 ${results.length} pessoa${results.length>1?'s':''} mapeada${results.length>1?'s':''} — disponível em MAPEAMENTO DOS NOVOS`);
    renderMapTranscricoes();
    renderMapeamentoNovosPool();
  }catch(e){
    console.error('Erro ao gerar mapeamento em lote',e);
    if(e.quota){
      toast('⏳ Limite de uso da IA no momento — suas transcrições continuam salvas.');
    }else{
      toast('⚠️ Erro ao gerar mapeamento: '+e.message+' — suas transcrições continuam salvas.');
    }
    window._mapBatchLastErrQuota=!!e.quota;
    window._mapBatchLastErrWait=e.waitSeconds;
    window._mapBatchLastErrMsg=e.quota?'':e.message;
  }finally{
    if(btn){btn.disabled=false;btn.textContent='🗺️ Mapear Transcrições';}
    if(window._mapBatchLastErrQuota&&st){
      renderAIWaitCountdown('map-gerar-status',window._mapBatchLastErrWait,{prefix:'⏳ Limite de uso da IA',suffix:'transcrições já estão salvas'});
    }else if(st){
      st.textContent=window._mapBatchLastErrMsg?`⚠️ ${window._mapBatchLastErrMsg}`:'';
    }
    window._mapBatchLastErrMsg=null;window._mapBatchLastErrQuota=false;window._mapBatchLastErrWait=null;
  }
}
let mapeamentoNovosOpenBatches=null;
function renderMapeamentoNovosPool(){
  const el=document.getElementById('map-novos-list');
  if(!el)return;
  if(!mapeamentoNovosOpenBatches)mapeamentoNovosOpenBatches=new Set();
  const batches=[...S.mapeamentoBatches].reverse();
  if(!batches.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Nenhum mapeamento gerado ainda — grave em Mapeamento e clique em Gerar Mapeamento em Transcrições.</div>';return;}
  el.innerHTML=batches.map(b=>{
    const dateBR=b.date.split('-').reverse().join('/');
    const top=[...b.results].sort((a,b2)=>(b2.pontuacaoGeral||0)-(a.pontuacaoGeral||0))[0];
    const riscoCount=b.results.filter(r=>r.riscoDetectado).length;
    // Guarda se o card estava aberto antes de re-renderizar — sem isso, toda
    // vez que a gestora vincula um mapeamento a um tester (o que chama essa
    // função de novo), o card fechava sozinho e dava a impressão de que o
    // mapeamento tinha sumido.
    const isOpen=mapeamentoNovosOpenBatches.has(b.id);
    return`<div style="border:1px solid var(--line);border-radius:9px;margin-bottom:9px;overflow:hidden">
      <div style="padding:11px 13px;background:var(--bg-soft);display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="toggleMapeamentoNovosBatch('${b.id}')">
        <div>
          <div style="font-size:13px;font-weight:700">${dateBR} · ${b.results.length} pessoa${b.results.length>1?'s':''}</div>
          <div style="font-size:11px;color:var(--text3)">${top?`🌟 destaque: ${top.nome}`:''}${riscoCount?` · ⚠️ ${riscoCount} com risco`:''}</div>
        </div>
        <span style="font-size:10px;color:var(--text3)" id="map-novos-ic-${b.id}">${isOpen?'▲':'▼'}</span>
      </div>
      <div id="map-novos-body-${b.id}" style="display:${isOpen?'block':'none'};padding:12px">
        ${[...b.results].sort((a,c)=>(c.pontuacaoGeral||0)-(a.pontuacaoGeral||0)).map((r,idx)=>{
          const isTopPick=idx<3&&!r.riscoDetectado&&(r.pontuacaoGeral||0)>=60;
          const recColor=r.recomendacao==='forte candidato'?'var(--ok)':r.recomendacao==='candidato razoável'?'var(--warn)':'var(--bad)';
          return`<div style="border:1px solid ${r.riscoDetectado?'var(--bad)':'var(--line)'};${r.riscoDetectado?'background:var(--bad-soft);':''}border-radius:9px;padding:12px;margin-bottom:9px">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">
              <div style="font-weight:700;font-size:14px">${r.nome} ${isTopPick?'<span class="pill pill-ok" style="font-size:9px">🌟 sugerido pra vaga</span>':''}</div>
              <div style="font-size:16px;font-weight:800;font-family:var(--font-mono);color:${recColor}">${r.pontuacaoGeral ?? '—'}</div>
            </div>
            <div style="font-size:9.5px;font-weight:700;color:${recColor};text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px">${r.recomendacao||'—'}</div>
            <div style="font-size:12.5px;color:var(--text2);margin-bottom:6px"><strong>${r.personalidadeUmaFrase||''}</strong></div>
            <div style="font-size:12px;color:var(--text2);margin-bottom:4px">🎭 <strong>Traço sutil:</strong> ${r.tracoSutil||'—'}</div>
            <div style="font-size:12px;color:var(--text2);margin-bottom:4px">👑 <strong>Autoridade:</strong> ${r.autoridade||'—'} — ${r.autoridadeMotivo||''}</div>
            <div style="font-size:12px;color:var(--text2);margin-bottom:4px">🗣️ Comunicação: ${r.comunicacao ?? '—'}/100 · 💛 Intel. emocional: ${r.inteligenciaEmocional ?? '—'}/100</div>
            ${r.experienciaProfissional?`<div style="font-size:12px;color:var(--text2);margin-bottom:4px">💼 <strong>Experiência profissional:</strong> <span style="color:${r.experienciaProfissional==='boa'?'var(--ok)':r.experienciaProfissional==='média'?'var(--warn)':'var(--bad)'};font-weight:700;text-transform:uppercase">${r.experienciaProfissional}</span> — ${r.experienciaProfissionalMotivo||''}</div>`:''}
            ${Array.isArray(r.motivadores)&&r.motivadores.length?`<div style="font-size:12px;color:var(--text2);margin-bottom:4px">🎯 Motivadores: ${r.motivadores.join(', ')}</div>`:''}
            ${r.riscoDetectado?`<div style="font-size:12.5px;color:var(--bad);font-weight:700;margin-top:6px">⚠️ RISCO: ${r.motivoRisco||''}</div>`:''}
            <div style="font-size:12px;color:var(--text3);margin-top:8px;line-height:1.5">${r.resumo||''}</div>
            <div style="display:flex;gap:8px;margin-top:9px;align-items:center">
              ${(()=>{
                const linked=r.chatterId&&S.chatters.find(c=>c.id===r.chatterId);
                if(linked)return`<div style="flex:1;font-size:12px;color:var(--ok);font-weight:700">✅ Vinculado a ${linked.name}</div>`;
                // Lista os testers já existentes (inclusive quem se autoincluiu
                // pelo link de tarefas) pra gestora escolher a quem esse
                // mapeamento pertence de verdade, em vez de sempre criar um
                // chatter novo (raiz de boa parte dos nomes duplicados).
                const candidatos=S.chatters.filter(c=>c.time==='tester'||c.pendenteAprovacao).slice().sort((a,c2)=>(a.name||'').localeCompare(c2.name||''));
                return`<select class="fselect" style="flex:1;font-size:12.5px;padding:8px" onchange="vincularMapeamentoNovo('${b.id}','${r.id}',this.value,'${r.nome.replace(/'/g,"\\'")}')">
                  <option value="">— vincular a um tester —</option>
                  ${candidatos.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}
                  <option value="__novo__">➕ Criar tester novo com esse nome</option>
                </select>`;
              })()}
              <button class="btn btn-ghost btn-xs" title="Eliminar esse candidato do mapeamento" onclick="event.stopPropagation();removerMapeamentoNovoResultado('${b.id}','${r.id}')" style="color:var(--bad);flex-shrink:0">✕</button>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
}
function toggleMapeamentoNovosBatch(id){
  if(!mapeamentoNovosOpenBatches)mapeamentoNovosOpenBatches=new Set();
  const b=document.getElementById('map-novos-body-'+id),ic=document.getElementById('map-novos-ic-'+id);
  if(!b)return;
  const open=b.style.display!=='none';
  if(open)mapeamentoNovosOpenBatches.delete(id);else mapeamentoNovosOpenBatches.add(id);
  b.style.display=open?'none':'block';
  if(ic)ic.textContent=open?'▼':'▲';
}
function criarTesterDoMapeamentoNovo(batchId,resultId,nome){
  const batch=S.mapeamentoBatches.find(b=>b.id===batchId);
  const r=batch&&(batch.results||[]).find(x=>x.id===resultId);
  // Evita duplicar: se esse resultado do mapeamento já foi convertido antes
  // (e o tester ainda existe), não cria um segundo chatter com o mesmo nome.
  if(r&&r.chatterId&&S.chatters.some(c=>c.id===r.chatterId)){
    toast('Esse candidato já virou tester.');
    return;
  }
  const chatterId='c'+Date.now();
  // Ainda não é Tester "oficial" — só aparece nas Tarefas (tarefas-novato.html,
  // que filtra por time==='tester') pra começar a fazer Sexta/Sábado/Domingo e
  // ser reivindicado por um padrinho. Só vira Tester de fato (aparece aqui em
  // Testers/Equipe) quando a gestora aprovar a solicitação de Afilhado.
  S.chatters.push({id:chatterId,name:nome||'Novo candidato',discord:'',level:'teste',time:'tester',pendenteAprovacao:true,notes:'',watchtime:'',createdAt:new Date().toISOString()});
  // Alinha o mapeamento dos novos a essa pessoa por ID — casar só pelo nome
  // falha quando existem nomes repetidos (2 pessoas com nome parecido, ou o
  // mesmo nome gravado 2x), e é exatamente esse o cenário que gera
  // desalinhamento no Documento dos Padrinhos.
  if(r)r.chatterId=chatterId;
  save();
  toast('✅ '+(nome||'Candidato')+' adicionado às Tarefas — vira Tester quando o padrinho for aprovado!');
  renderTesters();
}
function vincularMapeamentoNovo(batchId,resultId,value,nomeFallback){
  if(!value)return; // "— vincular a um tester —" selecionado, não faz nada
  if(value==='__novo__'){
    criarTesterDoMapeamentoNovo(batchId,resultId,nomeFallback);
    return;
  }
  const batch=S.mapeamentoBatches.find(b=>b.id===batchId);
  const r=batch&&(batch.results||[]).find(x=>x.id===resultId);
  const c=S.chatters.find(ch=>ch.id===value);
  if(!r||!c)return;
  r.chatterId=value;
  save();
  toast(`🔗 Mapeamento vinculado a ${c.name} — já aparece pros padrinhos.`);
  renderMapeamentoNovosPool();
}
function removerMapeamentoNovoResultado(batchId,resultId){
  const batch=S.mapeamentoBatches.find(b=>b.id===batchId);
  if(!batch)return;
  if(!confirm('Eliminar esse candidato do mapeamento? Essa ação não pode ser desfeita.'))return;
  batch.results=(batch.results||[]).filter(r=>r.id!==resultId);
  if(!batch.results.length)S.mapeamentoBatches=S.mapeamentoBatches.filter(b=>b.id!==batchId);
  save();
  renderMapeamentoNovosPool();
}

function renderTriagemPool(){
  const el=document.getElementById('triagem-pool-list');
  if(!el)return;
  const pool=S.triagemCandidatos||[];
  if(!pool.length){el.innerHTML='<div style="font-size:12.5px;color:var(--text3);padding:8px 0">Nenhum candidato triado ainda — grave ou cole a call em grupo pra gerar os perfis.</div>';return;}
  const badgeColor={
    'Alto potencial · baixo risco':'var(--ok)','Alto potencial · risco médio':'var(--ok)',
    'Potencial médio · baixo risco':'var(--warn)','Potencial médio · risco médio':'var(--warn)',
    'Baixo potencial':'var(--bad)','Alto risco — não recomendado':'var(--bad)'
  };
  el.innerHTML=pool.map(cand=>{
    const color=badgeColor[cand.classificacao]||'var(--text3)';
    return`<div style="border:1px solid var(--line);border-radius:9px;padding:11px 13px;margin-bottom:9px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
        <div style="min-width:0">
          <div style="font-weight:700;font-size:14px">${cand.nome||'—'}</div>
          <div style="font-size:11.5px;color:var(--text2);margin-top:2px">${cand.ondeMora||'-'} · ${cand.oQueFaz||'-'}</div>
          <div style="font-size:11px;color:var(--text3);margin-top:2px">💰 ${cand.pretensaoSalarial||'-'} · 📈 ${cand.conheceMercado||'-'}</div>
        </div>
        <span class="pill" style="font-size:9px;flex-shrink:0;border-color:${color};color:${color}">${cand.classificacao||'-'}</span>
      </div>
      <div style="font-size:12px;color:var(--text2);margin-top:8px;line-height:1.5">${cand.resumo||''}</div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn btn-primary btn-xs" style="flex:1" onclick="openVincularTriagemModal('${cand.id}')">🔗 Vincular a um tester</button>
        <button class="btn btn-ghost btn-xs" onclick="removerTriagemCandidato('${cand.id}')">✕</button>
      </div>
    </div>`;
  }).join('');
}

function removerTriagemCandidato(candId){
  if(!confirm('Descartar esse perfil de triagem? Essa ação não pode ser desfeita.'))return;
  S.triagemCandidatos=S.triagemCandidatos.filter(c=>c.id!==candId);
  save();
  renderTriagemPool();
}

function openVincularTriagemModal(candId){
  const cand=S.triagemCandidatos.find(c=>c.id===candId);
  if(!cand)return;
  window._triagemVincularId=candId;
  const nameEl=document.getElementById('triagem-vincular-nome');
  if(nameEl)nameEl.textContent=cand.nome||'';
  const sel=document.getElementById('triagem-vincular-select');
  if(sel){
    const testers=S.chatters.filter(c=>c.time==='tester');
    sel.innerHTML='<option value="">— nenhum —</option>'+testers.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
  }
  openModal('m-triagem-vincular');
}

function excluirTriagemIA(chatterId){
  const f=S.chatterFichas[chatterId];
  if(!f||!f.triagemIA)return;
  if(!confirm('Excluir o mapeamento de triagem dessa pessoa? Essa ação não pode ser desfeita.'))return;
  delete f.triagemIA;
  save();
  toast('Triagem excluída');
  renderTesterDetail(chatterId);
}
function confirmarVincularTriagem(mode){
  const candId=window._triagemVincularId;
  const cand=S.triagemCandidatos.find(c=>c.id===candId);
  if(!cand)return;
  let chatterId='';
  if(mode==='new'){
    chatterId='c'+Date.now();
    S.chatters.push({id:chatterId,name:cand.nome||'Novo candidato',discord:'',level:'teste',time:'tester',pendenteAprovacao:true,notes:'',watchtime:'',createdAt:new Date().toISOString()});
  } else {
    const sel=document.getElementById('triagem-vincular-select');
    chatterId=sel?sel.value:'';
    if(!chatterId){toast('Selecione um tester ou crie um novo');return;}
  }
  if(!S.chatterFichas[chatterId])S.chatterFichas[chatterId]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
  const{id,...profile}=cand;
  S.chatterFichas[chatterId].triagemIA={...profile,date:cand.date};
  S.triagemCandidatos=S.triagemCandidatos.filter(c=>c.id!==candId);
  save();
  closeModal('m-triagem-vincular');
  const c=S.chatters.find(ch=>ch.id===chatterId);
  toast('🔗 Triagem vinculada a '+(c?c.name:'?'));
  renderTriagemPool();
  renderTesters();
}
function abrirTrocaMapeamento(chatterId){
  window._mapTrocaFromId=chatterId;
  const sel=document.getElementById('map-troca-select');
  if(sel){
    const outros=S.chatters.filter(ch=>ch.id!==chatterId);
    sel.innerHTML=outros.length?outros.map(ch=>`<option value="${ch.id}">${ch.name}</option>`).join(''):'<option value="">Nenhum outro chatter</option>';
  }
  const fromC=S.chatters.find(ch=>ch.id===chatterId);
  const nameEl=document.getElementById('map-troca-from-name');
  if(nameEl)nameEl.textContent=fromC?fromC.name:'';
  openModal('m-map-troca');
}
function confirmarTrocaMapeamento(){
  const fromId=window._mapTrocaFromId;
  const sel=document.getElementById('map-troca-select');
  const toId=sel?sel.value:'';
  if(!fromId||!toId||fromId===toId){toast('Selecione um chatter diferente');return;}
  const fFrom=S.chatterFichas[fromId];
  if(!fFrom||!fFrom.mapeamentoIA){toast('Não há mapeamento pra mover');return;}
  if(!S.chatterFichas[toId])S.chatterFichas[toId]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
  const fTo=S.chatterFichas[toId];
  if(fTo.mapeamentoIA&&!confirm('O chatter de destino já tem um mapeamento — isso vai substituir o mapeamento existente dele. Continuar?'))return;
  fTo.mapeamentoIA=fFrom.mapeamentoIA;
  delete fFrom.mapeamentoIA;
  save();
  closeModal('m-map-troca');
  const cTo=S.chatters.find(ch=>ch.id===toId);
  toast('Mapeamento movido pra '+(cTo?cTo.name:'?'));
  renderFichaChatter(fromId);
}
// Arrasta o card do Mapeamento pra direita revela as ações Excluir/Trocar
// atrás dele (mesmo padrão touch/mouse já usado em attachSwipeDismiss,
// mas aqui o card fica "aberto" mostrando os botões em vez de desaparecer).
function attachMapeamentoSwipe(chatterId){
  const card=document.getElementById('map-swipe-card-'+chatterId);
  if(!card)return;
  let startX=0,curX=0,dragging=false,revealed=false;
  const REVEAL=96;
  const onDown=e=>{
    if(e.target.closest('button,select,a,textarea'))return;
    dragging=true;
    startX=(e.touches?e.touches[0].clientX:e.clientX);
    card.style.transition='none';
  };
  const onMove=e=>{
    if(!dragging)return;
    const delta=(e.touches?e.touches[0].clientX:e.clientX)-startX;
    curX=Math.max(0,Math.min(REVEAL,(revealed?REVEAL:0)+delta));
    card.style.transform=`translateX(${curX}px)`;
  };
  const onUp=()=>{
    if(!dragging)return;
    dragging=false;
    card.style.transition='transform .2s ease';
    if(curX>REVEAL/2){
      card.style.transform=`translateX(${REVEAL}px)`;
      revealed=true;
    } else {
      card.style.transform='translateX(0)';
      revealed=false;
    }
  };
  card.addEventListener('mousedown',onDown);
  card.addEventListener('touchstart',onDown,{passive:true});
  card.addEventListener('mousemove',onMove);
  card.addEventListener('touchmove',onMove,{passive:true});
  card.addEventListener('mouseup',onUp);
  card.addEventListener('mouseleave',onUp);
  card.addEventListener('touchend',onUp);
}
function renderMapeamentoPanel(chatterId){
  const f=S.chatterFichas[chatterId]||{};
  const m=f.mapeamentoIA;
  if(!m){
    return `<div class="panel">
      <div class="panel-head"><div><div class="panel-title">🎯 Mapeamento de Performance</div><div class="panel-note">Entrevista guiada (roteiro + gravação) analisada por IA — perfil completo de liderança e motivação</div></div></div>
      <button class="btn btn-primary btn-block" onclick="openMapeamentoModal('${chatterId}')">🎙️ Mapear</button>
    </div>`;
  }
  const perfisTxt=(m.perfis||[]).map(p=>`${p.tipo} ${p.pct}%`).join(' / ');
  const dp=m.dadosPessoais||{};
  const infoOk=v=>v&&!/n[ãa]o informad/i.test(v);
  const radar=m.radar||{};
  const radarKeys=Object.keys(radar);
  const body=`
    <div style="position:relative;overflow:hidden;border-radius:10px;margin-bottom:6px">
      <div style="position:absolute;top:0;left:0;bottom:0;width:96px;display:flex;flex-direction:column;gap:6px;justify-content:center;z-index:0">
        <button data-noaccordion class="btn btn-ghost btn-xs" style="color:var(--bad);border-color:var(--bad)" onclick="excluirMapeamentoIA('${chatterId}')">🗑️ Excluir</button>
        <button data-noaccordion class="btn btn-ghost btn-xs" onclick="abrirTrocaMapeamento('${chatterId}')">🔁 Trocar pessoa</button>
      </div>
      <div id="map-swipe-card-${chatterId}" style="position:relative;background:var(--bg-soft);border-radius:10px;padding:12px;z-index:1">
        ${m.personalidadeUmaFrase?`<div style="font-size:14px;font-weight:700;color:var(--accent);font-style:italic;margin-bottom:8px">"${m.personalidadeUmaFrase}"</div>`:''}
        ${(infoOk(dp.idade)||infoOk(dp.ondeMora)||infoOk(dp.comQuemMora))?`<div style="display:flex;flex-wrap:wrap;gap:10px;font-size:11.5px;color:var(--text3);margin-bottom:6px">
          ${infoOk(dp.idade)?`<span>🎂 ${dp.idade}</span>`:''}
          ${infoOk(dp.ondeMora)?`<span>📍 ${dp.ondeMora}</span>`:''}
          ${infoOk(dp.comQuemMora)?`<span>🏠 mora com ${dp.comQuemMora}</span>`:''}
        </div>`:''}
        <div class="panel-note" style="margin-bottom:6px">👤 Quem é essa pessoa</div>
        ${dp.sobre?`<div style="font-size:12.5px;color:var(--text2);line-height:1.5;margin-bottom:4px">${dp.sobre}</div>`:''}
        <div style="font-size:12.5px;color:var(--text2);line-height:1.5">${m.resumoHistoria||'-'}</div>
      </div>
    </div>
    <div class="panel-note" style="margin-bottom:12px;text-align:center">⬅️ Arraste esse card pra direita pra excluir ou trocar de pessoa</div>
    ${(m.respostaDesafioGpt&&!/^n[ãa]o fez/i.test(m.respostaDesafioGpt))?`<div style="background:var(--bg-soft);border-radius:10px;padding:12px;margin-bottom:14px;border:1px solid var(--line)">
      <div class="panel-note" style="margin-bottom:6px">🤖 Desafio GPT — resposta completa</div>
      <div style="font-size:12.5px;color:var(--text2);line-height:1.6;white-space:pre-wrap">${m.respostaDesafioGpt}</div>
    </div>`:''}

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
      <div style="text-align:center;background:var(--bg-soft);border-radius:8px;padding:8px">
        <div style="font-size:9px;color:var(--text3)">Comunicação</div>
        <div style="font-size:16px;font-weight:800">${m.comunicacao??'-'}/100</div>
      </div>
      <div style="text-align:center;background:var(--bg-soft);border-radius:8px;padding:8px">
        <div style="font-size:9px;color:var(--text3)">Intelig. emocional</div>
        <div style="font-size:16px;font-weight:800">${m.inteligenciaEmocional??'-'}/100</div>
      </div>
    </div>

    <div class="field"><label class="flabel">🎓 Aprende melhor</label><div style="font-size:12.5px;color:var(--text2)">${m.aprendizagem||'-'}</div></div>
    <div class="field"><label class="flabel">🔥 Motivadores principais</label><div style="font-size:12.5px;color:var(--text2)">${(m.motivadores||[]).join(' · ')||'-'}</div></div>

    <div class="field">
      <label class="flabel">👑 Liderança ideal${m.liderancaIdeal&&m.liderancaIdeal.estilo?' — '+m.liderancaIdeal.estilo:''}</label>
      <div style="font-size:11.5px;color:var(--ok);margin-bottom:4px">${((m.liderancaIdeal&&m.liderancaIdeal.funcionaQuando)||[]).map(x=>'✔ '+x).join('<br>')}</div>
      <div style="font-size:11.5px;color:var(--bad)">${((m.liderancaIdeal&&m.liderancaIdeal.evite)||[]).map(x=>'✖ '+x).join('<br>')}</div>
    </div>

    <div class="field"><label class="flabel">💡 Como motivar</label><div style="font-size:12.5px;color:var(--text2)">${m.comoMotivar||'-'}</div></div>
    <div class="field"><label class="flabel">🧭 Como liderar</label><div style="font-size:12.5px;color:var(--text2)">${m.comoLiderar||'-'}</div></div>
    <div class="field"><label class="flabel">🚫 O que NÃO fazer</label><div style="font-size:12.5px;color:var(--text2)">${m.oQueNaoFazer||'-'}</div></div>

    <div class="panel-note" style="margin:10px 0 6px">📊 Radar de competências (0-10)</div>
    ${radarKeys.map(k=>`
      <div style="margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text3)"><span>${k}</span><span>${radar[k]}</span></div>
        <div class="goalbar-track"><div class="goalbar-fill" style="width:${Math.max(0,Math.min(100,(Number(radar[k])||0)/10*100))}%"></div></div>
      </div>`).join('')}

    <button data-noaccordion class="btn btn-ghost btn-block" style="margin-top:10px" onclick="openMapeamentoModal('${chatterId}')">🔁 Refazer mapeamento</button>
  `;
  return fichaAccordion('mapeamento-'+chatterId,'border:2px solid var(--accent)',
    `<div><div class="panel-title">🎯 Mapeamento de Performance</div><div class="panel-note">Gerado em ${m.date||''} · <b>${perfisTxt||'-'}</b></div></div>`,
    body
  );
}

function formatFichaSnapshot(snap){
  const lines=[];
  if(snap.tech)Object.entries(snap.tech).forEach(([k,v])=>{if(v)lines.push(`${k}: ${v}`);});
  if(snap.behavior)Object.entries(snap.behavior).forEach(([k,v])=>{if(v)lines.push(`${k}: ${v}`);});
  if(snap.potential)Object.entries(snap.potential).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!=='')lines.push(`${k}: ${v?'Sim':'Não'}`);});
  if(snap.risk)Object.entries(snap.risk).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!=='')lines.push(`${k}: ${v?'Sim':'Não'}`);});
  return lines.join(' · ')||'Sem dados';
}
function saveFicha(chatterId){
  if(!S.chatterFichas[chatterId])S.chatterFichas[chatterId]={tech:{},behavior:{},potential:{},risk:{},history:[]};
  const f=S.chatterFichas[chatterId];
  ['conversao','ticket','resposta','evolucao'].forEach(k=>{const el=document.getElementById(`ficha-tech-${k}-${chatterId}`);if(el)f.tech[k]=el.value;});
  ['intensidade','comunicacao','comprometimento','energia'].forEach(k=>{const el=document.getElementById(`ficha-behavior-${k}-${chatterId}`);if(el)f.behavior[k]=el.value;});
  save();
}
function saveFichaBool(chatterId,store,key,value){
  if(!S.chatterFichas[chatterId])S.chatterFichas[chatterId]={tech:{},behavior:{},potential:{},risk:{},history:[]};
  S.chatterFichas[chatterId][store][key]=value;
  save();renderFichaChatter(chatterId);
}
function saveFichaSnapshot(chatterId){
  saveFicha(chatterId);
  const f=S.chatterFichas[chatterId];
  const today=todayKey();
  const snap={date:today,tech:{...f.tech},behavior:{...f.behavior},potential:{...f.potential},risk:{...f.risk}};
  if(!f.history)f.history=[];
  // Nunca duplica: se já existe um snapshot de hoje, substitui em vez de
  // adicionar outro — clicar "salvar" várias vezes no mesmo dia não deve
  // acumular cópias idênticas.
  const idx=f.history.findIndex(h=>h&&h.date===today);
  if(idx!==-1)f.history[idx]=snap;
  else f.history.push(snap);
  save();renderFichaChatter(chatterId);toast('✅ Snapshot salvo!');
}

function renderExtra(){
  const wd=getWeekDates();
  document.getElementById('extra-sub').textContent=`Semana ${wd[0].getDate()}/${wd[0].getMonth()+1}–${wd[6].getDate()}/${wd[6].getMonth()+1}`;
  const wkey=getWeekKey();
  const vagas=getHoraExtraVagas();
  const slots=S.horaExtraSlots[wkey]||[];
  const DAY_LABELS={seg:'Segunda',ter:'Terça',qua:'Quarta',qui:'Quinta',sex:'Sexta',sab:'Sábado',dom:'Domingo'};

  // Badge
  const vagasBadge=document.getElementById('extra-vagas-badge');
  if(vagasBadge)vagasBadge.textContent=`${vagas.length} vaga${vagas.length!==1?'s':''}`;

  // Total extra revenue
  const totalExtra=slots.reduce((sum,x)=>sum+(parseFloat(x.revenue)||0),0);
  const totalBadge=document.getElementById('extra-total-badge');
  if(totalBadge)totalBadge.textContent=moneyShort(totalExtra);

  // Vagas disponíveis
  const vagasList=document.getElementById('extra-vagas-list');
  if(vagasList){
    if(!vagas.length){
      vagasList.innerHTML='<div class="empty"><div class="empty-tx">Nenhuma vaga — cadastre turnos com dia de folga na aba Turno</div></div>';
    } else {
      vagasList.innerHTML=vagas.map(v=>{
        const slot=getExtraSlotId(v.shiftId,v.slotIdx)||{};
        const atribuido=slot.chatterId?S.chatters.find(c=>c.id===slot.chatterId):null;
        const isDone=slot.done||false;
        return`<div style="background:${isDone?'var(--bg-soft)':'var(--warn-soft)'};border-radius:10px;padding:12px;margin-bottom:8px;border-left:3px solid ${isDone?'var(--ok)':'var(--warn)'};opacity:${isDone?'0.7':'1'}">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div>
              <div style="font-weight:700;font-size:13px">${DAY_LABELS[v.folgaDia]||v.folgaDia} · ${v.start}–${v.end}</div>
              <div style="font-size:11.5px;color:var(--text2)">Folga de ${v.chatterName}${v.slotIdx===2?' (2º turno)':''}</div>
            </div>
            <button onclick="toggleExtraDone('${v.shiftId}',${v.slotIdx})" style="width:26px;height:26px;border-radius:6px;border:2px solid ${isDone?'var(--ok)':'var(--warn)'};background:${isDone?'var(--ok)':'transparent'};cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center">
              ${isDone?'<span style="color:#fff">✓</span>':''}
            </button>
          </div>
          <div class="field" style="margin-bottom:6px">
            <label class="flabel">Quem cobriu</label>
            <select class="fselect" onchange="saveExtraSlot('${v.shiftId}',${v.slotIdx},'chatterId',this.value)">
              <option value="">— selecionar chatter —</option>
              ${S.chatters.filter(c=>c.id!==v.chatterId).map(c=>`<option value="${c.id}" ${slot.chatterId===c.id?'selected':''}>${c.name}</option>`).join('')}
            </select>
          </div>
          ${atribuido?`
          <div class="fgrid2">
            <div class="field">
              <label class="flabel">Faturamento (R$)</label>
              <input type="number" inputmode="decimal" class="finput" style="font-family:var(--font-mono)" value="${slot.revenue||''}" placeholder="0"
                onblur="saveExtraSlot('${v.shiftId}',${v.slotIdx},'revenue',parseFloat(this.value)||0)">
            </div>
            <div class="field">
              <label class="flabel">Modelo</label>
              <select class="fselect" onchange="saveExtraSlot('${v.shiftId}',${v.slotIdx},'modelId',this.value)">
                <option value="">—</option>
                ${S.models.map(m=>`<option value="${m.id}" ${slot.modelId===m.id?'selected':''}>${m.emoji} ${m.name}</option>`).join('')}
              </select>
            </div>
          </div>`:''}
        </div>`;
      }).join('');
    }
  }

  // Hora extra atribuída: shift-based + parsed from team reports
  const atribuidos=vagas.filter(v=>{const s=getExtraSlotId(v.shiftId,v.slotIdx);return s&&s.chatterId;});
  // Parsed slots (from team reports, shiftId='parsed')
  const parsedSlots=slots.filter(x=>x.shiftId==='parsed'&&x.chatterId&&(parseFloat(x.revenue)||0)>0);

  const atribList=document.getElementById('extra-atribuida-list');
  if(atribList){
    const hasAny=atribuidos.length||parsedSlots.length;
    if(!hasAny){
      atribList.innerHTML='<div style="color:var(--text3);font-size:12.5px;padding:8px 0">Nenhuma hora extra atribuída ainda</div>';
    } else {
      let html='';
      // Shift-based slots
      if(atribuidos.length){
        html+=atribuidos.map(v=>{
          const slot=getExtraSlotId(v.shiftId,v.slotIdx)||{};
          const worker=S.chatters.find(c=>c.id===slot.chatterId);
          const model=S.models.find(m=>m.id===slot.modelId);
          return`<div class="reprow">
            <div>
              <div style="font-weight:700;font-size:13px">${worker?worker.name:'?'}</div>
              <div style="font-size:11.5px;color:var(--text2)">${DAY_LABELS[v.folgaDia]||v.folgaDia} · ${v.start}–${v.end}${model?` · ${model.emoji} ${model.name}`:''}</div>
            </div>
            <div style="font-family:var(--font-mono);font-weight:800;color:var(--ok)">${moneyShort(parseFloat(slot.revenue)||0)}</div>
          </div>`;
        }).join('');
      }
      // Parsed slots from team reports
      if(parsedSlots.length){
        html+=`<div style="font-size:11px;font-weight:700;color:var(--info);text-transform:uppercase;letter-spacing:.04em;margin:10px 0 6px">📨 Importado dos relatórios</div>`;
        html+=parsedSlots.map(slot=>{
          const worker=S.chatters.find(c=>c.id===slot.chatterId);
          const model=S.models.find(m=>m.id===slot.modelId);
          return`<div class="reprow">
            <div>
              <div style="font-weight:700;font-size:13px">${worker?worker.name:'?'}</div>
              <div style="font-size:11.5px;color:var(--text2)">${slot.dateKey||''} ${model?`· ${model.emoji} ${model.name}`:''}</div>
            </div>
            <div style="font-family:var(--font-mono);font-weight:800;color:var(--ok)">${moneyShort(parseFloat(slot.revenue)||0)}</div>
          </div>`;
        }).join('');
      }
      atribList.innerHTML=html;
    }
  }

  // Faturamento breakdown por chatter (shift-based + parsed)
  const fatBreak=document.getElementById('extra-fat-breakdown');
  if(fatBreak){
    const byChatter={};
    atribuidos.forEach(v=>{
      const slot=getExtraSlotId(v.shiftId,v.slotIdx)||{};
      if(!slot.chatterId)return;
      const model=S.models.find(m=>m.id===slot.modelId);
      if(!byChatter[slot.chatterId])byChatter[slot.chatterId]={total:0,models:{}};
      byChatter[slot.chatterId].total+=parseFloat(slot.revenue)||0;
      if(model){
        byChatter[slot.chatterId].models[model.id]=(byChatter[slot.chatterId].models[model.id]||0)+(parseFloat(slot.revenue)||0);
      }
    });
    parsedSlots.forEach(slot=>{
      if(!slot.chatterId)return;
      const model=S.models.find(m=>m.id===slot.modelId);
      if(!byChatter[slot.chatterId])byChatter[slot.chatterId]={total:0,models:{}};
      byChatter[slot.chatterId].total+=parseFloat(slot.revenue)||0;
      if(model){
        byChatter[slot.chatterId].models[model.id]=(byChatter[slot.chatterId].models[model.id]||0)+(parseFloat(slot.revenue)||0);
      }
    });
    const entries=Object.entries(byChatter);
    if(!entries.length){
      fatBreak.innerHTML='<div style="color:var(--text3);font-size:12.5px;padding:8px 0">Nenhum faturamento de hora extra registrado</div>';
    } else {
      fatBreak.innerHTML=entries.map(([cid,data])=>{
        const c=S.chatters.find(ch=>ch.id===cid);
        const modelBreakdown=Object.entries(data.models).map(([mid,val])=>{
          const m=S.models.find(mm=>mm.id===mid);
          return`<div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--text2);padding:2px 0 2px 12px">
            <span>${m?`${m.emoji} ${m.name}`:mid}</span>
            <span style="font-family:var(--font-mono)">${moneyShort(val)}</span>
          </div>`;
        }).join('');
        return`<div style="margin-bottom:8px">
          <div class="reprow"><div class="replb" style="font-weight:700">${c?c.name:'?'}</div><div class="repval" style="color:var(--ok);font-weight:800">${money(data.total)}</div></div>
          ${modelBreakdown}
        </div>`;
      }).join('')+`<div class="reprow" style="border-top:2px solid var(--line);margin-top:6px;padding-top:8px"><div class="replb" style="font-weight:800">Total hora extra</div><div class="repval" style="color:var(--ok);font-weight:800">${money(totalExtra+(parsedSlots.reduce((s,x)=>s+(parseFloat(x.revenue)||0),0)))}</div></div>`;
    }
  }
}
function saveAbsence(){
  const chatterId=document.getElementById('abs-chatter').value,type=document.getElementById('abs-type').value;
  const date=document.getElementById('abs-date').value,note=document.getElementById('abs-note').value.trim();
  if(!chatterId||!date){toast('⚠️ Preencha os campos');return;}
  S.absences.push({id:'a'+Date.now(),chatterId,type,date,note});save();
  closeModal('m-absence');document.getElementById('abs-date').value='';document.getElementById('abs-note').value='';
  toast('✅ Registrado!');renderAbsenceListWithJustificativa();renderHome();
}
function saveOrientation(){
  const chatterId=document.getElementById('orient-chatter').value,text=document.getElementById('orient-text').value.trim();
  if(!chatterId||!text){toast('⚠️ Preencha os campos');return;}
  S.orientations.push({id:'o'+Date.now(),chatterId,text,shift:document.getElementById('orient-shift').value,goal:document.getElementById('orient-goal').value,date:todayKey()});
  save();closeModal('m-orient');document.getElementById('orient-text').value='';document.getElementById('orient-goal').value='';
  toast('✅ Orientação salva!');renderOrientList();
}
function deleteOrientation(id){S.orientations=S.orientations.filter(o=>o.id!==id);save();renderOrientList();renderTaskBoards();toast('Removida');}
function saveStudy(){
  const title=document.getElementById('study-title').value.trim();if(!title){toast('⚠️ Título obrigatório');return;}
  S.studies.push({id:'st'+Date.now(),title,category:document.getElementById('study-cat').value,priority:document.getElementById('study-prio').value,done:false});
  save();closeModal('m-study');document.getElementById('study-title').value='';toast('✅ Adicionado!');renderStudyList();
}
function toggleStudy(id){const s=S.studies.find(st=>st.id===id);if(s){s.done=!s.done;save();renderStudyList();}}
function deleteStudy(id){S.studies=S.studies.filter(s=>s.id!==id);save();renderStudyList();toast('Removido');}
function saveRevenue(chatterId,modelId,value,dateKey){
  const key=`${chatterId}_${modelId}_${dateKey||selectedFatDate||todayKey()}`;
  S.revenues[key]=parseFloat(value)||0;
  save();
  // Refresh totals in the table row without full re-render
  renderHome();
}
function saveOvertime(){
  const chatterId=document.getElementById('ot-chatter').value;
  const start=document.getElementById('ot-start').value,end=document.getElementById('ot-end').value;
  const date=document.getElementById('ot-date').value,note=document.getElementById('ot-note').value.trim();
  if(!chatterId||!start||!date){toast('⚠️ Preencha os campos');return;}
  if(!S.turnoLog[date])S.turnoLog[date]=[];
  S.turnoLog[date].push({id:'tl'+Date.now()+Math.random().toString(36).slice(2,6),chatterId,action:'overtime',time:start,otEnd:end,note});
  save();closeModal('m-overtime');document.getElementById('ot-note').value='';
  const c=S.chatters.find(ch=>ch.id===chatterId);
  toast(`⏱ Hora extra de ${c?c.name:'?'} registrada!`);renderTurnoBoard();renderHome();
}

// ---------- data helpers ----------
function getTodayTotalRevenue(){
  const today=todayKey();let t=0;
  S.chatters.forEach(c=>S.models.forEach(m=>{t+=parseFloat(S.revenues[`${c.id}_${m.id}_${today}`])||0;}));
  // Include today's hora extra in daily total
  const wkey=getWeekKey();
  (S.horaExtraSlots[wkey]||[]).filter(x=>x.shiftId==='parsed'&&x.dateKey===today).forEach(x=>t+=parseFloat(x.revenue)||0);
  return t;
}
// Revenue for META calculation — EXCLUDES hora extra (extra doesn't count toward goal)
// Estimativa automática do valor em R$ de vendas high-ticket na semana,
// a partir do % médio de high-ticket já calculado pelos relatórios processados.
// % de high ticket PONDERADO pelo faturamento real da semana (não é uma
// média simples entre os dias — um dia de 1 venda não pesa igual a um dia
// de 30 vendas). Já soma normal + hora extra, porque venda alta é venda
// alta não importa a "caixinha" de pagamento — os 8% valem pra qualquer uma.
// % de High Ticket correto: soma o R$ de vendas high-ticket e o R$ total do
// período, e divide no final — NUNCA soma as porcentagens de cada dia e
// tira média (isso distorce muito em dias com poucas vendas).
function weightedHighTicketPct(analytics,dateKeys){
  let ht=0,rev=0;
  dateKeys.forEach(dk=>{
    const a=analytics[dk];
    if(a){ht+=a.highTicketTotal||0;rev+=(a.chatterTotal||0)+(a.extraTotal||0);}
  });
  return rev>0?Math.round(ht/rev*100):0;
}
function getChatterWeekHighTicket(chatterId,offset){
  const f=S.chatterFichas[chatterId];
  const analytics=f?.analytics?.weeklyData||{};
  const wd=getWeekDates(offset);
  let htTotal=0,totalRev=0;
  wd.forEach(d=>{
    const dk=fmt(d);
    const a=analytics[dk];
    if(a){
      htTotal+=a.highTicketTotal!=null?a.highTicketTotal:0;
      totalRev+=(a.chatterTotal||0)+(a.extraTotal||0);
    }
  });
  const avgHtPct=totalRev>0?Math.round((htTotal/totalRev)*100):0;
  return{avgHtPct,htTotal};
}
// Medalha automática — baseada no % da meta semanal batida (mesmos degraus do prêmio)
// Mantida só por retrocompatibilidade (nada mais chama esta função a partir
// de 04/08/2026 — ver autoMedalForChatter abaixo, que é a régua atual).
function autoMedalForPct(pct){
  if(pct>=130)return 4; // 💎 Diamante
  if(pct>=100)return 3; // 🥇 Ouro
  if(pct>=85)return 2;  // 🥈 Prata
  if(pct>=70)return 1;  // 🥉 Bronze
  return 0;             // Sem medalha
}
// ---------- NOVA REGRA DE MEDALHAS (pedido 04/08/2026) ----------
// Substitui inteiramente a régua por % de meta semanal (acima) em todo
// lugar que decide a medalha (Pagamento, Evolução, myperformance, IA,
// simuladores). Regra combinada, confirmada com a gestora:
//  · Ouro    = faturamento do MÊS (turno+extra) ≥ R$24.000 — sozinho,
//              não depende de categoria nem de semanas seguidas.
//  · Diamante= faturamento do MÊS ≥ R$35.000 — mesma ideia, tem
//              prioridade sobre Ouro (se bateu os dois, vale o maior).
//  · Bronze  = categoria B cadastrada na Ficha do chatter E bateu 100%+
//              da própria meta semanal da categoria B nas últimas 3
//              semanas seguidas (semana atual + as 2 anteriores).
//  · Prata   = mesma coisa, categoria C.
//  · Categorias A/D/E não têm degrau de bronze/prata por semanas — só
//    entram no jogo se o faturamento do mês bater Ouro/Diamante.
// O override manual da gestora (dropdown de medalha em Pagamento) continua
// funcionando por cima disso, sem mudança.
function autoMedalForChatter(cid,cat,monthRevenueForGate){
  const monthRev=monthRevenueForGate||0;
  if(monthRev>=35000)return 4; // 💎 Diamante
  if(monthRev>=24000)return 3; // 🥇 Ouro
  if(cat==='B'||cat==='C'){
    const catData=PAG_CATS[cat];
    for(let o=0;o>-3;o--){
      if(getChatterWeekRevenue(cid,o)<catData.n100)return 0;
    }
    return cat==='C'?2:1; // Prata=2, Bronze=1
  }
  return 0;
}
function getChatterWeekRevenue(id,offset){
  let t=0;
  getWeekDates(offset).forEach(d=>{
    const dk=fmt(d);
    const fin=getChatterDayRevenueFinanceiro(id,dk);
    if(fin){t+=fin.turno;return;}
    S.models.forEach(m=>{t+=parseFloat(S.revenues[`${id}_${m.id}_${dk}`])||0;});
  });
  return t;
}
// Revenue for DISPLAY — INCLUDES hora extra
function getChatterWeekRevenueTotal(id){
  return getChatterWeekRevenue(id)+getChatterExtraRevenue(id);
}
function getWeekAbsencesData(){
  const wd=getWeekDates();
  const wkStart=fmt(wd[0]),wkEnd=fmt(wd[6]);
  return S.absences.filter(a=>a.date>=wkStart&&a.date<=wkEnd);
}

/* ===========================================================
   TESTERS — 3-day test window: the first 3 dates (chronologically,
   across all recorded history) where a tester logged revenue.
   =========================================================== */
function getTesterTestDays(chatterId){
  const dateTotals={};
  Object.keys(S.revenues).forEach(key=>{
    const parts=key.split('_');
    if(parts.length<3)return;
    if(parts[0]!==chatterId)return;
    const dateKey=parts.slice(2).join('_');
    const val=parseFloat(S.revenues[key])||0;
    if(val<=0)return;
    dateTotals[dateKey]=(dateTotals[dateKey]||0)+val;
  });
  const dates=Object.keys(dateTotals).sort().slice(0,3);
  return dates.map(dk=>({date:dk,revenue:dateTotals[dk]}));
}
function getTesterAnalysis(chatterId){
  const testDays=getTesterTestDays(chatterId);
  const f=S.chatterFichas[chatterId]||{};
  const analytics=f?.analytics?.weeklyData||{};
  let ticketSum=0,vphSum=0,highSum=0,maxGap=0,daysWithData=0,totalVendas=0,totalRev=0,htTotal=0;
  testDays.forEach(({date,revenue})=>{
    totalRev+=revenue;
    const a=analytics[date];
    if(a){
      totalVendas+=a.totalVendas||0;
      htTotal+=a.highTicketTotal||0;
      if(a.ticketMedio>0){ticketSum+=a.ticketMedio;vphSum+=a.vendasPorHora||0;highSum+=a.highTicketPct||0;daysWithData++;}
      if((a.maxGapMin||0)>maxGap)maxGap=a.maxGapMin||0;
    }
  });
  return{
    testDays,totalRev,daysWithData,totalVendas,maxGap,htTotal,
    avgTicket:daysWithData>0?ticketSum/daysWithData:0,
    avgVph:daysWithData>0?Math.round(vphSum/daysWithData*100)/100:0,
    avgHigh:daysWithData>0?Math.round(highSum/daysWithData):0,
  };
}

// ---------- chips ----------
document.querySelectorAll('.chip').forEach(chip=>chip.addEventListener('click',()=>chip.classList.toggle('sel')));

// ---------- INIT ----------
// Rede de segurança global: se algum erro não tratado acontecer durante o
// uso (não durante o carregamento inicial), avisa em vez de deixar a tela
// travada/apagada em silêncio — e reforça que o autosave contínuo já
// protege o que foi digitado/gravado até aqui.
window.addEventListener('error',e=>{
  console.error('Erro não tratado:',e.error||e.message);
  try{toast('⚠️ Ocorreu um erro inesperado. Seus dados já salvos continuam seguros — se a tela travar, recarregue a página.',6000);}catch(_){}
});
window.addEventListener('unhandledrejection',e=>{
  console.error('Promise rejeitada sem tratamento:',e.reason);
});
load();
// Limpa duplicatas/lixo acumulado e salva uma vez logo na abertura do app —
// não espera nenhuma ação do usuário, pra nunca depender de "clicar em algo"
// pra corrigir o documento.
pruneHeavyData(S);
save();
initFirebaseWithRetry();
// Segurança: nunca deixa a tela de carregamento travada pra sempre (ex: sem
// internet) — depois de um tempo, libera o app pra funcionar com o que tiver
// localmente, mesmo que o Firebase ainda não tenha respondido. Esse prazo é
// maior que o timeout do Firebase (8s) de propósito, pra dar tempo da
// mensagem de erro real aparecer antes de esconder a tela.
setTimeout(()=>{
  const overlay=document.getElementById('initial-load-overlay');
  if(!overlay||overlay.querySelector('button'))return; // já foi liberado ou já mostra um erro
  if(fbHasReceivedFirstSnapshot){hideInitialLoadOverlay();return;}
  // Passou do tempo e a sincronização NÃO terminou, mas também não caiu no
  // callback de erro — mostra exatamente o status de cada uma das 4 partes,
  // em vez de simplesmente liberar a tela vazia em silêncio.
  const rows=ALL_SYNC_DOC_IDS.map(id=>`<div style="display:flex;justify-content:space-between;gap:10px;font-size:11px;padding:3px 0"><span style="color:var(--text3)">${id}</span><span>${fbDocsStatus[id]||'sem resposta'}</span></div>`).join('');
  overlay.innerHTML=`<div style="max-width:340px;text-align:center;padding:0 20px">
    <div style="font-size:28px;margin-bottom:10px">⏱️</div>
    <div style="font-size:13px;font-weight:700;margin-bottom:10px">Demorou demais pra sincronizar</div>
    <div style="text-align:left;background:var(--bg-soft);border-radius:8px;padding:10px 12px;margin-bottom:14px">${rows}</div>
    <button onclick="hideInitialLoadOverlay()" class="btn btn-primary btn-sm">Continuar mesmo assim</button>
  </div>`;
},10000);
document.getElementById('abs-date').value=todayKey();

if(!S.hasSeededStudies&&!S.studies.length){
  S.studies=[
    {id:'st1',title:'Liderança Situacional — adaptar estilo ao nível do liderado',category:'liderança',priority:'alta',done:false},
    {id:'st2',title:'Feedback eficaz: SBI (Situação, Comportamento, Impacto)',category:'comunicacao',priority:'alta',done:false},
    {id:'st3',title:'Preparar treinamento: técnicas de retenção para chatters júniores',category:'treinamento',priority:'media',done:false},
    {id:'st4',title:'Gestão de tempo: matriz de Eisenhower',category:'gestao',priority:'media',done:false},
    {id:'st5',title:'Técnicas de vendas conversacionais',category:'vendas',priority:'alta',done:false},
  ];
  S.hasSeededStudies=true;
  save();
}

updateClock();setInterval(updateClock,1000);
renderHome();

/* ===========================================================
   MANAGER PROFILE
   =========================================================== */
function renderManagerProfile(){
  const el=document.getElementById('manager-profile-display');
  if(!el)return;
  const p=S.managerProfile||{};
  if(!p.name&&!p.cargo){
    el.innerHTML='<div style="color:var(--text3);font-size:13px;text-align:center;padding:8px">Clique em editar para configurar seu perfil</div>';
    return;
  }
  el.innerHTML=`<div style="display:flex;align-items:center;gap:14px">
    <div style="width:56px;height:56px;border-radius:50%;overflow:hidden;background:var(--bg-soft);border:2px solid var(--line);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:24px">
      ${p.photoUrl?`<img src="${p.photoUrl}" style="width:100%;height:100%;object-fit:cover">`:'👤'}
    </div>
    <div><div style="font-weight:800;font-size:16px">${p.name||'Gestor'}</div>
    <div style="font-size:12.5px;color:var(--text2)">${p.cargo||''}</div></div>
  </div>`;
}
function openManagerProfileModal(){
  const p=S.managerProfile||{};
  const nameEl=document.getElementById('mgr-name');
  const cargoEl=document.getElementById('mgr-cargo');
  if(nameEl)nameEl.value=p.name||'';
  if(cargoEl)cargoEl.value=p.cargo||'';
  const preview=document.getElementById('mgr-photo-preview');
  if(preview&&p.photoUrl)preview.innerHTML=`<img src="${p.photoUrl}" style="width:100%;height:100%;object-fit:cover">`;
  openModal('m-manager-profile');
}
function loadManagerPhoto(input){
  const file=input.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=e=>{
    // Redimensiona e comprime antes de salvar — uma foto de celular sem
    // compressão pode passar de 1MB sozinha e travar a sincronização de
    // TODOS os dados no Firestore (o app guarda tudo em um único documento
    // com limite de 1MB). Limitando a 240px + JPEG 0.7 fica bem abaixo disso.
    const img=new Image();
    img.onload=()=>{
      const maxDim=240;
      const scale=Math.min(1,maxDim/Math.max(img.width,img.height));
      const canvas=document.createElement('canvas');
      canvas.width=Math.round(img.width*scale);
      canvas.height=Math.round(img.height*scale);
      const ctx=canvas.getContext('2d');
      ctx.drawImage(img,0,0,canvas.width,canvas.height);
      const compressed=canvas.toDataURL('image/jpeg',0.7);
      const preview=document.getElementById('mgr-photo-preview');
      if(preview)preview.innerHTML=`<img src="${compressed}" style="width:100%;height:100%;object-fit:cover">`;
      if(!S.managerProfile)S.managerProfile={};
      S.managerProfile.photoUrl=compressed;
      toast(`📷 Foto otimizada (${Math.round(compressed.length/1024)}KB)`);
    };
    img.onerror=()=>toast('⚠️ Não foi possível processar essa imagem');
    img.src=e.target.result;
  };
  reader.readAsDataURL(file);
}
function saveManagerProfile(){
  if(!S.managerProfile)S.managerProfile={};
  S.managerProfile.name=document.getElementById('mgr-name')?.value||'';
  S.managerProfile.cargo=document.getElementById('mgr-cargo')?.value||'';
  save();closeModal('m-manager-profile');
  renderManagerProfile();toast('✅ Perfil salvo!');
}

/* ===========================================================
   DEMANDAS 2 — with dates and 48h alerts
   =========================================================== */
function renderDemandas2(){
  const el=document.getElementById('demandas2-list');
  if(!el)return;
  const items=Array.isArray(S.demandas2)?S.demandas2:[];
  if(!items.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Nenhuma demanda</div>';return;}
  el.innerHTML=items.map(item=>{
    return`<div style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">
      <button onclick="toggleDemanda2('${item.id}')" style="width:22px;height:22px;border-radius:5px;border:2px solid ${item.done?'var(--ok)':'var(--line)'};background:${item.done?'var(--ok)':'transparent'};cursor:pointer;flex-shrink:0;margin-top:2px;display:flex;align-items:center;justify-content:center">${item.done?'<span style="color:#fff;font-size:11px">✓</span>':''}</button>
      <div style="flex:1">
        <div style="font-size:13.5px;${item.done?'text-decoration:line-through;color:var(--text3)':''}">${item.text}</div>
      </div>
      <button onclick="removeDemanda2('${item.id}')" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:13px">✕</button>
    </div>`;
  }).join('');
}
function isWithin48h(dateStr){
  const d=new Date(dateStr+'T23:59:00');
  const diff=d-new Date();
  return diff>0&&diff<=48*3600*1000;
}
function addDemanda2(){
  const text=document.getElementById('demandas2-text')?.value.trim();
  if(!text)return;
  if(!Array.isArray(S.demandas2))S.demandas2=[];
  S.demandas2.push({id:'d2'+Date.now(),text,done:false});
  const el=document.getElementById('demandas2-text');if(el)el.value='';
  save();renderDemandas2();
}
function toggleDemanda2(id){
  const item=(S.demandas2||[]).find(x=>x.id===id);
  if(item){item.done=!item.done;save();renderDemandas2();}
}
function removeDemanda2(id){
  if(Array.isArray(S.demandas2))S.demandas2=S.demandas2.filter(x=>x.id!==id);
  save();renderDemandas2();
}
// Botão único do quadro (em vez de data por item): joga um lembrete pronto
// na Agenda pra gestora repassar as questões pendentes ao financeiro — pode
// escolher data e horário nos campos ao lado, ou deixar vazio pra hoje.
function incluirFinanceiroNaAgenda(){
  const dateInput=document.getElementById('demandas2-agenda-date');
  const timeInput=document.getElementById('demandas2-agenda-time');
  const dk=(dateInput&&dateInput.value)||todayKey();
  const time=(timeInput&&timeInput.value)||'';
  if(!S.dailyTasksByDay[dk])S.dailyTasksByDay[dk]=[];
  S.dailyTasksByDay[dk].push({id:'tk'+Date.now()+Math.random().toString(36).slice(2,4),text:'Repassar questões pendentes ao setor financeiro',time,date:'',urgent:false,done:false});
  save();
  renderTaskBoards();
  toast(dk===todayKey()?'✅ Adicionado na agenda de hoje':`✅ Adicionado na agenda de ${dk.split('-').reverse().join('/')}`);
}
// Mesmo mecanismo, agora pro quadro de Requisições para modelos.
function incluirModelRequestsNaAgenda(){
  const dateInput=document.getElementById('modelreq-agenda-date');
  const timeInput=document.getElementById('modelreq-agenda-time');
  const dk=(dateInput&&dateInput.value)||todayKey();
  const time=(timeInput&&timeInput.value)||'';
  if(!S.dailyTasksByDay[dk])S.dailyTasksByDay[dk]=[];
  S.dailyTasksByDay[dk].push({id:'tk'+Date.now()+Math.random().toString(36).slice(2,4),text:'Revisar requisições pendentes para os modelos',time,date:'',urgent:false,done:false});
  save();
  renderTaskBoards();
  toast(dk===todayKey()?'✅ Adicionado na agenda de hoje':`✅ Adicionado na agenda de ${dk.split('-').reverse().join('/')}`);
}

/* ===========================================================
   ESTRATÉGIA — DIAGNÓSTICO AUTOMÁTICO DA EQUIPE
   Responde "o que eu deveria fazer hoje?": gera prioridades,
   status por chatter (🟢 evolução / 🟡 estagnado / 🔴 queda /
   ⚫ risco de sair), uma ação sugerida (a partir do erro mais
   recorrente no ChatLab) e os gargalos detectáveis com os dados
   já existentes. Tudo derivado de dados já salvos — sem chamar
   IA, pra responder na hora e não gastar cota.
   =========================================================== */
function getEstrategiaChatters(){
  return S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
}
function calcChatterPctMeta(c,offset){
  const wkey=getWeekKey(offset);
  const goals=S.chatterWeekGoals[wkey]||{};
  const f=S.chatterFichas[c.id];
  const cat=f?.pagCategoria||'B';
  const metaManual=parseFloat(goals[c.id])||0;
  const meta=metaManual>0?metaManual:(PAG_CATS[cat]?.n100||0);
  const rev=getChatterWeekRevenue(c.id,offset);
  return meta>0?Math.round(rev/meta*100):null;
}
// % da semana já "andada" — pra semanas passadas (offset<0) é sempre 100
// (semana fechada); pra semana atual (offset 0) é proporcional ao dia de
// hoje. Sem isso, comparar o % da meta batido na terça-feira com a meta
// da semana inteira faria todo mundo parecer "em risco" só por ainda ser
// início de semana — o que não é justo nem verdadeiro.
function getWeekProgressPct(offset){
  if(offset<0)return 100;
  const dow=new Date().getDay(); // 0=dom...6=sáb
  const diasElapsed=dow===0?7:dow;
  return Math.min(100,(diasElapsed/7)*100);
}
// Ritmo relativo ao esperado pra essa altura da semana (100 = exatamente
// no ritmo pra bater a meta; abaixo de 100 = atrasado; acima = adiantado).
// É isso que deve ser usado pra classificar status/risco — o % bruto da
// meta (calcChatterPctMeta) só serve como dado de apoio no texto.
function calcChatterRitmo(c,offset){
  const pct=calcChatterPctMeta(c,offset);
  if(pct==null)return null;
  const progresso=getWeekProgressPct(offset);
  return progresso>0?Math.round((pct/progresso)*100):pct;
}
function calcChatterAvgTicket(c,offset){
  const f=S.chatterFichas[c.id];
  const wd=getWeekDates(offset);
  const analytics=f?.analytics?.weeklyData||{};
  let ticketSum=0,days=0;
  wd.forEach(d=>{const a=analytics[fmt(d)];if(a&&a.ticketMedio>0){ticketSum+=a.ticketMedio;days++;}});
  return days>0?ticketSum/days:0;
}
function calcChatterDiagnostico(c){
  const pctNow=calcChatterPctMeta(c,0);
  const pctPrev=calcChatterPctMeta(c,-1);
  const ritmoNow=calcChatterRitmo(c,0);
  const ritmoPrev=calcChatterRitmo(c,-1);
  const delta=(ritmoNow!=null&&ritmoPrev!=null)?ritmoNow-ritmoPrev:null;
  const mNow=calcMetricasSemana(coletarAnalisesDaSemana(c.id,0));
  const mPrev=calcMetricasSemana(coletarAnalisesDaSemana(c.id,-1));
  const igpDelta=(mNow.avgIGP!=null&&mPrev.avgIGP!=null)?mNow.avgIGP-mPrev.avgIGP:null;

  let status='semdados',label='⚪ Sem dados suficientes',cor='var(--text3)',motivo='Ainda não há faturamento ou ChatLab suficiente essa semana pra avaliar.';
  if(ritmoNow!=null){
    const contexto=`(fez ${pctNow}% da meta da semana até agora)`;
    if(ritmoNow<55&&(delta==null||delta<=0)){
      status='risco';label='⚫ Alto risco de sair';cor='#3a3a3a';
      motivo=`Está a só ${ritmoNow}% do ritmo esperado pra essa altura da semana ${contexto}${delta!=null?(delta<0?`, caindo em relação ao mesmo ritmo da semana passada`:', sem sinal de melhora'):''}${igpDelta!=null&&igpDelta<0?' e o atendimento no ChatLab também piorou':''}.`;
    } else if(delta!=null&&delta<=-15){
      status='queda';label='🔴 Em queda';cor='var(--bad)';
      motivo=`Caiu ${Math.abs(Math.round(delta))}pp de ritmo em relação à semana passada ${contexto}.`;
    } else if((delta!=null&&delta>=10)||ritmoNow>=100){
      status='evolucao';label='🟢 Em evolução';cor='var(--ok)';
      motivo=(delta!=null&&delta>=10)?`Subiu ${Math.round(delta)}pp de ritmo em relação à semana passada ${contexto}.`:`No ritmo certo pra bater a meta ${contexto}.`;
    } else {
      status='estagnado';label='🟡 Estagnado';cor='var(--warn)';
      motivo=`No ritmo de ${ritmoNow}% do esperado, sem variação significativa em relação à semana passada ${contexto}.`;
    }
  }
  // Ação sugerida — a partir do erro mais recorrente no ChatLab (essa semana + anterior)
  const recentAnalises=[...coletarAnalisesDaSemana(c.id,0),...coletarAnalisesDaSemana(c.id,-1)];
  const errosTally={};
  recentAnalises.forEach(a=>{if(a.tags?.principalErro)errosTally[a.tags.principalErro]=(errosTally[a.tags.principalErro]||0)+1;});
  const maiorErro=Object.entries(errosTally).sort((a,b)=>b[1]-a[1])[0];
  let acao=null;
  if(maiorErro){
    acao=`Foco em "${maiorErro[0]}" — foi o erro mais recorrente no ChatLab recentemente (${maiorErro[1]}x). Sugestão: revisar 2-3 conversas com essa pessoa e fazer um roleplay rápido sobre isso.`;
  } else if(status==='queda'||status==='risco'){
    acao='Sem análises recentes do ChatLab pra apontar uma causa específica — vale rodar uma auditoria de conversa dela essa semana.';
  } else if(status==='estagnado'){
    acao='Sem um erro técnico se repetindo — pode ser falta de volume/leads mais do que técnica. Vale um 1:1 rápido pra entender o que está travando.';
  }
  return{chatter:c,status,label,cor,motivo,acao,pctNow,pctPrev,ritmoNow,ritmoPrev,delta,igpDelta,mNow};
}
function calcChatterGargalos(c,diag){
  const gargalos=[];
  const avgTicket=calcChatterAvgTicket(c,0);
  if(avgTicket>0&&avgTicket<130)gargalos.push({tipo:'Ticket baixo',detalhe:`Ticket médio de ${money(avgTicket)} essa semana`});
  const taxaConv=diag.mNow.taxaConversao;
  if(taxaConv!=null&&taxaConv<20)gargalos.push({tipo:'Conversão baixa',detalhe:`Só ${taxaConv}% das conversas analisadas no ChatLab converteram essa semana`});
  if(diag.ritmoNow!=null&&diag.ritmoNow<40)gargalos.push({tipo:'Muito abaixo do ritmo',detalhe:`${diag.ritmoNow}% do ritmo esperado pra essa altura da semana — pode ser poucos leads chegando ou tempo demais com clientes sem potencial`});
  return gargalos;
}
function renderEstrategiaDiagnostico(){
  const chatters=getEstrategiaChatters();
  const prioridadesEl=document.getElementById('estrategia-prioridades');
  const diagnosticoEl=document.getElementById('estrategia-diagnostico');
  const gargalosEl=document.getElementById('estrategia-gargalos');
  if(!chatters.length){
    if(prioridadesEl)prioridadesEl.innerHTML='<div style="font-size:12.5px;color:var(--text3)">Sem chatters no time ainda.</div>';
    if(diagnosticoEl)diagnosticoEl.innerHTML='';
    if(gargalosEl)gargalosEl.innerHTML='';
    return;
  }
  const diags=chatters.map(c=>calcChatterDiagnostico(c));
  const ordem={risco:0,queda:1,estagnado:2,semdados:3,evolucao:4};
  const diagsOrdenados=[...diags].sort((a,b)=>ordem[a.status]-ordem[b.status]);

  const prioritarias=diagsOrdenados.filter(d=>d.status==='risco'||d.status==='queda').slice(0,5);
  if(prioridadesEl){
    prioridadesEl.innerHTML=!prioritarias.length
      ?'<div style="font-size:12.5px;color:var(--ok)">✅ Ninguém em queda ou risco essa semana — time estável.</div>'
      :prioritarias.map(d=>`
        <div style="background:var(--bg-soft);border-left:3px solid ${d.cor};border-radius:8px;padding:10px 12px;margin-bottom:8px">
          <div style="font-size:13px;font-weight:700">${d.label} — ${d.chatter.name}</div>
          <div style="font-size:12px;color:var(--text2);margin-top:3px">${d.motivo}</div>
          ${d.acao?`<div style="font-size:11.5px;color:var(--accent-strong);margin-top:5px">👉 ${d.acao}</div>`:''}
        </div>`).join('');
  }

  if(diagnosticoEl){
    diagnosticoEl.innerHTML=diagsOrdenados.map(d=>`
      <div style="display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)">
        <div style="font-size:16px;line-height:1;margin-top:1px">${d.label.split(' ')[0]}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:700">${d.chatter.name} <span style="font-weight:500;color:${d.cor};font-size:11.5px">· ${d.label.replace(/^\S+\s/,'')}</span></div>
          <div style="font-size:12px;color:var(--text2);margin-top:2px">${d.motivo}</div>
          ${d.acao?`<div style="font-size:11.5px;color:var(--text3);margin-top:3px">👉 ${d.acao}</div>`:''}
        </div>
      </div>`).join('');
  }

  if(gargalosEl){
    const gargalosPorChatter=diags.map(d=>({chatter:d.chatter,itens:calcChatterGargalos(d.chatter,d)})).filter(g=>g.itens.length);
    const detectaveis=gargalosPorChatter.length?gargalosPorChatter.map(g=>`
      <div style="margin-bottom:8px">
        <div style="font-size:12.5px;font-weight:700">${g.chatter.name}</div>
        ${g.itens.map(it=>`<div style="font-size:12px;color:var(--text2);padding-left:8px">• <strong>${it.tipo}:</strong> ${it.detalhe}</div>`).join('')}
      </div>`).join(''):'<div style="font-size:12px;color:var(--ok)">✅ Nenhum gargalo automático detectado essa semana.</div>';
    gargalosEl.innerHTML=`
      ${detectaveis}
      <div style="border-top:1px solid var(--line);margin:12px 0 8px"></div>
      <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;margin-bottom:5px">👀 Exigem observação manual (sem dado automático ainda)</div>
      <div style="font-size:11.5px;color:var(--text3);line-height:1.7">
        <div>• <strong>Poucos leads</strong> — o app não conta leads recebidos ainda.</div>
        <div>• <strong>Demora na resposta</strong> — o app mede intervalo entre vendas, não tempo de resposta por mensagem.</div>
        <div>• <strong>Pouca insistência / abandono de conversa</strong> — dá pra notar auditando conversas no ChatLab.</div>
        <div>• <strong>Excesso de desconto</strong> — não existe campo de desconto lançado ainda.</div>
      </div>`;
  }
}

/* ===========================================================
   MEDALHAS — detecta quando um chatter SOBE de medalha (nunca
   avisa em queda) comparando o cálculo automático de hoje com o
   último valor visto. O pagamento já reflete a medalha automática
   sozinho (autoMedalForPct é recalculado ao vivo na aba Pagamento)
   — isso aqui só cuida do aviso pra gestora ficar sabendo.
   =========================================================== */
function checkMedalAchievements(){
  const chatters=getEstrategiaChatters();
  let changed=false;
  chatters.forEach(c=>{
    const catMedal=S.chatterFichas?.[c.id]?.pagCategoria||'B';
    const stMedal=getChatterMonthStats(c.id);
    const medalAtual=autoMedalForChatter(c.id,catMedal,stMedal.monthRevenue+stMedal.monthExtra);
    const anterior=S.chatterLastMedal[c.id]??0;
    if(medalAtual>anterior){
      S.medalAchievements.unshift({
        id:'medal'+Date.now()+Math.random().toString(36).slice(2,6),
        chatterId:c.id,chatterName:c.name,medal:medalAtual,
        wkey:getWeekKey(0),date:new Date().toISOString(),seen:false
      });
      if(S.medalAchievements.length>30)S.medalAchievements.length=30;
      changed=true;
    }
    S.chatterLastMedal[c.id]=medalAtual;
  });
  if(changed)save();
}
function dismissMedalAchievement(id){
  const it=(S.medalAchievements||[]).find(m=>m.id===id);
  if(it){it.seen=true;save();}
  renderMedalNotice('home-medal-notice');
  renderMedalNotice('estrategia-medal-notice');
  if(currentViewName()==='evolucao')renderEvolucao();
}
function renderMedalNotice(containerId){
  const el=document.getElementById(containerId);
  if(!el)return;
  const pendentes=(S.medalAchievements||[]).filter(m=>!m.seen);
  if(!pendentes.length){el.innerHTML='';return;}
  el.innerHTML=pendentes.map(m=>`
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--accent-soft);border-radius:8px;padding:9px 12px;margin-bottom:8px;font-size:12.5px">
      <span>${PAG_MEDAL_LABEL[m.medal]||''} <strong>${m.chatterName}</strong> alcançou uma nova medalha essa semana — já reflete automaticamente no pagamento.</span>
      <button class="btn btn-ghost btn-xs" onclick="dismissMedalAchievement('${m.id}')" title="Marcar como visto">✕</button>
    </div>`).join('');
}

/* ===========================================================
   ESTRATÉGIAS DE LIDERANÇA — substitui o antigo "Motivacional da
   semana" (texto livre por semana) por uma lista de ações reais,
   organizadas por prazo, marcáveis como feitas, editáveis e com
   opção de adicionar mais. Não é escopado por semana — é um board
   vivo que a gestora vai atualizando conforme a situação muda.
   =========================================================== */
const LIDERANCA_CATS=[
  {key:'imediato',label:'🔴 Imediato — essa semana'},
  {key:'curto',label:'🟠 Curto prazo — próximas 2 semanas'},
  {key:'medio',label:'🟡 Médio prazo — esse mês'},
  {key:'estrutural',label:'🟣 Estrutural — sempre'}
];
function renderLiderancaEstrategica(){
  LIDERANCA_CATS.forEach(cat=>{
    const el=document.getElementById('lid-list-'+cat.key);
    if(!el)return;
    const items=(S.liderancaEstrategias||[]).filter(t=>t.categoria===cat.key);
    const countEl=document.getElementById('lid-count-'+cat.key);
    if(countEl)countEl.textContent=items.length?`${items.filter(t=>!t.done).length}/${items.length}`:'';
    if(!items.length){
      el.innerHTML='<div class="lid-empty">Nenhuma ação aqui ainda.</div>';
      return;
    }
    el.innerHTML=items.map(t=>`
      <div class="lid-card lid-card-${cat.key}${t.done?' done':''}" data-key="${t.id}" style="touch-action:pan-y">
        <button class="lid-check${t.done?' done':''}" onclick="toggleLiderancaTarefa('${t.id}')">${t.done?'✓':''}</button>
        <textarea class="lid-text${t.done?' done':''}" onblur="salvarLiderancaTexto('${t.id}',this)" oninput="lidAutoGrow(this)">${t.texto}</textarea>
      </div>`).join('');
    attachSwipeToDelete(el,'.lid-card',id=>removerLiderancaTarefa(id),renderLiderancaEstrategica);
    el.querySelectorAll('.lid-text').forEach(ta=>lidAutoGrow(ta));
  });
  renderLiderancaHome();
}
function lidAutoGrow(el){
  el.style.height='auto';
  el.style.height=(el.scrollHeight+2)+'px';
}
function toggleLiderancaTarefa(id){
  const t=(S.liderancaEstrategias||[]).find(x=>x.id===id);
  if(t){t.done=!t.done;save();renderLiderancaEstrategica();}
}
function salvarLiderancaTexto(id,el){
  const t=(S.liderancaEstrategias||[]).find(x=>x.id===id);
  if(!t)return;
  const val=el.value.trim();
  if(!val){removerLiderancaTarefa(id);return;}
  if(t.texto===val)return;
  t.texto=val;save();
}
function toggleLidAddForm(categoria){
  const row=document.getElementById('lid-addrow-'+categoria);
  if(!row)return;
  const showing=row.style.display==='flex';
  row.style.display=showing?'none':'flex';
  if(!showing){
    const inp=document.getElementById('lid-add-'+categoria);
    if(inp)inp.focus();
  }
}
function addLiderancaTarefa(categoria){
  const inp=document.getElementById('lid-add-'+categoria);
  const texto=inp?.value.trim();
  if(!texto)return;
  if(!S.liderancaEstrategias)S.liderancaEstrategias=[];
  S.liderancaEstrategias.push({id:'lid'+Date.now()+Math.random().toString(36).slice(2,6),categoria,texto,done:false,criadoEm:new Date().toISOString()});
  inp.value='';
  const row=document.getElementById('lid-addrow-'+categoria);
  if(row)row.style.display='none';
  save();renderLiderancaEstrategica();
}
function removerLiderancaTarefa(id){
  S.liderancaEstrategias=(S.liderancaEstrategias||[]).filter(t=>t.id!==id);
  save();renderLiderancaEstrategica();
}
function renderLiderancaHome(){
  const el=document.getElementById('home-motiv-content');
  if(!el)return;
  const items=S.liderancaEstrategias||[];
  const pending=items.filter(t=>!t.done);
  if(!items.length){
    el.innerHTML='<div style="color:var(--text3);font-size:13px">Nenhuma estratégia cadastrada ainda.<br><button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="navTo(\'estrategia\')">Adicionar na Estratégia →</button></div>';
    return;
  }
  if(!pending.length){
    el.innerHTML='<div style="color:var(--ok);font-size:13px">✅ Tudo em dia — nenhuma ação pendente.</div>';
    return;
  }
  const imediatos=pending.filter(t=>t.categoria==='imediato');
  const destaque=imediatos.length?imediatos:pending;
  el.innerHTML=`
    <div style="font-size:11px;color:var(--text3);margin-bottom:8px">${pending.length} ação${pending.length!==1?'ões':''} pendente${pending.length!==1?'s':''}${imediatos.length?` · ${imediatos.length} urgente${imediatos.length!==1?'s':''}`:''}</div>
    ${destaque.slice(0,2).map(t=>`<div style="font-size:13px;line-height:1.5;margin-bottom:8px;padding-left:8px;border-left:2px solid ${t.categoria==='imediato'?'var(--bad)':'var(--info)'}">${t.texto.length>150?t.texto.slice(0,150)+'…':t.texto}</div>`).join('')}
    <button class="btn btn-ghost btn-xs" onclick="navTo('estrategia')">Ver tudo →</button>
  `;
}

/* ===========================================================
   JANELA DE TURNOS — empty slots in upcoming days
   =========================================================== */


/* ===========================================================
   48H DEADLINE ALERTS for demandas in home panel
   =========================================================== */
function render48hAlerts(){
  const el=document.getElementById('home-demandas-urgentes');
  if(!el)return;
  const today=todayKey();
  const urgent=[];
  // Check all demandas2 across days
  (Array.isArray(S.demandas2)?S.demandas2:[]).forEach(item=>{
    if(!item.done&&item.date&&!urgent.find(x=>x.id===item.id)){
      const overdue=item.date<today;
      const near=!overdue&&isWithin48h(item.date);
      if(overdue||near)urgent.push({...item,overdue});
    }
  });
  // Check trainings
  S.trainings.forEach(t=>{
    if(t.date&&isWithin48h(t.date))urgent.push({id:'tr_'+t.id,text:`Treinamento: ${t.title}`,date:t.date,overdue:false,training:true});
  });
  if(!urgent.length){el.innerHTML='';return;}
  el.innerHTML=`<div class="panel" style="border-color:var(--warn)">
    <div class="panel-head"><div class="panel-title" style="color:var(--warn)">⏰ Próximas datas</div></div>
    ${urgent.map(item=>`<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">
      <span style="font-size:16px">${item.overdue?'🚨':'⏳'}</span>
      <div style="flex:1"><div style="font-size:13px;font-weight:600">${item.text}</div>
      <div style="font-size:11px;color:${item.overdue?'var(--bad)':'var(--warn)'}">${item.overdue?'Vencida:':'Prazo:'} ${item.date}</div></div>
    </div>`).join('')}
  </div>`;
}

/* ===========================================================
   MODEL REQUESTS — select model + text, list of requests
   =========================================================== */
function renderModelRequestsSplit(){
  const el=document.getElementById('model-requests-split-list');
  if(!el)return;
  const wkey=getWeekKey();
  if(!Array.isArray(S.modelRequests[wkey]))S.modelRequests[wkey]=[];
  const items=S.modelRequests[wkey];
  if(!items.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Nenhuma requisição essa semana</div>';}
  else{
    el.innerHTML=items.map(item=>{
      const m=S.models.find(mo=>mo.id===item.modelId);
      return`<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">
        <div style="flex:1"><span style="font-weight:700">${m?`${m.emoji||'🧩'} ${m.name}`:'?'}</span><span style="font-size:12px;color:var(--text2);margin-left:8px">${item.text}</span></div>
        <button onclick="removeModelRequest('${item.id}')" style="background:none;border:none;color:var(--text3);cursor:pointer">✕</button>
      </div>`;
    }).join('');
  }
  const sel=document.getElementById('model-req-model');
  if(sel&&!sel.options.length){sel.innerHTML=S.models.map(m=>`<option value="${m.id}">${m.emoji||'🧩'} ${m.name}</option>`).join('');}
}
function addModelRequest(){
  const mid=document.getElementById('model-req-model')?.value;
  const text=document.getElementById('model-req-text')?.value.trim();
  if(!mid||!text)return;
  const wkey=getWeekKey();
  if(!Array.isArray(S.modelRequests[wkey]))S.modelRequests[wkey]=[];
  S.modelRequests[wkey].push({id:'mreq'+Date.now(),modelId:mid,text});
  document.getElementById('model-req-text').value='';
  save();renderModelRequestsSplit();
}
function removeModelRequest(id){
  const wkey=getWeekKey();
  S.modelRequests[wkey]=(S.modelRequests[wkey]||[]).filter(x=>x.id!==id);
  save();renderModelRequestsSplit();
}

/* ===========================================================
   CHAT ANALYSIS — daily per chatter, feeds ficha
   =========================================================== */
const CHAT_METRICS=['conexao','conducao','engajamento','conversao','resposta','naturalidade'];
const CHAT_METRIC_LABELS={conexao:'Conexão',conducao:'Condução',engajamento:'Engajamento',conversao:'Conversão',resposta:'Resposta',naturalidade:'Naturalidade'};
const SCORE_WORD={1:'Fraco',2:'Regular',3:'Bom',4:'Ótimo',5:'Excelente'};

/* ===========================================================
   ANÁLISE SEMANAL DE CHATTER — divide toda a equipe pelos 7 dias
   da semana. Mostra os 7 dias de uma vez, cada um com seus nomes;
   ao marcar feito, o nome some; se o dia ficar vazio, o dia
   inteiro some também.
   =========================================================== */
const DAY_LABELS_FULL={dom:'Domingo',seg:'Segunda',ter:'Terça',qua:'Quarta',qui:'Quinta',sex:'Sexta',sab:'Sábado'};
function getWeeklyAnalysisAssignment(){
  // A pedido da gestora: Análise de Hoje é só da equipe já contratada —
  // testers (ainda em período de teste) não entram aqui.
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  const byDay={};
  DAY_KEYS.forEach(dk=>byDay[dk]=[]);
  chatters.forEach((c,i)=>{byDay[DAY_KEYS[i%7]].push(c);});
  return byDay;
}
function renderWeeklyChatAnalysisBoard(){
  const el=document.getElementById('weekly-analysis-board');
  if(!el)return;
  const wkey=getWeekKey();
  if(!S.weeklyAnalysisDone[wkey])S.weeklyAnalysisDone[wkey]=[];
  const doneList=S.weeklyAnalysisDone[wkey];
  const assignment=getWeeklyAnalysisAssignment();
  const todayDk=DAY_KEYS[new Date().getDay()];
  const days=DAY_KEYS.map(dk=>({dk,pending:(assignment[dk]||[]).filter(c=>!doneList.includes(c.id))})).filter(d=>d.pending.length);
  if(!days.length){el.innerHTML='<span style="color:var(--text3)">Todo mundo analisado essa semana 👍</span>';return;}
  el.innerHTML=days.map(d=>`<div style="margin-bottom:8px">
    <div style="font-size:10.5px;font-weight:700;color:${d.dk===todayDk?'var(--accent)':'var(--text3)'};text-transform:uppercase;margin-bottom:3px">${DAY_LABELS_FULL[d.dk]}${d.dk===todayDk?' · hoje':''}</div>
    <div>${d.pending.map(c=>`<span style="display:inline-flex;align-items:center;gap:4px;background:var(--bg-soft);border-radius:6px;padding:3px 8px;margin:2px 4px 2px 0">
      ${c.name}
      <button onclick="markWeeklyAnalysisDone('${c.id}')" style="background:none;border:none;color:var(--ok);cursor:pointer;font-size:12px;padding:0">✓</button>
    </span>`).join('')}</div>
  </div>`).join('');
}
function markWeeklyAnalysisDone(cid){
  const wkey=getWeekKey();
  if(!S.weeklyAnalysisDone[wkey])S.weeklyAnalysisDone[wkey]=[];
  if(!S.weeklyAnalysisDone[wkey].includes(cid))S.weeklyAnalysisDone[wkey].push(cid);
  save();renderWeeklyChatAnalysisBoard();
}

/* ===========================================================
   TAREFAS (Diárias/Semanais/Mensais) — todas com horário; clicar
   no texto marca urgente (fica vermelha).
   =========================================================== */
let selectedTaskDay=getTodayDayKey();
// Segurar apertado (mouse ou toque) por ~450ms abre o modo de edição de
// uma tarefa: dá pra editar texto/horário e trocar de lugar com a vizinha
// (troca de horário) usando as flechinhas. Vale pra rotina da manhã e
// pros 3 quadros de tarefas (diárias/semanais/mensais).
// Ordenação por horário: pra tarefas "diárias" e a rotina da manhã, um
// horário de madrugada (antes das 6h) conta como continuação do dia
// anterior, não como o começo de um novo dia — assim, se você trabalha até
// 1h da manhã, uma tarefa marcada pra 00:30 fica no FIM da lista, não volta
// pro topo quando passa da meia-noite.
function taskSortKey(t,treatEarlyAsLateNight){
  let time=t.time||'99:99';
  if(treatEarlyAsLateNight&&t.time){
    const[h,m]=t.time.split(':').map(Number);
    if(!isNaN(h)&&h<6)time=String(h+24).padStart(2,'0')+':'+String(m).padStart(2,'0');
  }
  return(t.date||'')+time;
}
let editingTaskKey=null;
let _taskLpTimer=null;
function taskLongPressStart(editKey){
  clearTimeout(_taskLpTimer);
  _taskLpTimer=setTimeout(()=>{editingTaskKey=editKey;renderTaskBoards();},450);
}
function taskLongPressCancel(){clearTimeout(_taskLpTimer);}
function closeTaskEdit(){editingTaskKey=null;renderTaskBoards();}
function taskRowHtml(t,editKey,isDone,cb){
  const isEditing=editingTaskKey===editKey;
  if(isEditing){
    return`<div style="display:flex;align-items:center;gap:6px;padding:7px 6px;border-bottom:1px solid var(--line);background:var(--bg-soft);border-radius:6px;margin:2px 0">
      <div style="display:flex;flex-direction:column">
        <button onclick="${cb.swapUp}" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:10px;padding:0;line-height:1.3">▲</button>
        <button onclick="${cb.swapDown}" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:10px;padding:0;line-height:1.3">▼</button>
      </div>
      <input type="time" class="finput" value="${t.time||''}" onchange="${cb.setTime}" style="width:82px;flex-shrink:0;padding:4px 6px;font-size:12px">
      <input class="finput" value="${(t.text||'').replace(/"/g,'&quot;')}" onblur="${cb.setText}" style="flex:1;padding:4px 6px;font-size:13px">
      <button onclick="closeTaskEdit()" style="background:none;border:none;color:var(--ok);cursor:pointer;font-size:16px">✓</button>
    </div>`;
  }
  return`<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--line);user-select:none"
    onpointerdown="taskLongPressStart('${editKey}')" onpointerup="taskLongPressCancel()" onpointerleave="taskLongPressCancel()">
    <button onclick="${cb.toggleDone}" style="width:20px;height:20px;border-radius:5px;border:2px solid ${isDone?'var(--ok)':'var(--line-strong)'};background:${isDone?'var(--ok)':'transparent'};cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px">${isDone?'<span style="color:#fff">✓</span>':''}</button>
    <span style="font-size:10.5px;font-family:var(--font-mono);color:var(--text3);width:${t.date?'72px':'38px'};flex-shrink:0">${t.date?t.date.slice(8,10)+'/'+t.date.slice(5,7)+' ':''}${t.time||'--:--'}</span>
    <span onclick="${cb.togglePriority}" style="flex:1;font-size:13px;cursor:pointer;${t.urgent?'color:var(--pink);font-weight:700':''}${isDone?'text-decoration:line-through;opacity:.5':''}">${t.text}${t.urgent?' 🌸':''}</span>
    <button onclick="${cb.del}" style="background:none;border:none;color:var(--text3);cursor:pointer">✕</button>
  </div>`;
}
function getTaskStore(scope,key){
  if(scope==='daily'){if(!S.dailyTasksByDay[key])S.dailyTasksByDay[key]=[];return S.dailyTasksByDay[key];}
  if(scope==='weekly'){if(!S.weeklyTasks[key])S.weeklyTasks[key]=[];return S.weeklyTasks[key];}
  if(scope==='monthly'){if(!S.monthlyTasks[key])S.monthlyTasks[key]=[];return S.monthlyTasks[key];}
  return[];
}
function selectTaskDay(dk){selectedTaskDay=dk;renderTaskBoards();}
function addTaskGeneric(scope,key,inputId,timeId,dateId){
  const inp=document.getElementById(inputId);
  const text=inp?.value.trim();
  if(!text){toast('⚠️ Descreva a tarefa');return;}
  const timeInp=document.getElementById(timeId);
  const time=timeInp?.value||'';
  const dateInp=dateId?document.getElementById(dateId):null;
  const date=dateInp?.value||'';
  getTaskStore(scope,key).push({id:'tk'+Date.now()+Math.random().toString(36).slice(2,4),text,time,date,urgent:false,done:false});
  inp.value='';if(timeInp)timeInp.value='';if(dateInp)dateInp.value='';
  save();renderTaskBoards();
}
function addDailyTask(){addTaskGeneric('daily',selectedTaskDay,'daily-task-input','daily-task-time');}
function addWeeklyTask(){addTaskGeneric('weekly',getWeekKey(),'weekly-task-input','weekly-task-time','weekly-task-date');}
function addMonthlyTask(){addTaskGeneric('monthly',todayKey().slice(0,7),'monthly-task-input','monthly-task-time','monthly-task-date');}
// Tarefas semanais/mensais SEM data marcada (t.date vazio) são recorrentes —
// precisam "repetir diariamente", ou seja, o check de feito reseta todo dia,
// em vez de ficar marcado a semana/mês inteiro depois de feito uma vez.
// Tarefas COM data+hora marcada continuam com o comportamento antigo (prazo
// real: uma vez feita, fica feita — é isso que alimenta o alerta de prazo).
// Tarefas DIÁRIAS (S.dailyTasksByDay) são por definição recorrentes — moram
// num balde por dia da semana (seg/ter/qua...) e voltam a aparecer toda
// semana nesse mesmo dia — então elas TAMBÉM precisam resetar o "feito"
// todo dia (senão marcar como feita numa segunda deixava feita pra sempre
// em toda segunda seguinte, já que o objeto do balde é reaproveitado).
function recurresDaily(scope,t){
  return scope==='daily'||((scope==='weekly'||scope==='monthly')&&!t.date);
}
function isTaskDoneToday(scope,t){
  if(recurresDaily(scope,t))return!!(S.taskDoneLog[todayKey()]||{})[t.id];
  return!!t.done;
}
function toggleTaskDone(scope,key,id){
  const t=getTaskStore(scope,key).find(x=>x.id===id);
  if(!t)return;
  if(recurresDaily(scope,t)){
    const dk=todayKey();
    if(!S.taskDoneLog[dk])S.taskDoneLog[dk]={};
    S.taskDoneLog[dk][id]=!S.taskDoneLog[dk][id];
  } else {
    t.done=!t.done;
  }
  save();renderTaskBoards();
}
function toggleTaskUrgent(scope,key,id){
  const t=getTaskStore(scope,key).find(x=>x.id===id);
  if(t)t.urgent=!t.urgent;
  save();renderTaskBoards();
}
function deleteTask(scope,key,id){
  const list=getTaskStore(scope,key);
  const idx=list.findIndex(x=>x.id===id);
  if(idx>-1)list.splice(idx,1);
  save();renderTaskBoards();
}
function swapTaskTime(scope,key,id,dir){
  const list=getTaskStore(scope,key);
  const late=scope==='daily';
  const sorted=[...list].sort((a,b)=>taskSortKey(a,late).localeCompare(taskSortKey(b,late)));
  const idx=sorted.findIndex(x=>x.id===id);
  const swapIdx=idx+dir;
  if(swapIdx<0||swapIdx>=sorted.length)return;
  const a=list.find(x=>x.id===sorted[idx].id);
  const b=list.find(x=>x.id===sorted[swapIdx].id);
  const tmpT=a.time;a.time=b.time;b.time=tmpT;
  const tmpD=a.date;a.date=b.date;b.date=tmpD;
  save();renderTaskBoards();
}
function updateTaskField(scope,key,id,field,value){
  const t=getTaskStore(scope,key).find(x=>x.id===id);
  if(t)t[field]=value;
  save();renderTaskBoards();
}
// Linha de exibição pros compromissos "automáticos" (orientações agendadas,
// tarefas semanais/mensais com data marcada, quadro de Aquecimento Discord)
// que aparecem em Tarefas Diárias só de olho no dia — não foram criados
// direto nessa lista, então não têm swap/edição de texto: o feito e o dado
// em si moram na fonte original (Agenda, Semana, etc), aqui é só espelho.
function autoTaskRowHtml(t){
  // Compromissos atrasados (data já passou e ainda não foram marcados como
  // feitos) ganham uma tag vermelha "Atrasada" em vez da tag normal — pra
  // ficar claro que não é um item de hoje, mas continua acessível/clicável
  // até ser marcado como feito (não soma mais depois disso).
  const isOverdue=/^Atrasad/.test(t.tag);
  // Orientações (t.view) abrem, ao clicar no texto, um modal com a abordagem
  // sugerida/roteiro/frase de abertura — "a forma de aplicá-la" — em vez de
  // só mostrar o texto curto. Semanal/Mensal/Treinamento não têm esse roteiro
  // guardado, então continuam sem clique no texto (só o checkbox).
  const textStyle=`flex:1;font-size:13px;${t.isDone?'text-decoration:line-through;opacity:.5;':''}${t.view?'cursor:pointer;text-decoration:underline;text-decoration-style:dotted;':''}`;
  const textClick=t.view?` onclick="${t.view}"`:'';
  return`<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--line)">
    <button onclick="${t.toggle}" style="width:20px;height:20px;border-radius:5px;border:2px solid ${t.isDone?'var(--ok)':isOverdue?'var(--bad)':'var(--line-strong)'};background:${t.isDone?'var(--ok)':'transparent'};cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px">${t.isDone?'<span style="color:#fff">✓</span>':''}</button>
    <span style="font-size:10.5px;font-family:var(--font-mono);color:var(--text3);width:38px;flex-shrink:0">${t.time}</span>
    <span style="${textStyle}"${textClick}>${t.text}</span>
    <span style="font-size:9.5px;color:${isOverdue?'var(--bad)':'var(--accent)'};background:${isOverdue?'var(--bad-soft)':'var(--accent-soft)'};padding:2px 6px;border-radius:5px;flex-shrink:0;white-space:nowrap">${t.tag}</span>
    ${t.del?`<button onclick="if(confirm('Excluir este item incluído automaticamente?')){${t.del}}" title="Excluir (item errado)" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:13px;flex-shrink:0;padding:0 2px">✕</button>`:''}
  </div>`;
}
// Junta, pra uma data específica, todo compromisso com HORA e DATA marcadas
// que vive em outros quadros do app (Orientação agendada na Ficha, tarefas
// semanais/mensais com data, Aquecimento Discord) — pra aparecer também em
// Tarefas Diárias no dia certo, na hora certa, mesmo já existindo nos outros
// lugares. Cada item aponta o "feito" pro dado original (não duplica estado).
function getAutoDailyAgendaItems(dateKey){
  const items=[];
  // Compromissos com data+hora que já passaram e ainda não foram marcados
  // como feitos CONTINUAM aparecendo aqui (com tag "Atrasada · DD/MM") em vez
  // de sumir quando o dia vira — senão a pessoa perde o acesso pra marcar
  // como feito ou dar um follow-up. Some da lista só quando ela realmente
  // conclui o item (o.done/t.done vira true).
  S.orientations.filter(o=>o.time&&(o.date===dateKey||(o.date<dateKey&&!o.done))).forEach(o=>{
    const c=S.chatters.find(ch=>ch.id===o.chatterId);
    const overdue=o.date<dateKey;
    items.push({key:`orient|${o.id}`,time:o.time,date:'',
      text:`🎯 Orientação — ${c?c.name:'?'}: ${o.text}`,
      isDone:!!o.done,toggle:`toggleOrientationDone('${o.id}')`,
      view:`openOrientView('${o.id}')`,del:`deleteOrientation('${o.id}')`,
      tag:overdue?`Atrasada · ${o.date.split('-').reverse().join('/')}`:'Orientação'});
  });
  Object.keys(S.weeklyTasks).forEach(wk=>{
    (S.weeklyTasks[wk]||[]).forEach(t=>{
      if(t.date&&t.time&&(t.date===dateKey||(t.date<dateKey&&!t.done))){
        const overdue=t.date<dateKey;
        items.push({key:`weekly|${wk}|${t.id}`,time:t.time,date:'',
          text:`📅 ${t.text}`,isDone:!!t.done,
          toggle:`toggleTaskDone('weekly','${wk}','${t.id}')`,
          del:`deleteTask('weekly','${wk}','${t.id}')`,
          tag:overdue?`Atrasada · ${t.date.split('-').reverse().join('/')}`:'Semanal'});
      }
    });
  });
  Object.keys(S.monthlyTasks).forEach(mk=>{
    (S.monthlyTasks[mk]||[]).forEach(t=>{
      if(t.date&&t.time&&(t.date===dateKey||(t.date<dateKey&&!t.done))){
        const overdue=t.date<dateKey;
        items.push({key:`monthly|${mk}|${t.id}`,time:t.time,date:'',
          text:`🗓️ ${t.text}`,isDone:!!t.done,
          toggle:`toggleTaskDone('monthly','${mk}','${t.id}')`,
          del:`deleteTask('monthly','${mk}','${t.id}')`,
          tag:overdue?`Atrasada · ${t.date.split('-').reverse().join('/')}`:'Mensal'});
      }
    });
  });
  return items;
}
function renderTaskBoard(containerId,scope,key){
  const el=document.getElementById(containerId);
  if(!el)return;
  const list=getTaskStore(scope,key);
  const late=scope==='daily';
  const own=list.map(t=>({...t,_auto:false}));
  const auto=(scope==='daily'&&key===getTodayDayKey())?getAutoDailyAgendaItems(todayKey()):[];
  const combined=[...own,...auto.map(a=>({id:a.key,text:a.text,time:a.time,date:a.date,_auto:true,_item:a}))];
  const sorted=combined.sort((a,b)=>taskSortKey(a,late).localeCompare(taskSortKey(b,late)));
  if(!sorted.length){el.innerHTML='<div style="font-size:12px;color:var(--text3);padding:6px 0">Nenhuma tarefa</div>';return;}
  el.innerHTML=sorted.map(t=>{
    if(t._auto)return autoTaskRowHtml(t._item);
    return taskRowHtml(t,`${scope}|${key}|${t.id}`,isTaskDoneToday(scope,t),{
      toggleDone:`toggleTaskDone('${scope}','${key}','${t.id}')`,
      togglePriority:`toggleTaskUrgent('${scope}','${key}','${t.id}')`,
      del:`deleteTask('${scope}','${key}','${t.id}')`,
      swapUp:`swapTaskTime('${scope}','${key}','${t.id}',-1)`,
      swapDown:`swapTaskTime('${scope}','${key}','${t.id}',1)`,
      setTime:`updateTaskField('${scope}','${key}','${t.id}','time',this.value)`,
      setText:`updateTaskField('${scope}','${key}','${t.id}','text',this.value)`,
    });
  }).join('');
}
function toggleOrientationDone(id){
  const o=S.orientations.find(x=>x.id===id);
  if(!o)return;
  o.done=!o.done;
  save();renderTaskBoards();renderOrientList();
}
function renderTaskBoards(){
  const daySel=document.getElementById('daily-task-day-selector');
  if(daySel){
    const labels={dom:'Dom',seg:'Seg',ter:'Ter',qua:'Qua',qui:'Qui',sex:'Sex',sab:'Sáb'};
    daySel.innerHTML=DAY_KEYS.map(dk=>`<button onclick="selectTaskDay('${dk}')" class="btn ${dk===selectedTaskDay?'btn-primary':'btn-ghost'} btn-xs">${labels[dk]}</button>`).join('');
  }
  renderTaskBoard('daily-tasks-list','daily',selectedTaskDay);
  renderTaskBoard('weekly-tasks-list','weekly',getWeekKey());
  renderTaskBoard('monthly-tasks-list','monthly',todayKey().slice(0,7));
}

/* ===========================================================
   AQUECIMENTO DISCORD — roteiro fixo Segunda a Quinta pros
   "Inscritos" antes do treinamento (que agora é seu próprio quadro
   fixo Sexta/Sábado/Domingo, ver TREINAMENTO FIXO abaixo). Não é
   mais um ciclo com data "presa" numa semana — é sempre a mesma
   lista por dia da semana. Clicar num dia abre o roteiro e mostra
   um botão "Agendar na Agenda": escolhe o horário e o item entra
   recorrente em Tarefas Diárias naquele dia da semana (usando o
   mesmo balde S.dailyTasksByDay que a Agenda já usa).
   =========================================================== */
const RETENTION_AGENDA_DAYS=[
  {dk:'seg',dia:1,titulo:'Ativação de identidade — Pergunta do Dia',
    texto:'No bate-papo-geral: "Por que você quer trabalhar com isso? Qual é o número que mudaria sua vida financeira hoje?" — força o candidato a verbalizar a motivação. Quem escreve o motivo tem muito mais dificuldade de desistir depois. É compromisso público.'},
  {dk:'ter',dia:2,titulo:'Conteúdo de valor + lembrete',
    texto:'Em avisos-oficiais: poste 1 único conteúdo curto de contexto de mercado (texto, print, dado sobre criadores de conteúdo no Brasil) — não ensine técnica ainda, o objetivo é ele pensar "esse mercado é maior do que eu imaginava". Poste também um lembrete curto reforçando data e horário do treinamento.'},
  {dk:'qua',dia:3,titulo:'Pressão positiva + reconhecimento nominal',
    texto:'Em avisos-oficiais: "Estamos observando quem está aqui, quem está interagindo e quem já demonstra o perfil que buscamos. O treinamento começa em X dias — mas nossa avaliação já começou." No bate-papo-geral, cite pelo nome 2 ou 3 candidatos que interagiram bem: "Fulano, Ciclano — boa postura aqui. É exatamente isso."'},
  {dk:'qui',dia:4,titulo:'Antecipação e comprometimento final',
    texto:'Em avisos-oficiais: "Amanhã começa. Confirme sua presença reagindo com ✅ nessa mensagem. Quem não confirmar até as 22h de hoje será removido da lista — a vaga vai para o próximo da fila." Pergunta do dia no bate-papo: "O que você vai fazer diferente amanhã para já entrar no treinamento no seu melhor nível?"'},
  {dk:'sex',dia:5,titulo:'Recepção e último empurrão — hoje é o dia',
    texto:'Em avisos-oficiais: "É hoje! Treinamento às [horário] — chega 5 minutos antes." No bate-papo-geral, recepcione quem já confirmou presença e reforce o clima de expectativa: "Bora, hoje é o dia de mostrar serviço." Aproveite pra reforçar o link/local do treinamento uma última vez.'},
];
let aquecimentoDiaAberto=null;
function toggleAquecimentoDia(dk){
  aquecimentoDiaAberto=aquecimentoDiaAberto===dk?null:dk;
  renderAquecimento();
}
function toggleAquecimentoAgendar(dk){
  const row=document.getElementById('aquec-agendar-'+dk);
  if(!row)return;
  row.style.display=row.style.display==='flex'?'none':'flex';
}
function agendarAquecimentoDia(dk){
  const inp=document.getElementById('aquec-time-'+dk);
  const time=inp?.value;
  if(!time){toast('⚠️ Escolha um horário');return;}
  const d=RETENTION_AGENDA_DAYS.find(x=>x.dk===dk);
  if(!d)return;
  if(!S.dailyTasksByDay[dk])S.dailyTasksByDay[dk]=[];
  S.dailyTasksByDay[dk].push({id:'tk'+Date.now()+Math.random().toString(36).slice(2,4),text:`🔥 ${d.titulo}`,time,date:'',urgent:false,done:false});
  save();
  toast(`✅ Agendado toda ${DAYS[DAY_KEYS.indexOf(dk)]} às ${time} — já aparece em Tarefas Diárias!`);
  const row=document.getElementById('aquec-agendar-'+dk);
  if(row)row.style.display='none';
  renderTaskBoards();
}
function renderAquecimento(){
  const el=document.getElementById('aquecimento-content');
  if(!el)return;
  const labels={seg:'Segunda',ter:'Terça',qua:'Quarta',qui:'Quinta',sex:'Sexta'};
  el.innerHTML=RETENTION_AGENDA_DAYS.map(d=>{
    const aberto=aquecimentoDiaAberto===d.dk;
    return`<div style="background:var(--warn-soft);border-radius:10px;padding:12px;margin-bottom:8px;border-left:3px solid var(--warn)">
      <div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="toggleAquecimentoDia('${d.dk}')">
        <div>
          <div style="font-weight:700;font-size:14px">🔥 ${labels[d.dk]}</div>
          <div style="font-size:11.5px;color:var(--text2)">${d.titulo}</div>
        </div>
        <span style="font-size:11px;color:var(--warn)">${aberto?'▾':'▸'}</span>
      </div>
      ${aberto?`<div style="margin-top:10px">
        <div style="font-size:12.5px;color:var(--text2);line-height:1.55;margin-bottom:10px">${d.texto}</div>
        <button class="btn btn-soft btn-sm" onclick="toggleAquecimentoAgendar('${d.dk}')">📅 Agendar na Agenda</button>
        <div id="aquec-agendar-${d.dk}" style="display:none;gap:6px;margin-top:8px">
          <input type="time" class="finput" id="aquec-time-${d.dk}" style="flex:1">
          <button class="btn btn-primary btn-sm" onclick="agendarAquecimentoDia('${d.dk}')">OK</button>
        </div>
      </div>`:''}
    </div>`;
  }).join('');
}
// TREINAMENTO FIXO — Sexta/Sábado/Domingo sempre presentes (não precisam
// ser recriados toda semana), com o roteiro editável direto no card.
let treinamentoFixoAberto=null;
function toggleTreinamentoFixoDia(dk){
  treinamentoFixoAberto=treinamentoFixoAberto===dk?null:dk;
  renderTreinamentoFixo();
}
function saveTreinamentoFixoScript(dk,val){
  if(!S.treinamentoFixo)S.treinamentoFixo={};
  if(!S.treinamentoFixo[dk])S.treinamentoFixo[dk]={titulo:'',texto:''};
  S.treinamentoFixo[dk].texto=val;
  save();
}
function renderTreinamentoFixo(){
  const el=document.getElementById('treinamento-fixo-content');
  if(!el)return;
  const dias=[{dk:'sex',label:'Sexta'},{dk:'sab',label:'Sábado'},{dk:'dom',label:'Domingo'}];
  el.innerHTML=dias.map(d=>{
    const entry=S.treinamentoFixo?.[d.dk]||{titulo:'',texto:''};
    const aberto=treinamentoFixoAberto===d.dk;
    return`<div style="background:var(--warn-soft);border-radius:10px;padding:12px;margin-bottom:8px;border-left:3px solid var(--warn)">
      <div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="toggleTreinamentoFixoDia('${d.dk}')">
        <div>
          <div style="font-weight:700;font-size:14px">🎓 ${d.label}${entry.titulo?` — ${entry.titulo}`:''}</div>
          <div style="font-size:11.5px;color:var(--text2)">${entry.texto?'Roteiro definido':'Sem roteiro ainda — toque pra adicionar'}</div>
        </div>
        <span style="font-size:11px;color:var(--warn)">${aberto?'▾':'▸'}</span>
      </div>
      ${aberto?`<div style="margin-top:10px">
        <textarea class="ftext" style="min-height:60px;font-size:12.5px" placeholder="Roteiro/plano do treinamento de ${d.label.toLowerCase()}..." onblur="saveTreinamentoFixoScript('${d.dk}',this.value)">${entry.texto||''}</textarea>
      </div>`:''}
    </div>`;
  }).join('');
}

/* ===========================================================
   NECESSIDADE DE ORIENTAÇÃO — mostra 1 chatter em foco por vez;
   ao marcar como orientado, passa pro próximo que precisa.
   =========================================================== */
function getChattersNeedingOrientation(){
  const wk=getWeekKey(0);
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  const oriented=S.orientedThisWeek[wk]||[];
  const candidates=[];
  chatters.forEach(c=>{
    if(oriented.includes(c.id))return;
    const cat=S.chatterFichas?.[c.id]?.pagCategoria||'B';
    const metaManual=parseFloat((S.chatterWeekGoals[wk]||{})[c.id])||0;
    const meta=metaManual>0?metaManual:(PAG_CATS[cat]?.n100||0);
    if(!meta)return;
    const rev=getChatterWeekRevenue(c.id,0);
    const pct=rev/meta*100;
    if(pct>=60)return; // não está em dificuldade
    candidates.push({c,pct:Math.round(pct)});
  });
  candidates.sort((a,b)=>a.pct-b.pct);
  return candidates;
}
function renderOrientNeedBoard(){
  const el=document.getElementById('orient-need-board');
  if(!el)return;
  const list=getChattersNeedingOrientation();
  if(!list.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px;padding:6px 0">Ninguém precisa de orientação agora 👍</div>';return;}
  const top=list[0];
  el.innerHTML=`<div style="display:flex;align-items:center;justify-content:space-between;padding:10px;background:var(--bad-soft);border-radius:9px">
    <div><div style="font-weight:700">${top.c.name}</div><div style="font-size:11.5px;color:var(--bad)">${top.pct}% da meta essa semana</div></div>
    <button class="btn btn-primary btn-sm" onclick="markOriented('${top.c.id}')">✅ Já orientei</button>
  </div>
  ${list.length>1?`<div style="font-size:11px;color:var(--text3);margin-top:6px">+ ${list.length-1} outro(s) aguardando</div>`:''}`;
}
function markOriented(cid){
  const wk=getWeekKey(0);
  if(!S.orientedThisWeek[wk])S.orientedThisWeek[wk]=[];
  if(!S.orientedThisWeek[wk].includes(cid))S.orientedThisWeek[wk].push(cid);
  save();renderOrientNeedBoard();
  toast('✅ Marcado como orientado');
}

/* ===========================================================
   ESTUDOS — updated with 3 fields each
   =========================================================== */
function saveEstudosDraft(){
  S.estudosDraft={};
  ['fortes1','fortes2','fortes3','fracos1','fracos2','fracos3','foco1','foco2','foco3'].forEach(k=>{
    S.estudosDraft[k]=document.getElementById('estudos-'+k)?.value||'';
  });
  save();
}
function saveEstudosSnapshot(){
  saveEstudosDraft();
  const d=S.estudosDraft;
  const hasContent=Object.values(d).some(v=>v.trim());
  if(!hasContent){toast('⚠️ Preencha pelo menos um campo');return;}
  if(!S.estudosHistory)S.estudosHistory=[];
  S.estudosHistory.push({date:todayKey(),...d});
  save();renderEstudosHistorico();toast('✅ Snapshot salvo!');
}

/* ===========================================================
   SEMANA — per-chatter development + auto analysis
   =========================================================== */
function renderSemanaDesenvolvimento(){
  const el=document.getElementById('semana-desenvolvimento');
  if(!el)return;
  const wd=getWeekDates();
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  if(!chatters.length){el.innerHTML='<div style="color:var(--text3);font-size:13px">Cadastre chatters e processe relatórios para ver os dados</div>';return;}

  let hasData=false;
  el.innerHTML=chatters.map(c=>{
    const f=S.chatterFichas[c.id];
    const analytics=f?.analytics?.weeklyData||{};
    const wkeys=wd.map(d=>fmt(d)).filter(dk=>analytics[dk]&&(!c.testerApprovalDate||dk>=c.testerApprovalDate));
    if(!wkeys.length)return`<div style="padding:8px 0;border-bottom:1px solid var(--line);font-size:13px;color:var(--text3)">${c.name} — sem dados esta semana</div>`;
    hasData=true;

    let totalRev=0,totalVendas=0,totalTicket=0,totalVPH=0,totalHighPct=0,maxGap=0,totalExtra=0,days=0;
    wkeys.forEach(dk=>{
      const a=analytics[dk];
      totalRev+=a.chatterTotal||0;
      totalVendas+=a.totalVendas||0;
      totalExtra+=a.extraTotal||0;
      if(a.ticketMedio>0){totalTicket+=a.ticketMedio;totalVPH+=a.vendasPorHora||0;totalHighPct+=a.highTicketPct||0;days++;}
      if((a.maxGapMin||0)>maxGap)maxGap=a.maxGapMin||0;
    });
    const avgTicket=days>0?totalTicket/days:0;
    const avgVPH=days>0?Math.round(totalVPH/days*100)/100:0;
    const avgHighPct=days>0?Math.round(totalHighPct/days):0;

    return`<div style="margin-bottom:14px">
      <div style="font-weight:700;font-size:14px;margin-bottom:8px">${c.name} <span style="font-size:11px;color:var(--text3)">(${wkeys.length} dia${wkeys.length>1?'s':''})</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px">
        <div style="background:var(--bg-soft);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:10px;color:var(--text3)">Ticket médio</div>
          <div style="font-size:14px;font-weight:800;font-family:var(--font-mono)">${money(avgTicket)}</div>
        </div>
        <div style="background:var(--bg-soft);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:10px;color:var(--text3)">Valor/hora</div>
          <div style="font-size:14px;font-weight:800;color:${avgVPH>=20?'var(--ok)':avgVPH>=10?'var(--warn)':'var(--bad)'}">${avgVPH}</div>
        </div>
        <div style="background:var(--bg-soft);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:10px;color:var(--text3)">% High ticket</div>
          <div style="font-size:14px;font-weight:800;color:${avgHighPct>=30?'var(--ok)':avgHighPct>=15?'var(--warn)':'var(--bad)'}">${avgHighPct}%</div>
        </div>
        <div style="background:var(--bg-soft);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:10px;color:var(--text3)">Maior gap</div>
          <div style="font-size:14px;font-weight:800;color:${maxGap>60?'var(--bad)':maxGap>30?'var(--warn)':'var(--ok)'}">${maxGap?maxGap+'min':'—'}</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;font-size:12px;color:var(--text2)">
        <span>Total: <strong>${money(totalRev)}</strong></span>
        <span>${totalVendas} vendas</span>
        ${totalExtra>0?`<span style="color:var(--info)">⚡ Extra: ${money(totalExtra)}</span>`:''}
      </div>
    </div>`;
  }).join('');

  if(!hasData)el.innerHTML='<div style="color:var(--text3);font-size:13px">Processe relatórios na aba Rel.Equipe para ver os dados aqui</div>';
}

function gerarAnaliseSemanal(){
  const el=document.getElementById('semana-analise');
  if(!el)return;
  const wd=getWeekDates();
  const wkey=getWeekKey();
  const goals=S.chatterWeekGoals[wkey]||{};
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  if(!chatters.length){el.innerHTML='<div style="color:var(--text3);font-size:13px">Sem dados</div>';return;}

  const linhas=[];
  const destaques=[];
  const atencao=[];

  chatters.forEach(c=>{
    const f=S.chatterFichas[c.id];
    const analytics=f?.analytics?.weeklyData||{};
    const wkeys=wd.map(d=>fmt(d)).filter(dk=>analytics[dk]&&(!c.testerApprovalDate||dk>=c.testerApprovalDate));
    if(!wkeys.length)return;

    let totalRev=0,totalVendas=0,totalTicket=0,totalVPH=0,totalHighPct=0,maxGap=0,days=0;
    wkeys.forEach(dk=>{
      const a=analytics[dk];
      totalRev+=a.chatterTotal||0;totalVendas+=a.totalVendas||0;
      if(a.ticketMedio>0){totalTicket+=a.ticketMedio;totalVPH+=a.vendasPorHora||0;totalHighPct+=a.highTicketPct||0;days++;}
      if((a.maxGapMin||0)>maxGap)maxGap=a.maxGapMin||0;
    });
    const avgTicket=days>0?totalTicket/days:0;
    const avgVPH=days>0?Math.round(totalVPH/days*100)/100:0;
    const avgHighPct=days>0?Math.round(totalHighPct/days):0;
    const meta=parseFloat(goals[c.id])||0;
    const pct=meta>0?Math.round((getChatterWeekRevenue(c.id)/meta)*100):null;

    if(avgVPH>=1&&avgHighPct>=25)destaques.push(`${c.name} (${avgVPH} v/h, ${avgHighPct}% HT)`);
    if(maxGap>90)atencao.push(`${c.name} ficou ${maxGap}min sem vender`);
    if(pct!==null&&pct<50)atencao.push(`${c.name} está em ${pct}% da meta`);
    if(avgTicket<20)atencao.push(`${c.name} com ticket médio baixo: ${money(avgTicket)}`);

    linhas.push(`${c.name}: fat ${money(totalRev)} · ${avgVPH}v/h · ticket ${money(avgTicket)} · HT ${avgHighPct}%${pct!==null?' · meta '+pct+'%':''}`);
  });

  const analise=`📊 ANÁLISE DA SEMANA — ${wkey}\n\n`+
    (destaques.length?`✅ Destaques:\n${destaques.map(d=>'• '+d).join('\n')}\n\n`:'')+
    (atencao.length?`⚠️ Atenção:\n${atencao.map(a=>'• '+a).join('\n')}\n\n`:'')+
    `📋 Resumo:\n${linhas.join('\n')}`;

  el.innerHTML=`<pre style="font-size:12px;line-height:1.7;white-space:pre-wrap;font-family:var(--font-mono);color:var(--text)">${analise}</pre>
    <button class="btn btn-ghost btn-sm btn-block" style="margin-top:8px" onclick="navigator.clipboard&&navigator.clipboard.writeText(document.querySelector('#semana-analise pre').textContent).then(()=>toast('✅ Copiado!'))">📋 Copiar análise</button>`;

  // Save to week notes area for reference
  if(!S.weekNotes)S.weekNotes={};
  S.weekNotes[wkey+'_analise']=analise;
  save();
}

/* ===========================================================
   HORA EXTRA — fix to show values per chatter
   =========================================================== */
function getChatterExtraRevenueDetailed(chatterId){
  const wkey=getWeekKey();
  const slots=(S.horaExtraSlots[wkey]||[]).filter(x=>x.chatterId===chatterId);
  const total=slots.reduce((s,x)=>s+(parseFloat(x.revenue)||0),0);
  const byModel={};
  slots.forEach(x=>{
    const m=S.models.find(mm=>mm.id===x.modelId);
    const key=m?m.name:'Outro';
    byModel[key]=(byModel[key]||0)+(parseFloat(x.revenue)||0);
  });
  return{total,byModel,slots};
}

/* ===========================================================
   AUSÊNCIAS — add justificativa field
   =========================================================== */
function renderAbsenceListWithJustificativa(){
  const el=document.getElementById('absence-list');
  if(!el)return;
  const wd=getWeekDates();
  const wStart=fmt(wd[0]),wEnd=fmt(wd[6]);
  const weekAbs=S.absences.filter(a=>a.date>=wStart&&a.date<=wEnd).sort((a,b)=>b.date.localeCompare(a.date));
  if(!weekAbs.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Nenhuma ocorrência esta semana</div>';return;}
  el.innerHTML=weekAbs.map(a=>{
    const c=S.chatters.find(ch=>ch.id===a.chatterId);
    const typeLabel={falta:'🔴 Falta',atraso:'🟡 Atraso',saida_antecipada:'🟠 Saída antecipada'}[a.type]||a.type;
    const justKey=`just_abs_${a.id}`;
    const justText=(S.alertNotes&&S.alertNotes[justKey])||a.justificativa||'';
    return`<div style="padding:10px 0;border-bottom:1px solid var(--line)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <div><span style="font-weight:700">${c?c.name:'?'}</span> <span style="font-size:12px;color:var(--text2)">${typeLabel} · ${a.date}</span></div>
        <button onclick="removeAbsence('${a.id}')" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:13px">✕</button>
      </div>
      ${a.note?`<div style="font-size:12px;color:var(--text2);margin-bottom:4px">${a.note}</div>`:''}
      <input class="finput" style="font-size:11.5px;padding:5px 9px" placeholder="Justificativa (falta justificada, folga acordada, etc.)..."
        value="${justText}" onblur="saveAbsenceJustificativa('${a.id}',this.value)">
    </div>`;
  }).join('');
}
function saveAbsenceJustificativa(absId,text){
  const a=S.absences.find(x=>x.id===absId);
  if(a)a.justificativa=text;
  if(!S.alertNotes)S.alertNotes={};
  S.alertNotes[`just_abs_${absId}`]=text;
  save();
}
function removeAbsence(id){
  S.absences=S.absences.filter(a=>a.id!==id);
  save();renderAbsenceListWithJustificativa();
}

/* ===========================================================
   EVOLUÇÃO — % improvement per chatter per metric
   =========================================================== */
function calcEvolutionPct(chatterId){
  const f=S.chatterFichas[chatterId];
  if(!f?.analytics?.weeklyData)return null;
  const entries=Object.entries(f.analytics.weeklyData).sort((a,b)=>a[0].localeCompare(b[0]));
  if(entries.length<2)return null;

  const metrics=['ticketMedio','vendasPorHora','highTicketPct'];
  const result={};
  metrics.forEach(m=>{
    const vals=entries.map(([,a])=>a[m]||0).filter(v=>v>0);
    if(vals.length<2)return;
    const first=vals[0],last=vals[vals.length-1];
    const pct=first>0?Math.round(((last-first)/first)*100):0;
    result[m]=pct;
  });
  return result;
}

/* ===========================================================
   ANÁLISE COMPARATIVA DA EQUIPE (IA) — Evolução
   Compara resultado mensal de cada chatter (oscila vs constante)
   e comenta se os talentos estão bem distribuídos entre modelos.
   =========================================================== */
function getChatterMonthlyStats(cid){
  const f=S.chatterFichas[cid]||{};
  const analytics=f.analytics?.weeklyData||{};
  const weekKeys=Object.keys(analytics).sort();
  const monthGroups={};
  weekKeys.forEach(dk=>{
    const mo=dk.slice(0,7);
    if(!monthGroups[mo])monthGroups[mo]={totalRev:0,tickets:[],vphs:[]};
    const a=analytics[dk];
    monthGroups[mo].totalRev+=a.chatterTotal||0;
    if(a.ticketMedio>0)monthGroups[mo].tickets.push(a.ticketMedio);
    if(a.vendasPorHora>0)monthGroups[mo].vphs.push(a.vendasPorHora);
  });
  const avg=arr=>arr.length?Math.round(arr.reduce((s,v)=>s+v,0)/arr.length*10)/10:0;
  return Object.keys(monthGroups).sort().map(mo=>({mo,rev:Math.round(monthGroups[mo].totalRev),avgTicket:avg(monthGroups[mo].tickets),avgVph:avg(monthGroups[mo].vphs)}));
}
function getChatterModelRevenue(cid){
  const byModel={};
  S.models.forEach(m=>{
    let tot=0;
    Object.keys(S.revenues).forEach(key=>{
      if(key.startsWith(`${cid}_${m.id}_`))tot+=parseFloat(S.revenues[key])||0;
    });
    if(tot>0)byModel[m.name]=Math.round(tot);
  });
  return byModel;
}
async function rodarAnaliseComparativaEquipe(){
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  if(chatters.length<2){toast('⚠️ Precisa de pelo menos 2 chatters no time base');return;}
  const btn=document.getElementById('team-analysis-btn');
  const resEl=document.getElementById('team-analysis-result');
  btn.disabled=true;btn.textContent='Analisando…';
  resEl.innerHTML='<div style="text-align:center;padding:30px;color:var(--text2);font-size:13px">⏳ A IA está comparando a equipe…</div>';

  let dataText='';
  chatters.forEach(c=>{
    const stats=getChatterMonthlyStats(c.id);
    const modelRev=getChatterModelRevenue(c.id);
    dataText+=`\n### ${c.name} (nível ${c.level})\n`;
    if(stats.length){
      dataText+=stats.map(s=>`- ${s.mo}: faturou ${money(s.rev)}, ticket médio ${money(s.avgTicket)}, valor/hora ${money(s.avgVph)}`).join('\n')+'\n';
    } else dataText+='- Sem dados mensais suficientes ainda.\n';
    const modelEntries=Object.entries(modelRev);
    dataText+=modelEntries.length?`Faturamento por modelo: ${modelEntries.map(([n,v])=>`${n}: ${money(v)}`).join(', ')}\n`:'Sem faturamento por modelo registrado.\n';
  });

  const system='Você é a Gerente Sênior de Performance de uma operação de vendas por chat (chatters atendendo modelos de conteúdo adulto). Analisa dados mensais agregados do time inteiro e escreve com clareza, direto ao ponto, sem enrolação, em português do Brasil.';
  const prompt=`Aqui estão os dados mensais de faturamento, ticket médio e valor/hora de cada chatter do time, além do faturamento de cada um por modelo:\n${dataText}\n\nEscreva uma análise comparativa curta (use Markdown) com:\n## 📊 Quem é constante vs quem oscila\nAponte quem tem resultado mensal estável e quem tem altos e baixos, com números.\n## 🎭 Equilíbrio de talentos entre modelos\nDiga se os melhores chatters estão concentrados em poucas modelos (desequilíbrio) ou bem distribuídos, e se algum chatter parece mais talentoso pra uma modelo específica.\n## 💡 Sugestões\n2-4 sugestões práticas de realocação ou ajuste, se fizer sentido. Se os dados forem insuficientes para alguma conclusão, diga isso claramente em vez de inventar.`;

  try{
    const res=await fetch(AI_PROXY_URL,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:4000,system,messages:[{role:'user',content:prompt}]})
    });
    const data=await res.json();
    const text=data.content?.map(b=>b.type==='text'?b.text:'').join('')||'';
    if(!text)throw new Error(data.error?.message||'Resposta vazia da IA');
    resEl.innerHTML=`<div class="cl-md">${clMd(text)}</div>`;
    toast('✅ Análise comparativa gerada!');
  }catch(err){
    resEl.innerHTML=`<div style="color:var(--bad);font-size:13px">❌ ${err.message}</div>`;
  }finally{
    btn.disabled=false;btn.textContent='⚡ Gerar análise';
  }
}

function renderEvolucao(){
  renderWeekNav();
  const el=document.getElementById('evolucao-content');
  if(!el)return;
  const wkey=getWeekKey();
  const wd=getWeekDates();
  let html='';
  // Mês de referência pro faturamento oficial do financeiro (pedido
  // 04/08/2026) — Evolução navega por semana, então usa a segunda-feira da
  // semana exibida pra decidir qual mês do financeiro mostrar.
  const monthKeyEvo=(wd&&wd[0])?fmt(wd[0]).slice(0,7):fmt(new Date()).slice(0,7);

  if(!S.chatters.length){
    el.innerHTML='<div style="color:var(--text3);font-size:13px;padding:12px 0">Cadastre chatters na aba Equipe</div>';
    return;
  }

  html+=`<div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px">Relatório individual por chatter</div>`;
  let resumoSemanalMudou=false; // pro link myperformance — só salva se algo mudou de verdade

  const goals=S.chatterWeekGoals[wkey]||{};
  let teamTotal=0, teamDays=0, teamTicketSum=0, teamVphSum=0, teamHighSum=0;

  S.chatters.filter(c=>c.time!=='tester'&&c.time!=='elite'&&!isChatterTerminated(c)).forEach(c=>{
    const rev=getChatterWeekRevenueTotal(c.id);
    const meta=parseFloat(goals[c.id])||0;
    const pct=meta>0?Math.round((getChatterWeekRevenue(c.id)/meta)*100):null;
    const f=S.chatterFichas[c.id]||{};
    const analytics=f?.analytics?.weeklyData||{};
    const wkeys=wd.map(d=>fmt(d)).filter(dk=>analytics[dk]&&(!c.testerApprovalDate||dk>=c.testerApprovalDate));

    // Aggregate analytics
    let ticketSum=0,vphSum=0,highSum=0,maxGap=0,days=0,totalV=0,extraV=0,totalVendas=0,htTotalWeek=0;
    const allSaleTimes=[]; // all sale times in minutes for peak hour
    const hourHistTotal=new Array(24).fill(0); // soma dos resumos de dias antigos (já sem detalhe bruto)
    wkeys.forEach(dk=>{
      const a=analytics[dk];
      totalV+=a.chatterTotal||0; extraV+=a.extraTotal||0;
      totalVendas+=a.totalVendas||0;
      htTotalWeek+=a.highTicketTotal||0;
      if(a.ticketMedio>0){ticketSum+=a.ticketMedio;vphSum+=a.vendasPorHora||0;highSum+=a.highTicketPct||0;days++;}
      if((a.maxGapMin||0)>maxGap)maxGap=a.maxGapMin||0;
      if(a.saleTimes)a.saleTimes.forEach(t=>allSaleTimes.push(t));
      else if(a.hourHistogram)a.hourHistogram.forEach((n,h)=>hourHistTotal[h]+=n);
    });
    const avgTicket=days>0?ticketSum/days:0;
    const avgVph=days>0?Math.round(vphSum/days*100)/100:0;
    const avgHigh=days>0?Math.round(highSum/days):0;
    teamTotal+=rev; if(days>0){teamDays++;teamTicketSum+=avgTicket;teamVphSum+=avgVph;teamHighSum+=avgHigh;}

    // Peak hour calculation — find hour with most sales (detalhe bruto e/ou resumo)
    let peakHour=null;
    const hourCount={};
    allSaleTimes.forEach(mins=>{
      const h=Math.floor(mins/60)%24;
      hourCount[h]=(hourCount[h]||0)+1;
    });
    hourHistTotal.forEach((n,h)=>{if(n>0)hourCount[h]=(hourCount[h]||0)+n;});
    const totalSampled=allSaleTimes.length+hourHistTotal.reduce((s,n)=>s+n,0);
    if(totalSampled>=3){
      const topH=Object.entries(hourCount).sort((a,b)=>b[1]-a[1])[0];
      if(topH)peakHour=`${String(topH[0]).padStart(2,'0')}h–${String((parseInt(topH[0])+1)%24).padStart(2,'0')}h`;
    }

    // Chat analyses
    const analyses=[];
    Object.values(S.chatAnalyses||{}).forEach(arr=>(arr||[]).filter(a=>a.chatterId===c.id).forEach(a=>analyses.push(a)));
    const avgScore=analyses.length?Math.round(CHAT_METRICS.reduce((s,m)=>s+analyses.reduce((ss,a)=>ss+(a[m]||0),0)/analyses.length,0)/CHAT_METRICS.length*10)/10:null;

    // Evolution %
    const entries=Object.entries(analytics).sort((a,b)=>a[0].localeCompare(b[0]));
    const evoTicket=entries.length>=2&&entries[0][1].ticketMedio>0?Math.round(((entries[entries.length-1][1].ticketMedio-entries[0][1].ticketMedio)/entries[0][1].ticketMedio)*100):null;
    const evoVph=entries.length>=2&&entries[0][1].vendasPorHora>0?Math.round(((entries[entries.length-1][1].vendasPorHora-entries[0][1].vendasPorHora)/entries[0][1].vendasPorHora)*100):null;

    // Generate recommendations based on data
    // Best/worst day analysis
    let bestDay=null,worstDay=null;
    wkeys.forEach(dk=>{
      const a=analytics[dk];
      if(!a||!(a.chatterTotal>0))return;
      if(!bestDay||a.chatterTotal>analytics[bestDay].chatterTotal)bestDay=dk;
      if(!worstDay||a.chatterTotal<analytics[worstDay].chatterTotal)worstDay=dk;
    });
    const DIAS=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
    const dayName=dk=>{const[y,mo,d]=dk.split('-').map(Number);return DIAS[new Date(y,mo-1,d).getDay()];};

    // Weak points from chat analyses (lowest scoring metric)
    let weakestMetric=null;
    if(analyses.length){
      let low=6,lowM=null;
      CHAT_METRICS.forEach(m=>{
        const avgM=analyses.reduce((s,a)=>s+(a[m]||0),0)/analyses.length;
        if(avgM>0&&avgM<low){low=avgM;lowM=m;}
      });
      if(lowM&&low<4)weakestMetric={name:CHAT_METRIC_LABELS[lowM],score:SCORE_WORD[Math.round(low)]||Math.round(low)};
    }

// Cruza a Ficha (observações escritas à mão) e o último diagnóstico do
// ChatLab (seção "Maiores Erros" do relatório de IA) pra enriquecer a
// análise individual — sem depender só de números.
function getFichaAndDiagnosisInsights(chatterId){
  const insights=[];
  const f=S.chatterFichas[chatterId];
  if(f){
    if(f.evolucaoNotes)insights.push(`Observação do gestor: ${f.evolucaoNotes}`);
    if(f.risk?.riscos)insights.push(`Risco observado na ficha: ${f.risk.riscos}`);
    if(f.potential?.proximos)insights.push(`Próximo passo (ficha): ${f.potential.proximos}`);
    else if(f.tech?.evolucao)insights.push(`Evolução observada na ficha: ${f.tech.evolucao}`);
  }
  const clList=(S.chatlabAnalyses||[]).filter(a=>a.chatterId===chatterId);
  const last=clList[clList.length-1];
  if(last?.raw){
    const m=last.raw.match(/##\s*🔴\s*Maiores Erros[^\n]*\n([\s\S]*?)(?:\n##|$)/i);
    if(m){
      const firstLine=m[1].split('\n').map(l=>l.trim()).filter(l=>l&&l!=='*')[0];
      if(firstLine)insights.push(`Diagnóstico ChatLab: ${firstLine.replace(/^[*\-]\s*/,'')}`);
    }
  }
  return insights;
}
function suggestTrainingText(chatterId){
  const insights=getFichaAndDiagnosisInsights(chatterId);
  const clList=(S.chatlabAnalyses||[]).filter(a=>a.chatterId===chatterId);
  const last=clList[clList.length-1];
  let plano='';
  if(last?.raw){
    const m=last.raw.match(/##\s*📋\s*Plano de Treinamento[^\n]*\n([\s\S]*?)(?:\n##|$)/i);
    if(m)plano=m[1].trim().split('\n').slice(0,3).join(' ');
  }
  const parts=[];
  if(plano)parts.push(plano);
  if(insights.length)parts.push(...insights.slice(0,2));
  return parts.join(' · ');
}
    // Data-driven personalized recommendations
    const recs=[];
    if(peakHour)recs.push(`Rende mais entre <strong>${peakHour}</strong> — concentre os leads quentes e ofertas nesse horário`);
    if(bestDay&&worstDay&&bestDay!==worstDay){
      const diff=analytics[bestDay].chatterTotal-analytics[worstDay].chatterTotal;
      recs.push(`Melhor dia: <strong>${dayName(bestDay)}</strong> (${money(analytics[bestDay].chatterTotal)}) vs pior: ${dayName(worstDay)} (${money(analytics[worstDay].chatterTotal)}) — investigar o que mudou (${money(diff)} de diferença)`);
    }
    if(avgTicket>0&&avgHigh<20)recs.push(`High ticket em ${avgHigh}% — ticket médio é ${money(avgTicket)}, treinar ofertas acima de ${money(avgTicket*1.5)}`);
    if(avgVph>0&&avgVph<10)recs.push(`${money(avgVph)}/hora está abaixo do mínimo (R$10/h) — revisar abordagem ou volume de leads`);
    else if(avgVph>=10&&avgVph<20)recs.push(`${money(avgVph)}/hora é regular — meta: chegar a R$20/h aumentando conversão nos horários fortes`);
    if(maxGap>90)recs.push(`Ficou <strong>${maxGap}min sem vender</strong> — mapear o que aconteceu nesse intervalo (pausa? lead frio? falta de fila?)`);
    if(weakestMetric)recs.push(`Ponto mais fraco nas análises de chat: <strong>${weakestMetric.name}</strong> (${weakestMetric.score}) — prioridade de treinamento`);
    if(pct!==null&&pct<50){
      const falta=meta-getChatterWeekRevenue(c.id);
      recs.push(`${pct}% da meta — faltam ${money(falta)}; com valor/hora atual precisa de ~${avgVph>0?Math.ceil(falta/avgVph)+'h':'mais dados'} de chat focado`);
    }
    if(!recs.length&&rev>0)recs.push(`Desempenho sólido (${money(rev)}, ${totalVendas} vendas) — manter ritmo e testar aumento de ticket`);
    if(!recs.length)recs.push('Sem dados suficientes — processe os relatórios de vendas desta semana');
    // A pedido da gestora: essa lista fica só com comparações NUMÉRICAS —
    // não cruza mais com anotações da Ficha (evolucaoNotes/risco/próximos
    // passos). O diagnóstico do ChatLab continua, mas só no quadro próprio
    // dele mais abaixo (🔬 DIAGNÓSTICO CHATLAB), não misturado aqui.

    const timeLabel=c.time==='tester'?'<span class="pill pill-bad" style="font-size:9px">🧪 Tester</span>':'';

    const evoHead=`<div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <div style="font-weight:800;font-size:15px">${c.name}</div>${timeLabel}
          <span class="pill pill-flat" style="font-size:9px">${c.level}</span>
          <a href="${location.origin}/myperformance.html?id=${encodeURIComponent(c.id)}&nome=${encodeURIComponent(c.name)}" target="_blank" data-noaccordion title="Link pra ${c.name} acompanhar a própria evolução semana a semana" style="font-size:10px;color:var(--accent-strong);font-weight:700;text-decoration:none;white-space:nowrap">📱 myperformance</a>
        </div>
        <div style="text-align:right">
          <div style="font-family:var(--font-mono);font-weight:800;font-size:15px;color:var(--ok)">${money(rev)}</div>
          ${meta>0?`<div style="font-size:11px;color:var(--text3)">${pct}% da meta</div>`:''}
        </div>
      </div>
      ${meta>0?`<div style="background:var(--line);border-radius:4px;height:5px;overflow:hidden;margin-top:8px">
        <div style="height:5px;border-radius:4px;background:${pct>=100?'var(--ok)':pct>=60?'var(--warn)':'var(--bad)'};width:${Math.min(100,pct||0)}%"></div>
      </div>`:''}
    </div>`;
    // Dia a dia da semana — a pedido da gestora, clicando no card (evoHead
    // já é o cabeçalho do accordion) aparece isso: faturamento/vendas/%HT de
    // cada dia trabalhado, e se a meta semanal já tinha sido batida
    // (cumulativo) até aquele dia.
    const diaADiaHtml=wkeys.length?(()=>{
      let cumulativo=0;
      const linhas=wkeys.map(dk=>{
        const a=analytics[dk];
        const diaRev=(a.chatterTotal||0)+(a.extraTotal||0);
        cumulativo+=diaRev;
        const bateuMeta=meta>0&&cumulativo>=meta;
        return`<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--line);font-size:12px">
          <div style="display:flex;align-items:center;gap:6px;min-width:70px">
            <span style="font-weight:700">${dayName(dk)}</span>
            ${meta>0?`<span title="${bateuMeta?'Meta semanal já batida até esse dia':'Ainda não batia a meta semanal'}">${bateuMeta?'✅':'⏳'}</span>`:''}
          </div>
          <div style="display:flex;gap:10px;color:var(--text2);font-family:var(--font-mono);font-size:11.5px">
            <span title="Faturamento do dia">${money(diaRev)}</span>
            <span title="Vendas do dia" style="font-family:var(--font);color:var(--info)">${a.totalVendas||0}v</span>
            <span title="% high ticket do dia" style="font-family:var(--font)">${a.highTicketPct||0}%HT</span>
          </div>
        </div>`;
      }).join('');
      return`<div style="margin-bottom:10px">
        <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;margin-bottom:4px">📅 Dia a dia da semana</div>
        ${linhas}
      </div>`;
    })():'';
    // Meta mensal + aviso de medalha — reaproveita o mesmo cálculo já usado
    // em Pagamento (categoria/medalha automática), só resumido aqui.
    const savedCatEvo=S.chatterFichas?.[c.id]?.pagCategoria||'B';
    const manualMedalRawEvo=S.chatterFichas?.[c.id]?.manualMedal;
    const statsEvoTmp=getChatterMonthStats(c.id);
    const autoMedalEvo=autoMedalForChatter(c.id,savedCatEvo,statsEvoTmp.monthRevenue+statsEvoTmp.monthExtra);
    const medalAtualEvo=(manualMedalRawEvo!==undefined&&manualMedalRawEvo!=='')?parseInt(manualMedalRawEvo,10):autoMedalEvo;
    const monthEarnEvo=getChatterMonthEarnings(c.id,medalAtualEvo,savedCatEvo);
    const metaMensalEvo=PAG_CATS[savedCatEvo].n100*(getDaysInCurrentMonth()/7);
    const pctMesEvo=metaMensalEvo>0?Math.round((monthEarnEvo.monthRevenue+monthEarnEvo.monthExtra)/metaMensalEvo*100):0;
    const medalPendenteEvo=(S.medalAchievements||[]).find(m=>m.chatterId===c.id&&!m.seen);
    const metaMensalHtml=`<div style="background:var(--bg-soft);border-radius:8px;padding:10px;margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase">📆 Meta mensal</div>
        <div style="font-size:11px;color:var(--text2)">${PAG_MEDAL_LABEL[medalAtualEvo]}</div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <span style="font-family:var(--font-mono);font-weight:700;font-size:14px">${money(monthEarnEvo.monthRevenue+monthEarnEvo.monthExtra)}</span>
        <span style="font-size:10.5px;color:var(--text3)">de ${money(metaMensalEvo)} (${pctMesEvo}%)</span>
      </div>
      <div style="background:var(--line);border-radius:4px;height:5px;overflow:hidden">
        <div style="height:5px;border-radius:4px;background:${pctMesEvo>=100?'var(--ok)':'var(--accent)'};width:${Math.min(100,pctMesEvo)}%"></div>
      </div>
    </div>
    ${medalPendenteEvo?`<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--accent-soft);border-radius:8px;padding:9px 12px;margin-bottom:8px;font-size:12.5px">
      <span>${PAG_MEDAL_LABEL[medalPendenteEvo.medal]||''} <strong>${c.name}</strong> tem direito a nova medalha essa semana!</span>
      <button class="btn btn-ghost btn-xs" data-noaccordion onclick="dismissMedalAchievement('${medalPendenteEvo.id}')" title="Marcar como visto">✕</button>
    </div>`:''}`;
    // 💰 Financeiro oficial (pedido 04/08/2026) — faturamento, meta, horas,
    // high tickets e categoria/prêmio semanal, direto da planilha oficial
    // importada do financeiro (S.faturamentoFinanceiro), quando existe pra
    // essa pessoa nesse mês. Convive com o quadro "Meta mensal" (que usa a
    // medalha/categoria calculada de dentro do próprio app) — esse aqui é a
    // fonte externa, lado a lado, pra comparar.
    const finEvo=getChatterFinanceiroMes(c.id,monthKeyEvo);
    const financeiroOficialHtml=finEvo?`<div style="background:var(--accent-soft);border:1px solid var(--accent);border-radius:8px;padding:10px;margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="font-size:10px;font-weight:700;color:var(--accent-strong);text-transform:uppercase">📁 Financeiro oficial — ${amMonthLabel(monthKeyEvo)}</div>
        ${finEvo.categoriaAtual?`<div style="font-size:11px;color:var(--text2);font-weight:700">Categoria ${finEvo.categoriaAtual}</div>`:''}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <span style="font-family:var(--font-mono);font-weight:800;font-size:15px">${money(finEvo.totalGeral)}</span>
        <span style="font-size:10.5px;color:var(--text3)">de ${money(finEvo.meta)} (${Math.round((finEvo.pctMeta||0)*100)}%)</span>
      </div>
      <div style="background:var(--line);border-radius:4px;height:5px;overflow:hidden;margin-bottom:8px">
        <div style="height:5px;border-radius:4px;background:${finEvo.atingiuMeta?'var(--ok)':'var(--accent)'};width:${Math.min(100,Math.round((finEvo.pctMeta||0)*100))}%"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
        <div style="text-align:center">
          <div style="font-size:9px;color:var(--text3)">Horas no mês</div>
          <div style="font-size:13px;font-weight:700;font-family:var(--font-mono)">${Math.round((finEvo.horasTotais||0)*10)/10}h</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:9px;color:var(--text3)">High tickets</div>
          <div style="font-size:13px;font-weight:700;font-family:var(--font-mono)">${finEvo.htCount||0}</div>
        </div>
        <div style="text-align:center">
          <div style="font-size:9px;color:var(--text3)">Extra (hora extra)</div>
          <div style="font-size:13px;font-weight:700;font-family:var(--font-mono)">${money(finEvo.totalExtra||0)}</div>
        </div>
      </div>
      ${(finEvo.porSemana||[]).length?`<div style="margin-top:8px;border-top:1px solid var(--line);padding-top:6px">
        ${finEvo.porSemana.map(s=>`<div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;padding:2px 0">
          <span style="color:var(--text2)">${s.semana} · cat. ${s.categoria||'—'}</span>
          <span style="font-family:var(--font-mono);color:var(--text2)">${money(s.faturamento)}</span>
          <span style="font-weight:700;color:${s.nivel&&s.nivel!=='não bateu'?'var(--ok)':'var(--text3)'}">${s.nivel||'—'}${s.premio?' · '+money(s.premio):''}</span>
        </div>`).join('')}
      </div>`:''}
      <div style="font-size:9.5px;color:var(--text3);margin-top:6px">Arquivo: ${finEvo.arquivoNome||'—'} · importado ${finEvo.importadoEm?new Date(finEvo.importadoEm).toLocaleDateString('pt-BR'):''}</div>
    </div>`:'';
    const evoBody=`${diaADiaHtml}${financeiroOficialHtml}${metaMensalHtml}${days>0?`<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px">
        <div style="background:var(--bg-soft);border-radius:7px;padding:7px;text-align:center">
          <div style="font-size:9px;color:var(--text3)">Ticket médio</div>
          <div style="font-size:13px;font-weight:700;font-family:var(--font-mono)">${money(avgTicket)}</div>
          ${evoTicket!==null?`<div style="font-size:10px;color:${evoTicket>=0?'var(--ok)':'var(--bad)'}">${evoTicket>=0?'▲':'▼'}${Math.abs(evoTicket)}%</div>`:''}
        </div>
        <div style="background:var(--bg-soft);border-radius:7px;padding:7px;text-align:center">
          <div style="font-size:9px;color:var(--text3)">Valor/hora</div>
          <div style="font-size:13px;font-weight:700;color:${avgVph>=20?'var(--ok)':avgVph>=10?'var(--warn)':'var(--bad)'}">${money(avgVph)}/h</div>
          ${evoVph!==null?`<div style="font-size:10px;color:${evoVph>=0?'var(--ok)':'var(--bad)'}">${evoVph>=0?'▲':'▼'}${Math.abs(evoVph)}%</div>`:''}
        </div>
        <div style="background:var(--bg-soft);border-radius:7px;padding:7px;text-align:center">
          <div style="font-size:9px;color:var(--text3)">High ticket ≥R$300</div>
          <div style="font-size:13px;font-weight:700;color:${avgHigh>=30?'var(--ok)':avgHigh>=15?'var(--warn)':'var(--bad)'}">${avgHigh}%</div>
          ${htTotalWeek>0?`<div style="font-size:10px;color:var(--text3)">${money(htTotalWeek)}/sem.</div>`:''}
        </div>
        <div style="background:var(--bg-soft);border-radius:7px;padding:7px;text-align:center">
          <div style="font-size:9px;color:var(--text3)">Vendas semana</div>
          <div style="font-size:15px;font-weight:800;color:var(--info)">${totalVendas}</div>
        </div>
        <div style="background:var(--bg-soft);border-radius:7px;padding:7px;text-align:center;grid-column:${peakHour?'2/4':'2/3'}">
          <div style="font-size:9px;color:var(--text3)">🔥 Melhor horário</div>
          <div style="font-size:13px;font-weight:700;color:var(--accent)">${peakHour||'—'}</div>
        </div>
      </div>`:'<div style="font-size:12px;color:var(--text3);margin-bottom:8px">Processe relatórios para ver métricas</div>'}
      ${avgScore!==null?`<div style="font-size:12px;color:var(--text2);margin-bottom:8px">Análise do chat: <strong style="color:${avgScore>=4?'var(--ok)':avgScore>=3?'var(--warn)':'var(--bad)'}">${SCORE_WORD[Math.round(avgScore)]||avgScore}</strong> (${analyses.length} análise${analyses.length>1?'s':''})</div>`:''}
      <div style="background:var(--bg-soft);border-radius:8px;padding:10px">
        <div style="font-size:11px;font-weight:700;color:var(--text3);margin-bottom:6px">💡 ONDE MELHORAR</div>
        ${recs.map(r=>`<div style="font-size:12.5px;color:var(--text);padding:3px 0;border-bottom:1px solid var(--line)">• ${r}</div>`).join('')}
        <textarea class="ftext" style="min-height:44px;font-size:12.5px;background:#fff;margin-top:8px" placeholder="Adicione ou corrija algo sobre ${c.name}..." onblur="saveEvolucaoNote('${c.id}',this.value)">${S.chatterFichas[c.id]?.evolucaoNotes||''}</textarea>
      </div>
      ${(()=>{
        // Diagnostic square — latest ChatLab analysis
        const clList=(S.chatlabAnalyses||[]).filter(a=>a.chatterId===c.id);
        const last=clList[clList.length-1];
        if(!last)return`<div style="background:var(--info-soft);border-radius:8px;padding:10px;margin-top:8px">
          <div style="font-size:11px;font-weight:700;color:var(--info);margin-bottom:4px">🔬 DIAGNÓSTICO CHATLAB</div>
          <div style="font-size:12px;color:var(--text3)">Sem análise ainda — <span style="color:var(--info);cursor:pointer;text-decoration:underline" onclick="navTo('chatlab')">analisar conversa →</span></div>
        </div>`;
        const col=last.igp>=70?'var(--ok)':last.igp>=50?'var(--warn)':'var(--bad)';
        return`<div style="background:var(--info-soft);border-radius:8px;padding:10px;margin-top:8px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
            <div style="font-size:11px;font-weight:700;color:var(--info)">🔬 DIAGNÓSTICO CHATLAB</div>
            <div style="display:flex;align-items:center;gap:6px">
              <span style="font-family:var(--font-mono);font-weight:800;font-size:16px;color:${col}">${last.igp||'—'}</span>
              <span style="font-size:10px;color:var(--text3)">IGP · ${new Date(last.date).toLocaleDateString('pt-BR',{day:'2-digit',month:'short'})} · ${clList.length} análise${clList.length>1?'s':''}</span>
            </div>
          </div>
          ${last.resumo?`<div style="font-size:12px;color:var(--text2);line-height:1.6">${clMd(last.resumo)}</div>`:''}
        </div>`;
      })()}
      <div style="background:var(--warn-soft);border-radius:8px;padding:10px;margin-top:8px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <div style="font-size:11px;font-weight:700;color:var(--warn)">🏋️ COMO TREINAR MELHOR</div>
          <button class="btn btn-ghost btn-xs" onclick="sendTrainingToWeek('${c.id}')">→ orientações da semana</button>
        </div>
        <textarea class="ftext" style="min-height:52px;font-size:12.5px;background:#fff" placeholder="Escreva como treinar ${c.name} esta semana..." onblur="saveChatterTraining('${c.id}',this.value)">${(S.chatterTraining[c.id]||suggestTrainingText(c.id))}</textarea>
      </div>`;
    html+=fichaAccordion('evocard-'+c.id,`margin-bottom:10px;border-left:3px solid ${pct===null?'var(--line)':pct>=80?'var(--ok)':pct>=50?'var(--warn)':'var(--bad)'}`,evoHead,evoBody);

    // Snapshot resumido pro link myperformance (fatia própria e SEGURA, sem
    // Dados PJ — ver comentário em SHARD_FIELDS). Só marca dirty se mudou.
    if(!S.chatterWeeklySummaries[c.id])S.chatterWeeklySummaries[c.id]={};
    const resumoSemana={
      revenue:rev,meta,pct,avgTicket,avgVph,avgHigh,htTotal:htTotalWeek,totalVendas,peakHour,
      medal:medalAtualEvo,
      dayByDay:wkeys.map(dk=>{
        const a=analytics[dk];
        return{dk,rev:(a.chatterTotal||0)+(a.extraTotal||0),vendas:a.totalVendas||0,htPct:a.highTicketPct||0};
      })
    };
    const resumoAnterior=S.chatterWeeklySummaries[c.id][wkey];
    if(JSON.stringify(resumoAnterior)!==JSON.stringify(resumoSemana)){
      S.chatterWeeklySummaries[c.id][wkey]=resumoSemana;
      resumoSemanalMudou=true;
    }
    // Também guarda o progresso mensal já calculado (sem categoria/PAG_CATS
    // no link público — só o número final, que não é sensível)
    // Financeiro oficial pro link público (pedido 04/08/2026) — só os
    // números de desempenho, NUNCA os dados pessoais/PJ da planilha
    // (nome, CNPJ, endereço, telefone, e-mail, PIX ficam de fora por
    // completo — nem são lidos aqui, só o resumo calculado).
    const finPorSemanaMapped=(finEvo?.porSemana||[]).map(s=>({
      semana:s.semana,categoria:s.categoria,faturamento:s.faturamento,pctMeta:s.pctMeta,
      nivel:s.nivel,premio:s.premio,horas:s.horas,
      bateuMeta:!!s.nivel&&s.nivel!=='não bateu'
      // Não tem mais "medal" por semana individual — a régua nova
      // (04/08/2026) não é mais por %/semana isolada: Bronze/Prata olham
      // as últimas 3 semanas seguidas E Ouro/Diamante são valor absoluto
      // do MÊS. A medalha atual (única, por chatter) está em recebimento.medalAtual.
    }));
    // Valores que a pessoa recebe (pedido 04/08/2026) — mesma régua de
    // pagamento usada em Pagamento/calcChatterPagamento, aplicada aos
    // números oficiais do financeiro: comissão sobre o faturamento total
    // (% conforme a medalha da semana mais recente já lançada), soma dos
    // prêmios de meta por semana (já vem calculado certinho da própria
    // planilha, então só somamos), bônus de 8% sobre high ticket e 10%
    // sobre hora extra. O "piso" continua só informativo (mínimo garantido,
    // não soma nem substitui o calculado) — mesma regra do resto do app.
    const finMedalAtual=finEvo?autoMedalForChatter(c.id,savedCatEvo,finEvo.totalGeral):0;
    const finComissao=finEvo?Math.round((finEvo.totalGeral||0)*(PAG_COM[finMedalAtual]||0.04)*100)/100:0;
    const finPremioTotal=Math.round(finPorSemanaMapped.reduce((s,w)=>s+(w.premio||0),0)*100)/100;
    const finHtBonus=finEvo?Math.round((finEvo.htBonusTotal||(finEvo.htTotalValor||0)*0.08)*100)/100:0;
    const finExtraBonus=finEvo?Math.round((finEvo.totalExtra||0)*0.10*100)/100:0;
    const finTotalAReceber=Math.round((finComissao+finPremioTotal+finHtBonus+finExtraBonus)*100)/100;
    const finPiso=PAG_PISO[finMedalAtual]||1000;
    const financeiroOficialSnap=finEvo?{
      monthKey:monthKeyEvo,totalGeral:finEvo.totalGeral,totalTurno:finEvo.totalTurno,totalExtra:finEvo.totalExtra,
      meta:finEvo.meta,pctMeta:finEvo.pctMeta,atingiuMeta:finEvo.atingiuMeta,horasTotais:finEvo.horasTotais,
      htCount:finEvo.htCount,htMaior:finEvo.htMaior,htBonusTotal:finEvo.htBonusTotal,htTotalValor:finEvo.htTotalValor,
      categoriaAtual:finEvo.categoriaAtual,
      // Resumo diário (turno+extra+HT por dia) e por tipo de produto de HT —
      // pedido 04/08/2026 pra deixar o myperformance com "tudo visível na
      // mesma página": nada aqui identifica cliente/CNPJ/PJ, só números de
      // desempenho por dia, seguro pro link público.
      porDiaTurno:finEvo.porDiaTurno||{},porDiaExtra:finEvo.porDiaExtra||{},
      htPorDia:finEvo.htPorDia||{},htPorProduto:finEvo.htPorProduto||{},
      porSemana:finPorSemanaMapped,
      // Valores a receber — indicadores de pagamento (pedido 04/08/2026)
      recebimento:{
        medalAtual:finMedalAtual,comPct:PAG_COM_LABEL[finMedalAtual]||'4%',
        comissao:finComissao,premioTotal:finPremioTotal,htBonus:finHtBonus,extraBonus:finExtraBonus,
        total:finTotalAReceber,piso:finPiso
      }
    }:null;
    const currentMonthSnap={
      monthRevenue:Math.round((monthEarnEvo.monthRevenue+monthEarnEvo.monthExtra)*100)/100,
      metaMensal:Math.round(metaMensalEvo*100)/100,
      pctMes:pctMesEvo,
      medal:medalAtualEvo,
      medalPendente:medalPendenteEvo?{id:medalPendenteEvo.id,medal:medalPendenteEvo.medal}:null,
      financeiroOficial:financeiroOficialSnap
    };
    if(JSON.stringify(S.chatterWeeklySummaries[c.id].currentMonth)!==JSON.stringify(currentMonthSnap)){
      S.chatterWeeklySummaries[c.id].currentMonth=currentMonthSnap;
      resumoSemanalMudou=true;
    }
  });
  if(resumoSemanalMudou)save();

  // Team summary report
  const avgTeamTicket=teamDays>0?teamTicketSum/teamDays:0;
  const avgTeamVph=teamDays>0?Math.round(teamVphSum/teamDays*100)/100:0;
  const avgTeamHigh=teamDays>0?Math.round(teamHighSum/teamDays):0;

  const p=S.managerProfile||{};
  const estudos=S.estudosDraft||{};

  html+=`<div class="panel" style="border:2px solid var(--accent);margin-top:8px">
    <div style="font-size:11px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px">📈 Relatório semanal da equipe — ${wkey}</div>
    <div class="reprow"><div class="replb">Total equipe</div><div class="repval" style="font-weight:800">${money(teamTotal)}</div></div>
    ${avgTeamTicket>0?`<div class="reprow"><div class="replb">Ticket médio geral</div><div class="repval">${money(avgTeamTicket)}</div></div>`:''}
    ${avgTeamVph>0?`<div class="reprow"><div class="replb">Valor/hora médio</div><div class="repval">${money(avgTeamVph)}/h</div></div>`:''}
    ${avgTeamHigh>0?`<div class="reprow"><div class="replb">High ticket médio</div><div class="repval">${avgTeamHigh}%</div></div>`:''}
    <div style="margin-top:12px;font-size:11px;font-weight:700;color:var(--text3);margin-bottom:6px">GESTÃO — ${p.name||'Gestor'} · ${p.cargo||''}</div>
    ${estudos.foco1||estudos.foco2||estudos.foco3?`<div style="font-size:12.5px;color:var(--text2)"><strong>Focos:</strong> ${[estudos.foco1,estudos.foco2,estudos.foco3].filter(Boolean).join(' · ')}</div>`:''}
    <button class="btn btn-ghost btn-sm btn-block" style="margin-top:10px" onclick="copiarRelatorioEvolucao()">📋 Copiar relatório</button>
  </div>`;

  el.innerHTML=html;
}

function copiarRelatorioEvolucao(){
  const el=document.getElementById('evolucao-content');
  if(!el)return;
  const text=el.innerText||el.textContent||'';
  navigator.clipboard?.writeText(text).then(()=>toast('📋 Relatório copiado!'));
}

function deleteShift(shiftId){
  if(!confirm('Remover este turno?'))return;
  markTombstone(shiftId);
  S.shifts=S.shifts.filter(s=>s.id!==shiftId);
  save();renderTurno();toast('Turno removido');
  // Não espera o debounce de 600ms — em exclusões, envia pro Firestore JÁ.
  // Sem isso, um recarregamento de página muito rápido (menos de 600ms)
  // podia pegar a versão antiga do servidor antes do envio sair, trazendo
  // o turno de volta na corrida.
  clearTimeout(fbSaveTimer);
  pushToFirestore();
}

/* ===========================================================
   FATURAMENTO — hora extra
   =========================================================== */
function renderExtraProgress(){
  const el=document.getElementById('fat-extra-progress');
  if(!el)return;
  const chattersWithExtra=S.chatters.filter(c=>getChatterExtraRevenue(c.id)>0);
  if(!chattersWithExtra.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Nenhuma hora extra registrada esta semana</div>';return;}
  el.innerHTML=chattersWithExtra.map(c=>{
    const det=getChatterExtraRevenueDetailed(c.id);
    const byModelHtml=Object.entries(det.byModel).map(([name,val])=>
      `<div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--text2);padding:2px 0 2px 10px"><span>${name}</span><span style="font-family:var(--font-mono)">${money(val)}</span></div>`
    ).join('');
    return`<div style="padding:8px 0;border-bottom:1px solid var(--line)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <div style="font-weight:600;font-size:13px">${c.name}</div>
        <div style="font-family:var(--font-mono);font-weight:700;color:var(--info)">⚡ ${money(det.total)}</div>
      </div>
      ${byModelHtml}
    </div>`;
  }).join('');
}

function renderChatterAnalysis(){
  const el=document.getElementById('fat-chatter-analysis');
  if(!el)return;
  const sel=document.getElementById('fat-analysis-chatter');
  if(sel&&!sel.options.length)sel.innerHTML='<option value="">— selecionar —</option>'+S.chatters.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
  const chatterId=sel?.value;
  if(!chatterId){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Selecione um chatter para ver análise</div>';return;}

  const f=S.chatterFichas[chatterId];
  const analytics=f?.analytics?.weeklyData||{};
  const wd=getWeekDates();

  // Aggregate analytics from parsed reports this week
  let totalRev=0,totalSales=0,totalTicket=0,totalHighPct=0,totalGap=0,extraTot=0,totalVPH=0,daysCount=0;
  wd.forEach(d=>{
    const dk=fmt(d);
    if(analytics[dk]){
      const a=analytics[dk];
      totalRev+=a.chatterTotal||0;
      totalSales+=a.totalVendas||0;
      if(a.ticketMedio>0){totalTicket+=a.ticketMedio;totalVPH+=a.vendasPorHora||0;totalHighPct+=a.highTicketPct||0;daysCount++;}
      if(a.maxGapMin>totalGap)totalGap=a.maxGapMin;
      extraTot+=a.extraTotal||0;
    }
  });

  const ticketMedioSemana=daysCount>0?totalTicket/daysCount:0;
  const highPctSemana=daysCount>0?Math.round(totalHighPct/daysCount):0;
  const vphSemana=daysCount>0?Math.round((totalVPH/daysCount)*100)/100:0;

  // Fall back to revenue data if no analytics yet
  if(!daysCount){
    let revTotal=0;let revDays=0;
    wd.forEach(d=>{let dr=0;S.models.forEach(m=>{dr+=parseFloat(S.revenues[`${chatterId}_${m.id}_${fmt(d)}`])||0;});if(dr>0){revTotal+=dr;revDays++;}});
    totalRev=revTotal;
    const ticketFallback=totalSales>0?revTotal/totalSales:0;
    el.innerHTML=`
      <div class="reprow"><div class="replb">Faturamento semana</div><div class="repval">${money(totalRev)}</div></div>
      <div class="reprow"><div class="replb">Dias com vendas</div><div class="repval">${revDays} dias</div></div>
      <div style="margin-top:8px;font-size:12px;color:var(--text3)">Cole relatórios na aba Rel.Equipe para ver ticket médio, high ticket e tempo sem venda.</div>`;
    return;
  }

  el.innerHTML=`
    <div class="reprow"><div class="replb">Faturamento semana</div><div class="repval">${money(totalRev)}</div></div>
    <div class="reprow"><div class="replb">Ticket médio (semana)</div><div class="repval">${money(ticketMedioSemana)}</div></div>
    <div class="reprow"><div class="replb">% High ticket</div><div class="repval" style="color:${highPctSemana>=30?'var(--ok)':'var(--warn)'}">${highPctSemana}%</div></div>
    <div class="reprow"><div class="replb">Valor/hora (média)</div><div class="repval" style="color:${vphSemana>=1?'var(--ok)':vphSemana>=0.5?'var(--warn)':'var(--bad)'}">${vphSemana}</div></div>
    <div class="reprow"><div class="replb">Maior tempo sem venda</div><div class="repval" style="color:${totalGap>60?'var(--bad)':totalGap>30?'var(--warn)':'var(--ok)'}">${totalGap?totalGap+'min':'—'}</div></div>
    ${extraTot>0?`<div class="reprow"><div class="replb">Hora extra (semana)</div><div class="repval" style="color:var(--info)">⚡ ${money(extraTot)}</div></div>`:''}
    <div class="reprow"><div class="replb">Dias analisados</div><div class="repval">${daysCount}</div></div>
    ${daysCount>0?`
    <div style="margin-top:10px;font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Por dia</div>
    ${wd.filter(d=>analytics[fmt(d)]).map(d=>{const a=analytics[fmt(d)];return`
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line);font-size:12px">
        <span style="color:var(--text2)">${fmt(d)}</span>
        <span>${money(a.chatterTotal)} · ${a.totalVendas} vendas · ${a.vendasPorHora||0}/h</span>
      </div>`}).join('')}`:''}`;
}

/* ===========================================================
   GESTÃO — updated renderGestao
   =========================================================== */
function renderGestaoMissingReports(){
  // Redirect to home panel
  renderHomeMissingReports();
}

function renderHomeMissingReports(){
  const el=document.getElementById('home-missing-reports');
  if(!el)return;
  if(!S.models.length||!S.chatters.length){el.innerHTML='';return;}
  const wd=getWeekDates();
  const missing=[];
  wd.forEach(d=>{
    const dk=fmt(d);
    if(dk>todayKey())return;
    S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c)).forEach(c=>{
      const hasRev=S.models.some(m=>(parseFloat(S.revenues[`${c.id}_${m.id}_${dk}`])||0)>0);
      const justKey='just_'+c.id+'_'+dk;
      const hasJust=S.justificativas&&S.justificativas[justKey];
      if(!hasRev&&!hasJust&&!chatterNaoPrecisaDeRelatorio(c.id,dk))missing.push({name:c.name,id:c.id,date:dk});
    });
  });
  if(!missing.length){el.innerHTML='';return;}
  // Group by chatter
  const byChatter={};
  missing.forEach(x=>{
    if(!byChatter[x.id])byChatter[x.id]={name:x.name,id:x.id,dates:[]};
    byChatter[x.id].dates.push(x.date);
  });
  // Small compact warning
  el.innerHTML=`<div style="background:var(--bad-soft);border:1px solid var(--bad);border-radius:10px;padding:12px;margin-bottom:10px">
    <div style="font-size:12px;font-weight:700;color:var(--bad);margin-bottom:8px">📋 Sem relatório de vendas</div>
    ${Object.values(byChatter).map(x=>`
      <div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid rgba(180,35,52,.15)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <span style="font-size:13px;font-weight:700">${x.name}</span>
          <span style="font-size:11px;color:var(--bad)">${x.dates.map(d=>d.slice(5)).join(', ')}</span>
        </div>
        <input class="finput" style="font-size:12px;padding:5px 9px;background:#fff"
          placeholder="Justificativa..." 
          value="${(S.justificativas&&S.justificativas['just_'+x.id+'_'+x.dates[0]])||''}"
          onblur="saveJustificativa2('${x.id}',this.value,'${x.dates.join(',')}')">
      </div>`).join('')}
  </div>`;
}
function saveJustificativa(chatterId,text){
  if(!S.justificativas)S.justificativas={};
  S.justificativas[todayKey()+'_'+chatterId]=text;
  save();
}
function saveJustificativa2(chatterId,text,datesStr){
  if(!S.justificativas)S.justificativas={};
  (datesStr||'').split(',').forEach(dk=>{
    S.justificativas['just_'+chatterId+'_'+dk.trim()]=text;
  });
  save();
  renderHomeMissingReports();
}

function renderGestao(){
  renderManagerProfile();
  renderDemandas2();
  renderTaskBoards();
  renderEventActionList();
  renderTrainings();
  renderTreinamentoFixo();
  renderAquecimento();
  renderPrizePanel();
  renderModelRequestsSplit();
  renderScheduleRequests();
  renderWeeklyChatAnalysisBoard();
  renderOrientNeedBoard();
  const sel=document.getElementById('sched-req-chatter');
  if(sel&&!sel.options.length)sel.innerHTML=S.chatters.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
  renderOrientList();
  renderGestaoMissingReports();
}

/* ===========================================================
   EVOLUÇÃO — auto-summary of all people
   =========================================================== */



/* ===========================================================
   TURNO — copy and edit mode
   =========================================================== */
function copyTurnoDay(){
  const el=document.getElementById('turno-day-list');
  if(!el)return;
  const text=el.innerText||el.textContent||'';
  navigator.clipboard?.writeText(text).then(()=>toast('📋 Escala do dia copiada!'));
}

function copyTurnoWeek(){
  const el=document.getElementById('turno-week-list');
  if(!el)return;
  // Build readable text from the week schedule
  const DAY_LABEL={seg:'Seg',ter:'Ter',qua:'Qua',qui:'Qui',sex:'Sex',sab:'Sáb',dom:'Dom'};
  const wd=getWeekDates();
  let lines=['📅 ESCALA DA SEMANA',''];
  S.models.forEach(m=>{
    const modelShifts=S.shifts.filter(s=>(s.modelIds||[]).includes(m.id)&&s.chatterId);
    if(!modelShifts.length)return;
    lines.push(`${m.emoji||'🧩'} ${m.name}`);
    const sorted=[...modelShifts].sort((a,b)=>{
      const toM=t=>{if(!t)return 9999;const[h,mn]=t.split(':').map(Number);return h<7?h*60+mn+1440:h*60+mn;};
      return toM(a.start)-toM(b.start);
    });
    sorted.forEach(s=>{
      const c=S.chatters.find(ch=>ch.id===s.chatterId);
      if(!c||c.time==='elite')return;
      const days=(s.days||[]).map(d=>DAY_LABEL[d]).join('/');
      const t2=s.start2&&s.end2?` + ${s.start2}–${s.end2}`:'';
      lines.push(`  ${c.name}: ${s.start}–${s.end}${t2} (${days})`);
    });
    lines.push('');
  });
  const text=lines.join('\n');
  navigator.clipboard?.writeText(text).then(()=>toast('📋 Escala da semana copiada!'));
}

let turnoEditMode=false;
function toggleTurnoEditMode(){
  turnoEditMode=!turnoEditMode;
  if(typeof renderTurnoSchedule==='function')renderTurnoSchedule();
  if(turnoEditMode)toast('Modo edição ativo — clique em ❌ falta ou 🔁 trocar');
}


/* ===========================================================
   ORIENTAÇÕES DA SEMANA — done items only vanish on new week
   =========================================================== */
// Detecta quem está com muita dificuldade de bater a meta (< 50%) e pouca
// evolução, e sugere automaticamente uma orientação — sem duplicar a
// mesma sugestão na mesma semana, e sem nunca remover o que o gestor
// escreveu manualmente.
function autoSuggestOrientations(){
  const wk=getWeekKey(0);
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  chatters.forEach(c=>{
    const meta=parseFloat((S.chatterWeekGoals[wk]||{})[c.id])||0;
    if(!meta)return;
    const rev=getChatterWeekRevenue(c.id,0);
    const pct=rev/meta*100;
    if(pct>=50)return; // não está em dificuldade severa
    const evo=calcEvolutionPct(c.id);
    const poucaEvolucao=!evo||Object.values(evo).every(v=>v<=5);
    if(!poucaEvolucao)return;
    const already=S.weekOrients.some(o=>o.chatterId===c.id&&o.autoWeek===wk);
    if(already)return;
    S.weekOrients.push({id:'wo'+Date.now()+Math.random().toString(36).slice(2,4),chatterId:c.id,
      text:`⚠️ ${c.name} está em ${Math.round(pct)}% da meta com pouca evolução — sugestão automática: conversa 1:1 e reforço de treinamento`,
      done:false,doneWeek:null,auto:true,autoWeek:wk});
  });
}
function renderWeekOrients(){
  const el=document.getElementById('week-orients-list');
  if(!el)return;
  const wk=getWeekKey();
  autoSuggestOrientations();
  // prune: done in a PREVIOUS week disappears
  S.weekOrients=S.weekOrients.filter(o=>!o.done||o.doneWeek===wk);
  if(!S.weekOrients.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px;padding:6px 0">Nenhuma orientação esta semana</div>';return;}
  el.innerHTML=S.weekOrients.map(o=>{
    const c=o.chatterId?S.chatters.find(ch=>ch.id===o.chatterId):null;
    return`<div style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">
      <button onclick="toggleWeekOrient('${o.id}')" style="width:20px;height:20px;border-radius:5px;border:2px solid ${o.done?'var(--ok)':'var(--line-strong)'};background:${o.done?'var(--ok)':'transparent'};cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;margin-top:1px">${o.done?'<span style="color:#fff">✓</span>':''}</button>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;${o.done?'text-decoration:line-through;color:var(--text3)':''}">${o.text}${o.auto?' <span class="pill pill-info" style="font-size:9px">auto</span>':''}</div>
        ${c?`<div style="font-size:10.5px;color:var(--accent);margin-top:1px">👤 ${c.name}${o.time?` · ⏰ ${o.time}${o.date?' ('+o.date.split('-').reverse().join('/')+')':''}`:''}</div>`:''}
      </div>
      <button onclick="removeWeekOrient('${o.id}')" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:13px">✕</button>
    </div>`;
  }).join('');
}
function addWeekOrient(text,chatterId){
  const inp=document.getElementById('week-orient-input');
  const t=(typeof text==='string'&&text)?text:(inp?.value.trim());
  if(!t){toast('⚠️ Escreva a orientação');return;}
  S.weekOrients.push({id:'wo'+Date.now(),chatterId:chatterId||null,text:t,done:false,doneWeek:null});
  if(inp&&typeof text!=='string')inp.value='';
  save();renderWeekOrients();
  toast('✅ Orientação adicionada à semana');
}
function toggleWeekOrient(id){
  const o=S.weekOrients.find(x=>x.id===id);
  if(!o)return;
  o.done=!o.done;
  o.doneWeek=o.done?getWeekKey():null;
  save();renderWeekOrients();
}
function removeWeekOrient(id){
  S.weekOrients=S.weekOrients.filter(x=>x.id!==id);
  save();renderWeekOrients();
}

/* ===========================================================
   CHATLAB — análise de conversas com IA (aba integrada)
   Baseado nos manuais internos: escala de temperatura 1-10, os
   10 arquétipos de lead (com tom e gatilho), as 9 técnicas de
   negociação, as 8 técnicas avançadas de persuasão e os sinais
   de whale — em vez de critérios genéricos de "vendas".
   =========================================================== */
const PLAYBOOK_CATALOGO=`
ESCALA DE TEMPERATURA (Manual de Aplicação — 1 a 10):
1 GELADO (zero sinal) · 2 FRIO (respostas curtas, sem emoção) · 3 ESQUENTANDO (pergunta de você ou conta de si) · 4 MORNO (primeira insinuação leve) · 5 PEDIU PRA VER ("manda uma foto" — NÃO é sinal de compra) · 6 IMAGINANDO (ele descreve, se solta) · 7 NO LIMITE (pico de ansiedade, pergunta preço) · 8 DECISÃO (pergunta preço/insiste/pressa — sinal real de disposição a pagar) · 9 SATISFAÇÃO (comprou) · 10 VÍNCULO (pós-venda).
Regra por faixa: 1-6 é tudo gratuito (gancho leve só no 5-6, nunca mídia paga); 7-8 é o ponto de oferta, sempre respeitando a escada do script (nunca pular 1→2→3); 9-10 é rapport antes de emendar a próxima venda.

10 ARQUÉTIPOS DE LEAD (Manual de Tipos de Lead + Tom e Gatilhos):
Carente (busca companhia; tom acolhedor; gatilhos Rótulo Emocional + Reciprocidade) · Submisso (quer ser conduzido; tom firme/assertivo; gatilhos Autoridade de Especialista + Compromisso e Coerência) · Namorado (quer fantasia de relacionamento; tom íntimo/caloroso; gatilhos Antecipação do Futuro + Rótulo Emocional) · Fetichista (o mais lucrativo, não o mais estranho; tom curioso sem julgamento; gatilhos Autoridade de Especialista + Escassez Real) · Salvador (quer cuidar de você; tom vulnerável com moderação; gatilhos Reciprocidade + Compromisso e Coerência) · Curioso (está testando; tom leve sem pressão; gatilhos Loop Aberto + Reciprocidade) · Punheteiro (quer entrega rápida, não vínculo; tom direto/eficiente; gatilhos Fechamento Alternativo + Escassez Real) · Dominador (quer sentir que manda; tom confiante nunca submisso; gatilhos Efeito Contraste + Fechamento Alternativo) · Fã que não compra (interage mas não converte; tom amigável sem esforço extra; gatilhos Retirada da Oferta + Escassez Real) · Narcisista (quer validação; tom admirador genuíno; gatilhos Reciprocidade + Autoridade de Especialista invertida).

9 TÉCNICAS DE NEGOCIAÇÃO: Ancoragem (fale o preço primeiro) · Silêncio Depois do Preço (fale e espere) · Escada de Concessão (nunca ceda sem pedir algo em troca) · Enquadramento (como descreve o preço muda a resposta) · Espelhamento (repita o ritmo dele) · Rótulo Emocional (nomeie a objeção antes dele) · Perguntas Calibradas ("o que faria valer a pena pra você") · Aversão à Perda (mostre o que ele perde) · Escassez Real (nunca invente prazo).

8 TÉCNICAS AVANÇADAS DE PERSUASÃO: Reciprocidade · Compromisso e Coerência · Efeito Contraste · Retirada da Oferta · Fechamento Alternativo · Loop Aberto (Curiosidade) · Antecipação do Futuro · Autoridade de Especialista. Nunca empilhar mais de uma técnica na mesma mensagem — isso soa artificial.

SINAIS DE WHALE (Manual de Criação de Whale): 3+ compras espaçadas, intervalo curto e constante, pagou sem regatear, ticket subindo, compartilhou algo pessoal sem ser perguntado. Quando presentes: não vender rápido, investir em conexão.

REGRA DE VENDA RÁPIDA (turno 15h-23h, maior volume): pedido espontâneo de personalizado/whats já é sinal de compra — vender na hora; quando a oferta parte do chatter, sempre validar com sexting antes; nunca ofertar preço alto pra quem não validou.

ERROS CLÁSSICOS DO PLAYBOOK (usar como catálogo de erro, não inventar outros): pular etapa de script, oferecer mídia paga sem ter passado por sexting, ceder desconto sem pedir nada em troca, mandar mídia de graça quando só pediram "pra ver", sumir depois de mandar conteúdo, usar escassez falsa, empilhar mais de uma técnica de persuasão na mesma mensagem, tratar todo mundo com o mesmo tom independente do arquétipo, discutir preço em vez de reforçar valor, vender antes de aquecer, fala mecânica/robótica (mensagem genérica que ignora o que o assinante acabou de dizer), mandar mídias em sequência sem criar contexto/conversa entre elas, subir o preço da mídia de forma brusca sem progressão gradual, reaproveitar o mesmo roteiro de PPV storytelling com um lead que já recusou nele (só vale uma vez por lead), vender mídia por valor muito baixo desvalorizando a modelo (ex: R$5-8), falar em "venda" ou tratar a conversa como comércio explícito (o lead não pode sentir a troca comercial — evitar até a palavra "conteúdo", que também soa comercial), conduzir direto pra venda sem explorar antes a dor/curiosidade/contexto do lead, usar estrutura pronta e repetitiva que soa robótica em vez de individualizar pra cada lead, ficar disponível demais/sem posicionamento de conquista (nunca provocar, entregar mídia de primeira sem instigar), insistir com quem sinalizou não ter dinheiro no momento em vez de liberar com uma saída elegante, ofertar WhatsApp/personalizado pra quem ainda não tem valor percebido suficiente construído, deixar passar de 12 mensagens sem nenhuma tentativa clara de monetização.

FUNIL DE CHATTING (Manual do Chatter de Alta Performance — 7 etapas; usar JUNTO com a escala de temperatura pra identificar o MOMENTO exato da conversa, não só o nível de calor):
Etapa 0 — Validação Visual: o lead já viu a modelo em algum lugar (Instagram, X, feed do gratuito) antes de entrar no chat — etapa de contexto, sem ação do chatter.
Etapa 1 — Aquecimento do Lead (equivale à temperatura 1-4, aprofundada na etapa 6): o lead começa a se interessar (nem sempre excitado ainda) pelo jeito de falar, atenção dada e rapport gerado. Regras: toda mensagem é intencional — pensar aonde ela leva antes de mandar (perguntar onde ele mora já sinaliza presencial; perguntar se está com tesão de cara soa "emocionada demais por vender" e derruba o valor percebido); reter o lead a qualquer custo (chamar pelo nome, responder rápido — depois de +4min ele já esfriou); ser carismática por texto (aumentativos, emojis, alto-astral — nunca mensagem seca); sempre terminar deixando uma pergunta em aberto (nunca terceirizar pro lead o esforço de puxar assunto); espelhar o jeito de cada lead (seco → seco, alto-astral → mais alto-astral ainda, várias mensagens curtas → várias mensagens curtas); identificar o perfil rápido (carente, direto/putanheiro, curioso, ego, tímido, casado buscando aventura) pra saber a dor de cada um; todo mundo compra alguma coisa em algum momento — não descartar quem não compra na hora, só redefinir prioridade de resposta (isso também gera escassez); só descartar de verdade quem pede grátis, tenta levar pra fora da plataforma ou ataca a modelo — nesses casos nunca xingar (viola política da plataforma), e sim cobrar por atenção (ex: mandar mídia paga como resposta a pedido de sair), ser sincera sobre o limite, ou simplesmente ignorar; fazer remarketing constante com quem sumiu ou não compra mais (foto nova, chamar whale antigo pelo nome, avisar novidade) — inclusive pra reabrir quem recebeu mídia e não abriu.
Etapa 2 — Conversa Intencional: já entendeu o perfil do lead e conduz com intenção de pitch — pegar na dor dele, brincar com as emoções, despertar curiosidade/excitação, e sobretudo fazer ELE pedir o que quer (nunca empurrar a oferta de cara).
Etapa 3 — Pitch de Venda: envia o PPV com texto persuasivo baseado no que foi coletado nas etapas anteriores — vender exatamente o que ele quer, roteiro com congruência entre mídia e contexto, legenda que gera desejo, segurar a excitação (a primeira mídia é ticket baixo e não entrega tudo).
Etapa 4 — Compra: o lead compra a mídia barata — reforçar valor percebido, esquentar o clima, precificar a próxima oferta, manter um open loop (deixar uma ponta solta de curiosidade pra próxima mídia).
Etapa 5 — LTV: repetir o loop conversa+mídia numa escada de valor crescente (nunca pular degraus de preço) até o clímax final — o ganho real está em várias mídias pequenas com bom rapport entre elas, não uma mídia cara isolada.
Etapa 6 — Conexão Extrema e Fidelização (aprofunda a etapa 1): depois de uma experiência boa, criar conexão real — "com quem estou conversando" (trabalho, com quem mora, hobbies, aniversário), interesse genuíno, deixar o lead desabafar, mostrar que ele é diferente pra você. É daqui que vêm as vendas de alto ticket (R$300 a R$1k+), web-namoro e mimos — vendas de RELACIONAMENTO PERCEBIDO, não de conteúdo adulto. O chatter bom não é o que vende bem conteúdo, é o que leva o lead até essa etapa.

REGRAS DE OURO DE ALTA PERFORMANCE (aplicar em toda análise e todo direcionamento tático, além do playbook acima):
Nunca tratar a interação como comércio explícito: não falar em "venda" nem deixar o lead sentir a troca comercial — evitar até a palavra "conteúdo"; falar em vivência, momento, ou nomear a mídia específica (foto, vídeo).
Criar relacionamento ENTRE as mídias, nunca mandar mídia atrás de mídia sem conversa: fluxo padrão é rapport → pergunta que gera desejo (ex: sobre o corpo/desejo dele) → oferta de mídia (ex: R$35) → rapport de novo → mais interesse → próxima mídia. O ganho está na qualidade do rapport entre cada mídia, não só na mídia isolada.
Falar em primeira pessoa como se sentisse de verdade — descrever como a persona se sente, falar do corpo dele e do que ele gosta que façam com ele, fazer a mente dele sentir a cena. Interação neutra/genérica é sinal de falta de imersão na persona, não só falta de esforço técnico.
Não pagou = silêncio: se o lead recebeu a mídia e não abriu/pagou, a ação é SÓ recuar — curtar a resposta, não implorar atenção, limitar tempo e atenção, ou jogar no ego dele (fazer sentir que está perdendo algo). Nunca misturar isso com continuar escalando desejo/oferta pro próximo passo enquanto o pagamento pendente não é resolvido — são orientações contraditórias, escolha uma só.
Consistência entre temperatura e etapa do funil: a etapaFunil NUNCA pode estar à frente da temperatura real. Etapas 4 (Compra) e 5 (LTV) só valem se já houve pelo menos um pagamento CONFIRMADO nessa conversa — enviar um PPV que o lead ainda não abriu/pagou NÃO avança a etapa; nesse caso a etapa correta continua sendo a que bate com a temperatura (normalmente Aquecimento ou Conversa Intencional), e o envio precoce da oferta deve ser sinalizado como erro (vender antes de aquecer/pular etapa de script) — nunca tratado como se já estivesse em fase de venda repetida.
Posicionamento de conquista: a modelo precisa ser uma conquista, nunca estar disponível demais. Provocar até o lead PEDIR pra ver — quando ele pedir, aumentar a excitação (instigar/recusar) até 3 vezes antes de entregar, pra gerar valor percebido (pode usar Fechamento Alternativo/trem do sim quando a temperatura já estiver 8+).
Homens sentem mais desejo por submissão do que o contrário — sempre se posicionar com autoridade, nunca de forma subserviente ou disponível demais.
Lead sem dinheiro no momento: nunca insistir — usar algo como "Amor, não quero te atrapalhar, quando você estiver pronto de verdade me avisa" (ativa o ego dele, evita perder tempo empurrando venda impossível, e ele tende a voltar depois já mais disposto).
Nunca ofertar WhatsApp ou personalizado pra quem ainda não tem relevância/conexão suficiente construída — isso só mata o lead antes da hora; ele precisa ver VALOR antes de ver PREÇO.
Leitura rápida de perfil já nas primeiras mensagens (carente, direto, curioso, ego, entre outros) — o tom identificado logo no início manda em como conduzir dali pra frente.
Estrutura recomendada até a 12ª mensagem: 1-3 conectar e observar o jeito dele; 4-6 já ter entendido o perfil e puxar em cima disso; 7-12 criar tensão e levar à monetização sem enrolar nem alongar demais. Passar de 12 mensagens sem nenhuma tentativa clara de monetização é erro — nesse ponto, ou tenta mais uma vez de forma direta, ou prioriza outro lead.
Erros de timing a sempre apontar quando presentes: responder de forma padrão/genérica sem individualizar, demorar pra entender o perfil do lead, deixar a conversa rodar demais sem direção — sinal de perda de timing.
Aprofundar conexão de verdade (não é só bater papo): trazer um ritual próprio e consistente da persona, priorizar atenção de forma perceptível pra quem já demonstrou interesse/compra, e conduzir com perguntas que aprofundam em vez de ficar em pergunta fechada de superfície — evitar interrogatório raso e trazer também um pouco de si (reciprocidade).
Potencial whale identificado (ver Sinais de Whale acima): não vender rápido — investir tempo real em fazê-lo se apaixonar/conectar antes de qualquer oferta de ticket alto.

PPV COM STORYTELLING (Manual de Vendas de PPV com Storytelling — venda de mídia como sequência narrativa erótica contínua, não mídia avulsa; usar pra avaliar Criatividade, Inteligência Comercial e Condução): o chatter é roteirista guiando a imaginação do lead, não vendedor desesperado — foco no LTV (quanto o lead rende ao longo de toda a história), não só no ticket de uma venda isolada. Preço: nunca fixo, nunca vender baixo demais e desvalorizar a modelo, progressão gradual sem saltos (não pular de R$20 pra R$100), etapas finais/mais explícitas valem mais (R$80-150), se o lead paga bem sem reclamar pode subir o preço sem medo pra testar até onde ele vai. Estratégia: ganha-se na quantidade de mídias vendidas aos poucos (R$15+R$20+R$30... rende mais que 1 vídeo caro só), sempre fazer o lead demonstrar curiosidade/pedir antes de ofertar (nunca ofertar de cara), ofertar no contexto do que ele acabou de falar, só pular direto pras mídias finais se o lead já estiver muito excitado. Condução: abrir descrevendo o que a persona está fazendo naquele momento (gera curiosidade), trocar 5-10 mensagens de conexão entre cada mídia enviada, manter mistério (nunca entregar tudo de uma vez), sempre guiar a narrativa. Cada roteiro de storytelling só pode ser usado UMA vez por lead — se ele não comprou a primeira mídia, guardar o roteiro pra outro cliente em vez de insistir.

COMO PUXAR ASSUNTO (Manual "Como Puxar Assunto com Assinantes" — usar pra diagnosticar e corrigir fala mecânica, tipo o problema do Renan):
"Não tenho assunto" é mito — todo assinante entrega deixa, o trabalho é achar e puxar o fio, não inventar do zero. Fluxo em 3 passos: 1) PERGUNTA ABERTA (nunca fechada tipo "tudo bem?"/"curtiu?" — pergunta que puxa opinião, gosto, o que faria, ex: "como tá sendo seu dia?" em vez de "tudo bem?") pra coletar informação real sobre a pessoa; 2) FALAR DO QUE ELE GOSTA (uma vez descoberto o assunto, ir fundo nele em vez de tentar inventar outro — a pessoa se sente ouvida e valorizada, isso sozinho já gera vínculo); 3) CONTAR UMA HISTÓRIA PARECIDA DA PERSONA depois que ele se abriu (reciprocidade — conversa não pode ser só interrogatório, ela também precisa "soltar" informação, sempre coerente com o que já contou antes pra essa pessoa).
Erros de fala mecânica a apontar: rajada de perguntas fechadas em sequência, resposta genérica que não usa nada do que o assinante acabou de escrever (soa robótico/copiado e colado), não ler o histórico da conversa antes de responder (a deixa muitas vezes já está lá em cima), só perguntar sem nunca contribuir com algo próprio (interrogatório), forçar assunto quando a pessoa claramente não está afim (nem toda conversa depende do chatter — às vezes é só o momento errado da pessoa, não é falha dele).

CUIDADO COM TAREFAS/METAS DE TEMPO: nunca sugira desafio ou tarefa de treino do tipo "feche uma venda em X minutos" ou qualquer meta que force o chatter a apressar o lead pulando a escada de temperatura — isso pressiona o assinante, quebra a régua 1→2→...→8 do script e tende a atrapalhar mais do que ajudar. Toda tarefa de treino/autoteste sugerida deve ser sobre PRATICAR uma técnica específica (ex: "aplique pergunta aberta em pelo menos 3 conversas essa semana"), nunca sobre bater um prazo ou meta de tempo de fechamento.

CATÁLOGO DE FETICHES (Manual de Identificação de Fetiche — usar pra reconhecer, nomear pra si (nunca julgar) e guiar o roteiro de PPV storytelling em cima do interesse real do lead; todo fetiche tem um foco psicológico por trás — é nele que a conversa/venda deve mirar, não só na palavra-chave. Formato: Fetiche — do que se trata — foco psicológico a explorar na conversa):
Dinâmica de poder e controle: Dominação (Dom) — assumir o controle da dinâmica — poder, liderança · Submissão (Sub) — entregar o controle ao parceiro — confiança, entrega · Femdom — mulher na posição dominante — autoridade feminina · Maledom — homem na posição dominante — autoridade masculina · Bondage — restrição com cordas/algemas/faixas — restrição, confiança · Shibari — bondage artístico com cordas — estética, entrega · Sadismo — prazer em aplicar dor consensual — controle, intensidade · Masoquismo — prazer em receber dor consensual — resistência, catarse · Brat — submisso que provoca o dominante — desafio, atenção · Brat Tamer — dominante que "corrige" o brat — controle, disciplina · Praise Kink — receber elogios durante a dinâmica — validação · Humilhação — ser diminuído consensualmente — vulnerabilidade · Degradação — linguagem ofensiva consensual — vergonha controlada · Chastity — cinto/dispositivo de castidade — controle, antecipação · Edging — adiar o orgasmo — autocontrole, expectativa · Orgasm Control — controle do orgasmo — poder · Denial — negação consensual do orgasmo — frustração controlada.
Poder financeiro/simbólico: Findom — entrega de dinheiro à pessoa dominante — poder simbólico · Financial Submission — submissão por recursos financeiros — sacrifício, entrega.
Pet/age/role play: Pet Play — agir como animal de estimação — desconexão da rotina · Puppy Play — fantasia de cachorro — lealdade, brincadeira · Kitten Play — fantasia de gato — carinho, independência · Pony Play — fantasia de cavalo — disciplina · Mommy/Daddy Dynamic — cuidado e autoridade entre adultos — proteção · Age Play — interpretação de idades fictícias entre adultos — regressão emocional · Teacher/Student, Doctor/Nurse, Boss/Secretary, Police/Prison — fantasias de papel/autoridade — poder, cuidado, controle (conforme o papel) · Uniformes — roupas profissionais — status · Cosplay — personagens fictícios — imersão.
Estética, corpo e vestuário (fetiches de foco visual/sensorial — combinam bem com fotos/vídeos temáticos): Feet (podolatria), Shoes, Boots, High Heels, Stockings, Pantyhose — pés, calçados e meias — condicionamento, estética, elegância, sensualidade (conforme o item) · Latex, Leather, Lingerie — materiais e roupas — aparência, dominação, estética · Tattoo, Piercing, Hair (Long Hair/Bald), Beard — características físicas — individualidade, estilo, beleza, masculinidade · Armpits, Hands, Legs, Belly, Butt, Breasts, Muscle Worship — partes do corpo — condicionamento, elegância, curvas, atração física, força.
Corpo/porte (preferência corporal — nunca comentar peso/corpo da modelo, só reconhecer o interesse do lead): BBW — preferência por corpo gordo — preferência corporal · Petite — corpo pequeno — contraste · Giantess, Macro/Micro — diferença extrema de tamanho (fantasia) — diferença de poder, proteção.
Voyeurismo/compartilhamento: Voyeurismo — observar intimidade — curiosidade · Exhibitionismo — ser observado — validação · Cuckold/Cuckquean — parceiro(a) com outra pessoa — ciúme erotizado, competição · Swing — troca de casais — novidade · Hotwife — parceira com outros parceiros, consensualmente — compartilhamento · Gangbang Fantasy — fantasia com múltiplos parceiros — intensidade.
Fertilidade/transformação (tratar sempre como fantasia/roleplay, nunca literal): Breeding Fantasy, Creampie Fantasy, Pregnancy Fantasy, Lactophilia — simbolismo ligado à fertilidade — instinto reprodutivo, exclusividade, criação/intimidade, nutrição simbólica · Belly Expansion, Inflation — transformação corporal fictícia — fantasia corporal.
Fantasia/ficção: Tentacle, Monster, Alien, Vampire, Werewolf — criaturas fictícias — fantasia surreal, sedução, instinto (conforme a criatura) · Furry — personagens antropomórficos — identidade alternativa · Transformation — transformação física — mudança de identidade.
Identidade/expressão de gênero (tratar com respeito, é sobre exploração de identidade, não fetichização depreciativa): Sissy — feminização consensual — exploração de identidade, submissão · Crossdressing — vestir roupas associadas a outro gênero — expressão de identidade · Gender Play — exploração de papéis de gênero — experimentação · Bimboification — fantasia de transformação em persona hipersexualizada — mudança de identidade.
Sensorial (voz/cheiro/textura): Voice Kink — voz — conexão emocional · ASMR — sons suaves — relaxamento · Perfume — cheiro — memória afetiva · Sweat, Musk — suor/odor corporal — instinto, biologia.
Sensações físicas controladas: Wax Play — cera quente — dor controlada · Ice Play — gelo — contraste sensorial · Fire Play — técnicas controladas com calor — adrenalina · Knife Play — uso simbólico e consensual de facas sem dano — risco controlado · Breath Play — restrição da respiração em fantasia — intensidade, confiança · Dacryphilia — lágrimas — vulnerabilidade.
Sensorial/alimentar (nicho, tratar com naturalidade se o lead trouxer): Sploshing, Wet & Messy — alimentos/substâncias sobre o corpo, sujeira controlada — sensorial, lúdico · Feederism — alimentar ou ganhar peso — cuidado, transformação.
Nicho/tabu (SEMPRE dentro do consentimento e da linha de conteúdo já autorizada pela agência/modelo — nunca sugerir ao chatter ir além do que a modelo já definiu como limite; sinalizar ao gestor se o lead insistir em algo fora do escopo): Omorashi — segurar a vontade de urinar — tensão e alívio · Urofilia — urina — tabu, intimidade · Scat (Coprofilia) — fezes — transgressão extrema · Somnophilia Fantasy — fantasia com parceiro já consentido em cenário fictício de sono — vulnerabilidade, confiança · Objectophilia, Balloon Fetish, Plushophilia, Mechanophilia, Formicophilia, Klismaphilia — objetos, texturas e associações específicas — apego simbólico, conforto, fascínio tecnológico, estímulo tátil, controle corporal (conforme o item).
Como usar na prática: quando o lead sinalizar um fetiche da lista, não tratar como estranho nem ignorar — nomear internamente o foco psicológico (ex: Dom quer "poder", Praise Kink quer "validação") e usar exatamente esse foco pra escrever o roteiro de PPV storytelling e escolher o tom da persona; isso é o arquétipo Fetichista do manual de leads, o mais lucrativo quando bem conduzido. Nunca fingir interesse genérico — o roteiro precisa refletir o fetiche específico mencionado.
`;
// Copiloto tático — resposta curta e rápida pro CHATTER, em tempo real,
// enquanto ele ainda está na conversa. Formato enxuto de propósito: não é
// o relatório completo do gestor (isso é rodarChatLab), é orientação
// imediata de "o que fazer agora".
// Schema do Copiloto Tático (dica rápida "o que fazer agora" pro chatter) —
// antes era um pedido SEPARADO pra IA (CHATLAB_COPILOTO_SYSTEM + clRunCopiloto),
// disparado em paralelo com a análise completa: 2 pedidos à IA por clique de
// "Analisar", o dobro de gasto de cota, só no ChatLab (nenhuma outra
// ferramenta faz isso) — era a causa real de "o ChatLab sempre falha por
// limite de uso". Agora o copiloto vem EMBUTIDO na mesma resposta da análise
// completa, como um bloco ```copiloto no início (ver montarPromptAnaliseChatLab
// / rodarChatLab) — só 1 pedido à IA por análise.
const CHATLAB_COPILOTO_SCHEMA='{"temperatura":{"nivel":0,"label":""},"etapaFunil":{"numero":0,"nome":""},"arquetipo":{"tipo":"","confianca":"baixa|media|alta","evidencia":""},"feticheIdentificado":{"tipo":"","focoPsicologico":"","evidencia":""},"tomRecomendado":"","gatilhoRecomendado":{"tecnica":"","comoAplicar":""},"proximaAcao":"","alerta":"","sinalDeWhale":""}';
// A infra de IA (AI_PROXY_URL) às vezes corta a resposta no meio (flaky —
// varia de tentativa pra tentativa, não é sempre no mesmo ponto) — por
// isso tenta de novo automaticamente antes de mostrar erro pro chatter.
async function clFetchAI(system,userContent,maxTokens){
  const res=await fetch(AI_PROXY_URL,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:maxTokens,system,messages:[{role:'user',content:userContent}]})
  });
  const data=await res.json();
  const text=data.content?.map(b=>b.type==='text'?b.text:'').join('')||'';
  if(!text){
    // Se for especificamente limite de uso da IA, joga o erro real (com o
    // tempo de espera calculado pelo proxy) pra quem chamou poder mostrar
    // a contagem regressiva exata — em vez de só devolver texto vazio.
    const qerr=aiQuotaError(data);
    if(qerr)throw qerr;
  }
  return text;
}
function renderClCopilotoResult(state,obj){
  const el=document.getElementById('cl-copiloto');
  if(!el)return;
  if(state==='loading'){el.innerHTML='<div class="panel" style="border-left:3px solid var(--accent)"><div style="font-size:12.5px;color:var(--text2)">🎯 Copiloto tático calculando…</div></div>';return;}
  if(state==='error'){
    if(obj?.quota){renderAIWaitCountdown('cl-copiloto',obj.waitSeconds,{prefix:'⏳ Copiloto tático — limite de uso da IA',panel:true});return;}
    el.innerHTML=`<div class="panel" style="border-color:var(--bad)"><div style="color:var(--bad);font-size:12.5px">❌ Copiloto tático: ${obj?.message||'erro'}</div></div>`;return;
  }
  const t=obj.temperatura||{},a=obj.arquetipo||{},g=obj.gatilhoRecomendado||{},ef=obj.etapaFunil||{},fi=obj.feticheIdentificado||{};
  const tCol=t.nivel>=9?'var(--ok)':t.nivel>=7?'var(--warn)':'var(--text3)';
  el.innerHTML=`<div class="panel" style="border-left:3px solid var(--accent)">
    <div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:8px">🎯 COPILOTO TÁTICO — o que fazer agora</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      <div style="background:var(--bg-soft);border-radius:8px;padding:8px 12px;text-align:center">
        <div style="font-size:9.5px;color:var(--text3)">TEMPERATURA</div>
        <div style="font-size:16px;font-weight:800;font-family:var(--font-mono);color:${tCol}">${t.nivel||'—'}<span style="font-size:10px"> · ${t.label||''}</span></div>
      </div>
      <div style="background:var(--bg-soft);border-radius:8px;padding:8px 12px;text-align:center">
        <div style="font-size:9.5px;color:var(--text3)">ARQUÉTIPO</div>
        <div style="font-size:13px;font-weight:800">${a.tipo||'—'}<span style="font-size:10px;color:var(--text3)"> (${a.confianca||'—'})</span></div>
      </div>
      ${(ef.nome||ef.numero!=null)?`<div style="background:var(--bg-soft);border-radius:8px;padding:8px 12px;text-align:center">
        <div style="font-size:9.5px;color:var(--text3)">MOMENTO</div>
        <div style="font-size:13px;font-weight:800">${ef.numero??'—'} · ${ef.nome||''}</div>
      </div>`:''}
      ${fi.tipo?`<div style="background:var(--bg-soft);border-radius:8px;padding:8px 12px;text-align:center">
        <div style="font-size:9.5px;color:var(--text3)">FETICHE</div>
        <div style="font-size:13px;font-weight:800">${fi.tipo}</div>
      </div>`:''}
    </div>
    <div style="font-size:12.5px;margin-bottom:6px"><strong>Tom recomendado:</strong> ${obj.tomRecomendado||'—'}</div>
    ${fi.tipo?`<div style="font-size:12.5px;margin-bottom:6px"><strong>Foco do fetiche:</strong> ${fi.focoPsicologico||'—'}</div>`:''}
    <div style="font-size:12.5px;margin-bottom:6px"><strong>Gatilho agora:</strong> ${g.tecnica||'—'}${g.comoAplicar?' — '+g.comoAplicar:''}</div>
    <div style="font-size:13px;font-weight:700;color:var(--ok);margin-bottom:6px">👉 ${obj.proximaAcao||'—'}</div>
    ${obj.alerta?`<div style="font-size:12.5px;color:var(--bad);margin-top:6px">⚠️ ${obj.alerta}</div>`:''}
    ${obj.sinalDeWhale?`<div style="font-size:12.5px;color:var(--accent);margin-top:6px">🐋 ${obj.sinalDeWhale}</div>`:''}
  </div>`;
}
function renderChatLab(){
  const sel=document.getElementById('cl-chatter');
  if(sel){
    const cur=sel.value;
    sel.innerHTML='<option value="">— selecionar —</option>'+S.chatters.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
    if(cur)sel.value=cur;
  }
  renderChatLabHistorico();
  renderChatLabRanking();
}
// Responde as perguntas de gestão (quem converte melhor, qual arquétipo
// compra mais, erro mais comum...) agregando o campo .tags que cada análise
// já salva — consulta sobre dado estruturado, não uma pergunta nova pra IA.
function renderChatLabRanking(){
  const el=document.getElementById('cl-ranking');
  if(!el)return;
  const tagged=S.chatlabAnalyses.filter(a=>a.tags);
  if(!tagged.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Analise algumas conversas pra ver os rankings aqui</div>';return;}

  const porChatter={};
  tagged.forEach(a=>{
    if(!porChatter[a.chatterId])porChatter[a.chatterId]={total:0,conv:0,valor:0,whale:0,erros:{}};
    const p=porChatter[a.chatterId];
    p.total++;
    if(a.tags.converteu==='sim'){p.conv++;p.valor+=parseFloat(a.tags.valor)||0;}
    if(a.tags.sinalDeWhale)p.whale++;
    if(a.tags.principalErro)p.erros[a.tags.principalErro]=(p.erros[a.tags.principalErro]||0)+1;
  });
  const ranked=Object.entries(porChatter).map(([cid,p])=>{
    const c=S.chatters.find(ch=>ch.id===cid);
    const topErro=Object.entries(p.erros).sort((x,y)=>y[1]-x[1])[0];
    return{name:c?c.name:'?',total:p.total,taxa:p.total?Math.round(p.conv/p.total*100):0,
      ticketMedio:p.conv?p.valor/p.conv:0,whale:p.whale,topErro:topErro?topErro[0]:'—'};
  }).sort((a,b)=>b.taxa-a.taxa);
  const totalWhales=ranked.reduce((s,r)=>s+r.whale,0);

  const arquetipoTally={};
  tagged.filter(a=>a.tags.converteu==='sim'&&a.tags.arquetipo).forEach(a=>{
    arquetipoTally[a.tags.arquetipo]=(arquetipoTally[a.tags.arquetipo]||0)+1;
  });
  const topArquetipo=Object.entries(arquetipoTally).sort((a,b)=>b[1]-a[1])[0];

  el.innerHTML=`
    ${topArquetipo?`<div style="background:var(--accent-soft);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:12.5px"><strong>Arquétipo que mais converte:</strong> ${topArquetipo[0]} (${topArquetipo[1]} venda${topArquetipo[1]>1?'s':''})</div>`:''}
    ${totalWhales>0?`<div style="background:var(--accent-soft);border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:12.5px"><strong>🐋 ${totalWhales} sinal${totalWhales>1?'is':''} de whale</strong> identificado${totalWhales>1?'s':''} no total — veja quem criou na coluna 🐋 abaixo</div>`:''}
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <tr style="color:var(--text3);text-align:left"><th style="padding:4px 6px">Chatter</th><th style="padding:4px 6px">Conversas</th><th style="padding:4px 6px">Taxa conv.</th><th style="padding:4px 6px">Ticket médio</th><th style="padding:4px 6px">🐋</th><th style="padding:4px 6px">Erro mais comum</th></tr>
      ${ranked.map(r=>`<tr style="border-top:1px solid var(--line)">
        <td style="padding:5px 6px;font-weight:700">${r.name}</td>
        <td style="padding:5px 6px">${r.total}</td>
        <td style="padding:5px 6px;color:${r.taxa>=50?'var(--ok)':r.taxa>=25?'var(--warn)':'var(--bad)'};font-weight:700">${r.taxa}%</td>
        <td style="padding:5px 6px;font-family:var(--font-mono)">${money(r.ticketMedio)}</td>
        <td style="padding:5px 6px;${r.whale>0?'color:var(--accent);font-weight:800':'color:var(--text3)'}">${r.whale||'—'}</td>
        <td style="padding:5px 6px;color:var(--text3)">${r.topErro}</td>
      </tr>`).join('')}
    </table>`;
}
// Agrupado por chatter: a "nota" que aparece ao lado do nome é a MÉDIA
// geral do IGP (não a de uma análise isolada). Clicar no nome expande e
// mostra TODAS as conversas dele, minimizadas por data — cada uma clicável
// pra ver a análise completa.
function renderChatLabHistorico(){
  const el=document.getElementById('cl-historico');
  if(!el)return;
  if(!S.chatlabAnalyses.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Nenhuma análise ainda</div>';return;}
  const byChatter={};
  S.chatlabAnalyses.forEach(a=>{
    const cid=a.chatterId||'_sem';
    if(!byChatter[cid])byChatter[cid]=[];
    byChatter[cid].push(a);
  });
  const grupos=Object.entries(byChatter).map(([cid,list])=>{
    const c=S.chatters.find(ch=>ch.id===cid);
    const comIgp=list.filter(a=>a.igp!=null);
    const avgIGP=comIgp.length?Math.round(comIgp.reduce((s,a)=>s+(a.igp||0),0)/comIgp.length):null;
    const sorted=list.slice().sort((a,b)=>(b.date||'').localeCompare(a.date||''));
    return{cid,name:c?c.name:'?',avgIGP,count:list.length,list:sorted,lastDate:sorted[0]?.date||''};
  }).sort((a,b)=>(b.lastDate||'').localeCompare(a.lastDate||''));

  el.innerHTML=grupos.map(g=>{
    const col=g.avgIGP>=70?'var(--ok)':g.avgIGP>=50?'var(--warn)':g.avgIGP?'var(--bad)':'var(--text3)';
    return`<div class="cl-group-row" data-key="${g.cid}" style="border:1px solid var(--line);border-radius:9px;margin-bottom:8px;overflow:hidden;touch-action:pan-y">
      <div style="padding:10px 13px;background:var(--bg-soft);display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="toggleClGroup('${g.cid}')">
        <div>
          <div style="font-size:13px;font-weight:700">${g.name}</div>
          <div style="font-size:11px;color:var(--text3)">${g.count} conversa${g.count>1?'s':''} · IGP médio</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:18px;font-weight:800;font-family:var(--font-mono);color:${col}">${g.avgIGP??'—'}</span>
          <span style="font-size:10px;color:var(--text3)" id="cl-gic-${g.cid}">▼</span>
        </div>
      </div>
      <div id="cl-gbody-${g.cid}" style="display:none;padding:10px 13px">
        ${g.list.map(a=>{
          const acol=a.igp>=70?'var(--ok)':a.igp>=50?'var(--warn)':a.igp?'var(--bad)':'var(--text3)';
          return`<div style="border:1px solid var(--line);border-radius:8px;margin-bottom:7px;overflow:hidden">
            <div style="padding:8px 11px;background:var(--bg);display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="toggleClAn('${a.id}')">
              <div style="font-size:11.5px;color:var(--text3)">${new Date(a.date).toLocaleDateString('pt-BR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}${a.autoAnalise?' <span style="font-size:9px;font-weight:700;color:var(--accent)">🤖 autoanálise</span>':''}</div>
              <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:14px;font-weight:800;font-family:var(--font-mono);color:${acol}">${a.igp||'—'}</span>
                <span style="font-size:9px;color:var(--text3)" id="cl-ic-${a.id}">▼</span>
              </div>
            </div>
            <div id="cl-body-${a.id}" style="display:none"><div class="cl-md" style="padding:14px 14px 0">${clMd(a.raw||'')}</div><div style="padding:0 14px 14px">${redoBtnHtml(a.id)}</div></div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
  attachSwipeToDelete(el,'.cl-group-row',cid=>excluirChatlabPessoa(cid),renderChatLabHistorico);
}
// Arrastar pro lado remove TODAS as análises do ChatLab dessa pessoa —
// sempre pede confirmação antes, já que é uma exclusão de histórico inteiro.
function excluirChatlabPessoa(cid){
  const c=S.chatters.find(ch=>ch.id===cid);
  const nome=c?c.name:'essa pessoa';
  if(!confirm(`Excluir TODO o histórico do ChatLab de ${nome}? Isso remove todas as conversas analisadas dela. Essa ação não pode ser desfeita.`))return;
  S.chatlabAnalyses=S.chatlabAnalyses.filter(a=>(a.chatterId||'_sem')!==cid);
  save();
  toast('🗑️ Histórico do ChatLab removido');
}
function toggleClGroup(cid){
  const b=document.getElementById('cl-gbody-'+cid),ic=document.getElementById('cl-gic-'+cid);
  if(!b)return;
  const open=b.style.display!=='none';
  b.style.display=open?'none':'block';
  if(ic)ic.textContent=open?'▼':'▲';
}
function toggleClAn(id){
  const b=document.getElementById('cl-body-'+id),ic=document.getElementById('cl-ic-'+id);
  if(!b)return;
  const open=b.style.display!=='none';
  b.style.display=open?'none':'block';
  if(ic)ic.textContent=open?'▼':'▲';
}
function limparChatLab(){
  const c=document.getElementById('cl-conversa');if(c)c.value='';
  const x=document.getElementById('cl-ctx');if(x)x.value='';
  const r=document.getElementById('cl-resultado');if(r)r.innerHTML='';
  const cp=document.getElementById('cl-copiloto');if(cp)cp.innerHTML='';
}
function clMd(md){
  return md
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/^## (.+)$/gm,'<h3 style="font-size:14px;font-weight:700;color:var(--accent);margin:16px 0 6px">$1</h3>')
    .replace(/^### (.+)$/gm,'<h4 style="font-size:13px;font-weight:600;margin:10px 0 4px">$1</h4>')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/^---$/gm,'<hr style="border:none;border-top:1px solid var(--line);margin:14px 0">')
    .replace(/^\|(.+)\|$/gm,row=>{
      const cells=row.slice(1,-1).split('|');
      if(cells.every(c=>/^[-\s:]+$/.test(c)))return'';
      return'<tr>'+cells.map(c=>`<td style="padding:5px 9px;border-bottom:1px solid var(--line);font-size:12.5px">${c.trim()}</td>`).join('')+'</tr>';
    })
    .replace(/(<tr>[\s\S]*?<\/tr>\n?)+/g,'<table style="width:100%;border-collapse:collapse;margin:8px 0">$&</table>')
    .replace(/^[-*] (.+)$/gm,'<li style="font-size:13px;color:var(--text2);line-height:1.65">$1</li>')
    .replace(/^\d+\. (.+)$/gm,'<li style="font-size:13px;color:var(--text2);line-height:1.65">$1</li>')
    .replace(/(<li[\s\S]*?<\/li>\n?)+/g,'<ul style="padding-left:18px;margin:6px 0">$&</ul>')
    .replace(/\n{2,}/g,'<br>');
}
// Quando alguém RESPONDE (cita) uma mensagem específica no chat, o app de
// mensagens gera um bloco de 3 linhas: o NOME de quem mandou a mensagem
// citada, a mensagem citada (repetida — ela já apareceu antes na conversa)
// e só então a resposta nova de verdade. Esse NOME sozinho na linha confunde
// a IA — ela lê como se fosse quem está falando ali, mas às vezes é
// justamente o nome de quem NÃO está falando naquele trecho (ex: aparece
// "Feli" mas quem respondeu de verdade foi o Rafael, citando uma fala da
// Feli). Detecta esse padrão (nome sozinho seguido de uma linha que já
// apareceu antes) e remove as duas linhas, deixando só a resposta nova —
// assim a IA não tenta usar esses nomes pra decidir quem é quem.
function limparNomesDeRespostaCitada(conv){
  if(!conv)return conv;
  const linhas=conv.split('\n');
  const vistas=new Set();
  const nomeRegex=/^\p{Lu}[\p{Ll}'’]{1,20}$/u;
  const out=[];
  for(let i=0;i<linhas.length;i++){
    const linha=linhas[i];
    const norm=linha.trim().toLowerCase();
    if(norm&&nomeRegex.test(linha.trim())&&i+1<linhas.length){
      // a linha seguinte só conta como "mensagem citada repetida" se tiver
      // texto de verdade — horários (18:33) e emojis sozinhos se repetem o
      // tempo todo na conversa e não podem disparar o corte por engano.
      const proximaRaw=linhas[i+1].trim();
      const temLetra=/\p{L}/u.test(proximaRaw);
      const ehHorario=/^\d{1,2}:\d{2}$/.test(proximaRaw);
      const proxima=proximaRaw.toLowerCase();
      if(temLetra&&!ehHorario&&proxima&&vistas.has(proxima)){
        i++; // pula a linha do nome + a linha citada (duplicada)
        continue;
      }
    }
    if(norm)vistas.add(norm);
    out.push(linha);
  }
  return out.join('\n');
}
// Prompt compartilhado entre a análise normal e o "Refazer" (quando a IA
// inverteu quem é o chatter e quem é o lead — problema real reportado pela
// gestora). correcaoPapeis=true adiciona um aviso reforçado no topo pedindo
// pra reler a conversa com atenção redobrada antes de reanalisar.
function montarPromptAnaliseChatLab(c,conv,ctx,prevCount,correcaoPapeis){
  conv=limparNomesDeRespostaCitada(conv);
  const aviso=correcaoPapeis?`⚠️ CORREÇÃO IMPORTANTE: a gestora CONFIRMOU que a análise anterior dessa mesma conversa inverteu os papéis. Ou seja, quem você tratou como CHATTER na análise anterior é, na verdade, o LEAD/CLIENTE — e quem você tratou como LEAD/CLIENTE é, na verdade, o CHATTER **${c.name}**. Inverta essa identificação, não repita a mesma leitura. Ignore a posição/ordem das mensagens e identifique pelo COMPORTAMENTO: quem conduz a conversa, oferece mídia, aplica técnica de venda e cobra preço é sempre o CHATTER **${c.name}** — mesmo que antes tenha sido lido como o lado que compra.\n\n`:'';
  return`${aviso}Analise a conversa do chatter **${c.name}** (nível: ${c.level||'—'}).${ctx?'\nContexto: '+ctx:''}${prevCount?'\nAnálise nº '+(prevCount+1)+' — compare evolução quando relevante.':''}\n\nANTES DE ANALISAR: identifique com cuidado qual lado da conversa é o CHATTER (${c.name}) e qual é o LEAD/CLIENTE — nunca inverta os dois. O CHATTER é quem está atendendo/vendendo: geralmente conduz a conversa, oferece mídia, aplica técnica de venda, cobra preço, mantém o tom de uma persona. O LEAD é quem está comprando/consumindo: geralmente pede coisas, reage, pergunta preço, decide comprar.\n\nIDIOMA: a conversa colada pode estar em inglês (ou outro idioma que não português) — nesse caso, entenda e avalie normalmente, mas escreva TODA a análise em português como sempre. Sempre que citar ou reescrever um trecho literal da conversa (evidências, "Mensagens Desperdiçadas", exemplos), inclua a tradução em português logo em seguida entre parênteses. Se a conversa não estiver em português, comece a análise com a linha "🌐 Conversa em [idioma] — traduzida automaticamente nesta análise." (sem essa linha se já estiver em português).\n\n---\nCONVERSA:\n${conv}\n---\n\nGere análise em Markdown com: notas X/10 e evidências para Conexão Emocional, Conversão e Timing, Leitura de Sinais de Compra, Condução, Inteligência Emocional, Perfil do Lead, Qualificação, Inteligência Comercial, Criatividade, Gestão do Tempo e Retenção — usando a escala de temperatura, o arquétipo e as técnicas do playbook acima como base de cada avaliação, não critério genérico. Em "Perfil do Lead" especificamente: nomeie o arquétipo (10 ARQUÉTIPOS DE LEAD) citando a evidência real que embasa a escolha (nunca um rótulo sem prova), e se houver sinal claro de algum item do CATÁLOGO DE FETICHES, nomeie o fetiche identificado + seu foco psicológico e avalie se o chatter direcionou o roteiro/PPV storytelling pra esse foco específico ou perdeu a oportunidade. Se não houver sinal de fetiche específico, não force — diga que não identificou um fetiche claro em vez de inventar. Depois:\n\n## 🔴 Maiores Erros (graves → leves, com impacto — classifique cada um usando só o catálogo de erros do playbook)\n## 🟢 O Que Não Deve Mudar\n## 💬 Mensagens Desperdiçadas (reescreva 2-3 usando a técnica/gatilho certo do playbook)\n## 📋 Plano de Treinamento (3 prioridades: objetivo — como treinar — resultado)\n## 📊 Dashboard (tabela indicador × nota)\n**IGP: XX/100** (pesos: Conversão 20%, Conexão 15%, Condução 15%, Sinais 10%, Comercial 10%, demais 5% cada)\n## 🎯 Resumo Executivo\n- Ponto forte / Maior oportunidade / Erro crítico / Foco da semana / Parecer (Promoveria / Manteria com treinamento / Acompanhamento intensivo)\n\nPor fim, numa linha separada ao final, depois de tudo, inclua um bloco \`\`\`json com exatamente: {"temperaturaFinal":0,"arquetipo":"","converteu":"sim|nao|andamento","valor":0,"principalErro":"","sinalDeWhale":false} — baseado só no catálogo acima, pra virar dado estruturado do ranking (não aparece pro chatter, é só pro dashboard).`;
}
async function rodarChatLab(){
  const cid=document.getElementById('cl-chatter')?.value;
  const conv=document.getElementById('cl-conversa')?.value.trim();
  const ctx=document.getElementById('cl-ctx')?.value.trim();
  if(!cid){toast('⚠️ Selecione um chatter');return;}
  if(!conv){toast('⚠️ Cole a conversa');return;}
  const c=S.chatters.find(ch=>ch.id===cid);
  const btn=document.getElementById('cl-btn');
  btn.disabled=true;btn.textContent='Analisando…';
  document.getElementById('cl-resultado').innerHTML='<div style="text-align:center;padding:30px;color:var(--text2);font-size:13px">⏳ A IA está analisando a conversa…</div>';

  // Copiloto tático vem embutido na MESMA chamada da análise completa (ver
  // comentário em CHATLAB_COPILOTO_SCHEMA) — 1 pedido à IA por clique, não 2.
  renderClCopilotoResult('loading');

  const prev=S.chatlabAnalyses.filter(a=>a.chatterId===cid);
  const system=`Você é a Gerente Sênior de Performance de uma operação de vendas por chat. Analisa conversas de chatters usando EXATAMENTE o playbook interno da agência abaixo — não critérios genéricos de vendas. Seja crítica, objetiva e didática. Nunca elogie sem evidência. Nunca critique sem ensinar. Toda nota deve ter justificativa baseada na conversa real.\n\n${PLAYBOOK_CATALOGO}`;
  const copilotoInstrucao=`Antes de mais nada, gere um bloco \`\`\`copiloto contendo APENAS um JSON válido (nada de texto fora dele) com exatamente estas chaves — isso é o COPILOTO TÁTICO, lido em segundos no meio do atendimento real, então precisa ser o direcionamento mais assertivo e específico possível (nunca genérico, nunca teórico, nunca uma frase pronta pro chatter mandar):\n${CHATLAB_COPILOTO_SCHEMA}\n\nPra preencher esse JSON, identifique primeiro (com o mesmo cuidado descrito na instrução "ANTES DE ANALISAR" abaixo) qual lado da conversa é o CHATTER (${c.name}) e qual é o LEAD — nunca inverta os dois nesse bloco do copiloto; se inverter aqui, todo o direcionamento tático sai errado mesmo que a análise completa abaixo esteja correta.\n\n"arquetipo" precisa vir de evidência real da conversa, nunca de achismo: "evidencia" cita a(s) mensagem(ns) ou padrão específico do lead que embasa a escolha (ex: "pediu foto 3x sem nunca falar de preço" = Curioso), e "confianca" só é "alta" quando há 2+ sinais confirmando o mesmo arquétipo do catálogo — com só 1 sinal fraco, use "baixa" em vez de forçar uma leitura confiante.\n"feticheIdentificado" só deve ser preenchido se houver sinal real e específico na conversa (palavra-chave, pedido, reação a determinado tipo de mídia) batendo com algum item do CATÁLOGO DE FETICHES do playbook acima — "tipo" é o nome exato do catálogo, "focoPsicologico" é o foco psicológico daquele fetiche (copiado do catálogo, não inventado) que deve guiar o próximo PPV storytelling, e "evidencia" cita o sinal específico. Se não houver nenhum sinal claro de fetiche ainda, deixe os 3 campos em branco ("") — nunca chute um fetiche genérico tipo "convencional" só pra preencher.\n"gatilhoRecomendado" deve combinar os gatilhos do arquétipo identificado (ver 10 ARQUÉTIPOS DE LEAD) com o focoPsicologico do fetiche identificado quando houver um — "comoAplicar" é a ação concreta (não teoria) ligando os dois.\n\n"etapaFunil.numero" deve ser 0 a 6 conforme o FUNIL DE CHATTING do playbook acima (0 Validação Visual, 1 Aquecimento do Lead, 2 Conversa Intencional, 3 Pitch de Venda, 4 Compra, 5 LTV, 6 Conexão Extrema/Fidelização) e "etapaFunil.nome" o nome curto dessa etapa — ela precisa ser COERENTE com a temperatura: nunca marque etapa 4 (Compra) ou 5 (LTV) a menos que já tenha havido pagamento CONFIRMADO na conversa; um PPV enviado que o lead não abriu/pagou NÃO avança a etapa (continua Aquecimento/Conversa Intencional) e isso vira item em "erros" (vender antes de aquecer), não motivo pra pular a etapa à frente.\n"proximaAcao" (o campo mais importante) precisa combinar a etapa do funil identificada + a temperatura + as REGRAS DE OURO DE ALTA PERFORMANCE do playbook (nunca soar comercial, sempre posicionamento de conquista, rapport entre mídias) — diga o que fazer AGORA e por quê, ligado a um sinal específico da conversa, nunca um conselho genérico tipo "aprofunde a conexão". Se a regra "não pagou = silêncio" se aplicar, "proximaAcao" deve ser SÓ sobre recuar (curtar resposta/limitar atenção/ego) — nunca misture com "continue escalando desejo/oferta pro próximo passo", são instruções contraditórias.\n"alerta" é pra risco em TEMPO REAL, não observação genérica: priorize sinalizar se a conversa já passou de ~10-12 mensagens sem nenhuma tentativa de monetização, se o lead está tentando sair da plataforma, ou se a próxima mensagem do chatter corre risco de soar robótica/comercial demais — deixe em branco ("") se nada disso se aplica, não force um alerta à toa.\n"erros": no máximo 3, só do catálogo ERROS CLÁSSICOS DO PLAYBOOK, priorizando os que dá pra corrigir JÁ na próxima mensagem (não observações só retrospectivas de fechamento de conversa) — pode vir vazio.\nSe a conversa for curta demais pra avaliar algo com segurança, escreva "Não foi possível determinar" no campo em vez de inventar.\n\nDepois desse bloco, continue com a análise completa pedida abaixo — são DUAS coisas na mesma resposta, não pule nenhuma das duas.\n\n`;
  const prompt=copilotoInstrucao+montarPromptAnaliseChatLab(c,conv,ctx,prev.length,false);

  try{
    // A infra de IA às vezes corta a resposta no meio (flaky, não é sempre
    // no mesmo ponto) — tenta de novo automaticamente se vier incompleta
    // (sem a seção Resumo Executivo, que é sempre a última do relatório).
    let text='',lastErr=null;
    for(let attempt=0;attempt<2;attempt++){
      try{
        // 7000 (não 6000) porque agora a resposta inclui TAMBÉM o bloco
        // ```copiloto embutido — precisa de um pouco mais de orçamento de
        // tokens além da análise completa em si.
        text=await clFetchAI(system,prompt,7000);
      }catch(err){
        lastErr=err;
        text='';
        // Erro de limite de uso já vem com o tempo real de espera — tentar
        // de novo em 1.5s só gastaria mais uma requisição da cota.
        if(err.quota)break;
        if(attempt===0)await new Promise(r=>setTimeout(r,1500));
        continue;
      }
      if(text&&/## 🎯 Resumo Executivo/i.test(text))break;
      lastErr=new Error('Resposta incompleta da IA (provavelmente limite de uso da IA no momento — espere um minuto e tente de novo)');
      text='';
      if(attempt===0)await new Promise(r=>setTimeout(r,1500));
    }
    if(!text)throw lastErr||new Error('Resposta vazia da IA');
    // Extrai o bloco ```copiloto (dica tática embutida na mesma resposta) e
    // tira do texto ANTES de tudo — o resto da função (parsing do IGP, tags,
    // renderização em markdown) precisa ver só a análise completa, sem esse
    // bloco misturado no meio.
    const copM=text.match(/```copiloto\s*([\s\S]*?)```/i);
    if(copM){
      try{renderClCopilotoResult('ok',JSON.parse(copM[1]));}
      catch(e){renderClCopilotoResult('error',new Error('Copiloto: resposta em formato inesperado'));}
      text=(text.slice(0,copM.index)+text.slice(copM.index+copM[0].length)).trim();
    }else{
      renderClCopilotoResult('error',new Error('Copiloto não veio nessa resposta'));
    }
    const igpM=text.match(/IGP[^:]*:\s*\**\s*(\d+)/i);
    const igp=igpM?parseInt(igpM[1]):null;
    // Extract resumo executivo snippet for the Evolução diagnostic square
    const resumoM=text.match(/## 🎯 Resumo Executivo([\s\S]*?)(?=\n## |```json|$)/i);
    const resumo=resumoM?resumoM[1].trim().slice(0,600):'';
    // Extrai o bloco json final (dado estruturado pro ranking) e tira do
    // texto visível — o chatter/gestor só veem o relatório em markdown.
    let tags=null;
    const jsonM=text.match(/```json\s*([\s\S]*?)```/i);
    if(jsonM){
      try{tags=JSON.parse(jsonM[1]);}catch(e){tags=null;}
      text=text.slice(0,jsonM.index).trim();
    }
    const newId='cla'+Date.now();
    S.chatlabAnalyses.push({id:newId,chatterId:cid,date:new Date().toISOString(),igp,raw:text,resumo,tags,conv});
    save();
    const col=igp>=70?'var(--ok)':igp>=50?'var(--warn)':'var(--bad)';
    const resEl=document.getElementById('cl-resultado');
    resEl.dataset.analysisId=newId;
    resEl.innerHTML=`<div class="panel" style="border-left:3px solid ${col}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-weight:700">${c.name} — análise concluída</div>
        ${igp?`<div style="font-size:24px;font-weight:800;font-family:var(--font-mono);color:${col}">${igp}<span style="font-size:11px;color:var(--text3)">/100</span></div>`:''}
      </div>
      <div class="cl-md">${clMd(text)}</div>
      ${redoBtnHtml(newId)}
    </div>`;
    renderChatLabHistorico();
    renderChatLabRanking();
    toast('✅ Análise salva — aparece na Evolução');
  }catch(err){
    // Copiloto vem na MESMA resposta agora — se a chamada toda falhou, o
    // painel dele não pode continuar preso em "calculando" pra sempre.
    renderClCopilotoResult('error',err);
    if(err.quota){
      renderAIWaitCountdown('cl-resultado',err.waitSeconds,{prefix:'⏳ Análise completa — limite de uso da IA',panel:true,suffix:'a conversa colada continua no campo'});
    }else{
      document.getElementById('cl-resultado').innerHTML=`<div class="panel" style="border-color:var(--bad)"><div style="color:var(--bad);font-size:13px">❌ ${err.message}</div><div style="font-size:12px;color:var(--text3);margin-top:5px">Verifique a conexão e tente novamente.</div></div>`;
    }
  }finally{
    btn.disabled=false;btn.textContent='⚡ Analisar';
  }
}
// Botão de canto pra quando a IA confunde quem é o chatter e quem é o lead
// (problema real reportado pela gestora — de vez em quando a análise sai
// com os papéis invertidos). Só aparece funcional se a conversa original
// ainda estiver salva (.conv só existe durante a semana da análise).
function redoBtnHtml(id){
  return`<button data-noaccordion onclick="refazerAnaliseInvertida('${id}',this)" style="margin-top:10px;background:none;border:1px solid var(--line);border-radius:7px;padding:6px 10px;font-size:11px;color:var(--text3);cursor:pointer">🔄 Refazer (inverteu quem é quem)</button>`;
}
async function refazerAnaliseInvertida(analysisId,btnEl){
  const idx=S.chatlabAnalyses.findIndex(a=>a.id===analysisId);
  if(idx<0){toast('⚠️ Análise não encontrada');return;}
  const a=S.chatlabAnalyses[idx];
  if(!a.conv){
    toast('⚠️ A conversa original dessa análise já não está mais salva (virada de semana) — cole a conversa de novo e rode uma análise nova.');
    return;
  }
  const c=S.chatters.find(ch=>ch.id===a.chatterId);
  if(!c){toast('⚠️ Chatter não encontrado');return;}
  if(btnEl){btnEl.disabled=true;btnEl.textContent='Refazendo…';}
  toast('🔄 Refazendo análise com atenção redobrada aos papéis…');
  const prevCount=S.chatlabAnalyses.filter(x=>x.chatterId===a.chatterId&&x.id!==analysisId).length;
  const system=`Você é a Gerente Sênior de Performance de uma operação de vendas por chat. Analisa conversas de chatters usando EXATAMENTE o playbook interno da agência abaixo — não critérios genéricos de vendas. Seja crítica, objetiva e didática. Nunca elogie sem evidência. Nunca critique sem ensinar. Toda nota deve ter justificativa baseada na conversa real.\n\n${PLAYBOOK_CATALOGO}`;
  const prompt=montarPromptAnaliseChatLab(c,a.conv,'',prevCount,true);
  try{
    let text='',lastErr=null;
    for(let attempt=0;attempt<2;attempt++){
      try{
        text=await clFetchAI(system,prompt,6000);
      }catch(err){
        lastErr=err;text='';
        if(err.quota)break;
        if(attempt===0)await new Promise(r=>setTimeout(r,1500));
        continue;
      }
      if(text&&/## 🎯 Resumo Executivo/i.test(text))break;
      lastErr=new Error('Resposta incompleta da IA (provavelmente limite de uso da IA no momento — espere um minuto e tente de novo)');
      text='';
      if(attempt===0)await new Promise(r=>setTimeout(r,1500));
    }
    if(!text)throw lastErr||new Error('Resposta vazia da IA');
    const igpM=text.match(/IGP[^:]*:\s*\**\s*(\d+)/i);
    const igp=igpM?parseInt(igpM[1]):null;
    const resumoM=text.match(/## 🎯 Resumo Executivo([\s\S]*?)(?=\n## |```json|$)/i);
    const resumo=resumoM?resumoM[1].trim().slice(0,600):'';
    let tags=null;
    const jsonM=text.match(/```json\s*([\s\S]*?)```/i);
    if(jsonM){
      try{tags=JSON.parse(jsonM[1]);}catch(e){tags=null;}
      text=text.slice(0,jsonM.index).trim();
    }
    // Substitui no lugar — mesmo id/chatterId/date/conv, só troca o
    // conteúdo da análise em si.
    S.chatlabAnalyses[idx]={...a,igp,raw:text,resumo,tags};
    save();
    toast('✅ Análise refeita');
    renderChatLabHistorico();
    renderChatLabRanking();
    if(currentViewName()==='testers'){
      const sel=document.getElementById('tester-select');
      if(sel&&sel.value===a.chatterId)renderTesterDetail(a.chatterId);
    }
    const resEl=document.getElementById('cl-resultado');
    if(resEl&&resEl.dataset.analysisId===analysisId){
      const col=igp>=70?'var(--ok)':igp>=50?'var(--warn)':'var(--bad)';
      resEl.innerHTML=`<div class="panel" style="border-left:3px solid ${col}">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div style="font-weight:700">${c.name} — análise refeita</div>
          ${igp?`<div style="font-size:24px;font-weight:800;font-family:var(--font-mono);color:${col}">${igp}<span style="font-size:11px;color:var(--text3)">/100</span></div>`:''}
        </div>
        <div class="cl-md">${clMd(text)}</div>
        ${redoBtnHtml(analysisId)}
      </div>`;
    }
  }catch(err){
    if(err.quota)toast(`⏳ Limite de uso da IA — tente de novo em ${err.waitSeconds||60}s`);
    else toast('❌ Erro ao refazer: '+err.message);
    if(btnEl){btnEl.disabled=false;btnEl.textContent='🔄 Refazer (inverteu quem é quem)';}
  }
}

/* ===========================================================
   CHATLAB — RELATÓRIO SEMANAL DO CHATTER
   Junta todas as análises da semana (Segunda-Domingo) de um chatter —
   rodadas por ela OU pelo próprio chatter via link de autoanálise — e
   pede pra IA sintetizar um relatório de evolução: o que melhorou, o
   que manter, os erros mais frequentes, o plano pra semana seguinte e
   uma tarefa de autoteste. O objetivo (pedido explícito da gestora) é
   que o time aprenda a se autocorrigir sem depender só dela apontando
   erro por erro. Pode ser gerado tanto por ela (aba ChatLab) quanto
   pelo próprio chatter (link público chatlab-chatter.html) — os dois
   lados enxergam o mesmo relatório assim que qualquer um gera.
   =========================================================== */
function coletarAnalisesDaSemana(cid,offset){
  const wd=getWeekDates(offset!==undefined?offset:0); // por padrão sempre a semana ATUAL — só Métricas passa offset explícito pra seguir a navegação de semana da tela
  const start=wd[0];
  const end=new Date(wd[6]);end.setHours(23,59,59,999);
  return(S.chatlabAnalyses||[])
    .filter(a=>a.chatterId===cid&&a.date&&new Date(a.date)>=start&&new Date(a.date)<=end)
    .sort((a,b)=>(a.date||'').localeCompare(b.date||''));
}
// Calcula métricas objetivas da semana (não depende da IA acertar conta) —
// usa só o campo .tags que cada análise já salva.
function calcMetricasSemana(analises){
  const comIgp=analises.filter(a=>a.igp!=null);
  const avgIGP=comIgp.length?Math.round(comIgp.reduce((s,a)=>s+(a.igp||0),0)/comIgp.length):null;
  const tagged=analises.filter(a=>a.tags);
  const taxaConversao=tagged.length?Math.round(tagged.filter(a=>a.tags.converteu==='sim').length/tagged.length*100):null;
  const arqTally={};
  tagged.forEach(a=>{if(a.tags.arquetipo)arqTally[a.tags.arquetipo]=(arqTally[a.tags.arquetipo]||0)+1;});
  const topArquetipo=Object.entries(arqTally).sort((a,b)=>b[1]-a[1])[0]?.[0]||null;
  // Quantas conversas da semana tiveram sinal de whale (cliente com padrão de
  // comprador de alto valor, conforme o playbook) — pra dar visibilidade de
  // quando o chatter consegue criar/converter um whale, não só ficar
  // escondido dentro de cada análise individual.
  const whaleCount=tagged.filter(a=>a.tags.sinalDeWhale).length;
  return{avgIGP,taxaConversao,topArquetipo,whaleCount};
}
async function gerarRelatorioSemanalChatter(cid,generatedBy){
  const c=S.chatters.find(ch=>ch.id===cid);
  if(!c)return;
  const analises=coletarAnalisesDaSemana(cid);
  if(!analises.length){toast('⚠️ Nenhuma análise do ChatLab essa semana ainda pra gerar relatório');return;}
  const wk=getWeekKey(0);
  const metrics=calcMetricasSemana(analises);
  const contexto=analises.map((a,i)=>`Análise ${i+1} — ${new Date(a.date).toLocaleDateString('pt-BR',{day:'2-digit',month:'short'})} — IGP ${a.igp||'—'}${a.tags?.principalErro?` — erro principal: ${a.tags.principalErro}`:''}${a.tags?.converteu?` — converteu: ${a.tags.converteu}`:''}${a.tags?.arquetipo?` — arquétipo: ${a.tags.arquetipo}`:''}${a.tags?.sinalDeWhale?' — 🐋 sinal de whale identificado nessa conversa':''}\n${a.resumo||''}`).join('\n\n---\n\n');
  const system=`Você é a Gerente Sênior de Performance de uma operação de vendas por chat, usando EXATAMENTE o playbook interno abaixo (não critérios genéricos). Baseie-se só nas análises fornecidas, nunca invente dado que não está lá.\n\n${PLAYBOOK_CATALOGO}`;
  const prompt=`Chatter: ${c.name}. Semana: ${weekLabel(0)} (${analises.length} análise${analises.length>1?'s':''} de conversa registrada${analises.length>1?'s':''}, rodadas por ele mesmo e/ou pela gestora). Sinais de whale identificados essa semana: ${metrics.whaleCount}.\n\nRESUMOS DAS ANÁLISES DA SEMANA:\n${contexto}\n\nEscreva DUAS versões do relatório semanal, nessa ordem exata:\n\n1) VERSÃO PRA GESTORA (Markdown, direto, analítico, com evidência de cada análise) com exatamente estas seções:\n## 💪 Pontos Fortes\n## ⚠️ Fraquezas\n## 📈 O Que Melhorou\n## 🎯 Perfil Deste Chatter (diga se ele tende bem pra venda rápida, prioriza conexão/vínculo, ou prioriza qualificar o lead antes de tudo — com evidência das análises, pra gestora saber onde ele funciona mais)\n## 🧭 Tipo de Lead Que Ele Atende Melhor (qual arquétipo de lead ele converte/conduz melhor)\n## 🗣️ Como É a Condução da Conversa\n## 🐋 Whales (se houve pelo menos 1 sinal de whale essa semana, destaque isso aqui: em qual conversa apareceu e o que especificamente o chatter fez certo que gerou esse sinal, segundo o playbook de Criação de Whale — se não houve nenhum, escreva só "Nenhum sinal de whale essa semana")\n## 🔴 Problemas Mais Frequentes (ranqueados por quantas vezes apareceram — só o que está nos dados)\n## 🎯 Plano Pra Próxima Semana (uma ação concreta por problema)\n\n2) Logo em seguida, um bloco \`\`\`chatter contendo a versão PRO PRÓPRIO CHATTER ler — tom completamente diferente: informal, simples, como se fosse um chatter mais experiente dando dica de colega pra colega, NUNCA se apresentando como gerente/gestora ou usando linguagem formal. Cubra: o que ele mandou bem essa semana (se criou algum whale, comemora isso especificamente como uma conquista), os erros mais comuns em linguagem simples e como corrigir, e uma tarefa de autoteste pra ele praticar sozinho nos próximos dias (nunca uma meta de tempo/prazo de venda — só prática de técnica específica).`;
  try{
    const text=await clFetchAI(system,prompt,3500);
    if(!text)throw new Error('Resposta vazia da IA');
    const fenceM=text.match(/```chatter\s*([\s\S]*?)```/i);
    let rawGestora=text.trim(),rawChatter='';
    if(fenceM){
      rawChatter=fenceM[1].trim();
      rawGestora=text.slice(0,fenceM.index).trim();
    }else{
      rawChatter=rawGestora; // fallback: IA não formatou a cerca — melhor mostrar algo do que nada
    }
    if(!S.chatlabWeeklyReports)S.chatlabWeeklyReports={};
    if(!S.chatlabWeeklyReports[cid])S.chatlabWeeklyReports[cid]=[];
    S.chatlabWeeklyReports[cid]=S.chatlabWeeklyReports[cid].filter(r=>r.weekKey!==wk); // regenerar substitui a da mesma semana
    S.chatlabWeeklyReports[cid].push({weekKey:wk,date:new Date().toISOString(),rawGestora,rawChatter,generatedBy:generatedBy||'gestora',analisesCount:analises.length,metrics});
    save();
    return{rawGestora,rawChatter};
  }catch(err){
    if(err.quota)toast(`⏳ Limite de uso da IA — tente de novo em ${err.waitSeconds||60}s`);
    else toast('❌ Erro ao gerar relatório: '+err.message);
    throw err;
  }
}
async function gerarRelatorioSemanalUI(){
  const cid=document.getElementById('cl-chatter')?.value;
  if(!cid){toast('⚠️ Selecione um chatter primeiro');return;}
  const c=S.chatters.find(ch=>ch.id===cid);
  const btn=document.getElementById('cl-relatorio-btn');
  if(btn){btn.disabled=true;btn.textContent='Gerando…';}
  try{
    await gerarRelatorioSemanalChatter(cid,'gestora');
    toast(`✅ Relatório semanal salvo — veja na Ficha de ${c?c.name:'chatter'}`);
  }catch(e){/* toast já mostrado dentro de gerarRelatorioSemanalChatter */}
  if(btn){btn.disabled=false;btn.textContent='📅 Relatório da semana';}
  if(currentViewName()==='testers'){
    const sel=document.getElementById('tester-select');
    if(sel&&sel.value===cid)renderTesterDetail(cid);
  }
}
// Mesma geração, só que disparada direto do quadro clicável dentro da
// própria Ficha (não depende do seletor da aba ChatLab).
async function gerarRelatorioSemanalFicha(cid){
  const c=S.chatters.find(ch=>ch.id===cid);
  const btn=document.getElementById('relsemanal-btn-'+cid);
  if(btn){btn.disabled=true;btn.textContent='Gerando…';}
  try{
    await gerarRelatorioSemanalChatter(cid,'gestora');
    toast(`✅ Relatório semanal de ${c?c.name:'chatter'} gerado`);
  }catch(e){/* toast já mostrado dentro de gerarRelatorioSemanalChatter */}
  if(currentViewName()==='testers'){
    const sel=document.getElementById('tester-select');
    if(sel&&sel.value===cid)renderTesterDetail(cid);
  }
}
function weekKeyToLabel(wk){
  const[y,m,d]=wk.split('-').map(Number);
  const mon=new Date(y,m-1,d);
  const sun=new Date(mon);sun.setDate(mon.getDate()+6);
  return`${mon.getDate()}/${mon.getMonth()+1} – ${sun.getDate()}/${sun.getMonth()+1}`;
}
// Painel da Ficha do chatter — versão analítica (dashboard) pra gestora, com
// o quadro clicável "Relatório Chatter" que mostra exatamente a versão que
// ele vê no link dele.
function relatorioSemanalFichaHtml(cid){
  const lista=(S.chatlabWeeklyReports?.[cid]||[]).slice().sort((a,b)=>b.weekKey.localeCompare(a.weekKey));
  // Sempre aparece como um quadro clicável na Ficha, mesmo sem relatório
  // ainda — assim dá pra gerar direto daqui, sem precisar ir na aba ChatLab.
  if(!lista.length){
    return fichaAccordion('relsemanal-'+cid,'border:2px solid var(--accent)',
      `<div><div class="panel-title">📊 Relatório Semanal do Chatter</div><div class="panel-note">Nenhum ainda essa semana</div></div>`,
      `<div style="font-size:12.5px;color:var(--text2);margin-bottom:10px">Junta as análises da semana e resume pontos fortes, fraquezas, o que melhorou e o perfil desse chatter.</div>
       <button data-noaccordion class="btn btn-primary btn-block" id="relsemanal-btn-${cid}" onclick="gerarRelatorioSemanalFicha('${cid}')">📅 Gerar relatório desta semana</button>`
    );
  }
  const atual=lista[0];
  const m=atual.metrics||{};
  const origem=atual.generatedBy==='chatter'?'🤖 gerado pelo próprio chatter':'gerado por você';
  const body=`<div style="font-size:11px;color:var(--text3);margin-bottom:10px">${weekKeyToLabel(atual.weekKey)} · ${atual.analisesCount} análise${atual.analisesCount>1?'s':''} · ${origem}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      ${m.avgIGP!=null?`<div style="flex:1;min-width:90px;background:var(--bg-soft);border-radius:8px;padding:8px;text-align:center">
        <div style="font-size:9px;color:var(--text3)">IGP MÉDIO</div>
        <div style="font-size:16px;font-weight:800;font-family:var(--font-mono);color:${m.avgIGP>=70?'var(--ok)':m.avgIGP>=50?'var(--warn)':'var(--bad)'}">${m.avgIGP}</div>
      </div>`:''}
      ${m.taxaConversao!=null?`<div style="flex:1;min-width:90px;background:var(--bg-soft);border-radius:8px;padding:8px;text-align:center">
        <div style="font-size:9px;color:var(--text3)">TAXA CONVERSÃO</div>
        <div style="font-size:16px;font-weight:800;font-family:var(--font-mono)">${m.taxaConversao}%</div>
      </div>`:''}
      ${m.topArquetipo?`<div style="flex:1;min-width:90px;background:var(--bg-soft);border-radius:8px;padding:8px;text-align:center">
        <div style="font-size:9px;color:var(--text3)">ARQUÉTIPO+</div>
        <div style="font-size:13px;font-weight:800">${m.topArquetipo}</div>
      </div>`:''}
      ${m.whaleCount!=null?`<div style="flex:1;min-width:90px;background:${m.whaleCount>0?'var(--accent-soft)':'var(--bg-soft)'};border-radius:8px;padding:8px;text-align:center">
        <div style="font-size:9px;color:var(--text3)">🐋 WHALES</div>
        <div style="font-size:16px;font-weight:800;font-family:var(--font-mono);color:${m.whaleCount>0?'var(--accent)':'var(--text3)'}">${m.whaleCount}</div>
      </div>`:''}
    </div>
    <div class="cl-md">${clMd(atual.rawGestora)}</div>
    <div data-noaccordion onclick="toggleRelatorioChatterPreview('${cid}')" style="margin-top:14px;border:2px dashed var(--accent);border-radius:10px;padding:12px;text-align:center;cursor:pointer;font-weight:700;color:var(--accent);font-size:12.5px">👁️ Relatório Chatter — ver o que ${S.chatters.find(ch=>ch.id===cid)?.name||'ele'} vai ver</div>
    <div id="relatorio-chatter-preview-${cid}" style="display:none;margin-top:10px;background:var(--accent-soft);border-radius:10px;padding:14px">
      <div class="cl-md">${clMd(atual.rawChatter)}</div>
    </div>
    ${lista.length>1?`<div style="margin-top:10px;font-size:11px;color:var(--text3)">${lista.length-1} relatório${lista.length-1>1?'s':''} de semana${lista.length-1>1?'s':''} anterior${lista.length-1>1?'es':''} também salvo${lista.length-1>1?'s':''}</div>`:''}`;
  return fichaAccordion('relsemanal-'+cid,'border:2px solid var(--accent)',
    `<div><div class="panel-title">📊 Relatório Semanal do Chatter</div><div class="panel-note">${weekKeyToLabel(atual.weekKey)}${m.avgIGP!=null?` · IGP médio ${m.avgIGP}`:''}</div></div>`,
    body
  );
}
function toggleRelatorioChatterPreview(cid){
  const el=document.getElementById('relatorio-chatter-preview-'+cid);
  if(!el)return;
  el.style.display=el.style.display==='none'?'block':'none';
}
// Painel da Ficha do chatter — todas as conversas que ele (ou a gestora)
// já mandou pro ChatLab analisar, minimizadas por padrão, com data — pedido
// explícito da gestora pra acompanhar tudo sem procurar no histórico global.
function conversasAnalisadasFichaHtml(cid){
  const lista=(S.chatlabAnalyses||[]).filter(a=>a.chatterId===cid).slice().sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  if(!lista.length)return'';
  const body=lista.map(a=>{
    const col=a.igp>=70?'var(--ok)':a.igp>=50?'var(--warn)':a.igp?'var(--bad)':'var(--text3)';
    const dt=a.date?new Date(a.date).toLocaleDateString('pt-BR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'';
    return`<div style="border:1px solid var(--line);border-radius:9px;margin-bottom:8px;overflow:hidden">
      <div style="padding:9px 12px;background:var(--bg-soft);display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="toggleClAn('ficha-${a.id}')">
        <div style="font-size:11.5px;color:var(--text3)">${dt}${a.autoAnalise?' <span style="font-size:9px;font-weight:700;color:var(--accent)">🤖 autoanálise</span>':''}</div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:15px;font-weight:800;font-family:var(--font-mono);color:${col}">${a.igp||'—'}</span>
          <span style="font-size:9px;color:var(--text3)" id="cl-ic-ficha-${a.id}">▼</span>
        </div>
      </div>
      <div id="cl-body-ficha-${a.id}" style="display:none">
        ${a.conv?`<div style="margin:14px 14px 0;background:var(--bg-soft);border-radius:8px;padding:10px 12px">
          <div style="font-size:10px;font-weight:700;color:var(--text3);margin-bottom:5px">💬 CONVERSA (some na virada da semana — só o relatório abaixo fica salvo pra sempre)</div>
          <div style="font-size:12px;color:var(--text2);white-space:pre-wrap;max-height:160px;overflow-y:auto;line-height:1.5">${a.conv.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
        </div>`:''}
        <div class="cl-md" style="padding:14px 14px 0">${clMd(a.raw||'')}</div>
        <div style="padding:0 14px 14px">${redoBtnHtml(a.id)}</div>
      </div>
    </div>`;
  }).join('');
  return fichaAccordion('convanalisadas-'+cid,'',
    `<div><div class="panel-title">🔬 Conversas Analisadas</div><div class="panel-note">${lista.length} conversa${lista.length>1?'s':''} — inclui as que ele mesmo autoanalisou</div></div>`,
    body
  );
}

/* ===========================================================
   TREINAMENTO POR CHATTER (Evolução) → orientações da semana
   =========================================================== */
function saveChatterTraining(cid,val){
  S.chatterTraining[cid]=val;
  save();
}
function saveEvolucaoNote(cid,val){
  if(!S.chatterFichas[cid])S.chatterFichas[cid]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
  S.chatterFichas[cid].evolucaoNotes=val;
  save();
}
function sendTrainingToWeek(cid){
  const txt=(S.chatterTraining[cid]||'').trim();
  if(!txt){toast('⚠️ Escreva o treinamento primeiro');return;}
  addWeekOrient(txt,cid);
}

/* ===========================================================
   GERADOR DE RELATÓRIOS (aba integrada, sem Discord)
   =========================================================== */
let gerSheets={}; // modelName(UPPER) -> rows (session only, not persisted)
function gerLoadXlsx(e,modelKey){
  const f=e.target.files[0];if(!f)return;
  if(typeof XLSX==='undefined'){toast('❌ Biblioteca XLSX não carregou — recarregue a página');return;}
  const r=new FileReader();
  r.onload=ev=>{
    try{
      const wb=XLSX.read(ev.target.result,{type:'array'});
      gerSheets[modelKey]=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
      toast(`✅ ${modelKey}: ${gerSheets[modelKey].length} linhas`);
      renderGerador();
    }catch(err){toast('❌ Erro ao ler planilha');}
  };
  r.readAsArrayBuffer(f);
}
function gerAddChatter(team){
  if(!S.models.length){toast('⚠️ Cadastre modelos primeiro');return;}
  S[team].push({name:'',model:S.models[0].name.toUpperCase(),intervals:[{s:'',e:'',extra:false}]});
  save();renderGerador();
}
function renderGerCards(team,elId){
  const el=document.getElementById(elId);
  if(!el)return;
  const list=S[team]||[];
  if(!list.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px;padding:4px 0">Nenhum chatter — use o botão +</div>';return;}
  el.innerHTML=list.map((c,ci)=>`<div style="background:var(--bg-soft);border-radius:10px;padding:12px;margin-bottom:10px">
    <div style="display:flex;gap:8px;margin-bottom:8px">
      <input class="finput" style="flex:2" placeholder="Nome do chatter" value="${c.name||''}" list="ger-names" onblur="S['${team}'][${ci}].name=this.value;save();">
      <select class="fselect" style="flex:1" onchange="S['${team}'][${ci}].model=this.value;save();">
        ${S.models.map(m=>`<option value="${m.name.toUpperCase()}" ${c.model===m.name.toUpperCase()?'selected':''}>${m.name}</option>`).join('')}
      </select>
      <button onclick="S['${team}'].splice(${ci},1);save();renderGerador();" style="background:none;border:none;color:var(--bad);cursor:pointer;font-size:15px">✕</button>
    </div>
    ${(c.intervals||[]).map((iv,ii)=>`<div style="display:flex;align-items:center;gap:7px;margin-bottom:6px">
      <input class="finput" style="width:90px;font-family:var(--font-mono)" placeholder="início" value="${iv.s||''}" onblur="S['${team}'][${ci}].intervals[${ii}].s=this.value;save();">
      <span style="color:var(--text3);font-size:12px">às</span>
      <input class="finput" style="width:90px;font-family:var(--font-mono)" placeholder="fim" value="${iv.e||''}" onblur="S['${team}'][${ci}].intervals[${ii}].e=this.value;save();">
      <label style="display:flex;align-items:center;gap:4px;font-size:11.5px;color:var(--text2);cursor:pointer">
        <input type="checkbox" style="width:auto" ${iv.extra?'checked':''} onchange="S['${team}'][${ci}].intervals[${ii}].extra=this.checked;save();">⚡ extra
      </label>
      <button onclick="S['${team}'][${ci}].intervals.splice(${ii},1);save();renderGerador();" style="background:none;border:none;color:var(--text3);cursor:pointer">✕</button>
    </div>`).join('')}
    <button class="btn btn-ghost btn-xs" onclick="S['${team}'][${ci}].intervals.push({s:'',e:'',extra:false});save();renderGerador();">+ intervalo</button>
  </div>`).join('')+`<datalist id="ger-names">${S.chatters.map(c=>`<option value="${c.name}">`).join('')}</datalist>`;
}
function gerToMins(t){if(!t)return 0;const p=t.split(':').map(Number);return p[0]*60+(p[1]||0);}
function gerInIvs(mins,ivs){
  for(const iv of ivs){
    if(!iv.s)continue;
    const sm=gerToMins(iv.s),em=gerToMins(iv.e||'23:59');
    if(sm<=em){if(mins>=sm&&mins<=em)return true;}
    else{if(mins>=sm||mins<=em)return true;}
  }
  return false;
}
function gerSalesFor(c,excludeSet){
  const sheet=gerSheets[c.model];
  if(!sheet)return null;
  const valid=['Chat','Mimo - Chat'];
  const sales=[];
  for(const row of sheet){
    const tipo=(row['Tipo de entrada']||'').trim();
    if(!valid.includes(tipo))continue;
    const hora=(row['Hora']||'').toString().substring(0,5);
    if(excludeSet&&excludeSet.has(hora))continue;
    if(!gerInIvs(gerToMins(hora),c.intervals))continue;
    sales.push({hora,val:parseFloat(row['Sua comissão']||0)});
  }
  sales.sort((a,b)=>gerToMins(a.hora)-gerToMins(b.hora));
  return sales;
}
function gerBuildText(c,dateStr,canal,excludeSet){
  const sales=gerSalesFor(c,excludeSet);
  if(sales===null)return{warn:'planilha de '+c.model+' não carregada'};
  const normIvs=c.intervals.filter(iv=>iv.s&&!iv.extra);
  const extraIvs=c.intervals.filter(iv=>iv.s&&iv.extra);
  const blocks=[];
  const mkBlock=(ivs,label)=>{
    if(!ivs.length)return null;
    const bSales=sales.filter(s=>gerInIvs(gerToMins(s.hora),ivs));
    // sort in shift-relative order (overnight: 23:30 comes before 03:15)
    const anchor=gerToMins(ivs[0].s);
    bSales.sort((a,b)=>((gerToMins(a.hora)-anchor+1440)%1440)-((gerToMins(b.hora)-anchor+1440)%1440));
    const total=bSales.reduce((s,x)=>s+x.val,0);
    return{label,ivStr:ivs.map(iv=>iv.s+' às '+(iv.e||'?')).join(' e '),sales:bSales,total};
  };
  const nb=mkBlock(normIvs,c.model+' '+canal);
  const eb=mkBlock(extraIvs,c.model+' HORA EXTRA');
  [nb,eb].forEach(b=>{if(b)blocks.push(b);});
  if(!blocks.length)return{warn:'sem intervalos válidos'};
  const lines=['Data: '+dateStr,'Nome: '+c.name];
  let grandTotal=0;
  blocks.forEach(b=>{
    lines.push(b.label,b.ivStr,...b.sales.map(s=>s.hora+' - R$ '+s.val.toFixed(2).replace('.',',')));
    lines.push('Total de comissões: R$ '+b.total.toFixed(2).replace('.',','));
    grandTotal+=b.total;
  });
  return{text:lines.join('\n'),total:grandTotal};
}
function gerarRelatorios(){
  const out=document.getElementById('ger-out');
  const dataVal=document.getElementById('ger-data')?.value;
  const canal=(document.getElementById('ger-canal')?.value.trim()||'PRIVACY FREE').toUpperCase();
  const meu=(S.geradorMeu||[]).filter(c=>c.name);
  const elite=(S.geradorElite||[]).filter(c=>c.name);
  if(!meu.length&&!elite.length){
    out.innerHTML='<div class="panel" style="color:var(--text3);font-size:13px">Adicione chatters antes de gerar</div>';return;
  }
  const dateStr=dataVal?dataVal.split('-').reverse().join('/'):'--/--/----';

  // Collect elite sale hours per model to subtract from meu
  const eliteTimes={};
  elite.forEach(c=>{
    const parsed=parseEliteSales(c.salesRaw);
    if(!eliteTimes[c.model])eliteTimes[c.model]=new Set();
    parsed.forEach(s=>eliteTimes[c.model].add(s.hora));
  });

  let html='';
  const allTexts=[];

  const renderGroup=(list,title,useEliteExcl)=>{
    if(!list.length)return;
    html+=`<div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin:14px 0 8px">${title}</div>`;
    list.forEach((c,idx)=>{
      const excl=useEliteExcl?(eliteTimes[c.model]||null):null;
      const r=gerBuildText(c,dateStr,canal,excl&&excl.size?excl:null);
      if(r.warn){
        html+=`<div class="panel" style="border-color:var(--warn);padding:10px 14px;font-size:12.5px"><strong>${c.name}</strong> — ⚠️ ${r.warn}</div>`;
        return;
      }
      allTexts.push(r.text);
      window._gerTexts=window._gerTexts||{};
      window._gerTexts[title+'_'+idx]=r.text;
      const tid='gtx_'+title.replace(/\s/g,'')+'_'+idx;
      html+=`<div class="panel" style="padding:0;overflow:hidden">
        <div style="padding:10px 14px;background:var(--bg-soft);display:flex;align-items:center;justify-content:space-between">
          <div style="font-weight:700;font-size:13.5px">${c.name} <span style="font-size:11px;color:var(--text3)">${c.model}</span></div>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-family:var(--font-mono);font-weight:800;color:var(--ok)">${money(r.total)}</span>
            <button class="btn btn-ghost btn-xs" onclick="gerCopyTid('${tid}')">📋 copiar</button>
          </div>
        </div>
        <pre id="${tid}" style="margin:0;padding:12px 14px;font-family:var(--font-mono);font-size:11.5px;white-space:pre-wrap;color:var(--text2);line-height:1.7">${r.text}</pre>
      </div>`;
    });
  };

  // Elite team — build from parsed sales using sheet commissions
  if(elite.length){
    html+=`<div style="font-size:11px;font-weight:700;color:var(--warn);text-transform:uppercase;letter-spacing:.05em;margin:14px 0 8px">⭐ Time Elite</div>`;
    elite.forEach((c,idx)=>{
      const parsed=parseEliteSales(c.salesRaw);
      if(!parsed.length){
        html+=`<div class="panel" style="border-color:var(--warn);padding:10px 14px;font-size:12.5px"><strong>${c.name}</strong> — ⚠️ Sem vendas encontradas (verifique o formato)</div>`;
        return;
      }
      // Get commissions from sheet
      let salesWithCom=[];
      let total=0;
      parsed.forEach(s=>{
        const com=gerGetComissao(s.hora,c.model,s.bruto);
        const val=com!==null?com:s.bruto*0.3; // fallback 30%
        salesWithCom.push({hora:s.hora,val});
        total+=val;
      });
      const ivStr=parsed.length?`${parsed[0].hora} às ${parsed[parsed.length-1].hora}`:'';
      const lines=[
        'Data: '+dateStr,
        'Nome: '+c.name,
        c.model+' - '+canal,
        ivStr,
        ...salesWithCom.map(s=>s.hora+' - R$ '+s.val.toFixed(2).replace('.',',')),
        'Total de comissões: R$ '+total.toFixed(2).replace('.',',')
      ].join('\n');
      allTexts.push(lines);
      const tid='gtx_elite_'+idx;
      html+=`<div class="panel" style="padding:0;overflow:hidden;border-color:var(--warn)">
        <div style="padding:10px 14px;background:var(--warn-soft);display:flex;align-items:center;justify-content:space-between">
          <div style="font-weight:700;font-size:13.5px">${c.name} <span style="font-size:11px;color:var(--warn)">⭐ ${c.model}</span></div>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-family:var(--font-mono);font-weight:800;color:var(--warn)">${money(total)}</span>
            <button class="btn btn-ghost btn-xs" onclick="gerCopyTid('${tid}')">📋 copiar</button>
          </div>
        </div>
        <pre id="${tid}" style="margin:0;padding:12px 14px;font-family:var(--font-mono);font-size:11.5px;white-space:pre-wrap;color:var(--text2);line-height:1.7">${lines}</pre>
      </div>`;
    });
  }

  window._gerAllTexts=allTexts.join('\n\n');
  renderGroup(meu,'👥 Meu time',true);

  if(allTexts.length){
    html+=`<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <button class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText(window._gerAllTexts).then(()=>toast('📋 Todos copiados!'))">📋 Copiar todos</button>
      <button class="btn btn-primary btn-sm" onclick="gerProcessarTodos()">→ Processar todos no faturamento</button>
    </div>`;
  }
  out.innerHTML=html||'<div style="color:var(--text3);font-size:13px">Nenhum resultado</div>';
}

function gerCopyTid(id){
  const el=document.getElementById(id);
  if(!el)return;
  navigator.clipboard?.writeText(el.textContent.trim()).then(()=>toast('📋 Copiado!'));
}

function gerProcessarTodos(){
  if(!window._gerAllTexts){toast('⚠️ Gere os relatórios primeiro');return;}
  const inp=document.getElementById('teamreport-input');
  if(inp)inp.value=window._gerAllTexts;
  relSwitchTab('processar');
  parseTeamReports();
  toast('✅ Todos os relatórios processados!');
}
function gerCopy(id){
  const el=document.getElementById(id);
  if(!el)return;
  navigator.clipboard.writeText(el.textContent).then(()=>toast('📋 Copiado!'));
}
function gerEnviarRelEquipe(){
  const inp=document.getElementById('teamreport-input');
  if(!inp||!window._gerAllTexts){toast('⚠️ Gere os relatórios primeiro');return;}
  inp.value=window._gerAllTexts;
  navTo('teamreports');
  parseTeamReports();
  toast('✅ Relatórios processados no Rel. Equipe!');
}

/* ===========================================================
   REL TABS (inner tabs on Relatórios view)
   =========================================================== */
function relSwitchTab(tab){
  ['gerador','editor','processar'].forEach(t=>{
    const pane=document.getElementById('relpane-'+t);
    if(pane)pane.style.display=t===tab?'block':'none';
    const btn=document.getElementById('reltab-'+t);
    if(btn)btn.classList.toggle('active',t===tab);
  });
  if(tab==='gerador')renderGerador();
}

/* ===========================================================
   GERADOR — Discord-paste approach for meu time
   =========================================================== */
// Interpret entire Discord log at once → populate meu time cards
function gerInterpretar(){
  const txt=document.getElementById('ger-discord')?.value.trim();
  if(!txt){toast('⚠️ Cole o log do Discord primeiro');return;}
  const lines=txt.split('\n').map(l=>l.trim()).filter(Boolean);
  const pairs=[];let i=0;
  while(i<lines.length){
    const cur=lines[i];const next=lines[i+1]||'';
    const hasTime=/(\d{1,2}:\d{2})/.test(cur);const hasSep=/[—–\-]/.test(cur);
    if(!hasTime&&hasSep){pairs.push({main:cur+' '+next,status:lines[i+2]||''});i+=3;}
    else if(hasSep&&/^\s*(ON|OFF)\b/i.test(next)){pairs.push({main:cur,status:next});i+=2;}
    else{i++;}
  }
  const events=[];
  for(const {main,status} of pairs){
    const ntm=main.match(/^(?:\d+\.\s*)?(.+?)\s*[—–\-]\s*(?:[^\d]*?)(\d{1,2}:\d{2})\s*$/);
    if(!ntm)continue;
    const name=ntm[1].trim().replace(/,\s*$/,'').trim();
    let time=ntm[2].padStart(5,'0');
    const modelM=status.match(/\(([^)]+)\)/);
    const model=modelM?modelM[1].trim().toUpperCase():null;
    if(!model)continue;
    const isOn=/\bON\b/i.test(status);const isOff=/\bOFF\b/i.test(status);
    const extra=/hora\s*extra|extra/i.test(status);
    const overM=status.match(/-\s*(\d{1,2}:\d{2})\s*(?:$|\b(?!\d))/);
    if(overM)time=overM[1].padStart(5,'0');
    if(!isOn&&!isOff)continue;
    events.push({name,model,time,isOn,isOff,extra});
  }
  const map={};
  for(const e of events){
    const key=e.name+'||'+e.model;
    if(!map[key])map[key]={name:e.name,model:e.model,ons:[],offs:[]};
    if(e.isOn)map[key].ons.push({time:e.time,extra:e.extra});
    if(e.isOff)map[key].offs.push({time:e.time,extra:e.extra});
  }
  const result=[];
  for(const key in map){
    const g=map[key];
    const intervals=[];
    const len=Math.max(g.ons.length,g.offs.length);
    for(let i=0;i<len;i++)
      intervals.push({s:g.ons[i]?.time||'',e:g.offs[i]?.time||'',extra:g.ons[i]?.extra||g.offs[i]?.extra||false});
    result.push({name:g.name,model:g.model,intervals});
  }
  if(!result.length){toast('⚠️ Nenhum ON/OFF encontrado — verifique o formato');return;}
  S.geradorMeu=result;
  save();renderGerMeuCards();
  toast('✅ '+result.length+' chatter'+(result.length>1?'s':'')+' interpretado'+(result.length>1?'s':''));
}
function gerCopyEditor(){
  const txt=document.getElementById('ger-editor')?.value;
  if(!txt){toast('⚠️ Nada para copiar');return;}
  navigator.clipboard?.writeText(txt).then(()=>toast('📋 Copiado!'));
}
function gerProcessarEditor(){
  const txt=document.getElementById('ger-editor')?.value.trim();
  if(!txt){toast('⚠️ Cole um relatório primeiro');return;}
  const inp=document.getElementById('teamreport-input');
  if(inp)inp.value=txt;
  parseTeamReports();
  toast('✅ Relatório processado no faturamento!');
}
function gerProcessarEditorAsExtra(){
  const txt=document.getElementById('ger-editor')?.value.trim();
  if(!txt){toast('⚠️ Cole um relatório primeiro');return;}
  const inp=document.getElementById('teamreport-input');
  if(inp)inp.value=txt;
  parseTeamReportsAsExtra();
  toast('⚡ Relatório processado como hora extra!');
}

function renderGerador(){
  // sheets
  const sh=document.getElementById('ger-sheets');
  if(sh){
    if(!S.models.length)sh.innerHTML='<div style="color:var(--text3);font-size:12.5px">Cadastre modelos na aba Equipe primeiro</div>';
    else sh.innerHTML=S.models.map(m=>{
      const key=m.name.toUpperCase();
      const n=gerSheets[key]?.length;
      return`<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">
        <div style="font-size:13.5px;font-weight:700;flex:1">${m.emoji||'🧩'} ${m.name}</div>
        <span class="pill ${n?'pill-ok':'pill-flat'}">${n?n+' linhas':'sem planilha'}</span>
        <label class="btn btn-ghost btn-xs" style="cursor:pointer">📂 subir XLSX
          <input type="file" accept=".xlsx,.xls" style="display:none" onchange="gerLoadXlsx(event,'${key}')">
        </label>
      </div>`;
    }).join('');
  }
  const canal=document.getElementById('ger-canal');
  if(canal)canal.value=S.geradorCanal||'PRIVACY FREE';
  const dt=document.getElementById('ger-data');
  if(dt&&!dt.value)dt.value=todayKey();
  renderGerMeuCards();
}

// Total de horas trabalhadas (soma dos intervalos, cuidando de virada de meia-noite)
function gerCalcTotalMinutos(intervals){
  return (intervals||[]).reduce((sum,iv)=>{
    if(!iv.s||!iv.e)return sum;
    const s=gerToMins(iv.s),e=gerToMins(iv.e);
    return sum+((e-s+1440)%1440);
  },0);
}
function gerFormatHoras(mins){
  const h=Math.floor(mins/60),m=mins%60;
  return h+'h'+(m?' '+String(m).padStart(2,'0')+'min':'');
}

function renderGerMeuCards(){
  const el=document.getElementById('ger-meu-cards');
  if(!el)return;
  const list=S.geradorMeu||[];
  if(!list.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px;padding:4px 0">Cole o log do Discord acima e clique em Interpretar</div>';return;}
  el.innerHTML=list.map((c,ci)=>{
    const mins=gerCalcTotalMinutos(c.intervals);
    const extraMins=gerCalcTotalMinutos((c.intervals||[]).filter(iv=>iv.extra));
    return `
    <div style="background:var(--bg-soft);border-radius:10px;padding:10px 14px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:13.5px">${c.name||'(sem nome)'}</div>
        <div style="font-size:11px;color:var(--text3)">${c.model||''}${extraMins?' · ⚡ '+gerFormatHoras(extraMins)+' extra':''}</div>
      </div>
      <div style="font-family:var(--font-mono);font-weight:800;color:var(--ok);font-size:13.5px;flex-shrink:0">${mins?gerFormatHoras(mins):'—'}</div>
      <button onclick="S.geradorMeu.splice(${ci},1);save();renderGerMeuCards();"
        style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:15px;flex-shrink:0">✕</button>
    </div>`;
  }).join('');
}

/* ===========================================================
   ESTUDOS — EXERCÍCIO DIÁRIO DE CRIATIVIDADE
   3 hábitos diários (resetam à meia-noite, via creativityLog[dateKey])
   + 1 desafio semanal de exploração (reseta toda semana, via
   creativityWeekly[weekKey].done) + revisão semanal (5 perguntas,
   salvas por semana, com histórico das semanas anteriores).
   =========================================================== */
const CREATIVITY_HABITS=[
  {id:'ideias',icon:'💡',freq:'Diário · 15–20 min',
    habito:'Gerar 10 ideias sobre um problema, projeto ou oportunidade. Não julgar as ideias durante a escrita.',
    objetivo:'Desenvolver fluência criativa e pensamento divergente.'},
  {id:'consumo',icon:'📖',freq:'Diário · 30 min',
    habito:'Consumir conteúdo fora da sua área (livros, artigos, documentários, podcasts, museus, ciência, história, arquitetura, arte etc.) e anotar uma conexão com seu trabalho.',
    objetivo:'Expandir repertório e criar novas associações.'},
  {id:'observacao',icon:'🔍',freq:'Diário · 10 min',
    habito:'Registrar observações: uma percepção, um problema identificado e uma ideia ou pergunta que surgiu durante o dia.',
    objetivo:'Exercitar observação e identificar oportunidades de inovação.'}
];
const CREATIVITY_CHALLENGE={icon:'🌍',freq:'Semanal · 2–4h',
  habito:'Explorar um lugar completamente novo (bairro, parque, café, exposição, trilha, biblioteca, cidade, evento, feira ou espaço cultural) sem um objetivo específico além de observar.',
  objetivo:'Romper a rotina, estimular a curiosidade e renovar perspectivas.'};
const CREATIVITY_QUESTIONS=[
  {title:'💡 Ideias',qs:['Como isso poderia ser feito pela metade do custo?','O que eu eliminaria se começasse do zero?','Como outra indústria resolveria esse problema?']},
  {title:'🔍 Observação',qs:['O que me surpreendeu hoje?','Onde encontrei uma dificuldade recorrente?','O que funcionou melhor do que eu esperava?']},
  {title:'🌍 Exploração',qs:['O que há de diferente aqui?','Que experiência chamou minha atenção?','O que posso adaptar para minha realidade?','Que ideia surgiu por estar em um ambiente diferente?']}
];
const CREATIVITY_REVIEW_QUESTIONS=[
  {id:'melhorIdeia',label:'Qual foi a melhor ideia que tive?'},
  {id:'aprendizado',label:'O que aprendi fora da minha área?'},
  {id:'padrao',label:'Que padrão comecei a perceber?'},
  {id:'lugarNovo',label:'O que o lugar novo me fez enxergar de diferente?'},
  {id:'experimento',label:'Qual experimento ou ação vou testar na próxima semana?'}
];
function toggleCreativityHabit(id){
  const dk=todayKey();
  if(!S.creativityLog[dk])S.creativityLog[dk]={};
  S.creativityLog[dk][id]=!S.creativityLog[dk][id];
  save();
  renderCreatividade();
}
function toggleCreativityChallenge(){
  const wk=getWeekKey(0); // sempre a semana calendário atual, independente de qual semana está sendo navegada em Relatório
  if(!S.creativityWeekly[wk])S.creativityWeekly[wk]={done:false,review:{}};
  S.creativityWeekly[wk].done=!S.creativityWeekly[wk].done;
  save();
  renderCreatividade();
}
function saveCreativityReview(field,val){
  const wk=getWeekKey(0);
  if(!S.creativityWeekly[wk])S.creativityWeekly[wk]={done:false,review:{}};
  if(!S.creativityWeekly[wk].review)S.creativityWeekly[wk].review={};
  S.creativityWeekly[wk].review[field]=val;
  save();
}
function toggleCreativityQuestions(){
  const body=document.getElementById('creativity-questions-body');
  const ic=document.getElementById('creativity-questions-ic');
  if(!body)return;
  const open=body.style.display!=='none';
  body.style.display=open?'none':'block';
  if(ic)ic.textContent=open?'▸':'▾';
}
function renderCreatividade(){
  const dailyEl=document.getElementById('creativity-daily');
  const chEl=document.getElementById('creativity-challenge');
  const qEl=document.getElementById('creativity-questions-body');
  const reviewEl=document.getElementById('creativity-review');
  const histEl=document.getElementById('creativity-history');
  if(!dailyEl&&!chEl&&!qEl&&!reviewEl&&!histEl)return;

  const dk=todayKey();
  const wk=getWeekKey(0);
  const dayLog=S.creativityLog[dk]||{};
  const weekEntry=S.creativityWeekly[wk]||{done:false,review:{}};

  if(dailyEl)dailyEl.innerHTML=CREATIVITY_HABITS.map(h=>{
    const done=!!dayLog[h.id];
    return`<div style="border:1px solid var(--line);border-radius:9px;padding:11px 13px;margin-bottom:9px;${done?'opacity:.65':''}">
      <div style="display:flex;align-items:flex-start;gap:9px">
        <button onclick="toggleCreativityHabit('${h.id}')" style="width:20px;height:20px;border-radius:5px;border:2px solid ${done?'var(--ok)':'var(--accent)'};background:${done?'var(--ok)':'transparent'};cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;margin-top:1px">${done?'<span style="color:#fff">✓</span>':''}</button>
        <div style="flex:1;min-width:0">
          <div style="font-size:10.5px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.03em;margin-bottom:3px">${h.icon} ${h.freq}</div>
          <div style="font-size:13.5px;font-weight:600;${done?'text-decoration:line-through;color:var(--text3)':''};margin-bottom:4px">${h.habito}</div>
          <div style="font-size:11.5px;color:var(--text3)">🎯 ${h.objetivo}</div>
        </div>
      </div>
    </div>`;
  }).join('');

  if(chEl){
    const chDone=!!weekEntry.done;
    chEl.innerHTML=`<div style="border:2px solid ${chDone?'var(--ok)':'var(--accent)'};background:${chDone?'var(--ok-soft)':'var(--accent-soft)'};border-radius:9px;padding:11px 13px">
      <div style="display:flex;align-items:flex-start;gap:9px">
        <button onclick="toggleCreativityChallenge()" style="width:20px;height:20px;border-radius:5px;border:2px solid ${chDone?'var(--ok)':'var(--accent)'};background:${chDone?'var(--ok)':'transparent'};cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;margin-top:1px">${chDone?'<span style="color:#fff">✓</span>':''}</button>
        <div style="flex:1;min-width:0">
          <div style="font-size:10.5px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.03em;margin-bottom:3px">${CREATIVITY_CHALLENGE.icon} Desafio da semana · ${CREATIVITY_CHALLENGE.freq}</div>
          <div style="font-size:13.5px;font-weight:600;${chDone?'text-decoration:line-through;color:var(--text3)':''};margin-bottom:4px">${CREATIVITY_CHALLENGE.habito}</div>
          <div style="font-size:11.5px;color:var(--text3)">🎯 ${CREATIVITY_CHALLENGE.objetivo}</div>
        </div>
      </div>
    </div>`;
  }

  if(qEl)qEl.innerHTML=CREATIVITY_QUESTIONS.map(g=>`
    <div style="margin-bottom:10px">
      <div style="font-size:12px;font-weight:700;margin-bottom:4px">${g.title}</div>
      ${g.qs.map(q=>`<div style="font-size:12.5px;color:var(--text2);padding:3px 0 3px 8px;border-left:2px solid var(--line);margin-bottom:2px">${q}</div>`).join('')}
    </div>`).join('');

  if(reviewEl){
    const review=weekEntry.review||{};
    reviewEl.innerHTML=CREATIVITY_REVIEW_QUESTIONS.map(q=>`
      <div class="field">
        <label class="flabel">${q.label}</label>
        <textarea class="ftext" style="min-height:44px" onblur="saveCreativityReview('${q.id}',this.value)">${review[q.id]||''}</textarea>
      </div>`).join('');
  }

  if(histEl){
    const weeks=Object.keys(S.creativityWeekly).filter(w=>w!==wk).sort((a,b)=>b.localeCompare(a));
    const rows=weeks.map(w=>{
      const entry=S.creativityWeekly[w]||{};
      const r=entry.review||{};
      const answered=CREATIVITY_REVIEW_QUESTIONS.filter(q=>r[q.id]);
      if(!answered.length&&!entry.done)return'';
      const wkLabel=w.split('-').reverse().join('/');
      return`<div style="margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--line)">
        <div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:6px">Semana de ${wkLabel}${entry.done?' · 🌍 desafio cumprido':''}</div>
        ${answered.map(q=>`<div style="font-size:12px;margin-bottom:5px"><span style="color:var(--text3)">${q.label}</span><br>${r[q.id]}</div>`).join('')}
      </div>`;
    }).filter(Boolean);
    histEl.innerHTML=rows.length?rows.join(''):'<div style="color:var(--text3);font-size:12px">Sem semanas anteriores registradas ainda.</div>';
  }
}

/* ===========================================================
   ESTUDOS — O QUE MELHORAR
   =========================================================== */
function renderMelhoras(){
  const el=document.getElementById('melhoras-list');
  if(!el)return;
  const wk=getWeekKey();
  // Prune done items from previous weeks
  S.melhoras=S.melhoras.filter(m=>!m.done||m.doneWeek===wk);
  if(!S.melhoras.length){
    el.innerHTML='<div style="color:var(--text3);font-size:12.5px;padding:6px 0">Clique em + adicionar para criar um item</div>';return;
  }
  el.innerHTML=S.melhoras.map(m=>`
    <div style="border:1px solid var(--line);border-radius:9px;padding:11px 13px;margin-bottom:9px;${m.done?'opacity:.6':''}">
      <div style="display:flex;align-items:flex-start;gap:9px">
        <button onclick="toggleMelhora('${m.id}')" style="width:20px;height:20px;border-radius:5px;border:2px solid ${m.done?'var(--ok)':'var(--accent)'};background:${m.done?'var(--ok)':'transparent'};cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;margin-top:1px">${m.done?'<span style="color:#fff">✓</span>':''}</button>
        <div style="flex:1;min-width:0">
          <div style="font-size:13.5px;font-weight:700;${m.done?'text-decoration:line-through;color:var(--text3)':''};margin-bottom:5px">${m.text}</div>
          <textarea class="ftext" style="min-height:46px;font-size:12.5px;${m.done?'opacity:.5':''}" placeholder="Como melhorar..."
            onblur="saveMelhoraHow('${m.id}',this.value)">${m.how||''}</textarea>
        </div>
        <button onclick="removeMelhora('${m.id}')" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:13px;flex-shrink:0">✕</button>
      </div>
    </div>`).join('');
}

// Modal for adding melhora
function addMelhora(){
  const text=prompt('O que melhorar?');
  if(!text?.trim())return;
  S.melhoras.push({id:'ml'+Date.now(),text:text.trim(),how:'',done:false,doneWeek:null,createdWeek:getWeekKey()});
  save();renderMelhoras();
}
function toggleMelhora(id){
  const m=S.melhoras.find(x=>x.id===id);
  if(!m)return;
  m.done=!m.done;
  m.doneWeek=m.done?getWeekKey():null;
  // When marking done, auto-save snapshot entry
  if(m.done) gerMelhoraSnapshot(m);
  save();renderMelhoras();
}
function removeMelhora(id){
  S.melhoras=S.melhoras.filter(x=>x.id!==id);
  save();renderMelhoras();
}
function saveMelhoraHow(id,val){
  const m=S.melhoras.find(x=>x.id===id);
  if(m){m.how=val;save();}
}
function gerMelhoraSnapshot(melhora){
  // Save to melhoraHistory for the personal evolution log
  if(!S.melhoraHistory)S.melhoraHistory=[];
  const wk=getWeekKey();
  let entry=S.melhoraHistory.find(e=>e.week===wk);
  if(!entry){entry={week:wk,items:[]};S.melhoraHistory.push(entry);}
  if(!entry.items.find(x=>x.id===melhora.id)){
    entry.items.push({id:melhora.id,text:melhora.text,how:melhora.how,doneDate:todayKey()});
  }
}

function renderEstudosHistorico(){
  const el=document.getElementById('estudos-historico');
  if(!el)return;
  const hist=S.melhoraHistory||[];
  if(!hist.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Histórico vazio — marque itens como concluídos para registrar a evolução</div>';return;}
  el.innerHTML=[...hist].reverse().map(entry=>`
    <div style="margin-bottom:14px">
      <div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:6px">Semana de ${entry.week}</div>
      ${entry.items.map(it=>`
        <div style="display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px solid var(--line)">
          <span style="color:var(--ok);font-size:13px;flex-shrink:0">✅</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600">${it.text}</div>
            ${it.how?`<div style="font-size:12px;color:var(--text2);margin-top:2px">↳ ${it.how}</div>`:''}
            <div style="font-size:10.5px;color:var(--text3);margin-top:2px">${it.doneDate}</div>
          </div>
        </div>`).join('')}
    </div>`).join('');
}

function renderEstudos(){
  renderCreatividade();
  renderMelhoras();
  renderStudyList();
  renderEstudosHistorico();
}

function renderEstrategia(){
  // A pedido da gestora, a aba Estratégia mostra só Estratégias de Liderança
  // e Diagnóstico da equipe — Prioridades do dia, Gargalos, aviso de medalha
  // e Conselheiro Executivo saíram desta tela (funções continuam existindo,
  // só não são mais chamadas/exibidas aqui).
  renderLiderancaEstrategica();
  renderEstrategiaDiagnostico();
}

/* ===========================================================
   CONSELHEIRO EXECUTIVO (IA discreta)
   =========================================================== */
function toggleConselheiro(){
  const body=document.getElementById('conselheiro-body');
  const ic=document.getElementById('conselheiro-ic');
  if(!body)return;
  const wasOpen=body.style.display!=='none';
  body.style.display=wasOpen?'none':'block';
  if(ic)ic.textContent=wasOpen?'▸':'▾';
  // Ao abrir (não ao fechar), gera a leitura da semana automaticamente se
  // ainda não tiver uma pra semana atual — assim ela já encontra pronto,
  // sem precisar clicar em nada; gerarConselheiroSemanal já checa o cache
  // internamente e não gasta cota de IA à toa se já gerou essa semana.
  if(!wasOpen)gerarConselheiroSemanal(false);
}

const CONSELHEIRO_SYSTEM=`Você é meu Conselheiro Executivo de Liderança.

Seu único objetivo é transformar minha equipe em uma equipe de alta performance enquanto me desenvolve como uma líder respeitada, admirada e capaz de extrair o máximo potencial de cada pessoa.

Você atua como uma combinação de: CEO experiente, Diretora de Operações, Psicóloga Organizacional, Coach Executivo, Especialista em Comunicação Persuasiva, Negociação, Gestão de Conflitos, Motivação, Performance, Feedback e Construção de Autoridade.

Antes de responder, analise: personalidade, interesses, motivações, inseguranças, ego, objetivos, maturidade, inteligência emocional, perfil comportamental, cultura da equipe, impacto de curto e longo prazo.

Sempre responda com esta estrutura:
## Diagnóstico — O que realmente está acontecendo?
## Causas — Por que isso aconteceu?
## Riscos — O que pode acontecer se nada mudar?
## Estratégia — Qual a melhor forma de agir?
## Plano de ação — Passo a passo.
## Comunicação — Escreva exatamente o que devo dizer (quando necessário).
## Erros a evitar — Principais erros que piorariam a situação.
## Princípio de liderança — Qual princípio sustenta sua recomendação.

Desafie minhas decisões. Se eu estiver errada, diga. Se minha decisão for emocional, aponte. Se houver alternativa melhor, apresente. Seu compromisso é com a eficácia, não com concordar comigo.

Seja direto, estratégico e nunca superficial.`;

async function rodarConselheiro(){
  const inp=document.getElementById('conselheiro-input');
  const out=document.getElementById('conselheiro-out');
  const btn=document.getElementById('conselheiro-btn');
  const text=inp?.value.trim();
  if(!text){toast('⚠️ Descreva a situação');return;}
  btn.disabled=true;btn.textContent='Consultando…';
  out.innerHTML='<div style="color:var(--text2);font-size:12.5px;padding:10px 0">⏳ Analisando…</div>';
  try{
    // Antes o Conselheiro só via o texto digitado, sem nenhum dado real do
    // app — agora manda junto o mesmo contexto operacional (faturamento,
    // ChatLab, Métricas, tarefas de Liderança pendentes) que o "Pergunte à
    // IA" usa, pra análise vir baseada nos números reais da equipe, não só
    // na descrição da gestora.
    const contexto=buildOperationalContext();
    const prompt=`DADOS REAIS DA OPERAÇÃO (gerados automaticamente pelo sistema — use isso pra fundamentar sua análise, não invente números):\n\n${contexto}\n\nSITUAÇÃO DESCRITA PELA GESTORA:\n${text}`;
    const reply=await clFetchAI(CONSELHEIRO_SYSTEM,prompt,3500);
    if(!reply)throw new Error('Resposta vazia');
    out.innerHTML=`<div style="border-top:1px solid var(--line);padding-top:12px;margin-top:4px">${clMd(reply)}</div>`;
  }catch(err){
    if(err.quota){renderAIWaitCountdown('conselheiro-out',err.waitSeconds,{prefix:'⏳ Limite de uso da IA',panel:true});}
    else out.innerHTML=`<div style="color:var(--bad);font-size:12.5px">❌ ${err.message}</div>`;
  }finally{
    btn.disabled=false;btn.textContent='💬 Consultar';
  }
}

/* ---------- Leitura semanal automática (dados reais, sem precisar pedir) ---------- */
const CONSELHEIRO_SEMANAL_SYSTEM=`Você é o Conselheiro Executivo de Liderança da Mia, gestora de uma equipe de chatters. Toda semana você faz uma leitura proativa e direta dos dados reais da operação (fornecidos abaixo) para ela não precisar garimpar número por número sozinha.

Responda SEMPRE com esta estrutura curta (markdown simples, direto, sem enrolação, sem elogio genérico):
## 🟢 Quem está bem e por quê
## 🔴 Quem está em risco e por quê (com o número que prova isso)
## 🎯 As 2-3 ações mais importantes desta semana

Baseie-se SOMENTE nos dados fornecidos — nunca invente número. Seja específico (cite nomes e valores reais), honesto mesmo quando a notícia é ruim, e priorize o que realmente importa agora em vez de listar tudo.`;

async function gerarConselheiroSemanal(force){
  const wkey=getWeekKey(0);
  if(!force&&S.conselheiroSemanal?.wkey===wkey&&S.conselheiroSemanal?.text){
    renderConselheiroSemanal();
    return;
  }
  const el=document.getElementById('conselheiro-semanal');
  if(el)el.innerHTML='<div style="color:var(--text2);font-size:12.5px;padding:6px 0">⏳ Lendo a semana…</div>';
  try{
    const contexto=buildOperationalContext();
    const text=await clFetchAI(CONSELHEIRO_SEMANAL_SYSTEM,`DADOS DA SEMANA:\n\n${contexto}`,2500);
    if(!text)throw new Error('Resposta vazia');
    S.conselheiroSemanal={wkey,text,generatedAt:new Date().toISOString()};
    save();
  }catch(err){
    if(err.quota){renderAIWaitCountdown('conselheiro-semanal',err.waitSeconds,{prefix:'⏳ Leitura da semana — limite de uso da IA',panel:true});return;}
    if(el)el.innerHTML=`<div style="color:var(--bad);font-size:12.5px">❌ ${err.message}</div>`;
    return;
  }
  renderConselheiroSemanal();
}
function renderConselheiroSemanal(){
  const el=document.getElementById('conselheiro-semanal');
  if(!el)return;
  const cs=S.conselheiroSemanal;
  const wkey=getWeekKey(0);
  if(!cs?.text||cs.wkey!==wkey){
    el.innerHTML=`<div style="color:var(--text3);font-size:12.5px;padding:4px 0 8px">Ainda sem leitura desta semana.</div>`;
    return;
  }
  el.innerHTML=`<div style="font-size:10.5px;color:var(--text3);margin-bottom:6px">Gerado ${new Date(cs.generatedAt).toLocaleDateString('pt-BR')} às ${new Date(cs.generatedAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</div>${clMd(cs.text)}`;
}

/* ---------- Apoio pessoal (separado do lado de negócio de propósito) ----------
   Espaço pra Mia escrever como ELA está, não como a equipe está. Não injeta
   nenhum dado da operação aqui — só o texto dela. O prompt é deliberadamente
   acolhedor e nunca clínico: valida o que ela sente sem fingir ser terapeuta,
   nunca dá diagnóstico, sempre reforça descanso real e apoio humano/profissional
   pra assuntos pesados (luto, saúde, relação), e nunca reforça autocrítica. */
const CONSELHEIRO_PESSOAL_SYSTEM=`Você é um espaço de apoio para uma gestora de equipe que está sob muita pressão — não um terapeuta, não um médico, e você deixa isso claro se for relevante, sem ser repetitivo.

Seu papel: ouvir de verdade, validar o que ela está sentindo sem minimizar nem exagerar, ajudar a organizar o que está pesando, e devolver perspectiva com gentileza e honestidade — nunca com clichês vazios tipo "vai ficar tudo bem".

Regras importantes:
- Nunca dê diagnóstico psicológico ou médico. Nunca prescreva ou sugira medicação.
- Nunca reforce autocrítica negativa ("você é uma líder ruim", etc) — se ela disser isso de si mesma, questione gentilmente em vez de concordar.
- Sempre que fizer sentido, incentive descanso real (não produtividade disfarçada de descanso) e apoio humano de verdade — terapia, um médico, uma amiga, família — especialmente para assuntos como luto, saúde de um familiar, dor de relação ou exaustão prolongada. Faça isso de forma natural, uma vez, não repetidamente.
- Se em algum momento houver qualquer sinal de risco à vida ou de autolesão, pare o tom normal imediatamente e, com calma e sem alarme, incentive contato com um profissional ou o CVV (188, ligação e chat, 24h) — sem fazer diagnóstico e sem prometer confidencialidade que não pode garantir.
- Nunca minimize dizendo que "é só cansaço" quando ela descreve algo mais sério — mas também não catastrofize.
- Seja breve. Isso é uma conversa, não um artigo.

Responda em português, em tom pessoal e caloroso, sem formatação de markdown pesada (nada de títulos ## ou listas longas) — como uma pessoa de confiança escrevendo de volta.`;

async function conversarConselheiroPessoal(){
  const inp=document.getElementById('conselheiro-pessoal-input');
  const out=document.getElementById('conselheiro-pessoal-out');
  const btn=document.getElementById('conselheiro-pessoal-btn');
  const text=inp?.value.trim();
  if(!text){toast('⚠️ Escreva o que está sentindo/pensando');return;}
  btn.disabled=true;btn.textContent='…';
  out.innerHTML='<div style="color:var(--text2);font-size:12.5px;padding:8px 0">⏳ Lendo com calma…</div>';
  try{
    const reply=await clFetchAI(CONSELHEIRO_PESSOAL_SYSTEM,text,1800);
    if(!reply)throw new Error('Resposta vazia');
    out.innerHTML=`<div style="border-top:1px solid var(--line);padding-top:10px;margin-top:4px;white-space:pre-wrap">${clMd(reply)}</div>`;
    if(!S.conselheiroPessoal)S.conselheiroPessoal=[];
    S.conselheiroPessoal.unshift({id:'cp'+Date.now(),date:todayKey(),texto:text,resposta:reply});
    S.conselheiroPessoal=S.conselheiroPessoal.slice(0,20);
    save();
    inp.value='';
    renderConselheiroPessoalHistorico();
  }catch(err){
    if(err.quota){renderAIWaitCountdown('conselheiro-pessoal-out',err.waitSeconds,{prefix:'⏳ Limite de uso da IA',panel:true});}
    else out.innerHTML=`<div style="color:var(--bad);font-size:12.5px">❌ ${err.message}</div>`;
  }finally{
    btn.disabled=false;btn.textContent='💙 Conversar';
  }
}
function renderConselheiroPessoalHistorico(){
  const el=document.getElementById('conselheiro-pessoal-historico');
  if(!el)return;
  const hist=S.conselheiroPessoal||[];
  if(!hist.length){el.innerHTML='';return;}
  el.innerHTML=`<div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;margin:14px 0 6px">Conversas anteriores</div>`+
    hist.slice(0,10).map(h=>`<details style="margin-bottom:6px">
      <summary style="cursor:pointer;font-size:12px;color:var(--text2)">${h.date} — ${h.texto.length>60?h.texto.slice(0,60)+'…':h.texto}</summary>
      <div style="padding:8px 0 0 4px;white-space:pre-wrap">${clMd(h.resposta)}</div>
    </details>`).join('');
}

/* ===========================================================
   PERGUNTE À IA — painel global (acessível de qualquer tela) que
   responde perguntas livres do gestor sobre a operação, com base
   em dados REAIS extraídos do estado do app (faturamento, hora
   extra, pagamento, metas, faltas, mapeamento de perfil). Os
   valores financeiros já vêm calculados pelas MESMAS funções
   usadas na tela de Pagamento (calcChatterPagamento) — a IA só
   interpreta/compara, nunca refaz conta financeira sozinha.
   =========================================================== */
function buildOperationalContext(){
  const wkey=getWeekKey(0);
  const wd=getWeekDates(0);
  const lines=[];
  lines.push(`Semana atual: ${fmt(wd[0])} a ${fmt(wd[6])} (chave ${wkey}). Hoje: ${todayKey()}.`);

  const ativos=S.chatters.filter(c=>c.time!=='tester'&&!isChatterTerminated(c));
  lines.push(`\nEQUIPE ATIVA (${ativos.length} pessoas), faturamento e pagamento desta semana:`);
  ativos.forEach(c=>{
    const fat=getChatterWeekRevenue(c.id,0);
    const extraFat=getChatterExtraRevenue(c.id,0);
    const {htTotal,avgHtPct}=getChatterWeekHighTicket(c.id,0);
    const cat=S.chatterFichas?.[c.id]?.pagCategoria||'B';
    const manualMedalRaw=S.chatterFichas?.[c.id]?.manualMedal;
    const catInfo=PAG_CATS[cat]||PAG_CATS.B;
    const statsCtx=getChatterMonthStats(c.id);
    const autoMedal=autoMedalForChatter(c.id,cat,statsCtx.monthRevenue+statsCtx.monthExtra);
    const medal=(manualMedalRaw!==undefined&&manualMedalRaw!=='')?parseInt(manualMedalRaw,10):autoMedal;
    const metaManual=parseFloat((S.chatterWeekGoals[wkey]||{})[c.id])||0;
    const real=calcChatterPagamento(fat,medal,cat,htTotal,extraFat,metaManual);
    // Cenário hipotético: e se a hora extra contasse como faturamento normal
    // pra fins de comissão E de meta (em vez de virar um bônus de 10% à parte)?
    const hipotetico=calcChatterPagamento(fat+extraFat,medal,cat,htTotal,0,metaManual);
    const diff=hipotetico.total-real.total;
    lines.push(`- ${c.name} (nível ${c.level}, categoria pagamento ${cat}, medalha ${medal}): `+
      `faturamento normal da escala R$${fat.toFixed(2)}; hora extra (cobertura de folga em modelo extra) R$${extraFat.toFixed(2)}; `+
      `high ticket ${avgHtPct}% (R$${htTotal.toFixed(2)}); meta semanal ${metaManual>0?'R$'+metaManual.toFixed(2)+' (customizada)':'R$'+catInfo.n100.toFixed(2)+' (padrão da categoria '+cat+')'}. `+
      `GANHO REAL essa semana = comissão R$${real.comissao.toFixed(2)} + prêmio de meta R$${real.premio.toFixed(2)} + bônus high ticket R$${real.htBonus.toFixed(2)} + bônus hora extra (10%) R$${real.extraBonus.toFixed(2)} = TOTAL R$${real.total.toFixed(2)}. `+
      `CENÁRIO HIPOTÉTICO se a hora extra contasse como faturamento normal (pra comissão e pra destravar os degraus da meta, em vez do bônus de 10% à parte) = TOTAL R$${hipotetico.total.toFixed(2)} (diferença de R$${diff.toFixed(2)} ${diff>0?'a mais':diff<0?'a menos':'igual'} em relação ao real).`);
  });

  const absencesWeek=getWeekAbsencesData();
  lines.push(`\nFALTAS registradas esta semana: ${absencesWeek.length}.`);
  if(absencesWeek.length){
    absencesWeek.forEach(a=>{
      const c=S.chatters.find(ch=>ch.id===a.chatterId);
      lines.push(`- ${c?c.name:'?'} faltou em ${a.date}${a.reason?' ('+a.reason+')':''}`);
    });
  }

  const teamGoals=S.weekGoals[wkey]||[];
  if(teamGoals.length){
    lines.push(`\nOBJETIVOS DO TIME nesta semana:`);
    teamGoals.forEach(g=>{
      if(g.type==='simples')lines.push(`- ${g.text} — ${g.done?'concluído':'em aberto'}`);
      else lines.push(`- ${g.text} — ${g.current}/${g.target} (${g.target>0?Math.round(g.current/g.target*100):0}%)`);
    });
  }

  const comMapeamento=ativos.filter(c=>S.chatterFichas?.[c.id]?.mapeamentoIA);
  if(comMapeamento.length){
    lines.push(`\nPERFIL (Mapeamento de Performance por IA) de quem já foi mapeado:`);
    comMapeamento.forEach(c=>{
      const m=S.chatterFichas[c.id].mapeamentoIA;
      const perfis=(m.perfis||[]).map(p=>`${p.tipo} ${p.pct}%`).join('/');
      lines.push(`- ${c.name}: perfil ${perfis||'-'}; motivadores: ${(m.motivadores||[]).join(', ')||'-'}; como motivar: ${m.comoMotivar||'-'}; o que não fazer: ${m.oQueNaoFazer||'-'}`);
    });
  }

  // FICHA: observações qualitativas que o gestor vai preenchendo na ficha de
  // cada chatter (técnica, comportamento, potencial/risco, mapeamento manual
  // de perfil, anotações livres). Antes disso a IA só via os números — agora
  // ela também enxerga o que o gestor escreveu sobre cada pessoa.
  const comFicha=[];
  ativos.forEach(c=>{
    const f=S.chatterFichas?.[c.id];
    if(!f)return;
    const parts=[];
    const addField=(store,key,label)=>{const v=f[store]&&f[store][key];if(v&&String(v).trim())parts.push(`${label}: ${String(v).trim()}`);};
    addField('tech','conversao','Conversão');addField('tech','ticket','Ticket médio');addField('tech','resposta','Tempo de resposta');addField('tech','evolucao','Evolução técnica');
    addField('behavior','intensidade','Intensidade');addField('behavior','comunicacao','Comunicação');addField('behavior','comprometimento','Comprometimento');addField('behavior','energia','Energia');
    addField('potential','potencial','Potencial');addField('potential','proximos','Próximos passos');
    addField('risk','riscos','Riscos');
    addField('mapeamento','resumo','Resumo');addField('mapeamento','motivacao','Motivação');addField('mapeamento','comoLiderar','Como liderar');addField('mapeamento','naoFazer','O que não fazer');
    addField('obs','obs','Anotações livres');
    if(f.mapeamento&&f.mapeamento.perfil)parts.push(`Perfil de liderança: ${f.mapeamento.perfil}`);
    if(parts.length)comFicha.push(`- ${c.name}: ${parts.join(' | ')}`);
  });
  if(comFicha.length){
    lines.push(`\nFICHA (observações qualitativas registradas pelo gestor sobre cada chatter):`);
    comFicha.forEach(l=>lines.push(l));
  }

  // OBSERVAÇÕES DE CHAT: checklist diário (chamou pelo nome, respondeu não
  // lidas, tempo de resposta, checou conversão, analisou conversa) + nota
  // livre do dia, feito na Ficha de cada chatter.
  const weekDateKeys=wd.map(d=>fmt(d));
  const comChatObs=[];
  ativos.forEach(c=>{
    const co=S.chatObservacoes?.[c.id];
    if(!co)return;
    const entries=weekDateKeys.filter(dk=>co[dk]).map(dk=>{
      const e=co[dk];
      const checks=CHAT_OBS_ITEMS.filter(([k])=>e[k]).map(([,label])=>label);
      return `${dk}${checks.length?' ('+checks.join(', ')+')':' (nenhum item marcado ainda)'}${e.anotacao&&e.anotacao.trim()?' — nota: '+e.anotacao.trim():''}`;
    });
    if(entries.length)comChatObs.push(`- ${c.name}: ${entries.join('; ')}`);
  });
  if(comChatObs.length){
    lines.push(`\nOBSERVAÇÕES DE CHAT (checklist diário de acompanhamento) desta semana:`);
    comChatObs.forEach(l=>lines.push(l));
  }

  // MÉTRICAS: ranking de crescimento de faturamento (matemática pura, já
  // calculada em buildMetricasData — a IA só interpreta, nunca refaz conta)
  // + Índice de Desempenho (ID) já ponderado. Dá pra IA a visão "quem está
  // melhorando/piorando essa semana vs a passada", que é exatamente o tipo
  // de pergunta que a gestora mais faz ao Conselheiro.
  try{
    const md=buildMetricasData(0);
    if(md.perChatter.length){
      lines.push(`\nMÉTRICAS — comparação com a semana anterior (faturamento normal + hora extra, já somados) e Índice de Desempenho (ID, 0-100, combina performance de meta + crescimento + qualidade do ChatLab + consistência):`);
      [...md.perChatter].sort((a,b)=>(b.variacao??-999)-(a.variacao??-999)).forEach(p=>{
        lines.push(`- ${p.c.name} (${p.cargo}): R$${p.fatAtual.toFixed(2)} essa semana vs R$${p.fatAnterior.toFixed(2)} semana passada (variação ${p.variacao==null?'sem base de comparação':(p.variacao>0?'+':'')+p.variacao+'%'}); ID geral ${p.idGeral??'—'}${p.clMetrics.avgIGP!=null?`; IGP médio do ChatLab essa semana ${p.clMetrics.avgIGP}`:''}${p.clMetrics.taxaConversao!=null?`; conversão ${p.clMetrics.taxaConversao}%`:''}.`);
      });
    }
  }catch(e){/* Métricas pode não estar carregada ainda em algum fluxo — não quebra o contexto por isso */}

  // CHATLAB: diagnóstico objetivo por chatter (maiores erros e sinais de
  // whale da semana), extraído do mesmo campo .tags que cada análise salva —
  // não é uma chamada nova de IA, só agregação do que já foi analisado.
  const comChatlabSemana=[];
  ativos.forEach(c=>{
    const analises=coletarAnalisesDaSemana(c.id,0);
    if(!analises.length)return;
    const m=calcMetricasSemana(analises);
    const erros={};
    analises.forEach(a=>{if(a.tags?.principalErro)erros[a.tags.principalErro]=(erros[a.tags.principalErro]||0)+1;});
    const topErros=Object.entries(erros).sort((a,b)=>b[1]-a[1]).slice(0,2).map(([e,n])=>`${e} (${n}x)`).join(', ');
    comChatlabSemana.push(`- ${c.name}: ${analises.length} conversa(s) analisada(s), IGP médio ${m.avgIGP??'—'}, conversão ${m.taxaConversao??'—'}%${topErros?`, erros mais comuns: ${topErros}`:''}${m.whaleCount?`, ${m.whaleCount} sinal(is) de whale`:''}.`);
  });
  if(comChatlabSemana.length){
    lines.push(`\nCHATLAB — diagnóstico de atendimento desta semana (agregado das análises já feitas, sem nova chamada de IA):`);
    comChatlabSemana.forEach(l=>lines.push(l));
  }

  // ESTRATÉGIAS DE LIDERANÇA: tarefas que a própria gestora já se comprometeu
  // a fazer (quadro editável em Gestão) e ainda não marcou como feitas —
  // contexto importante pra IA não sugerir algo que ela já decidiu fazer,
  // ou cobrar se ela ainda não fez.
  const lidPendentes=(S.liderancaEstrategias||[]).filter(t=>!t.done);
  if(lidPendentes.length){
    const catLabel={imediato:'Imediato (essa semana)',curto:'Curto prazo (próximas 2 semanas)',medio:'Médio prazo (esse mês)',estrutural:'Estrutural (sempre)'};
    lines.push(`\nESTRATÉGIAS DE LIDERANÇA — ações que a gestora já se comprometeu a fazer e ainda estão pendentes:`);
    lidPendentes.forEach(t=>lines.push(`- [${catLabel[t.categoria]||t.categoria}] ${t.texto}`));
  }

  return lines.join('\n');
}

const IA_PERGUNTA_SYSTEM=`Você é um analista de operação sênior de uma agência de chatters (atendimento/vendas). Você responde perguntas objetivas do gestor com base SOMENTE nos dados fornecidos no contexto abaixo.

Os valores financeiros já vêm CALCULADOS pelas regras reais do sistema de pagamento da empresa (comissão por categoria, prêmio de meta com degraus 70/85/100% e boost por superar a meta, bônus de high ticket 8%, bônus de hora extra 10%). Nunca refaça contas do zero nem invente fórmulas novas — apenas leia, compare e interprete os números já calculados que estão no contexto.

Se a pergunta pedir algo que não está disponível nos dados fornecidos, diga claramente que essa informação não está disponível no contexto atual, não invente números.

Responda em português, direto e objetivo, em markdown simples (pode usar **negrito** e listas curtas), sem enrolação.`;

async function perguntarIA(){
  const input=document.getElementById('ia-pergunta-input');
  const question=(input?input.value:'').trim();
  if(!question){toast('Digite uma pergunta antes.');return;}
  const btn=document.getElementById('ia-pergunta-btn');
  const out=document.getElementById('ia-pergunta-resposta');
  if(btn){btn.disabled=true;btn.textContent='🤖 Analisando...';}
  if(out)out.innerHTML='<div style="color:var(--text3);font-size:12.5px">Consultando os dados da operação...</div>';
  try{
    const contexto=buildOperationalContext();
    const prompt=`DADOS DA OPERAÇÃO (gerados automaticamente pelo sistema):\n\n${contexto}\n\nPERGUNTA DO GESTOR:\n${question}`;
    const res=await fetch(AI_PROXY_URL,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:3000,system:IA_PERGUNTA_SYSTEM,messages:[{role:'user',content:prompt}]})
    });
    const data=await res.json();
    const text=data.content?.map(b=>b.type==='text'?b.text:'').join('')||'';
    if(!text)throw new Error(data.error?.message||'Resposta vazia da IA');
    if(out)out.innerHTML=`<div style="border-top:1px solid var(--line);padding-top:12px;margin-top:4px">${clMd(text)}</div>`;
    if(!S.iaPerguntas)S.iaPerguntas=[];
    S.iaPerguntas.unshift({id:'iaq'+Date.now(),date:todayKey(),question,answer:text});
    S.iaPerguntas=S.iaPerguntas.slice(0,30);
    save();
    renderIaPerguntaHistorico();
  }catch(e){
    console.error('Erro ao perguntar à IA',e);
    if(out)out.innerHTML=`<div style="color:var(--bad);font-size:12.5px">❌ ${e.message}</div>`;
  }finally{
    if(btn){btn.disabled=false;btn.textContent='🤖 Perguntar';}
  }
}

function renderIaPerguntaHistorico(){
  const el=document.getElementById('ia-pergunta-historico');
  if(!el)return;
  const hist=S.iaPerguntas||[];
  if(!hist.length){el.innerHTML='';return;}
  el.innerHTML=`<div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;margin-bottom:6px">Perguntas anteriores</div>`+
    hist.slice(0,10).map(h=>`<details style="margin-bottom:6px">
      <summary style="cursor:pointer;font-size:12px;color:var(--text2)">${h.date} — ${h.question.length>70?h.question.slice(0,70)+'…':h.question}</summary>
      <div style="padding:8px 0 0 4px">${clMd(h.answer)}</div>
    </details>`).join('');
}

/* ===========================================================
   GERADOR — ELITE TEAM (vendas brutas → comissões subtraídas)
   =========================================================== */
function gerAddElite(){
  S.geradorElite.push({name:'',model:S.models[0]?.name.toUpperCase()||'',salesRaw:''});
  save();renderGerEliteCards();
}
function renderGerEliteCards(){
  const el=document.getElementById('ger-elite-cards');
  if(!el)return;
  const list=S.geradorElite||[];
  if(!list.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px;padding:4px 0">Nenhum chatter Elite — use o botão + acima</div>';return;}
  el.innerHTML=list.map((c,ci)=>`
    <div style="background:var(--warn-soft);border:1px solid rgba(154,91,0,.2);border-radius:10px;padding:12px;margin-bottom:10px">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <input class="finput" style="flex:2" placeholder="Nome do chatter Elite" value="${c.name||''}"
          onblur="S.geradorElite[${ci}].name=this.value;save();">
        <select class="fselect" style="flex:1" onchange="S.geradorElite[${ci}].model=this.value;save();">
          ${S.models.map(m=>`<option value="${m.name.toUpperCase()}" ${(c.model||'')===(m.name.toUpperCase())?'selected':''}>${m.name}</option>`).join('')}
        </select>
        <button onclick="S.geradorElite.splice(${ci},1);save();renderGerEliteCards();"
          style="background:none;border:none;color:var(--bad);cursor:pointer;font-size:16px">✕</button>
      </div>
      <label class="flabel">Vendas brutas com horário</label>
      <textarea class="ftext" style="min-height:80px;font-size:12px;font-family:var(--font-mono)"
        placeholder="HH:MM - R$ XX,XX&#10;Ex:&#10;01:23 - R$ 150,00&#10;03:45 - R$ 280,00&#10;Ou cole direto do Privacy"
        onblur="S.geradorElite[${ci}].salesRaw=this.value;save();">${c.salesRaw||''}</textarea>
    </div>`).join('');
}

function parseEliteSales(raw){
  // Parse lines like "01:23 - R$ 150,00" or "01:23 R$150,00"
  const sales=[];
  (raw||'').split('\n').forEach(line=>{
    const m=line.match(/(\d{1,2}:\d{2})\s*[-–]?\s*R\$\s*([\d.,]+)/i);
    if(!m)return;
    const hora=m[1].padStart(5,'0');
    const val=parseFloat(m[2].replace(/\./g,'').replace(',','.'));
    if(val>0)sales.push({hora,bruto:val});
  });
  return sales;
}

// Get commission rate from sheet (if available) or fallback
function gerGetComissao(hora,modelKey,bruto){
  const sheet=gerSheets[modelKey];
  if(!sheet)return null;
  // Look for matching sale by hora and bruto in sheet
  for(const row of sheet){
    const h=(row['Hora']||'').toString().substring(0,5);
    if(h===hora){
      const com=parseFloat(row['Sua comissão']||0);
      if(com>0)return com;
    }
  }
  // Fallback: use % from sheet average if no exact match
  const valid=['Chat','Mimo - Chat'];
  let totalBruto=0,totalCom=0;
  for(const row of sheet){
    const tipo=(row['Tipo de entrada']||'').trim();
    if(!valid.includes(tipo))continue;
    const vb=parseFloat(row['Valor bruto']||row['Valor']||0);
    const vc=parseFloat(row['Sua comissão']||0);
    if(vb>0&&vc>0){totalBruto+=vb;totalCom+=vc;}
  }
  if(totalBruto>0&&totalCom>0)return bruto*(totalCom/totalBruto);
  return null;
}


function saveFichaText(chatterId,store,key,val){
  if(!S.chatterFichas[chatterId])S.chatterFichas[chatterId]={tech:{},behavior:{},potential:{},risk:{},obs:{},history:[],analytics:{}};
  const f=S.chatterFichas[chatterId];
  if(!f[store])f[store]={};
  f[store][key]=val;
  save();
}

/* ===========================================================
   TESTERS — daily result tracking per tester chatter
   =========================================================== */
// Todos os dias (não só os 3 do teste inicial) em que o chatter faturou algo
function getTesterAllWorkDays(chatterId){
  const dateTotals={};
  Object.keys(S.revenues).forEach(key=>{
    const parts=key.split('_');
    if(parts.length<3||parts[0]!==chatterId)return;
    const dateKey=parts.slice(2).join('_');
    const val=parseFloat(S.revenues[key])||0;
    if(val<=0)return;
    dateTotals[dateKey]=(dateTotals[dateKey]||0)+val;
  });
  return Object.keys(dateTotals).sort().map(dk=>({date:dk,revenue:dateTotals[dk]}));
}
// Reserva "permanente": já passou 3 dias desde que entrou pra fila de
// Reservas — sai do fluxo de decisão de Testers e passa a viver na
// aba Reservas de forma fixa, cobrindo turno quando necessário.
function daysSinceDecision(cid){
  const dt=S.chatterFichas?.[cid]?.testerDecisionDate;
  if(!dt)return 0;
  return Math.floor((new Date(todayKey()+'T12:00:00')-new Date(dt+'T12:00:00'))/86400000);
}
function isPermanentReserva(cid){
  // Ao clicar em "Reservas" no Testers, a pessoa sai de lá e aparece na
  // aba Reservas na hora — não espera mais nenhum prazo.
  return S.chatterFichas?.[cid]?.testerDecision==='espera';
}
function renderReservas(){
  const el=document.getElementById('reservas-content');
  if(!el)return;
  const reservas=S.chatters.filter(c=>isPermanentReserva(c.id));
  if(!reservas.length){
    el.innerHTML=`<div class="empty"><div class="empty-ic">🔵</div><div class="empty-tx">Nenhuma reserva permanente ainda.<br>Testers marcados "Reservas" entram aqui automaticamente depois de 3 dias.</div></div>`;
    return;
  }
  el.innerHTML=reservas.map(c=>{
    const workDays=getTesterAllWorkDays(c.id);
    const totalAll=workDays.reduce((s,d)=>s+d.revenue,0);
    const extraWeek=getChatterExtraRevenue(c.id,0);
    const extraBonusWeek=extraWeek*0.10;
    const daysAsReserva=daysSinceDecision(c.id);
    return`<div class="panel reserva-swipe-row" data-key="${c.id}" style="border-left:3px solid var(--bad);touch-action:pan-y">
      <div class="panel-head"><div><div class="panel-title">${c.name}</div><div class="panel-note">Reserva há ${daysAsReserva} dias · arraste pra esquerda pra excluir</div></div>
        <button class="btn btn-ghost btn-xs" onclick="openAddShiftForChatter('${c.id}')">🔁 Realocar em turno</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        <div style="background:var(--bg-soft);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:9px;color:var(--text3)">Faturamento total coberto</div>
          <div style="font-size:14px;font-weight:800;font-family:var(--font-mono)">${money(totalAll)}</div>
        </div>
        <div style="background:var(--bad-soft);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:9px;color:var(--bad)">Hora extra essa semana</div>
          <div style="font-size:14px;font-weight:800;font-family:var(--font-mono);color:var(--bad)">${money(extraBonusWeek)}</div>
        </div>
      </div>
      ${workDays.length?`<div style="max-height:140px;overflow-y:auto">${workDays.slice().reverse().slice(0,10).map(d=>`<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--line);font-size:12px">
        <span>${d.date.split('-').reverse().join('/')}</span><span style="font-weight:700">${money(d.revenue)}</span>
      </div>`).join('')}</div>`:'<div style="font-size:12px;color:var(--text3)">Ainda não cobriu nenhum turno</div>'}
    </div>`;
  }).join('');
  attachSwipeToDelete(el,'.reserva-swipe-row',id=>deleteChatter(id),renderReservas);
}
/* ===========================================================
   SOLICITAÇÃO DE AFILHADO — quadro na aba Testers com decisão
   PRÓPRIA e independente da decisão normal do tester (aprovado/
   reprovado/reservas via setTesterDecision). Aqui a gestora decide
   só sobre O PAREAMENTO padrinho↔tester reivindicado no link público
   de tarefas: aprovar grava padrinhoId na ficha do tester (o que já
   libera o botão "Avalie seu afiliado" pro padrinho no mesmo link);
   reprovar remove a solicitação; reservar guarda pra decidir depois.
   =========================================================== */
// Recado da Gestão — texto livre que a gestora escreve aqui e aparece em
// destaque no topo do link dos padrinhos, pra todos eles verem (tipo um
// aviso/comunicado geral, sem precisar mandar mensagem um por um).
function renderRecadoPadrinhos(){
  const el=document.getElementById('recado-padrinhos-text');
  if(el&&document.activeElement!==el)el.value=S.recadoPadrinhos||'';
}
function saveRecadoPadrinhos(){
  const el=document.getElementById('recado-padrinhos-text');
  if(!el)return;
  S.recadoPadrinhos=el.value;
  save();
  toast('✅ Recado salvo — já aparece pros padrinhos');
}
// Janela extra de reivindicação — reivindicações de afilhado normalmente só
// abrem aos domingos (pedido antigo da gestora); isso dá um jeito dela abrir
// manualmente fora do domingo também (ex: teste rápido, ou reabrir num
// horário combinado), sem mexer na regra normal de domingo. Guardado como
// {inicio,fim} simples no estado central — fim=null significa "sem prazo,
// fica aberta até eu fechar manualmente".
window.abrirJanelaReivindicacao=function(){
  const minRaw=document.getElementById('janela-reivindicacao-minutos')?.value;
  const min=parseInt(minRaw,10);
  const fim=(min>0)?new Date(Date.now()+min*60000).toISOString():null;
  S.reivindicacaoJanelaExtra={inicio:new Date().toISOString(),fim};
  save();
  renderJanelaReivindicacaoStatus();
  toast(fim?`🔓 Reivindicações abertas por ${min} min.`:'🔓 Reivindicações abertas (sem prazo — lembre de fechar depois).');
};
window.fecharJanelaReivindicacao=function(){
  S.reivindicacaoJanelaExtra=null;
  save();
  renderJanelaReivindicacaoStatus();
  toast('🔒 Janela extra de reivindicação fechada.');
};
function renderJanelaReivindicacaoStatus(){
  const el=document.getElementById('janela-reivindicacao-status');
  if(!el)return;
  const j=S.reivindicacaoJanelaExtra;
  const agora=new Date();
  const ativa=!!(j&&j.inicio&&new Date(j.inicio)<=agora&&(!j.fim||new Date(j.fim)>agora));
  if(agora.getDay()===0){
    el.innerHTML='🟢 Hoje é domingo — reivindicações já abertas normalmente.';
  }else if(ativa){
    el.innerHTML=`🟢 Janela extra <strong>ABERTA</strong>${j.fim?` até ${new Date(j.fim).toLocaleString('pt-BR')}`:' — sem prazo, feche manualmente quando quiser'}.`;
  }else{
    el.innerHTML='🔴 Fechada agora (só abre normalmente aos domingos, ou pelo botão acima).';
  }
}
function renderDeserdarHistorico(){
  const el=document.getElementById('deserdar-historico-content');
  if(!el)return;
  const hist=S.deserdarHistorico||[];
  if(!hist.length){
    el.innerHTML='<div style="font-size:12.5px;color:var(--text3)">Nenhuma deserção ainda.</div>';
    return;
  }
  // 09/08/2026 — a pedido da gestora: esse quadro era só histórico estático
  // (sem nenhum swipe attachado), por isso "arrastar" aqui nunca fazia nada.
  // Agora dá pra arrastar cada item pra tirar da lista (só remove o registro
  // do histórico — não mexe no tester, no padrinho nem em mais nada).
  el.innerHTML=hist.map((h,idx)=>`<div class="deserdar-hist-row" data-key="${h.id||idx}" style="border:1px solid var(--line);border-left:3px solid var(--bad);border-radius:9px;padding:10px 13px;margin-bottom:8px;touch-action:pan-y">
    <div style="font-weight:700;font-size:13px">💔 ${h.padrinhoNome} deserdou ${h.testerNome}</div>
    <div style="font-size:11px;color:var(--text3);margin-top:2px">${h.quando?new Date(h.quando).toLocaleString('pt-BR'):''} · volta pra lista de quem ainda não tem padrinho</div>
    <div style="font-size:10px;color:var(--text3);margin-top:4px">⟵ arraste pra tirar daqui</div>
  </div>`).join('');
  attachSwipeToDelete(el,'.deserdar-hist-row',key=>removerDeserdarHistoricoItem(key),renderDeserdarHistorico);
}
function removerDeserdarHistoricoItem(key){
  if(!Array.isArray(S.deserdarHistorico))return;
  S.deserdarHistorico=S.deserdarHistorico.filter((h,idx)=>String(h.id||idx)!==String(key));
  save();
}
function renderAfilhadoClaims(){
  renderRecadoPadrinhos();
  renderJanelaReivindicacaoStatus();
  renderDeserdarHistorico();
  const el=document.getElementById('afilhado-claims-content');
  if(!el)return;
  const claims=S.afilhadoClaims||[];
  if(!claims.length){
    el.innerHTML=`<div style="font-size:12.5px;color:var(--text3)">Nenhuma solicitação ainda — aparece aqui quando um padrinho reivindicar um tester no Link das Tarefas.</div>`;
    return;
  }
  const statusMeta={pendente:{label:'⏳ Pendente',color:'var(--warn)'},aprovado:{label:'✅ Aprovado — padrinho definido',color:'var(--ok)'},reservado:{label:'🔵 Reservado pra depois',color:'var(--text2)'}};
  const ordenados=[...claims].sort((a,b)=>(a.status==='pendente'?0:1)-(b.status==='pendente'?0:1)||(b.criadoEm||'').localeCompare(a.criadoEm||''));
  el.innerHTML=ordenados.map(cl=>{
    const meta=statusMeta[cl.status]||statusMeta.pendente;
    const testerChatterCl=S.chatters.find(ch=>ch.id===cl.testerId);
    const entrevistaLabel=testerChatterCl?.entrevista?.label||'';
    // Resultado da entrevista com o Henrique Peres (10/08/2026) — decisão
    // separada da Solicitação de Afilhado, só pra gestora acompanhar aqui.
    const entrevistaDecisao=S.chatterFichas?.[cl.testerId]?.entrevistaDecisao||'';
    const entrevistaDecisaoHtml=entrevistaDecisao?`<div style="font-size:11.5px;font-weight:700;margin-top:4px;color:${entrevistaDecisao==='aprovado'?'var(--ok)':'var(--bad)'}">🎤 Entrevista (Henrique Peres): ${entrevistaDecisao==='aprovado'?'✅ Aprovado':'❌ Reprovado'}</div>`:'';
    return`<div style="border:1px solid var(--line);border-left:3px solid ${meta.color};border-radius:9px;padding:11px 13px;margin-bottom:9px">
      <div style="font-weight:700;font-size:13.5px">👑 ${cl.padrinhoNome||'—'} → 🧪 ${cl.testerNome||'—'}</div>
      <div style="font-size:11px;color:${meta.color};font-weight:700;margin-top:2px">${meta.label}</div>
      ${entrevistaLabel?`<div style="font-size:11.5px;color:var(--text2);margin-top:4px">🎥 Entrevista marcada: Domingo, ${entrevistaLabel}</div>`:`<div style="font-size:11.5px;color:var(--text3);margin-top:4px">🎥 Ainda não marcou horário de entrevista</div>`}
      ${entrevistaDecisaoHtml}
      <div style="display:flex;gap:6px;margin-top:9px">
        ${['aprovado','reservado','reprovado'].map(op=>{
          const labels={aprovado:'✅ Aprovar',reservado:'🔵 Reservar',reprovado:'❌ Reprovar'};
          const colors={aprovado:'var(--ok)',reservado:'var(--warn)',reprovado:'var(--bad)'};
          const bgs={aprovado:'var(--ok-soft)',reservado:'var(--warn-soft)',reprovado:'var(--bad-soft)'};
          const sel=cl.status===op;
          return`<button onclick="setAfilhadoClaimDecision('${cl.id}','${op}')" style="flex:1;padding:7px 4px;border-radius:8px;border:2px solid ${sel?colors[op]:'var(--line)'};background:${sel?bgs[op]:'var(--bg)'};cursor:pointer;font-family:var(--font-display);font-weight:700;font-size:10.5px;color:${sel?colors[op]:'var(--text2)'}">${labels[op]}</button>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
}
function setAfilhadoClaimDecision(claimId,decision){
  const cl=S.afilhadoClaims.find(c=>c.id===claimId);
  if(!cl)return;
  if(decision==='reprovado'){
    S.afilhadoClaims=S.afilhadoClaims.filter(c=>c.id!==claimId);
    save();
    toast(`❌ Solicitação de ${cl.padrinhoNome} por ${cl.testerNome} reprovada.`);
    renderAfilhadoClaims();
    return;
  }
  cl.status=decision;
  cl.decisaoData=todayKey();
  if(decision==='aprovado'){
    if(!S.chatterFichas[cl.testerId])S.chatterFichas[cl.testerId]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
    S.chatterFichas[cl.testerId].padrinhoId=cl.padrinhoId;
    const testerChatter=S.chatters.find(ch=>ch.id===cl.testerId);
    if(testerChatter){
      testerChatter.time='tester'; // confirma/promove pra área de Tester
      testerChatter.pendenteAprovacao=false; // sai do limbo — agora conta como Tester de verdade
      // Espelha no próprio chatter (mesmo motivo do testerDecision acima):
      // tarefas-novato.html só recebe o array de chatters, nunca a ficha —
      // é assim que ela sabe se mostra a mensagem de "sem padrinho" no fim do ciclo,
      // e também consegue citar o nome do padrinho na mensagem pós-cadastro PJ.
      testerChatter.temPadrinho=true;
      const padrinhoChatter=S.chatters.find(ch=>ch.id===cl.padrinhoId);
      testerChatter.padrinhoNome=padrinhoChatter?padrinhoChatter.name:(cl.padrinhoNome||'');
    }
    // aprovado: sai do quadro de solicitações (mesmo comportamento de reprovado)
    S.afilhadoClaims=S.afilhadoClaims.filter(c=>c.id!==claimId);
    save();
    toast(`✅ ${cl.padrinhoNome} aprovado como padrinho de ${cl.testerNome} — ele foi pra área de Tester e a solicitação saiu da lista.`);
    renderAfilhadoClaims();
    renderTeam(teamFilter);
    renderTesters();
    return;
  } else {
    toast(`🔵 Solicitação de ${cl.padrinhoNome} por ${cl.testerNome} colocada em reservado.`);
  }
  save();
  renderAfilhadoClaims();
}
// Visibilidade da gestora sobre tudo que se passa com os padrinhos: pedidos
// de segunda chance (decididos por ELES no Documento dos Padrinhos, mas
// visíveis aqui) e dados de PJ recebidos (com botão de copiar).
function renderSegundaChancePanel(){
  const el=document.getElementById('segunda-chance-content');
  if(!el)return;
  const rows=[];
  S.chatters.forEach(c=>{
    const reqs=S.chatterFichas?.[c.id]?.segundaChanceRequests||[];
    reqs.forEach(r=>rows.push({...r,chatterName:c.name}));
  });
  if(!rows.length){
    el.innerHTML='<div style="font-size:12.5px;color:var(--text3)">Nenhum pedido ainda — aparece aqui quando um tester pedir segunda chance no link de tarefas.</div>';
    return;
  }
  rows.sort((a,b)=>(b.criadoEm||'').localeCompare(a.criadoEm||''));
  const meta={pendente:{label:'⏳ Aguardando padrinho',color:'var(--warn)'},aprovado:{label:'✅ Aprovado',color:'var(--ok)'},recusado:{label:'❌ Recusado',color:'var(--bad)'}};
  el.innerHTML=rows.map(r=>{
    const m=meta[r.status]||meta.pendente;
    return`<div style="border:1px solid var(--line);border-left:3px solid ${m.color};border-radius:9px;padding:11px 13px;margin-bottom:9px">
      <div style="font-weight:700;font-size:13.5px">${r.chatterName} — Dia ${r.dia}</div>
      <div style="font-size:12px;color:var(--text2);margin-top:4px">${r.justificativa||'—'}</div>
      <div style="font-size:11px;color:${m.color};font-weight:700;margin-top:6px">${m.label}${r.padrinhoNome?' · '+r.padrinhoNome:''}</div>
    </div>`;
  }).join('');
}
function textoDadosPJ(c,d){
  return[
    `${c.name}`,
    `Razão Social: ${d.razaoSocial||''}`,`Nickname: ${d.nickname||''}`,`CNPJ: ${d.cnpj||''}`,
    `Endereço de sede: ${d.endereco||''}`,`Número: ${d.numero||''}`,`Bairro: ${d.bairro||''}`,`Cep: ${d.cep||''}`,
    `Telefone/Celular: ${d.telefone||''}`,`E-mail: ${d.email||''}`,`Pix: ${d.pix||''}`,`Banco e chave: ${d.bancoChave||''}`,
    `Fala inglês: ${d.falaIngles||''}`,
    `Email do Trello: ${d.trelloEmail||''}`,`Número do Telegram: ${d.telegramNumero||''}`,`Nome no Telegram: ${d.telegramNome||''}`
  ].join('\n');
}
function renderDadosPjPanel(){
  const el=document.getElementById('dados-pj-content');
  if(!el)return;
  const withData=S.chatters.filter(c=>S.chatterFichas?.[c.id]?.dadosPJ);
  if(!withData.length){
    el.innerHTML='<div style="font-size:12.5px;color:var(--text3)">Nenhum dado de PJ recebido ainda — aparece aqui quando um tester aprovado preencher no link de tarefas.</div>';
    return;
  }
  // Botão "copiar todos" — a pedido da gestora, pra colar tudo de uma vez em
  // vez de ter que copiar pessoa por pessoa.
  el.innerHTML=`<button class="btn btn-ghost btn-sm" style="margin-bottom:10px" onclick="copiarTodosDadosPJ()">📋 Copiar todos juntos</button>`+
  withData.map(c=>{
    const d=S.chatterFichas[c.id].dadosPJ;
    const linhas=[
      ['Razão Social',d.razaoSocial],['Nickname',d.nickname],['CNPJ',d.cnpj],
      ['Endereço de sede',d.endereco],['Número',d.numero],['Bairro',d.bairro],['CEP',d.cep],
      ['Telefone/Celular',d.telefone],['E-mail',d.email],['Pix',d.pix],['Banco e chave',d.bancoChave],
      ['Fala inglês',d.falaIngles],
      ['Email do Trello',d.trelloEmail],['Número do Telegram',d.telegramNumero],['Nome no Telegram',d.telegramNome]
    ].filter(([,v])=>v);
    // 10/08/2026 — badge de verificação automática do CNPJ (caso do Wesley):
    // mostra se o link já conferiu na Receita que o CNPJ bate com o nome de
    // quem preencheu, ou se não deu pra confirmar (precisa olhar na mão).
    const cnpjBadge=d.cnpjVerificado
      ?`<span style="font-size:10px;font-weight:800;color:var(--ok);background:var(--ok-soft);border-radius:6px;padding:2px 6px;margin-left:6px">✅ CNPJ verificado</span>`
      :`<span title="${d.cnpjRazaoSocialReceita?'Razão social encontrada: '+d.cnpjRazaoSocialReceita:'Não foi possível confirmar automaticamente'}" style="font-size:10px;font-weight:800;color:var(--warn);background:var(--warn-soft);border-radius:6px;padding:2px 6px;margin-left:6px">⚠️ CNPJ não verificado — confira</span>`;
    return`<div class="dadospj-swipe-row" data-key="${c.id}" style="border:1px solid var(--line);border-radius:9px;padding:11px 13px;margin-bottom:9px;touch-action:pan-y">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="font-weight:700;font-size:13.5px">${c.name}${cnpjBadge}</div>
        <button data-noaccordion onclick="copiarDadosPJ('${c.id}')" title="Copiar dados" style="background:none;border:1px solid var(--line);border-radius:6px;padding:4px 8px;cursor:pointer;font-size:13px">📋</button>
      </div>
      ${linhas.map(([lb,v])=>`<div style="font-size:12px;color:var(--text2);margin-bottom:2px"><strong>${lb}:</strong> ${v}</div>`).join('')}
      <div style="font-size:10.5px;color:var(--text3);margin-top:6px">⟵ arraste pra remover daqui</div>
    </div>`;
  }).join('');
  attachSwipeToDelete(el,'.dadospj-swipe-row',id=>removerDadosPJ(id),renderDadosPjPanel);
}
function copiarDadosPJ(chatterId){
  const c=S.chatters.find(ch=>ch.id===chatterId);
  const d=S.chatterFichas?.[chatterId]?.dadosPJ;
  if(!c||!d){toast('⚠️ Sem dados pra copiar');return;}
  navigator.clipboard?.writeText(textoDadosPJ(c,d)).then(()=>toast('✅ Dados copiados')).catch(()=>toast('⚠️ Não consegui copiar'));
}
function copiarTodosDadosPJ(){
  const withData=S.chatters.filter(c=>S.chatterFichas?.[c.id]?.dadosPJ);
  if(!withData.length){toast('⚠️ Sem dados pra copiar');return;}
  const texto=withData.map(c=>textoDadosPJ(c,S.chatterFichas[c.id].dadosPJ)).join('\n\n———\n\n');
  navigator.clipboard?.writeText(texto).then(()=>toast(`✅ Dados de ${withData.length} pessoa${withData.length>1?'s':''} copiados juntos`)).catch(()=>toast('⚠️ Não consegui copiar'));
}
function removerDadosPJ(chatterId){
  // Remove só os dados de PJ desse quadro (não apaga o chatter nem mais
  // nada dele) — sempre com confirmação antes, pedido explícito da gestora
  // pra nunca apagar nada sem checar.
  const c=S.chatters.find(ch=>ch.id===chatterId);
  if(!confirm(`Remover os dados de PJ de ${c?c.name:'essa pessoa'} desse quadro? Já deve ter copiado/colado o que precisava — isso não apaga o chatter, só tira daqui.`))return;
  if(S.chatterFichas?.[chatterId]){
    delete S.chatterFichas[chatterId].dadosPJ;
    tombstoneField('chatterFichas.'+chatterId+'.dadosPJ');
  }
  save();
  renderDadosPjPanel();
  toast('Removido do quadro de Dados PJ.');
}
function setTesterDecision(chatterId,decision){
  const c=S.chatters.find(ch=>ch.id===chatterId);
  if(!c)return;
  if(!S.chatterFichas[chatterId])S.chatterFichas[chatterId]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
  S.chatterFichas[chatterId].testerDecision=decision;
  S.chatterFichas[chatterId].testerDecisionDate=todayKey();
  // Espelha no próprio chatter (não só na ficha) porque o link público de
  // tarefas (tarefas-novato.html) só recebe o array "chatters" via
  // central-dados, nunca as fichas inteiras — é assim que a página sabe
  // mostrar a tela de aprovado/reprovado pra pessoa certa.
  c.testerDecision=decision;
  c.testerDecisionDate=todayKey();
  // A pedido da gestora: as tarefas enviadas pelo link (com print em base64
  // de cada dia) só servem pra guiar a escolha dos padrinhos — assim que
  // QUALQUER decisão é tomada (aprovado, reprovado OU colocado nas Reservas)
  // elas não têm mais função e são apagadas, senão os prints ficam
  // acumulando à toa na fatia própria de tarefas (shard-tarefas-tester). Sem
  // exceção pra Reservas/espera — a gestora pediu explicitamente pra não
  // guardar nem esse caso.
  if(decision==='aprovado'){
    // 10/08/2026 — a pedido da gestora: se a pessoa é aprovada, o resultado
    // do Teste (PPM de cada dia + Mapeamento de Triagem) passa a constar pra
    // sempre num quadro fixo "Teste" na Ficha, junto do resumo do padrinho.
    // Isso precisa ser copiado AQUI, antes das linhas logo abaixo que
    // apagam as fontes originais (o shard de tarefas é sempre limpo e o
    // Mapeamento de Triagem é substituído pelo Mapeamento de Performance de
    // verdade) — sem essa cópia esse histórico se perderia pra sempre.
    const ciclosPPM=Object.keys(S.tarefasNovatoPorTester[chatterId]||{}).sort();
    const ultimoCicloPPM=ciclosPPM[ciclosPPM.length-1];
    const ppmDias=ultimoCicloPPM?Object.keys(S.tarefasNovatoPorTester[chatterId][ultimoCicloPPM]).sort().map(k=>{
      const d=S.tarefasNovatoPorTester[chatterId][ultimoCicloPPM][k];
      return{dia:k.replace('dia',''),resumo:d.resumo||'',ppmResultado:d.ppmResultado||d.ppmImage||'',enviadoEm:d.enviadoEm||''};
    }):[];
    if(!S.chatterFichas[chatterId])S.chatterFichas[chatterId]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
    S.chatterFichas[chatterId].testeResultado={
      ppmDias,
      mapeamento:S.chatterFichas[chatterId].triagemIA?{...S.chatterFichas[chatterId].triagemIA}:null,
      salvoEm:new Date().toISOString()
    };
  }
  delete S.tarefasNovatoPorTester[chatterId];
  if(decision==='aprovado'){
    c.time='basico'; // vira time normal — mas continua contando na lista de histórico de decisões
    if(c.level==='teste'||c.level==='treinamento')c.level='junior'; // promove o nível também, senão fica filtrado de fora em quadros que checam nível separado do cargo
    c.testerApprovalDate=todayKey(); // a partir dessa data os relatórios entram nas análises (Evolução etc)
    // O Mapeamento de Triagem (feito antes de contratar) some quando a pessoa
    // é efetivada — a partir de agora ela é avaliada pelo Mapeamento de
    // Performance de verdade (entrevista completa, feita já como chatter).
    // Já foi copiado pro quadro Teste (testeResultado.mapeamento) acima.
    if(S.chatterFichas[chatterId])delete S.chatterFichas[chatterId].triagemIA;
    toast(`✅ ${c.name} aprovado! Já passou pro Time Base e entra em todas as análises de desenvolvimento a partir de hoje.`);
  } else if(decision==='reprovado'){
    toast(`${c.name} marcado como reprovado.`);
  } else {
    toast(`${c.name} colocado nas Reservas — entra quando faltar cobertura de turno.`);
  }
  save();
  renderTesters();
}
// 08/08/2026 — a pedido da gestora: arrastar (swipe) na lista de Testers
// (pendentes ou decididos) NÃO apaga mais o chatter inteiro — só some
// daqui (fica marcado arquivadoTesters=true, que o filtro de renderTesters
// exclui). Todo o histórico, ficha, faturamento etc. continuam intactos.
// Antes o swipe chamava deleteChatter direto, apagando tudo sem volta —
// exatamente o que a gestora reportou como bug ("arrasto e apaga no
// sistema"). Pra apagar de vez agora precisa do botão 🗑️ explícito (linha
// de Decididos), que é bem mais difícil de acionar sem querer que um swipe.
function arquivarTester(id){
  const c=S.chatters.find(ch=>ch.id===id);
  if(!confirm(`Tirar ${c?c.name:'essa pessoa'} da lista de Testers? Isso só esconde daqui — NÃO apaga o chatter, a ficha, nem o histórico de nada. Pra apagar de vez, use o botão 🗑️.`))return;
  if(!S.chatterFichas[id])S.chatterFichas[id]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
  S.chatterFichas[id].arquivadoTesters=true;
  save();
  toast(`${c?c.name:'Pessoa'} tirada da lista de Testers — nada foi apagado.`);
}
function renderTesters(){
  renderMapSlots();
  renderMapTranscricoes();
  renderMapeamentoNovosPool();
  renderAfilhadoClaims();
  renderDadosPjPanel();
  const sel=document.getElementById('tester-select');
  // Pool: quem está marcado Tester AGORA e já foi aprovado (não é mais só
  // pendente de aprovação da solicitação de Afilhado), + quem já teve
  // alguma decisão registrada (mantém histórico mesmo após aprovar).
  // Enquanto pendenteAprovacao=true, a pessoa só aparece nas Tarefas
  // (tarefas-novato.html) — vira Tester aqui só quando a gestora aprovar
  // a solicitação do padrinho em Solicitação de Afilhado.
  // A pedido da gestora: só quem já foi apadrinhado (claim aprovado por um
  // padrinho) aparece aqui pra ela decidir aprovado/reprovado e iniciar o
  // teste — quem ainda não tem padrinho fica só no link dos padrinhos, onde
  // eles reivindicam. Quem já teve alguma decisão continua aparecendo
  // (histórico), mesmo que por algum motivo não tenha mais padrinhoId.
  // 08/08/2026 — a pedido da gestora: arrastar (swipe) nessa lista deixou
  // de apagar o chatter inteiro (deleteChatter) e passou a só "arquivar"
  // (arquivadoTesters=true), que esse filtro exclui — a pessoa some da
  // lista mas TODO o histórico continua intacto. Apagar de vez agora é só
  // pelo botão 🗑️ explícito (ver decisionBtns/tester-decided-row abaixo).
  const testers=S.chatters.filter(c=>{
    const ficha=S.chatterFichas?.[c.id];
    return!!(ficha&&(ficha.padrinhoId||ficha.testerDecision)&&!ficha.arquivadoTesters);
  });
  if(sel){
    const cur=sel.value;
    sel.innerHTML='<option value="">— ver todos —</option>'+
      testers.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
    if(cur&&testers.find(t=>t.id===cur))sel.value=cur;
  }
  const cid=document.getElementById('tester-select')?.value;
  const el=document.getElementById('tester-content');
  if(!el)return;

  if(cid){
    renderTesterDetail(cid);
    return;
  }

  if(!testers.length){
    el.innerHTML=`<div class="empty"><div class="empty-ic">🧪</div><div class="empty-ttl">Sem testers em avaliação</div><div class="empty-sub">Crie um tester em Mapeamento dos Novos ou marque um chatter como 🧪 Tester em Equipe — ele aparece aqui depois que a solicitação de Afilhado for aprovada</div></div>`;
    return;
  }

  const decided=testers.filter(c=>['aprovado','reprovado'].includes(S.chatterFichas?.[c.id]?.testerDecision));
  const pending=testers.filter(c=>!decided.includes(c)&&!isPermanentReserva(c.id));

  // Build score for each pending tester based on their 3-day test window
  const scored=pending.map(c=>{
    const analysis=getTesterAnalysis(c.id);
    const decision=S.chatterFichas?.[c.id]?.testerDecision||'';
    return{c,rev:analysis.totalRev,analysis,decision};
  }).sort((a,b)=>b.rev-a.rev);

  const DIAS=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const dayName=dk=>{const[y,mo,d]=dk.split('-').map(Number);return DIAS[new Date(y,mo-1,d).getDay()];};
  const fmtBR=dk=>{const[y,mo,d]=dk.split('-');return`${d}/${mo}/${y}`;};

  const decisionBtns=(c,current)=>['aprovado','espera','reprovado'].map(op=>{
    const labels={aprovado:'✅ Aprovado',espera:'🔵 Reservas',reprovado:'❌ Reprovado'};
    const colors={aprovado:'var(--ok)',espera:'var(--warn)',reprovado:'var(--bad)'};
    const bgs={aprovado:'var(--ok-soft)',espera:'var(--warn-soft)',reprovado:'var(--bad-soft)'};
    const sel2=current===op;
    return`<button onclick="event.stopPropagation();setTesterDecision('${c.id}','${op}')"
      style="flex:1;padding:7px 4px;border-radius:8px;border:2px solid ${sel2?colors[op]:'var(--line)'};background:${sel2?bgs[op]:'var(--bg)'};cursor:pointer;font-family:var(--font-display);font-weight:700;font-size:11px;color:${sel2?colors[op]:'var(--text2)'}">${labels[op]}</button>`;
  }).join('');

  // Indicador de espaço — a pedido da gestora, pra planejar quantos testers
  // dá pra receber ao mesmo tempo sem chegar perto do limite de ~1MB por
  // documento do Firestore. Desde 31/07/2026 as tarefas (com print do PPM)
  // moram numa fatia PRÓPRIA (shard-tarefas-tester), separada do documento
  // que guarda a Ficha de todo mundo já contratado — mostra os dois
  // orçamentos separados, cada um com seu próprio ~1024KB.
  const fichaKB=Math.round(JSON.stringify(S.chatterFichas||{}).length/1024);
  const tarefasKB=Math.round(JSON.stringify(S.tarefasNovatoPorTester||{}).length/1024);
  const testersComTarefas=Object.values(S.tarefasNovatoPorTester||{}).filter(t=>t&&Object.keys(t).length).length;
  const pior=Math.max(fichaKB,tarefasKB);
  const capCor=pior>850?'var(--bad)':pior>500?'var(--warn)':'var(--ok)';
  const capMsg=pior>850?'⚠️ perto do limite — decida (aprovado/reprovado/reservas) quem já terminou o ciclo pra liberar espaço na hora'
    :pior>500?'de olho, mas ainda tranquilo — vai decidindo quem termina o ciclo que o espaço libera sozinho'
    :'espaço de sobra pra receber mais gente';
  el.innerHTML=`
    <div style="background:var(--bg-soft);border-radius:10px;padding:12px;margin-bottom:10px;font-size:12.5px;color:var(--text2)">
      📊 <strong>${pending.length} em avaliação</strong> — classificados do melhor pro pior pelo resultado dos 3 dias de teste. Os 3 primeiros ficam sempre em destaque como fila de espera.
    </div>
    <div style="background:var(--bg-soft);border-radius:10px;padding:12px;margin-bottom:14px;font-size:12px;color:var(--text2);border-left:3px solid ${capCor}">
      💾 <strong>Tarefas dos testers: ${tarefasKB}KB</strong> de ~1024KB (fatia própria, ${testersComTarefas} tester${testersComTarefas!==1?'s':''} com print ainda sem decisão final) · Fichas de todo mundo: ${fichaKB}KB de ~1024KB — ${capMsg}
    </div>
    ${scored.map((item,idx)=>{
      const {c,rev,analysis,decision}=item;
      const isTop3=idx<3;
      const color=isTop3?'var(--ok)':idx<scored.length-Math.max(1,Math.floor(scored.length/3))?'var(--warn)':'var(--bad)';
      const daysLabel=analysis.testDays.length?analysis.testDays.map(td=>dayName(td.date)).join(', '):'sem dias de teste ainda';
      const workDays=getTesterAllWorkDays(c.id);
      const contractDate=c.createdAt?fmtBR(c.createdAt.slice(0,10)):'—';
      return`<div class="tester-pending-row" data-key="${c.id}" style="padding:12px;background:var(--surface);border:1px solid var(--line);border-left:3px solid ${color};border-radius:9px;margin-bottom:9px;touch-action:pan-y">
        <div style="display:flex;align-items:flex-start;gap:12px;cursor:pointer" onclick="document.getElementById('tester-select').value='${c.id}';renderTesterDetail('${c.id}')">
          <div style="font-size:20px;font-weight:800;font-family:var(--font-mono);color:${color};min-width:26px;flex-shrink:0">${isTop3?['🥇','🥈','🥉'][idx]:`${idx+1}º`}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:14px">${c.name} ${isTop3?'<span class="pill pill-ok" style="font-size:9px">🌟 fila</span>':''}</div>
            <div style="font-size:11.5px;color:var(--text2);margin-top:2px">Teste: ${daysLabel}${analysis.testDays.length?` · <strong style="color:${color}">${money(rev)}</strong> nos 3 dias`:''}</div>
            <div style="font-size:11px;color:var(--text3);margin-top:1px">${workDays.length} dia${workDays.length!==1?'s':''} de trabalho · contrato desde ${contractDate}</div>
          </div>
          <button title="Apagar de vez (não some sozinho? use isso)" onclick="event.stopPropagation();deleteChatter('${c.id}')" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:14px;padding:2px 4px">🗑️</button>
          <div style="font-size:18px">›</div>
        </div>
        <div style="display:flex;gap:6px;margin-top:10px">${decisionBtns(c,decision)}</div>
      </div>`;
    }).join('')}
    ${decided.length?`
      <div style="margin-top:20px">
        <div style="font-size:12px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">📋 Decididos</div>
        ${decided.sort((a,b)=>(S.chatterFichas[b.id]?.testerDecisionDate||'').localeCompare(S.chatterFichas[a.id]?.testerDecisionDate||'')).map(c=>{
          const f=S.chatterFichas[c.id]||{};
          const isAprov=f.testerDecision==='aprovado';
          // Faturamento continua visível independente da decisão — inclusive
          // reprovado — pra sempre poder consultar quanto essa pessoa gerou
          // no período de teste, mesmo depois de reprovada.
          const analysis=getTesterAnalysis(c.id);
          // A pedido da gestora (07/08/2026): antes essa linha não tinha
          // onclick nenhum — depois de decidido (aprovado/reprovado), não
          // dava pra abrir o detalhe do tester pra gerar/rever o link de
          // Avaliação de Chatter (mandamentosPanelHtml), então o relatório
          // do padrinho ficava sem onde ser processado/registrado pra quem
          // já tinha sido decidido. Agora clica igual à lista de pendentes.
          return`<div class="tester-decided-row" data-key="${c.id}" style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;background:var(--bg-soft);border-radius:8px;margin-bottom:6px;font-size:12.5px;touch-action:pan-y;cursor:pointer" onclick="document.getElementById('tester-select').value='${c.id}';renderTesterDetail('${c.id}')">
            <div><strong>${c.name}</strong> <span style="color:${isAprov?'var(--ok)':'var(--bad)'}">${isAprov?'✅ aprovado':'❌ reprovado'}</span></div>
            <div style="display:flex;align-items:center;gap:8px">
              <div style="text-align:right">
                <div style="font-weight:700;font-family:var(--font-mono)">${money(analysis.totalRev)}</div>
                <div style="color:var(--text3);font-size:11px">${f.testerDecisionDate?f.testerDecisionDate.split('-').reverse().join('/'):''}</div>
              </div>
              <button title="Apagar de vez (não some sozinho? use isso)" onclick="event.stopPropagation();deleteChatter('${c.id}')" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:14px;padding:2px 4px">🗑️</button>
              <div style="font-size:16px;color:var(--text3)">›</div>
            </div>
          </div>`;
        }).join('')}
      </div>`:''}
  `;
  // 08/08/2026 — a pedido da gestora: arrastar aqui não apaga mais o
  // chatter inteiro, só "arquiva" (esconde da lista, sem apagar nada —
  // ver arquivarTester). Apagar de vez é só pelo botão 🗑️ explícito.
  attachSwipeToDelete(el,'.tester-pending-row',id=>arquivarTester(id),renderTesters);
  attachSwipeToDelete(el,'.tester-decided-row',id=>arquivarTester(id),renderTesters);
}

/* ===========================================================
   MANDAMENTOS DO CHATTER — critérios avaliativos usados durante o
   período de teste, transformados a partir do documento oficial
   (Mandamentos_do_Chatter). Cada tópico vira um critério com status
   rápido (atende/parcial/não atende) + espaço de observação livre —
   fica na página de detalhe do tester, ao lado da análise de
   faturamento, pra embasar a decisão de aprovar/reprovar com o
   comportamento observado, não só com o número.
   =========================================================== */
const MANDAMENTOS_CRITERIOS=[
  {id:'nome',titulo:'Chama todos os leads novos pelo nome',
    descricao:'Todo lead novo é chamado pelo nome e ninguém fica sem resposta — descobre o que ele quer, gera intenção de compra e sabe agir: comprou (continua o atendimento), não comprou (curte e segue), questionou demais (dá um ultimato).'},
  {id:'organizacao',titulo:'Organização pra responder mensagens não lidas',
    descricao:'Responde de forma organizada e sistemática (ex: 15 de cima pra baixo e 15 de baixo pra cima), sem deixar ninguém de fora.'},
  {id:'constancia',titulo:'Constância do começo ao fim do turno',
    descricao:'Mantém a mesma frequência de resposta o turno inteiro — mesmo quando o chat esfria, continua atenta pra responder quem chegar.'},
  {id:'linguagem',titulo:'Linguagem adequada e posicionamento',
    descricao:'Linguagem feminina, com autoridade e posicionamento — tom provocativo, engraçado e levemente tímido quando cabe, agregando valor à experiência.'},
  {id:'clientePede',titulo:'Faz o cliente pedir o que quer',
    descricao:'Quem define preço, mídia e tempo é ela. Se o lead quer escolher tudo, cobra mais caro — reduz desperdício de tempo com curiosos testando limites.'},
  {id:'sexting',titulo:'Sexting e PPV com direção de venda',
    descricao:'Conduz a conversa com roteiro, começa com valores menores e aumenta gradualmente, adapta o ambiente à realidade do lead e cria imersão emocional.'},
  {id:'tempoVale',titulo:'Valoriza o tempo da modelo',
    descricao:'Limita conversas com leads excessivamente curiosos e conduz quem só consome mídia sem comprar pra uma decisão.'},
  {id:'valorMidia',titulo:'Cria valor pras mídias',
    descricao:'Sabe exatamente o que está oferecendo, instiga a imaginação antes de apresentar a mídia e só faz a oferta quando o lead já está envolvido.'},
  {id:'exclusividade',titulo:'Vende exclusividade',
    descricao:'Adapta o valor de conteúdos premium ao perfil e histórico de consumo do cliente, reforçando a percepção de raridade.'},
  {id:'personagem',titulo:'Conhece bem a personagem',
    descricao:'Domina a linguagem, os trejeitos e a forma de agir da personagem, criando uma experiência consistente do início ao fim.'},
  {id:'perfilProfissional',titulo:'Perfil profissional',
    descricao:'Sabe lidar com pressão, mantém postura profissional, respeita e ajuda os colegas, trabalha com foco e constância.'}
];
function ensureMandamentosEval(cid){
  if(!S.chatterFichas[cid])S.chatterFichas[cid]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
  if(!S.chatterFichas[cid].mandamentosEval)S.chatterFichas[cid].mandamentosEval={};
  return S.chatterFichas[cid].mandamentosEval;
}
function setMandamentoStatus(cid,critId,status){
  const ev=ensureMandamentosEval(cid);
  if(!ev[critId])ev[critId]={status:'',nota:''};
  ev[critId].status=ev[critId].status===status?'':status; // clica de novo pra desmarcar
  save();
  renderTesterDetail(cid);
}
function saveMandamentoNota(cid,critId,val){
  const ev=ensureMandamentosEval(cid);
  if(!ev[critId])ev[critId]={status:'',nota:''};
  ev[critId].nota=val;
  save();
}
// Padrinho responsável — chatter com cargo/medalha "Padrinho" designado como
// responsável por acompanhar esse tester específico durante o período de teste.
function setPadrinhoResponsavel(cid,padrinhoId){
  if(!S.chatterFichas[cid])S.chatterFichas[cid]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
  S.chatterFichas[cid].padrinhoId=padrinhoId||'';
  const c=S.chatters.find(ch=>ch.id===cid);
  if(c){
    c.temPadrinho=!!padrinhoId;
    const padrinhoChatter=padrinhoId?S.chatters.find(ch=>ch.id===padrinhoId):null;
    c.padrinhoNome=padrinhoChatter?padrinhoChatter.name:'';
  }
  save();
  renderTesterDetail(cid);
}
function mandamentosPanelHtml(cid){
  const ev=S.chatterFichas?.[cid]?.mandamentosEval||{};
  // A pedido da gestora (07/08/2026): critérios técnicos viraram só Sim/Não
  // (antes eram 3 opções atende/parcial/não atende, com descrição embaixo
  // de cada item — agora é só a bolinha sim/não, sem texto explicativo).
  const statusMeta={
    sim:{label:'✅ Sim',color:'var(--ok)',bg:'var(--ok-soft)'},
    nao:{label:'❌ Não',color:'var(--bad)',bg:'var(--bad-soft)'}
  };
  const total=MANDAMENTOS_CRITERIOS.length;
  const simCount=MANDAMENTOS_CRITERIOS.filter(c=>ev[c.id]?.status==='sim').length;
  const naoCount=MANDAMENTOS_CRITERIOS.filter(c=>ev[c.id]?.status==='nao').length;
  const padrinhoId=S.chatterFichas?.[cid]?.padrinhoId||'';
  const padrinhos=S.chatters.filter(ch=>(ch.level==='padrinho'||ch.isPadrinho)&&ch.id!==cid);
  const padrinhoSelectHtml=`<div style="border:1px solid var(--line);border-radius:9px;padding:11px 13px;margin-top:2px">
    <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px">👑 Padrinho responsável</div>
    ${padrinhos.length?`<select class="fselect" onchange="setPadrinhoResponsavel('${cid}',this.value)">
      <option value="">— selecionar —</option>
      ${padrinhos.map(p=>`<option value="${p.id}" ${padrinhoId===p.id?'selected':''}>${p.name}</option>`).join('')}
    </select>`:`<div style="font-size:12px;color:var(--text3)">Nenhum chatter marcado como 👑 Padrinho ainda — defina o cargo na aba Equipe pra poder escolher aqui.</div>`}
  </div>`;
  const obsGerais=S.chatterFichas?.[cid]?.padrinhoObservacoesGerais||'';
  // Rótulo alinhado com a pergunta que o padrinho responde no link público
  // (avaliacao.html) — a pedido da gestora (07/08/2026).
  const obsGeraisHtml=`<div style="border:1px solid var(--line);border-radius:9px;padding:11px 13px;margin-top:9px">
    <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.03em;margin-bottom:6px">📝 Processo de teste e opinião do padrinho</div>
    <textarea class="ftext" style="min-height:60px;font-size:12px" placeholder="Preenchido automaticamente quando o padrinho envia pelo link — ou escreva aqui direto..." onblur="savePadrinhoObsGerais('${cid}',this.value)">${obsGerais}</textarea>
  </div>`;
  // Lista compacta (07/08/2026, a pedido da gestora): cada critério é uma
  // linha só — título + bolinha Sim/Não do lado, sem card próprio nem
  // descrição embaixo. Antes cada item ocupava um bloco inteiro.
  return`<div class="panel" style="margin-bottom:14px;border-left:3px solid var(--accent)">
    <div class="panel-head"><div><div class="panel-title">📜 Avaliação de Chatter</div><div class="panel-note">${simCount}/${total} critérios com Sim${naoCount?` · ${naoCount} com Não`:''}</div></div>
      <button class="btn btn-ghost btn-xs" onclick="gerarLinkAvaliacao('${cid}')">🔗 Link de avaliação</button>
    </div>
    <div style="border:1px solid var(--line);border-radius:9px;overflow:hidden;margin-bottom:9px">
      ${MANDAMENTOS_CRITERIOS.map((c,idx)=>{
        const e=ev[c.id]||{};
        return`<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;${idx<MANDAMENTOS_CRITERIOS.length-1?'border-bottom:1px solid var(--line)':''}">
          <div style="font-size:12px;font-weight:600;line-height:1.3;flex:1">${idx+1}. ${c.titulo}</div>
          <div style="display:flex;gap:5px;flex-shrink:0">
            ${['sim','nao'].map(s=>{
              const sel=e.status===s;
              const m=statusMeta[s];
              return`<button onclick="setMandamentoStatus('${cid}','${c.id}','${s}')" style="width:26px;height:26px;border-radius:50%;border:2px solid ${sel?m.color:'var(--line-strong)'};background:${sel?m.bg:'var(--bg)'};cursor:pointer;font-family:var(--font-display);font-weight:800;font-size:11px;color:${sel?m.color:'var(--text3)'};display:flex;align-items:center;justify-content:center;padding:0">${s==='sim'?'✓':'✗'}</button>`;
            }).join('')}
          </div>
        </div>`;
      }).join('')}
    </div>
    ${padrinhoSelectHtml}
    ${obsGeraisHtml}
  </div>`;
}
function savePadrinhoObsGerais(cid,val){
  if(!S.chatterFichas[cid])S.chatterFichas[cid]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
  S.chatterFichas[cid].padrinhoObservacoesGerais=val;
  save();
}

/* ===========================================================
   AVALIAÇÃO DE CHATTER — link online pro padrinho preencher
   Nada de PDF: gera um link público (avaliacao.html?id=<chatterId>)
   que o padrinho abre e preenche direto no navegador. Ao enviar, a
   página escreve um documento novo na MESMA coleção 'gestorpro' do
   Firestore (que já é liberada pro app gravar sem login), marcado
   com type:'avaliacaoPendente' e processado:false. O app principal
   fica ouvindo essa coleção (listenToAvaliacoesPendentes, chamado
   junto do resto do Firestore em initFirebase) e, assim que um
   registro novo chega, aplica sozinho os critérios na Avaliação de
   Chatter certa e marca como processado — sem precisar abrir/importar
   nada manualmente. Quando o bot do Discord entrar, ele pode escrever
   nessa mesma coleção do mesmo jeito.
   =========================================================== */
function gerarLinkAvaliacao(cid){
  const c=S.chatters.find(ch=>ch.id===cid);
  if(!c)return;
  const url=`${location.origin}/avaliacao.html?id=${encodeURIComponent(cid)}&nome=${encodeURIComponent(c.name)}`;
  const input=document.getElementById('avaliacao-link-input');
  if(input)input.value=url;
  openModal('m-avaliacao-link');
}
function copiarLinkAvaliacao(){
  const input=document.getElementById('avaliacao-link-input');
  if(!input)return;
  input.select();
  navigator.clipboard?.writeText(input.value).then(()=>{
    toast('📋 Link copiado — envie pro padrinho responsável.');
  }).catch(()=>{
    document.execCommand('copy');
    toast('📋 Link copiado — envie pro padrinho responsável.');
  });
}
// Link ÚNICO (sem ?id) do quadro MAPEAMENTO DOS NOVOS — ao contrário dos
// links de avaliação/chatlab (um por pessoa), esse é o MESMO link pra
// todos os testers e padrinhos; a própria página pública pede o nome.
// 10/08/2026 — a pedido da gestora: ela quer divulgar um link mais discreto
// pros testers, que não deixe óbvio que existe um sistema inteiro por trás
// (ex: agenciaseduct-chatterteste.vercel.app em vez de gestordechat.vercel.app).
// Como ela não tem domínio próprio, o jeito gratuito é um ALIAS da Vercel
// (Vercel → o projeto → Settings → Domains → Add → digitar o nome desejado
// terminado em .vercel.app — aponta pro MESMO site, sem custo). Ela ainda
// não criou esse alias, então isso fica pronto mas DESLIGADO por padrão
// (string vazia = usa o link normal, sem quebrar nada agora). Assim que o
// alias existir, é só preencher o nome aqui embaixo (sem "https://") que o
// botão "Link das Tarefas" passa a gerar o endereço novo automaticamente.
const CHATTERTESTE_ALIAS_HOST=''; // ex: 'agenciaseduct-chatterteste.vercel.app'
function gerarLinkTarefasNovato(){
  // Renomeado de tarefas-novato.html pra chatterteste.html (06/08/2026, a
  // pedido da gestora) — o arquivo antigo virou um redirect, então quem já
  // tinha o link salvo continua funcionando, mas o link novo compartilhado
  // daqui pra frente já é o certo.
  const url=`${CHATTERTESTE_ALIAS_HOST?'https://'+CHATTERTESTE_ALIAS_HOST:location.origin}/chatterteste.html`;
  const input=document.getElementById('tarefas-novato-link-input');
  if(input)input.value=url;
  openModal('m-tarefas-novato-link');
}
function copiarLinkTarefasNovato(){
  const input=document.getElementById('tarefas-novato-link-input');
  if(!input)return;
  input.select();
  navigator.clipboard?.writeText(input.value).then(()=>{
    toast('📋 Link copiado — envie só pros testers.');
  }).catch(()=>{
    document.execCommand('copy');
    toast('📋 Link copiado — envie só pros testers.');
  });
}
// Link ÚNICO (sem ?id) do Documento dos Padrinhos — SEPARADO do link de
// tarefas dos testers de propósito: os testers não podem ver o mapeamento
// nem as tarefas uns dos outros, então esse é um link diferente que só vai
// pros padrinhos, com a página documento-padrinhos.html.
function gerarLinkDocumentoPadrinhos(){
  const url=`${location.origin}/documento-padrinhos.html`;
  const input=document.getElementById('documento-padrinhos-link-input');
  if(input)input.value=url;
  openModal('m-documento-padrinhos-link');
}
function copiarLinkDocumentoPadrinhos(){
  const input=document.getElementById('documento-padrinhos-link-input');
  if(!input)return;
  input.select();
  navigator.clipboard?.writeText(input.value).then(()=>{
    toast('📋 Link copiado — envie só pros padrinhos.');
  }).catch(()=>{
    document.execCommand('copy');
    toast('📋 Link copiado — envie só pros padrinhos.');
  });
}
// "Limpar quem não avançou" — mantém no MAPEAMENTO DOS NOVOS só os nomes
// que viraram tester/chatter de verdade (criados via "➕ Criar tester com
// esse nome"); quem nunca virou chatter é removido dos lotes de mapeamento.
function limparMapeamentoNaoSelecionados(){
  const totalAntes=S.mapeamentoBatches.reduce((s,b)=>s+b.results.length,0);
  if(!totalAntes){toast('⚠️ Nenhum mapeamento pra limpar.');return;}
  if(!confirm('Remover do Mapeamento dos Novos todo mundo que ainda não virou tester? Essa ação não pode ser desfeita.'))return;
  S.mapeamentoBatches=S.mapeamentoBatches.map(b=>({
    ...b,
    results:b.results.filter(r=>S.chatters.some(ch=>normalizeName(ch.name)===normalizeName(r.nome)))
  })).filter(b=>b.results.length);
  const totalDepois=S.mapeamentoBatches.reduce((s,b)=>s+b.results.length,0);
  save();
  toast(`🧹 ${totalAntes-totalDepois} pessoa${totalAntes-totalDepois!==1?'s':''} removida${totalAntes-totalDepois!==1?'s':''} do Mapeamento dos Novos.`);
  renderMapeamentoNovosPool();
}
// 10/08/2026 — achado pela gestora: o quadro de Deserções recentes mostrava
// o mesmo "Fulano deserdou Beltrano" duplicado várias vezes, sempre com o
// mesmo horário. Causa: ela usa o app em mais de um dispositivo ao mesmo
// tempo (computador + celular), cada um com sua PRÓPRIA escuta (onSnapshot)
// nas coleções "...Pendente" — sem proteção, os dois liam processado:false
// e processavam o MESMO pedido antes que qualquer um marcasse processado:true,
// duplicando de verdade o efeito de cada pedido (não só na tela, no dado
// mesmo). Toda função aplicarXPendente(docId,data) abaixo agora começa
// chamando claimPendenteDoc(docId) — uma transação do Firestore que só deixa
// UM dispositivo "ganhar o direito" de aplicar aquele pedido; o outro
// descobre que já foi marcado processado e não faz nada.
function claimPendenteDoc(docId){
  if(!fbDb)return Promise.resolve(false);
  const ref=fbDb.collection('gestorpro').doc(docId);
  return fbDb.runTransaction(tx=>tx.get(ref).then(snap=>{
    if(!snap.exists||snap.data().processado===true)return false;
    tx.update(ref,{processado:true});
    return true;
  })).catch(e=>{
    console.error('Erro ao reservar pedido pendente '+docId,e);
    return false;
  });
}
// Escuta a coleção 'gestorpro' filtrando só os documentos que a página
// pública avaliacao.html cria (type:'avaliacaoPendente', processado:false).
// Cada um vira, sozinho, uma Avaliação de Chatter aplicada — sem PDF, sem
// importar nada na mão. Chamado uma vez em initFirebase(), junto do resto
// da sincronização.
function listenToAvaliacoesPendentes(){
  if(!fbDb)return;
  fbDb.collection('gestorpro')
    .where('type','==','avaliacaoPendente')
    .where('processado','==',false)
    .onSnapshot((snap)=>{
      snap.docChanges().forEach(change=>{
        if(change.type!=='added')return;
        aplicarAvaliacaoPendente(change.doc.id,change.doc.data());
      });
    },(err)=>{
      console.error('Erro ao ouvir avaliações pendentes',err);
    });
}
async function aplicarAvaliacaoPendente(docId,data){
  // A pedido da gestora (07/08/2026): o relatório de avaliação do padrinho
  // continua sendo processado e registrado mesmo depois que o tester já foi
  // aprovado ou reprovado — de propósito, sem checar testerDecision aqui.
  // Só o chatter em si precisa existir (não foi apagado); a decisão que já
  // foi tomada não impede o registro do relatório.
  if(!(await claimPendenteDoc(docId)))return; // outro dispositivo já pegou esse pedido
  try{
    const c=S.chatters.find(ch=>ch.id===data.chatterId);
    if(!c){
      // Chatter pode ter sido removido nesse meio tempo — marca como
      // processado mesmo assim, pra não ficar tentando de novo pra sempre.
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'chatter não encontrado'});
      return;
    }
    const ev=ensureMandamentosEval(c.id);
    const criterios=data.criterios||{};
    let preenchidos=0;
    MANDAMENTOS_CRITERIOS.forEach(crit=>{
      const recebido=criterios[crit.id];
      if(!recebido||!recebido.status)return;
      ev[crit.id]={status:recebido.status,nota:recebido.nota||''};
      preenchidos++;
    });
    if(data.observacoesGerais)S.chatterFichas[c.id].padrinhoObservacoesGerais=data.observacoesGerais;
    if(data.padrinhoNome){
      const norm=s=>(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();
      const padrinhoMatch=S.chatters.find(ch=>(ch.level==='padrinho'||ch.isPadrinho)&&norm(ch.name)===norm(data.padrinhoNome));
      if(padrinhoMatch)S.chatterFichas[c.id].padrinhoId=padrinhoMatch.id;
    }
    save();
    toast(`✅ Avaliação de ${c.name} recebida via link — ${preenchidos}/${MANDAMENTOS_CRITERIOS.length} critérios aplicados automaticamente.`);
    if(currentViewName()==='testers'){
      const sel=document.getElementById('tester-select');
      if(sel&&sel.value===c.id)renderTesterDetail(c.id);
    }
    fbDb.collection('gestorpro').doc(docId).update({processado:true}).catch(e=>console.error('Erro ao marcar avaliação como processada',e));
  }catch(e){
    console.error('Erro ao aplicar avaliação pendente',e);
  }
}

/* ===========================================================
   TAREFAS DE NOVATO — link público único (tarefas-novato.html) onde
   cada tester preenche as tarefas do dia (Sexta/Sábado/Domingo) e os
   padrinhos veem tudo junto num "documento" ao vivo. A página pública
   escreve na mesma coleção 'gestorpro', marcada com
   type:'tarefaNovatoPendente' e processado:false — igual ao padrão da
   Avaliação/ChatLab. O nome do tester vem junto (não o id, já que a
   página não pede login) e é casado por nome normalizado com
   S.chatters — mesma tolerância a acento/caixa usada em toda a
   importação do relatório.
   =========================================================== */
function listenToTarefasNovatoPendentes(){
  if(!fbDb)return;
  fbDb.collection('gestorpro')
    .where('type','==','tarefaNovatoPendente')
    .where('processado','==',false)
    .onSnapshot((snap)=>{
      snap.docChanges().forEach(change=>{
        if(change.type!=='added')return;
        aplicarTarefaNovatoPendente(change.doc.id,change.doc.data());
      });
    },(err)=>{
      console.error('Erro ao ouvir tarefas de novato pendentes',err);
    });
}
async function aplicarTarefaNovatoPendente(docId,data){
  if(!(await claimPendenteDoc(docId)))return;
  try{
    const c=data.testerId
      ?S.chatters.find(ch=>ch.id===data.testerId)
      :S.chatters.find(ch=>normalizeName(ch.name)===normalizeName(data.testerNome));
    if(!c){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'tester não encontrado'});
      return;
    }
    // Tarefas de tester moram na fatia própria S.tarefasNovatoPorTester (não
    // mais dentro de chatterFichas) — documento Firestore dedicado, sem
    // dividir o orçamento de ~1MB com o histórico de todo mundo já
    // contratado (ver comentário em SHARD_FIELDS).
    if(!S.tarefasNovatoPorTester[c.id])S.tarefasNovatoPorTester[c.id]={};
    const fk=data.fridayKey;
    const diaN=data.dia;
    if(!fk||!diaN){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'ciclo/dia ausente'});
      return;
    }
    if(!S.tarefasNovatoPorTester[c.id][fk])S.tarefasNovatoPorTester[c.id][fk]={};
    S.tarefasNovatoPorTester[c.id][fk]['dia'+diaN]={
      resumo:data.resumo||'',
      disponibilidade:data.disponibilidade||'',
      cincoNotadas:data.cincoNotadas||'', // só usado no Dia 2
      // 10/08/2026 — a gestora decidiu não guardar mais a imagem do print em
      // lugar nenhum: a página pública já lê o resultado com IA e manda só o
      // TEXTO (ppmResultado). ppmImage/ppmUrl continuam aceitos só por
      // compatibilidade com registros enviados antes dessa mudança.
      ppmResultado:data.ppmResultado||'',
      ppmImage:data.ppmImage||'',
      ppmUrl:data.ppmUrl||'',
      enviadoEm:new Date().toISOString()
    };
    // Poda ciclos antigos — a pedido da gestora: garantir pelo menos 15
    // tarefas (1 foto do PPM por dia) guardadas por tester enquanto a
    // decisão ainda não é final — dá mais histórico pra decidir. Conta de
    // trás pra frente (ciclo mais recente primeiro) até acumular 15 tarefas
    // e só então apaga os ciclos inteiros mais antigos que sobrarem. Assim
    // que a decisão é tomada (aprovado/reprovado/reserva), tudo isso é
    // apagado de qualquer forma pelo setTesterDecision — essa poda aqui só
    // protege quem ainda está em processo.
    const ciclosSalvos=Object.keys(S.tarefasNovatoPorTester[c.id]).sort();
    let totalTarefas=0,manterAPartirDe=ciclosSalvos.length;
    for(let i=ciclosSalvos.length-1;i>=0;i--){
      totalTarefas+=Object.keys(S.tarefasNovatoPorTester[c.id][ciclosSalvos[i]]).length;
      manterAPartirDe=i;
      if(totalTarefas>=15)break;
    }
    ciclosSalvos.slice(0,manterAPartirDe).forEach(old=>delete S.tarefasNovatoPorTester[c.id][old]);
    save();
    toast(`📋 Tarefa do Dia ${diaN} de ${c.name} recebida via link.`);
    if(currentViewName()==='testers')renderTesters();
    fbDb.collection('gestorpro').doc(docId).update({processado:true}).catch(e=>console.error('Erro ao marcar tarefa de novato como processada',e));
  }catch(e){
    console.error('Erro ao aplicar tarefa de novato pendente',e);
  }
}

/* ===========================================================
   SOLICITAÇÃO DE AFILHADO — no mesmo documento de tarefas, os
   padrinhos marcam quem querem apadrinhar (visível em tempo real pra
   todos os padrinhos, já que todos leem/escrevem a mesma coleção). Vira
   um quadro novo na aba Testers com decisão PRÓPRIA (aprovar/reprovar/
   reservar), separada da decisão normal de tester (aprovado/reprovado/
   reservas) — a gestora decide se aquele apadrinhamento específico vale.
   =========================================================== */
function listenToAfilhadoClaimsPendentes(){
  if(!fbDb)return;
  fbDb.collection('gestorpro')
    .where('type','==','afilhadoClaimPendente')
    .where('processado','==',false)
    .onSnapshot((snap)=>{
      snap.docChanges().forEach(change=>{
        if(change.type!=='added')return;
        aplicarAfilhadoClaimPendente(change.doc.id,change.doc.data());
      });
    },(err)=>{
      console.error('Erro ao ouvir solicitações de afilhado pendentes',err);
    });
}
async function aplicarAfilhadoClaimPendente(docId,data){
  if(!(await claimPendenteDoc(docId)))return;
  try{
    const tester=data.testerId
      ?S.chatters.find(ch=>ch.id===data.testerId)
      :S.chatters.find(ch=>normalizeName(ch.name)===normalizeName(data.testerNome));
    const padrinho=data.padrinhoId
      ?S.chatters.find(ch=>ch.id===data.padrinhoId)
      :S.chatters.find(ch=>(ch.level==='padrinho'||ch.isPadrinho)&&normalizeName(ch.name)===normalizeName(data.padrinhoNome));
    if(!tester){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'tester não encontrado'});
      return;
    }
    // Um tester só pode ter UMA solicitação em aberto por vez — se já existe
    // uma pendente/aprovada pra esse tester, não duplica (o padrinho que
    // reivindicar primeiro é quem aparece; a gestora decide no app).
    const jaExiste=S.afilhadoClaims.find(cl=>cl.testerId===tester.id&&['pendente','aprovado'].includes(cl.status));
    if(jaExiste){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'já existe solicitação em aberto pra esse tester'});
      return;
    }
    S.afilhadoClaims.push({
      id:'afc'+Date.now(),
      testerId:tester.id,
      testerNome:tester.name,
      padrinhoId:padrinho?.id||'',
      padrinhoNome:padrinho?.name||data.padrinhoNome||'',
      status:'pendente',
      criadoEm:new Date().toISOString()
    });
    save();
    toast(`🤝 ${padrinho?.name||data.padrinhoNome||'Um padrinho'} quer apadrinhar ${tester.name} — decida em Testers → Solicitação de Afilhado.`);
    if(currentViewName()==='testers')renderTesters();
    fbDb.collection('gestorpro').doc(docId).update({processado:true}).catch(e=>console.error('Erro ao marcar solicitação de afilhado como processada',e));
  }catch(e){
    console.error('Erro ao aplicar solicitação de afilhado pendente',e);
  }
}

/* ===========================================================
   AUTOINCLUSÃO SEM MAPEAMENTO — botão "Não achei meu nome" no link
   de tarefas (tarefas-novato.html), pra quem devia ter Mapeamento
   feito mas por algum motivo não está na lista. Cria um tester
   pendente de aprovação do padrinho, igual qualquer outro caminho de
   criação de tester (nunca pula a aprovação).
   =========================================================== */
function listenToTesterAutoInclusaoPendentes(){
  if(!fbDb)return;
  fbDb.collection('gestorpro')
    .where('type','==','testerAutoInclusaoPendente')
    .where('processado','==',false)
    .onSnapshot((snap)=>{
      snap.docChanges().forEach(change=>{
        if(change.type!=='added')return;
        aplicarTesterAutoInclusaoPendente(change.doc.id,change.doc.data());
      });
    },(err)=>{
      console.error('Erro ao ouvir autoinclusões de tester pendentes',err);
    });
}
async function aplicarTesterAutoInclusaoPendente(docId,data){
  if(!(await claimPendenteDoc(docId)))return;
  try{
    const nome=(data.nome||'').trim();
    if(!nome){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'nome vazio'});
      return;
    }
    // Usa o MESMO id que o link público já gerou e mostrou pro tester na
    // hora (ver enviarAutoinclusao em tarefas-novato.html) — assim a página
    // dele, que já foi direto pra tela de tarefas de forma otimista, casa
    // certinho com esse registro real assim que sincronizar de volta, sem
    // duplicar nem trocar de id no meio do caminho.
    const chatterId=data.chatterId||('c'+Date.now()+Math.random().toString(36).slice(2,4));
    if(S.chatters.some(c=>c.id===chatterId)){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'id já existe'});
      return;
    }
    S.chatters.push({
      // A pedido da gestora: quem se autoinclui (porque não achou o nome)
      // NÃO espera aprovação pra começar a fazer as tarefas — ela se
      // cadastra e já pode fazer, os padrinhos só acompanham o que ela
      // envia (pendenteAprovacao:false, diferente do fluxo com Mapeamento).
      id:chatterId,name:nome,discord:'',level:'teste',time:'tester',pendenteAprovacao:false,
      notes:'Autoincluído pelo link de tarefas (sem Mapeamento) — já pode fazer as tarefas normalmente; os padrinhos acompanham o envio.',
      watchtime:'',createdAt:new Date().toISOString()
    });
    save();
    toast(`🙋 ${nome} se autoincluiu no link de tarefas (sem Mapeamento) — já pode fazer as tarefas.`);
    if(currentViewName()==='testers')renderTesters();
    fbDb.collection('gestorpro').doc(docId).update({processado:true,chatterId}).catch(e=>console.error('Erro ao marcar autoinclusão como processada',e));
  }catch(e){
    console.error('Erro ao aplicar autoinclusão de tester pendente',e);
  }
}

/* ===========================================================
   DADOS INFORMADOS PELO PRÓPRIO TESTER — nome/idade/cidade/
   experiência/pretensão salarial, preenchidos no link de tarefas por
   QUALQUER pessoa respondendo (veio de Mapeamento ou autoinclusão).
   Guardado no próprio chatter (visível no link também, sem precisar
   ler fichas) — nunca sobrescreve o que já veio de Mapeamento real,
   só complementa quando estiver vazio.
   =========================================================== */
function listenToTesterDadosPendentes(){
  if(!fbDb)return;
  fbDb.collection('gestorpro')
    .where('type','==','testerDadosPendente')
    .where('processado','==',false)
    .onSnapshot((snap)=>{
      snap.docChanges().forEach(change=>{
        if(change.type!=='added')return;
        aplicarTesterDadosPendente(change.doc.id,change.doc.data());
      });
    },(err)=>{
      console.error('Erro ao ouvir dados de tester pendentes',err);
    });
}
async function aplicarTesterDadosPendente(docId,data){
  if(!(await claimPendenteDoc(docId)))return;
  try{
    const c=data.testerId?S.chatters.find(ch=>ch.id===data.testerId):null;
    if(!c){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'tester não encontrado'});
      return;
    }
    c.dadosAutoInformados={
      sobreVoce:data.sobreVoce||'',
      atualizadoEm:new Date().toISOString()
    };
    save();
    toast(`📝 Dados pessoais de ${c.name} atualizados via link de tarefas.`);
    if(currentViewName()==='testers')renderTesters();
    fbDb.collection('gestorpro').doc(docId).update({processado:true}).catch(e=>console.error('Erro ao marcar dados de tester como processados',e));
  }catch(e){
    console.error('Erro ao aplicar dados de tester pendente',e);
  }
}

/* ===========================================================
   DADOS PJ — coletados no link de tarefas SÓ depois que a pessoa é
   aprovada (testerDecision==='aprovado'). Fica na ficha (não no
   chatter) porque é dado sensível (CNPJ, pix, endereço) e só a
   gestora precisa ver — nunca volta pro link público depois de salvo.
   =========================================================== */
function listenToDadosPjPendentes(){
  if(!fbDb)return;
  fbDb.collection('gestorpro')
    .where('type','==','dadosPjPendente')
    .where('processado','==',false)
    .onSnapshot((snap)=>{
      snap.docChanges().forEach(change=>{
        if(change.type!=='added')return;
        aplicarDadosPjPendente(change.doc.id,change.doc.data());
      });
    },(err)=>{
      console.error('Erro ao ouvir dados PJ pendentes',err);
    });
}
async function aplicarDadosPjPendente(docId,data){
  if(!(await claimPendenteDoc(docId)))return;
  try{
    const c=data.testerId?S.chatters.find(ch=>ch.id===data.testerId):null;
    if(!c){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'tester não encontrado'});
      return;
    }
    if(!S.chatterFichas[c.id])S.chatterFichas[c.id]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
    S.chatterFichas[c.id].dadosPJ={
      razaoSocial:data.razaoSocial||'',nickname:data.nickname||'',cnpj:data.cnpj||'',
      endereco:data.endereco||'',numero:data.numero||'',bairro:data.bairro||'',cep:data.cep||'',
      telefone:data.telefone||'',email:data.email||'',pix:data.pix||'',bancoChave:data.bancoChave||'',
      falaIngles:data.falaIngles||'',
      trelloEmail:data.trelloEmail||'',telegramNumero:data.telegramNumero||'',telegramNome:data.telegramNome||'',
      // 10/08/2026 — a pedido da gestora (caso do Wesley, que usou CNPJ de
      // familiar): o link já confere automaticamente na Receita se o CNPJ
      // bate com o nome de quem preencheu, e manda esse resultado junto.
      cnpjVerificado:!!data.cnpjVerificado,cnpjRazaoSocialReceita:data.cnpjRazaoSocialReceita||'',
      recebidoEm:new Date().toISOString()
    };
    // Espelha também no nível de cima da Ficha (falaIngles), não só dentro de
    // dadosPJ — é o mesmo campo que a gestora pode setar manualmente pra
    // chatters já efetivados (que nunca passaram pelo form de tester), então
    // os dois caminhos escrevem no mesmo lugar e a Ficha mostra sempre daqui.
    if(data.falaIngles)S.chatterFichas[c.id].falaIngles=data.falaIngles;
    // Espelha só um FLAG (sem nenhum dado sensível) no chatter — é o que o
    // link público de tarefas usa pra saber que já pode trocar o formulário
    // de PJ pela mensagem de aprovado + seletor de horário, sem esperar a
    // gestora abrir a Ficha. O CNPJ/pix/endereço em si nunca saem daqui.
    c.dadosPjRecebidos=true;
    // Nickname (=user do Telegram, ver campo no form) TAMBÉM é espelhado no
    // chatter (não sensível, ao contrário do resto) — a pedido da gestora
    // (06/08/2026), pra aparecer junto com as outras informações no link dos
    // padrinhos (documento-padrinhos.html).
    c.nicknameTelegram=data.nickname||'';
    save();
    toast(`📋 Dados de PJ de ${c.name} recebidos via link.`);
    if(currentViewName()==='testers')renderTesters();
    fbDb.collection('gestorpro').doc(docId).update({processado:true}).catch(e=>console.error('Erro ao marcar dados PJ como processados',e));
  }catch(e){
    console.error('Erro ao aplicar dados PJ pendente',e);
  }
}

/* ===========================================================
   SEGUNDA CHANCE — tester perdeu o prazo de um dia por imprevisto,
   pede justificativa; padrinho aprova/recusa no Documento dos
   Padrinhos. Se aprovar, o dia volta a ficar liberado pro tester
   enviar (espelhado no chatter em segundaChanceAprovadas, porque o
   link de tarefas só recebe o array de chatters, não as fichas).
   =========================================================== */
function listenToSegundaChancePendentes(){
  if(!fbDb)return;
  fbDb.collection('gestorpro')
    .where('type','==','segundaChancePendente')
    .where('processado','==',false)
    .onSnapshot((snap)=>{
      snap.docChanges().forEach(change=>{
        if(change.type!=='added')return;
        aplicarSegundaChancePendente(change.doc.id,change.doc.data());
      });
    },(err)=>{
      console.error('Erro ao ouvir pedidos de segunda chance pendentes',err);
    });
}
async function aplicarSegundaChancePendente(docId,data){
  if(!(await claimPendenteDoc(docId)))return;
  try{
    const c=data.testerId?S.chatters.find(ch=>ch.id===data.testerId):null;
    if(!c||!data.fridayKey||!data.dia){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'tester ou dia ausente'});
      return;
    }
    if(!S.chatterFichas[c.id])S.chatterFichas[c.id]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
    if(!Array.isArray(S.chatterFichas[c.id].segundaChanceRequests))S.chatterFichas[c.id].segundaChanceRequests=[];
    S.chatterFichas[c.id].segundaChanceRequests.push({
      id:'sc'+Date.now(),fridayKey:data.fridayKey,dia:data.dia,
      justificativa:data.justificativa||'',status:'pendente',criadoEm:new Date().toISOString()
    });
    save();
    toast(`🙏 ${c.name} pediu segunda chance no Dia ${data.dia} — padrinho decide no Documento dos Padrinhos.`);
    if(currentViewName()==='testers')renderTesters();
    fbDb.collection('gestorpro').doc(docId).update({processado:true}).catch(e=>console.error('Erro ao marcar pedido de segunda chance como processado',e));
  }catch(e){
    console.error('Erro ao aplicar pedido de segunda chance pendente',e);
  }
}
function listenToSegundaChanceDecisoesPendentes(){
  if(!fbDb)return;
  fbDb.collection('gestorpro')
    .where('type','==','segundaChanceDecisaoPendente')
    .where('processado','==',false)
    .onSnapshot((snap)=>{
      snap.docChanges().forEach(change=>{
        if(change.type!=='added')return;
        aplicarSegundaChanceDecisaoPendente(change.doc.id,change.doc.data());
      });
    },(err)=>{
      console.error('Erro ao ouvir decisões de segunda chance pendentes',err);
    });
}
async function aplicarSegundaChanceDecisaoPendente(docId,data){
  if(!(await claimPendenteDoc(docId)))return;
  try{
    const c=data.testerId?S.chatters.find(ch=>ch.id===data.testerId):null;
    const reqs=c&&S.chatterFichas[c.id]?S.chatterFichas[c.id].segundaChanceRequests||[]:[];
    const req=reqs.find(r=>r.fridayKey===data.fridayKey&&r.dia===data.dia&&r.status==='pendente');
    if(!c||!req){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'tester ou solicitação não encontrada'});
      return;
    }
    req.status=data.decisao==='aprovado'?'aprovado':'recusado';
    req.decididoEm=new Date().toISOString();
    req.padrinhoNome=data.padrinhoNome||'';
    if(data.decisao==='aprovado'){
      if(!Array.isArray(c.segundaChanceAprovadas))c.segundaChanceAprovadas=[];
      c.segundaChanceAprovadas.push({fridayKey:data.fridayKey,dia:data.dia});
    }
    save();
    toast(`${data.decisao==='aprovado'?'✅':'❌'} Segunda chance do Dia ${data.dia} de ${c.name} ${data.decisao==='aprovado'?'aprovada':'recusada'} por ${data.padrinhoNome||'padrinho'}.`);
    if(currentViewName()==='testers')renderTesters();
    fbDb.collection('gestorpro').doc(docId).update({processado:true}).catch(e=>console.error('Erro ao marcar decisão de segunda chance como processada',e));
  }catch(e){
    console.error('Erro ao aplicar decisão de segunda chance pendente',e);
  }
}

/* ===========================================================
   EXCLUSÃO DE TESTER PELO LINK DOS PADRINHOS — pedido da gestora pra
   os próprios padrinhos organizarem o site e apagarem nomes duplicados
   que nunca chegaram a fazer nenhuma tarefa (sobras de autoinclusão
   repetida). O link dos padrinhos nunca apaga nada sozinho: ele só
   registra o PEDIDO (excluirTesterPendente) e é o app principal quem
   decide se aplica — e só aplica se, de fato, essa pessoa nunca teve
   nenhuma decisão (aprovado/reprovado/espera) nem nenhuma tarefa nem
   registro real. Assim um padrinho nunca consegue apagar histórico de
   verdade por engano ou clique errado — pedido explícito da gestora
   pra tomar cuidado extremo aqui.
   =========================================================== */
function listenToExclusoesTesterPendentes(){
  if(!fbDb)return;
  fbDb.collection('gestorpro')
    .where('type','==','excluirTesterPendente')
    .where('processado','==',false)
    .onSnapshot((snap)=>{
      snap.docChanges().forEach(change=>{
        if(change.type!=='added')return;
        aplicarExclusaoTesterPendente(change.doc.id,change.doc.data());
      });
    },(err)=>{
      console.error('Erro ao ouvir exclusões de tester pendentes',err);
    });
}
async function aplicarExclusaoTesterPendente(docId,data){
  if(!(await claimPendenteDoc(docId)))return;
  try{
    const id=data.testerId;
    const c=id?S.chatters.find(ch=>ch.id===id):null;
    if(!c){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'tester não encontrado (talvez já excluído)'});
      return;
    }
    const temDecisao=!!c.testerDecision;
    const tarefas=(S.tarefasNovatoPorTester&&S.tarefasNovatoPorTester[id])||{};
    const temTarefaEnviada=Object.keys(tarefas).some(fk=>Object.keys(tarefas[fk]||{}).some(k=>tarefas[fk][k]&&tarefas[fk][k].enviadoEm));
    const temLog=((S.testerLogs&&S.testerLogs[id])||[]).length>0;
    if(temDecisao||temTarefaEnviada||temLog){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'bloqueado: já tem tarefa/decisão/registro real — não apaguei por segurança'});
      toast(`⚠️ ${data.padrinhoNome||'Um padrinho'} tentou excluir "${c.name}" pelo link, mas já tem tarefa/decisão registrada — bloqueei por segurança.`);
      return;
    }
    S.chatters=S.chatters.filter(ch=>ch.id!==id);
    delete S.chatterFichas[id];
    delete S.testerLogs[id];
    if(S.tarefasNovatoPorTester)delete S.tarefasNovatoPorTester[id];
    save();
    toast(`🗑️ ${data.padrinhoNome||'Um padrinho'} removeu "${data.testerNome||c.name}" (nome duplicado, sem tarefa) pelo link dos padrinhos.`);
    if(currentViewName()==='testers')renderTesters();
    fbDb.collection('gestorpro').doc(docId).update({processado:true}).catch(e=>console.error('Erro ao marcar exclusão de tester como processada',e));
  }catch(e){
    console.error('Erro ao aplicar exclusão de tester pendente',e);
  }
}

/* ===========================================================
   EXCLUIR AFILHADO PELO LINK DOS PADRINHOS — 10/08/2026, a pedido da
   gestora: faltava um X pra tirar um afilhado já apadrinhado (diferente
   do excluirTesterPendente acima, que só serve pra nomes duplicados sem
   nenhum progresso). Igual todo pedido vindo do link, o padrinho só
   registra — quem aplica é o app principal. E, diferente de um delete de
   verdade, isso só ARQUIVA (arquivadoTesters=true, mesmo mecanismo do
   botão de swipe/🗑️ da aba Testers): a pessoa some da lista da gestora,
   mas ficha, tarefas e histórico continuam intactos — se for pra apagar
   de vez, a gestora decide isso manualmente pelo 🗑️ na aba Testers.
   =========================================================== */
function listenToExclusoesAfilhadoPendentes(){
  if(!fbDb)return;
  fbDb.collection('gestorpro')
    .where('type','==','excluirAfilhadoPendente')
    .where('processado','==',false)
    .onSnapshot((snap)=>{
      snap.docChanges().forEach(change=>{
        if(change.type!=='added')return;
        aplicarExclusaoAfilhadoPendente(change.doc.id,change.doc.data());
      });
    },(err)=>{
      console.error('Erro ao ouvir exclusões de afilhado pendentes',err);
    });
}
async function aplicarExclusaoAfilhadoPendente(docId,data){
  if(!(await claimPendenteDoc(docId)))return;
  try{
    const id=data.testerId;
    const c=id?S.chatters.find(ch=>ch.id===id):null;
    const ficha=id?S.chatterFichas?.[id]:null;
    if(!c||!ficha){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'tester não encontrado'});
      return;
    }
    ficha.arquivadoTesters=true;
    save();
    toast(`✕ ${data.padrinhoNome||'Um padrinho'} excluiu "${c.name}" da lista de afilhados pelo link — nada foi apagado, só arquivado.`);
    if(currentViewName()==='testers')renderTesters();
    fbDb.collection('gestorpro').doc(docId).update({processado:true}).catch(e=>console.error('Erro ao marcar exclusão de afilhado como processada',e));
  }catch(e){
    console.error('Erro ao aplicar exclusão de afilhado pendente',e);
  }
}

/* ===========================================================
   DESERDAR — o padrinho aprovado pode liberar um afilhado que já
   apadrinhou (pra outro assumir num próximo domingo, ou porque não vai
   mais acompanhar). Mesmo padrão dos outros pedidos vindos do link dos
   padrinhos: só registra o pedido, quem aplica é o app principal.
   =========================================================== */
function listenToDeserdarPendentes(){
  if(!fbDb)return;
  fbDb.collection('gestorpro')
    .where('type','==','deserdarPendente')
    .where('processado','==',false)
    .onSnapshot((snap)=>{
      snap.docChanges().forEach(change=>{
        if(change.type!=='added')return;
        aplicarDeserdarPendente(change.doc.id,change.doc.data());
      });
    },(err)=>{
      console.error('Erro ao ouvir pedidos de deserdar pendentes',err);
    });
}
async function aplicarDeserdarPendente(docId,data){
  if(!(await claimPendenteDoc(docId)))return;
  try{
    const id=data.testerId;
    const c=id?S.chatters.find(ch=>ch.id===id):null;
    const ficha=id?S.chatterFichas?.[id]:null;
    if(!c||!ficha||ficha.padrinhoId!==data.padrinhoId){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'tester não encontrado ou padrinho não confere mais'});
      return;
    }
    const padrinhoNomeAntigo=c.padrinhoNome||data.padrinhoNome||'';
    ficha.padrinhoId='';
    tombstoneField('chatterFichas.'+id+'.padrinhoId');
    c.temPadrinho=false;
    c.padrinhoNome='';
    // Registro persistente — o toast() abaixo só aparece se o app estiver
    // aberto e visível NA HORA EXATA em que isso acontece (achado em
    // 03/08/2026: José deserdou o Fred e a gestora nunca viu nenhum aviso,
    // porque o toast já tinha sumido da tela). Guarda os últimos 20 pra
    // sempre dar pra conferir depois no quadro da aba Testers.
    if(!Array.isArray(S.deserdarHistorico))S.deserdarHistorico=[];
    S.deserdarHistorico.unshift({
      id:'des_'+Date.now()+Math.random().toString(36).slice(2),
      testerId:id,testerNome:c.name,
      padrinhoNome:padrinhoNomeAntigo||'Um padrinho',
      quando:new Date().toISOString()
    });
    S.deserdarHistorico=S.deserdarHistorico.slice(0,20);
    save();
    toast(`💔 ${padrinhoNomeAntigo||'Um padrinho'} deserdou "${c.name}" — volta pra lista de quem ainda não tem padrinho.`);
    if(currentViewName()==='testers'){renderTesters();renderAfilhadoClaims();}
    fbDb.collection('gestorpro').doc(docId).update({processado:true}).catch(e=>console.error('Erro ao marcar deserdar como processado',e));
  }catch(e){
    console.error('Erro ao aplicar pedido de deserdar pendente',e);
  }
}

/* ===========================================================
   HORÁRIO DE TESTE — a pedido da gestora (03/08/2026), em vez de
   "entraremos em contato pra marcar horário" o próprio tester escolhe 1 dos
   6 horários disponíveis (2 grupos de 3 dias × 3 opções) direto no link de
   tarefas, assim que aprovado — ou vê o horário fixo (caso do Victor,
   combinado manualmente fora do sistema de vagas). Guarda só
   {slotId,label,escolhidoEm} no CHATTER (não na ficha) — é um dado simples,
   sem nada sensível, e precisa estar no array de chatters mesmo pra
   sincronizar tanto com o link de tarefas (saber quais vagas já foram
   ocupadas por outros) quanto com o documento dos padrinhos (avisar o
   padrinho quando o afilhado escolhe).
   =========================================================== */
function listenToHorarioTestePendentes(){
  if(!fbDb)return;
  fbDb.collection('gestorpro')
    .where('type','==','horarioTestePendente')
    .where('processado','==',false)
    .onSnapshot((snap)=>{
      snap.docChanges().forEach(change=>{
        if(change.type!=='added')return;
        aplicarHorarioTestePendente(change.doc.id,change.doc.data());
      });
    },(err)=>{
      console.error('Erro ao ouvir horários de teste pendentes',err);
    });
}
async function aplicarHorarioTestePendente(docId,data){
  if(!(await claimPendenteDoc(docId)))return;
  try{
    const c=data.testerId?S.chatters.find(ch=>ch.id===data.testerId):null;
    if(!c){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'tester não encontrado'});
      return;
    }
    c.horarioTeste={slotId:data.slotId||'',label:data.slotLabel||'',escolhidoEm:new Date().toISOString()};
    save();
    toast(`🗓️ ${c.name} escolheu o horário de teste: ${data.slotLabel||''}`);
    if(currentViewName()==='testers')renderTesters();
    fbDb.collection('gestorpro').doc(docId).update({processado:true}).catch(e=>console.error('Erro ao marcar horário de teste como processado',e));
  }catch(e){
    console.error('Erro ao aplicar horário de teste pendente',e);
  }
}

/* ===========================================================
   ENTREVISTA POR VIDEOCHAMADA — a pedido da gestora (07/08/2026):
   logo abaixo da tarefa de Domingo (Dia 3), o tester marca o horário da
   entrevista obrigatória (sempre no próprio Domingo, 19h-1h, de 30 em 30
   min, vagas exclusivas — mesmo padrão do horário de teste). Espelha no
   CHATTER (c.entrevista={slotId,label,agendadoEm}) pra sincronizar com o
   link de tarefas (saber quais vagas já foram ocupadas) e aparecer aqui
   na Solicitação de Afilhado — é exatamente ali que a gestora aprova e
   só depois disso a pessoa vira afilhado do padrinho e segue pras
   páginas seguintes (dados PJ, horário de teste, Seja bem-vindo).
   =========================================================== */
function listenToEntrevistaPendentes(){
  if(!fbDb)return;
  fbDb.collection('gestorpro')
    .where('type','==','entrevistaPendente')
    .where('processado','==',false)
    .onSnapshot((snap)=>{
      snap.docChanges().forEach(change=>{
        if(change.type!=='added')return;
        aplicarEntrevistaPendente(change.doc.id,change.doc.data());
      });
    },(err)=>{
      console.error('Erro ao ouvir entrevistas pendentes',err);
    });
}
async function aplicarEntrevistaPendente(docId,data){
  if(!(await claimPendenteDoc(docId)))return;
  try{
    const c=data.testerId?S.chatters.find(ch=>ch.id===data.testerId):null;
    if(!c){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'tester não encontrado'});
      return;
    }
    c.entrevista={slotId:data.slotId||'',label:data.slotLabel||'',agendadoEm:new Date().toISOString()};
    save();
    toast(`🎥 ${c.name} marcou a entrevista: Domingo, ${data.slotLabel||''}`);
    if(currentViewName()==='testers')renderTesters();
    fbDb.collection('gestorpro').doc(docId).update({processado:true}).catch(e=>console.error('Erro ao marcar entrevista como processada',e));
  }catch(e){
    console.error('Erro ao aplicar entrevista pendente',e);
  }
}

/* ===========================================================
   DISCORD DO TESTER — a pedido da gestora (10/08/2026): passo novo entre
   dados PJ e escolha de horário, no link de tarefas. Guarda no CHATTER
   (c.discordUsername), simples e não sensível, igual ao nicknameTelegram —
   é assim que o Documento dos Padrinhos (modo "Henrique Peres/Entrevista")
   consegue mostrar o Discord de cada tester sem precisar de mais infra.
   =========================================================== */
function listenToDiscordPendentes(){
  if(!fbDb)return;
  fbDb.collection('gestorpro')
    .where('type','==','discordPendente')
    .where('processado','==',false)
    .onSnapshot((snap)=>{
      snap.docChanges().forEach(change=>{
        if(change.type!=='added')return;
        aplicarDiscordPendente(change.doc.id,change.doc.data());
      });
    },(err)=>{
      console.error('Erro ao ouvir Discord pendente',err);
    });
}
async function aplicarDiscordPendente(docId,data){
  if(!(await claimPendenteDoc(docId)))return;
  try{
    const c=data.testerId?S.chatters.find(ch=>ch.id===data.testerId):null;
    if(!c){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'tester não encontrado'});
      return;
    }
    c.discordUsername=data.discordUsername||'';
    save();
    if(currentViewName()==='testers')renderTesters();
    fbDb.collection('gestorpro').doc(docId).update({processado:true}).catch(e=>console.error('Erro ao marcar Discord como processado',e));
  }catch(e){
    console.error('Erro ao aplicar Discord pendente',e);
  }
}

/* ===========================================================
   DECISÃO DA ENTREVISTA (Henrique Peres) — a pedido da gestora
   (10/08/2026): no Documento dos Padrinhos, quem seleciona o cargo
   "Henrique Peres (Entrevista)" vê todo mundo que já marcou horário de
   teste (de qualquer padrinho) e decide aprovado/reprovado ali mesmo. Essa
   decisão é SEPARADA da decisão da Solicitação de Afilhado (setAfilhadoClaimDecision)
   e do testerDecision final — por pedido explícito, ela só fica registrada
   como resultado pra gestora ver (quadro Solicitação de Afilhado), sem
   mexer em mais nada sozinha. Guardada na FICHA (não no chatter) porque é
   avaliação interna, no mesmo padrão de testerDecision.
   =========================================================== */
function listenToEntrevistaDecisaoPendentes(){
  if(!fbDb)return;
  fbDb.collection('gestorpro')
    .where('type','==','entrevistaDecisaoPendente')
    .where('processado','==',false)
    .onSnapshot((snap)=>{
      snap.docChanges().forEach(change=>{
        if(change.type!=='added')return;
        aplicarEntrevistaDecisaoPendente(change.doc.id,change.doc.data());
      });
    },(err)=>{
      console.error('Erro ao ouvir decisões de entrevista pendentes',err);
    });
}
async function aplicarEntrevistaDecisaoPendente(docId,data){
  if(!(await claimPendenteDoc(docId)))return;
  try{
    const testerId=data.testerId;
    const c=testerId?S.chatters.find(ch=>ch.id===testerId):null;
    if(!c){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'tester não encontrado'});
      return;
    }
    if(!S.chatterFichas[testerId])S.chatterFichas[testerId]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
    S.chatterFichas[testerId].entrevistaDecisao=data.decisao||'';
    S.chatterFichas[testerId].entrevistaDecisaoData=new Date().toISOString();
    save();
    toast(`🎤 Henrique Peres ${data.decisao==='aprovado'?'aprovou':'reprovou'} ${c.name} na entrevista.`);
    if(currentViewName()==='testers')renderAfilhadoClaims();
    fbDb.collection('gestorpro').doc(docId).update({processado:true}).catch(e=>console.error('Erro ao marcar decisão de entrevista como processada',e));
  }catch(e){
    console.error('Erro ao aplicar decisão de entrevista pendente',e);
  }
}

/* ===========================================================
   CHATLAB — autoanálise do chatter (link online, sem login)
   Mesma ideia da Avaliação de Chatter: gera um link
   (chatlab-chatter.html?id=<chatterId>) que o próprio chatter abre,
   cola a conversa e roda a análise da IA sozinho — pra se corrigir no
   dia a dia, em vez de depender só da gestora apontar erro por erro.
   A página pública escreve o registro completo (com Plano de
   Treinamento) na mesma coleção 'gestorpro', marcado com
   type:'chatlabPendente' — o app principal escuta (listenToChatlabPendentes,
   chamado junto do resto em initFirebase) e aplica sozinho no
   S.chatlabAnalyses, marcado com autoAnalise:true pra aparecer
   sinalizado no histórico.
   =========================================================== */
function gerarLinkChatlabChatter(){
  const cid=document.getElementById('cl-chatter')?.value;
  if(!cid){toast('⚠️ Selecione um chatter antes de gerar o link');return;}
  const c=S.chatters.find(ch=>ch.id===cid);
  if(!c)return;
  const url=`${location.origin}/chatlab-chatter.html?id=${encodeURIComponent(cid)}&nome=${encodeURIComponent(c.name)}`;
  const input=document.getElementById('chatlab-link-input');
  if(input)input.value=url;
  openModal('m-chatlab-link');
}
function copiarLinkChatlab(){
  const input=document.getElementById('chatlab-link-input');
  if(!input)return;
  input.select();
  navigator.clipboard?.writeText(input.value).then(()=>{
    toast('📋 Link copiado — envie pro chatter.');
  }).catch(()=>{
    document.execCommand('copy');
    toast('📋 Link copiado — envie pro chatter.');
  });
}
function listenToChatlabPendentes(){
  if(!fbDb)return;
  fbDb.collection('gestorpro')
    .where('type','==','chatlabPendente')
    .where('processado','==',false)
    .onSnapshot((snap)=>{
      snap.docChanges().forEach(change=>{
        if(change.type!=='added')return;
        aplicarChatlabPendente(change.doc.id,change.doc.data());
      });
    },(err)=>{
      console.error('Erro ao ouvir autoanálises pendentes do ChatLab',err);
    });
}
async function aplicarChatlabPendente(docId,data){
  if(!(await claimPendenteDoc(docId)))return;
  try{
    if(!data.chatterId||!data.raw){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'dados incompletos'});
      return;
    }
    // Trava simples contra duplicidade caso o snapshot dispare mais de uma
    // vez pro mesmo documento (não deveria, mas não custa proteger).
    if(S.chatlabAnalyses.some(a=>a.sourceDocId===docId))return;
    const c=S.chatters.find(ch=>ch.id===data.chatterId);
    S.chatlabAnalyses.push({
      id:'cla'+Date.now(),
      chatterId:data.chatterId,
      date:data.date||new Date().toISOString(),
      igp:data.igp||null,
      raw:data.raw,
      resumo:data.resumo||'',
      tags:data.tags||null,
      conv:data.conv||'',
      autoAnalise:true,
      sourceDocId:docId
    });
    save();
    if(currentViewName()==='chatlab'){renderChatLabHistorico();renderChatLabRanking();}
    toast(`🤖 ${c?c.name:'Um chatter'} rodou uma autoanálise no ChatLab — já aplicada`);
    fbDb.collection('gestorpro').doc(docId).update({processado:true}).catch(e=>console.error('Erro ao marcar autoanálise como processada',e));
  }catch(e){
    console.error('Erro ao aplicar autoanálise pendente do ChatLab',e);
  }
}
// Mesmo padrão de fila da autoanálise, só que pro relatório semanal —
// permite que o PRÓPRIO chatter gere o relatório da semana dele direto no
// link público (chatlab-chatter.html), sem precisar da gestora gerar antes.
function listenToRelatoriosSemanaisPendentes(){
  if(!fbDb)return;
  fbDb.collection('gestorpro')
    .where('type','==','chatlabRelatorioPendente')
    .where('processado','==',false)
    .onSnapshot((snap)=>{
      snap.docChanges().forEach(change=>{
        if(change.type!=='added')return;
        aplicarRelatorioSemanalPendente(change.doc.id,change.doc.data());
      });
    },(err)=>{
      console.error('Erro ao ouvir relatórios semanais pendentes',err);
    });
}
async function aplicarRelatorioSemanalPendente(docId,data){
  if(!(await claimPendenteDoc(docId)))return;
  try{
    if(!data.chatterId||!data.rawGestora||!data.weekKey){
      fbDb.collection('gestorpro').doc(docId).update({processado:true,erro:'dados incompletos'});
      return;
    }
    const c=S.chatters.find(ch=>ch.id===data.chatterId);
    if(!S.chatlabWeeklyReports)S.chatlabWeeklyReports={};
    if(!S.chatlabWeeklyReports[data.chatterId])S.chatlabWeeklyReports[data.chatterId]=[];
    S.chatlabWeeklyReports[data.chatterId]=S.chatlabWeeklyReports[data.chatterId].filter(r=>r.weekKey!==data.weekKey);
    S.chatlabWeeklyReports[data.chatterId].push({weekKey:data.weekKey,date:data.date||new Date().toISOString(),rawGestora:data.rawGestora,rawChatter:data.rawChatter||data.rawGestora,generatedBy:'chatter',analisesCount:data.analisesCount||0,metrics:data.metrics||{}});
    save();
    if(currentViewName()==='testers'){
      const sel=document.getElementById('tester-select');
      if(sel&&sel.value===data.chatterId)renderTesterDetail(data.chatterId);
    }
    toast(`📅 ${c?c.name:'Um chatter'} gerou o relatório semanal dele — já aplicado`);
    fbDb.collection('gestorpro').doc(docId).update({processado:true}).catch(e=>console.error('Erro ao marcar relatório semanal como processado',e));
  }catch(e){
    console.error('Erro ao aplicar relatório semanal pendente',e);
  }
}

function renderTesterDetail(cid){
  const el=document.getElementById('tester-content');
  if(!el)return;
  const c=S.chatters.find(ch=>ch.id===cid);
  if(!c){el.innerHTML='';return;}

  if(!S.testerLogs)S.testerLogs={};
  if(!S.testerLogs[cid])S.testerLogs[cid]=[];

  const logs=S.testerLogs[cid];
  const today=todayKey();
  const analysis=getTesterAnalysis(cid);
  const DIAS=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const dayName=dk=>{const[y,mo,d]=dk.split('-').map(Number);return DIAS[new Date(y,mo-1,d).getDay()]+' '+d+'/'+mo;};

  const recs=[];
  if(analysis.avgTicket>0&&analysis.avgHigh<20)recs.push(`High ticket em ${analysis.avgHigh}% — ticket médio é ${money(analysis.avgTicket)}, treinar ofertas acima de ${money(analysis.avgTicket*1.5)}`);
  if(analysis.avgVph>0&&analysis.avgVph<10)recs.push(`${money(analysis.avgVph)}/hora está abaixo do mínimo (R$10/h) — revisar abordagem`);
  else if(analysis.avgVph>=10&&analysis.avgVph<20)recs.push(`${money(analysis.avgVph)}/hora é regular — meta: chegar a R$20/h`);
  if(analysis.maxGap>90)recs.push(`Ficou <strong>${analysis.maxGap}min sem vender</strong> em algum dos dias de teste — investigar`);
  if(!recs.length&&analysis.totalRev>0)recs.push(`Resultado sólido no teste (${money(analysis.totalRev)} em ${analysis.testDays.length} dias) — considerar aprovação`);
  if(!analysis.testDays.length)recs.push('Ainda sem faturamento lançado — os 3 dias de teste aparecem aqui automaticamente assim que houver lançamentos em Faturamento');

  const analysisPanel=`<div class="panel" style="margin-bottom:14px;border-left:3px solid var(--accent)">
    <div class="panel-head"><div class="panel-title">📊 Análise automática — 3 dias de teste</div></div>
    ${analysis.testDays.length?`
      <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
        ${analysis.testDays.map(td=>`<div style="flex:1;min-width:90px;background:var(--bg-soft);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:10px;color:var(--text3)">${dayName(td.date)}</div>
          <div style="font-size:14px;font-weight:800;font-family:var(--font-mono);color:var(--ok)">${money(td.revenue)}</div>
        </div>`).join('')}
        <div style="flex:1;min-width:90px;background:var(--accent-soft);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:10px;color:var(--accent);font-weight:700">SOMA</div>
          <div style="font-size:15px;font-weight:800;font-family:var(--font-mono);color:var(--accent)">${money(analysis.totalRev)}</div>
        </div>
      </div>
      ${analysis.daysWithData>0?`<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px">
        <div style="background:var(--bg-soft);border-radius:7px;padding:7px;text-align:center">
          <div style="font-size:9px;color:var(--text3)">Ticket médio</div>
          <div style="font-size:13px;font-weight:700;font-family:var(--font-mono)">${money(analysis.avgTicket)}</div>
        </div>
        <div style="background:var(--bg-soft);border-radius:7px;padding:7px;text-align:center">
          <div style="font-size:9px;color:var(--text3)">Valor/hora</div>
          <div style="font-size:13px;font-weight:700;color:${analysis.avgVph>=20?'var(--ok)':analysis.avgVph>=10?'var(--warn)':'var(--bad)'}">${money(analysis.avgVph)}/h</div>
        </div>
        <div style="background:var(--bg-soft);border-radius:7px;padding:7px;text-align:center">
          <div style="font-size:9px;color:var(--text3)">High ticket ≥R$300</div>
          <div style="font-size:13px;font-weight:700;color:${analysis.avgHigh>=30?'var(--ok)':analysis.avgHigh>=15?'var(--warn)':'var(--bad)'}">${analysis.avgHigh}%</div>
          ${analysis.htTotal>0?`<div style="font-size:10px;color:var(--text3)">${money(analysis.htTotal)}</div>`:''}
        </div>
      </div>`:''}
    `:'<div style="font-size:12.5px;color:var(--text3);margin-bottom:10px">Ainda sem lançamento em Faturamento — os 3 dias de teste aparecem aqui automaticamente.</div>'}
    <div style="background:var(--bg-soft);border-radius:8px;padding:10px">
      <div style="font-size:11px;font-weight:700;color:var(--text3);margin-bottom:6px">💡 ANÁLISE</div>
      ${recs.map(r=>`<div style="font-size:12.5px;color:var(--text);padding:3px 0;border-bottom:1px solid var(--line)">• ${r}</div>`).join('')}
    </div>
  </div>`;

  const isReserva=S.chatterFichas?.[cid]?.testerDecision==='espera';
  const reservaPanel=isReserva?(()=>{
    const workDays=getTesterAllWorkDays(cid);
    const totalAll=workDays.reduce((s,d)=>s+d.revenue,0);
    const extraWeek=getChatterExtraRevenue(cid,0);
    const extraBonusWeek=extraWeek*0.10;
    return`<div class="panel" style="margin-bottom:14px;border-left:3px solid var(--bad)">
      <div class="panel-head"><div class="panel-title">🔵 Reserva — histórico completo</div></div>
      <div style="font-size:11.5px;color:var(--text2);margin-bottom:10px">Cobre turno quando falta chatter disponível. Pagamento é só por hora extra (10% do faturamento coberto).</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        <div style="background:var(--bg-soft);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:9px;color:var(--text3)">Faturamento total coberto</div>
          <div style="font-size:14px;font-weight:800;font-family:var(--font-mono)">${money(totalAll)}</div>
        </div>
        <div style="background:var(--bad-soft);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:9px;color:var(--bad)">Hora extra essa semana</div>
          <div style="font-size:14px;font-weight:800;font-family:var(--font-mono);color:var(--bad)">${money(extraBonusWeek)}</div>
        </div>
      </div>
      ${workDays.length?`<div style="max-height:160px;overflow-y:auto">${workDays.slice().reverse().map(d=>`<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--line);font-size:12px">
        <span>${d.date.split('-').reverse().join('/')}</span><span style="font-weight:700">${money(d.revenue)}</span>
      </div>`).join('')}</div>`:'<div style="font-size:12px;color:var(--text3)">Sem faturamento lançado ainda</div>'}
      <button class="btn btn-ghost btn-sm btn-block" style="margin-top:10px" onclick="openAddShiftForChatter('${cid}')">🔁 Realocar em turno</button>
    </div>`;
  })():'';

  const triagem=S.chatterFichas?.[cid]?.triagemIA;
  const triagemPanel=triagem?fichaAccordion('triagem-'+cid,'border:2px solid var(--accent)',
    `<div><div class="panel-title">🔍 Mapeamento de Triagem</div><div class="panel-note">Gerado em ${triagem.date||''} · <b>${triagem.classificacao||''}</b></div></div>`,
    `<div style="background:var(--bg-soft);border-radius:10px;padding:12px;margin-bottom:12px">
      <div class="panel-note" style="margin-bottom:6px">👤 Sobre a pessoa</div>
      <div style="font-size:12.5px;color:var(--text2);line-height:1.5">${triagem.ondeMora||'-'} · ${triagem.oQueFaz||'-'}</div>
      <div style="font-size:12px;color:var(--text3);margin-top:4px">💰 Pretensão: ${triagem.pretensaoSalarial||'-'} · 📈 Mercado: ${triagem.conheceMercado||'-'}</div>
    </div>
    <div class="field"><label class="flabel">🗣️ Padrão de fala</label><div style="font-size:12.5px;color:var(--text2)">${triagem.padraoFala||'-'}</div></div>
    <div class="field"><label class="flabel">👑 Autoridade — ${triagem.autoridade||'-'}</label><div style="font-size:12.5px;color:var(--text2)">${triagem.autoridadeMotivo||'-'}</div></div>
    <div class="field"><label class="flabel">🔥 Engajamento — ${triagem.engajamento||'-'}</label><div style="font-size:12.5px;color:var(--text2)">${triagem.engajamentoMotivo||'-'}</div></div>
    <div class="field"><label class="flabel">📋 Parecer</label><div style="font-size:12.5px;color:var(--text2)">${triagem.resumo||'-'}</div></div>
    <button data-noaccordion class="btn btn-ghost btn-block" style="margin-top:10px;color:var(--bad);border-color:var(--bad)" onclick="excluirTriagemIA('${cid}')">🗑️ Excluir triagem</button>`
  ):'';

  // 10/08/2026 — quadro "Teste", a pedido da gestora: só aparece pra quem foi
  // aprovado, e reúne o que sobrevive do processo de teste (o PPM de cada
  // dia e o Mapeamento de Triagem, ambos apagados/substituídos assim que a
  // decisão é tomada — ver setTesterDecision) junto do resumo do padrinho
  // (esse já é permanente, lido direto — sem precisar de cópia).
  const testeResultado=S.chatterFichas?.[cid]?.testeResultado;
  const testePanel=(c.testerDecision==='aprovado'&&testeResultado)?fichaAccordion('teste-'+cid,'border:2px solid var(--ok)',
    `<div><div class="panel-title">🧪 Teste</div><div class="panel-note">PPM, Mapeamento e opinião do padrinho${testeResultado.salvoEm?' · registrado em '+new Date(testeResultado.salvoEm).toLocaleDateString('pt-BR'):''}</div></div>`,
    `${testeResultado.ppmDias&&testeResultado.ppmDias.length?`<div class="field"><label class="flabel">⌨️ Resultado do PPM (por dia)</label>
      ${testeResultado.ppmDias.map(d=>`<div style="font-size:12.5px;color:var(--text2);padding:5px 0;border-bottom:1px solid var(--line)"><b>Dia ${d.dia}:</b> ${d.ppmResultado||'—'}${d.resumo?` — ${d.resumo}`:''}</div>`).join('')}
    </div>`:'<div class="panel-note">Sem resultados de PPM guardados.</div>'}
    ${testeResultado.mapeamento?`<div class="field" style="margin-top:12px"><label class="flabel">🔍 Mapeamento (Triagem)</label>
      <div style="font-size:12.5px;color:var(--text2);line-height:1.5">${testeResultado.mapeamento.ondeMora||'-'} · ${testeResultado.mapeamento.oQueFaz||'-'}</div>
      <div style="font-size:12px;color:var(--text3);margin-top:4px">📋 Parecer: ${testeResultado.mapeamento.resumo||'-'}</div>
    </div>`:''}
    <div class="field" style="margin-top:12px"><label class="flabel">📝 Resumo do padrinho</label>
      <div style="font-size:12.5px;color:var(--text2)">${S.chatterFichas?.[cid]?.padrinhoObservacoesGerais||'— ainda não preenchido'}</div>
    </div>`
  ):'';
  const mandamentosPanel=mandamentosPanelHtml(cid);
  const relatorioSemanalPanel=relatorioSemanalFichaHtml(cid);
  const conversasAnalisadasPanel=conversasAnalisadasFichaHtml(cid);
  el.innerHTML=reservaPanel+triagemPanel+testePanel+analysisPanel+relatorioSemanalPanel+mandamentosPanel+conversasAnalisadasPanel+`
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px">
      <div>
        <div style="font-weight:800;font-size:16px">${c.name}</div>
        <div style="font-size:12px;color:var(--text3)">${c.level} · ${logs.length} dia${logs.length!==1?'s':''} registrado${logs.length!==1?'s':''}</div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="addTesterDay('${cid}')">+ Registrar dia</button>
    </div>

    <!-- NOVO REGISTRO -->
    <div class="panel" id="tester-new-${cid}" style="display:none;border-color:var(--accent)">
      <div class="panel-head"><div class="panel-title" style="color:var(--accent)">📝 Novo registro</div></div>
      <div class="field"><label class="flabel">Data</label>
        <input type="date" class="finput" id="tlog-date-${cid}" value="${today}">
      </div>
      <div class="field"><label class="flabel">✅ Pontos fortes do dia</label>
        <textarea class="ftext" id="tlog-fortes-${cid}" placeholder="O que ele fez bem hoje? Comportamentos positivos observados..."></textarea>
      </div>
      <div class="field"><label class="flabel">⚠️ Pontos fracos e o que melhorar</label>
        <textarea class="ftext" id="tlog-fracos-${cid}" placeholder="Onde ainda precisa melhorar? O que vai trabalhar amanhã?"></textarea>
      </div>
      <div class="field"><label class="flabel">📊 Resultados do dia</label>
        <textarea class="ftext" style="min-height:60px" id="tlog-results-${cid}" placeholder="Faturamento, vendas, ticket médio, observações numéricas..."></textarea>
      </div>
      <div class="field"><label class="flabel">💡 Plano para o próximo dia</label>
        <textarea class="ftext" style="min-height:52px" id="tlog-plano-${cid}" placeholder="O que vou orientar para amanhã?"></textarea>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" onclick="saveTesterDay('${cid}')">💾 Salvar</button>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('tester-new-${cid}').style.display='none'">Cancelar</button>
      </div>
    </div>

    <!-- HISTÓRICO DE DIAS -->
    ${logs.length?`<div class="panel"><div class="panel-head"><div class="panel-title">📅 Histórico diário</div></div>
      ${[...logs].sort((a,b)=>b.date.localeCompare(a.date)).map(log=>`
        <div class="tlog-swipe-row" data-key="${log.id}" style="padding:12px 0;border-bottom:1px solid var(--line);touch-action:pan-y">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div style="font-weight:700;font-size:13px">${log.date}</div>
            <button onclick="deleteTesterDay('${cid}','${log.id}')" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:12px">✕</button>
          </div>
          ${log.fortes?`<div style="background:var(--ok-soft);border-radius:8px;padding:9px 11px;margin-bottom:7px">
            <div style="font-size:10.5px;font-weight:700;color:var(--ok);margin-bottom:3px">✅ PONTOS FORTES</div>
            <div style="font-size:13px;color:var(--text);line-height:1.6">${log.fortes}</div>
          </div>`:''}
          ${log.fracos?`<div style="background:var(--warn-soft);border-radius:8px;padding:9px 11px;margin-bottom:7px">
            <div style="font-size:10.5px;font-weight:700;color:var(--warn);margin-bottom:3px">⚠️ O QUE MELHORAR</div>
            <div style="font-size:13px;color:var(--text);line-height:1.6">${log.fracos}</div>
          </div>`:''}
          ${log.results?`<div style="background:var(--bg-soft);border-radius:8px;padding:9px 11px;margin-bottom:7px">
            <div style="font-size:10.5px;font-weight:700;color:var(--text3);margin-bottom:3px">📊 RESULTADOS</div>
            <div style="font-size:13px;color:var(--text2)">${log.results}</div>
          </div>`:''}
          ${log.plano?`<div style="background:var(--info-soft);border-radius:8px;padding:9px 11px">
            <div style="font-size:10.5px;font-weight:700;color:var(--info);margin-bottom:3px">💡 PLANO PARA AMANHÃ</div>
            <div style="font-size:13px;color:var(--text2)">${log.plano}</div>
          </div>`:''}
        </div>`).join('')}
    </div>`:
    '<div style="color:var(--text3);font-size:13px;padding:8px 0">Nenhum dia registrado ainda — clique em + Registrar dia</div>'}
  `;
  attachSwipeToDelete(el,'.tlog-swipe-row',id=>deleteTesterDay(cid,id),()=>renderTesterDetail(cid));
}

function addTesterDay(cid){
  const panel=document.getElementById('tester-new-'+cid);
  if(panel){panel.style.display='block';panel.scrollIntoView({behavior:'smooth',block:'nearest'});}
}
function saveTesterDay(cid){
  if(!S.testerLogs)S.testerLogs={};
  if(!S.testerLogs[cid])S.testerLogs[cid]=[];
  const date=document.getElementById('tlog-date-'+cid)?.value||todayKey();
  const fortes=document.getElementById('tlog-fortes-'+cid)?.value.trim()||'';
  const fracos=document.getElementById('tlog-fracos-'+cid)?.value.trim()||'';
  const results=document.getElementById('tlog-results-'+cid)?.value.trim()||'';
  const plano=document.getElementById('tlog-plano-'+cid)?.value.trim()||'';
  if(!fortes&&!fracos&&!results){toast('⚠️ Preencha pelo menos um campo');return;}
  S.testerLogs[cid].push({id:'tl'+Date.now(),date,fortes,fracos,results,plano});
  save();
  document.getElementById('tester-new-'+cid).style.display='none';
  renderTesterDetail(cid);
  toast('✅ Dia registrado!');
}
function deleteTesterDay(cid,id){
  if(!confirm('Excluir este registro?'))return;
  if(S.testerLogs?.[cid])S.testerLogs[cid]=S.testerLogs[cid].filter(l=>l.id!==id);
  save();renderTesterDetail(cid);
}

/* ===========================================================
   BACKUP MANUAL — exportar e importar dados
   =========================================================== */
function exportBackup(){
  const data=JSON.stringify(S,null,2);
  const blob=new Blob([data],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  const date=new Date().toISOString().slice(0,10);
  a.href=url;a.download=`gestorpro-backup-${date}.json`;
  a.click();URL.revokeObjectURL(url);
  toast('✅ Backup exportado!');
}
function importBackup(){
  const inp=document.createElement('input');
  inp.type='file';inp.accept='.json';
  inp.onchange=e=>{
    const f=e.target.files[0];if(!f)return;
    const r=new FileReader();
    r.onload=ev=>{
      try{
        const parsed=JSON.parse(ev.target.result);
        if(!parsed||((!parsed.chatters||!parsed.chatters.length)&&(!parsed.models||!parsed.models.length))){
          toast('❌ Arquivo inválido — não parece um backup do GestorPro');return;
        }
        if(!confirm(`Restaurar backup? Isso vai substituir os dados atuais.\n\nChatters no backup: ${(parsed.chatters||[]).length}\nModelos: ${(parsed.models||[]).length}`))return;
        S={...S,...migrateState(parsed)};delete S.payload;delete S.schemaVersion;delete S.updatedAt;
        save();
        renderView(currentViewName());
        toast('✅ Backup restaurado com sucesso!');
      }catch(err){toast('❌ Erro ao ler arquivo: '+err.message);}
    };
    r.readAsText(f);
  };
  inp.click();
}

/* ===========================================================
   PAGAMENTO — sistema de remuneração Seduct
   =========================================================== */

// Boost multipliers: % acima da meta → multiplicador do prêmio
function pagBoost(pctAcima){
  if(pctAcima<=0)return 1;
  if(pctAcima<=20)return 1.2;
  if(pctAcima<=40)return 1.4;
  if(pctAcima<=60)return 1.6;
  if(pctAcima<=100)return 2.0;
  if(pctAcima<=150)return 2.5;
  return 3.5;
}

function calcChatterPagamento(fat, medalha, cat, htTotal, extraFat, customMeta){
  const com=PAG_COM[medalha]||0.04;
  const comissao=fat*com;

  // Meta prize — usa a meta customizada (definida em Faturamento) quando
  // existir, escalando os 3 degraus proporcionalmente; senão usa a
  // categoria padrão. O valor do prêmio em R$ de cada degrau continua
  // vindo da categoria (política de bônus da empresa).
  const c=PAG_CATS[cat];
  const n100=customMeta>0?customMeta:c.n100;
  const n85=customMeta>0?customMeta*(c.n85/c.n100):c.n85;
  const n70=customMeta>0?customMeta*(c.n70/c.n100):c.n70;
  let premio=0;
  if(fat>=n100){
    const pctOver=((fat-n100)/n100)*100;
    premio=Math.round(c.p100*pagBoost(pctOver));
  } else if(fat>=n85){
    premio=c.p85;
  } else if(fat>=n70){
    premio=c.p70;
  }

  const htBonus=(htTotal||0)*0.08;
  const extraBonus=(extraFat||0)*0.10;
  const total=comissao+premio+htBonus+extraBonus;
  // O "piso" é só uma referência informativa (mínimo garantido pela empresa,
  // política salarial separada) — NÃO soma nem substitui o valor calculado.
  // O que é efetivamente pago vem SEMPRE só do resultado da própria pessoa:
  // comissão sobre o faturamento + prêmio de meta + bônus de high ticket/hora extra.
  const piso=PAG_PISO[medalha]||1000;
  const pisoComp=Math.max(0,piso-total);

  return{comissao,premio,htBonus,extraBonus,total,piso,pisoComp,totalComPiso:total,n100,n85,n70};
}

function pagSwitchTab(tab){
  ['chatters','gerente'].forEach(t=>{
    const pane=document.getElementById('pagpane-'+t);
    if(pane)pane.style.display=t===tab?'block':'none';
    const btn=document.getElementById('pagtab-'+t);
    if(btn)btn.classList.toggle('active',t===tab);
  });
  if(tab==='gerente')renderGerPreview();
}

/* ===========================================================
   PAGAMENTO — visão MENSAL completa (faturamento do mês, ganho
   por cada uma das 5 formas somado o mês inteiro, ritmo projetado,
   e resumo do time no fim)
   =========================================================== */
function getMonthDaysSoFar(){
  const today=new Date();
  const days=[];
  for(let d=1;d<=today.getDate();d++)days.push(new Date(today.getFullYear(),today.getMonth(),d));
  return days;
}
function getDaysInCurrentMonth(){
  const today=new Date();
  return new Date(today.getFullYear(),today.getMonth()+1,0).getDate();
}
function getChatterMonthStats(cid){
  const days=getMonthDaysSoFar();
  const f=S.chatterFichas[cid];
  const analytics=f?.analytics?.weeklyData||{};
  let monthRevenue=0,monthExtra=0,monthHtTotal=0,ticketSum=0,ticketDays=0,vendasSum=0,diasTrabalhados=0,horasSum=0;
  const dayByDay=[];
  // Pedido 04/08/2026: quando o mês desse chatter foi importado do
  // financeiro, faturamento/horas por dia e o total de high ticket vêm de
  // lá (mais preciso — é a fonte que o financeiro realmente fecha), não do
  // lançamento manual/ChatLab. Alimenta Pagamento por igual.
  const todayMonthKey=fmt(new Date()).slice(0,7);
  const finMes=getChatterFinanceiroMes(cid,todayMonthKey);
  days.forEach(day=>{
    const dk=fmt(day);
    let dayRev=0,dayExtra=0,dayHoras=0;
    const fin=getChatterDayRevenueFinanceiro(cid,dk);
    const a=analytics[dk];
    if(fin){
      dayRev=fin.turno;dayExtra=fin.extra;dayHoras=fin.horasTurno+fin.horasExtra;
    }else{
      S.models.forEach(m=>{dayRev+=parseFloat(S.revenues[`${cid}_${m.id}_${dk}`])||0;});
      dayExtra=a?.extraTotal||0;
      dayHoras=a?.shiftHours||0;
    }
    monthRevenue+=dayRev;
    monthExtra+=dayExtra;
    horasSum+=dayHoras;
    if(a){
      if(!fin)monthHtTotal+=a.highTicketTotal||0; // com financeiro, HT vem de lá (override abaixo)
      vendasSum+=a.totalVendas||0;
      if(a.ticketMedio>0){ticketSum+=a.ticketMedio;ticketDays++;}
    }
    if(dayRev>0||dayExtra>0||(a&&a.totalVendas>0)){diasTrabalhados++;}
    dayByDay.push({date:dk,rev:dayRev+dayExtra});
  });
  if(finMes)monthHtTotal=finMes.htTotalValor||monthHtTotal;
  const avgTicket=ticketDays>0?ticketSum/ticketDays:0;
  const avgHtPct=monthRevenue+monthExtra>0?Math.round((monthHtTotal/(monthRevenue+monthExtra))*100):0;
  const mediaPorDia=diasTrabalhados>0?(monthRevenue+monthExtra)/diasTrabalhados:0;
  const fatPorHora=horasSum>0?(monthRevenue+monthExtra)/horasSum:0;
  return{monthRevenue,monthExtra,monthHtTotal,avgTicket,avgHtPct,vendasSum,diasTrabalhados,horasSum:Math.round(horasSum*10)/10,mediaPorDia,fatPorHora,dayByDay};
}
// Ganho do mês pelas 5 formas — comissão/high-ticket/modelo-extra somam
// direto os dias do mês; o prêmio de meta é por semana, então soma o
// prêmio de cada semana que tem pelo menos 1 dia dentro do mês atual.
function getChatterMonthEarnings(cid,medal,cat){
  const stats=getChatterMonthStats(cid);
  const com=PAG_COM[medal]||0.04;
  const comissao=(stats.monthRevenue+stats.monthExtra)*com;
  const htBonus=stats.monthHtTotal*0.08;
  const extraBonus=stats.monthExtra*0.10;
  // Prêmio de meta: soma por semana (até 6 semanas cobre qualquer mês)
  let premioSum=0;
  const today=new Date();
  const seenWeeks=new Set();
  for(let o=0;o>-6;o--){
    const wd=getWeekDates(o);
    const overlapsMonth=wd.some(d=>d.getMonth()===today.getMonth()&&d.getFullYear()===today.getFullYear());
    if(!overlapsMonth)continue;
    const wkey=getWeekKey(o);
    if(seenWeeks.has(wkey))continue;
    seenWeeks.add(wkey);
    const rv=getChatterWeekRevenue(cid,o);
    const goals=S.chatterWeekGoals[wkey]||{};
    const metaVal=parseFloat(goals[cid])||0;
    const r=calcChatterPagamento(rv,medal,cat,0,0,metaVal);
    premioSum+=r.premio;
  }
  const total=comissao+premioSum+htBonus+extraBonus;
  return{comissao,premio:premioSum,htBonus,extraBonus,total,...stats};
}
function renderPagMonthSummary(){
  const el=document.getElementById('pag-month-summary');
  if(!el)return;
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  if(!chatters.length){el.innerHTML='';return;}
  const daysInMonth=getDaysInCurrentMonth();
  const daysSoFar=new Date().getDate();
  let totalFat=0,totalEsperado=0,bateram=0;
  chatters.forEach(c=>{
    const {monthRevenue,monthExtra}=getChatterMonthStats(c.id);
    totalFat+=monthRevenue+monthExtra;
    const savedCat=S.chatterFichas?.[c.id]?.pagCategoria||'B';
    const metaMensal=PAG_CATS[savedCat].n100*(daysInMonth/7);
    totalEsperado+=metaMensal;
    if(monthRevenue>=metaMensal)bateram++;
  });
  const pctTime=totalEsperado>0?Math.round(totalFat/totalEsperado*100):0;
  const ritmoProjetado=daysSoFar>0?totalFat*(daysInMonth/daysSoFar):0;
  el.innerHTML=`<div class="panel" style="border:2px solid var(--accent)">
    <div class="panel-head"><div class="panel-title">🏢 Resumo do time — mês atual</div></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
      <div style="background:var(--bg-soft);border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:9.5px;color:var(--text3);text-transform:uppercase">Faturou no mês</div>
        <div style="font-size:20px;font-weight:800;font-family:var(--font-mono);color:var(--ok)">${money(totalFat)}</div>
      </div>
      <div style="background:var(--bg-soft);border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:9.5px;color:var(--text3);text-transform:uppercase">Esperado até agora</div>
        <div style="font-size:20px;font-weight:800;font-family:var(--font-mono)">${money(totalEsperado)}</div>
      </div>
    </div>
    <div style="text-align:center;margin-bottom:10px">
      <span style="font-size:13px;font-weight:700;color:${pctTime>=100?'var(--ok)':pctTime>=80?'var(--warn)':'var(--bad)'}">${pctTime}% do esperado no mês</span>
      <span style="font-size:11.5px;color:var(--text3)"> · no ritmo atual, fecha em ${money(ritmoProjetado)}</span>
    </div>
    <div style="text-align:center;font-size:13px">
      <strong style="color:var(--ok)">${bateram}</strong> de <strong>${chatters.length}</strong> já bateram a meta mensal deles
    </div>
  </div>`;
}
function renderPagamento(){
  renderPagWeekNav();
  // Render meta table
  const tbody=document.getElementById('pag-meta-table');
  if(tbody){
    tbody.innerHTML=Object.entries(PAG_CATS).map(([cat,c])=>`<tr>
      <td style="padding:6px 10px;font-weight:700;border-bottom:1px solid var(--line)">${cat}</td>
      <td style="padding:6px 10px;text-align:right;border-bottom:1px solid var(--line);font-family:var(--font-mono);font-size:11.5px">${money(c.n70)}</td>
      <td style="padding:6px 10px;text-align:right;border-bottom:1px solid var(--line);color:var(--ok);font-weight:700">+${money(c.p70)}</td>
      <td style="padding:6px 10px;text-align:right;border-bottom:1px solid var(--line);font-family:var(--font-mono);font-size:11.5px">${money(c.n85)}</td>
      <td style="padding:6px 10px;text-align:right;border-bottom:1px solid var(--line);color:var(--ok);font-weight:700">+${money(c.p85)}</td>
      <td style="padding:6px 10px;text-align:right;border-bottom:1px solid var(--line);font-family:var(--font-mono);font-size:11.5px">${money(c.n100)}</td>
      <td style="padding:6px 10px;text-align:right;border-bottom:1px solid var(--line);color:var(--ok);font-weight:800">+${money(c.p100)}</td>
    </tr>`).join('');
  }
  // Auto-populate chatters tab with all chatters
  renderPagChattersAll();
  renderPagMonthSummary();
  // Gerente chatters config
  renderGerChattersConfig();
  renderGerPreview();
}

/* ===========================================================
   MÉTRICAS — tabelas comparativas 100% matemáticas (sem IA), a
   partir dos dados que o sistema já tem (faturamento, horas
   trabalhadas, ChatLab). Nada aqui depende de uma chamada de IA pra
   atualizar — é tudo calculado na hora, direto do estado do app. A
   IA só entra se a gestora digitar uma pergunta específica no final
   da página, pra interpretar os números já prontos — nunca roda
   sozinha.
   =========================================================== */
const PAG_LEVEL_LABEL={treinamento:'Em treinamento',teste:'Chatter Teste',junior:'Chatter Júnior',pleno:'Chatter Pleno',senior:'Chatter Sênior',padrinho:'👑 Padrinho'};

function getChatterModelsWorkedWeek(cid,offset){
  const wd=getWeekDates(offset).map(d=>DAY_KEYS[d.getDay()]);
  const ids=[...new Set(S.shifts.filter(s=>s.chatterId===cid&&(s.days||[]).some(dk=>wd.includes(dk))).flatMap(s=>s.modelIds||[]))];
  return ids.map(mid=>S.models.find(m=>m.id===mid)).filter(Boolean);
}
// Ticket médio da semana — média dos dias com dado, mesma fonte usada em
// Pagamento/Evolução (f.analytics.weeklyData[dk].ticketMedio), sem refazer conta.
function getChatterWeekTicketMedio(cid,offset){
  const f=S.chatterFichas[cid];
  const analytics=f?.analytics?.weeklyData||{};
  const wd=getWeekDates(offset);
  let sum=0,days=0;
  wd.forEach(d=>{const a=analytics[fmt(d)];if(a&&a.ticketMedio>0){sum+=a.ticketMedio;days++;}});
  return days?sum/days:0;
}

// Categorias do Dashboard que o ChatLab já pede pra IA notar (0-10) em cada
// análise — nomes usados pra reconhecer a linha da tabela dentro do texto
// markdown já salvo (raw), sem precisar rodar IA de novo pra extrair isso.
const CHATLAB_CATEGORIAS=[
  {key:'conexao',label:'Conexão Emocional',match:/conex[ãa]o/i},
  {key:'conversao',label:'Conversão e Timing',match:/convers[ãa]o/i},
  {key:'sinaisCompra',label:'Leitura de Sinais de Compra',match:/sinais? de compra/i},
  {key:'conducao',label:'Condução',match:/^condu|condução/i},
  {key:'inteligenciaEmocional',label:'Inteligência Emocional',match:/intelig[êe]ncia emocional/i},
  {key:'perfilLead',label:'Perfil do Lead',match:/perfil do lead/i},
  {key:'qualificacao',label:'Qualificação',match:/qualifica/i},
  {key:'inteligenciaComercial',label:'Inteligência Comercial',match:/intelig[êe]ncia comercial/i},
  {key:'criatividade',label:'Criatividade',match:/criativ/i},
  {key:'gestaoTempo',label:'Gestão do Tempo',match:/gest[ãa]o do tempo/i},
  {key:'retencao',label:'Retenção',match:/retenç/i},
];
// Extrai as notas 0-10 do "Dashboard (tabela indicador × nota)" que já fica
// salvo dentro do texto (raw) de cada análise do ChatLab — pura leitura de
// texto já existente, nenhuma chamada nova de IA.
function parseChatLabDashboard(raw){
  if(!raw)return{};
  const scores={};
  const dashM=raw.match(/##\s*📊?\s*Dashboard[\s\S]*?(?=\n##\s|$)/i);
  const section=dashM?dashM[0]:raw;
  let m;
  // Formato atual da IA: tabela markdown dentro do Dashboard —
  // "| Conexão Emocional (Peso 15%) | 6.5 |" (sem "/10" na tabela, só o
  // número puro na 2ª coluna). Esse era o formato real e o parser antigo
  // nunca reconhecia isso, por isso as médias (inclusive Conexão no
  // ranking semanal) sempre saíam vazias mesmo com Dashboard presente.
  const tableRe=/\|\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ /]{2,50}?)(?:\s*\([^)]*\))?\s*\|\s*(\d{1,2}(?:[.,]\d+)?)\s*\|/g;
  while((m=tableRe.exec(section))){
    const nome=m[1].trim();
    const nota=parseFloat(String(m[2]).replace(',','.'));
    if(isNaN(nota)||nota<0||nota>10)continue;
    const cat=CHATLAB_CATEGORIAS.find(c=>c.match.test(nome));
    if(cat&&scores[cat.key]==null)scores[cat.key]=nota;
  }
  // Reserva: formato em prosa "Nome: NN/10" (relatórios antigos, ou texto
  // fora da tabela do Dashboard) — só preenche quem não veio da tabela.
  const lineRe=/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ /]{2,40}?)\s*[:|]\s*\**(\d{1,2}(?:[.,]\d+)?)\s*\/\s*10/g;
  while((m=lineRe.exec(raw))){
    const nome=m[1].trim();
    const nota=parseFloat(String(m[2]).replace(',','.'));
    if(isNaN(nota)||nota<0||nota>10)continue;
    const cat=CHATLAB_CATEGORIAS.find(c=>c.match.test(nome));
    if(cat&&scores[cat.key]==null)scores[cat.key]=nota;
  }
  return scores;
}
// Média das notas por categoria, a partir de um conjunto de análises já
// coletado (ex: coletarAnalisesDaSemana) — só soma/divide, sem IA.
function getChatLabCategoryAverages(analises){
  const sums={},counts={};
  (analises||[]).forEach(a=>{
    const scores=parseChatLabDashboard(a.raw);
    Object.entries(scores).forEach(([k,v])=>{sums[k]=(sums[k]||0)+v;counts[k]=(counts[k]||0)+1;});
  });
  const avgs={};
  Object.keys(sums).forEach(k=>{avgs[k]=sums[k]/counts[k];});
  return avgs;
}

function fmtPct(v){return v==null?'—':`${Math.round(v)}%`;}
function fmtPctSigned(v){return v==null?'—':`${v>0?'+':''}${Math.round(v)}%`;}

// Monta TODOS os dados derivados de uma vez (matemática pura, sem IA) — as
// funções de render só formatam o que já está aqui.
function buildMetricasData(offset){
  const o=offset!==undefined?offset:weekOffset;
  const wkey=getWeekKey(o);
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));

  const perChatter=chatters.map(c=>{
    const fat=getChatterWeekRevenue(c.id,o);
    const extraFat=getChatterExtraRevenue(c.id,o);
    const fatAtual=fat+extraFat;
    const fatAnterior=getChatterWeekRevenue(c.id,o-1)+getChatterExtraRevenue(c.id,o-1);
    const variacao=fatAnterior>0?Math.round(((fatAtual-fatAnterior)/fatAnterior)*100):(fatAtual>0?100:null);
    const {horas}=getChatterWeekWorkStats(c.id,o);
    const receitaPorHora=horas>0?fatAtual/horas:null;
    const ticketMedio=getChatterWeekTicketMedio(c.id,o);
    const clAnalises=coletarAnalisesDaSemana(c.id,o);
    const clMetrics=calcMetricasSemana(clAnalises);
    const catAvgs=getChatLabCategoryAverages(clAnalises);
    const cat=S.chatterFichas?.[c.id]?.pagCategoria||'B';
    const catInfo=PAG_CATS[cat]||PAG_CATS.B;
    const metaManual=parseFloat((S.chatterWeekGoals[wkey]||{})[c.id])||0;
    const metaAlvo=metaManual>0?metaManual:catInfo.n100;
    const perfPct=metaAlvo>0?Math.round(fat/metaAlvo*100):null;
    const models=getChatterModelsWorkedWeek(c.id,o).map(m=>m.name);
    const cargo=PAG_LEVEL_LABEL[c.level]||c.level;
    // Consistência: variação (desvio padrão) do % de meta batido nas últimas
    // 4 semanas relativas à semana selecionada — mesmo método já usado na
    // aba Projeção, só convertido pra "quanto maior, mais estável" (100 -
    // desvio).
    const weekPcts=[-3,-2,-1,0].map(rel=>{
      const r=getChatterWeekRevenue(c.id,o+rel);
      return catInfo.n100>0?Math.round(r/catInfo.n100*100):0;
    });
    const validPcts=weekPcts.filter(p=>p>0);
    let consistencia=null;
    if(validPcts.length>=2){
      const avg=validPcts.reduce((s,p)=>s+p,0)/validPcts.length;
      const variance=validPcts.reduce((s,p)=>s+Math.pow(p-avg,2),0)/validPcts.length;
      consistencia=Math.max(0,Math.round(100-Math.sqrt(variance)));
    }
    const idComponentes={performance:perfPct,crescimento:variacao,qualidade:clMetrics.avgIGP,consistencia};
    const idValues=Object.values(idComponentes).filter(v=>v!=null);
    const idGeral=idValues.length?Math.round(idValues.reduce((s,v)=>s+v,0)/idValues.length):null;
    return{c,fat,extraFat,fatAtual,fatAnterior,variacao,horas,receitaPorHora,ticketMedio,clAnalises,clMetrics,catAvgs,cat,models,cargo,idComponentes,idGeral};
  });

  const totalOperacao=perChatter.reduce((s,p)=>s+p.fatAtual,0);
  perChatter.forEach(p=>{p.dependencia=totalOperacao>0?Math.round(p.fatAtual/totalOperacao*100):0;});

  // Evolução por modelo — quem trabalhou em cada modelo essa semana, quanto
  // a modelo faturou vs semana passada, e quem foi o chatter que mais
  // faturou nela.
  const groups={};
  perChatter.forEach(p=>{
    const key=p.models[0]||'Sem modelo definida';
    if(!groups[key])groups[key]=[];
    groups[key].push(p);
  });
  const porModelo=Object.entries(groups).map(([modelName,list])=>{
    const totalAtual=list.reduce((s,p)=>s+p.fatAtual,0);
    const totalAnterior=list.reduce((s,p)=>s+p.fatAnterior,0);
    const variacaoTime=totalAnterior>0?Math.round(((totalAtual-totalAnterior)/totalAnterior)*100):(totalAtual>0?100:null);
    const melhor=[...list].sort((a,b)=>b.fatAtual-a.fatAtual)[0]||null;
    return{modelName,totalAtual,totalAnterior,variacaoTime,melhor,list};
  }).sort((a,b)=>b.totalAtual-a.totalAtual);

  // Melhor chatter por categoria do ChatLab (média das notas 0-10 já salvas)
  const leaderboard=CHATLAB_CATEGORIAS.map(cat=>{
    const candidatos=perChatter.filter(p=>p.catAvgs[cat.key]!=null).map(p=>({name:p.c.name,nota:p.catAvgs[cat.key]}));
    candidatos.sort((a,b)=>b.nota-a.nota);
    return{...cat,melhor:candidatos[0]||null,candidatos};
  });

  return{wkey,offset:o,perChatter,porModelo,leaderboard,totalOperacao};
}

function renderMetricasTabelaChatters(data){
  const rows=[...data.perChatter].sort((a,b)=>b.fatAtual-a.fatAtual);
  return`<div class="panel">
    <div class="panel-head"><div><div class="panel-title">📋 Chatters — ${weekLabel(data.offset)}</div><div class="panel-note">Calculado automaticamente do faturamento, horas e ChatLab já registrados — atualiza sozinho, sem IA</div></div></div>
    <div style="overflow-x:auto"><table class="rtable">
      <thead><tr>
        <th>Chatter</th>
        <th style="text-align:right">Receita semana</th>
        <th style="text-align:right">vs sem. passada</th>
        <th style="text-align:right">Receita/hora</th>
        <th style="text-align:right">Conversão (ChatLab)</th>
        <th style="text-align:right">Ticket médio</th>
        <th style="text-align:right">Dependência</th>
      </tr></thead><tbody>
      ${rows.map(p=>`<tr>
        <td><div style="font-weight:700;font-size:12.5px">${p.c.name}</div><div style="font-size:9.5px;color:var(--text3)">${p.models.join(', ')||'sem escala'}</div></td>
        <td style="text-align:right;font-family:var(--font-mono);font-weight:700">${money(p.fatAtual)}</td>
        <td style="text-align:right;font-weight:700;color:${p.variacao==null?'var(--text3)':p.variacao>=0?'var(--ok)':'var(--bad)'}">${fmtPctSigned(p.variacao)}</td>
        <td style="text-align:right;font-family:var(--font-mono)">${p.receitaPorHora!=null?money(p.receitaPorHora):'—'}</td>
        <td style="text-align:right">${p.clMetrics.taxaConversao!=null?p.clMetrics.taxaConversao+'%':'—'}</td>
        <td style="text-align:right;font-family:var(--font-mono)">${p.ticketMedio>0?money(p.ticketMedio):'—'}</td>
        <td style="text-align:right;font-weight:700">${p.dependencia}%</td>
      </tr>`).join('')}
    </tbody></table></div>
  </div>`;
}

function renderMetricasID(data){
  const rows=[...data.perChatter].sort((a,b)=>(b.idGeral||0)-(a.idGeral||0));
  return`<div class="panel">
    <div class="panel-head"><div><div class="panel-title">🆔 ID — Índice de Desenvolvimento Semanal</div><div class="panel-note">% performance (faturamento vs meta da categoria) · % crescimento (vs semana passada) · % qualidade (IGP médio do ChatLab) · % consistência (variação nas últimas 4 semanas)</div></div></div>
    <div style="overflow-x:auto"><table class="rtable">
      <thead><tr>
        <th>Chatter</th>
        <th style="text-align:right">% Performance</th>
        <th style="text-align:right">% Crescimento</th>
        <th style="text-align:right">% Qualidade</th>
        <th style="text-align:right">% Consistência</th>
        <th style="text-align:right;color:var(--accent)">ID Geral</th>
      </tr></thead><tbody>
      ${rows.map(p=>{const id=p.idComponentes;return`<tr>
        <td style="font-weight:700;font-size:12.5px">${p.c.name}</td>
        <td style="text-align:right">${fmtPct(id.performance)}</td>
        <td style="text-align:right;color:${id.crescimento==null?'var(--text3)':id.crescimento>=0?'var(--ok)':'var(--bad)'}">${fmtPctSigned(id.crescimento)}</td>
        <td style="text-align:right">${id.qualidade!=null?id.qualidade+'%':'—'}</td>
        <td style="text-align:right">${fmtPct(id.consistencia)}</td>
        <td style="text-align:right;font-weight:800;color:var(--accent)">${p.idGeral!=null?p.idGeral+'%':'—'}</td>
      </tr>`;}).join('')}
    </tbody></table></div>
    <div style="font-size:10px;color:var(--text3);margin-top:6px">ID Geral = média simples dos indicadores disponíveis pra cada chatter (não é uma fórmula oficial da empresa, só uma leitura rápida de conjunto).</div>
  </div>`;
}

// Ranking de crescimento semanal — puramente calculado a partir do
// faturamento já lançado (sem IA nenhuma envolvida), pra mostrar rápido
// quem está com os melhores resultados dessa semana vs a semana passada.
function renderMetricasRankingCrescimento(data){
  const elegiveis=data.perChatter.filter(p=>p.fatAtual>0||p.fatAnterior>0);
  if(!elegiveis.length)return'';
  const ranked=[...elegiveis].sort((a,b)=>{
    if(a.variacao==null&&b.variacao==null)return b.fatAtual-a.fatAtual;
    if(a.variacao==null)return 1;
    if(b.variacao==null)return-1;
    return b.variacao-a.variacao;
  });
  return`<div class="panel">
    <div class="panel-head"><div><div class="panel-title">📊 Ranking de Crescimento Semanal</div><div class="panel-note">Calculado direto do faturamento lançado (sem IA) — do maior crescimento pra a maior queda vs a semana anterior</div></div></div>
    <div style="overflow-x:auto"><table class="rtable">
      <thead><tr><th>Chatter</th><th style="text-align:right">Essa semana</th><th style="text-align:right">Semana passada</th><th style="text-align:right">Variação</th></tr></thead>
      <tbody>${ranked.map(p=>`<tr>
        <td style="font-weight:700;font-size:12.5px">${p.c.name}</td>
        <td style="text-align:right;font-family:var(--font-mono)">${money(p.fatAtual)}</td>
        <td style="text-align:right;font-family:var(--font-mono);color:var(--text3)">${money(p.fatAnterior)}</td>
        <td style="text-align:right;font-weight:800;color:${p.variacao==null?'var(--text3)':p.variacao>=0?'var(--ok)':'var(--bad)'}">${fmtPctSigned(p.variacao)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>`;
}

function renderMetricasEvolucaoModelo(data){
  return`<div class="panel">
    <div class="panel-head"><div><div class="panel-title">📈 Evolução por Modelo</div><div class="panel-note">Faturamento da semana vs semana passada, e quem mais faturou em cada modelo</div></div></div>
    ${data.porModelo.map(m=>`<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line)">
      <div>
        <div style="font-weight:700;font-size:13px">${m.modelName}</div>
        <div style="font-size:10.5px;color:var(--text3)">melhor da semana: ${m.melhor?m.melhor.c.name+' ('+money(m.melhor.fatAtual)+')':'—'}</div>
      </div>
      <div style="text-align:right">
        <div style="font-family:var(--font-mono);font-weight:800">${money(m.totalAtual)}</div>
        <div style="font-size:11px;font-weight:700;color:${m.variacaoTime==null?'var(--text3)':m.variacaoTime>=0?'var(--ok)':'var(--bad)'}">${fmtPctSigned(m.variacaoTime)}</div>
      </div>
    </div>`).join('')}
  </div>`;
}

function renderMetricasLeaderboard(data){
  const comDados=data.leaderboard.filter(l=>l.melhor);
  if(!comDados.length)return`<div class="panel"><div class="panel-head"><div class="panel-title">🏆 Melhor chatter por categoria (ChatLab)</div></div><div style="font-size:12px;color:var(--text3)">Ainda sem conversas analisadas no ChatLab essa semana pra calcular isso.</div></div>`;
  return`<div class="panel">
    <div class="panel-head"><div><div class="panel-title">🏆 Melhor chatter por categoria (ChatLab)</div><div class="panel-note">Média das notas 0-10 que já ficaram salvas em cada análise dessa semana — extraído automaticamente do texto, sem chamada nova de IA</div></div></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      ${comDados.map(l=>`<div style="background:var(--bg-soft);border-radius:10px;padding:10px">
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase">${l.label}</div>
        <div style="font-size:13.5px;font-weight:800">${l.melhor.name}</div>
        <div style="font-size:11px;color:var(--accent);font-weight:700">${l.melhor.nota.toFixed(1)}/10</div>
      </div>`).join('')}
    </div>
  </div>`;
}

function renderMetricas(){
  renderWeekNav();
  const el=document.getElementById('metricas-tabelas');
  if(!el)return;
  const data=buildMetricasData(weekOffset);
  _metricasDataCache=data;
  el.innerHTML=renderMetricasTabelaChatters(data)+renderMetricasRankingCrescimento(data)+renderMetricasID(data)+renderMetricasEvolucaoModelo(data)+renderMetricasLeaderboard(data);
  renderFaturamentoFinanceiro();
  renderMetricasPerformanceMensal();
  renderMetricasTreinamento();
  renderMetricasAnaliseMensal();
}

/* ===========================================================
   PERFORMANCE MENSAL POR CHATTER — visão de calendário (não de
   semana) do faturamento de cada chatter, comparando com o mês
   anterior e traduzindo a variação numa interpretação em texto —
   serve pra gestora avaliar a própria liderança olhando quem está
   evoluindo e quem está caindo, mês a mês.
   =========================================================== */
function getChatterFinanceiroMes(chatterId,monthKey){
  return(S.faturamentoFinanceiro&&S.faturamentoFinanceiro[chatterId]&&S.faturamentoFinanceiro[chatterId][monthKey])||null;
}
// Pedido 04/08/2026: "todas as informações devem abastecer Faturamento
// Semanal, Métricas, Pagamento e Projeção" — não basta só a Performance
// Mensal. Esse é o helper de base (por DIA) que todas as funções de
// faturamento passam a consultar primeiro; se o mês daquele chatter foi
// importado do financeiro, TODOS os dias daquele mês passam a vir de lá
// (mesmo os com valor zero — o mês inteiro fica "governado" pela planilha
// oficial), e só cai pro lançamento manual (S.revenues/horaExtraSlots) nos
// meses que ainda não foram importados.
function getChatterDayRevenueFinanceiro(chatterId,dateKey){
  const monthKey=dateKey.slice(0,7);
  const fin=getChatterFinanceiroMes(chatterId,monthKey);
  if(!fin)return null;
  const dia=parseInt(dateKey.slice(8,10),10);
  const dt=(fin.porDiaTurno&&fin.porDiaTurno[dia])||{valor:0,horas:0};
  const de=(fin.porDiaExtra&&fin.porDiaExtra[dia])||{valor:0,horas:0};
  return{turno:dt.valor||0,extra:de.valor||0,horasTurno:dt.horas||0,horasExtra:de.horas||0};
}
function getChatterMonthRevenue(chatterId,monthKey){
  // Se essa pessoa+mês tem planilha oficial do financeiro importada, ela vale
  // como fonte — só cai pro lançamento manual (S.revenues) quando não tem
  // importação (pedido 04/08/2026).
  const fin=getChatterFinanceiroMes(chatterId,monthKey);
  if(fin)return fin.totalTurno||0;
  let t=0;
  const prefix=chatterId+'_';
  Object.keys(S.revenues||{}).forEach(key=>{
    if(!key.startsWith(prefix))return;
    const parts=key.split('_');
    if(parts.length<3)return;
    const dateKey=parts.slice(2).join('_');
    if(!dateKey.startsWith(monthKey))return;
    t+=parseFloat(S.revenues[key])||0;
  });
  return t;
}
function getChatterMonthExtraRevenue(chatterId,monthKey){
  const fin=getChatterFinanceiroMes(chatterId,monthKey);
  if(fin)return fin.totalExtra||0;
  let t=0;
  Object.values(S.horaExtraSlots||{}).forEach(arr=>{
    (arr||[]).forEach(slot=>{
      if(slot.chatterId===chatterId&&slot.shiftId==='parsed'&&(slot.dateKey||'').startsWith(monthKey))t+=parseFloat(slot.revenue)||0;
    });
  });
  return t;
}
function pmMonthOptions(){
  const opts=[];
  const now=new Date();
  for(let i=0;i<12;i++){
    const d=new Date(now.getFullYear(),now.getMonth()-i,1);
    opts.push(d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'));
  }
  return opts;
}
function renderMetricasPerformanceMensal(){
  const sel=document.getElementById('pm-month-select');
  if(!sel)return;
  if(!sel.options.length)sel.innerHTML=pmMonthOptions().map(mk=>`<option value="${mk}">${amMonthLabel(mk)}</option>`).join('');
  const monthKey=sel.value||pmMonthOptions()[0];
  const prevKey=amPrevMonthKey(monthKey);
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  const rows=chatters.map(c=>{
    const atual=getChatterMonthRevenue(c.id,monthKey)+getChatterMonthExtraRevenue(c.id,monthKey);
    const anterior=getChatterMonthRevenue(c.id,prevKey)+getChatterMonthExtraRevenue(c.id,prevKey);
    const variacao=anterior>0?Math.round(((atual-anterior)/anterior)*100):(atual>0?100:null);
    const fonteFinanceiro=!!getChatterFinanceiroMes(c.id,monthKey);
    return{c,atual,anterior,variacao,fonteFinanceiro};
  }).sort((a,b)=>b.atual-a.atual);

  function interpretar(v,atual){
    if(v==null)return atual>0?{txt:'🆕 Sem mês anterior pra comparar',color:'var(--text3)'}:{txt:'— sem faturamento registrado',color:'var(--text3)'};
    if(v>=20)return{txt:'📈 Crescimento forte',color:'var(--ok)'};
    if(v>=5)return{txt:'📈 Em crescimento',color:'var(--ok)'};
    if(v>-5)return{txt:'➡️ Estável',color:'var(--text2)'};
    if(v>-20)return{txt:'📉 Queda moderada — vale atenção',color:'var(--warn)'};
    return{txt:'📉 Queda acentuada — merece conversa direta',color:'var(--bad)'};
  }

  const el=document.getElementById('pm-tabela-content');
  if(!el)return;
  if(!rows.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Cadastre chatters pra ver a performance mensal.</div>';return;}
  el.innerHTML=`<div style="overflow-x:auto"><table class="rtable">
    <thead><tr><th>Chatter</th><th style="text-align:right">${amMonthLabel(monthKey)}</th><th style="text-align:right">${amMonthLabel(prevKey)}</th><th style="text-align:right">Variação</th><th>Interpretação</th></tr></thead>
    <tbody>${rows.map(r=>{
      const interp=interpretar(r.variacao,r.atual);
      return`<tr>
        <td>${r.c.name}${r.fonteFinanceiro?' <span title="Faturamento oficial importado do financeiro" style="font-size:9.5px;font-weight:700;color:var(--accent-strong)">📁</span>':''}</td>
        <td style="text-align:right;font-family:var(--font-mono)">${money(r.atual)}</td>
        <td style="text-align:right;font-family:var(--font-mono);color:var(--text3)">${money(r.anterior)}</td>
        <td style="text-align:right;font-weight:700;color:${r.variacao==null?'var(--text3)':r.variacao>=0?'var(--ok)':'var(--bad)'}">${r.variacao==null?'—':(r.variacao>=0?'+':'')+r.variacao+'%'}</td>
        <td style="color:${interp.color};font-size:12.5px">${interp.txt}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

/* ===========================================================
   MÉTRICAS DE TREINAMENTO — dados manuais por turma de
   recrutamento/treinamento (total inscritos, quantos mandaram
   mensagem, confirmaram, apareceram, foram selecionados pra teste).
   Diferente do resto de Métricas, não é calculado automaticamente
   nem segue a navegação de semana — cada registro é uma turma.
   =========================================================== */
function abrirModalTreinamentoMetrica(){
  ['tm-total','tm-enviaram','tm-confirmaram','tm-apareceram','tm-selecionados','tm-obs'].forEach(id=>{
    const elIn=document.getElementById(id);
    if(elIn)elIn.value='';
  });
  openModal('m-treinamento-metrica');
}
function salvarTreinamentoMetrica(){
  const total=parseInt(document.getElementById('tm-total')?.value)||0;
  if(total<=0){toast('⚠️ Informe o total de pessoas inscritas.');return;}
  const entry={
    id:'tm'+Date.now(),
    criadoEm:new Date().toISOString(),
    totalInscritos:total,
    enviaramMensagem:parseInt(document.getElementById('tm-enviaram')?.value)||0,
    confirmaram:parseInt(document.getElementById('tm-confirmaram')?.value)||0,
    apareceram:parseInt(document.getElementById('tm-apareceram')?.value)||0,
    selecionadosTeste:parseInt(document.getElementById('tm-selecionados')?.value)||0,
    obs:(document.getElementById('tm-obs')?.value||'').trim()
  };
  if(!S.treinamentoMetricas)S.treinamentoMetricas=[];
  S.treinamentoMetricas.push(entry);
  save();
  closeModal('m-treinamento-metrica');
  toast('✅ Registro de Treinamento adicionado!');
  renderMetricasTreinamento();
}
function removerTreinamentoMetrica(id){
  S.treinamentoMetricas=(S.treinamentoMetricas||[]).filter(t=>t.id!==id);
  save();
  renderMetricasTreinamento();
}
function renderMetricasTreinamento(){
  const el=document.getElementById('metricas-treinamento-content');
  if(!el)return;
  const list=[...(S.treinamentoMetricas||[])].reverse();
  if(!list.length){
    el.innerHTML='<div style="color:var(--text3);font-size:12.5px;padding:4px 0">Nenhum registro ainda — clique em + registro pra adicionar os números da turma.</div>';
    return;
  }
  const pct=(n,total)=>total>0?Math.round(n/total*100):0;
  const metricBox=(label,n,total)=>`<div style="background:var(--bg-soft);border-radius:8px;padding:8px 10px">
    <div style="font-size:9.5px;color:var(--text3);text-transform:uppercase;letter-spacing:.03em">${label}</div>
    <div style="font-weight:800;font-family:var(--font-mono);font-size:14px">${n} <span style="font-size:11px;color:var(--text3);font-weight:600">(${pct(n,total)}%)</span></div>
  </div>`;
  el.innerHTML=list.map(t=>{
    const dataBR=new Date(t.criadoEm).toLocaleDateString('pt-BR');
    return`<div class="tm-row" data-key="${t.id}" style="border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px;touch-action:pan-y">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div style="font-weight:700;font-size:13px">${dataBR}</div>
        <div style="font-size:11px;color:var(--text3)">${t.totalInscritos} inscrito${t.totalInscritos!==1?'s':''}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${metricBox('Mandaram mensagem',t.enviaramMensagem,t.totalInscritos)}
        ${metricBox('Confirmaram',t.confirmaram,t.totalInscritos)}
        ${metricBox('Apareceram',t.apareceram,t.totalInscritos)}
        ${metricBox('Selecionados p/ teste',t.selecionadosTeste,t.totalInscritos)}
      </div>
      ${t.obs?`<div style="font-size:11.5px;color:var(--text2);margin-top:8px">${t.obs}</div>`:''}
    </div>`;
  }).join('');
  attachSwipeToDelete(el,'.tm-row',id=>removerTreinamentoMetrica(id),renderMetricasTreinamento);
}

/* ===========================================================
   ANÁLISE MENSAL DE VENDAS — importa o extrato de vendas (xlsx) de
   cada modelo e calcula: total de vendas, high ticket (qtd/valor/%
   das vendas/% do faturamento/comissão), breakdown por tipo de
   entrada, ranking de whales (maiores compradores), breakdown por
   chatter (cruzando o horário de cada venda com a escala de Turno
   atual + swaps daquele dia específico) e comparativo % vs o mês
   anterior da mesma modelo. Só guarda o RESUMO calculado por
   modelo+mês (não as linhas cruas da planilha), pra não pesar o
   documento do Firestore. Reaproveita gerToMins/gerInIvs (já usados
   no Gerador) pra bater horário de venda contra intervalo de turno.
   =========================================================== */
const AM_HT_MIN=300; // mesmo limiar usado no resto do app pra high ticket
const AM_TIPOS_CHATTER=['Chat','Mimo - Chat']; // tipos de venda atribuíveis a quem estava conversando (mesma regra do Gerador)
const AM_DAY_ABBR=['dom','seg','ter','qua','qui','sex','sab'];

function amParseDataCell(val){
  if(val instanceof Date)return val;
  if(typeof val==='number')return new Date(Math.round((val-25569)*86400*1000));
  if(typeof val==='string'){
    const m=val.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if(m)return new Date(+m[3],+m[2]-1,+m[1]);
  }
  return null;
}
function amParseHoraCell(val){
  if(val instanceof Date)return String(val.getHours()).padStart(2,'0')+':'+String(val.getMinutes()).padStart(2,'0');
  if(typeof val==='number'){
    const totalMin=Math.round(val*24*60);
    return String(Math.floor(totalMin/60)%24).padStart(2,'0')+':'+String(totalMin%60).padStart(2,'0');
  }
  if(typeof val==='string')return val.trim().substring(0,5);
  return '00:00';
}
function amShiftsPorDia(modelId,dateKey){
  const [y,mo,d]=dateKey.split('-').map(Number);
  const dow=new Date(y,mo-1,d).getDay();
  const dayAbbr=AM_DAY_ABBR[dow];
  const shifts=(S.shifts||[]).filter(s=>(s.modelIds||[]).includes(modelId)&&(s.days||[]).includes(dayAbbr));
  const swapsForDay=(S.swaps||[]).filter(sw=>sw.date===dateKey);
  const byChatter={};
  shifts.forEach(s=>{
    const gaveAway=swapsForDay.some(sw=>sw.originalId===s.chatterId&&sw.shiftId===s.id);
    if(gaveAway)return;
    if(!byChatter[s.chatterId])byChatter[s.chatterId]=[];
    byChatter[s.chatterId].push(s);
  });
  swapsForDay.forEach(sw=>{
    const orig=(S.shifts||[]).find(s=>s.id===sw.shiftId);
    if(!(orig&&(orig.modelIds||[]).includes(modelId)))return;
    if(!byChatter[sw.covererId])byChatter[sw.covererId]=[];
    byChatter[sw.covererId].push({start:sw.start,end:sw.end,start2:sw.start2||'',end2:sw.end2||''});
  });
  return byChatter;
}
function amAcharChatter(mins,byChatter){
  for(const cid in byChatter){
    const ivs=[];
    byChatter[cid].forEach(s=>{
      if(s.start&&s.end)ivs.push({s:s.start,e:s.end});
      if(s.start2&&s.end2)ivs.push({s:s.start2,e:s.end2});
    });
    if(gerInIvs(mins,ivs))return cid;
  }
  return null;
}
function amMonthLabel(monthKey){
  const [y,mo]=(monthKey||'').split('-').map(Number);
  if(!y||!mo)return monthKey||'';
  const MESES=['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  return MESES[mo-1]+'/'+y;
}
function amPrevMonthKey(monthKey){
  const [y,mo]=monthKey.split('-').map(Number);
  const d=new Date(y,mo-2,1);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
}

function importarAnaliseMensal(e){
  const modelId=document.getElementById('am-model-select')?.value;
  if(!modelId){toast('⚠️ Selecione a modelo antes de importar.');e.target.value='';return;}
  const f=e.target.files[0];if(!f)return;
  if(typeof XLSX==='undefined'){toast('❌ Biblioteca XLSX não carregou — recarregue a página');return;}
  const r=new FileReader();
  r.onload=ev=>{
    try{
      const wb=XLSX.read(ev.target.result,{type:'array'});
      const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
      processarAnaliseMensal(modelId,rows);
    }catch(err){console.error(err);toast('❌ Erro ao ler planilha: '+err.message);}
    e.target.value='';
  };
  r.readAsArrayBuffer(f);
}

function processarAnaliseMensal(modelId,rows){
  const model=(S.models||[]).find(m=>m.id===modelId);
  if(!model){toast('⚠️ Modelo não encontrada.');return;}
  if(!rows.length){toast('⚠️ Planilha vazia.');return;}

  const monthCount={};
  const parsed=[];
  rows.forEach(row=>{
    const situacao=(row['Situação']||row['Situacao']||'').toString().trim();
    if(situacao&&!/confirmad/i.test(situacao))return; // pula pendente/estornado/etc
    const dt=amParseDataCell(row['Data']);
    if(!dt)return;
    const valor=parseFloat(row['Valor da venda'])||0;
    if(valor<=0)return;
    const comissao=parseFloat(row['Sua comissão'])||0;
    const hora=amParseHoraCell(row['Hora']);
    const tipo=(row['Tipo de entrada']||'—').toString().trim();
    const compradorId=(row['ID usuário comprador']||row['Comprador']||'').toString().trim();
    const compradorNome=(row['Comprador']||compradorId||'—').toString().trim();
    const dateKey=fmt(dt);
    const mk=dateKey.slice(0,7);
    monthCount[mk]=(monthCount[mk]||0)+1;
    parsed.push({dateKey,hora,valor,comissao,tipo,compradorId,compradorNome});
  });
  if(!parsed.length){toast('⚠️ Não encontrei vendas confirmadas nessa planilha.');return;}
  const monthKey=Object.entries(monthCount).sort((a,b)=>b[1]-a[1])[0][0];

  const totalFaturamento=parsed.reduce((s,v)=>s+v.valor,0);
  const totalVendas=parsed.length;

  const htSales=parsed.filter(v=>v.valor>=AM_HT_MIN);
  const htCount=htSales.length;
  const htTotal=htSales.reduce((s,v)=>s+v.valor,0);
  const htComissao=htSales.reduce((s,v)=>s+v.comissao,0);
  const htPctVendas=totalVendas>0?Math.round(htCount/totalVendas*100):0;
  const htPctFaturamento=totalFaturamento>0?Math.round(htTotal/totalFaturamento*100):0;

  const porTipoMap={};
  parsed.forEach(v=>{
    if(!porTipoMap[v.tipo])porTipoMap[v.tipo]={total:0,count:0};
    porTipoMap[v.tipo].total+=v.valor;porTipoMap[v.tipo].count++;
  });
  const porTipo=Object.entries(porTipoMap).map(([tipo,d])=>({tipo,total:d.total,count:d.count,pct:totalFaturamento>0?Math.round(d.total/totalFaturamento*100):0})).sort((a,b)=>b.total-a.total);

  const porCompradorMap={};
  parsed.forEach(v=>{
    const key=v.compradorId||v.compradorNome;
    if(!porCompradorMap[key])porCompradorMap[key]={nome:v.compradorNome,total:0,count:0};
    porCompradorMap[key].total+=v.valor;porCompradorMap[key].count++;
    if(v.compradorNome)porCompradorMap[key].nome=v.compradorNome;
  });
  const whales=Object.values(porCompradorMap).sort((a,b)=>b.total-a.total).slice(0,8).map(w=>({...w,pct:totalFaturamento>0?Math.round(w.total/totalFaturamento*100):0}));

  const porChatterMap={};
  let naoAtribuidoTotal=0,naoAtribuidoCount=0;
  parsed.forEach(v=>{
    if(!AM_TIPOS_CHATTER.includes(v.tipo))return;
    const byChatter=amShiftsPorDia(modelId,v.dateKey);
    const cid=amAcharChatter(gerToMins(v.hora),byChatter);
    if(!cid){naoAtribuidoTotal+=v.valor;naoAtribuidoCount++;return;}
    if(!porChatterMap[cid])porChatterMap[cid]={total:0,count:0};
    porChatterMap[cid].total+=v.valor;porChatterMap[cid].count++;
  });
  const porChatter=Object.entries(porChatterMap).map(([cid,d])=>{
    const c=(S.chatters||[]).find(ch=>ch.id===cid);
    return{chatterId:cid,chatterName:c?c.name:'(removido)',total:d.total,count:d.count,pctModelo:totalFaturamento>0?Math.round(d.total/totalFaturamento*100):0};
  }).sort((a,b)=>b.total-a.total);

  const entry={
    id:'am_'+modelId+'_'+monthKey,
    modelId,modelName:model.name,monthKey,
    importadoEm:new Date().toISOString(),
    totalFaturamento,totalVendas,
    htCount,htTotal,htComissao,htPctVendas,htPctFaturamento,
    porTipo,whales,porChatter,
    naoAtribuidoTotal,naoAtribuidoCount
  };

  if(!S.analiseMensal)S.analiseMensal=[];
  const existingIdx=S.analiseMensal.findIndex(a=>a.id===entry.id);
  if(existingIdx>=0)S.analiseMensal[existingIdx]=entry;
  else S.analiseMensal.push(entry);
  save();
  toast(`✅ ${model.name} — ${amMonthLabel(monthKey)}: ${totalVendas} vendas, ${money(totalFaturamento)}`);
  window._amModelId=modelId;
  window._amMonthKey=monthKey;
  renderMetricasAnaliseMensal();
}

function renderMetricasAnaliseMensal(){
  const sel=document.getElementById('am-model-select');
  if(!sel)return;
  const cur=window._amModelId||sel.value;
  sel.innerHTML=(S.models||[]).map(m=>`<option value="${m.id}" ${cur===m.id?'selected':''}>${m.emoji||'🧩'} ${m.name}</option>`).join('')||'<option value="">Cadastre modelos primeiro</option>';
  if(!cur&&S.models&&S.models.length)window._amModelId=S.models[0].id;
  onAnaliseMensalModelChange();
}
function onAnaliseMensalModelChange(){
  const sel=document.getElementById('am-model-select');
  const modelId=sel?.value;
  window._amModelId=modelId;
  const monthSel=document.getElementById('am-month-select');
  const entries=(S.analiseMensal||[]).filter(a=>a.modelId===modelId).sort((a,b)=>b.monthKey.localeCompare(a.monthKey));
  if(monthSel){
    monthSel.innerHTML=entries.length?entries.map(a=>`<option value="${a.monthKey}">${amMonthLabel(a.monthKey)}</option>`).join(''):'<option value="">Nenhuma importação ainda</option>';
    if(window._amMonthKey&&entries.some(a=>a.monthKey===window._amMonthKey))monthSel.value=window._amMonthKey;
    window._amMonthKey=monthSel.value;
  }
  renderAnaliseMensalContent();
}
function renderAnaliseMensalContent(){
  const monthSel=document.getElementById('am-month-select');
  window._amMonthKey=monthSel?.value;
  const el=document.getElementById('am-content');
  if(!el)return;
  const entry=(S.analiseMensal||[]).find(a=>a.modelId===window._amModelId&&a.monthKey===window._amMonthKey);
  if(!entry){
    el.innerHTML='<div style="color:var(--text3);font-size:12.5px;padding:8px 0">Nenhuma planilha importada ainda pra essa modelo — importe o extrato (.xlsx) acima.</div>';
    return;
  }
  const prevEntry=(S.analiseMensal||[]).find(a=>a.modelId===entry.modelId&&a.monthKey===amPrevMonthKey(entry.monthKey));
  const variacao=prevEntry&&prevEntry.totalFaturamento>0?Math.round(((entry.totalFaturamento-prevEntry.totalFaturamento)/prevEntry.totalFaturamento)*100):null;
  const totalGeralMes=(S.analiseMensal||[]).filter(a=>a.monthKey===entry.monthKey).reduce((s,a)=>s+a.totalFaturamento,0);

  const statBox=(label,val,sub)=>`<div style="background:var(--bg-soft);border-radius:10px;padding:10px 12px">
    <div style="font-size:9.5px;color:var(--text3);text-transform:uppercase;letter-spacing:.03em">${label}</div>
    <div style="font-weight:800;font-family:var(--font-mono);font-size:15px">${val}</div>
    ${sub?`<div style="font-size:10.5px;color:var(--text3);margin-top:2px">${sub}</div>`:''}
  </div>`;

  el.innerHTML=`
    <div style="font-size:11px;color:var(--text3);margin-bottom:10px">Importado em ${new Date(entry.importadoEm).toLocaleDateString('pt-BR')} · atribuição por chatter usa a escala de Turno atual (pode não refletir trocas manuais fora do sistema, ou mudanças de escala desde então)</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
      ${statBox('Faturamento total',money(entry.totalFaturamento), variacao!=null?`${variacao>=0?'📈':'📉'} ${variacao>=0?'+':''}${variacao}% vs ${amMonthLabel(amPrevMonthKey(entry.monthKey))}`:'sem mês anterior pra comparar')}
      ${statBox('Total de vendas',entry.totalVendas)}
      ${statBox('High Ticket (≥ '+money(AM_HT_MIN)+')',entry.htCount+' vendas', `${entry.htPctVendas}% das vendas · ${entry.htPctFaturamento}% do faturamento`)}
      ${statBox('Comissão em HT',money(entry.htComissao))}
    </div>

    <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Por tipo de entrada</div>
    <div style="overflow-x:auto;margin-bottom:14px"><table class="rtable">
      <thead><tr><th>Tipo</th><th style="text-align:right">Total</th><th style="text-align:right">% faturamento</th><th style="text-align:right">Qtd</th></tr></thead>
      <tbody>${entry.porTipo.map(t=>`<tr><td>${t.tipo}</td><td style="text-align:right;font-family:var(--font-mono)">${money(t.total)}</td><td style="text-align:right">${t.pct}%</td><td style="text-align:right">${t.count}</td></tr>`).join('')}</tbody>
    </table></div>

    <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Por chatter (Chat/Mimo-Chat, cruzado com a escala)</div>
    <div style="overflow-x:auto;margin-bottom:14px"><table class="rtable">
      <thead><tr><th>Chatter</th><th style="text-align:right">Total</th><th style="text-align:right">% da modelo</th><th style="text-align:right">% do total</th><th style="text-align:right">Qtd</th></tr></thead>
      <tbody>
        ${entry.porChatter.map(c=>`<tr><td>${c.chatterName}</td><td style="text-align:right;font-family:var(--font-mono)">${money(c.total)}</td><td style="text-align:right">${c.pctModelo}%</td><td style="text-align:right">${totalGeralMes>0?Math.round(c.total/totalGeralMes*100):0}%</td><td style="text-align:right">${c.count}</td></tr>`).join('')}
        ${entry.naoAtribuidoCount?`<tr style="color:var(--text3)"><td>Não atribuído (sem turno correspondente)</td><td style="text-align:right;font-family:var(--font-mono)">${money(entry.naoAtribuidoTotal)}</td><td style="text-align:right">${entry.totalFaturamento>0?Math.round(entry.naoAtribuidoTotal/entry.totalFaturamento*100):0}%</td><td style="text-align:right">—</td><td style="text-align:right">${entry.naoAtribuidoCount}</td></tr>`:''}
      </tbody>
    </table></div>

    <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">🐋 Maiores whales</div>
    <div style="overflow-x:auto;margin-bottom:10px"><table class="rtable">
      <thead><tr><th>Comprador</th><th style="text-align:right">Total</th><th style="text-align:right">% faturamento</th><th style="text-align:right">Qtd compras</th></tr></thead>
      <tbody>${entry.whales.map(w=>`<tr><td>${w.nome}</td><td style="text-align:right;font-family:var(--font-mono)">${money(w.total)}</td><td style="text-align:right">${w.pct}%</td><td style="text-align:right">${w.count}</td></tr>`).join('')}</tbody>
    </table></div>

    <button class="btn btn-ghost btn-xs" style="color:var(--bad)" onclick="removerAnaliseMensal('${entry.id}')">✕ Remover essa importação</button>
  `;
}
function removerAnaliseMensal(id){
  if(!confirm('Remover essa análise mensal importada? Essa ação não pode ser desfeita.'))return;
  S.analiseMensal=(S.analiseMensal||[]).filter(a=>a.id!==id);
  save();
  onAnaliseMensalModelChange();
}

/* ===========================================================
   FATURAMENTO OFICIAL DO FINANCEIRO — pedido 04/08/2026: o
   financeiro compartilha (via Drive) uma planilha .xlsx por
   chatter ("Nome_Seduct_Controle_Chatter.xlsx"), com abas
   Parâmetros (nome/mês), Controle Diário Turno/Extra (dia a dia)
   e Fechamento (totais do mês já calculados: faturamento
   turno+extra, meta, % da meta, horas). Importa vários arquivos
   de uma vez (um por chatter), casa cada um com o chatter certo
   pelo nome (mesmo com apelido/variação) e guarda só o resumo —
   esse resumo passa a valer como faturamento oficial na
   Performance Mensal (getChatterMonthRevenue/
   getChatterMonthExtraRevenue), no lugar do lançamento manual
   diário, pra essa pessoa+mês específicos. O lançamento manual
   diário (aba Financeiro) continua existindo pra quem ainda não
   tem planilha importada, e pros outros usos (ranking Semana,
   Relatório Semanal etc.) que dependem de S.revenues por modelo —
   só a leitura de Performance Mensal foi trocada por enquanto.
   =========================================================== */
function ffMatchChatter(nomePlanilha){
  const norm=normalizeName(nomePlanilha);
  if(!norm)return null;
  const normWords=norm.split(/\s+/).filter(w=>w.length>=3);
  let best=null,bestScore=0;
  (S.chatters||[]).forEach(c=>{
    const cn=normalizeName(c.name);
    if(!cn)return;
    if(cn===norm){best=c;bestScore=999;return;}
    if(bestScore>=999)return;
    if(norm.includes(cn)||cn.includes(norm)){
      const score=100+Math.min(cn.length,norm.length);
      if(score>bestScore){bestScore=score;best=c;}
      return;
    }
    const cWords=cn.split(/\s+/).filter(w=>w.length>=3);
    const shared=cWords.filter(w=>normWords.includes(w)).length;
    if(shared>0&&shared>bestScore){bestScore=shared;best=c;}
  });
  return bestScore>0?best:null;
}
function ffAchaLabel(rows,label){
  return rows.find(r=>(r[0]||'').toString().trim().toLowerCase()===label.toLowerCase());
}
function ffAchaValor(rows,label,col){
  const row=ffAchaLabel(rows,label);
  if(!row)return null;
  if(col!=null&&row[col]!=null&&row[col]!=='')return row[col];
  // fallback: primeiro valor não-vazio depois da coluna 0
  for(let i=1;i<row.length;i++){if(row[i]!=null&&row[i]!=='')return row[i];}
  return null;
}
function ffParsePorDia(rows,valorCol,horasCol){
  const headerIdx=rows.findIndex(r=>(r[0]||'').toString().trim().toUpperCase()==='DIA');
  if(headerIdx<0)return{};
  const out={};
  for(let i=headerIdx+1;i<rows.length;i++){
    const row=rows[i];
    const dia=row&&row[0];
    if(dia==null||dia===''||isNaN(Number(dia)))break;
    out[Math.round(Number(dia))]={valor:parseFloat(row[valorCol])||0,horas:parseFloat(row[horasCol])||0};
  }
  return out;
}
function ffAchaValorEmQualquerCol(rows,label){
  // Alguns indicadores (High Tickets, Metas Semanais) ficam numa coluna
  // "INDICADORES" no meio da tabela, não na coluna 0 — varre todas as
  // colunas de cada linha procurando o rótulo.
  for(const row of rows){
    if(!row)continue;
    for(let i=0;i<row.length;i++){
      if((row[i]||'').toString().trim().toLowerCase()===label.toLowerCase()){
        for(let j=i+1;j<row.length;j++){if(row[j]!=null&&row[j]!=='')return row[j];}
      }
    }
  }
  return null;
}
function ffParseMetasSemanais(rows){
  const headerIdx=rows.findIndex(r=>(r[0]||'').toString().trim().toUpperCase()==='SEMANA');
  if(headerIdx<0)return[];
  const out=[];
  for(let i=headerIdx+1;i<rows.length;i++){
    const row=rows[i];
    const label=((row&&row[0])||'').toString().trim();
    if(!label||!/^semana/i.test(label))break;
    out.push({
      semana:label,categoria:(row[1]||'').toString().trim(),
      faturamento:parseFloat(row[2])||0,pctMeta:parseFloat(row[3])||0,
      nivel:(row[4]||'').toString().trim(),premio:parseFloat(row[5])||0,
      horas:parseFloat(row[6])||0
    });
  }
  return out;
}
function parseControleChatterWorkbook(wb,fileName){
  const paramSheet=wb.Sheets['Parâmetros'];
  const fechamentoSheet=wb.Sheets['Fechamento'];
  if(!paramSheet||!fechamentoSheet)return{erro:'Planilha não parece ser o modelo "Controle Chatter" (faltam abas Parâmetros/Fechamento).'};
  const paramRows=XLSX.utils.sheet_to_json(paramSheet,{header:1,defval:null});
  const fechRows=XLSX.utils.sheet_to_json(fechamentoSheet,{header:1,defval:null});

  const nomeRaw=(ffAchaValor(paramRows,'Nome do chatter',1)||'').toString().trim();
  if(!nomeRaw)return{erro:'Não encontrei "Nome do chatter" na aba Parâmetros.'};
  const mesRefRaw=ffAchaValor(paramRows,'Mês / Ano (referência)',1);
  const mesRefDate=amParseDataCell(mesRefRaw);
  if(!mesRefDate)return{erro:'Não encontrei o "Mês / Ano (referência)" na aba Parâmetros.'};
  const monthKey=mesRefDate.getFullYear()+'-'+String(mesRefDate.getMonth()+1).padStart(2,'0');

  const totalTurno=parseFloat(ffAchaValor(fechRows,'Faturamento turno principal',3))||0;
  const totalExtra=parseFloat(ffAchaValor(fechRows,'Faturamento horas extras',3))||0;
  const totalGeral=parseFloat(ffAchaValor(fechRows,'FATURAMENTO TOTAL (turno + extra)',3))||(totalTurno+totalExtra);
  const horasTotais=parseFloat(ffAchaValor(fechRows,'Horas trabalhadas no mês',3))||0;
  const meta=parseFloat(ffAchaValor(fechRows,'Meta mensal estipulada',3))||0;
  const atingiuMetaRaw=(ffAchaValor(fechRows,'Atingiu a meta?',3)||'').toString().trim().toUpperCase();
  const atingiuMeta=atingiuMetaRaw==='SIM';
  const pctMeta=parseFloat(ffAchaValor(fechRows,'% da meta atingida',3))||0;

  let porDiaTurno={},porDiaExtra={};
  const turnoSheet=wb.Sheets['Controle Diário Turno'];
  const extraSheet=wb.Sheets['Controle Diário Extra'];
  if(turnoSheet)porDiaTurno=ffParsePorDia(XLSX.utils.sheet_to_json(turnoSheet,{header:1,defval:null}),2,4);
  if(extraSheet)porDiaExtra=ffParsePorDia(XLSX.utils.sheet_to_json(extraSheet,{header:1,defval:null}),2,3);

  let porSemana=[];
  const metasSheet=wb.Sheets['Metas Semanais'];
  if(metasSheet)porSemana=ffParseMetasSemanais(XLSX.utils.sheet_to_json(metasSheet,{header:1,defval:null}));

  let htCount=0,htMaior=0,htBonusTotal=0,htTotalValor=0,htPorDia={},htPorProduto={};
  const htSheet=wb.Sheets['High Tickets'];
  if(htSheet){
    const htRows=XLSX.utils.sheet_to_json(htSheet,{header:1,defval:null});
    // Soma direto das linhas de venda (coluna MODELO preenchida = venda real,
    // não linha vazia de indicador) — mais confiável que só ler o indicador
    // "Bônus total", porque também dá o valor bruto (sem o desconto do 8%),
    // usado pra alimentar o cálculo de Pagamento do próprio app. A planilha
    // também tem colunas DIA (col1) e PRODUTO (col9) por venda — usadas pra
    // montar o resumo diário de high ticket e o total por tipo de produto,
    // pedido 04/08/2026 pra deixar o myperformance mais completo.
    const headerIdx=htRows.findIndex(r=>(r[0]||'').toString().trim()==='#');
    if(headerIdx>=0){
      for(let i=headerIdx+1;i<htRows.length;i++){
        const row=htRows[i];
        if(!row||row[3]==null||row[3]==='')continue;
        const valor=parseFloat(row[5])||0;
        const dia=parseInt(row[1],10);
        const produto=(row[9]||'').toString().trim()||'Outro';
        htCount++;htTotalValor+=valor;
        if(valor>htMaior)htMaior=valor;
        if(dia){
          if(!htPorDia[dia])htPorDia[dia]={count:0,valor:0};
          htPorDia[dia].count++;htPorDia[dia].valor+=valor;
        }
        if(!htPorProduto[produto])htPorProduto[produto]={count:0,valor:0};
        htPorProduto[produto].count++;htPorProduto[produto].valor+=valor;
      }
    }
    htBonusTotal=parseFloat(ffAchaValorEmQualquerCol(htRows,'Bônus total (8%)'))||Math.round(htTotalValor*0.08*100)/100;
  }

  // Categoria/medalha atual = a da semana mais recente já lançada (o
  // financeiro reavalia isso toda semana no cadastro do chatter).
  const categoriaAtual=porSemana.length?porSemana[porSemana.length-1].categoria:'';

  return{
    nomeRaw,monthKey,totalTurno,totalExtra,totalGeral,horasTotais,meta,atingiuMeta,pctMeta,
    porDiaTurno,porDiaExtra,porSemana,categoriaAtual,htCount,htMaior,htBonusTotal,htTotalValor,
    htPorDia,htPorProduto,arquivoNome:fileName
  };
}
function importarFaturamentoFinanceiro(e){
  const files=Array.from(e.target.files||[]);
  if(!files.length)return;
  if(typeof XLSX==='undefined'){toast('❌ Biblioteca XLSX não carregou — recarregue a página');e.target.value='';return;}
  let restantes=files.length;
  const resultados=[];
  files.forEach(f=>{
    const r=new FileReader();
    r.onload=ev=>{
      try{
        const wb=XLSX.read(ev.target.result,{type:'array',cellDates:true});
        const parsed=parseControleChatterWorkbook(wb,f.name);
        if(parsed.erro){
          resultados.push({arquivo:f.name,ok:false,msg:parsed.erro});
        }else{
          const chatter=ffMatchChatter(parsed.nomeRaw);
          if(!chatter){
            resultados.push({arquivo:f.name,ok:false,msg:`Não achei um chatter cadastrado parecido com "${parsed.nomeRaw}".`});
          }else{
            if(!S.faturamentoFinanceiro)S.faturamentoFinanceiro={};
            if(!S.faturamentoFinanceiro[chatter.id])S.faturamentoFinanceiro[chatter.id]={};
            S.faturamentoFinanceiro[chatter.id][parsed.monthKey]={
              totalTurno:parsed.totalTurno,totalExtra:parsed.totalExtra,totalGeral:parsed.totalGeral,
              horasTotais:parsed.horasTotais,meta:parsed.meta,atingiuMeta:parsed.atingiuMeta,pctMeta:parsed.pctMeta,
              porDiaTurno:parsed.porDiaTurno,porDiaExtra:parsed.porDiaExtra,
              porSemana:parsed.porSemana,categoriaAtual:parsed.categoriaAtual,
              htCount:parsed.htCount,htMaior:parsed.htMaior,htBonusTotal:parsed.htBonusTotal,htTotalValor:parsed.htTotalValor,
              htPorDia:parsed.htPorDia,htPorProduto:parsed.htPorProduto,
              nomeNaPlanilha:parsed.nomeRaw,arquivoNome:parsed.arquivoNome,
              importadoEm:new Date().toISOString()
            };
            resultados.push({arquivo:f.name,ok:true,chatterNome:chatter.name,monthKey:parsed.monthKey,total:parsed.totalGeral});
          }
        }
      }catch(err){
        console.error(err);
        resultados.push({arquivo:f.name,ok:false,msg:'Erro ao ler: '+err.message});
      }
      restantes--;
      if(restantes===0){
        save();
        const ok=resultados.filter(r=>r.ok);
        const falhas=resultados.filter(r=>!r.ok);
        if(ok.length)toast(`✅ ${ok.length} planilha${ok.length!==1?'s':''} importada${ok.length!==1?'s':''}: ${ok.map(r=>r.chatterNome).join(', ')}`);
        if(falhas.length)setTimeout(()=>{alert('⚠️ Alguns arquivos não foram importados:\n\n'+falhas.map(r=>`• ${r.arquivo}: ${r.msg}`).join('\n'));},ok.length?300:0);
        renderFaturamentoFinanceiro();
        renderMetricasPerformanceMensal();
      }
    };
    r.readAsArrayBuffer(f);
  });
  e.target.value='';
}
function removerFaturamentoFinanceiro(chatterId,monthKey){
  if(!confirm('Remover essa importação? A Performance Mensal dessa pessoa/mês volta a usar o lançamento manual.'))return;
  if(S.faturamentoFinanceiro&&S.faturamentoFinanceiro[chatterId]){
    delete S.faturamentoFinanceiro[chatterId][monthKey];
    if(!Object.keys(S.faturamentoFinanceiro[chatterId]).length)delete S.faturamentoFinanceiro[chatterId];
  }
  save();
  renderFaturamentoFinanceiro();
  renderMetricasPerformanceMensal();
}
function renderFaturamentoFinanceiro(){
  const el=document.getElementById('ff-content');
  if(!el)return;
  const rows=[];
  Object.keys(S.faturamentoFinanceiro||{}).forEach(chatterId=>{
    const c=(S.chatters||[]).find(ch=>ch.id===chatterId);
    Object.keys(S.faturamentoFinanceiro[chatterId]).forEach(monthKey=>{
      rows.push({chatterId,chatterNome:c?c.name:'(removido)',monthKey,...S.faturamentoFinanceiro[chatterId][monthKey]});
    });
  });
  if(!rows.length){
    el.innerHTML='<div style="color:var(--text3);font-size:12.5px;padding:8px 0">Nenhuma planilha do financeiro importada ainda.</div>';
    return;
  }
  rows.sort((a,b)=>b.monthKey.localeCompare(a.monthKey)||a.chatterNome.localeCompare(b.chatterNome));
  el.innerHTML=`<div style="overflow-x:auto"><table class="rtable">
    <thead><tr><th>Chatter</th><th>Mês</th><th style="text-align:right">Faturamento</th><th style="text-align:right">Meta</th><th></th></tr></thead>
    <tbody>${rows.map(r=>`<tr>
      <td>${r.chatterNome}</td>
      <td>${amMonthLabel(r.monthKey)}</td>
      <td style="text-align:right;font-family:var(--font-mono)">${money(r.totalGeral)}</td>
      <td style="text-align:right;font-weight:700;color:${r.atingiuMeta?'var(--ok)':'var(--text3)'}">${r.atingiuMeta?'✅ bateu':(r.pctMeta?Math.round(r.pctMeta*100)+'%':'—')}</td>
      <td><button class="btn btn-ghost btn-xs" style="color:var(--bad)" onclick="removerFaturamentoFinanceiro('${r.chatterId}','${r.monthKey}')">✕</button></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

// ---- Perguntar à IA sobre os dados já calculados (opcional, sob demanda) ----
let _metricasDataCache=null;
function buildMetricasContextoParaIA(data){
  const lines=[];
  lines.push(`Semana: ${weekLabel(data.offset)} (${data.wkey}). Faturamento total da operação: ${money(data.totalOperacao)}.`);
  data.perChatter.forEach(p=>{
    lines.push(`- ${p.c.name} (${p.cargo}, modelo(s): ${p.models.join(', ')||'sem escala'}): receita semana ${money(p.fatAtual)} (variação ${fmtPctSigned(p.variacao)}), receita/hora ${p.receitaPorHora!=null?money(p.receitaPorHora):'—'}, conversão ChatLab ${p.clMetrics.taxaConversao!=null?p.clMetrics.taxaConversao+'%':'—'}, ticket médio ${p.ticketMedio>0?money(p.ticketMedio):'—'}, dependência da operação ${p.dependencia}%, ID geral ${p.idGeral!=null?p.idGeral+'%':'—'} (performance ${fmtPct(p.idComponentes.performance)}, crescimento ${fmtPctSigned(p.idComponentes.crescimento)}, qualidade ${p.idComponentes.qualidade!=null?p.idComponentes.qualidade+'%':'—'}, consistência ${fmtPct(p.idComponentes.consistencia)}).`);
  });
  lines.push(`\nEvolução por modelo:`);
  data.porModelo.forEach(m=>{
    lines.push(`- ${m.modelName}: faturamento ${money(m.totalAtual)} (variação ${fmtPctSigned(m.variacaoTime)}), melhor chatter: ${m.melhor?m.melhor.c.name:'—'}.`);
  });
  const comLeader=data.leaderboard.filter(l=>l.melhor);
  if(comLeader.length){
    lines.push(`\nMelhor chatter por categoria do ChatLab essa semana:`);
    comLeader.forEach(l=>lines.push(`- ${l.label}: ${l.melhor.name} (${l.melhor.nota.toFixed(1)}/10)`));
  }
  return lines.join('\n');
}
const METRICAS_IA_SYSTEM=`Você é um analista de operação sênior de uma agência de chatters. Todos os números que você recebe abaixo JÁ VÊM CALCULADOS automaticamente pelo sistema (faturamento, horas, ChatLab) — nunca refaça conta nem invente número novo, só leia, compare e interprete o que a gestora perguntar. Se a pergunta pedir algo que não está nos dados fornecidos, diga isso claramente em vez de supor. Responda em português, direto, sem enrolação, em markdown simples.`;
async function perguntarIAMetricas(){
  const input=document.getElementById('metricas-ia-input');
  const question=(input?.value||'').trim();
  if(!question){toast('Digite uma pergunta antes.');return;}
  const btn=document.getElementById('metricas-ia-btn');
  const out=document.getElementById('metricas-ia-resposta');
  if(btn){btn.disabled=true;btn.textContent='🤖 Analisando...';}
  if(out)out.innerHTML='<div style="color:var(--text3);font-size:12.5px">Consultando os dados já calculados...</div>';
  try{
    const data=_metricasDataCache||buildMetricasData(weekOffset);
    const contexto=buildMetricasContextoParaIA(data);
    const prompt=`DADOS JÁ CALCULADOS PELO SISTEMA (semana atual):\n\n${contexto}\n\nPERGUNTA DA GESTORA:\n${question}`;
    const text=await clFetchAI(METRICAS_IA_SYSTEM,prompt,2000);
    if(!text)throw new Error('Resposta vazia da IA');
    if(out)out.innerHTML=`<div style="border-top:1px solid var(--line);padding-top:10px;margin-top:4px">${clMd(text)}</div>`;
  }catch(err){
    if(err.quota){renderAIWaitCountdown('metricas-ia-resposta',err.waitSeconds,{prefix:'⏳ limite de uso da IA',panel:true});}
    else if(out)out.innerHTML=`<div style="color:var(--bad);font-size:12.5px">❌ ${err.message}</div>`;
  }finally{
    if(btn){btn.disabled=false;btn.textContent='🤖 Perguntar';}
  }
}

// Quantos dias de trabalho ainda restam essa semana pra um chatter (hoje
// incluso), pra dividir "quanto falta" em uma meta diária de apoio
function getRemainingWorkDaysThisWeek(chatterId){
  const wd=getWeekDates(0);
  const today=todayKey();
  let count=0;
  wd.forEach(d=>{
    const dk=fmt(d);
    if(dk<today)return;
    const dayKey=DAY_KEYS[d.getDay()];
    const hasShift=S.shifts.some(s=>s.chatterId===chatterId&&(s.days||[]).includes(dayKey)&&s.folgaDia!==dayKey);
    if(hasShift)count++;
  });
  return count;
}
let pagWeekOffset=0;
function setPagWeekOffset(o){
  pagWeekOffset=Math.min(0,o); // nunca deixa ir pro futuro
  renderPagChattersAll();
  renderPagWeekNav();
}
function renderPagWeekNav(){
  const el=document.getElementById('pag-week-nav');
  if(!el)return;
  const isNow=pagWeekOffset===0;
  el.innerHTML=`<div style="display:flex;align-items:center;gap:6px">
    <button onclick="setPagWeekOffset(${pagWeekOffset-1})" style="background:var(--bg-soft);border:1px solid var(--line);border-radius:7px;padding:4px 10px;cursor:pointer;font-size:14px;color:var(--text2)">‹</button>
    <div style="font-size:12.5px;font-weight:600;color:var(--text2);min-width:140px;text-align:center">${weekLabel(pagWeekOffset)}${isNow?' <span style="font-size:10px;color:var(--ok)">(atual)</span>':''}</div>
    <button onclick="setPagWeekOffset(${pagWeekOffset+1})" ${isNow?'disabled style="opacity:.3;cursor:not-allowed"':''} style="background:var(--bg-soft);border:1px solid var(--line);border-radius:7px;padding:4px 10px;cursor:pointer;font-size:14px;color:var(--text2)">›</button>
    ${!isNow?`<button onclick="setPagWeekOffset(0)" style="background:var(--accent-soft);border:none;border-radius:7px;padding:4px 9px;cursor:pointer;font-size:11px;font-weight:600;color:var(--accent)">hoje</button>`:''}
  </div>`;
}
function getChatterWeekWorkStats(cid,offset){
  const f=S.chatterFichas[cid];
  const analytics=f?.analytics?.weeklyData||{};
  const wd=getWeekDates(offset);
  let dias=0,horas=0;
  wd.forEach(d=>{
    const a=analytics[fmt(d)];
    if(a&&((a.chatterTotal||0)>0||(a.extraTotal||0)>0||(a.totalVendas||0)>0)){dias++;horas+=a.shiftHours||0;}
  });
  return{dias,horas:Math.round(horas*10)/10};
}
function renderPagChattersAll(){
  const el=document.getElementById('pag-chatters-all');
  if(!el)return;
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  if(!chatters.length){el.innerHTML='';return;}
  const wkey=getWeekKey(pagWeekOffset);
  const readOnly=pagWeekOffset!==0; // resultado de semana passada é só consulta

  el.innerHTML=`<div class="panel">
    <div class="panel-head"><div class="panel-title">📋 Todos os chatters ${pagWeekOffset===0?'— semana atual':'— '+weekLabel(pagWeekOffset)}</div><div class="panel-note">${readOnly?'Consulta de semana anterior — categoria e medalha não editáveis aqui':'Faturamento, medalha, high ticket e "falta pra meta" são automáticos. Só escolha a categoria.'}</div></div>
    ${chatters.map(c=>{
      // Tudo automático a partir dos dados reais — respeita a semana selecionada aqui
      const weekRev=getChatterWeekRevenue(c.id,pagWeekOffset);
      const weekExtra=getChatterExtraRevenue(c.id,pagWeekOffset);
      const {avgHtPct,htTotal}=getChatterWeekHighTicket(c.id,pagWeekOffset);
      const {dias,horas}=getChatterWeekWorkStats(c.id,pagWeekOffset);
      const fatPorHora=horas>0?(weekRev+weekExtra)/horas:0;
      // Categoria: única escolha manual (padrão sugerido pela meta cadastrada)
      const goals=S.chatterWeekGoals[wkey]||{};
      const metaVal=parseFloat(goals[c.id])||0;
      const savedCat=S.chatterFichas?.[c.id]?.pagCategoria;
      const cat=savedCat||Object.entries(PAG_CATS).find(([k,v])=>metaVal>0&&metaVal<=v.n100)?.[0]||'B';
      // A meta REAL é a que você define em Faturamento — quando existir,
      // ela substitui a meta padrão da categoria em todos os cálculos daqui.
      const metaCat=metaVal>0?metaVal:PAG_CATS[cat].n100;
      const pct=weekRev>0&&metaCat>0?Math.round(weekRev/metaCat*100):0;
      const falta=Math.max(0,metaCat-weekRev);
      const remainDays=pagWeekOffset===0?getRemainingWorkDaysThisWeek(c.id):0;
      const faltaPorDia=falta>0&&remainDays>0?falta/remainDays:null;
      const statsPagAll=getChatterMonthStats(c.id);
      const autoMedal=autoMedalForChatter(c.id,cat,statsPagAll.monthRevenue+statsPagAll.monthExtra);
      const manualMedalRaw=S.chatterFichas?.[c.id]?.manualMedal;
      const hasManualMedal=manualMedalRaw!==undefined&&manualMedalRaw!==''&&manualMedalRaw!==null;
      const medal=hasManualMedal?parseInt(manualMedalRaw,10):autoMedal;
      const r=calcChatterPagamento(weekRev,medal,cat,htTotal,weekExtra,metaVal);
      const col=pct>=100?'var(--ok)':pct>=85?'var(--warn)':pct>=70?'var(--info)':'var(--bad)';
      const tier=pct>=100?'100%':pct>=85?'85%':pct>=70?'70%':'—';
      return`<div style="background:var(--bg-soft);border-radius:10px;padding:12px;margin-bottom:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div style="font-weight:700;font-size:14px">${c.name} <span style="font-size:11px;color:var(--text3)">${c.level}</span></div>
          <div style="font-size:18px;font-weight:800;font-family:var(--font-mono);color:var(--ok)">${money(r.totalComPiso)}</div>
        </div>
        <div style="background:var(--line);border-radius:4px;height:7px;overflow:hidden;margin-bottom:5px">
          <div style="height:7px;border-radius:4px;background:${col};width:${Math.min(100,pct)}%;transition:width .3s"></div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:11.5px;margin-bottom:6px">
          <span style="color:${col};font-weight:700">${pct}% da meta <span style="background:${col};color:#fff;border-radius:5px;padding:1px 6px;font-size:10px;margin-left:4px">degrau ${tier}</span></span>
          <span style="color:var(--text3)">${money(weekRev)} de ${money(metaCat)}${metaVal>0?'':' (categoria)'}</span>
        </div>
        <div style="margin-bottom:10px">
          ${falta>0?`<div style="color:var(--bad);font-weight:700;font-size:12.5px">falta ${money(falta)}${faltaPorDia?` · <span style="color:var(--warn)">${money(faltaPorDia)}/dia</span> em ${remainDays} dia${remainDays>1?'s':''} de trabalho restante${remainDays>1?'s':''}`:remainDays===0&&pagWeekOffset===0?' · sem mais dias de trabalho essa semana':''}</div>`:`<div style="color:var(--ok);font-weight:700;font-size:12.5px">✅ meta batida!</div>`}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px">
          <div style="background:var(--bg);border-radius:7px;padding:7px;text-align:center">
            <div style="font-size:9px;color:var(--text3)">Faturamento (auto)</div>
            <div style="font-size:13px;font-weight:700;font-family:var(--font-mono)">${money(weekRev)}</div>
          </div>
          <div class="field" style="margin:0">
            <label class="flabel">Medalha${hasManualMedal?'':' (auto)'}</label>
            <select class="fselect" style="font-size:12px;padding:6px 8px" ${readOnly?'disabled':''} onchange="saveManualMedal('${c.id}',this.value);renderPagChattersAll()">
              <option value="" ${!hasManualMedal?'selected':''}>Auto — ${PAG_MEDAL_LABEL[autoMedal]}</option>
              ${[0,1,2,3,4].map(m=>`<option value="${m}" ${hasManualMedal&&medal===m?'selected':''}>${PAG_MEDAL_LABEL[m]}</option>`).join('')}
            </select>
          </div>
          <div class="field" style="margin:0">
            <label class="flabel">Categoria</label>
            <select class="fselect" style="font-size:12px;padding:6px 8px" id="pag-c-cat-${c.id}" ${readOnly?'disabled':''} onchange="saveChatterPagCategoria('${c.id}',this.value);renderPagChattersAll()">
              ${['A','B','C','D','E'].map(k=>`<option value="${k}" ${cat===k?'selected':''}>${k} — meta ${money(PAG_CATS[k].n100)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin-bottom:6px">
          <div style="background:var(--bg);border-radius:7px;padding:6px;text-align:center">
            <div style="font-size:8.5px;color:var(--text3)">Dias trabalhados</div>
            <div style="font-size:12.5px;font-weight:700">${dias}</div>
          </div>
          <div style="background:var(--bg);border-radius:7px;padding:6px;text-align:center">
            <div style="font-size:8.5px;color:var(--text3)">Horas (turno+extra)</div>
            <div style="font-size:12.5px;font-weight:700">${horas}h</div>
          </div>
          <div style="background:var(--bg);border-radius:7px;padding:6px;text-align:center">
            <div style="font-size:8.5px;color:var(--text3)">Fatur. por hora</div>
            <div style="font-size:12.5px;font-weight:700;font-family:var(--font-mono)">${money(fatPorHora)}</div>
          </div>
          <div style="background:var(--bg);border-radius:7px;padding:6px;text-align:center">
            <div style="font-size:8.5px;color:var(--text3)">High ticket ≥R$300</div>
            <div style="font-size:12.5px;font-weight:700">${avgHtPct}%</div>
          </div>
        </div>
        <div id="pag-c-result-${c.id}" style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:8px">
          ${renderChatterPagCells(r,pct,col,medal)}
        </div>
        <button class="btn btn-ghost btn-xs btn-block" onclick="toggleCatComparison('${c.id}')">📊 Ver ganho em todas as 5 categorias</button>
        <div id="pag-cat-compare-${c.id}" style="display:none;margin-top:8px"></div>
        <button class="btn btn-ghost btn-xs btn-block" style="margin-top:6px" onclick="toggleMonthDashboard('${c.id}')">📅 Ver painel do mês completo</button>
        <div id="pag-month-dash-${c.id}" style="display:none;margin-top:8px"></div>
        ${(()=>{
          // Piso é MENSAL, não semanal — soma as últimas ~4 semanas (mês
          // corrente aproximado) e compara com o piso garantido da medalha.
          if(pagWeekOffset!==0)return''; // só mostra na semana atual, pra não confundir
          let monthTotal=0;
          for(let o=0;o>-4;o--){
            const rv=getChatterWeekRevenue(c.id,o);
            const rx=getChatterExtraRevenue(c.id,o);
            const {htTotal:ht2}=getChatterWeekHighTicket(c.id,o);
            monthTotal+=calcChatterPagamento(rv,medal,cat,ht2,rx,0).totalComPiso;
          }
          const piso=PAG_PISO[medal]||1000;
          const faltaPiso=Math.max(0,piso-monthTotal);
          return`<div style="margin-top:8px;font-size:11px;color:var(--text3);border-top:1px solid var(--line);padding-top:8px">
            💰 Piso mensal (${PAG_MEDAL_LABEL[medal]}): ${money(piso)} · últimas 4 semanas somaram ${money(monthTotal)}
            ${faltaPiso>0?`<span style="color:var(--warn)"> · empresa completaria +${money(faltaPiso)} se o mês fechar assim</span>`:` <span style="color:var(--ok)">· já passou do piso ✅</span>`}
          </div>`;
        })()}
      </div>`;
    }).join('')}
  </div>`;
}
function toggleCatComparison(cid){
  const el=document.getElementById('pag-cat-compare-'+cid);
  if(!el)return;
  if(el.style.display==='block'){el.style.display='none';return;}
  el.style.display='block';
  const c=S.chatters.find(ch=>ch.id===cid);
  if(!c)return;
  const weekRev=getChatterWeekRevenue(cid,pagWeekOffset);
  const weekExtra=getChatterExtraRevenue(cid,pagWeekOffset);
  const {htTotal}=getChatterWeekHighTicket(cid,pagWeekOffset);
  const manualMedalRaw=S.chatterFichas?.[cid]?.manualMedal;
  const wkey=getWeekKey(pagWeekOffset);
  const goals=S.chatterWeekGoals[wkey]||{};
  const metaVal=parseFloat(goals[cid])||0;
  const savedCat=S.chatterFichas?.[cid]?.pagCategoria||'B';
  const statsCatCmp=getChatterMonthStats(cid);
  const autoMedal=autoMedalForChatter(cid,savedCat,statsCatCmp.monthRevenue+statsCatCmp.monthExtra);
  const medal=(manualMedalRaw!==undefined&&manualMedalRaw!=='')?parseInt(manualMedalRaw,10):autoMedal;
  el.innerHTML=`<div style="background:var(--bg);border-radius:8px;padding:8px 10px">
    <div style="font-size:10px;color:var(--text3);margin-bottom:6px">Com o MESMO faturamento (${money(weekRev)}), veja quanto ${c.name.split(' ')[0]} ganharia em cada categoria — não muda a categoria dela de verdade, é só comparação</div>
    ${['A','B','C','D','E'].map(k=>{
      const rk=calcChatterPagamento(weekRev,medal,k,htTotal,weekExtra,0);
      const isCurrentCat=k===savedCat;
      return`<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;${isCurrentCat?'font-weight:700':''};border-bottom:1px solid var(--line);font-size:12px">
        <span>${isCurrentCat?'👉 ':''}Categoria ${k} <span style="color:var(--text3);font-size:10.5px">(meta ${money(PAG_CATS[k].n100)})</span></span>
        <span style="font-family:var(--font-mono);color:${isCurrentCat?'var(--ok)':'var(--text)'}">${money(rk.totalComPiso)}</span>
      </div>`;
    }).join('')}
  </div>`;
}
function toggleMonthDashboard(cid){
  const el=document.getElementById('pag-month-dash-'+cid);
  if(!el)return;
  if(el.style.display==='block'){el.style.display='none';return;}
  el.style.display='block';
  const c=S.chatters.find(ch=>ch.id===cid);
  if(!c)return;
  const savedCat=S.chatterFichas?.[cid]?.pagCategoria||'B';
  const manualMedalRaw=S.chatterFichas?.[cid]?.manualMedal;
  const statsDashGate=getChatterMonthStats(cid);
  const autoMedal=autoMedalForChatter(cid,savedCat,statsDashGate.monthRevenue+statsDashGate.monthExtra);
  const medal=(manualMedalRaw!==undefined&&manualMedalRaw!=='')?parseInt(manualMedalRaw,10):autoMedal;
  const earn=getChatterMonthEarnings(cid,medal,savedCat);
  const daysInMonth=getDaysInCurrentMonth();
  const daysSoFar=new Date().getDate();
  const metaMensal=PAG_CATS[savedCat].n100*(daysInMonth/7);
  const pctMes=metaMensal>0?Math.round((earn.monthRevenue+earn.monthExtra)/metaMensal*100):0;
  const ritmoAtual=daysSoFar>0?(earn.monthRevenue+earn.monthExtra)*(daysInMonth/daysSoFar):0;
  const pctRitmo=metaMensal>0?Math.round(ritmoAtual/metaMensal*100):0;
  const maxBar=Math.max(...earn.dayByDay.map(d=>d.rev),1);

  // Degraus da meta SEMANAL (70/85/100%) — mostra qual já foi batido essa
  // semana, pra ficar claro em qual degrau a pessoa está agora.
  const cat=PAG_CATS[savedCat];
  const tiers=[
    {label:'70%',meta:cat.n70,premio:cat.p70,batido:weekRevNow>=cat.n70},
    {label:'85%',meta:cat.n85,premio:cat.p85,batido:weekRevNow>=cat.n85},
    {label:'100%',meta:cat.n100,premio:cat.p100,batido:weekRevNow>=cat.n100},
  ];

  el.innerHTML=`<div style="background:var(--bg);border-radius:10px;padding:14px">
    <div style="text-align:center;margin-bottom:10px">
      <div style="font-size:10px;color:var(--text3);text-transform:uppercase">Faturamento do mês</div>
      <div style="font-size:26px;font-weight:800;font-family:var(--font-mono)">${money(earn.monthRevenue+earn.monthExtra)}</div>
      <div style="font-size:11px;color:var(--text3)">de uma meta de ${money(metaMensal)} no mês</div>
    </div>
    <div style="background:var(--line);border-radius:5px;height:9px;overflow:hidden;margin-bottom:4px">
      <div style="height:9px;background:${pctMes>=100?'var(--ok)':'var(--accent)'};width:${Math.min(100,pctMes)}%"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:10.5px;color:var(--text3);margin-bottom:10px">
      <span>Início</span><span>Meta ${money(metaMensal)}</span>
    </div>
    <div style="text-align:center;margin-bottom:12px">
      <span class="pill ${pctRitmo>=100?'pill-ok':'pill-warn'}" style="font-size:11px">NO RITMO ATUAL: ${money(ritmoAtual)} · ${pctRitmo}% da meta</span>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:6px">
      <div style="background:var(--bg-soft);border-radius:7px;padding:7px;text-align:center">
        <div style="font-size:8.5px;color:var(--text3)">Ticket médio</div>
        <div style="font-size:12.5px;font-weight:700">${money(earn.avgTicket)}</div>
        <div style="font-size:8px;color:var(--text3)">${earn.vendasSum} vendas</div>
      </div>
      <div style="background:var(--bg-soft);border-radius:7px;padding:7px;text-align:center">
        <div style="font-size:8.5px;color:var(--text3)">High ticket</div>
        <div style="font-size:12.5px;font-weight:700">${earn.avgHtPct}%</div>
        <div style="font-size:8px;color:var(--text3)">do faturamento</div>
      </div>
      <div style="background:var(--bg-soft);border-radius:7px;padding:7px;text-align:center">
        <div style="font-size:8.5px;color:var(--text3)">Dias no mês</div>
        <div style="font-size:12.5px;font-weight:700">${earn.diasTrabalhados}</div>
        <div style="font-size:8px;color:var(--text3)">trabalhados</div>
      </div>
      <div style="background:var(--bg-soft);border-radius:7px;padding:7px;text-align:center">
        <div style="font-size:8.5px;color:var(--text3)">Média por dia</div>
        <div style="font-size:12.5px;font-weight:700">${money(earn.mediaPorDia)}</div>
        <div style="font-size:8px;color:var(--text3)">nos dias ativos</div>
      </div>
      <div style="background:var(--bg-soft);border-radius:7px;padding:7px;text-align:center">
        <div style="font-size:8.5px;color:var(--text3)">Horas no mês</div>
        <div style="font-size:12.5px;font-weight:700">${earn.horasSum}h</div>
        <div style="font-size:8px;color:var(--text3)">turno + extra</div>
      </div>
      <div style="background:var(--bg-soft);border-radius:7px;padding:7px;text-align:center">
        <div style="font-size:8.5px;color:var(--text3)">Fatur. por hora</div>
        <div style="font-size:12.5px;font-weight:700">${money(earn.fatPorHora)}</div>
        <div style="font-size:8px;color:var(--text3)">no mês</div>
      </div>
    </div>
    <div style="display:flex;align-items:flex-end;gap:2px;height:60px;margin:10px 0;padding:0 2px">
      ${earn.dayByDay.map(d=>`<div style="flex:1;background:${d.rev>0?'var(--accent)':'var(--line)'};height:${Math.max(2,d.rev/maxBar*60)}px;border-radius:2px 2px 0 0" title="${d.date}: ${money(d.rev)}"></div>`).join('')}
    </div>
    <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;margin-bottom:6px">Degraus da meta semanal (essa semana)</div>
    ${tiers.map(t=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--line);font-size:12px">
      <span>${t.batido?'✅':'⬜'} ${t.label} <span style="color:var(--text3);font-size:10.5px">(${money(t.meta)})</span></span>
      <span style="font-family:var(--font-mono);color:${t.batido?'var(--ok)':'var(--text3)'}">${t.batido?'+':''}${money(t.premio)}</span>
    </div>`).join('')}
    <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;margin:12px 0 6px">Ganho do mês</div>
    <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12.5px"><span>① Fixo (comissão)</span><span style="font-family:var(--font-mono)">${money(earn.comissao)}</span></div>
    <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12.5px"><span>② Prêmios de meta</span><span style="font-family:var(--font-mono)">${money(earn.premio)}</span></div>
    <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12.5px"><span>③ Bônus high ticket</span><span style="font-family:var(--font-mono)">${money(earn.htBonus)}</span></div>
    <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12.5px"><span>④ Bônus modelo extra</span><span style="font-family:var(--font-mono)">${money(earn.extraBonus)}</span></div>
    <div style="display:flex;justify-content:space-between;padding:8px 0;margin-top:4px;border-top:2px solid var(--line);font-size:14px;font-weight:800"><span>TOTAL ATÉ AGORA</span><span style="color:var(--ok);font-family:var(--font-mono)">${money(earn.total)}</span></div>
    <div style="font-size:10px;color:var(--text3);text-align:center;margin-top:4px">Ao vivo, do fechamento da sua planilha. Fecha oficialmente no fim do mês.</div>
  </div>`;
}
function saveChatterPagCategoria(cid,cat){
  if(!S.chatterFichas[cid])S.chatterFichas[cid]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
  S.chatterFichas[cid].pagCategoria=cat;
  save();
}
function saveManualMedal(cid,value){
  if(!S.chatterFichas[cid])S.chatterFichas[cid]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
  S.chatterFichas[cid].manualMedal=value; // '' = volta a ser automático
  save();
}

function renderChatterPagCells(r,pct,col,medal){
  const comPct=Math.round((PAG_COM[medal]||0.04)*1000)/10; // ex: 4.5
  const boostX=pct>100?pagBoost(pct-100):1;
  return`
    <div style="background:var(--bg);border-radius:7px;padding:7px;text-align:center">
      <div style="font-size:9px;color:var(--text3)">① Comissão (${comPct}%)</div>
      <div style="font-size:12px;font-weight:700;font-family:var(--font-mono)">${money(r.comissao)}</div>
    </div>
    <div style="background:var(--bg);border-radius:7px;padding:7px;text-align:center">
      <div style="font-size:9px;color:var(--text3)">② Prêmio meta${boostX>1?` (boost ${boostX}×)`:''}</div>
      <div style="font-size:12px;font-weight:700;color:${r.premio>0?'var(--ok)':'var(--text3)'}">${money(r.premio)}</div>
    </div>
    <div style="background:var(--bg);border-radius:7px;padding:7px;text-align:center">
      <div style="font-size:9px;color:var(--text3)">③ High ticket (8%)</div>
      <div style="font-size:12px;font-weight:700;color:${r.htBonus>0?'var(--ok)':'var(--text3)'}">${money(r.htBonus)}</div>
    </div>
    <div style="background:var(--bg);border-radius:7px;padding:7px;text-align:center">
      <div style="font-size:9px;color:var(--text3)">④ Modelo extra (10%)</div>
      <div style="font-size:12px;font-weight:700;color:${r.extraBonus>0?'var(--ok)':'var(--text3)'}">${money(r.extraBonus)}</div>
    </div>
    <div style="background:var(--bg);border-radius:7px;padding:7px;text-align:center">
      <div style="font-size:9px;color:var(--text3)">% meta</div>
      <div style="font-size:12px;font-weight:800;color:${col}">${pct}%</div>
    </div>
    <div style="background:var(--ok-soft);border-radius:7px;padding:7px;text-align:center">
      <div style="font-size:9px;color:var(--text3)">⑤ Total (real)</div>
      <div style="font-size:12px;font-weight:800;color:var(--ok)">${money(r.totalComPiso)}</div>
    </div>`;
}





/* ===========================================================
   GERÊNCIA — calculadora de premiação por chatter
   =========================================================== */
// Calculates manager commission faixa a faixa
function calcGerPremio(fat, meta){
  if(!meta||!fat)return 0;
  const pct=fat/meta;
  let premio=0;
  // Calcular faixa a faixa
  const bands=[
    {from:0,   to:0.5,  rate:0.02},
    {from:0.5, to:0.70, rate:0.04},
    {from:0.70,to:0.85, rate:0.06},
    {from:0.85,to:1.00, rate:0.09},
    {from:1.00,to:1.30, rate:0.10},
    {from:1.30,to:1.70, rate:0.11},
    {from:1.70,to:99,   rate:0.12},
  ];
  for(const b of bands){
    if(pct<=b.from)break;
    const low=meta*b.from;
    const high=meta*Math.min(b.to,pct);
    const slice=Math.max(0,high-low);
    if(pct>b.from)premio+=slice*b.rate;
  }
  return Math.round(premio);
}

// Faturamento real da operação no mês corrente, até hoje (soma real, não projeção)
function getCompanyMonthToDateRevenue(){
  const today=new Date();
  const year=today.getFullYear(),month=today.getMonth();
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  let total=0;
  for(let d=1;d<=today.getDate();d++){
    const key=fmt(new Date(year,month,d));
    chatters.forEach(c=>{
      const fin=getChatterDayRevenueFinanceiro(c.id,key);
      if(fin){total+=fin.turno+fin.extra;return;}
      S.models.forEach(m=>{total+=parseFloat(S.revenues[`${c.id}_${m.id}_${key}`])||0;});
    });
  }
  return total;
}
// Frente 2 — meta global da operação (Sistema de Remuneração Gerente, seção 01):
// proporcional até 100% (R$1.500 na meta cheia), e acima de 100% cada ponto
// percentual vale o dobro (R$30/ponto, em vez de R$15/ponto) — sem limite.
function calcGerMeta2(metaGlobal, fatGlobal){
  if(!metaGlobal||!fatGlobal)return 0;
  const pct=(fatGlobal/metaGlobal)*100; // em pontos percentuais
  if(pct<=100)return Math.round(pct*15);
  return Math.round(1500+(pct-100)*30);
}
// Piso garantido do gerente (R$3.000/mês) — rede de segurança: se a soma das
// duas frentes não chegar lá, a diferença é completada. Nunca reduz o total.
const GER_PISO_GARANTIDO=3000;

function renderGerChattersConfig(){
  // Config manual removida — meta e faturamento de cada chatter agora vêm
  // automáticos (categoria escolhida em Faturamento + resultado real da
  // semana). Ver renderGerPreview().
  const el=document.getElementById('ger-chatters-config');
  if(el)el.innerHTML='';
}

function renderGerPreview(){
  const el=document.getElementById('ger-preview');
  if(!el)return;
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  if(!chatters.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Cadastre chatters na aba Equipe</div>';return;}

  const wkey=getWeekKey(0);
  const goals=S.chatterWeekGoals[wkey]||{};
  let frente1=0;
  const rows=chatters.map(c=>{
    const cat=S.chatterFichas?.[c.id]?.pagCategoria||'B';
    const metaVal=parseFloat(goals[c.id])||0;
    const meta=metaVal>0?metaVal:PAG_CATS[cat].n100;
    const fat=getChatterWeekRevenue(c.id,0); // sempre semana atual, automático
    const premio=calcGerPremio(fat,meta);
    frente1+=premio;
    const pct=meta>0?fat/meta*100:0;
    const col=pct>=100?'var(--ok)':pct>=85?'var(--warn)':'var(--bad)';
    return`<tr>
      <td style="padding:6px 10px;font-weight:600;border-bottom:1px solid var(--line)">${c.name} <span style="font-size:9.5px;color:var(--text3)">(cat ${cat})</span></td>
      <td style="padding:6px 10px;text-align:right;border-bottom:1px solid var(--line);font-family:var(--font-mono);font-size:11.5px">${money(meta)}</td>
      <td style="padding:6px 10px;text-align:right;border-bottom:1px solid var(--line);font-family:var(--font-mono);font-size:11.5px">${money(fat)}</td>
      <td style="padding:6px 10px;text-align:right;border-bottom:1px solid var(--line);color:${col};font-weight:700">${Math.round(pct)}%</td>
      <td style="padding:6px 10px;text-align:right;border-bottom:1px solid var(--line);font-family:var(--font-mono);font-weight:800;color:var(--ok)">${money(premio)}</td>
    </tr>`;
  });

  // Meta global do mês = soma das metas semanais reais de cada chatter × ~4,3 semanas
  const metaGlobal=chatters.reduce((s,c)=>{
    const cat=S.chatterFichas?.[c.id]?.pagCategoria||'B';
    const metaVal=parseFloat(goals[c.id])||0;
    const meta=metaVal>0?metaVal:PAG_CATS[cat].n100;
    return s+meta*(30/7);
  },0);
  const fatGlobal=getCompanyMonthToDateRevenue(); // faturamento real do mês, automático
  const frente2=calcGerMeta2(metaGlobal,fatGlobal);
  const somaFrentes=frente1+frente2;
  const pisoAplicado=somaFrentes<GER_PISO_GARANTIDO;
  const total=Math.max(somaFrentes,GER_PISO_GARANTIDO); // piso garantido de R$3.000 — nunca abaixo disso

  el.innerHTML=`
    <div style="background:var(--bg-soft);border-radius:10px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:var(--text2)">
      📊 <strong>Automático:</strong> meta global do mês ${money(metaGlobal)} (soma das categorias de cada chatter) · faturamento real do mês até hoje ${money(fatGlobal)} (${metaGlobal>0?Math.round(fatGlobal/metaGlobal*100):0}%)
    </div>
    <div style="overflow-x:auto;margin:12px 0">
      <table style="width:100%;border-collapse:collapse;font-size:12.5px">
        <thead><tr style="background:var(--bg-soft)">
          <th style="padding:7px 10px;text-align:left;border-bottom:1px solid var(--line)">Chatter</th>
          <th style="padding:7px 10px;text-align:right;border-bottom:1px solid var(--line)">Meta (sem.)</th>
          <th style="padding:7px 10px;text-align:right;border-bottom:1px solid var(--line)">Faturou (sem.)</th>
          <th style="padding:7px 10px;text-align:right;border-bottom:1px solid var(--line)">%</th>
          <th style="padding:7px 10px;text-align:right;border-bottom:1px solid var(--line)">Sua premiação</th>
        </tr></thead>
        <tbody>${rows.join('')}
        <tr style="background:var(--bg-soft);font-weight:800">
          <td colspan="4" style="padding:8px 10px">Frente 1 — premiação por chatter</td>
          <td style="padding:8px 10px;text-align:right;font-family:var(--font-mono);color:var(--ok)">${money(frente1)}</td>
        </tr>
        ${frente2>0?`<tr style="background:var(--bg-soft)">
          <td colspan="4" style="padding:8px 10px;font-weight:700">Frente 2 — meta global (${metaGlobal>0?Math.round(fatGlobal/metaGlobal*100):0}%)</td>
          <td style="padding:8px 10px;text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--info)">${money(frente2)}</td>
        </tr>`:''}
        ${pisoAplicado?`<tr style="background:var(--warn-soft)">
          <td colspan="4" style="padding:8px 10px;font-weight:700;color:var(--warn)">🛡️ Piso garantido aplicado (frentes somaram ${money(somaFrentes)})</td>
          <td style="padding:8px 10px;text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--warn)">${money(GER_PISO_GARANTIDO-somaFrentes)}</td>
        </tr>`:''}
        <tr style="background:var(--accent-soft)">
          <td colspan="4" style="padding:10px;font-weight:800;font-size:14px;color:var(--accent)">Total do mês${pisoAplicado?' (piso garantido)':' (real)'}</td>
          <td style="padding:10px;text-align:right;font-family:var(--font-mono);font-weight:800;font-size:18px;color:var(--accent)">${money(total)}</td>
        </tr>
        </tbody>
      </table>
    </div>
    <div style="font-size:11px;color:var(--text3);margin-top:8px">Piso garantido: R$3.000/mês · Sem teto — não há limite pra soma das frentes num mês forte.</div>`;
}

/* ===========================================================
   PROJEÇÃO — análise mensal de desenvolvimento por chatter
   =========================================================== */
/* ===========================================================
   PROJEÇÃO DA EMPRESA — "se continuar assim, onde vamos chegar?"
   Faturamento (dia/semana/mês + cenários), meta (falta/ritmo),
   performance (ticket/conversão/leads), comissão projetada
   (chatters + liderança) e um simulador "e se...?" — tudo
   derivado dos dados já existentes (faturamento, metas, ChatLab).
   =========================================================== */
function getProjecaoEmpresaData(overrides){
  overrides=overrides||{};
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  const wkey=getWeekKey(0);
  const goals=S.chatterWeekGoals[wkey]||{};
  const wd=getWeekDates(0);

  // Faturamento de hoje, por modelo e total — por modelo continua só do
  // lançamento manual (o financeiro não quebra por conta/modelo), mas o
  // total do dia usa o financeiro quando o mês da pessoa já foi importado.
  const todayKey=fmt(new Date());
  const porModelo={};
  let hojeTotal=0;
  chatters.forEach(c=>{
    const fin=getChatterDayRevenueFinanceiro(c.id,todayKey);
    if(fin){hojeTotal+=fin.turno+fin.extra;return;}
    (S.models||[]).forEach(m=>{
      const v=parseFloat(S.revenues[`${c.id}_${m.id}_${todayKey}`])||0;
      if(v>0){porModelo[m.id]=(porModelo[m.id]||0)+v;hojeTotal+=v;}
    });
  });

  // Semana: real até hoje + projeção do resto da semana no ritmo diário médio
  const todayDow=new Date().getDay();
  const diasPassadosSemana=todayDow===0?7:todayDow;
  const semanaAtual=chatters.reduce((s,c)=>s+getChatterWeekRevenue(c.id,0),0);
  const semanaProjetada=diasPassadosSemana>0?(semanaAtual/diasPassadosSemana)*7:semanaAtual;

  const fatMesAteAgora=getCompanyMonthToDateRevenue();
  const mesProjetadoBase=getCompanyMonthlyProjection(); // já existe: soma da média semanal recente de cada chatter × 30/7

  const metaGlobalMes=chatters.reduce((s,c)=>{
    const cat=S.chatterFichas?.[c.id]?.pagCategoria||'B';
    const metaVal=parseFloat(goals[c.id])||0;
    const meta=metaVal>0?metaVal:(PAG_CATS[cat]?.n100||0);
    return s+meta*(30/7);
  },0);

  // Simulador — ajustes aplicados de forma simples e transparente sobre a
  // projeção base (não é um modelo estatístico, é uma estimativa de impacto)
  const ajusteConversao=overrides.conversao||0;
  const ajusteTicket=overrides.ticket||0;
  const chattersExtra=overrides.chattersExtra||0;
  const ajusteChurn=overrides.churn||0;
  const impactoContratacao=chattersExtra>0&&chatters.length>0?(chattersExtra/chatters.length):0;
  const fatorSimulador=Math.max(0,1+(ajusteTicket/100)+(ajusteConversao/100)+impactoContratacao+(ajusteChurn/100));

  const mesProjetado=mesProjetadoBase*fatorSimulador;
  const mesMelhor=mesProjetado*1.15;
  const mesPior=mesProjetado*0.85;

  const faltaMeta=Math.max(0,metaGlobalMes-fatMesAteAgora);
  const pctProjetado=metaGlobalMes>0?Math.round(mesProjetado/metaGlobalMes*100):null;

  const hoje=new Date();
  const ultimoDiaMes=new Date(hoje.getFullYear(),hoje.getMonth()+1,0).getDate();
  const diasRestantes=Math.max(1,ultimoDiaMes-hoje.getDate());
  const ritmoDiarioNecessario=faltaMeta/diasRestantes;

  let vphSum=0,vphDays=0,ticketSum=0,ticketDays=0;
  chatters.forEach(c=>{
    const analytics=S.chatterFichas[c.id]?.analytics?.weeklyData||{};
    wd.forEach(d=>{
      const a=analytics[fmt(d)];
      if(a&&a.ticketMedio>0){
        ticketSum+=a.ticketMedio;ticketDays++;
        if(a.vendasPorHora>0){vphSum+=a.vendasPorHora;vphDays++;}
      }
    });
  });
  const teamValorHora=vphDays>0?vphSum/vphDays:0;
  const horasNecessariasDia=teamValorHora>0?ritmoDiarioNecessario/teamValorHora:null;
  const ticketMedioProjetado=ticketDays>0?(ticketSum/ticketDays)*(1+ajusteTicket/100):0;

  const todasAnalisesSemana=[];
  chatters.forEach(c=>coletarAnalisesDaSemana(c.id,0).forEach(a=>todasAnalisesSemana.push(a)));
  const metricasTime=calcMetricasSemana(todasAnalisesSemana);
  const conversaoEsperada=metricasTime.taxaConversao!=null?Math.max(0,Math.min(100,metricasTime.taxaConversao+ajusteConversao)):null;
  const vendasNecessarias=(ticketMedioProjetado>0&&faltaMeta>0)?Math.ceil(faltaMeta/ticketMedioProjetado):(faltaMeta>0?null:0);
  const leadsNecessarios=(vendasNecessarias&&conversaoEsperada>0)?Math.ceil(vendasNecessarias/(conversaoEsperada/100)):null;

  // Comissão projetada dos chatters, no ritmo (ajustado) do mês, pela categoria/medalha de cada um
  let comissaoChatters=0;
  chatters.forEach(c=>{
    const projMensal=getChatterAvgWeeklyRevenue(c.id)*(30/7)*fatorSimulador;
    const cat=S.chatterFichas?.[c.id]?.pagCategoria||'B';
    const medal=autoMedalForChatter(c.id,cat,projMensal);
    comissaoChatters+=projMensal*(PAG_COM[medal]||0.04);
  });

  // Comissão da liderança projetada — mesma lógica do simulador de pagamento
  // da gerência, usando o ritmo (ajustado) em vez do real até hoje
  let frente1Proj=0;
  chatters.forEach(c=>{
    const cat=S.chatterFichas?.[c.id]?.pagCategoria||'B';
    const metaVal=parseFloat(goals[c.id])||0;
    const metaSemana=metaVal>0?metaVal:(PAG_CATS[cat]?.n100||0);
    const projSemana=getChatterAvgWeeklyRevenue(c.id)*fatorSimulador;
    frente1Proj+=calcGerPremio(projSemana,metaSemana);
  });
  const frente2Proj=calcGerMeta2(metaGlobalMes,mesProjetado);
  const comissaoLideranca=Math.max(frente1Proj+frente2Proj,GER_PISO_GARANTIDO);

  return{
    hojeTotal,porModelo,semanaAtual,semanaProjetada,fatMesAteAgora,mesProjetado,mesMelhor,mesPior,
    metaGlobalMes,faltaMeta,pctProjetado,ritmoDiarioNecessario,horasNecessariasDia,teamValorHora,
    ticketMedioProjetado,conversaoEsperada,vendasNecessarias,leadsNecessarios,
    comissaoChatters,comissaoLideranca,diasRestantes
  };
}
function renderProjecaoEmpresa(sim){
  const el=document.getElementById('proj-empresa');
  if(!el)return;
  sim=sim||S._projSimState||{conversao:0,ticket:0,chattersExtra:0,churn:0};
  S._projSimState=sim;
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  if(!chatters.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Cadastre chatters e lance faturamento pra ver a projeção.</div>';return;}
  const d=getProjecaoEmpresaData(sim);

  const modeloLines=Object.entries(d.porModelo).sort((a,b)=>b[1]-a[1]).map(([mid,v])=>{
    const m=(S.models||[]).find(x=>x.id===mid);
    return`<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0"><span>${m?m.name:mid}</span><span style="font-family:var(--font-mono);font-weight:700">${money(v)}</span></div>`;
  }).join('')||'<div style="font-size:12px;color:var(--text3)">Sem lançamento hoje ainda</div>';

  const alertaCor=d.pctProjetado===null?'var(--text3)':d.pctProjetado>=100?'var(--ok)':d.pctProjetado>=85?'var(--warn)':'var(--bad)';
  const aumentoNecessario=(d.mesProjetado>0&&d.faltaMeta>0)?Math.round((d.faltaMeta/d.mesProjetado)*100):null;

  el.innerHTML=`
    <div class="panel">
      <div class="panel-head"><div><div class="panel-title">💰 Faturamento</div><div class="panel-note">Hoje, semana e mês — no ritmo atual</div></div></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">
        <div style="background:var(--bg-soft);border-radius:9px;padding:9px;text-align:center">
          <div style="font-size:9.5px;color:var(--text3)">Hoje</div>
          <div style="font-size:14px;font-weight:800;font-family:var(--font-mono)">${money(d.hojeTotal)}</div>
        </div>
        <div style="background:var(--bg-soft);border-radius:9px;padding:9px;text-align:center">
          <div style="font-size:9.5px;color:var(--text3)">Semana (projetada)</div>
          <div style="font-size:14px;font-weight:800;font-family:var(--font-mono)">${money(d.semanaProjetada)}</div>
        </div>
        <div style="background:var(--bg-soft);border-radius:9px;padding:9px;text-align:center">
          <div style="font-size:9.5px;color:var(--text3)">Mês (real até hoje)</div>
          <div style="font-size:14px;font-weight:800;font-family:var(--font-mono)">${money(d.fatMesAteAgora)}</div>
        </div>
      </div>
      <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;margin-bottom:5px">Por modelo (hoje)</div>
      ${modeloLines}
      <div style="border-top:1px solid var(--line);margin:12px 0 10px"></div>
      <div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;margin-bottom:6px">Cenários pro mês</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <div style="background:var(--bad-soft);border-radius:9px;padding:9px;text-align:center">
          <div style="font-size:9.5px;color:var(--text3)">Pior cenário</div>
          <div style="font-size:13px;font-weight:800;font-family:var(--font-mono);color:var(--bad)">${money(d.mesPior)}</div>
        </div>
        <div style="background:var(--accent-soft);border-radius:9px;padding:9px;text-align:center">
          <div style="font-size:9.5px;color:var(--text3)">Esperado</div>
          <div style="font-size:13px;font-weight:800;font-family:var(--font-mono);color:var(--accent-strong)">${money(d.mesProjetado)}</div>
        </div>
        <div style="background:var(--bg-soft);border-radius:9px;padding:9px;text-align:center">
          <div style="font-size:9.5px;color:var(--text3)">Melhor cenário</div>
          <div style="font-size:13px;font-weight:800;font-family:var(--font-mono);color:var(--ok)">${money(d.mesMelhor)}</div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><div><div class="panel-title">🎯 Meta do mês</div><div class="panel-note">Meta global = soma das metas semanais de cada chatter</div></div></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">
        <div style="background:var(--bg-soft);border-radius:9px;padding:9px;text-align:center">
          <div style="font-size:9.5px;color:var(--text3)">Falta pra bater</div>
          <div style="font-size:14px;font-weight:800;font-family:var(--font-mono);color:${d.faltaMeta>0?'var(--bad)':'var(--ok)'}">${d.faltaMeta>0?money(d.faltaMeta):'Já bateu ✅'}</div>
        </div>
        <div style="background:var(--bg-soft);border-radius:9px;padding:9px;text-align:center">
          <div style="font-size:9.5px;color:var(--text3)">Projeção da meta</div>
          <div style="font-size:14px;font-weight:800;color:${alertaCor}">${d.pctProjetado!=null?d.pctProjetado+'%':'—'}</div>
        </div>
        <div style="background:var(--bg-soft);border-radius:9px;padding:9px;text-align:center">
          <div style="font-size:9.5px;color:var(--text3)">Ritmo necessário</div>
          <div style="font-size:13px;font-weight:800;font-family:var(--font-mono)">${money(d.ritmoDiarioNecessario)}/dia</div>
          ${d.horasNecessariasDia?`<div style="font-size:9.5px;color:var(--text3)">≈${d.horasNecessariasDia.toFixed(1)}h de venda/dia no ritmo atual de ${money(d.teamValorHora)}/h</div>`:''}
        </div>
      </div>
      ${d.pctProjetado!=null?`<div style="background:${d.pctProjetado>=100?'var(--bg-soft)':'var(--warn-soft)'};border-radius:9px;padding:10px 12px;font-size:12.5px;line-height:1.6">
        🔔 <strong>Se continuar nesse ritmo:</strong> meta mensal em ${d.pctProjetado}%${d.faltaMeta>0?`, faltarão ${money(d.faltaMeta)}${aumentoNecessario?`, é necessário aumentar as vendas em ${aumentoNecessario}%`:''}`:', a meta já está garantida no ritmo atual'}.
      </div>`:''}
    </div>

    <div class="panel">
      <div class="panel-head"><div><div class="panel-title">📈 Performance projetada</div></div></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <div style="background:var(--bg-soft);border-radius:9px;padding:9px;text-align:center">
          <div style="font-size:9.5px;color:var(--text3)">Ticket médio</div>
          <div style="font-size:14px;font-weight:800;font-family:var(--font-mono)">${d.ticketMedioProjetado>0?money(d.ticketMedioProjetado):'—'}</div>
        </div>
        <div style="background:var(--bg-soft);border-radius:9px;padding:9px;text-align:center">
          <div style="font-size:9.5px;color:var(--text3)">Conversão esperada</div>
          <div style="font-size:14px;font-weight:800">${d.conversaoEsperada!=null?d.conversaoEsperada+'%':'—'}</div>
        </div>
        <div style="background:var(--bg-soft);border-radius:9px;padding:9px;text-align:center">
          <div style="font-size:9.5px;color:var(--text3)">Leads necessários</div>
          <div style="font-size:14px;font-weight:800">${d.leadsNecessarios!=null?d.leadsNecessarios:'—'}</div>
        </div>
      </div>
      ${d.conversaoEsperada==null?'<div style="font-size:11px;color:var(--text3);margin-top:8px">Conversão e leads dependem de análises do ChatLab dessa semana — analise mais conversas pra essa projeção aparecer.</div>':''}
    </div>

    <div class="panel">
      <div class="panel-head"><div><div class="panel-title">💵 Comissão projetada (no ritmo atual)</div></div></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div style="background:var(--bg-soft);border-radius:9px;padding:9px;text-align:center">
          <div style="font-size:9.5px;color:var(--text3)">Chatters (soma do time)</div>
          <div style="font-size:14px;font-weight:800;font-family:var(--font-mono)">${money(d.comissaoChatters)}</div>
        </div>
        <div style="background:var(--bg-soft);border-radius:9px;padding:9px;text-align:center">
          <div style="font-size:9.5px;color:var(--text3)">Liderança (gerência)</div>
          <div style="font-size:14px;font-weight:800;font-family:var(--font-mono)">${money(d.comissaoLideranca)}</div>
        </div>
      </div>
      <div style="font-size:11px;color:var(--text3);margin-top:8px">Comissão da operação ainda não tem uma fórmula configurada no app — se existir um % combinado, me conta que eu adiciono aqui.</div>
    </div>

    <div class="panel">
      <div class="panel-head"><div><div class="panel-title">🧪 Simulador — "e se...?"</div><div class="panel-note">Mexa nos campos e veja o impacto na hora, sem salvar nada</div></div></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div class="field" style="margin-bottom:0">
          <label class="flabel">Aumentar conversão em (pp)</label>
          <input type="number" class="finput" id="sim-conversao" value="${sim.conversao}" step="1">
        </div>
        <div class="field" style="margin-bottom:0">
          <label class="flabel">Aumentar ticket médio em (%)</label>
          <input type="number" class="finput" id="sim-ticket" value="${sim.ticket}" step="1">
        </div>
        <div class="field" style="margin-bottom:0">
          <label class="flabel">Contratar mais chatters</label>
          <input type="number" class="finput" id="sim-chatters" value="${sim.chattersExtra}" step="1" min="0">
        </div>
        <div class="field" style="margin-bottom:0">
          <label class="flabel">Diminuir churn em (%)</label>
          <input type="number" class="finput" id="sim-churn" value="${sim.churn}" step="1">
        </div>
      </div>
      <button class="btn btn-primary btn-block" onclick="aplicarSimuladorProjecao()">Calcular impacto</button>
      ${(sim.conversao||sim.ticket||sim.chattersExtra||sim.churn)?`<button class="btn btn-ghost btn-block" style="margin-top:6px" onclick="resetSimuladorProjecao()">↺ Resetar simulação</button>`:''}
    </div>
  `;
}
function aplicarSimuladorProjecao(){
  const sim={
    conversao:parseFloat(document.getElementById('sim-conversao')?.value)||0,
    ticket:parseFloat(document.getElementById('sim-ticket')?.value)||0,
    chattersExtra:parseFloat(document.getElementById('sim-chatters')?.value)||0,
    churn:parseFloat(document.getElementById('sim-churn')?.value)||0,
  };
  renderProjecaoEmpresa(sim);
}
function resetSimuladorProjecao(){
  renderProjecaoEmpresa({conversao:0,ticket:0,chattersExtra:0,churn:0});
}

function renderProjecao(){
  renderProjecaoEmpresa();
  const sel=document.getElementById('proj-chatter');
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  if(sel){
    const cur=sel.value;
    sel.innerHTML='<option value="">— visão geral do time (melhora por semana) —</option>'+
      chatters.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
    if(cur)sel.value=cur;
  }
  const cid=document.getElementById('proj-chatter')?.value;
  if(cid){
    const el=document.getElementById('proj-content');
    if(el)el.innerHTML=`<div id="proj-section-${cid}"></div>`;
    renderProjecaoChatter(cid);
  } else {
    renderProjecaoTeamChart();
  }
}
// Acha os offsets de semana (0, -1, -2...) que têm pelo menos 1 dia dentro
// do mês atual — normalmente 4 ou 5 semanas.
function getWeekOffsetsInCurrentMonth(){
  const today=new Date();
  const offsets=[];
  for(let o=0;o>-7;o--){
    const wd=getWeekDates(o);
    const overlaps=wd.some(d=>d.getMonth()===today.getMonth()&&d.getFullYear()===today.getFullYear());
    if(overlaps)offsets.unshift(o);
    else if(offsets.length)break;
  }
  return offsets;
}
function renderProjecaoTeamChart(){
  const el=document.getElementById('proj-content');
  if(!el)return;
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  if(!chatters.length){
    el.innerHTML='<div class="empty"><div class="empty-ic">📈</div><div class="empty-ttl">Sem chatters</div></div>';
    return;
  }
  const offsets=getWeekOffsetsInCurrentMonth();
  const rows=chatters.map(c=>{
    const cat=S.chatterFichas?.[c.id]?.pagCategoria||'B';
    const meta=PAG_CATS[cat]?.n100||0;
    const weekPcts=offsets.map(o=>{
      const rev=getChatterWeekRevenue(c.id,o);
      return meta>0?Math.round(rev/meta*100):0;
    });
    const validPcts=weekPcts.filter(p=>p>0);
    const avg=validPcts.length?validPcts.reduce((s,p)=>s+p,0)/validPcts.length:0;
    const variance=validPcts.length?validPcts.reduce((s,p)=>s+Math.pow(p-avg,2),0)/validPcts.length:0;
    const stdDev=Math.sqrt(variance);
    const firstIdx=weekPcts.findIndex(p=>p>0);
    const lastIdx=weekPcts.length-1-[...weekPcts].reverse().findIndex(p=>p>0);
    const delta=(firstIdx>=0&&lastIdx>firstIdx)?weekPcts[lastIdx]-weekPcts[firstIdx]:null;
    return{c,weekPcts,avg,stdDev,delta,semanasComDado:validPcts.length};
  });

  const elegiveis=rows.filter(r=>r.semanasComDado>=2); // precisa de pelo menos 2 semanas pra comparar
  const maisConstante=[...elegiveis].sort((a,b)=>a.stdDev-b.stdDev)[0];
  const maiorMelhora=[...elegiveis].filter(r=>r.delta!==null&&r.delta>0).sort((a,b)=>b.delta-a.delta)[0];
  const maiorQueda=[...elegiveis].filter(r=>r.delta!==null&&r.delta<0).sort((a,b)=>a.delta-b.delta)[0];

  const destaques=[
    maisConstante?{label:'🎯 Mais constante',name:maisConstante.c.name,val:`variação de só ${Math.round(maisConstante.stdDev)}pp entre as semanas`,color:'var(--info)'}:null,
    maiorMelhora?{label:'📈 Melhora significativa',name:maiorMelhora.c.name,val:`+${Math.round(maiorMelhora.delta)}pp da primeira pra última semana`,color:'var(--ok)'}:null,
    maiorQueda?{label:'📉 Caiu performance',name:maiorQueda.c.name,val:`${Math.round(maiorQueda.delta)}pp da primeira pra última semana`,color:'var(--bad)'}:null,
  ].filter(Boolean);

  const weekLabels=offsets.map(o=>weekLabel(o));

  el.innerHTML=`
    <div class="panel">
      <div class="panel-head"><div><div class="panel-title">📊 Melhora por semana do mês</div><div class="panel-note">Compara o % da meta batido em cada semana do mês atual</div></div></div>
      ${destaques.length?`<div style="display:grid;grid-template-columns:repeat(${destaques.length},1fr);gap:8px;margin-bottom:14px">
        ${destaques.map(d=>`<div style="background:var(--bg-soft);border-radius:10px;padding:10px;text-align:center">
          <div style="font-size:10px;color:var(--text3)">${d.label}</div>
          <div style="font-size:13px;font-weight:800;color:${d.color}">${d.name}</div>
          <div style="font-size:10.5px;color:var(--text3);margin-top:2px">${d.val}</div>
        </div>`).join('')}
      </div>`:'<div style="font-size:12px;color:var(--text3);margin-bottom:12px">Ainda não tem semanas suficientes pra comparar essa análise.</div>'}
      <div style="display:flex;gap:4px;margin-bottom:6px;padding-left:110px">
        ${weekLabels.map(l=>`<div style="flex:1;text-align:center;font-size:9px;color:var(--text3)">${l.replace('Esta semana','Atual').replace('Semana passada','Passada')}</div>`).join('')}
      </div>
      ${rows.map(r=>`<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <div style="width:104px;flex-shrink:0;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.c.name}</div>
        <div style="display:flex;gap:4px;flex:1">
          ${r.weekPcts.map(p=>{
            const col=p===0?'var(--line)':p>=100?'var(--ok)':p>=85?'var(--warn)':p>=70?'var(--info)':'var(--bad)';
            return`<div style="flex:1;text-align:center;background:${col}22;border-radius:5px;padding:5px 2px">
              <div style="font-size:10.5px;font-weight:700;color:${col}">${p>0?p+'%':'—'}</div>
            </div>`;
          }).join('')}
        </div>
        ${r.delta!==null?`<div style="width:44px;flex-shrink:0;text-align:right;font-size:11px;font-weight:700;color:${r.delta>0?'var(--ok)':r.delta<0?'var(--bad)':'var(--text3)'}">${r.delta>0?'+':''}${Math.round(r.delta)}pp</div>`:'<div style="width:44px;flex-shrink:0"></div>'}
      </div>`).join('')}
    </div>`;
}

// Média semanal recente (até 4 semanas) de faturamento de um chatter, a partir das analytics
function getChatterAvgWeeklyRevenue(cid){
  const f=S.chatterFichas[cid]||{};
  const analytics=f.analytics?.weeklyData||{};
  const weekGroups={};
  // Pedido 04/08/2026: junta os dias que só existem no financeiro (mês
  // importado, sem lançamento manual/ChatLab correspondente) com os dias
  // do ChatLab, pra Projeção enxergar tudo — dia com financeiro sempre
  // prevalece sobre o ChatLab pro mesmo dia.
  const dateKeys=new Set(Object.keys(analytics));
  Object.keys(S.faturamentoFinanceiro?.[cid]||{}).forEach(monthKey=>{
    Object.keys(S.faturamentoFinanceiro[cid][monthKey].porDiaTurno||{}).forEach(dia=>{
      dateKeys.add(monthKey+'-'+String(dia).padStart(2,'0'));
    });
  });
  dateKeys.forEach(dk=>{
    const d=new Date(dk+'T12:00:00');
    const wk=fmt(getMondayOfWeek(d));
    const fin=getChatterDayRevenueFinanceiro(cid,dk);
    const dayTotal=fin?(fin.turno+fin.extra):(analytics[dk]?.chatterTotal||0);
    weekGroups[wk]=(weekGroups[wk]||0)+dayTotal;
  });
  const recentWeeks=Object.keys(weekGroups).sort().reverse().slice(0,4);
  const weekRevs=recentWeeks.map(wk=>weekGroups[wk]).filter(v=>v>0);
  return weekRevs.length?weekRevs.reduce((s,v)=>s+v,0)/weekRevs.length:0;
}
// Projeção mensal (30 dias) somada de toda a empresa, no ritmo atual de cada chatter
function getCompanyMonthlyProjection(){
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&!isChatterTerminated(c));
  let total=0;
  chatters.forEach(c=>{total+=getChatterAvgWeeklyRevenue(c.id)*(30/7);});
  return total;
}
function renderProjecaoChatter(cid,containerId){
  const el=document.getElementById(containerId||'proj-content');
  if(!el)return;
  if(!cid){el.innerHTML='';return;}
  const c=S.chatters.find(ch=>ch.id===cid);
  if(!c){el.innerHTML='';return;}

  const f=S.chatterFichas[cid]||{};
  const analytics=f.analytics?.weeklyData||{};
  const weekKeys=Object.keys(analytics).sort();
  const clAnalyses=(S.chatlabAnalyses||[]).filter(a=>a.chatterId===cid).sort((a,b)=>a.date.localeCompare(b.date));

  // Group by week (Seg-Dom)
  const weekGroups={};
  weekKeys.forEach(dk=>{
    const d=new Date(dk+'T12:00:00');
    const wk=fmt(getMondayOfWeek(d));
    if(!weekGroups[wk])weekGroups[wk]=[];
    weekGroups[wk].push({date:dk,...analytics[dk]});
  });

  // Group by month
  const monthGroups={};
  weekKeys.forEach(dk=>{
    const mo=dk.slice(0,7);
    if(!monthGroups[mo])monthGroups[mo]={weeks:0,totalRev:0,tickets:[],vphs:[],hts:[],maxGaps:[],vendas:0,extraRev:0};
    const a=analytics[dk];
    monthGroups[mo].weeks++;
    monthGroups[mo].totalRev+=a.chatterTotal||0;
    monthGroups[mo].extraRev+=a.extraTotal||0;
    if(a.ticketMedio>0)monthGroups[mo].tickets.push(a.ticketMedio);
    if(a.vendasPorHora>0)monthGroups[mo].vphs.push(a.vendasPorHora);
    if(a.highTicketPct>0)monthGroups[mo].hts.push(a.highTicketPct);
    if(a.maxGapMin>0)monthGroups[mo].maxGaps.push(a.maxGapMin);
    monthGroups[mo].vendas+=a.totalVendas||0;
  });

  const avg=arr=>arr.length?Math.round(arr.reduce((s,v)=>s+v,0)/arr.length*10)/10:0;
  const months=Object.keys(monthGroups).sort().reverse();

  if(!months.length&&!clAnalyses.length){
    el.innerHTML=`<div class="empty"><div class="empty-ic">📈</div><div class="empty-ttl">Sem dados ainda</div><div class="empty-sub">Processe relatórios de venda e faça análises ChatLab para ver a projeção</div></div>`;
    return;
  }

  // Trend arrows
  const trend=(arr,i)=>{
    if(arr.length<2||i>=arr.length-1)return'';
    const cur=arr[i],prev=arr[i+1];
    if(!prev)return'';
    const pct=Math.round((cur-prev)/prev*100);
    return pct>=0?`<span style="color:var(--ok);font-size:10px">▲${pct}%</span>`:`<span style="color:var(--bad);font-size:10px">▼${Math.abs(pct)}%</span>`;
  };

  let html=`
    <div style="background:var(--bg-soft);border-radius:12px;padding:14px;margin-bottom:16px;display:flex;align-items:center;gap:12px">
      <div style="font-size:28px">👤</div>
      <div>
        <div style="font-weight:800;font-size:16px">${c.name}</div>
        <div style="font-size:12px;color:var(--text3)">${c.level} · ${months.length} mês${months.length>1?'es':''} de dados</div>
      </div>
    </div>`;

  // ---- Projeção motivacional: faturamento e ganho REAL do próprio chatter (todas as formas de pagamento) + análise curta de desenvolvimento ----
  {
    const avgWeekRev=getChatterAvgWeeklyRevenue(cid);

    // Ganho real projetado — mesma fórmula da aba Pagamento, com TODAS as
    // formas: comissão sobre faturamento + prêmio de meta + high ticket
    // (8%) + hora extra (10%). Não é faturamento da empresa, é o que ELE
    // recebe, considerando só a % que cabe a ele segundo a categoria dele.
    const weekRev=getChatterWeekRevenue(cid,0);
    const weekExtra=getChatterExtraRevenue(cid,0);
    const {htTotal}=getChatterWeekHighTicket(cid,0);
    const wkeyNow=getWeekKey(0);
    const goalsNow=S.chatterWeekGoals[wkeyNow]||{};
    const cat=f.pagCategoria||'B';
    const metaManual=parseFloat(goalsNow[cid])||0;
    const metaCat=metaManual>0?metaManual:(PAG_CATS[cat]?.n100||0);
    const statsFichaProj=getChatterMonthStats(cid);
    const medalNow=autoMedalForChatter(cid,cat,statsFichaProj.monthRevenue+statsFichaProj.monthExtra);
    const pag=calcChatterPagamento(weekRev,medalNow,cat,htTotal,weekExtra,metaManual);
    const projGanhoMonth=pag.totalComPiso*(30/7);
    const projMonth=avgWeekRev*(30/7); // faturamento QUE ELE GERA, projetado pro mês

    // Análise curta de desenvolvimento pessoal: compara o mês mais antigo com o mais recente
    let devText;
    if(months.length>=2){
      const oldest=monthGroups[months[months.length-1]];
      const newest=monthGroups[months[0]];
      const ticketOld=avg(oldest.tickets),ticketNew=avg(newest.tickets);
      const vphOld=avg(oldest.vphs),vphNew=avg(newest.vphs);
      if(ticketOld>0&&vphOld>0){
        const ticketDiff=Math.round((ticketNew-ticketOld)/ticketOld*100);
        const vphDiff=Math.round((vphNew-vphOld)/vphOld*100);
        if(ticketDiff>=5||vphDiff>=5)devText=`📈 Evoluindo bem: ticket médio ${ticketDiff>=0?'subiu':'variou'} ${ticketDiff}% e valor/hora ${vphDiff>=0?'subiu':'variou'} ${vphDiff}% desde o início.`;
        else if(ticketDiff<=-10||vphDiff<=-10)devText=`⚠️ Queda no período: ticket médio ${ticketDiff}% e valor/hora ${vphDiff}% — vale uma conversa de reforço.`;
        else devText=`➡️ Desempenho estável (ticket médio ${ticketDiff>=0?'+':''}${ticketDiff}%, valor/hora ${vphDiff>=0?'+':''}${vphDiff}%) — foco agora é destravar o próximo salto.`;
      } else devText='Ainda sem métricas suficientes de ticket/valor-hora em mais de um mês para medir evolução.';
    } else devText='Ainda não há dados de meses anteriores para comparar — continue processando relatórios para essa análise aparecer aqui.';

    if(avgWeekRev>0||projGanhoMonth>0){
      html+=`<div class="panel" style="margin-bottom:16px;border:2px solid var(--accent);background:linear-gradient(135deg,var(--accent-soft),var(--bg-soft))">
        <div style="text-align:center;margin-bottom:12px">
          <div style="font-size:11px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">🚀 Projeção para os próximos 30 dias</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
          <div style="text-align:center;background:var(--bg);border-radius:10px;padding:10px">
            <div style="font-size:9.5px;color:var(--text3);text-transform:uppercase">Faturamento gerado</div>
            <div style="font-size:20px;font-weight:800;font-family:var(--font-mono);color:var(--ok)">${money(projMonth)}</div>
          </div>
          <div style="text-align:center;background:var(--bg);border-radius:10px;padding:10px">
            <div style="font-size:9.5px;color:var(--text3);text-transform:uppercase">Salário de ${c.name.split(' ')[0]}</div>
            <div style="font-size:20px;font-weight:800;font-family:var(--font-mono);color:var(--accent)">${money(projGanhoMonth)}</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:10px">
          <div style="text-align:center;background:var(--bg);border-radius:7px;padding:6px 3px">
            <div style="font-size:8.5px;color:var(--text3)">Comissão</div>
            <div style="font-size:11.5px;font-weight:700">${money(pag.comissao*(30/7))}</div>
          </div>
          <div style="text-align:center;background:var(--bg);border-radius:7px;padding:6px 3px">
            <div style="font-size:8.5px;color:var(--text3)">Prêmio meta</div>
            <div style="font-size:11.5px;font-weight:700">${money(pag.premio*(30/7))}</div>
          </div>
          <div style="text-align:center;background:var(--bg);border-radius:7px;padding:6px 3px">
            <div style="font-size:8.5px;color:var(--text3)">High ticket</div>
            <div style="font-size:11.5px;font-weight:700">${money(pag.htBonus*(30/7))}</div>
          </div>
          <div style="text-align:center;background:var(--bg);border-radius:7px;padding:6px 3px">
            <div style="font-size:8.5px;color:var(--text3)">Hora extra</div>
            <div style="font-size:11.5px;font-weight:700">${money(pag.extraBonus*(30/7))}</div>
          </div>
        </div>
        ${avgWeekRev>0?`<div style="font-size:12px;color:var(--text2);text-align:center;margin-bottom:10px">no ritmo atual — gerando média de ${money(avgWeekRev)}/semana em faturamento</div>`:''}
        <div style="font-size:12.5px;color:var(--text);line-height:1.5;background:var(--bg);border-radius:8px;padding:9px 11px;margin-bottom:8px">
          <strong>🧠 Desenvolvimento:</strong> ${devText}
        </div>
        ${avgWeekRev>0?`<div style="font-size:12.5px;color:var(--text);text-align:center;line-height:1.5">💪 Continue nesse ritmo e ${c.name.split(' ')[0]} pode fechar o mês recebendo <strong>${money(projGanhoMonth)}</strong> (soma de todas as formas de pagamento)!</div>`:''}
      </div>`;
    }
  }

  // Monthly breakdown
  months.forEach((mo,mi)=>{
    const m=monthGroups[mo];
    const [y,mo2]=mo.split('-');
    const monthName=new Date(parseInt(y),parseInt(mo2)-1,1).toLocaleDateString('pt-BR',{month:'long',year:'numeric'});
    const ticketAvg=avg(m.tickets);
    const vphAvg=avg(m.vphs);
    const htAvg=avg(m.hts);
    const maxGapAvg=avg(m.maxGaps);

    // ChatLab analyses in this month
    const monthAnalyses=clAnalyses.filter(a=>a.date.slice(0,7)===mo);
    const avgIGP=monthAnalyses.length?Math.round(monthAnalyses.reduce((s,a)=>s+(a.igp||0),0)/monthAnalyses.length):null;

    // Generate monthly report text
    const recs=[];
    if(htAvg>0&&htAvg<20)recs.push(`High ticket em ${htAvg}% — abaixo do ideal (meta: ≥30%)`);
    if(vphAvg>0&&vphAvg<10)recs.push(`${money(vphAvg)}/hora — abaixo do mínimo esperado`);
    else if(vphAvg>=10&&vphAvg<20)recs.push(`${money(vphAvg)}/hora — regular, meta é ≥R$20/h`);
    if(maxGapAvg>60)recs.push(`Gap médio de ${Math.round(maxGapAvg)}min — verificar consistência no período`);
    if(avgIGP!==null&&avgIGP<60)recs.push(`IGP médio ${avgIGP}/100 — análises indicam necessidade de treinamento técnico`);
    if(!recs.length)recs.push('Desempenho dentro do esperado — manter ritmo e evoluir categoria');

    const allMonthRevs=months.map(m2=>monthGroups[m2].totalRev);
    const allMonthTickets=months.map(m2=>avg(monthGroups[m2].tickets));

    html+=`<div class="panel" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div>
          <div style="font-weight:800;font-size:15px;text-transform:capitalize">${monthName}</div>
          <div style="font-size:11.5px;color:var(--text3)">${m.weeks} semana${m.weeks>1?'s':''} · ${m.vendas} vendas</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:20px;font-weight:800;font-family:var(--font-mono);color:var(--ok)">${money(m.totalRev)}</div>
          ${m.extraRev>0?`<div style="font-size:11px;color:var(--info)">⚡ +${money(m.extraRev)} extra</div>`:''}
          ${trend(allMonthRevs,mi)}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:10px">
        <div style="background:var(--bg-soft);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:9px;color:var(--text3)">Ticket médio</div>
          <div style="font-size:14px;font-weight:800;font-family:var(--font-mono)">${money(ticketAvg)}</div>
          ${trend(allMonthTickets,mi)}
        </div>
        <div style="background:var(--bg-soft);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:9px;color:var(--text3)">Valor/hora</div>
          <div style="font-size:14px;font-weight:800;color:${vphAvg>=20?'var(--ok)':vphAvg>=10?'var(--warn)':'var(--bad)'}">${money(vphAvg)}/h</div>
        </div>
        <div style="background:var(--bg-soft);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:9px;color:var(--text3)">High ticket</div>
          <div style="font-size:14px;font-weight:800;color:${htAvg>=30?'var(--ok)':htAvg>=15?'var(--warn)':'var(--bad)'}">${htAvg}%</div>
        </div>
        <div style="background:var(--bg-soft);border-radius:8px;padding:8px;text-align:center">
          <div style="font-size:9px;color:var(--text3)">ChatLab IGP</div>
          <div style="font-size:14px;font-weight:800;color:${avgIGP>=70?'var(--ok)':avgIGP>=50?'var(--warn)':avgIGP?'var(--bad)':'var(--text3)'}">${avgIGP||'—'}</div>
        </div>
      </div>

      ${f.tech||f.behavior?`<div style="background:var(--bg-soft);border-radius:8px;padding:10px;margin-bottom:8px">
        <div style="font-size:10.5px;font-weight:700;color:var(--text3);margin-bottom:6px">📋 AVALIAÇÃO GESTOR</div>
        ${f.tech?.conversao?`<div style="font-size:12.5px;margin-bottom:3px"><strong style="color:var(--text2)">Conversão:</strong> ${f.tech.conversao}</div>`:''}
        ${f.behavior?.comprometimento?`<div style="font-size:12.5px;margin-bottom:3px"><strong style="color:var(--text2)">Comprometimento:</strong> ${f.behavior.comprometimento}</div>`:''}
        ${f.potential?.potencial?`<div style="font-size:12.5px;margin-bottom:3px"><strong style="color:var(--text2)">Potencial:</strong> ${f.potential.potencial}</div>`:''}
        ${f.risk?.riscos?`<div style="font-size:12.5px;color:var(--warn)"><strong>Atenção:</strong> ${f.risk.riscos}</div>`:''}
      </div>`:''}

      ${monthAnalyses.length?`<div style="background:var(--info-soft);border-radius:8px;padding:10px;margin-bottom:8px">
        <div style="font-size:10.5px;font-weight:700;color:var(--info);margin-bottom:6px">🔬 ANÁLISES CHATLAB (${monthAnalyses.length})</div>
        ${monthAnalyses.map(a=>`<div style="font-size:12px;color:var(--text2);padding:3px 0;border-bottom:1px solid rgba(29,95,174,.1)">${a.date.slice(0,10)} · IGP <strong style="color:${(a.igp||0)>=70?'var(--ok)':(a.igp||0)>=50?'var(--warn)':'var(--bad)'}">${a.igp||'—'}</strong>${a.resumo?` · ${a.resumo.slice(0,80)}...`:''}</div>`).join('')}
      </div>`:''}

      <div style="background:var(--warn-soft);border-radius:8px;padding:10px">
        <div style="font-size:10.5px;font-weight:700;color:var(--warn);margin-bottom:5px">📌 ANÁLISE DO MÊS</div>
        ${recs.map(r=>`<div style="font-size:12.5px;color:var(--text);padding:2px 0">• ${r}</div>`).join('')}
      </div>
    </div>`;
  });

  // If no monthly data but has ChatLab analyses
  if(!months.length&&clAnalyses.length){
    html+=`<div class="panel">
      <div class="panel-title">🔬 Análises ChatLab</div>
      ${clAnalyses.map(a=>`<div style="padding:8px 0;border-bottom:1px solid var(--line)">
        <div style="display:flex;justify-content:space-between"><span style="font-weight:600">${a.date.slice(0,10)}</span><span style="font-family:var(--font-mono);color:${(a.igp||0)>=70?'var(--ok)':(a.igp||0)>=50?'var(--warn)':'var(--bad)'}">${a.igp||'—'}/100</span></div>
        ${a.resumo?`<div style="font-size:12px;color:var(--text2);margin-top:3px">${a.resumo.slice(0,120)}...</div>`:''}
      </div>`).join('')}
    </div>`;
  }

  el.innerHTML=html;
}

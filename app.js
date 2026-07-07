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
  if(!s.morningRoutine)s.morningRoutine=[];
  if(!s.morningRoutineDone)s.morningRoutineDone={}; // dateKey -> [itemId,...] — feito/dia (campo próprio, seguro para salvar)
  if(!s.problemsToday||!Array.isArray(s.problemsToday))s.problemsToday=[];
  if(!s.demandas)s.demandas={};
  if(!s.trainings)s.trainings=[];
  if(!s.weekEvolutions)s.weekEvolutions={};
  if(!s.modelRequests)s.modelRequests={};
  if(!s.weekPrize)s.weekPrize={};
  if(!s.motivational)s.motivational={};
  if(!s.scheduleRequests)s.scheduleRequests={};
  if(!s.chatterFichas)s.chatterFichas={};
  if(!s.estudosDraft)s.estudosDraft={};
  if(!s.estudosHistory)s.estudosHistory=[];
  if(!s.managerProfile)s.managerProfile={};
  if(!s.motivacionalHome)s.motivacionalHome={};
  if(!s.chatAnalyses)s.chatAnalyses={};
  if(!s.semanaObjetivos)s.semanaObjetivos={};
  if(!s.modelRequestsSplit)s.modelRequestsSplit={};
  if(!s.demandas2||!Array.isArray(s.demandas2))s.demandas2=[];
  if(!s.justificativas)s.justificativas={};
  if(!s.chatlabAnalyses)s.chatlabAnalyses=[];
  if(!s.chatterTraining)s.chatterTraining={};
  if(!s.weekOrients)s.weekOrients=[];
  else{const wk=getWeekKey();s.weekOrients=s.weekOrients.filter(o=>!o.done||o.doneWeek===wk);} // done items vanish on new week
  if(!s.geradorMeu)s.geradorMeu=[];
  if(!s.geradorExt)s.geradorExt=[];
  if(!s.geradorCanal)s.geradorCanal='PRIVACY FREE';
  if(!s.geradorElite)s.geradorElite=[];
  if(!s.testerLogs)s.testerLogs={};
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
  if(!s.weekGoals)s.weekGoals={};
  if(!s.revenues)s.revenues={};
  if(!s.models)s.models=[];
  if(!s.quickNotes)s.quickNotes=[];
  if(!s.turnoLog)s.turnoLog={};
  if(!s.chatters)s.chatters=[];
  if(!s.shifts)s.shifts=[];
  if(!s.absences)s.absences=[];
  if(!s.orientations)s.orientations=[];
  if(!s.studies)s.studies=[];
  s.chatters=s.chatters.map(c=>({
    level:'junior',discord:'',notes:'',watchtime:'',createdAt:new Date().toISOString(),
    time:'basico', // 'basico' | 'elite'
    ...c
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
    // Timeout: if no response in 8s, give up silently
    const t=setTimeout(()=>{
      if(fbSyncStatus!=='online'){fbSyncStatus='offline';updateSyncBadge();}
    },8000);
    listenToFirestore(t);
  }catch(e){
    fbSyncStatus='offline';
    updateSyncBadge();
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
  loc.forEach(item=>{if(item&&typeof item==='object'&&item.id!=null){if(!map.has(item.id))order.push(item.id);map.set(item.id,item);}});
  rem.forEach(item=>{if(item&&typeof item==='object'&&item.id!=null){
    const existing=map.get(item.id);
    if(!map.has(item.id))order.push(item.id);
    map.set(item.id,existing?deepMergeState(existing,item):item);
  }});
  return order.map(id=>map.get(id));
}
function deepMergeState(local,remote){
  if(remote===undefined||remote===null)return local;
  if(local===undefined||local===null)return remote;
  if(Array.isArray(local)||Array.isArray(remote))return mergeArraysSafe(local,remote);
  if(isPlainObj(local)&&isPlainObj(remote)){
    const out={};
    const keys=new Set([...Object.keys(local),...Object.keys(remote)]);
    keys.forEach(k=>{out[k]=deepMergeState(local[k],remote[k]);});
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
const SHARD_FIELDS=['chatterFichas','revenues','chatlabAnalyses'];
const SHARD_DOC_IDS={chatterFichas:'shard-fichas',revenues:'shard-revenues',chatlabAnalyses:'shard-chatlab'};
const ALL_SYNC_DOC_IDS=[FIREBASE_DOC_ID,...SHARD_FIELDS.map(f=>SHARD_DOC_IDS[f])];
let fbDocsSeen=new Set();
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
          if(fbDocsSeen.size>=ALL_SYNC_DOC_IDS.length)fbHasReceivedFirstSnapshot=true;
          fbSyncStatus='online';updateSyncBadge();
          return;
        }
        let needsInitialPush=false;
        if(doc.exists){
          const remote=doc.data();
          if(remote&&remote.payload){
            try{
              const parsedPart=JSON.parse(remote.payload);
              if(docId===FIREBASE_DOC_ID){
                const migrated=migrateState(parsedPart);
                S=deepMergeState(S,migrated);delete S.payload;delete S.schemaVersion;delete S.updatedAt;
              } else {
                // Shard: parsedPart já vem no formato {campo: valor} — funde só essa fatia
                S=deepMergeState(S,parsedPart);delete S.payload;delete S.schemaVersion;delete S.updatedAt;
                if(docId===SHARD_DOC_IDS.chatterFichas)pruneHeavyData(S); // dedupe/limpa aqui também, não só no load inicial
              }
              persistLocalCache();
              scheduleRerenderAfterSync();
            }catch(e){console.error('Erro ao processar snapshot '+docId,e);}
          }
        } else {
          needsInitialPush=true; // documento ainda não existe (ex: primeiro uso, ou fatia nova do sharding)
        }
        // IMPORTANTE: marca como "visto" ANTES de decidir qualquer coisa.
        // Nunca cria/sobrescreve um documento baseado só no estado local
        // até termos confirmado o que já existe em TODOS os documentos —
        // isso evita que um envio precoce (antes da sincronização inicial
        // terminar) apague dados reais que só existiam no Firestore.
        fbDocsSeen.add(docId);
        const wasAllSeenBefore=fbHasReceivedFirstSnapshot;
        const allSeen=fbDocsSeen.size>=ALL_SYNC_DOC_IDS.length;
        if(allSeen)fbHasReceivedFirstSnapshot=true;
        if(needsInitialPush&&allSeen)pushToFirestore();
        else if(allSeen&&!wasAllSeenBefore)pushToFirestore(); // sincronização inicial completa agora — envia qualquer mudança que ficou represada esperando
        fbSyncStatus='online';
        updateSyncBadge();
        runAutoBackupIfNeeded();
      },
      (err)=>{
        if(connectTimeout)clearTimeout(connectTimeout);
        fbSyncStatus='offline';
        updateSyncBadge();
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

let localSaveFailCount=0;
let lastLocalSaveWarningAt=0;
function save(){
  pruneHeavyData(S); // limpa/dedupe antes de salvar, pra nunca deixar duplicata ir pro Firebase
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
  fbIgnoreSnapshotsUntil=Date.now()+3000;
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
  smartAlertsDone:{},    // dateKey -> [alertId, ...]
  alertNotes:{},         // 'date_alertId' -> text
  horaExtraSlots:{},     // weekKey -> [{...}]
  swaps:[],              // [{id, date, covererId, originalId, ...}]
  morningRoutine:[],     // [{id, text, done}] — repeats daily
  morningRoutineDone:{}, // dateKey -> [itemId,...] — marcação diária de feito (campo próprio, JSON-safe)
  problemsToday:[],      // persistent list [{id, text, done}] — does NOT reset daily
  demandas:{},           // dateKey -> [{id, text, done}]
  trainings:[],          // [{id, title, date, days:[{day, script}]}]
  weekEvolutions:{},     // weekKey -> [{id, label, done, missed}]
  modelRequests:{},      // weekKey -> [{id, text}]
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
const LVLCLASS={treinamento:'lvl-treinamento',teste:'lvl-teste',junior:'lvl-junior',pleno:'lvl-pleno',senior:'lvl-senior'};
const LVLEMOJI={treinamento:'◆',teste:'○',junior:'▲',pleno:'●',senior:'★'};

// ---------- HELPERS ----------
function p2(n){return String(n).padStart(2,'0');}
function fmt(d){return`${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`;}
function nowHHMM(){const n=new Date();return p2(n.getHours())+':'+p2(n.getMinutes());}
function todayKey(){return fmt(new Date());}
function getTodayDayKey(){return DAY_KEYS[new Date().getDay()];}
// weekOffset: 0=current, -1=last week, -2=two weeks ago, etc.
let weekOffset=0;

function getWeekDates(offset){
  const off=offset!==undefined?offset:weekOffset;
  const now=new Date(),dow=now.getDay();
  const sun=new Date(now);sun.setDate(now.getDate()-dow + off*7);
  return Array.from({length:7},(_,i)=>{const d=new Date(sun);d.setDate(sun.getDate()+i);return d;});
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
function money(n){return 'R$ '+ (n||0).toLocaleString('pt-BR',{minimumFractionDigits:2});}
function moneyShort(n){return 'R$'+(n||0).toLocaleString('pt-BR',{maximumFractionDigits:0});}

// ---------- NAV ----------
const VIEWS=['home','turno','semana','time','fat','report','extra','gerador','gestao','fichas','estudos','evolucao','chatlab','testers','pagamento','projecao'];
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
}
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
  else if(v==='fichas')renderFichas();
  else if(v==='estudos')renderEstudos();
  else if(v==='evolucao')renderEvolucao();
  else if(v==='chatlab')renderChatLab();
  else if(v==='testers')renderTesters();
  else if(v==='pagamento')renderPagamento();
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
  document.getElementById('hd-clock').textContent=`${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
  document.getElementById('hd-date').textContent=`${DAYS[now.getDay()]}, ${now.getDate()} ${MONTHS[now.getMonth()]}`;
  updateAlarmCountdown();
  checkMidnightGeneration();
  checkLoginWatch();
  updateNavDots();
  // Refresh escritório every minute — schedule-based status changes on the minute
  if(now.getSeconds()===0){
    renderEscritorioPanel();
    renderSmartAlerts();
  }
}

// ---------- NAV DOTS (pending indicators) ----------
function updateNavDots(){
  const yest=new Date();yest.setDate(yest.getDate()-1);
  const ykey=fmt(yest);
  const watchPending=Object.values(S.watchAlerts[todayKey()]||{}).filter(s=>s==='pending').length;
  const dot=document.getElementById('nav-dot-turno');
  if(dot)dot.style.display=(watchPending>0)?'block':'none';
}

/* ===========================================================
   FEATURE 1 — LOGIN WATCH ALARM (per-chatter)
   For each chatter with a configured watchtime, fires an
   internal alarm at that time reminding the manager to check
   whether the chatter actually logged in.
   =========================================================== */
let watchFiredToday=new Set(); // chatterIds already alerted today (in-memory, resets on reload but date-keyed below avoids dup via state)

function checkLoginWatch(){
  const today=todayKey();
  const now=new Date();
  const nowMinutes=now.getHours()*60+now.getMinutes();
  if(!S.watchAlerts[today])S.watchAlerts[today]={};
  S.chatters.forEach(c=>{
    if(!c.watchtime)return;
    const[wh,wm]=c.watchtime.split(':').map(Number);
    const watchMinutes=wh*60+wm;
    // Fire if we're at or up to 10 minutes past the configured time — covers
    // the case where the app wasn't open at the exact minute the alarm was due.
    const withinWindow=nowMinutes>=watchMinutes&&nowMinutes<=watchMinutes+10;
    if(withinWindow){
      const already=S.watchAlerts[today][c.id];
      if(!already){
        S.watchAlerts[today][c.id]='pending';
        save();
        toast(`⏰ Checar entrada de ${c.name} (esperado ${c.watchtime})`,6000);
        renderHome();
      }
    }
  });
}

function getWatchAlertsToday(){
  const today=todayKey();
  const map=S.watchAlerts[today]||{};
  return Object.entries(map).filter(([id,status])=>status==='pending').map(([id])=>S.chatters.find(c=>c.id===id)).filter(Boolean);
}

function confirmWatch(chatterId,status){
  const today=todayKey();
  if(!S.watchAlerts[today])S.watchAlerts[today]={};
  S.watchAlerts[today][chatterId]=status;
  save();
  renderHome();
  const c=S.chatters.find(ch=>ch.id===chatterId);
  toast(status==='confirmed'?`✅ ${c?c.name:'?'} confirmado online`:`⚠️ ${c?c.name:'?'} marcado como atraso`);
  if(status==='missed'){
    // also helpful: prefill absence quick log as atraso
  }
}

function renderWatchBanner(){
  const wrap=document.getElementById('home-watch-wrap');
  if(!wrap)return;
  const pending=getWatchAlertsToday();
  if(!pending.length){wrap.innerHTML='';return;}
  wrap.innerHTML=`<div class="watchbanner">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:9px">
      <span style="font-size:16px">⏰</span><span style="font-weight:700;font-size:13.5px;color:var(--bad)">Checagem de entrada</span>
    </div>
    ${pending.map(c=>{
      const color=getComputedLevelColor(c.level);
      return`<div class="watchitem">
        <div style="flex:1"><span style="font-weight:700;font-size:13px">${c.name}</span>
        <span style="font-family:var(--font-mono);font-size:11px;color:var(--text2);margin-left:6px">esperado ${c.watchtime}</span></div>
        <button class="btn btn-primary btn-xs" onclick="confirmWatch('${c.id}','confirmed')">✓ Entrou</button>
        <button class="btn btn-danger btn-xs" onclick="confirmWatch('${c.id}','missed')">✕ Não entrou</button>
      </div>`;
    }).join('')}
  </div>`;
}
function getComputedLevelColor(level){
  const map={treinamento:'#6E6AF0',teste:'#8A8A93',junior:'#2F8FE0',pleno:'#C98A1F',senior:'#1F9E6E'};
  return map[level]||'#8A8A93';
}

/* ===========================================================
   FEATURE 2 — DAILY TASKS (general checklist, not chatter-bound)
   =========================================================== */
function renderDailyTasks(){
  const el=document.getElementById('daily-tasks-list');
  if(!el)return; // element removed — tasks now managed in Gestão
  const tasks=S.dailyTasks[today]||[];
  if(!tasks.length){el.innerHTML='<div class="empty"><div class="empty-ic">✅</div><div class="empty-tx">Nenhuma tarefa para hoje.<br>Adicione itens da sua rotina de gestão.</div></div>';return;}
  const pb={alta:'pill-bad',media:'pill-warn',baixa:'pill-flat'};
  el.innerHTML='<div class="tasklist">'+tasks.map(t=>`
    <div class="taskrow ${t.done?'done':''}">
      <div class="tcheck ${t.done?'done':''}" onclick="toggleTask('${t.id}')">${t.done?'✓':''}</div>
      <div class="tbody">
        <div class="ttext">${t.text}</div>
        <div class="tmeta-row"><span class="pill ${pb[t.prio]||'pill-flat'}">${t.prio}</span></div>
      </div>
      <button class="btn btn-icon btn-line" onclick="deleteTask('${t.id}')" style="font-size:14px">✕</button>
    </div>`).join('')+'</div>';
}
function saveTask(){
  const text=document.getElementById('task-text').value.trim();
  if(!text){toast('⚠️ Escreva a tarefa');return;}
  const today=todayKey();
  if(!S.dailyTasks[today])S.dailyTasks[today]=[];
  S.dailyTasks[today].push({id:'dt'+Date.now(),text,prio:document.getElementById('task-prio').value,done:false});
  save();closeModal('m-task');document.getElementById('task-text').value='';
  toast('✅ Tarefa adicionada!');renderDailyTasks();updateNavDots();
}
function toggleTask(id){
  const today=todayKey();
  const t=(S.dailyTasks[today]||[]).find(x=>x.id===id);
  if(t){t.done=!t.done;save();renderDailyTasks();updateNavDots();}
}
function deleteTask(id){
  const today=todayKey();
  S.dailyTasks[today]=(S.dailyTasks[today]||[]).filter(x=>x.id!==id);
  save();renderDailyTasks();toast('Removida');
}

/* ===========================================================
   FEATURE 3 — WEEKLY GOALS (team-level planning)
   =========================================================== */
function renderSemana(){
  renderWeekNav();
  renderWeekOrients();
  const wk=getWeekDates();
  document.getElementById('semana-range').textContent=`${wk[0].getDate()}/${wk[0].getMonth()+1} – ${wk[6].getDate()}/${wk[6].getMonth()+1}`;
  const notesEl=document.getElementById('week-notes');
  if(notesEl&&!notesEl.value)notesEl.value=S.weekNotes[getWeekKey()]||'';
  renderGoals();
  renderSemanaRevenue();
  renderSemanaDesenvolvimento();
}
function renderGoals(){
  const el=document.getElementById('goals-list');
  const wkey=getWeekKey();
  const goals=S.weekGoals[wkey]||[];
  if(!goals.length){el.innerHTML='<div class="empty"><div class="empty-ic">🎯</div><div class="empty-tx">Nenhum objetivo definido para esta semana.<br>Defina metas para guiar o time.</div></div>';return;}
  el.innerHTML=goals.map(g=>{
    if(g.type==='simples'){
      return`<div class="goalcard ${g.done?'met':''}">
        <div class="goal-top">
          <div class="goal-text" style="${g.done?'text-decoration:line-through;color:var(--text3)':''}">${g.text}</div>
          <button class="tcheck ${g.done?'done':''}" onclick="toggleGoalDone('${g.id}')">${g.done?'✓':''}</button>
        </div>
        <button class="btn btn-icon btn-line" style="margin-top:4px" onclick="deleteGoal('${g.id}')">✕</button>
      </div>`;
    }
    const pct=g.target>0?Math.min(100,Math.round((g.current/g.target)*100)):0;
    const met=pct>=100;
    return`<div class="goalcard ${met?'met':''}">
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
        <input type="number" class="finput" style="flex:1" id="goal-update-${g.id}" placeholder="Atualizar valor atual...">
        <button class="btn btn-soft btn-sm" onclick="updateGoalProgress('${g.id}')">Atualizar</button>
      </div>
    </div>`;
  }).join('');
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
  const chatters=S.chatters.filter(c=>c.time!=='tester');
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
      const opensBlock1=s.folgaDia===dayKey;
      const opensBlock2=s.folgaDia2===dayKey&&s.start2&&s.end2;
      if(!opensBlock1&&!opensBlock2)return;
      const c=S.chatters.find(ch=>ch.id===s.chatterId);
      if(!c)return;
      const models=(s.modelIds||[]).map(mid=>S.models.find(m=>m.id===mid)).filter(Boolean);
      const modelStr=models.map(m=>`${m.emoji||'🧩'} ${m.name}`).join(' · ')||'sem modelo';
      const timeStr=[opensBlock1?`${s.start}–${s.end}`:null,opensBlock2?`${s.start2}–${s.end2}`:null].filter(Boolean).join(' · ');
      const existingSwap=S.swaps.find(sw=>sw.date===dateStr&&sw.shiftId===s.id&&sw.originalId===c.id);
      windows.push({date:dateStr,dayName:DAYS[day.getDay()],shiftId:s.id,originalId:c.id,originalName:c.name,modelStr,timeStr,covererId:existingSwap?existingSwap.covererId:''});
    });
  });
  return windows.sort((a,b)=>a.date.localeCompare(b.date));
}
function assignWindowCover(shiftId,date,originalId,covererId){
  S.swaps=S.swaps.filter(sw=>!(sw.date===date&&sw.shiftId===shiftId&&sw.originalId===originalId));
  if(covererId){
    const s=S.shifts.find(sh=>sh.id===shiftId);
    if(s){
      S.swaps.push({id:'sw'+Date.now()+Math.random().toString(36).slice(2,5),date,covererId,originalId,start:s.start,end:s.end,start2:s.start2||'',end2:s.end2||'',shiftId:s.id,createdAt:todayKey()});
      const coverer=S.chatters.find(c=>c.id===covererId);
      const original=S.chatters.find(c=>c.id===originalId);
      toast(`✅ ${coverer?.name} vai cobrir ${original?.name} em ${date} — já aparece na escala do dia`);
    }
  }
  save();
  renderAvailWindowsPanel();
  if(typeof renderTurno==='function'&&currentViewName()==='turno')renderTurno();
}
function renderAvailWindowsPanel(){
  const panel=document.getElementById('home-availwindows-panel');
  const el=document.getElementById('home-availwindows-content');
  if(!panel||!el)return;
  if(!S.chatters.length){panel.style.display='none';return;}
  const windows=getWeekAvailableWindows();
  if(!windows.length){panel.style.display='none';return;}
  panel.style.display='block';
  el.innerHTML=`
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
      <span style="font-size:20px">🗓️</span>
      <div style="font-weight:700;font-size:14px">Janelas disponíveis na semana</div>
    </div>
    ${windows.map(w=>{
      const d=new Date(w.date+'T12:00:00');
      const dayShort=w.dayName.slice(0,3);
      return`<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)">
        <div style="flex:1;min-width:0">
          <div style="font-size:13.5px;font-weight:700;color:var(--text)">${w.modelStr} · ${w.timeStr}</div>
          <div style="font-size:11px;color:var(--text3)">${dayShort} ${d.getDate()}/${d.getMonth()+1} · turno de ${w.originalName}</div>
        </div>
        <select onchange="assignWindowCover('${w.shiftId}','${w.date}','${w.originalId}',this.value)" style="max-width:130px;font-size:12px;padding:6px 8px;border-radius:8px;border:1.5px solid ${w.covererId?'var(--ok)':'var(--line)'};background:${w.covererId?'var(--ok-soft)':'var(--bg-soft)'};color:var(--text)">
          <option value="">— cobrir —</option>
          ${S.chatters.filter(c=>c.id!==w.originalId).map(c=>`<option value="${c.id}" ${w.covererId===c.id?'selected':''}>${c.name}</option>`).join('')}
        </select>
      </div>`;
    }).join('')}
  `;
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

  S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester').forEach(c=>{
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
    S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester').forEach(c=>{
      const hasRev=S.models.some(m=>(parseFloat(S.revenues[`${c.id}_${m.id}_${dk}`])||0)>0);
      if(!hasRev){
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
    return`<div style="border-radius:10px;padding:11px 12px;background:${bg};border-left:3px solid ${borderColor};margin-bottom:8px;transition:opacity .2s">
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
}

function renderHome(){
  renderWatchBanner();
  renderEscritorioPanel();
  renderUrgentPanel();
  renderSmartAlerts();
  renderAvailWindowsPanel();
  renderMotivacionalHome();
  render48hAlerts();
  renderMidnightPreviewHome();
}

function renderEscritorioPanel(){
  const el=document.getElementById('home-escritorio');
  if(!el)return;
  const todayDK=getTodayDayKey();
  const today=todayKey();

  const online=getCurrentOnline();
  const scheduledToday=getCurrentScheduledToday();

  // Manual overrides saved in S.turnoLog[today] with status 'manual_online' or 'manual_offline'
  if(!S.turnoLog[today])S.turnoLog[today]=[];
  const manualOnline=S.turnoLog[today].filter(x=>x.status==='manual_online').map(x=>x.chatterId);
  const manualOffline=S.turnoLog[today].filter(x=>x.status==='manual_offline').map(x=>x.chatterId);

  // Full online list = auto detected + manual overrides
  const allOnlineIds=new Set([...online.map(c=>c.id),...manualOnline].filter(id=>!manualOffline.includes(id)));
  const allOnline=S.chatters.filter(c=>allOnlineIds.has(c.id));

  // Not online but scheduled or manually available
  const notOnline=S.chatters.filter(c=>
    c.time!=='elite'&&
    !allOnlineIds.has(c.id)
  );

  const nextUp=scheduledToday
    .filter(c=>!allOnlineIds.has(c.id))
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
  const gaveAway=S.swaps.some(sw=>sw.date===today&&sw.originalId===chatterId);
  if(!gaveAway){
    const shifts=S.shifts.filter(s=>s.chatterId===chatterId&&(s.days||[]).includes(todayDK));
    for(const s of shifts){
      const [sh,sm]=s.start.split(':').map(Number);
      const [eh,em]=s.end.split(':').map(Number);
      const startMins=sh*60+sm, endMins=eh*60+em;
      if(nowMins>=startMins&&nowMins<endMins)return true;
      if(s.start2&&s.end2){
        const [sh2,sm2]=s.start2.split(':').map(Number);
        const [eh2,em2]=s.end2.split(':').map(Number);
        const s2=sh2*60+sm2,e2=eh2*60+em2;
        if(nowMins>=s2&&nowMins<e2)return true;
      }
    }
  }
  // Also check swaps for today
  const swapShifts=S.swaps.filter(sw=>sw.date===today&&sw.covererId===chatterId);
  for(const sw of swapShifts){
    const [sh,sm]=(sw.start||'').split(':').map(Number);
    const [eh,em]=(sw.end||'').split(':').map(Number);
    if(!isNaN(sh)){const s=sh*60+sm,e=eh*60+em;if(nowMins>=s&&nowMins<e)return true;}
    if(sw.start2&&sw.end2){
      const [sh2,sm2]=sw.start2.split(':').map(Number);
      const [eh2,em2]=sw.end2.split(':').map(Number);
      if(!isNaN(sh2)){const s2=sh2*60+sm2,e2=eh2*60+em2;if(nowMins>=s2&&nowMins<e2)return true;}
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
  // Manual overrides (checkins) take priority over schedule
  const log=(S.turnoLog[dateKey]||[]).filter(e=>e.chatterId===chatterId);
  if(log.length){
    const last=log[log.length-1];
    // Manual override: if last action was 'out', check if a new shift started since then
    if(last.action==='out'){
      // If schedule says they should be on right now (new shift window), override the manual out
      if(dateKey===todayKey()&&isChatterScheduledNow(chatterId))return'online';
      return'offline';
    }
    if(last.action==='overtime')return'overtime';
    if(last.action==='in')return'online';
  }
  // No manual log — use schedule automatically
  if(dateKey===todayKey()&&isChatterScheduledNow(chatterId))return'online';
  return'offline';
}

function getCurrentOnline(){
  const today=todayKey();
  // Elite chatters work off-schedule — exclude from auto status
  return S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester'&&['online','overtime'].includes(getChatterStatus(c.id,today)));
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
let selectedDay='seg';
function toggleNextTurno(){
  const panel=document.getElementById('next-turno-panel');
  const arrow=document.getElementById('next-turno-arrow');
  if(!panel)return;
  const open=panel.style.display==='none';
  panel.style.display=open?'block':'none';
  if(arrow)arrow.textContent=open?'▾ fechar':'▸ ver';
}

function renderTurno(){
  renderTurnoDay();
  renderTurnoWeek();
  renderAbsenceListWithJustificativa();
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
    html='<div style="color:var(--text3);font-size:13px;padding:12px 0;text-align:center">Nenhum chatter do Time Básico escalado hoje</div>';
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
  const yest=new Date();yest.setDate(yest.getDate()-1);const yO=S.orientations.filter(o=>o.date===fmt(yest));
  let html='';
  if(yO.length){
    html+=`<div style="margin-bottom:12px"><div class="sectionlb" style="color:var(--warn)">↻ follow-up de ontem</div>
    ${yO.map(o=>{const c=S.chatters.find(ch=>ch.id===o.chatterId);return`<div class="logitem alt"><div class="logdate">${c?c.name:'?'} · ${o.shift}</div><div class="logtext">${o.text}</div></div>`;}).join('')}</div>`;
  }
  if(!todayO.length){html+='<div class="empty"><div class="empty-ic">🎯</div><div class="empty-tx">Nenhuma orientação hoje</div></div>';}
  else{
    html+='<div class="sectionlb">hoje</div>';
    html+=todayO.map(o=>{const c=S.chatters.find(ch=>ch.id===o.chatterId);
      return`<div class="logitem"><div class="logdate">${c?c.name:'?'} · turno ${o.shift}</div><div class="logtext">${o.text}</div>
      ${o.goal?`<div style="margin-top:5px;font-family:var(--font-mono);font-size:12px;color:var(--ok)">meta: ${money(parseFloat(o.goal))}</div>`:''}
      <button class="btn btn-icon btn-line" style="margin-top:8px" onclick="deleteOrientation('${o.id}')">✕</button></div>`;
    }).join('');
  }
  el.innerHTML=html;
}
function renderStudyList(){
  const el=document.getElementById('study-list');
  if(!S.studies.length){el.innerHTML='<div class="empty"><div class="empty-ic">📚</div><div class="empty-tx">Adicione itens de estudo</div></div>';return;}
  const pb={alta:'pill-bad',media:'pill-warn',baixa:'pill-flat'};
  el.innerHTML='<div class="tasklist">'+S.studies.map(s=>`<div class="taskrow ${s.done?'done':''}">
    <div class="tcheck ${s.done?'done':''}" onclick="toggleStudy('${s.id}')">${s.done?'✓':''}</div>
    <div class="tbody"><div class="ttext">${s.title}</div>
    <div class="tmeta-row"><span class="pill pill-info">${s.category}</span><span class="pill ${pb[s.priority]||'pill-flat'}">${s.priority}</span></div></div>
    <button class="btn btn-icon btn-line" onclick="deleteStudy('${s.id}')">✕</button>
  </div>`).join('')+'</div>';
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
  if(filter!=='all')chatters=chatters.filter(c=>c.level===filter);
  if(!chatters.length){list.innerHTML='<div class="empty"><div class="empty-ic">▦</div><div class="empty-tx">Nenhum chatter encontrado</div></div>';return;}

  const eliteGroup=chatters.filter(c=>c.time==='elite');
  const basicoGroup=chatters.filter(c=>c.time!=='elite'&&c.time!=='tester');

  const renderCard=c=>{
    const color=getComputedLevelColor(c.level);
    const revWeek=getChatterWeekRevenue(c.id,0);
    const extraWeek=getChatterExtraRevenue(c.id,0);
    const {avgHtPct,htTotal}=getChatterWeekHighTicket(c.id,0);
    const status=getChatterStatus(c.id,todayKey());
    const otMins=getChatterOvertimeOn(c.id,todayKey());
    const dotColor=status==='online'?'var(--ok)':status==='overtime'?'var(--warn)':'var(--text3)';
    const timeBadge=c.time==='elite'?`<span class="pill pill-warn" style="font-size:9px">⭐ Elite</span>`:c.time==='tester'?`<span class="pill pill-bad" style="font-size:9px">🧪 Novatos</span>`:`<span class="pill pill-flat" style="font-size:9px">Básico</span>`;
    return`<div class="teamcard" onclick="openChatterDetail('${c.id}')">
      <div class="ravatar" style="width:42px;height:42px;background:${color}22;color:${color}">${c.name.slice(0,2).toUpperCase()}</div>
      <div class="rinfo">
        <div style="display:flex;align-items:center;gap:6px"><span class="rname">${c.name}</span><div class="tc-status" style="background:${dotColor}"></div></div>
        <div class="rmeta">${c.discord||''} · ${moneyShort(revWeek)} semana${extraWeek>0?` · ⚡${moneyShort(extraWeek)} extra`:''}${htTotal>0?` · 🎯${avgHtPct}% HT (${moneyShort(htTotal)})`:''}</div>
        <div class="tmeta-row">${timeBadge}<span class="pill ${LVLCLASS[c.level]}" style="border:1px solid">${c.level}</span>${otMins>0?`<span class="pill pill-warn">+${otMins}min`:''}${c.watchtime?`<span class="pill pill-info">⏰ ${c.watchtime}</span>`:''}</div>
      </div>
      <span style="color:var(--text3);font-size:18px">›</span>
    </div>`;
  };

  let html='';
  if(eliteGroup.length){
    html+=`<div style="font-size:11px;font-weight:800;color:var(--warn);text-transform:uppercase;letter-spacing:.06em;margin:4px 0 8px">⭐ Time Elite (${eliteGroup.length})</div>`;
    html+=eliteGroup.map(renderCard).join('');
  }
  if(basicoGroup.length){
    html+=`<div style="font-size:11px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin:${eliteGroup.length?'16px':'4px'} 0 8px">Time Básico (${basicoGroup.length})</div>`;
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
      <input type="number" class="finput" style="width:84px;text-align:right;padding:6px 8px;font-size:13px;font-family:var(--font-mono)" value="${val}" placeholder="0" oninput="saveRevenue('${id}','${m.id}',this.value)"></div>
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
      <span class="pill ${LVLCLASS[c.level]}" style="border:1px solid;margin-top:4px">${c.level}</span></div>
    </div>
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
      </select>
    </div>
    <div class="field"><label class="flabel">Time</label>
      <div style="display:flex;gap:8px">
        <button id="dl-time-basico-${id}" onclick="setChatterTime('${id}','basico')" style="flex:1;padding:8px;border-radius:8px;border:2px solid ${(c.time||'basico')==='basico'?'var(--info)':'var(--line)'};background:${(c.time||'basico')==='basico'?'var(--info-soft)':'transparent'};cursor:pointer;font-family:var(--font-display);font-weight:700;font-size:12.5px;color:${(c.time||'basico')==='basico'?'var(--info)':'var(--text2)'}">Time Base</button>
        <button id="dl-time-elite-${id}" onclick="setChatterTime('${id}','elite')" style="flex:1;padding:8px;border-radius:8px;border:2px solid ${c.time==='elite'?'var(--warn)':'var(--line)'};background:${c.time==='elite'?'var(--warn-soft)':'transparent'};cursor:pointer;font-family:var(--font-display);font-weight:700;font-size:12.5px;color:${c.time==='elite'?'var(--warn)':'var(--text2)'}">⭐ Elite</button>
        <button id="dl-time-tester-${id}" onclick="setChatterTime('${id}','tester')" style="flex:1;padding:8px;border-radius:8px;border:2px solid ${c.time==='tester'?'var(--bad)':'var(--line)'};background:${c.time==='tester'?'var(--bad-soft)':'transparent'};cursor:pointer;font-family:var(--font-display);font-weight:700;font-size:12.5px;color:${c.time==='tester'?'var(--bad)':'var(--text2)'}">🧪 Novatos</button>
      </div>
    </div>
    <div class="field"><label class="flabel">⏰ Alarme de checagem de login</label>
      <input type="time" class="finput" id="dl-watch-${id}" value="${c.watchtime||''}">
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
  S.shifts=S.shifts.filter(s=>s.id!==shiftId);
  save();
  toast('Turno removido');
  renderChatterShifts(chatterId);
  renderScheduleForDay(selectedDay);
}

function saveChatterDetail(id){
  const c=S.chatters.find(ch=>ch.id===id);if(!c)return;
  const levelEl=document.getElementById('dl-level-'+id);
  const notesEl=document.getElementById('dl-notes-'+id);
  const watchEl=document.getElementById('dl-watch-'+id);
  if(levelEl)c.level=levelEl.value||c.level;
  if(notesEl)c.notes=notesEl.value; // intentional: allow clearing notes
  if(watchEl)c.watchtime=watchEl.value; // intentional: allow clearing alarm
  save();toast('✅ Atualizado!');renderTeam(teamFilter);
}
function deleteChatter(id){
  if(!confirm('Remover chatter? Isso também apaga faltas, orientações, treinamentos e histórico de ponto dele.'))return;
  S.chatters=S.chatters.filter(c=>c.id!==id);
  S.shifts=S.shifts.filter(s=>s.chatterId!==id);
  S.absences=S.absences.filter(a=>a.chatterId!==id);
  S.orientations=S.orientations.filter(o=>o.chatterId!==id);
  S.chatterTrainings=S.chatterTrainings.filter(t=>t.chatterId!==id);
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
  Object.keys(S.revenues).forEach(key=>{
    if(key.startsWith(id+'_'))delete S.revenues[key];
  });
  save();closeModal('m-chatter-detail');toast('Chatter e histórico removidos');renderTeam(teamFilter);
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
    <div class="taskrow ${t.done?'done':''}" style="margin-bottom:6px">
      <div class="tcheck ${t.done?'done':''}" onclick="toggleChatterTraining('${t.id}','${chatterId}')">${t.done?'✓':''}</div>
      <div class="tbody"><div class="ttext" style="font-size:12.5px">${t.title}</div></div>
      <button class="btn btn-icon btn-line" onclick="deleteChatterTraining('${t.id}','${chatterId}')">✕</button>
    </div>`).join('');
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

  // Update week range header
  const rangeEl=document.getElementById('report-wk-range');
  if(rangeEl)rangeEl.textContent=`${wd[0].getDate()}/${wd[0].getMonth()+1} a ${wd[6].getDate()}/${wd[6].getMonth()+1}`;

  // ---- Section 1: Visão Geral ----
  let totalRev=0;
  const chatterRevs=S.chatters.filter(c=>c.time!=='tester').map(c=>{
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
    const ativos=S.chatters.filter(c=>c.level!=='treinamento'&&c.level!=='teste'&&c.time!=='tester');
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
        <div class="field" style="margin-top:8px"><label class="flabel">Principal erro</label><input class="finput" id="rpt-erro-${c.id}" value="${getReportDraft('erro-'+c.id)}" placeholder="Descreva o erro principal..."></div>
        <div class="field"><label class="flabel">Ação tomada</label><input class="finput" id="rpt-acao-${c.id}" value="${getReportDraft('acao-'+c.id)}" placeholder="O que você fez a respeito..."></div>
        ${orients.length?`<div style="margin-top:6px;font-size:11.5px;color:var(--text2)">📋 ${orients.length} orientação(ões) esta semana</div>`:''}
      </div>`;
    }).join('');
  }

  // ---- Section 6: Ações Realizadas ----
  const s6=document.getElementById('rpt-acoes');
  if(s6){
    const wkStart=fmt(wd[0]),wkEnd=fmt(wd[6]);
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
      <div class="reprow"><div class="replb">Treinamentos feitos</div><div class="repval">${trainsDone}</div></div>
      <div class="reprow"><div class="replb">Orientações/correções</div><div class="repval">${corrections}</div></div>
      <div class="reprow"><div class="replb">Trocas de turno cobertas</div><div class="repval">${swapsWeek}</div></div>
      <div class="reprow"><div class="replb">Decisões de teste (aprovado/reprovado)</div><div class="repval">${decisionsWeek}</div></div>
      <div class="reprow"><div class="replb">Categorias de pagamento definidas</div><div class="repval">${catsSetWeek}</div></div>
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

  // Restore saved draft values for manual fields
  ['erro1','erro2','erro3','prob1','prob2','plano1','plano2','plano3','ajustes'].forEach(key=>{
    const el=document.getElementById('rpt-'+key);
    if(el&&!el.value)el.value=getReportDraft(key)||'';
  });
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
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester');
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
function setReportToggle(draftKey,value,btnGroupPrefix){
  saveReportDraftField(draftKey,value);
  // Update button visual states
  const options=value==='Boa'||value==='Ruim'?['Boa','Ruim']:['Aprovar','Continuar','Reprovar'];
  const colorMap={
    Boa:'var(--ok)',Ruim:'var(--bad)',
    Aprovar:'var(--ok)',Continuar:'var(--warn)',Reprovar:'var(--bad)'
  };
  const bgMap={
    Boa:'var(--ok-soft)',Ruim:'var(--bad-soft)',
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
function generateFullReport(){
  saveReportDraft();
  const wd=getWeekDates();
  const wkey=getWeekKey();
  const goals=S.chatterWeekGoals[wkey]||{};
  const d=key=>getReportDraft(key);
  const wkStart=fmt(wd[0]),wkEnd=fmt(wd[6]);

  let totalRev=0;
  const chatterRevs=S.chatters.map(c=>{
    let r=0;wd.forEach(wdate=>S.models.forEach(m=>{r+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(wdate)}`])||0;}));
    totalRev+=r;return{c,r};
  }).sort((a,b)=>b.r-a.r);
  const avgRev=chatterRevs.filter(x=>x.r>0).length?totalRev/chatterRevs.filter(x=>x.r>0).length:0;
  const best=chatterRevs[0];
  const worst=[...chatterRevs].reverse().find(x=>x.r>0);

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
  const ativos=S.chatters.filter(c=>c.level!=='treinamento'&&c.level!=='teste'&&c.time!=='tester');
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
  lines.push(`3. MEUS PRINCIPAIS ERROS DA SEMANA`);
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
  lines.push(`4. AÇÕES REALIZADAS`);
  lines.push(`● Treinamentos feitos: ${trainsDone}`);
  lines.push(`● Correções aplicadas: ${corrections}`);
  lines.push(`● Ajustes na operação: ${d('ajustes')||'—'}`);
  lines.push(``);
  lines.push(`5. PROBLEMAS ENCONTRADOS`);
  lines.push(`● Problema 1: ${d('prob1')||'—'}`);
  lines.push(`● Problema 2: ${d('prob2')||'—'}`);
  lines.push(``);
  lines.push(`6. PLANO PARA PRÓXIMA SEMANA`);
  lines.push(`● Ação 1: ${d('plano1')||'—'}`);
  lines.push(`● Ação 2: ${d('plano2')||'—'}`);
  lines.push(`● Ação 3: ${d('plano3')||'—'}`);

  const text=lines.join('\n');
  document.getElementById('rpt-output').value=text;
  document.getElementById('rpt-output-panel').style.display='block';
  document.getElementById('rpt-output-panel').scrollIntoView({behavior:'smooth'});
  toast('✅ Relatório gerado!');
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
  renderMetaProgress();
  renderExtraProgress();
  renderChatterAnalysis();
  renderReport('week');
  renderDailyByModel();
  renderDailyByChatter();
  renderChatterGoals();
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
function renderRevenueTable(){
  const el=document.getElementById('revenue-table');
  if(!el)return;
  if(!S.models.length){el.innerHTML='<div class="empty"><div class="empty-tx">Cadastre modelos para lançar faturamento</div></div>';return;}
  if(!S.chatters.length){el.innerHTML='<div class="empty"><div class="empty-tx">Cadastre chatters para lançar faturamento</div></div>';return;}
  const dateKey=selectedFatDate;

  // Show all chatters — always. For past dates show everyone, for today show scheduled + those with revenue
  const allChatters=S.chatters.filter(c=>c.time!=='elite');

  // Check if any data exists for this date (from reports or manual)
  const hasReportData=allChatters.some(c=>S.models.some(m=>(parseFloat(S.revenues[`${c.id}_${m.id}_${dateKey}`])||0)>0));

  let html='';

  // Table header
  html+=`<div style="overflow-x:auto"><table class="rtable">
    <thead><tr>
      <th>Chatter</th>
      ${S.models.map(m=>`<th style="text-align:right">${m.emoji||'🧩'} ${m.name}</th>`).join('')}
      <th style="text-align:right;color:var(--ok)">Total</th>
    </tr></thead><tbody>`;

  let dayTotal=0;
  allChatters.forEach(c=>{
    let rowTotal=0;
    const cells=S.models.map(m=>{
      const key=`${c.id}_${m.id}_${dateKey}`;
      const val=parseFloat(S.revenues[key])||0;
      rowTotal+=val;
      return`<td style="text-align:right">
        <input type="number" class="rinput" value="${val||''}" placeholder="—"
          oninput="saveRevenue('${c.id}','${m.id}',this.value,'${dateKey}')">
      </td>`;
    }).join('');
    dayTotal+=rowTotal;
    const rowColor=rowTotal>0?'':'opacity:0.5';
    html+=`<tr style="${rowColor}">
      <td><div style="font-weight:700;font-size:13px">${c.name}</div></td>
      ${cells}
      <td style="text-align:right;font-family:var(--font-mono);font-weight:800;color:${rowTotal>0?'var(--ok)':'var(--text3)'}">
        ${rowTotal>0?money(rowTotal):'—'}
      </td>
    </tr>`;
  });

  // Total row
  html+='<tr class="rtotalrow"><td><strong>TOTAL DIA</strong></td>';
  S.models.forEach(m=>{
    let ct=0;allChatters.forEach(c=>{ct+=parseFloat(S.revenues[`${c.id}_${m.id}_${dateKey}`])||0;});
    html+=`<td style="text-align:right;font-family:var(--font-mono)">${ct>0?money(ct):'—'}</td>`;
  });
  html+=`<td style="text-align:right;font-family:var(--font-mono);font-weight:800;color:var(--ok)">${dayTotal>0?money(dayTotal):'—'}</td>`;
  html+='</tr></tbody></table></div>';

  // No substitute button needed — re-processing a report auto-replaces the data

  el.innerHTML=html;
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
  if(period==='week'){
    let total=0;wd.forEach(d=>S.chatters.forEach(c=>S.models.forEach(m=>{total+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(d)}`])||0;})));
    el.innerHTML=`<div style="font-family:var(--font-mono);font-size:26px;font-weight:700;color:var(--ok);text-align:center;padding:6px 0">${money(total)}</div>
    <div class="divider"></div><div class="sectionlb">por modelo</div>
    ${S.models.map(m=>{let r=0;wd.forEach(d=>S.chatters.forEach(c=>{r+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(d)}`])||0;}));return`<div class="reprow"><div class="replb">${m.emoji} ${m.name}</div><div class="repval">${money(r)}</div></div>`;}).join('')}
    <div class="divider"></div><div class="sectionlb">por chatter</div>
    ${S.chatters.map(c=>`<div class="reprow"><div class="replb">${c.name}</div><div class="repval">${money(getChatterWeekRevenueTotal(c.id))}</div></div>`).join('')}`;
  } else {
    const year=today.getFullYear(),month=today.getMonth();
    const daysInMonthSoFar=Array.from({length:today.getDate()},(_,i)=>new Date(year,month,i+1));
    let total=0;daysInMonthSoFar.forEach(d=>{const key=fmt(d);S.chatters.forEach(c=>S.models.forEach(m=>{total+=parseFloat(S.revenues[`${c.id}_${m.id}_${key}`])||0;}));});
    el.innerHTML=`<div style="font-family:var(--font-mono);font-size:26px;font-weight:700;color:var(--ok);text-align:center;padding:6px 0">${money(total)}</div>
    <div style="text-align:center;font-size:12px;color:var(--text2);margin-bottom:8px">${MONTHS[month]} ${year}</div>
    <div class="divider"></div><div class="sectionlb">por modelo</div>
    ${S.models.map(m=>{let r=0;daysInMonthSoFar.forEach(d=>{const key=fmt(d);S.chatters.forEach(c=>{r+=parseFloat(S.revenues[`${c.id}_${m.id}_${key}`])||0;});});return`<div class="reprow"><div class="replb">${m.emoji} ${m.name}</div><div class="repval">${money(r)}</div></div>`;}).join('')}
    <div class="divider"></div><div class="sectionlb">por chatter</div>
    ${S.chatters.map(c=>{let r=0;daysInMonthSoFar.forEach(d=>{const key=fmt(d);S.models.forEach(m=>{r+=parseFloat(S.revenues[`${c.id}_${m.id}_${key}`])||0;});});return`<div class="reprow"><div class="replb">${c.name}</div><div class="repval">${money(r)}</div></div>`;}).join('')}`;
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
  const wd=getWeekDates();
  const dayLabels=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  let html=`<div style="overflow-x:auto"><table class="rtable"><thead><tr><th>Modelo</th>${dayLabels.map(d=>`<th style="text-align:right">${d}</th>`).join('')}<th style="text-align:right;color:var(--ok)">Total</th></tr></thead><tbody>`;
  S.models.forEach(m=>{
    let rowTotal=0;
    const cells=wd.map(d=>{
      let v=0;S.chatters.forEach(c=>{v+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(d)}`])||0;});
      rowTotal+=v;
      return`<td style="text-align:right;font-family:var(--font-mono);font-size:11.5px">${v>0?v.toLocaleString('pt-BR',{maximumFractionDigits:0}):'—'}</td>`;
    }).join('');
    html+=`<tr><td><div style="font-weight:700;font-size:13px">${m.emoji} ${m.name}</div></td>${cells}<td style="text-align:right;font-family:var(--font-mono);font-weight:800;color:var(--ok)">${moneyShort(rowTotal)}</td></tr>`;
  });
  html+='<tr class="rtotalrow"><td>TOTAL</td>';
  wd.forEach(d=>{
    let dayTotal=0;S.chatters.forEach(c=>S.models.forEach(m=>{dayTotal+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(d)}`])||0;}));
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
    S.chatters.forEach(c=>{
      const rev=parseFloat(S.revenues[`${c.id}_${m.id}_${dateKey}`])||0;
      if(rev>0)chatterIds.push(c.id);
    });
    const uniqueIds=[...new Set(chatterIds)];
    if(!uniqueIds.length)return;

    const chattersData=uniqueIds.map(cid=>{
      const c=S.chatters.find(ch=>ch.id===cid);
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
            <input type="number" class="finput" style="width:90px;text-align:right;padding:5px 8px;font-size:13px;font-family:var(--font-mono)"
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
  let t=0;
  getWeekDates().forEach(d=>S.chatters.forEach(c=>S.models.forEach(m=>{t+=parseFloat(S.revenues[`${c.id}_${m.id}_${fmt(d)}`])||0;})));
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
  return (S.horaExtraSlots[wkey]||[]).filter(x=>x.shiftId==='parsed'&&x.chatterId===chatterId).reduce((s,x)=>s+(parseFloat(x.revenue)||0),0);
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
          <input type="number" class="finput" style="width:90px;text-align:right;padding:5px 8px;font-size:12.5px" value="${target||''}" placeholder="0"
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
  ['shift-chatter','abs-chatter','orient-chatter','ot-chatter'].forEach(id=>{
    const el=document.getElementById(id);if(!el)return;
    el.innerHTML=S.chatters.length?S.chatters.map(c=>`<option value="${c.id}">${c.name}</option>`).join(''):'<option value="">Nenhum chatter</option>';
  });
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
  S.chatters.push({id:'c'+Date.now(),name,discord:document.getElementById('ch-discord').value.trim(),level:document.getElementById('ch-level').value,notes:document.getElementById('ch-notes').value.trim(),watchtime:document.getElementById('ch-watchtime').value,createdAt:new Date().toISOString()});
  save();closeModal('m-chatter');['ch-name','ch-discord','ch-notes','ch-watchtime'].forEach(id=>document.getElementById(id).value='');
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
function renderTeamReports(){
  // Just ensure the input area is visible — processing happens on button click
}

function parseTeamReports(){parseTeamReportsCore(false);}
function parseTeamReportsAsExtra(){parseTeamReportsCore(true);}
function parseTeamReportsCore(forceExtra){
  const raw=document.getElementById('teamreport-input').value.trim();
  if(!raw){document.getElementById('teamreport-results').innerHTML='<div style="color:var(--text3);font-size:13px;padding:8px 0">Cole o conteúdo antes de processar</div>';return;}

  const lines=raw.split('\n').map(l=>l.trim()).filter(l=>l);
  const blocks=[];
  let current=null;

  lines.forEach(line=>{
    if(/^data:/i.test(line)){
      if(current)blocks.push(current);
      current={dateRaw:line.replace(/^data:\s*/i,'').trim(),name:'',modelBlocks:[],currentModel:null,rawSales:[]};
    } else if(/^nome:/i.test(line)&&current){
      current.name=line.replace(/^nome:\s*/i,'').trim();
    } else if(current){
      const isModelLine=/^[A-ZÁÉÍÓÚÀÂÊÎÔÛÃÕ\s0-9-]+$/.test(line)&&line.length>3&&!line.includes('R$')&&!/^\d/.test(line)&&line===line.toUpperCase();
      if(isModelLine){
        // If current model has NO sales/shift yet, it might be a continuation of the model name
        // e.g. "ARRUDA" then "PRIVACY FREE" = one model "ARRUDA PRIVACY FREE"
        if(current.currentModel&&!current.currentModel.sales.length&&!current.currentModel.shiftStart&&!current.currentModel.total){
          current.currentModel.name+=' '+line;
        } else {
          current.currentModel={name:line,sales:[],saleTimes:[]};
          current.modelBlocks.push(current.currentModel);
        }
      } else if(/total de comiss/i.test(line)&&current.currentModel){
        const m=line.match(/R\$\s*([\d.,]+)/);
        if(m)current.currentModel.total=parseFloat(m[1].replace('.','').replace(',','.'));
      } else if(current.currentModel){
        // Detect shift window: "23:21 às 07:02"
        const shiftMatch=line.match(/(\d{2}:\d{2})\s+às\s+(\d{2}:\d{2})/);
        if(shiftMatch&&!current.currentModel.shiftStart){
          current.currentModel.shiftStart=shiftMatch[1];
          current.currentModel.shiftEnd=shiftMatch[2];
        }
        // Detect sale times: "HH:MM -" (R$ value may be on same OR next line in real reports)
        // Shift times use "às" so they never match "HH:MM -"
        const saleTimePattern=/(\d{2}:\d{2})\s*-/g;
        let st;
        while((st=saleTimePattern.exec(line))!==null){
          current.currentModel.saleTimes.push(st[1]);
        }
        const valMatches=line.match(/R\$\s*([\d.,]+)/g);
        if(valMatches){
          valMatches.forEach(v=>{
            const val=parseFloat(v.replace('R$','').trim().replace(/\./g,'').replace(',','.'));
            if(val>0){current.currentModel.sales.push(val);current.rawSales.push({val,time:null});}
          });
        }
      }
    }
  });
  if(current)blocks.push(current);

  if(!blocks.length){
    document.getElementById('teamreport-results').innerHTML='<div style="color:var(--warn);font-size:13px;padding:8px 0">⚠️ Nenhum relatório reconhecido. Verifique o formato.</div>';
    return;
  }

  const wkey=getWeekKey();
  const goals=S.chatterWeekGoals[wkey]||{};
  let exportLines=['📊 RELATÓRIOS DA EQUIPE — '+wkey,''];
  let totalEquipe=0;

  const resultsHtml=blocks.map(block=>{
    const chatter=S.chatters.find(c=>c.name.toLowerCase()===block.name.toLowerCase())||
      S.chatters.find(c=>block.name.toLowerCase().includes(c.name.toLowerCase().split(' ')[0]))||
      S.chatters.find(c=>c.name.toLowerCase().includes(block.name.toLowerCase().split(' ')[0]));

    let dateKey=todayKey();
    if(block.dateRaw){
      const parts=block.dateRaw.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      if(parts){
        const year=parts[3].length===2?'20'+parts[3]:parts[3];
        dateKey=`${year}-${parts[2].padStart(2,'0')}-${parts[1].padStart(2,'0')}`;
      }
    }

    let chatterTotal=0,extraTotal=0;
    const allSales=[];
    const modelResults=block.modelBlocks.map(mb=>{
      const total=mb.total||mb.sales.reduce((s,v)=>s+v,0);
      const isExtra=forceExtra||/hora extra/i.test(mb.name);
      if(isExtra)extraTotal+=total; else chatterTotal+=total;
      mb.sales.forEach((v,i)=>allSales.push({val:v,time:mb.saleTimes[i]||null,isExtra}));

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
          slot.revenue=total;
        } else {
          S.revenues[`${chatter.id}_${model.id}_${dateKey}`]=total;
        }
      }
      return{name:mb.name,total,model,matched:!!model,isExtra};
    });

    // ---- Analytics ----
    const normalSales=allSales.filter(s=>!s.isExtra);
    const ticketMedio=normalSales.length>0?chatterTotal/normalSales.length:0;
    const HIGH_TICKET_MIN=375; // limiar fixo — vendas a partir desse valor dão 8% de bônus diário
    const highTicketSales=normalSales.filter(s=>s.val>=HIGH_TICKET_MIN);
    const highTicketPct=normalSales.length>0?Math.round((highTicketSales.length/normalSales.length)*100):0;
    const highTicketTotal=highTicketSales.reduce((s,v)=>s+v.val,0); // valor exato em R$, não estimativa

    // Vendas por hora — use shift window from "HH:MM às HH:MM" in the report
    let shiftHours=0;
    block.modelBlocks.filter(mb=>!(/hora extra/i.test(mb.name))).forEach(mb=>{
      if(mb.shiftStart&&mb.shiftEnd){
        const[h1,m1]=mb.shiftStart.split(':').map(Number);
        const[h2,m2]=mb.shiftEnd.split(':').map(Number);
        let endMins=h2*60+m2,startMins=h1*60+m1;
        if(endMins<startMins)endMins+=24*60;
        shiftHours+=(endMins-startMins)/60;
      }
    });
    if(!shiftHours)shiftHours=8; // fallback if no shift window found
    const vendasPorHora=shiftHours>0?Math.round((chatterTotal/shiftHours)*100)/100:0; // R$/hora

    // Tempo máximo sem venda (gap between sale times)
    let maxGapMin=0;
    const saleTsAll=[];
    block.modelBlocks.filter(mb=>!(/hora extra/i.test(mb.name))).forEach(mb=>{
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
      a.weeklyData[dateKey]={ticketMedio,vendasPorHora,highTicketPct,highTicketTotal,maxGapMin,totalVendas:normalSales.length,chatterTotal,extraTotal,shiftHours,saleTimes:saleTsAll};
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
  safeRender(renderMetaProgress,'meta');
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
   GESTÃO — morning routine, problems, demands, training,
   evolutions, prize, motivational, requests, schedules
   =========================================================== */

// ---- ROTINA DA MANHÃ (repeats daily, same tasks) ----
function renderMorningRoutine(){
  const el=document.getElementById('morning-routine-list');
  if(!el)return;
  const today=todayKey();
  // Clone routine items with today's done state
  if(!S.morningRoutineDone[today])S.morningRoutineDone[today]=[];
  const doneIds=new Set(S.morningRoutineDone[today]);
  if(!S.morningRoutine.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Adicione itens da rotina abaixo</div>';return;}
  el.innerHTML=S.morningRoutine.map(item=>{
    const done=doneIds.has(item.id);
    return`<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">
      <button onclick="toggleRoutineItem('${item.id}')" style="width:22px;height:22px;border-radius:5px;border:2px solid ${done?'var(--ok)':'var(--line)'};background:${done?'var(--ok)':'transparent'};cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:12px">${done?'<span style="color:#fff">✓</span>':''}</button>
      <span style="flex:1;font-size:13.5px;${done?'text-decoration:line-through;color:var(--text3)':''}">${item.text}</span>
      <button onclick="removeMorningRoutineItem('${item.id}')" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:13px">✕</button>
    </div>`;
  }).join('');
}
function toggleRoutineItem(id){
  const today=todayKey();
  if(!S.morningRoutineDone[today])S.morningRoutineDone[today]=[];
  const idx=S.morningRoutineDone[today].indexOf(id);
  if(idx===-1)S.morningRoutineDone[today].push(id);else S.morningRoutineDone[today].splice(idx,1);
  save();renderMorningRoutine();
}
function addMorningRoutine(){
  const inp=document.getElementById('morning-routine-input');
  const text=inp?.value.trim();if(!text)return;
  S.morningRoutine.push({id:'mr'+Date.now(),text});
  inp.value='';save();renderMorningRoutine();
}
function removeMorningRoutineItem(id){
  S.morningRoutine=S.morningRoutine.filter(x=>x.id!==id);
  save();renderMorningRoutine();
}

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
function addProblem(){
  const inp=document.getElementById('problems-input');
  const text=inp?.value.trim();if(!text)return;
  if(!Array.isArray(S.problemsToday))S.problemsToday=[];
  S.problemsToday.push({id:'p'+Date.now(),text,done:false});
  inp.value='';save();renderGestao();
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
    return`<div style="background:var(--warn-soft);border-radius:10px;padding:12px;margin-bottom:8px;border-left:3px solid var(--warn)">
      <div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="toggleTrainingDetail('${t.id}')">
        <div>
          <div style="font-weight:700;font-size:14px">🎓 ${t.title}</div>
          <div style="font-size:11.5px;color:var(--text2)">${t.date}${currentDay?` · Dia ${currentDay}`:' · não iniciado'}</div>
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
function saveModelRequests(){
  const wkey=getWeekKey();
  const el=document.getElementById('model-requests-text');
  if(!el)return;
  S.modelRequests[wkey]=el.value||'';
  save();
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
  save();
  const basicoBtn=document.getElementById('dl-time-basico-'+chatterId);
  const eliteBtn=document.getElementById('dl-time-elite-'+chatterId);
  const testerBtn=document.getElementById('dl-time-tester-'+chatterId);
  if(basicoBtn){basicoBtn.style.borderColor=time==='basico'?'var(--info)':'var(--line)';basicoBtn.style.background=time==='basico'?'var(--info-soft)':'transparent';basicoBtn.style.color=time==='basico'?'var(--info)':'var(--text2)';}
  if(eliteBtn){eliteBtn.style.borderColor=time==='elite'?'var(--warn)':'var(--line)';eliteBtn.style.background=time==='elite'?'var(--warn-soft)':'transparent';eliteBtn.style.color=time==='elite'?'var(--warn)':'var(--text2)';}
  if(testerBtn){testerBtn.style.borderColor=time==='tester'?'var(--bad)':'var(--line)';testerBtn.style.background=time==='tester'?'var(--bad-soft)':'transparent';testerBtn.style.color=time==='tester'?'var(--bad)':'var(--text2)';}
  toast(`✅ ${c.name} → ${time==='elite'?'⭐ Elite':time==='tester'?'🧪 Novatos':'Time Base'}`);
  renderTeam(teamFilter);
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
    const sun=new Date(d);sun.setDate(d.getDate()-d.getDay());
    const wk=fmt(sun);
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

  el.innerHTML=`
    <div style="background:var(--bg-soft);border-radius:12px;padding:14px;margin-bottom:12px">
      <div style="font-weight:800;font-size:16px;margin-bottom:4px">${c.name}</div>
      <div style="font-size:12px;color:var(--text3)">${c.level} · desde ${c.createdAt?c.createdAt.slice(0,10):'?'}</div>
    </div>

    <div class="panel">
      <div class="panel-head"><div class="panel-title">⚡ Técnica</div></div>
      ${txtField('conversao','Conversão','tech','Como está a conversão? Pontos fortes e fracos...')}
      ${txtField('ticket','Ticket médio','tech','Observações sobre ticket e high ticket...')}
      ${txtField('resposta','Tempo de resposta','tech','Como está a agilidade nas respostas?')}
      ${txtField('evolucao','Evolução','tech','Como tem evoluído nas últimas semanas?')}
    </div>

    <div class="panel">
      <div class="panel-head"><div class="panel-title">🧠 Comportamento</div></div>
      ${txtField('intensidade','Intensidade','behavior','Como está o nível de dedicação?')}
      ${txtField('comunicacao','Comunicação','behavior','Como se comunica com a gestão?')}
      ${txtField('comprometimento','Comprometimento','behavior','É pontual? Cumpre metas e combinados?')}
      ${txtField('energia','Energia','behavior','Como está o nível de energia e motivação?')}
    </div>

    <div class="panel">
      <div class="panel-head"><div class="panel-title">🚀 Potencial e Risco</div></div>
      ${txtField('potencial','Pontos fortes e potencial','potential','O que essa pessoa tem de melhor? Onde pode chegar?')}
      ${txtField('riscos','Pontos de atenção e riscos','risk','O que precisa melhorar? Quais riscos observados?')}
      ${txtField('proximos','Próximos passos','potential','O que vou trabalhar com essa pessoa?')}
    </div>

    <div class="panel">
      <div class="panel-head"><div class="panel-title">📝 Observações gerais</div></div>
      ${txtField('obs','Anotações livres','obs','Qualquer coisa relevante sobre esse chatter...')}
    </div>

    <button class="btn btn-primary btn-block" style="margin-bottom:12px" onclick="saveFichaSnapshot('${chatterId}')">💾 Salvar snapshot semanal</button>

    ${Object.keys(f.analytics?.weeklyData||{}).length?`
    <div class="panel">
      <div class="panel-head"><div class="panel-title">📊 Dados dos relatórios</div><div class="panel-note">Preenchido automaticamente</div></div>
      ${Object.entries(f.analytics.weeklyData).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,7).map(([date,a])=>`
        <div style="padding:8px 0;border-bottom:1px solid var(--line)">
          <div style="font-size:11px;font-weight:700;color:var(--text3);margin-bottom:5px">${date}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px">
            <div style="text-align:center;background:var(--bg-soft);border-radius:6px;padding:5px">
              <div style="font-size:9px;color:var(--text3)">Faturamento</div>
              <div style="font-size:12px;font-weight:700;font-family:var(--font-mono)">${moneyShort(a.chatterTotal||0)}</div>
            </div>
            <div style="text-align:center;background:var(--bg-soft);border-radius:6px;padding:5px">
              <div style="font-size:9px;color:var(--text3)">Ticket médio</div>
              <div style="font-size:12px;font-weight:700;font-family:var(--font-mono)">${moneyShort(a.ticketMedio||0)}</div>
            </div>
            <div style="text-align:center;background:var(--bg-soft);border-radius:6px;padding:5px">
              <div style="font-size:9px;color:var(--text3)">Valor/hora</div>
              <div style="font-size:12px;font-weight:700;color:${(a.vendasPorHora||0)>=20?'var(--ok)':(a.vendasPorHora||0)>=10?'var(--warn)':'var(--bad)'}">${a.vendasPorHora||0}</div>
            </div>
          </div>
        </div>`).join('')}
    </div>`:``}

    ${history.length?`
    <div class="panel">
      <div class="panel-head"><div class="panel-title">📜 Histórico</div></div>
      ${[...history].reverse().slice(0,5).map(snap=>`
        <div style="padding:10px 0;border-bottom:1px solid var(--line)">
          <div style="font-weight:700;font-size:12px;color:var(--text3);margin-bottom:6px">${snap.date}</div>
          ${Object.entries(snap).filter(([k])=>k!=='date').map(([k,v])=>v?`<div style="margin-bottom:4px"><span style="font-size:10.5px;font-weight:700;color:var(--text3)">${k.toUpperCase()}</span><div style="font-size:12.5px;color:var(--text2)">${v}</div></div>`:'').join('')}
        </div>`).join('')}
    </div>`:''}

    ${renderFichaCruzamento(chatterId)}
  `;
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
              <input type="number" class="finput" style="font-family:var(--font-mono)" value="${slot.revenue||''}" placeholder="0"
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
function deleteOrientation(id){S.orientations=S.orientations.filter(o=>o.id!==id);save();renderOrientList();toast('Removida');}
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
function getChatterWeekHighTicket(chatterId,offset){
  const f=S.chatterFichas[chatterId];
  const analytics=f?.analytics?.weeklyData||{};
  const wd=getWeekDates(offset);
  let htPctSum=0,days=0,htTotal=0;
  wd.forEach(d=>{
    const dk=fmt(d);
    const a=analytics[dk];
    if(a&&a.ticketMedio>0){
      htPctSum+=a.highTicketPct||0;days++;
      htTotal+=a.highTicketTotal!=null?a.highTicketTotal:0;
    }
  });
  const avgHtPct=days>0?htPctSum/days:0;
  return{avgHtPct:Math.round(avgHtPct),htTotal};
}
// Medalha automática — baseada no % da meta semanal batida (mesmos degraus do prêmio)
function autoMedalForPct(pct){
  if(pct>=130)return 4; // 💎 Diamante
  if(pct>=100)return 3; // 🥇 Ouro
  if(pct>=85)return 2;  // 🥈 Prata
  if(pct>=70)return 1;  // 🥉 Bronze
  return 0;             // Sem medalha
}
function getChatterWeekRevenue(id,offset){
  let t=0;getWeekDates(offset).forEach(d=>S.models.forEach(m=>{t+=parseFloat(S.revenues[`${id}_${m.id}_${fmt(d)}`])||0;}));
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
load();
initFirebaseWithRetry();
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
    const overdue=item.date&&item.date<today;
    const near=item.date&&!overdue&&isWithin48h(item.date);
    return`<div style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">
      <button onclick="toggleDemanda2('${item.id}')" style="width:22px;height:22px;border-radius:5px;border:2px solid ${item.done?'var(--ok)':'var(--line)'};background:${item.done?'var(--ok)':'transparent'};cursor:pointer;flex-shrink:0;margin-top:2px;display:flex;align-items:center;justify-content:center">${item.done?'<span style="color:#fff;font-size:11px">✓</span>':''}</button>
      <div style="flex:1">
        <div style="font-size:13.5px;${item.done?'text-decoration:line-through;color:var(--text3)':''}">${item.text}</div>
        ${item.date?`<div style="font-size:11px;color:${overdue?'var(--bad)':near?'var(--warn)':'var(--text3)'};margin-top:2px">${overdue?'⚠️ vencida':'📅'} ${item.date}</div>`:''}
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
  const date=document.getElementById('demandas2-date')?.value||'';
  if(!text)return;
  if(!Array.isArray(S.demandas2))S.demandas2=[];
  S.demandas2.push({id:'d2'+Date.now(),text,date,done:false});
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

/* ===========================================================
   MOTIVACIONAL HOME
   =========================================================== */
function renderMotivacionalHome(){
  const el=document.getElementById('home-motiv-content');
  if(!el)return;
  const wkey=getWeekKey();
  const data=S.motivacionalHome[wkey]||{};
  if(!data.idea){
    el.innerHTML=`<div style="color:var(--text3);font-size:13px">Nenhuma ideia motivacional esta semana.<br><button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="navTo('gestao')">Adicionar na Gestão →</button></div>`;
    return;
  }
  el.innerHTML=`<div style="font-size:14px;line-height:1.6;color:var(--text)">${data.idea}</div>
    ${data.results?`<div style="margin-top:8px;font-size:12px;color:var(--text2);border-top:1px solid var(--line);padding-top:8px"><strong>Resultado:</strong> ${data.results}</div>`:''}`;
}
function openMotivacionalHome(){navTo('gestao');}
function saveMotivacionalGestao(){
  const wkey=getWeekKey();
  if(!S.motivacionalHome[wkey])S.motivacionalHome[wkey]={};
  S.motivacionalHome[wkey].idea=document.getElementById('motiv-idea-gestao')?.value||'';
  S.motivacionalHome[wkey].results=document.getElementById('motiv-results-gestao')?.value||'';
  save();renderMotivacionalHome();
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
   MODEL REQUESTS SPLIT
   =========================================================== */
function renderModelRequestsSplit(){
  const el=document.getElementById('model-requests-split-list');
  if(!el)return;
  const wkey=getWeekKey();
  if(!S.modelRequestsSplit)S.modelRequestsSplit={};
  if(!S.modelRequestsSplit[wkey])S.modelRequestsSplit[wkey]={};
  if(!S.models.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Cadastre modelos primeiro</div>';return;}
  el.innerHTML=S.models.map(m=>`
    <div style="margin-bottom:12px">
      <label class="flabel">${m.emoji||'🧩'} ${m.name}</label>
      <textarea class="ftext" id="mr-split-${m.id}" style="min-height:60px" placeholder="Requisições para ${m.name}..." onblur="saveModelRequestSplit('${m.id}')">${S.modelRequestsSplit[wkey][m.id]||''}</textarea>
    </div>`).join('');
}
function saveModelRequestSplit(modelId){
  const wkey=getWeekKey();
  if(!S.modelRequestsSplit)S.modelRequestsSplit={};
  if(!S.modelRequestsSplit[wkey])S.modelRequestsSplit[wkey]={};
  S.modelRequestsSplit[wkey][modelId]=document.getElementById('mr-split-'+modelId)?.value||'';
  save();
}

/* ===========================================================
   CHAT ANALYSIS — daily per chatter, feeds ficha
   =========================================================== */
const CHAT_METRICS=['conexao','conducao','engajamento','conversao','resposta','naturalidade'];
const CHAT_METRIC_LABELS={conexao:'Conexão',conducao:'Condução',engajamento:'Engajamento',conversao:'Conversão',resposta:'Resposta',naturalidade:'Naturalidade'};
const SCORE_WORD={1:'Fraco',2:'Regular',3:'Bom',4:'Ótimo',5:'Excelente'};

function openChatAnalysis(){
  if(!S.chatters.length){toast('⚠️ Cadastre chatters primeiro');return;}
  const sel=document.getElementById('ca-chatter');
  if(sel){
    sel.innerHTML='<option value="">— selecionar chatter —</option>'+
      S.chatters.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
    sel.value='';
  }
  CHAT_METRICS.forEach(m=>{const el=document.getElementById('ca-'+m);if(el)el.value='';});
  const f=document.getElementById('ca-fortes');const fr=document.getElementById('ca-fracos');
  if(f)f.value='';if(fr)fr.value='';
  openModal('m-chat-analysis');
}
function saveChatAnalysis(){
  const chatterId=document.getElementById('ca-chatter')?.value;
  if(!chatterId){toast('⚠️ Selecione um chatter primeiro');return;}
  const analysis={id:'ca'+Date.now(),chatterId,date:todayKey(),
    fortes:document.getElementById('ca-fortes')?.value||'',
    fracos:document.getElementById('ca-fracos')?.value||''};
  let hasScore=false;
  CHAT_METRICS.forEach(m=>{
    const v=parseInt(document.getElementById('ca-'+m)?.value)||0;
    analysis[m]=v;if(v>0)hasScore=true;
  });
  if(!hasScore&&!analysis.fortes&&!analysis.fracos){toast('⚠️ Preencha pelo menos um campo');return;}
  if(!S.chatAnalyses)S.chatAnalyses={};
  const today=todayKey();
  if(!S.chatAnalyses[today])S.chatAnalyses[today]=[];
  S.chatAnalyses[today].push(analysis);
  updateFichaFromAnalysis(chatterId);
  save();
  closeModal('m-chat-analysis');
  const selEl=document.getElementById('chat-analysis-chatter');
  if(selEl){
    selEl.innerHTML='<option value="">— selecionar chatter —</option>'+S.chatters.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
    selEl.value=chatterId;
  }
  renderChatAnalysisList();
  toast('✅ Análise salva!');
}

function updateFichaFromAnalysis(chatterId){
  if(!S.chatterFichas[chatterId])S.chatterFichas[chatterId]={tech:{},behavior:{},potential:{},risk:{},history:[]};
  const f=S.chatterFichas[chatterId];
  // Collect all analyses for this chatter
  const allAnalyses=[];
  Object.values(S.chatAnalyses||{}).forEach(dayArr=>{
    (dayArr||[]).filter(a=>a.chatterId===chatterId).forEach(a=>allAnalyses.push(a));
  });
  if(!allAnalyses.length)return;
  const avg=key=>Math.round(allAnalyses.reduce((s,a)=>s+(a[key]||0),0)/allAnalyses.length);
  // Map to ficha fields
  const scores={conversao:avg('conversao'),resposta:avg('resposta'),evolucao:avg('engajamento')};
  Object.entries(scores).forEach(([k,v])=>{if(v>0)f.tech[k]=SCORE_WORD[v]||String(v);});
  const behavScores={intensidade:avg('conexao'),comunicacao:avg('conducao'),energia:avg('naturalidade')};
  Object.entries(behavScores).forEach(([k,v])=>{if(v>0)f.behavior[k]=SCORE_WORD[v]||String(v);});
}
function renderChatAnalysisList(){
  const el=document.getElementById('chat-analysis-list');
  const sel=document.getElementById('chat-analysis-chatter');
  if(!el)return;
  // Always repopulate select
  if(sel){
    const cur=sel.value;
    sel.innerHTML='<option value="">— selecionar chatter —</option>'+S.chatters.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
    if(cur)sel.value=cur;
  }
  const chatterId=sel?.value;
  if(!chatterId){el.innerHTML='<div style="color:var(--text3);font-size:12.5px;padding:8px 0">Selecione um chatter para ver as análises</div>';return;}
  const analyses=[];
  Object.entries(S.chatAnalyses||{}).forEach(([date,arr])=>{
    (arr||[]).filter(a=>a.chatterId===chatterId).forEach(a=>analyses.push({...a,date}));
  });
  analyses.sort((a,b)=>b.date.localeCompare(a.date));
  if(!analyses.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px;padding:8px 0">Nenhuma análise para este chatter ainda</div>';return;}
  el.innerHTML=analyses.slice(0,10).map(a=>`
    <div style="background:var(--bg-soft);border-radius:9px;padding:10px;margin-bottom:8px">
      <div style="font-size:11px;font-weight:700;color:var(--text3);margin-bottom:7px">${a.date}</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:8px">
        ${CHAT_METRICS.map(m=>`<div style="text-align:center;background:var(--bg);border-radius:7px;padding:5px 3px">
          <div style="font-size:9px;color:var(--text3)">${CHAT_METRIC_LABELS[m]}</div>
          <div style="font-size:13px;font-weight:800;color:${(a[m]||0)>=4?'var(--ok)':(a[m]||0)>=3?'var(--warn)':'var(--bad)'}">${SCORE_WORD[a[m]]||'—'}</div>
        </div>`).join('')}
      </div>
      ${a.fortes?`<div style="font-size:12px;margin-bottom:4px"><strong style="color:var(--ok)">✅</strong> ${a.fortes}</div>`:''}
      ${a.fracos?`<div style="font-size:12px"><strong style="color:var(--warn)">⚠️</strong> ${a.fracos}</div>`:''}
    </div>`).join('');
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
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester');
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
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester');
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

function renderEvolucao(){
  renderWeekNav();
  const el=document.getElementById('evolucao-content');
  if(!el)return;
  const wkey=getWeekKey();
  const wd=getWeekDates();
  let html='';

  if(!S.chatters.length){
    el.innerHTML='<div style="color:var(--text3);font-size:13px;padding:12px 0">Cadastre chatters na aba Equipe</div>';
    return;
  }

  html+=`<div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px">Relatório individual por chatter</div>`;

  const goals=S.chatterWeekGoals[wkey]||{};
  let teamTotal=0, teamDays=0, teamTicketSum=0, teamVphSum=0, teamHighSum=0;

  S.chatters.filter(c=>c.time!=='tester').forEach(c=>{
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
    // Cruza com a ficha e o diagnóstico do ChatLab pra não depender só de números
    getFichaAndDiagnosisInsights(c.id).forEach(ins=>recs.push(ins));

    const timeLabel=c.time==='elite'?'<span class="pill pill-warn" style="font-size:9px">⭐ Elite</span>':c.time==='tester'?'<span class="pill pill-bad" style="font-size:9px">🧪 Novatos</span>':'';

    html+=`<div class="panel" style="margin-bottom:10px;border-left:3px solid ${pct===null?'var(--line)':pct>=80?'var(--ok)':pct>=50?'var(--warn)':'var(--bad)'}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:6px">
          <div style="font-weight:800;font-size:15px">${c.name}</div>${timeLabel}
          <span class="pill pill-flat" style="font-size:9px">${c.level}</span>
        </div>
        <div style="text-align:right">
          <div style="font-family:var(--font-mono);font-weight:800;font-size:15px;color:var(--ok)">${money(rev)}</div>
          ${meta>0?`<div style="font-size:11px;color:var(--text3)">${pct}% da meta</div>`:''}
        </div>
      </div>
      ${meta>0?`<div style="background:var(--line);border-radius:4px;height:5px;overflow:hidden;margin-bottom:10px">
        <div style="height:5px;border-radius:4px;background:${pct>=100?'var(--ok)':pct>=60?'var(--warn)':'var(--bad)'};width:${Math.min(100,pct||0)}%"></div>
      </div>`:''}
      ${days>0?`<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px">
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
          <div style="font-size:9px;color:var(--text3)">High ticket ≥R$375</div>
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
      </div>
    </div>`;
  });

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
  S.shifts=S.shifts.filter(s=>s.id!==shiftId);
  save();renderTurno();toast('Turno removido');
}

/* ===========================================================
   FATURAMENTO — meta progress + chatter analysis
   =========================================================== */
function renderMetaProgress(){
  const el=document.getElementById('fat-meta-progress');
  if(!el)return;
  const wkey=getWeekKey();
  const goals=S.chatterWeekGoals[wkey]||{};
  const ativos=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester');
  if(!ativos.length){el.innerHTML='';return;}
  el.innerHTML=`<div style="margin-bottom:4px;font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.05em">Metas da semana</div>`+
  ativos.map(c=>{
    const meta=parseFloat(goals[c.id])||0;
    const rev=getChatterWeekRevenue(c.id);
    const extra=getChatterExtraRevenue(c.id);
    const pct=meta>0?Math.min(100,Math.round((rev/meta)*100)):0;
    const falta=meta>0?Math.max(0,meta-rev):0;
    return`<div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <div style="font-weight:600;font-size:13px">${c.name}</div>
        <div style="font-size:12px;font-family:var(--font-mono)">${moneyShort(rev)}${meta>0?` / ${moneyShort(meta)}`:''}</div>
      </div>
      ${meta>0?`<div style="background:var(--line);border-radius:4px;height:8px;overflow:hidden;margin-bottom:3px">
        <div style="height:8px;border-radius:4px;background:${pct>=100?'var(--ok)':pct>=60?'var(--warn)':'var(--bad)'};width:${pct}%;transition:width .3s"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text3)">
        <span>${pct}%${extra>0?` · +${moneyShort(extra)} extra`:''}</span>
        ${falta>0?`<span style="color:var(--bad)">falta ${moneyShort(falta)}</span>`:`<span style="color:var(--ok)">✅ meta batida!</span>`}
      </div>`:`<div style="font-size:11px;color:var(--text3)">Sem meta definida${extra>0?` · extra: ${moneyShort(extra)}`:''}</div>`}
    </div>`;
  }).join('');
}

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
    S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester').forEach(c=>{
      const hasRev=S.models.some(m=>(parseFloat(S.revenues[`${c.id}_${m.id}_${dk}`])||0)>0);
      const justKey='just_'+c.id+'_'+dk;
      const hasJust=S.justificativas&&S.justificativas[justKey];
      if(!hasRev&&!hasJust)missing.push({name:c.name,id:c.id,date:dk});
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
  renderMorningRoutine();
  renderDailyList('problemsToday','problems-list','problems-badge');
  renderDemandas2();
  renderTrainings();
  renderPrizePanel();
  const wkey=getWeekKey();
  const motiv=S.motivacionalHome[wkey]||{};
  const ideaEl=document.getElementById('motiv-idea-gestao');
  const resEl=document.getElementById('motiv-results-gestao');
  if(ideaEl&&!ideaEl.value)ideaEl.value=motiv.idea||'';
  if(resEl&&!resEl.value)resEl.value=motiv.results||'';
  renderModelRequestsSplit();
  renderScheduleRequests();
  const sel=document.getElementById('sched-req-chatter');
  if(sel&&!sel.options.length)sel.innerHTML=S.chatters.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
  // Always populate chat analysis chatter select with full team list
  const casel=document.getElementById('chat-analysis-chatter');
  if(casel){
    const prev=casel.value;
    casel.innerHTML='<option value="">— selecionar chatter —</option>'+S.chatters.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
    if(prev)casel.value=prev;
  }
  renderChatAnalysisList();
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
  renderTurnoWeek();
  if(turnoEditMode)toast('Modo edição ativo — ✏️ editar ou ✕ remover');
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
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester');
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
        ${c?`<div style="font-size:10.5px;color:var(--accent);margin-top:1px">👤 ${c.name}</div>`:''}
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
   =========================================================== */
function renderChatLab(){
  const sel=document.getElementById('cl-chatter');
  if(sel){
    const cur=sel.value;
    sel.innerHTML='<option value="">— selecionar —</option>'+S.chatters.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
    if(cur)sel.value=cur;
  }
  renderChatLabHistorico();
}
function renderChatLabHistorico(){
  const el=document.getElementById('cl-historico');
  if(!el)return;
  if(!S.chatlabAnalyses.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px">Nenhuma análise ainda</div>';return;}
  el.innerHTML=[...S.chatlabAnalyses].reverse().slice(0,15).map(a=>{
    const c=S.chatters.find(ch=>ch.id===a.chatterId);
    const col=a.igp>=70?'var(--ok)':a.igp>=50?'var(--warn)':a.igp?'var(--bad)':'var(--text3)';
    return`<div style="border:1px solid var(--line);border-radius:9px;margin-bottom:8px;overflow:hidden">
      <div style="padding:10px 13px;background:var(--bg-soft);display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="toggleClAn('${a.id}')">
        <div>
          <div style="font-size:13px;font-weight:700">${c?c.name:'?'}</div>
          <div style="font-size:11px;color:var(--text3)">${new Date(a.date).toLocaleDateString('pt-BR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:18px;font-weight:800;font-family:var(--font-mono);color:${col}">${a.igp||'—'}</span>
          <span style="font-size:10px;color:var(--text3)" id="cl-ic-${a.id}">▼</span>
        </div>
      </div>
      <div id="cl-body-${a.id}" style="display:none"><div class="cl-md" style="padding:16px">${clMd(a.raw||'')}</div></div>
    </div>`;
  }).join('');
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

  const prev=S.chatlabAnalyses.filter(a=>a.chatterId===cid);
  const system='Você é a Gerente Sênior de Performance de uma operação de vendas por chat. Analisa conversas de vendedores (chatters) e gera diagnósticos técnicos, precisos e acionáveis. Seja crítica, objetiva e didática. Nunca elogie sem evidência. Nunca critique sem ensinar. Toda nota deve ter justificativa baseada na conversa real.';
  const prompt=`Analise a conversa do chatter **${c.name}** (nível: ${c.level||'—'}).${ctx?'\nContexto: '+ctx:''}${prev.length?'\nAnálise nº '+(prev.length+1)+' — compare evolução quando relevante.':''}\n\n---\nCONVERSA:\n${conv}\n---\n\nGere análise em Markdown com: notas X/10 e evidências para Conexão Emocional, Conversão e Timing, Leitura de Sinais de Compra, Condução, Inteligência Emocional, Perfil do Lead, Qualificação, Inteligência Comercial, Criatividade, Gestão do Tempo e Retenção. Depois:\n\n## 🔴 Maiores Erros (graves → leves, com impacto)\n## 🟢 O Que Não Deve Mudar\n## 💬 Mensagens Desperdiçadas (reescreva 2-3)\n## 📋 Plano de Treinamento (3 prioridades: objetivo — como treinar — resultado)\n## 📊 Dashboard (tabela indicador × nota)\n**IGP: XX/100** (pesos: Conversão 20%, Conexão 15%, Condução 15%, Sinais 10%, Comercial 10%, demais 5% cada)\n## 🎯 Resumo Executivo\n- Ponto forte / Maior oportunidade / Erro crítico / Foco da semana / Parecer (Promoveria / Manteria com treinamento / Acompanhamento intensivo)`;

  try{
    const res=await fetch(AI_PROXY_URL,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:4000,system,messages:[{role:'user',content:prompt}]})
    });
    const data=await res.json();
    const text=data.content?.map(b=>b.type==='text'?b.text:'').join('')||'';
    if(!text)throw new Error(data.error?.message||'Resposta vazia da IA');
    const igpM=text.match(/IGP[^:]*:\s*\**\s*(\d+)/i);
    const igp=igpM?parseInt(igpM[1]):null;
    // Extract resumo executivo snippet for the Evolução diagnostic square
    const resumoM=text.match(/## 🎯 Resumo Executivo([\s\S]*?)(?=\n## |$)/i);
    const resumo=resumoM?resumoM[1].trim().slice(0,600):'';
    S.chatlabAnalyses.push({id:'cla'+Date.now(),chatterId:cid,date:new Date().toISOString(),igp,raw:text,resumo});
    save();
    const col=igp>=70?'var(--ok)':igp>=50?'var(--warn)':'var(--bad)';
    document.getElementById('cl-resultado').innerHTML=`<div class="panel" style="border-left:3px solid ${col}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-weight:700">${c.name} — análise concluída</div>
        ${igp?`<div style="font-size:24px;font-weight:800;font-family:var(--font-mono);color:${col}">${igp}<span style="font-size:11px;color:var(--text3)">/100</span></div>`:''}
      </div>
      <div class="cl-md">${clMd(text)}</div>
    </div>`;
    renderChatLabHistorico();
    toast('✅ Análise salva — aparece na Evolução');
  }catch(err){
    document.getElementById('cl-resultado').innerHTML=`<div class="panel" style="border-color:var(--bad)"><div style="color:var(--bad);font-size:13px">❌ ${err.message}</div><div style="font-size:12px;color:var(--text3);margin-top:5px">Verifique a conexão e tente novamente.</div></div>`;
  }finally{
    btn.disabled=false;btn.textContent='⚡ Analisar';
  }
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
function gerAddChatterMeu(){
  S.geradorMeu.push({name:'',model:S.models[0]?.name.toUpperCase()||'',intervals:[]});
  save();renderGerMeuCards();
}
function gerAddMeu(){
  gerAddChatterMeu();
}

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

function renderGerMeuCards(){
  const el=document.getElementById('ger-meu-cards');
  if(!el)return;
  const list=S.geradorMeu||[];
  if(!list.length){el.innerHTML='<div style="color:var(--text3);font-size:12.5px;padding:4px 0">Clique em + chatter para adicionar</div>';return;}
  el.innerHTML=list.map((c,ci)=>`
    <div style="background:var(--bg-soft);border-radius:10px;padding:12px;margin-bottom:10px">
      <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">
        <input class="finput" style="flex:2" placeholder="Nome" value="${c.name||''}" list="ger-namelist"
          onblur="S.geradorMeu[${ci}].name=this.value;save();">
        <select class="fselect" style="flex:1"
          onchange="S.geradorMeu[${ci}].model=this.value;save();">
          ${S.models.map(m=>`<option value="${m.name.toUpperCase()}" ${(c.model||'')===(m.name.toUpperCase())?'selected':''}>${m.name}</option>`).join('')}
        </select>
        <button onclick="S.geradorMeu.splice(${ci},1);save();renderGerMeuCards();"
          style="background:none;border:none;color:var(--bad);cursor:pointer;font-size:16px;flex-shrink:0">✕</button>
      </div>
      <div style="font-size:11px;font-weight:600;color:var(--text3);margin-bottom:4px">📋 Entradas/saídas do Discord</div>
      <textarea class="ftext" style="min-height:80px;font-size:12px;font-family:var(--font-mono)"
        placeholder="Cole aqui as entradas/saídas do Discord para ${c.name||'este chatter'}&#10;Ex:&#10;Guilherme — Ontem às 23:00&#10;ON (Momoi)&#10;Guilherme — Ontem às 07:02&#10;OFF (Momoi)"
        onblur="S.geradorMeu[${ci}].discordRaw=this.value;save();">${c.discordRaw||''}</textarea>
      <button class="btn btn-ghost btn-xs" style="margin-top:6px" onclick="gerInterpretarDiscord(${ci})">🔄 Interpretar entradas</button>
      ${(c.intervals&&c.intervals.length)?`<div style="margin-top:8px">`+c.intervals.map((iv,ii)=>`
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:5px">
          <input class="finput" style="width:82px;font-family:var(--font-mono)" placeholder="início" value="${iv.s||''}"
            onblur="S.geradorMeu[${ci}].intervals[${ii}].s=this.value;save();">
          <span style="color:var(--text3);font-size:12px">às</span>
          <input class="finput" style="width:82px;font-family:var(--font-mono)" placeholder="fim" value="${iv.e||''}"
            onblur="S.geradorMeu[${ci}].intervals[${ii}].e=this.value;save();">
          <label style="display:flex;align-items:center;gap:4px;font-size:11.5px;color:var(--text2);cursor:pointer;flex-shrink:0">
            <input type="checkbox" style="width:auto" ${iv.extra?'checked':''}
              onchange="S.geradorMeu[${ci}].intervals[${ii}].extra=this.checked;save();">⚡extra
          </label>
          <button onclick="S.geradorMeu[${ci}].intervals.splice(${ii},1);save();renderGerMeuCards();"
            style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:13px">✕</button>
        </div>`).join('')+`
        <button class="btn btn-ghost btn-xs" onclick="S.geradorMeu[${ci}].intervals.push({s:'',e:'',extra:false});save();renderGerMeuCards();">+ intervalo</button>
        </div>`:
        '<div style="font-size:11.5px;color:var(--text3);margin-top:6px">Cole o Discord acima e clique Interpretar — ou adicione os horários manualmente</div>'}
    </div>`).join('')+`<datalist id="ger-namelist">${S.chatters.map(c=>`<option value="${c.name}">`).join('')}</datalist>`;
}

function gerInterpretarDiscord(ci){
  const c=S.geradorMeu[ci];
  if(!c||!c.discordRaw?.trim()){toast('⚠️ Cole o texto do Discord primeiro');return;}
  const parsed=gerParseDiscord(c.discordRaw);
  // Merge intervals (keep existing manual entries)
  if(parsed.length){
    c.intervals=parsed;
    save();renderGerMeuCards();
    toast('✅ '+parsed.length+' intervalo(s) interpretado(s)');
  } else {
    toast('⚠️ Não encontrei entradas/saídas no texto');
  }
}

function gerParseDiscord(txt){
  const lines=txt.split('\n').map(l=>l.trim()).filter(Boolean);
  const events=[];
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    const next=lines[i+1]||'';
    const timeM=line.match(/(\d{1,2}:\d{2})/);
    if(!timeM)continue;
    const time=timeM[1].padStart(5,'0');
    const onOffLine=(/\bON\b/i.test(next)||/\bOFF\b/i.test(next))?next:line;
    const isOn=/\bON\b/i.test(onOffLine);
    const isOff=/\bOFF\b/i.test(onOffLine);
    const extra=/hora\s*extra|extra/i.test(onOffLine);
    if(isOn||isOff) events.push({time,isOn,isOff,extra});
  }
  const intervals=[];
  let pending=null;
  for(const e of events){
    if(e.isOn){
      pending={s:e.time,e:'',extra:e.extra};
    } else if(e.isOff&&pending){
      pending.e=e.time;
      intervals.push(pending);
      pending=null;
    }
  }
  if(pending)intervals.push(pending); // open-ended
  return intervals;
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
  renderMelhoras();
  renderStudyList();
  renderEstudosHistorico();
}

/* ===========================================================
   CONSELHEIRO EXECUTIVO (IA discreta)
   =========================================================== */
function toggleConselheiro(){
  const body=document.getElementById('conselheiro-body');
  const ic=document.getElementById('conselheiro-ic');
  if(!body)return;
  const open=body.style.display!=='none';
  body.style.display=open?'none':'block';
  if(ic)ic.textContent=open?'▸':'▾';
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
    const res=await fetch(AI_PROXY_URL,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:2000,
        system:CONSELHEIRO_SYSTEM,
        messages:[{role:'user',content:text}]
      })
    });
    const data=await res.json();
    const reply=data.content?.map(b=>b.type==='text'?b.text:'').join('')||'';
    if(!reply)throw new Error(data.error?.message||'Resposta vazia');
    out.innerHTML=`<div style="border-top:1px solid var(--line);padding-top:12px;margin-top:4px">${clMd(reply)}</div>`;
  }catch(err){
    out.innerHTML=`<div style="color:var(--bad);font-size:12.5px">❌ ${err.message}</div>`;
  }finally{
    btn.disabled=false;btn.textContent='💬 Consultar';
  }
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
function setTesterDecision(chatterId,decision){
  const c=S.chatters.find(ch=>ch.id===chatterId);
  if(!c)return;
  if(!S.chatterFichas[chatterId])S.chatterFichas[chatterId]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
  S.chatterFichas[chatterId].testerDecision=decision;
  S.chatterFichas[chatterId].testerDecisionDate=todayKey();
  if(decision==='aprovado'){
    c.time='basico'; // vira time normal — mas continua contando na lista de histórico de decisões
    if(c.level==='teste'||c.level==='treinamento')c.level='junior'; // promove o nível também, senão fica filtrado de fora em quadros que checam nível separado do cargo
    c.testerApprovalDate=todayKey(); // a partir dessa data os relatórios entram nas análises (Evolução etc)
    toast(`✅ ${c.name} aprovado! Já passou pro Time Base e entra em todas as análises de desenvolvimento a partir de hoje.`);
  } else if(decision==='reprovado'){
    toast(`${c.name} marcado como reprovado.`);
  } else {
    toast(`${c.name} colocado em espera.`);
  }
  save();
  renderTesters();
}
function renderTesters(){
  const sel=document.getElementById('tester-select');
  // Pool: quem está marcado Novatos AGORA, + quem já teve alguma decisão registrada (mantém histórico mesmo após aprovar)
  const testers=S.chatters.filter(c=>c.time==='tester'||S.chatterFichas?.[c.id]?.testerDecision);
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
    el.innerHTML=`<div class="empty"><div class="empty-ic">🧪</div><div class="empty-ttl">Sem novatos em teste</div><div class="empty-sub">Vá em Equipe e marque chatters como 🧪 Novatos</div></div>`;
    return;
  }

  const decided=testers.filter(c=>['aprovado','reprovado'].includes(S.chatterFichas?.[c.id]?.testerDecision));
  const pending=testers.filter(c=>!decided.includes(c));

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
    const labels={aprovado:'✅ Aprovado',espera:'⏳ Espera',reprovado:'❌ Reprovado'};
    const colors={aprovado:'var(--ok)',espera:'var(--warn)',reprovado:'var(--bad)'};
    const bgs={aprovado:'var(--ok-soft)',espera:'var(--warn-soft)',reprovado:'var(--bad-soft)'};
    const sel2=current===op;
    return`<button onclick="event.stopPropagation();setTesterDecision('${c.id}','${op}')"
      style="flex:1;padding:7px 4px;border-radius:8px;border:2px solid ${sel2?colors[op]:'var(--line)'};background:${sel2?bgs[op]:'var(--bg)'};cursor:pointer;font-family:var(--font-display);font-weight:700;font-size:11px;color:${sel2?colors[op]:'var(--text2)'}">${labels[op]}</button>`;
  }).join('');

  el.innerHTML=`
    <div style="background:var(--bg-soft);border-radius:10px;padding:12px;margin-bottom:14px;font-size:12.5px;color:var(--text2)">
      📊 <strong>${pending.length} em avaliação</strong> — classificados do melhor pro pior pelo resultado dos 3 dias de teste. Os 3 primeiros ficam sempre em destaque como fila de espera.
    </div>
    ${scored.map((item,idx)=>{
      const {c,rev,analysis,decision}=item;
      const isTop3=idx<3;
      const color=isTop3?'var(--ok)':idx<scored.length-Math.max(1,Math.floor(scored.length/3))?'var(--warn)':'var(--bad)';
      const daysLabel=analysis.testDays.length?analysis.testDays.map(td=>dayName(td.date)).join(', '):'sem dias de teste ainda';
      const workDays=getTesterAllWorkDays(c.id);
      const contractDate=c.createdAt?fmtBR(c.createdAt.slice(0,10)):'—';
      return`<div style="padding:12px;background:var(--surface);border:1px solid var(--line);border-left:3px solid ${color};border-radius:9px;margin-bottom:9px">
        <div style="display:flex;align-items:flex-start;gap:12px;cursor:pointer" onclick="document.getElementById('tester-select').value='${c.id}';renderTesterDetail('${c.id}')">
          <div style="font-size:20px;font-weight:800;font-family:var(--font-mono);color:${color};min-width:26px;flex-shrink:0">${isTop3?['🥇','🥈','🥉'][idx]:`${idx+1}º`}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:14px">${c.name} ${isTop3?'<span class="pill pill-ok" style="font-size:9px">🌟 fila</span>':''}</div>
            <div style="font-size:11.5px;color:var(--text2);margin-top:2px">Teste: ${daysLabel}${analysis.testDays.length?` · <strong style="color:${color}">${money(rev)}</strong> nos 3 dias`:''}</div>
            <div style="font-size:11px;color:var(--text3);margin-top:1px">${workDays.length} dia${workDays.length!==1?'s':''} de trabalho · contrato desde ${contractDate}</div>
          </div>
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
          return`<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;background:var(--bg-soft);border-radius:8px;margin-bottom:6px;font-size:12.5px">
            <div><strong>${c.name}</strong> <span style="color:${isAprov?'var(--ok)':'var(--bad)'}">${isAprov?'✅ aprovado':'❌ reprovado'}</span></div>
            <div style="color:var(--text3);font-size:11px">${f.testerDecisionDate?f.testerDecisionDate.split('-').reverse().join('/'):''}</div>
          </div>`;
        }).join('')}
      </div>`:''}
  `;
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
          <div style="font-size:9px;color:var(--text3)">High ticket ≥R$375</div>
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

  el.innerHTML=analysisPanel+`
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
        <div style="padding:12px 0;border-bottom:1px solid var(--line)">
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

// Tabela de metas semanais por categoria
const PAG_CATS={
  A:{n70:2500,p70:100, n85:3000,p85:120, n100:3500,p100:140},
  B:{n70:3500,p70:175, n85:4000,p85:210, n100:5000,p100:250},
  C:{n70:5000,p70:350, n85:6000,p85:425, n100:7000,p100:500},
  D:{n70:7000,p70:560, n85:8500,p85:680, n100:10000,p100:800},
  E:{n70:10000,p70:900,n85:12000,p85:1100,n100:14000,p100:1300},
};

// Comissão % por medalha
const PAG_COM={0:0.04,1:0.04,2:0.045,3:0.05,4:0.06};
const PAG_COM_LABEL={0:'4%',1:'4%',2:'4,5%',3:'5%',4:'6%'};
const PAG_PISO={0:1000,1:1200,2:1500,3:1800,4:2500};
const PAG_MEDAL_LABEL={0:'Sem medalha',1:'🥉 Bronze',2:'🥈 Prata',3:'🥇 Ouro',4:'💎 Diamante'};

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

function renderPagamento(){
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
  // Gerente chatters config
  renderGerChattersConfig();
  renderGerPreview();
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
function renderPagChattersAll(){
  const el=document.getElementById('pag-chatters-all');
  if(!el)return;
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester');
  if(!chatters.length){el.innerHTML='';return;}
  const wkey=getWeekKey(0); // Pagamento é sempre a semana atual, nunca segue a navegação de outras abas

  el.innerHTML=`<div class="panel">
    <div class="panel-head"><div class="panel-title">📋 Todos os chatters — semana atual</div><div class="panel-note">Faturamento, medalha, high ticket e "falta pra meta" são automáticos. Só escolha a categoria.</div></div>
    ${chatters.map(c=>{
      // Tudo automático a partir dos dados reais — sempre semana atual (offset 0)
      const weekRev=getChatterWeekRevenue(c.id,0);
      const weekExtra=getChatterExtraRevenue(c.id,0);
      const {avgHtPct,htTotal}=getChatterWeekHighTicket(c.id,0);
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
      const remainDays=getRemainingWorkDaysThisWeek(c.id);
      const faltaPorDia=falta>0&&remainDays>0?falta/remainDays:null;
      const medal=autoMedalForPct(pct);
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
          ${falta>0?`<div style="color:var(--bad);font-weight:700;font-size:12.5px">falta ${money(falta)}${faltaPorDia?` · <span style="color:var(--warn)">${money(faltaPorDia)}/dia</span> em ${remainDays} dia${remainDays>1?'s':''} de trabalho restante${remainDays>1?'s':''}`:remainDays===0?' · sem mais dias de trabalho essa semana':''}</div>`:`<div style="color:var(--ok);font-weight:700;font-size:12.5px">✅ meta batida!</div>`}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px">
          <div style="background:var(--bg);border-radius:7px;padding:7px;text-align:center">
            <div style="font-size:9px;color:var(--text3)">Faturamento (auto)</div>
            <div style="font-size:13px;font-weight:700;font-family:var(--font-mono)">${money(weekRev)}</div>
          </div>
          <div style="background:var(--bg);border-radius:7px;padding:7px;text-align:center">
            <div style="font-size:9px;color:var(--text3)">Medalha (auto)</div>
            <div style="font-size:12.5px;font-weight:700">${PAG_MEDAL_LABEL[medal]}</div>
          </div>
          <div class="field" style="margin:0">
            <label class="flabel">Categoria</label>
            <select class="fselect" style="font-size:12px;padding:6px 8px" id="pag-c-cat-${c.id}" onchange="saveChatterPagCategoria('${c.id}',this.value);renderPagChattersAll()">
              ${['A','B','C','D','E'].map(k=>`<option value="${k}" ${cat===k?'selected':''}>${k} — meta ${money(PAG_CATS[k].n100)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:6px">
          <div style="background:var(--bg);border-radius:7px;padding:7px;text-align:center">
            <div style="font-size:9px;color:var(--text3)">High ticket ≥R$375 (auto, ${avgHtPct}%)</div>
            <div style="font-size:13px;font-weight:700;font-family:var(--font-mono)">${money(htTotal)}</div>
          </div>
          <div style="background:var(--bg);border-radius:7px;padding:7px;text-align:center">
            <div style="font-size:9px;color:var(--text3)">Hora extra (auto)</div>
            <div style="font-size:13px;font-weight:700;font-family:var(--font-mono)">${money(weekExtra)}</div>
          </div>
        </div>
        <div id="pag-c-result-${c.id}" style="display:grid;grid-template-columns:repeat(4,1fr);gap:5px">
          ${renderChatterPagCells(r,pct,col)}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}
function saveChatterPagCategoria(cid,cat){
  if(!S.chatterFichas[cid])S.chatterFichas[cid]={tech:{},behavior:{},potential:{},risk:{},history:[],analytics:{}};
  S.chatterFichas[cid].pagCategoria=cat;
  save();
}

function renderChatterPagCells(r,pct,col){
  return`
    <div style="background:var(--bg);border-radius:7px;padding:7px;text-align:center">
      <div style="font-size:9px;color:var(--text3)">Comissão</div>
      <div style="font-size:12px;font-weight:700;font-family:var(--font-mono)">${money(r.comissao)}</div>
    </div>
    <div style="background:var(--bg);border-radius:7px;padding:7px;text-align:center">
      <div style="font-size:9px;color:var(--text3)">Prêmio meta</div>
      <div style="font-size:12px;font-weight:700;color:${r.premio>0?'var(--ok)':'var(--text3)'}">${money(r.premio)}</div>
    </div>
    <div style="background:var(--bg);border-radius:7px;padding:7px;text-align:center">
      <div style="font-size:9px;color:var(--text3)">% meta</div>
      <div style="font-size:12px;font-weight:800;color:${col}">${pct}%</div>
    </div>
    <div style="background:var(--ok-soft);border-radius:7px;padding:7px;text-align:center">
      <div style="font-size:9px;color:var(--text3)">Total (real)</div>
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
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester');
  let total=0;
  for(let d=1;d<=today.getDate();d++){
    const key=fmt(new Date(year,month,d));
    chatters.forEach(c=>S.models.forEach(m=>{total+=parseFloat(S.revenues[`${c.id}_${m.id}_${key}`])||0;}));
  }
  return total;
}
function calcGerMeta2(metaGlobal, fatGlobal){
  if(!metaGlobal||!fatGlobal)return 0;
  const pct=fatGlobal/metaGlobal;
  if(pct<=0.9)return Math.round(1500*pct);
  if(pct<=1.0)return 1500;
  if(pct<=1.1)return 1800;
  if(pct<=1.2)return 2100;
  if(pct<=1.3)return 2400;
  return Math.round(2400+(pct-1.3)*metaGlobal*0.008);
}

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
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester');
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
  const total=frente1+frente2; // vem só do resultado real — sem piso artificial

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
        <tr style="background:var(--accent-soft)">
          <td colspan="4" style="padding:10px;font-weight:800;font-size:14px;color:var(--accent)">Total do mês (real)</td>
          <td style="padding:10px;text-align:right;font-family:var(--font-mono);font-weight:800;font-size:18px;color:var(--accent)">${money(total)}</td>
        </tr>
        </tbody>
      </table>
    </div>`;
}

/* ===========================================================
   PROJEÇÃO — análise mensal de desenvolvimento por chatter
   =========================================================== */
function renderProjecao(){
  const sel=document.getElementById('proj-chatter');
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester');
  if(sel){
    const cur=sel.value;
    sel.innerHTML='<option value="">— todos os chatters —</option>'+
      chatters.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
    if(cur)sel.value=cur;
  }
  const cid=document.getElementById('proj-chatter')?.value;
  if(cid){
    renderProjecaoChatter(cid);
  } else {
    // Show all chatters
    const el=document.getElementById('proj-content');
    if(!el)return;
    if(!chatters.length){
      el.innerHTML='<div class="empty"><div class="empty-ic">📈</div><div class="empty-ttl">Sem chatters</div></div>';
      return;
    }
    el.innerHTML=chatters.map(c=>`<div id="proj-section-${c.id}"></div>`).join('');
    chatters.forEach((c,i)=>setTimeout(()=>renderProjecaoChatter(c.id,`proj-section-${c.id}`),i*30));
  }
}

// Média semanal recente (até 4 semanas) de faturamento de um chatter, a partir das analytics
function getChatterAvgWeeklyRevenue(cid){
  const f=S.chatterFichas[cid]||{};
  const analytics=f.analytics?.weeklyData||{};
  const weekGroups={};
  Object.keys(analytics).forEach(dk=>{
    const d=new Date(dk+'T12:00:00');
    const sun=new Date(d);sun.setDate(d.getDate()-d.getDay());
    const wk=fmt(sun);
    weekGroups[wk]=(weekGroups[wk]||0)+(analytics[dk].chatterTotal||0);
  });
  const recentWeeks=Object.keys(weekGroups).sort().reverse().slice(0,4);
  const weekRevs=recentWeeks.map(wk=>weekGroups[wk]).filter(v=>v>0);
  return weekRevs.length?weekRevs.reduce((s,v)=>s+v,0)/weekRevs.length:0;
}
// Projeção mensal (30 dias) somada de toda a empresa, no ritmo atual de cada chatter
function getCompanyMonthlyProjection(){
  const chatters=S.chatters.filter(c=>c.time!=='elite'&&c.time!=='tester');
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

  // Group by week (Sun-Sat)
  const weekGroups={};
  weekKeys.forEach(dk=>{
    const d=new Date(dk+'T12:00:00');
    const sun=new Date(d);sun.setDate(d.getDate()-d.getDay());
    const wk=fmt(sun);
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

  // ---- Projeção motivacional: empresa + chatter + análise curta de desenvolvimento ----
  {
    const avgWeekRev=getChatterAvgWeeklyRevenue(cid);
    const projMonth=avgWeekRev*(30/7);
    const companyProjMonth=getCompanyMonthlyProjection();

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

    if(avgWeekRev>0||companyProjMonth>0){
      html+=`<div class="panel" style="margin-bottom:16px;border:2px solid var(--accent);background:linear-gradient(135deg,var(--accent-soft),var(--bg-soft))">
        <div style="text-align:center;margin-bottom:12px">
          <div style="font-size:11px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">🚀 Projeção para os próximos 30 dias</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
          <div style="text-align:center;background:var(--bg);border-radius:10px;padding:10px">
            <div style="font-size:9.5px;color:var(--text3);text-transform:uppercase">Faturamento da empresa</div>
            <div style="font-size:20px;font-weight:800;font-family:var(--font-mono);color:var(--ok)">${money(companyProjMonth)}</div>
          </div>
          <div style="text-align:center;background:var(--bg);border-radius:10px;padding:10px">
            <div style="font-size:9.5px;color:var(--text3);text-transform:uppercase">Faturamento de ${c.name.split(' ')[0]}</div>
            <div style="font-size:20px;font-weight:800;font-family:var(--font-mono);color:var(--accent)">${money(projMonth)}</div>
          </div>
        </div>
        ${avgWeekRev>0?`<div style="font-size:12px;color:var(--text2);text-align:center;margin-bottom:10px">no ritmo atual — média de ${money(avgWeekRev)}/semana (${c.name.split(' ')[0]})</div>`:''}
        <div style="font-size:12.5px;color:var(--text);line-height:1.5;background:var(--bg);border-radius:8px;padding:9px 11px;margin-bottom:8px">
          <strong>🧠 Desenvolvimento:</strong> ${devText}
        </div>
        ${avgWeekRev>0?`<div style="font-size:12.5px;color:var(--text);text-align:center;line-height:1.5">💪 Continue nesse ritmo e ${c.name.split(' ')[0]} pode fechar o mês com <strong>${money(projMonth)}</strong>! Cada venda extra hoje ajuda a bater essa marca ainda mais rápido.</div>`:''}
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

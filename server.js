// ============================================================
//  SG1 Notícias — Backend (LOGIN DIRETO PELO INSTAGRAM)
//  Instagram API with Instagram Login — não exige Página do Facebook.
//  Fluxo: login no Instagram → token de longa duração → /me/media
// ============================================================
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Diagnóstico: mostra erros de forma clara no log ----
process.on('uncaughtException', (e) => console.error('🔴 ERRO FATAL:', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('🔴 ERRO (promessa):', (e && e.stack) || e));

const {
  INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET,
  META_APP_ID, META_APP_SECRET,        // compatível: pode reaproveitar essas variáveis
  REDIRECT_URI,
  SITE_URL = 'http://localhost:3000',
  PORT = 3000,
  ADMIN_KEY = 'troque-esta-chave',
  CACHE_MINUTES = 10
} = process.env;

// Usa as credenciais do APP DO INSTAGRAM (aceita os dois nomes de variável)
const IG_APP_ID = INSTAGRAM_APP_ID || META_APP_ID;
const IG_APP_SECRET = INSTAGRAM_APP_SECRET || META_APP_SECRET;
const SCOPE = 'instagram_business_basic'; // permissão para ler perfil e mídia

// ---- Armazenamento simples do token ----
const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const loadTokens = () => { try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch { return null; } };
const saveTokens = (d) => fs.writeFileSync(TOKENS_FILE, JSON.stringify(d, null, 2));
const clearTokens = () => { try { fs.unlinkSync(TOKENS_FILE); } catch {} };

const app = express();
app.use(express.json({ limit: '6mb' }));
app.use(cors({ origin: [SITE_URL, 'http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:3000'] }));
app.use(express.static(path.join(__dirname, 'public')));

const pendingStates = new Map();
setInterval(() => { const now = Date.now(); for (const [s, t] of pendingStates) if (now - t > 600000) pendingStates.delete(s); }, 60000);

let postsCache = { at: 0, data: [] };

async function igGet(url) {
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  if (j.error_message) throw new Error(j.error_message);
  return j;
}

// ============================================================
//  1) Inicia o login no Instagram
//     (mantém a rota /auth/facebook para não mexer no site)
// ============================================================
app.get('/auth/facebook', (req, res) => {
  if (!IG_APP_ID || !REDIRECT_URI) return res.status(500).send('Backend sem APP_ID/REDIRECT_URI configurados.');
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  const url = `https://www.instagram.com/oauth/authorize`
    + `?client_id=${encodeURIComponent(IG_APP_ID)}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&response_type=code`
    + `&scope=${encodeURIComponent(SCOPE)}`
    + `&state=${state}`;
  res.redirect(url);
});

// ============================================================
//  2) Retorno do login: troca código por token e salva
// ============================================================
app.get('/auth/facebook/callback', async (req, res) => {
  let { code, state, error } = req.query;
  if (error) return res.redirect(`${SITE_URL}?ig=erro#/admin`);
  if (!code || !state || !pendingStates.has(state)) return res.redirect(`${SITE_URL}?ig=erro#/admin`);
  pendingStates.delete(state);
  code = String(code).replace(/#_$/, ''); // remove sufixo que o IG às vezes adiciona

  try {
    // 2.1 código -> token curto (POST em formato de formulário)
    const body = new URLSearchParams({
      client_id: IG_APP_ID,
      client_secret: IG_APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      code
    });
    const sr = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const sj = await sr.json();
    if (sj.error_message || sj.error) throw new Error(sj.error_message || (sj.error.message || JSON.stringify(sj.error)));
    const shortToken = sj.access_token;
    console.log('IG token curto OK · user_id:', sj.user_id);

    // 2.2 token curto -> token de longa duração (~60 dias)
    const lj = await igGet(`https://graph.instagram.com/access_token`
      + `?grant_type=ig_exchange_token`
      + `&client_secret=${IG_APP_SECRET}`
      + `&access_token=${shortToken}`);
    const longToken = lj.access_token;
    console.log('IG token longo OK · expira em (s):', lj.expires_in);

    // 2.3 dados do perfil
    const me = await igGet(`https://graph.instagram.com/me`
      + `?fields=user_id,username,profile_picture_url&access_token=${longToken}`);
    console.log('IG conectado: @' + me.username);

    saveTokens({
      igToken: longToken,
      igUserId: me.user_id,
      igUsername: me.username,
      igPhoto: me.profile_picture_url || '',
      connectedAt: new Date().toISOString()
    });
    postsCache = { at: 0, data: [] };
    res.redirect(`${SITE_URL}?ig=connected#/admin`);
  } catch (e) {
    console.error('Callback Instagram:', e.message);
    res.redirect(`${SITE_URL}?ig=erro#/admin`);
  }
});

// ============================================================
//  3) Status da conexão
// ============================================================
app.get('/api/instagram/status', (req, res) => {
  const t = loadTokens();
  if (!t) return res.json({ connected: false });
  res.json({ connected: true, username: t.igUsername, photo: t.igPhoto, connectedAt: t.connectedAt });
});

// ============================================================
//  4) Últimos posts/reels (alimenta a home do site)
// ============================================================
app.get('/api/instagram/posts', async (req, res) => {
  const t = loadTokens();
  if (!t) return res.status(409).json({ connected: false, posts: [] });
  const limit = Math.min(parseInt(req.query.limit) || 10, 25);
  const fresh = Date.now() - postsCache.at < CACHE_MINUTES * 60 * 1000;
  if (fresh && postsCache.data.length) return res.json({ connected: true, posts: postsCache.data });

  try {
    const fields = ['id', 'caption', 'media_type', 'media_product_type', 'media_url', 'thumbnail_url', 'permalink', 'timestamp'].join(',');
    const data = await igGet(`https://graph.instagram.com/me/media?fields=${fields}&limit=${limit}&access_token=${t.igToken}`);
    const posts = (data.data || []).map(m => ({
      id: m.id,
      caption: m.caption || '',
      type: m.media_type,
      isReel: m.media_product_type === 'REELS',
      thumb: m.thumbnail_url || m.media_url || '',
      permalink: m.permalink,
      timestamp: m.timestamp,
      likes: null,
      comments: null
    }));
    postsCache = { at: Date.now(), data: posts };
    res.json({ connected: true, posts });
  } catch (e) {
    console.error('Posts IG:', e.message);
    if (postsCache.data.length) return res.json({ connected: true, posts: postsCache.data, stale: true });
    res.status(502).json({ connected: true, posts: [], error: e.message });
  }
});

// ============================================================
//  5) Desconectar (protegido por ADMIN_KEY)
// ============================================================
app.post('/auth/logout', (req, res) => {
  if (req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ ok: false });
  clearTokens();
  postsCache = { at: 0, data: [] };
  res.json({ ok: true });
});

// ============================================================
//  6) Renovar o token de longa duração (cron mensal)
// ============================================================
app.post('/auth/refresh', async (req, res) => {
  if (req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ ok: false });
  const t = loadTokens();
  if (!t) return res.status(409).json({ ok: false });
  try {
    const j = await igGet(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${t.igToken}`);
    saveTokens({ ...t, igToken: j.access_token, refreshedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ============================================================
//  7) Diário Oficial + IA (somente admin) — usa OpenAI
//     A chave fica SÓ aqui no servidor (variável OPENAI_API_KEY).
// ============================================================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const FONTES = {
  sg: 'Diário Oficial da Prefeitura de São Gonçalo - RJ',
  rj: 'Diário Oficial do Estado do Rio de Janeiro (IOERJ)',
  alerj: 'Diário Oficial da ALERJ (Poder Legislativo do RJ)',
  todos: 'Diários Oficiais de São Gonçalo e região'
};

// limite simples de uso (protege os créditos da OpenAI contra abuso)
let iaHits = [];
function iaRateOk() {
  const now = Date.now();
  iaHits = iaHits.filter(t => now - t < 60 * 60 * 1000);
  if (iaHits.length >= 60) return false; // máx 60 análises por hora
  iaHits.push(now);
  return true;
}

async function fetchDiarioContent(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 SG1Bot' } });
  if (!r.ok) throw new Error('Não consegui acessar o link (HTTP ' + r.status + ').');
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('pdf') || url.toLowerCase().endsWith('.pdf')) {
    const buf = Buffer.from(await r.arrayBuffer());
    try {
      const mod = await import('pdf-parse/lib/pdf-parse.js');
      const pdfParse = mod.default || mod;
      const data = await pdfParse(buf);
      return data.text || '';
    } catch (e) {
      throw new Error('Esse link é um PDF que não consegui ler sozinho. Copie o texto do diário e cole no campo de texto.');
    }
  }
  const html = await r.text();
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
             .replace(/<style[\s\S]*?<\/style>/gi, ' ')
             .replace(/<[^>]+>/g, ' ')
             .replace(/\s+/g, ' ').trim();
}

async function askOpenAI(system, user) {
  if (!OPENAI_API_KEY) throw new Error('A chave da OpenAI não está configurada no servidor (variável OPENAI_API_KEY).');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.2, max_tokens: 1600
    })
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'Erro na OpenAI');
  return j.choices?.[0]?.message?.content || '';
}

app.post('/api/diario', async (req, res) => {
  if (req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ ok: false, error: 'Acesso restrito (chave de administrador inválida).' });
  if (!iaRateOk()) return res.status(429).json({ ok: false, error: 'Muitas análises em pouco tempo. Tente novamente daqui a pouco.' });
  try {
    let { source = 'todos', url = '', text = '', mode = 'pautas', query = '' } = req.body || {};
    let content = (text || '').trim();
    if (!content && url) content = await fetchDiarioContent(url.trim());
    if (!content) return res.status(400).json({ ok: false, error: 'Cole o texto do diário ou informe um link válido.' });
    content = content.slice(0, 45000);

    const fonte = FONTES[source] || FONTES.todos;
    let system, user;
    if (mode === 'busca') {
      if (!query.trim()) return res.status(400).json({ ok: false, error: 'Digite o que deseja buscar (nome, empresa ou assunto).' });
      system = `Você é um analista de redação do portal SG1 Notícias (São Gonçalo - RJ). Recebe o texto de um diário oficial (${fonte}). Procure TODAS as menções relacionadas a: "${query}". Para cada ocorrência traga: o contexto/trecho, o tipo de ato (nomeação, exoneração, licitação, contrato, etc.), valores e datas quando houver. Se não encontrar, diga claramente "Nenhuma menção encontrada". Responda em português, em tópicos, objetivo.`;
      user = `Buscar por: ${query}\n\nTEXTO DO DIÁRIO:\n${content}`;
    } else {
      system = `Você é um assistente de pauta do portal SG1 Notícias (São Gonçalo - RJ). Recebe o texto de um diário oficial (${fonte}). Identifique os assuntos com POTENCIAL DE NOTÍCIA para a população: novas licitações, nomeações/posses, exonerações, contratos relevantes, concursos públicos, decretos importantes e mudanças administrativas. Para cada item retorne: • Título sugerido de notícia • Tipo • Resumo em 1-2 frases • Por que é relevante. Ignore o que for puramente burocrático e sem interesse público. Responda em português, em lista organizada.`;
      user = `Encontre pautas relevantes neste diário:\n\n${content}`;
    }
    const resposta = await askOpenAI(system, user);
    res.json({ ok: true, resposta });
  } catch (e) {
    console.error('Diário IA:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/health', (_req, res) => res.send('SG1 Instagram backend ativo ✅'));

// Mostra no log se as configurações chegaram (sem expor segredos)
console.log('⚙️  Config →',
  'APP_ID:', IG_APP_ID ? 'ok' : '❌ FALTANDO',
  '| SECRET:', IG_APP_SECRET ? 'ok' : '❌ FALTANDO',
  '| REDIRECT_URI:', REDIRECT_URI || '❌ FALTANDO',
  '| SITE_URL:', SITE_URL,
  '| PORT(bruto):', process.env.PORT);

// Valida a porta — se estiver inválida (ex.: App ID colado por engano), avisa e usa 3000
let LISTEN_PORT = Number(process.env.PORT) || 3000;
if (!Number.isInteger(LISTEN_PORT) || LISTEN_PORT < 0 || LISTEN_PORT > 65535) {
  console.error('🔴 A variável PORT está INVÁLIDA: "' + process.env.PORT + '". '
    + 'APAGUE a variável PORT no Render (Environment). Usando 3000 por enquanto.');
  LISTEN_PORT = 3000;
}

const server = app.listen(LISTEN_PORT, () => console.log(`✅ SG1 backend rodando na porta ${LISTEN_PORT}`));
server.on('error', (e) => console.error('🔴 ERRO ao iniciar o servidor:', e.message));

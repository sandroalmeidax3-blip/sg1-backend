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
app.use(express.json({ limit: '25mb' }));
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
//  7) Diário Oficial — IA investigativa (somente admin)
//     A chave da OpenAI fica SÓ aqui no servidor (OPENAI_API_KEY).
//     Você baixa o PDF do diário e anexa; a IA lê, resume e investiga.
// ============================================================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_SEARCH_MODEL = process.env.OPENAI_SEARCH_MODEL || 'gpt-4o-mini-search-preview';

let iaHits = [];
function iaRateOk() { const now = Date.now(); iaHits = iaHits.filter(t => now - t < 3600000); if (iaHits.length >= 120) return false; iaHits.push(now); return true; }

async function extrairPdf(base64) {
  const buf = Buffer.from(base64, 'base64');
  const mod = await import('pdf-parse/lib/pdf-parse.js');
  const pdfParse = mod.default || mod;
  const data = await pdfParse(buf);
  return (data.text || '').trim();
}

const PERSONA = 'Você é um jornalista investigativo experiente do portal SG1 Notícias, de São Gonçalo (RJ). Sua função: ler diários oficiais e documentos públicos e identificar o que tem interesse público e potencial de notícia (licitações, contratos, nomeações/posses, exonerações, concursos, decretos, valores atípicos, possíveis irregularidades). Seja rigoroso e baseie-se no que está nos documentos, citando trechos quando útil. Separe a análise por ASSUNTO. Aponte o que merece apuração e sugira próximos passos de investigação. Quando puder pesquisar na web, contextualize e verifique fatos, sempre citando as fontes. Escreva em português do Brasil, de forma clara e direta.';

function montarContextoDocs(docs) {
  if (!docs || !docs.length) return '';
  let total = 0, partes = [];
  for (const d of docs) {
    let t = (d.text || '').slice(0, 22000);
    if (total + t.length > 60000) t = t.slice(0, Math.max(0, 60000 - total));
    if (!t) break;
    partes.push('### DOCUMENTO: ' + (d.name || 'documento') + '\n' + t);
    total += t.length;
  }
  return partes.join('\n\n');
}

async function chatOpenAI({ messages, docs, useSearch }) {
  if (!OPENAI_API_KEY) throw new Error('A chave da OpenAI não está configurada no servidor (OPENAI_API_KEY).');
  const ctx = montarContextoDocs(docs);
  const sys = PERSONA + (ctx ? ('\n\nDOCUMENTOS ANEXADOS PELO EDITOR (base principal da análise):\n' + ctx) : '\n\n(Nenhum documento anexado ainda.)');
  const msgs = [{ role: 'system', content: sys }, ...messages];
  const body = { model: useSearch ? OPENAI_SEARCH_MODEL : OPENAI_MODEL, messages: msgs, max_tokens: 1900 };
  if (useSearch) body.web_search_options = { search_context_size: 'medium' };
  else body.temperature = 0.3;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'Erro na OpenAI');
  const msg = j.choices?.[0]?.message || {};
  return { reply: msg.content || '', annotations: msg.annotations || [] };
}

// extrai o texto de UM pdf (base64) por vez
app.post('/api/diario/extract', async (req, res) => {
  if (req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ ok: false, error: 'Acesso restrito (chave do painel inválida).' });
  try {
    const { name = 'documento.pdf', base64 = '' } = req.body || {};
    if (!base64) return res.status(400).json({ ok: false, error: 'Arquivo vazio.' });
    const text = await extrairPdf(base64);
    if (!text) return res.json({ ok: true, name, text: '', aviso: 'Não consegui extrair texto — o PDF pode ser uma imagem escaneada.' });
    res.json({ ok: true, name, text, chars: text.length });
  } catch (e) {
    console.error('Extract PDF:', e.message);
    res.status(502).json({ ok: false, error: 'Falha ao ler o PDF: ' + e.message });
  }
});

// conversa com a IA investigativa (usa os documentos como contexto)
app.post('/api/diario/chat', async (req, res) => {
  if (req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ ok: false, error: 'Acesso restrito (chave do painel inválida).' });
  if (!iaRateOk()) return res.status(429).json({ ok: false, error: 'Muitas requisições em pouco tempo. Aguarde um pouco.' });
  try {
    const { messages = [], docs = [], useSearch = false } = req.body || {};
    if (!messages.length) return res.status(400).json({ ok: false, error: 'Sem mensagem.' });
    const hist = messages.slice(-12);
    const out = await chatOpenAI({ messages: hist, docs, useSearch });
    res.json({ ok: true, reply: out.reply, annotations: out.annotations });
  } catch (e) {
    console.error('Diário chat:', e.message);
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

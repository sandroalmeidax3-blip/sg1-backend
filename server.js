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

async function openaiChat({ system, messages, useSearch = false, maxTokens = 1800, model, json = false, searchContext = 'medium' }) {
  if (!OPENAI_API_KEY) throw new Error('A chave da OpenAI não está configurada no servidor (OPENAI_API_KEY).');
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const mdl = model || (useSearch ? OPENAI_SEARCH_MODEL : OPENAI_MODEL);
  const body = { model: mdl, messages: msgs, max_tokens: maxTokens };
  if (useSearch) body.web_search_options = { search_context_size: searchContext };
  else { body.temperature = 0.3; if (json) body.response_format = { type: 'json_object' }; }
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_API_KEY },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'Erro na OpenAI');
  const m = j.choices?.[0]?.message || {};
  return { reply: m.content || '', annotations: m.annotations || [] };
}

function extrairJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/```json/gi, '').replace(/```/g, '').trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch (e) {} }
  return null;
}

async function chatOpenAI({ messages, docs, useSearch }) {
  const ctx = montarContextoDocs(docs);
  const sys = PERSONA + (ctx ? ('\n\nDOCUMENTOS ANEXADOS PELO EDITOR (base principal da análise):\n' + ctx) : '\n\n(Nenhum documento anexado ainda.)');
  return openaiChat({ system: sys, messages, useSearch, maxTokens: 1900 });
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

// ---- Radar de pautas na web (jornalismo) ----
// ---- Helpers do radar de pautas (Google Notícias RSS) ----
function gnDecode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function gnParse(xml) {
  const out = [];
  const blocks = xml.split('<item>').slice(1);
  for (const b of blocks) {
    const body = b.split('</item>')[0];
    const pick = (tag) => { const m = body.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>')); return m ? gnDecode(m[1]) : ''; };
    let title = pick('title');
    const link = (body.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
    const pub = pick('pubDate');
    const source = pick('source');
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3)).trim();
    if (title) out.push({ title, link: link.trim(), pub, source });
  }
  return out;
}

app.post('/api/pautas', async (req, res) => {
  if (req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ ok: false, error: 'Acesso restrito (chave do painel inválida).' });
  if (!iaRateOk()) return res.status(429).json({ ok: false, error: 'Muitas requisições em pouco tempo. Aguarde um pouco.' });
  try {
    let { regiao = '', tema = '', periodo = '7' } = req.body || {};
    const days = ({ '1': 1, '7': 7, '30': 30 })[String(periodo)] || 7;
    let cidade = (regiao || '').trim();
    if (/metropolitana|leste/i.test(cidade)) cidade = 'Leste Fluminense';
    if (!cidade) cidade = 'São Gonçalo';
    let q = cidade;
    if (!/\brj\b|rio de janeiro/i.test(q)) q += ' RJ';
    if (tema) q += ' ' + tema;
    q += ` when:${days}d`;
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 SG1Bot' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const xml = await r.text();
    const items = gnParse(xml);
    const lim = Date.now() - (days * 24 + 12) * 3600 * 1000; // tolerância de 12h
    const fmt = (d) => { try { return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }); } catch (e) { return ''; } };
    let pautas = items.map(it => {
      const dt = it.pub ? new Date(it.pub) : null;
      const ok = dt && !isNaN(dt.getTime());
      return { titulo: it.title, regiao: cidade, tema: tema || '', fonte: it.source || '', data: ok ? fmt(dt) : '', _ts: ok ? dt.getTime() : 0, resumo: '', link: it.link };
    });
    pautas = pautas.filter(p => !p._ts || p._ts >= lim).sort((a, b) => b._ts - a._ts).slice(0, 25);
    pautas.forEach(p => delete p._ts);
    res.json({ ok: true, pautas, fonte: url });
  } catch (e) {
    console.error('Pautas:', e.message);
    res.status(502).json({ ok: false, error: 'Não consegui buscar as pautas: ' + e.message });
  }
});

// ---- Gerar texto da matéria (redator jornalista) ----
app.post('/api/materia', async (req, res) => {
  if (req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ ok: false, error: 'Acesso restrito (chave do painel inválida).' });
  if (!iaRateOk()) return res.status(429).json({ ok: false, error: 'Muitas requisições em pouco tempo. Aguarde um pouco.' });
  try {
    const { titulo = '', resumo = '', link = '', tema = '', regiao = '', useSearch = true } = req.body || {};
    if (!titulo) return res.status(400).json({ ok: false, error: 'Sem pauta para escrever.' });
    const sys = 'Você é redator jornalista do portal SG1 Notícias (São Gonçalo - RJ). Escreva uma matéria completa, pronta para publicar, com apuração responsável. ' + (useSearch ? 'Pesquise na web para confirmar e enriquecer os fatos. ' : '') + 'Estrutura: um título jornalístico e chamativo, uma linha fina (subtítulo) e o CORPO com lide (o quê, quem, quando, onde, por quê), desenvolvimento e contexto local de São Gonçalo. Tom jornalístico, claro e imparcial. NÃO invente dados, números ou declarações; se não confirmar, não afirme. Português do Brasil. Retorne SOMENTE um JSON: {"titulo":"","linha_fina":"","corpo":"texto com parágrafos separados por quebras de linha"}.';
    const user = 'Pauta: ' + titulo + '\nTema: ' + tema + ' | Região: ' + regiao + '\nResumo: ' + resumo + '\nFonte de referência: ' + link;
    const out = await openaiChat({ system: sys, messages: [{ role: 'user', content: user }], useSearch: !!useSearch, maxTokens: 2400 });
    const j = extrairJson(out.reply);
    if (j && j.corpo) res.json({ ok: true, materia: j });
    else res.json({ ok: true, materia: { titulo, linha_fina: '', corpo: out.reply } });
  } catch (e) {
    console.error('Matéria:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ---- Mural de Licitações de São Gonçalo (portal aberto) ----
const LIC_URLS = {
  licitacoes: 'https://licitacao.pmsg.rj.gov.br/licitacoes.php',
  dispensas: 'https://licitacao.pmsg.rj.gov.br/dispensas.php',
  contratos: 'https://licitacao.pmsg.rj.gov.br/contratos.php',
  inexigibilidades: 'https://licitacao.pmsg.rj.gov.br/inexigibilidades.php'
};
function parseMural(html) {
  const trs = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const itens = [];
  for (const tr of trs) {
    const idm = tr.match(/([\w-]+\.php\?[\w]+=\d+)/);
    const txt = tr.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
    if (txt.length > 25 && idm) itens.push({ texto: txt, url: 'https://licitacao.pmsg.rj.gov.br/' + idm[1] });
  }
  return itens;
}
app.get('/api/licitacoes', async (req, res) => {
  if (req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ ok: false, error: 'Acesso restrito (chave do painel inválida).' });
  try {
    const tipo = (req.query.tipo || 'licitacoes');
    const termo = (req.query.termo || '').trim().toLowerCase();
    const dataIni = (req.query.dataIni || '').replace(/-/g, ''); // yyyymmdd
    const dataFim = (req.query.dataFim || '').replace(/-/g, '');
    const url = LIC_URLS[tipo] || LIC_URLS.licitacoes;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 SG1Bot' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();
    let itens = parseMural(html);
    // filtro por data (usa a data dd/mm/aaaa que aparece na linha)
    if (dataIni || dataFim) {
      itens = itens.filter(it => {
        const m = it.texto.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (!m) return true; // sem data reconhecível: mantém
        const d = m[3] + m[2] + m[1];
        if (dataIni && d < dataIni) return false;
        if (dataFim && d > dataFim) return false;
        return true;
      });
    }
    // filtro por termo
    if (termo) itens = itens.filter(it => it.texto.toLowerCase().includes(termo));
    itens = itens.slice(0, 60);
    const texto = itens.map((it, i) => (i + 1) + '. ' + it.texto + '\n   Detalhes: ' + it.url).join('\n\n');
    res.json({ ok: true, count: itens.length, texto, fonte: url });
  } catch (e) {
    console.error('Licitações:', e.message);
    res.status(502).json({ ok: false, error: 'Não consegui acessar o mural de licitações: ' + e.message });
  }
});

// === Puxa SÓ a imagem de um post público do Instagram (sem token/API da Meta) ===
function igShortcode(u) {
  const m = String(u || '').match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}
function igExtractImg(html) {
  let m = html.match(/"display_url":"([^"]+)"/);                              if (m) return m[1];
  m = html.match(/property="og:image"\s+content="([^"]+)"/);                  if (m) return m[1];
  m = html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/);      if (m) return m[1];
  m = html.match(/class="EmbeddedMediaImage"[^>]*\bsrc="([^"]+)"/);           if (m) return m[1];
  return '';
}
async function igTryImg(url, ua) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': ua, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' } });
    if (!r.ok) return '';
    return igExtractImg(await r.text());
  } catch (e) { return ''; }
}
app.get('/api/instagram/preview', async (req, res) => {
  try {
    const code = igShortcode(req.query.url || '');
    if (!code) return res.status(400).json({ ok: false, error: 'URL do Instagram inválida.' });
    const BR = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
    const FB = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
    let img = '';
    img = await igTryImg(`https://www.instagram.com/p/${code}/embed/captioned/`, BR);   // 1) página de embed (pública)
    if (!img) img = await igTryImg(`https://www.instagram.com/p/${code}/`, FB);          // 2) og:image servido a crawlers
    if (!img) img = await igTryImg(`https://www.instagram.com/reel/${code}/embed/captioned/`, BR); // 3) caso seja reel
    if (!img) return res.status(404).json({ ok: false, error: 'Não achei a imagem (post privado, ou o Instagram bloqueou o acesso do servidor).' });
    img = img.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    res.json({ ok: true, code, image: img });
  } catch (e) {
    console.error('IG preview:', e.message);
    res.status(502).json({ ok: false, error: 'Não consegui buscar a imagem: ' + e.message });
  }
});

// === Monitor de páginas do Instagram via Apify (últimas N de cada perfil) ===
const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const APIFY_ACTOR = process.env.APIFY_ACTOR || 'apify~instagram-scraper';
async function apifyLatestPosts(username, limit) {
  const fetchN = Math.max(limit + 8, 12); // pega a mais p/ ignorar fixados e ordenar por data
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(APIFY_TOKEN)}`;
  const input = { directUrls: [`https://www.instagram.com/${username}/`], resultsType: 'posts', resultsLimit: fetchN, addParentData: false };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  if (!r.ok) throw new Error('Apify HTTP ' + r.status);
  const data = await r.json();
  const items = Array.isArray(data) ? data : [];
  const mapped = items.map(it => ({
    img: it.displayUrl || (Array.isArray(it.images) && it.images[0]) || '',
    caption: (it.caption || '').slice(0, 220),
    date: it.timestamp || '',
    _ts: it.timestamp ? Date.parse(it.timestamp) : 0,
    link: it.url || (it.shortCode ? `https://www.instagram.com/p/${it.shortCode}/` : ''),
    likes: (it.likesCount != null ? it.likesCount : null),
    type: it.type || ''
  }));
  mapped.sort((a, b) => (b._ts || 0) - (a._ts || 0)); // mais recentes primeiro (por data real)
  return mapped.slice(0, limit).map(({ _ts, ...rest }) => rest);
}
app.post('/api/ig-monitor', async (req, res) => {
  if (req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ ok: false, error: 'Acesso restrito (chave do painel inválida).' });
  if (!APIFY_TOKEN) return res.status(400).json({ ok: false, error: 'APIFY_TOKEN não configurado no servidor. Adicione nas Environment Variables do Render.' });
  if (!iaRateOk()) return res.status(429).json({ ok: false, error: 'Muitas requisições em pouco tempo. Aguarde um pouco.' });
  try {
    let { pages = [], limit = 5 } = req.body || {};
    if (!Array.isArray(pages)) pages = [];
    pages = pages.map(p => String(p).trim().replace(/^@/, '').replace(/\/+$/, '')).filter(Boolean).slice(0, 8);
    limit = Math.min(Math.max(parseInt(limit) || 5, 1), 10);
    if (!pages.length) return res.json({ ok: true, results: [] });
    const settled = await Promise.allSettled(pages.map(p => apifyLatestPosts(p, limit)));
    const results = pages.map((p, i) => ({
      page: p,
      ok: settled[i].status === 'fulfilled',
      posts: settled[i].status === 'fulfilled' ? settled[i].value : [],
      error: settled[i].status === 'rejected' ? String(settled[i].reason && settled[i].reason.message || settled[i].reason) : undefined
    }));
    res.json({ ok: true, results });
  } catch (e) {
    console.error('IG monitor:', e.message);
    res.status(502).json({ ok: false, error: 'Falha ao buscar no Instagram: ' + e.message });
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

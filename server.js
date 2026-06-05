// ============================================================
//  SG1 Notícias — Backend de integração com Instagram (Meta)
//  Fluxo: Facebook Login → token de longa duração → Página →
//         Instagram Business Account → últimos posts/reels
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
const {
  META_APP_ID, META_APP_SECRET, REDIRECT_URI,
  SITE_URL = 'http://localhost:5500',
  GRAPH_VERSION = 'v21.0',
  PORT = 3000,
  ADMIN_KEY = 'troque-esta-chave',
  CACHE_MINUTES = 10
} = process.env;

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const SCOPES = [
  'instagram_basic',
  'pages_show_list',
  'pages_read_engagement',
  'business_management'
].join(',');

// ---- Armazenamento simples dos tokens (arquivo) ----
// ATENÇÃO produção: troque por um cofre de segredos / banco com criptografia.
const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const loadTokens = () => {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); }
  catch { return null; }
};
const saveTokens = (data) =>
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(data, null, 2));
const clearTokens = () => { try { fs.unlinkSync(TOKENS_FILE); } catch {} };

// ---- App ----
const app = express();
app.use(express.json());
app.use(cors({ origin: [SITE_URL, 'http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:3000'] }));

// Serve o site (coloque o index.html dentro da pasta ./public)
app.use(express.static(path.join(__dirname, 'public')));

// guarda os "state" do OAuth por alguns minutos (anti-CSRF)
const pendingStates = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [s, t] of pendingStates) if (now - t > 10 * 60 * 1000) pendingStates.delete(s);
}, 60 * 1000);

// cache em memória dos posts
let postsCache = { at: 0, data: [] };

// helper de chamada à Graph API
async function graph(url) {
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'Erro na Graph API');
  return j;
}

// ============================================================
//  1) Inicia o login: redireciona para o diálogo da Meta
// ============================================================
app.get('/auth/facebook', (req, res) => {
  if (!META_APP_ID || !REDIRECT_URI)
    return res.status(500).send('Backend sem META_APP_ID/REDIRECT_URI configurados.');
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  const url = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`
    + `?client_id=${encodeURIComponent(META_APP_ID)}`
    + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
    + `&scope=${encodeURIComponent(SCOPES)}`
    + `&response_type=code`
    + `&state=${state}`;
  res.redirect(url);
});

// ============================================================
//  2) Callback: troca código por token, acha a Página e o IG
// ============================================================
app.get('/auth/facebook/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.redirect(`${SITE_URL}?ig=erro#/admin`);
  if (!code || !state || !pendingStates.has(state))
    return res.redirect(`${SITE_URL}?ig=erro#/admin`);
  pendingStates.delete(state);

  try {
    // 2.1 código -> token curto
    const short = await graph(`${GRAPH}/oauth/access_token`
      + `?client_id=${META_APP_ID}`
      + `&client_secret=${META_APP_SECRET}`
      + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
      + `&code=${code}`);

    // 2.2 token curto -> token de longa duração (~60 dias)
    const long = await graph(`${GRAPH}/oauth/access_token`
      + `?grant_type=fb_exchange_token`
      + `&client_id=${META_APP_ID}`
      + `&client_secret=${META_APP_SECRET}`
      + `&fb_exchange_token=${short.access_token}`);
    const userToken = long.access_token;

    // 2.3 páginas do usuário (cada uma traz seu próprio page token)
    const pages = await graph(`${GRAPH}/me/accounts`
      + `?fields=id,name,access_token,instagram_business_account`
      + `&access_token=${userToken}`);

    // 2.4 acha a página que tem conta de Instagram vinculada
    const page = (pages.data || []).find(p => p.instagram_business_account);
    if (!page)
      return res.redirect(`${SITE_URL}?ig=sem_instagram#/admin`);

    const igId = page.instagram_business_account.id;

    // 2.5 pega o @username do Instagram
    const igInfo = await graph(`${GRAPH}/${igId}`
      + `?fields=username,profile_picture_url`
      + `&access_token=${page.access_token}`);

    saveTokens({
      userToken,
      pageId: page.id,
      pageName: page.name,
      pageToken: page.access_token,
      igId,
      igUsername: igInfo.username,
      igPhoto: igInfo.profile_picture_url || '',
      connectedAt: new Date().toISOString()
    });
    postsCache = { at: 0, data: [] }; // invalida cache

    res.redirect(`${SITE_URL}?ig=connected#/admin`);
  } catch (e) {
    console.error('Callback Meta:', e.message);
    res.redirect(`${SITE_URL}?ig=erro#/admin`);
  }
});

// ============================================================
//  3) Status da conexão (para o painel)
// ============================================================
app.get('/api/instagram/status', (req, res) => {
  const t = loadTokens();
  if (!t) return res.json({ connected: false });
  res.json({
    connected: true,
    username: t.igUsername,
    page: t.pageName,
    photo: t.igPhoto,
    connectedAt: t.connectedAt
  });
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
    const fields = [
      'id', 'caption', 'media_type', 'media_product_type',
      'media_url', 'thumbnail_url', 'permalink', 'timestamp',
      'like_count', 'comments_count'
    ].join(',');
    const data = await graph(`${GRAPH}/${t.igId}/media`
      + `?fields=${fields}&limit=${limit}&access_token=${t.pageToken}`);

    const posts = (data.data || []).map(m => ({
      id: m.id,
      caption: m.caption || '',
      type: m.media_type,
      isReel: m.media_product_type === 'REELS',
      // para vídeo/reel a Meta entrega thumbnail_url; imagem usa media_url
      thumb: m.thumbnail_url || m.media_url || '',
      permalink: m.permalink,
      timestamp: m.timestamp,
      likes: m.like_count ?? null,
      comments: m.comments_count ?? null
    }));

    postsCache = { at: Date.now(), data: posts };
    res.json({ connected: true, posts });
  } catch (e) {
    console.error('Posts IG:', e.message);
    // se o cache tiver algo, devolve mesmo assim
    if (postsCache.data.length) return res.json({ connected: true, posts: postsCache.data, stale: true });
    res.status(502).json({ connected: true, posts: [], error: e.message });
  }
});

// ============================================================
//  5) Desconectar (protegido por ADMIN_KEY)
// ============================================================
app.post('/auth/logout', (req, res) => {
  if (req.get('x-admin-key') !== ADMIN_KEY)
    return res.status(401).json({ ok: false });
  clearTokens();
  postsCache = { at: 0, data: [] };
  res.json({ ok: true });
});

// ============================================================
//  6) (opcional) Renovar o token de longa duração
//     Rode periodicamente (ex.: cron mensal) para não expirar.
// ============================================================
app.post('/auth/refresh', async (req, res) => {
  if (req.get('x-admin-key') !== ADMIN_KEY)
    return res.status(401).json({ ok: false });
  const t = loadTokens();
  if (!t) return res.status(409).json({ ok: false, msg: 'não conectado' });
  try {
    const long = await graph(`${GRAPH}/oauth/access_token`
      + `?grant_type=fb_exchange_token`
      + `&client_id=${META_APP_ID}`
      + `&client_secret=${META_APP_SECRET}`
      + `&fb_exchange_token=${t.userToken}`);
    // renova também o page token
    const pages = await graph(`${GRAPH}/me/accounts`
      + `?fields=id,access_token&access_token=${long.access_token}`);
    const pg = (pages.data || []).find(p => p.id === t.pageId);
    saveTokens({ ...t, userToken: long.access_token, pageToken: pg ? pg.access_token : t.pageToken, refreshedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/health', (_req, res) => res.send('SG1 Meta backend ativo ✅'));

app.listen(PORT, () => console.log(`SG1 backend rodando na porta ${PORT}`));

// OpenAI-compatible Telegram Bot — Cloudflare Worker (v4)
// Navigation: ONE panel message that is edited in place (editMessageText) —
// going into sub-pages and pressing Back rewrites the same message, no message spam.
// Roles: admin (full, private only) / authorized user (chat, own ID, own history) / others (own ID only).
// Privacy: secret-looking messages are deleted & never stored/forwarded; keys only ever shown masked.
// Secrets: BOT_TOKEN, OPENAI_API_KEY (default key), WEBHOOK_SECRET
// Plain vars: ADMIN_IDS, OPENAI_MODEL, OPENAI_BASE_URL, SYSTEM_PROMPT
// KV: AUTH_KV — auth lists, admins, per-user history, key pool, flows, config, stats

const MAX_TG = 4000, HISTORY_TURNS = 12, RATE_PER_MIN = 20;
const SECRET_RE = /(sk-[A-Za-z0-9_-]{16,}|[0-9]{6,}:[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}|\b[A-Za-z0-9_-]{40}\b|\b[0-9a-fA-F]{64}\b|(api[_-]?key|secret|token|passwd|password|密钥|令牌|密码)\s*[:：=]\s*\S{8,})/i;
function looksSecret(text) {
  if (SECRET_RE.test(text)) return true;
  const t = String(text || "").trim();
  // A lone long random-looking string (e.g. a pasted Cloudflare/API token) counts as a secret.
  if (/^[A-Za-z0-9_\-+\/.=]{24,}$/.test(t) && /\d/.test(t) && /[A-Za-z]/.test(t) && (/[A-Z]/.test(t) || /[-_+/]/.test(t))) return true;
  return false;
}
async function tg(token, method, body) {
  try {
    const r = await fetchTimeout(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }, 20000);
    return await r.json().catch(() => ({}));
  } catch (e) { return { ok: false, description: String(e.message || e) }; }
}
function splitText(t) {
  const str = String(t || ""); if (str.length <= MAX_TG) return str ? [str] : [];
  const out = []; let rest = str;
  while (rest.length > MAX_TG) {
    const win = rest.slice(0, MAX_TG); let cut = -1;
    for (const sep of ["\n\n", "\n", "。", "！", "？", ". ", "；", "，", " "]) { const i = win.lastIndexOf(sep); if (i > MAX_TG * 0.5) { cut = i + sep.length; break; } }
    if (cut < 0) cut = MAX_TG;
    out.push(rest.slice(0, cut)); rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}
async function send(env, chatId, text, extra) { for (const part of splitText(text)) { const res = await tg(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: part, ...(extra || {}) }); if (res.ok) await trackBotMsg(env, chatId, res.result?.message_id, 0); else if (extra?.parse_mode) { const r2 = await tg(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: extra.parse_mode === "HTML" ? part.replace(/<[^>]+>/g, "") : part }); if (r2.ok) await trackBotMsg(env, chatId, r2.result?.message_id, 0); } } }
async function tryDelete(env, chatId, messageId) { try { const r = await tg(env.BOT_TOKEN, "deleteMessage", { chat_id: chatId, message_id: messageId }); return !!r.ok; } catch { return false; } }
const kvGet = async (env, k, d) => { try { const v = await env.AUTH_KV.get(k, "json"); return v ?? d; } catch { return d; } };
const kvPut = (env, k, v, ttl) => env.AUTH_KV.put(k, JSON.stringify(v), ttl ? { expirationTtl: ttl } : undefined);
// ---------- D1 data layer: high-write data (history, group log, stats, rate) lives in D1 (100k writes/day on the free plan vs KV's 1k); config stays in KV. Every helper falls back to KV when D1 is absent. ----------
const hasDb = (env) => !!env.DB;
async function dbHistPut(env, chatId, userId, history, memo, last) {
  if (!hasDb(env)) return false;
  try {
    await env.DB.prepare("INSERT INTO hist (chat_id, user_id, data, memo, last, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, user_id) DO UPDATE SET data=excluded.data, memo=excluded.memo, last=excluded.last, updated_at=excluded.updated_at")
      .bind(String(chatId), String(userId), JSON.stringify(history || []), memo || "", last ?? null, Date.now()).run();
    return true;
  } catch { return false; }
}
async function loadConvo(env, chatId, userId) {
  if (hasDb(env)) {
    try {
      const row = await env.DB.prepare("SELECT data, memo, last FROM hist WHERE chat_id=? AND user_id=?").bind(String(chatId), String(userId)).first();
      if (row) return { history: JSON.parse(row.data || "[]"), memo: row.memo || "", last: row.last || null };
    } catch {}
  }
  const history = await kvGet(env, `hist:${chatId}:${userId}`, []);
  const memo = await kvGet(env, `histmemo:${chatId}:${userId}`, "");
  const last = await kvGet(env, `lastprompt:${chatId}:${userId}`, null);
  if ((history.length || memo || last) && hasDb(env)) await dbHistPut(env, chatId, userId, history, memo, last);
  return { history, memo, last };
}
async function saveConvo(env, chatId, userId, history, memo, last) {
  if (await dbHistPut(env, chatId, userId, history, memo, last)) return;
  await kvPut(env, `hist:${chatId}:${userId}`, history, 60 * 60 * 24);
  await kvPut(env, `histmemo:${chatId}:${userId}`, memo || "", 60 * 60 * 24);
  if (last !== undefined && last !== null) await kvPut(env, `lastprompt:${chatId}:${userId}`, last, 60 * 60 * 6);
}
async function setLast(env, chatId, userId, last) {
  if (hasDb(env)) {
    try { await env.DB.prepare("INSERT INTO hist (chat_id, user_id, data, memo, last, updated_at) VALUES (?, ?, '[]', '', ?, ?) ON CONFLICT(chat_id, user_id) DO UPDATE SET last=excluded.last, updated_at=excluded.updated_at").bind(String(chatId), String(userId), last, Date.now()).run(); return; } catch {}
  }
  await kvPut(env, `lastprompt:${chatId}:${userId}`, last, 60 * 60 * 6);
}
async function dbHistClear(env, chatId, userId) {
  if (hasDb(env)) { try { await env.DB.prepare("DELETE FROM hist WHERE chat_id=? AND user_id=?").bind(String(chatId), String(userId)).run(); } catch {} }
  await env.AUTH_KV.delete(`hist:${chatId}:${userId}`); await env.AUTH_KV.delete(`histmemo:${chatId}:${userId}`); await env.AUTH_KV.delete(`lastprompt:${chatId}:${userId}`);
}
async function getStats(env) {
  if (hasDb(env)) { try { const row = await env.DB.prepare("SELECT data FROM stats WHERE id=1").first(); if (row) return JSON.parse(row.data || "{}"); } catch {} }
  return kvGet(env, "stats", { messages: 0, users: {} });
}
async function bumpStats(env, userId) {
  const st = await getStats(env);
  st.messages = (st.messages || 0) + 1; st.users = st.users || {}; st.users[userId] = Date.now();
  if (hasDb(env)) { try { await env.DB.prepare("INSERT INTO stats (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").bind(JSON.stringify(st)).run(); return; } catch {} }
  await kvPut(env, "stats", st);
}
async function ecoOn(env) { return (await kvGet(env, "config:eco", "")) === new Date().toISOString().slice(0, 10); }
async function kvGuardOn(env) { return (await kvGet(env, "config:kvguard", "")) === new Date().toISOString().slice(0, 10); }
let _dbx = false;
async function ensureDbX(env) {
  if (_dbx || !hasDb(env)) return;
  _dbx = true;
  try { await env.DB.prepare("ALTER TABLE botmsgs ADD COLUMN temp INTEGER DEFAULT 0").run(); } catch {}
  try {
    await env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS spamlog (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, ts INTEGER, user_id TEXT, name TEXT, category TEXT, reason TEXT, text TEXT)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_glog_chat_ts ON glog (chat_id, ts)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_spamlog_chat ON spamlog (chat_id, ts)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_hist_upd ON hist (updated_at)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS members (chat_id TEXT, user_id TEXT, name TEXT, lang TEXT, first_seen INTEGER, last_seen INTEGER, msg_count INTEGER, joined_at INTEGER, left_at INTEGER, PRIMARY KEY (chat_id, user_id))"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS botmsgs (chat_id TEXT, message_id INTEGER, ts INTEGER, pin INTEGER DEFAULT 0, temp INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id))"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_botmsgs_ts ON botmsgs (ts)")
    ]);
  } catch {}
}
async function cacheGet(env, k) {
  await ensureDbX(env);
  if (hasDb(env)) { try { const r = await env.DB.prepare("SELECT v FROM cache WHERE k = ?").bind(k).first(); if (r?.v) return JSON.parse(r.v); } catch {} }
  return kvGet(env, k, null);
}
async function cachePut(env, k, v) {
  await ensureDbX(env);
  if (hasDb(env)) { try { await env.DB.prepare("INSERT INTO cache (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, JSON.stringify(v)).run(); return; } catch {} }
  await kvPut(env, k, v);
}
async function spamLogAdd(env, chatId, rec) {
  await ensureDbX(env);
  if (hasDb(env)) { try { await env.DB.prepare("INSERT INTO spamlog (chat_id, ts, user_id, name, category, reason, text) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(String(chatId), rec.t, String(rec.u), rec.n || "", rec.category || "", rec.reason || "", rec.x || "").run(); return; } catch {} }
  const slog = await kvGet(env, `spamlog:${chatId}`, []); slog.push(rec); await kvPut(env, `spamlog:${chatId}`, slog.slice(-100), 60 * 60 * 24 * 7);
}
async function spamLogGet(env, chatId) {
  await ensureDbX(env);
  if (hasDb(env)) {
    try {
      const rs = await env.DB.prepare("SELECT ts, user_id, name, category, reason, text FROM spamlog WHERE chat_id = ? ORDER BY ts DESC LIMIT 100").bind(String(chatId)).all();
      const rows = (rs.results || []).map(r => ({ t: r.ts, u: r.user_id, n: r.name, category: r.category, reason: r.reason, x: r.text }));
      if (rows.length) return rows.reverse();
    } catch {}
  }
  return kvGet(env, `spamlog:${chatId}`, []);
}
async function migrateToD1(env) {
  if (!hasDb(env) || (await kvGet(env, "config:d1_migrated", 0))) return;
  let cursor;
  do {
    const page = await env.AUTH_KV.list({ prefix: "glog:", cursor });
    for (const item of page.keys) {
      const log = await kvGet(env, item.name, []);
      for (const e of log) { try { await env.DB.prepare("INSERT INTO glog (chat_id, ts, user_id, name, text) VALUES (?, ?, ?, ?, ?)").bind(item.name.slice(5), e.t || Date.now(), String(e.u || ""), e.n || "", e.x || "").run(); } catch {} }
      await env.AUTH_KV.delete(item.name);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const st = await env.AUTH_KV.get("stats", "json");
  if (st) { try { await env.DB.prepare("INSERT INTO stats (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").bind(JSON.stringify(st)).run(); } catch {} }
  await kvPut(env, "config:d1_migrated", 1);
}
const maskKey = (k) => !k ? "未设置" : (k.length <= 12 ? "****" : `${k.slice(0, 6)}...${k.slice(-4)}`);
const normBase = (b) => String(b || "https://api.openai.com/v1").trim().replace(/\/$/, "");

// ---------- Pages & in-place rendering ----------
const pg = (text, rows) => ({ text, rows });
const ROW_PANEL = [{ text: "⬅ 返回管理面板", callback_data: "panel" }];
async function sendPage(env, chatId, page) {
  const base = { chat_id: chatId, text: page.text.slice(0, MAX_TG), reply_markup: { inline_keyboard: page.rows || [] } };
  if (page.html) {
    const r = await tg(env.BOT_TOKEN, "sendMessage", { ...base, parse_mode: "HTML" });
    if (r.ok) { await trackBotMsg(env, chatId, r.result?.message_id, 0); return r; }
    const r2 = await tg(env.BOT_TOKEN, "sendMessage", { ...base, text: base.text.replace(/<[^>]+>/g, "") });
    if (r2.ok) await trackBotMsg(env, chatId, r2.result?.message_id, 0);
    return r2;
  }
  const r = await tg(env.BOT_TOKEN, "sendMessage", base);
  if (r.ok) await trackBotMsg(env, chatId, r.result?.message_id, 0);
  return r;
}
async function editPage(env, chatId, messageId, page) {
  if (messageId) {
    const base = { chat_id: chatId, message_id: messageId, text: page.text.slice(0, MAX_TG), reply_markup: { inline_keyboard: page.rows || [] } };
    const notModified = (r) => /not modified/i.test(r?.description || "");
    if (page.html) {
      const r = await tg(env.BOT_TOKEN, "editMessageText", { ...base, parse_mode: "HTML" });
      if (r.ok || notModified(r)) return r;
      const r2 = await tg(env.BOT_TOKEN, "editMessageText", { ...base, text: base.text.replace(/<[^>]+>/g, "") });
      if (r2.ok || notModified(r2)) return r2;
    } else {
      const r = await tg(env.BOT_TOKEN, "editMessageText", base);
      if (r.ok || notModified(r)) return r;
    }
  }
  return sendPage(env, chatId, page);
}
const resultPage = (text, extraRows) => pg(text, [...(extraRows || []), ROW_PANEL]);

async function isAdmin(env, userId) {
  if (String(env.ADMIN_IDS || "").split(",").map(x => x.trim()).includes(String(userId))) return true;
  return (await kvGet(env, "admins", [])).map(String).includes(String(userId));
}
const isOwner = (env, userId) => String(env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean).includes(String(userId));
async function isAllowed(env, chat, userId) {
  if (await isAdmin(env, userId)) return true;
  if (chat.type === "private") return (await kvGet(env, "allowed_users", [])).map(String).includes(String(userId));
  return (await kvGet(env, "allowed_groups", [])).map(String).includes(String(chat.id));
}
async function rateOk(env, userId) {
  if (hasDb(env)) {
    try {
      const row = await env.DB.prepare("INSERT INTO rate (user_id, minute, n) VALUES (?, ?, 1) ON CONFLICT(user_id, minute) DO UPDATE SET n = n + 1 RETURNING n").bind(String(userId), Math.floor(Date.now() / 60000)).first();
      if (row) return (row.n || 1) <= RATE_PER_MIN;
    } catch {}
  }
  const key = `rate:${userId}:${Math.floor(Date.now() / 60000)}`, n = Number(await env.AUTH_KV.get(key)) || 0;
  if (n >= RATE_PER_MIN) return false;
  await env.AUTH_KV.put(key, String(n + 1), { expirationTtl: 70 }); return true;
}
const modList = async (env, key, val, add) => { let list = (await kvGet(env, key, [])).map(String); list = add ? [...new Set([...list, String(val)])] : list.filter(x => x !== String(val)); await kvPut(env, key, list); return list; };

// ---------- Key pool ----------
async function getStoredKeys(env) { return (await kvGet(env, "keys", [])).filter(e => e && e.key); }
async function getPool(env) {
  const pool = [...await getStoredKeys(env)];
  const override = await kvGet(env, "config:envkey", null);
  if (override?.disabled) return pool;
  if (override && override.key) pool.push({ name: override.name || "默认", base_url: normBase(override.base_url), key: override.key, isEnv: true, ...(override.api ? { api: override.api } : {}), ...(override.ua ? { ua: override.ua } : {}) });
  else if (env.OPENAI_API_KEY && !pool.some(e => e.key === env.OPENAI_API_KEY)) pool.push({ name: "默认", base_url: normBase(env.OPENAI_BASE_URL), key: env.OPENAI_API_KEY, isEnv: true });
  return pool;
}
async function orderedPool(env) {
  const pool = await getPool(env); if (!pool.length) return pool;
  const mode = await kvGet(env, "config:key_mode", "fallback");
  const activeName = await kvGet(env, "config:active_key", null);
  let start = Math.max(0, pool.findIndex(e => e.name === activeName));
  if (mode === "rotate") { const rr = Number(await kvGet(env, "config:rr", 0)) || 0; start = rr % pool.length; await kvPut(env, "config:rr", rr + 1); }
  if (mode === "single") return [pool[start]];
  return [...pool.slice(start), ...pool.slice(0, start)];
}
async function fetchTimeout(url, opts, ms = 60000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { ...(opts || {}), signal: ctl.signal }); clearTimeout(t); return r; }
  catch (e) { clearTimeout(t); if (e?.name === "AbortError") throw new Error("请求超时，接口长时间没有响应"); throw e; }
}
function uaH(entry, h) { if (entry && entry.ua) h["user-agent"] = entry.ua; return h; }
async function tryChat(env, entry, model, system, history, timeoutMs) {
  const r = await fetchTimeout(`${normBase(entry.base_url)}/chat/completions`, { method: "POST", headers: uaH(entry, { "content-type": "application/json", authorization: `Bearer ${entry.key}` }), body: JSON.stringify({ model, messages: [{ role: "system", content: system }, ...history] }) }, timeoutMs || 60000);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
  return data.choices?.[0]?.message?.content || "(empty reply)";
}
// Some providers (e.g. api.openai.com) disabled /chat/completions and require the Responses API.
async function apiTypeFor(env, entry) {
  if (entry.api === "responses" || entry.api === "chat") return entry.api;
  return (await cacheGet(env, `apitype:${entry.base_url}`)) || "chat";
}
function toResponsesContent(content) {
  if (typeof content === "string") return content;
  return content.map(pt => pt.type === "image_url" ? { type: "input_image", image_url: pt.image_url?.url || "" } : { type: "input_text", text: pt.text || "" });
}
async function callResponses(entry, model, system, history, timeoutMs) {
  const r = await fetchTimeout(`${normBase(entry.base_url)}/responses`, { method: "POST", headers: uaH(entry, { "content-type": "application/json", authorization: `Bearer ${entry.key}` }), body: JSON.stringify({ model, instructions: system, input: history.map(m => ({ role: m.role, content: toResponsesContent(m.content) })) }) }, timeoutMs || 60000);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
  let text = "";
  for (const item of data.output || []) if (item.type === "message") for (const c of item.content || []) if (c.type === "output_text") text += c.text;
  if (!text && typeof data.output_text === "string") text = data.output_text;
  if (!text) throw new Error("Responses 接口返回为空");
  return text;
}
async function tryEntry(env, entry, model, system, history, timeoutMs) {
  const kind = await apiTypeFor(env, entry);
  if (kind === "responses") return callResponses(entry, model, system, history, timeoutMs);
  try { return await tryChat(env, entry, model, system, history, timeoutMs); }
  catch (e) {
    if (/responses/i.test(e.message || "")) {
      const out = await callResponses(entry, model, system, history, timeoutMs);
      if (!(await kvGuardOn(env))) await cachePut(env, `apitype:${entry.base_url}`, "responses");
      return out;
    }
    throw e;
  }
}
async function orderCandidates(env, opts) {
  const model = opts?.model || (await kvGet(env, "config:model", null)) || env.OPENAI_MODEL || "kilo-auto/free";
  let system = opts?.system || (await kvGet(env, "config:system_prompt", null)) || env.SYSTEM_PROMPT || "You are a helpful assistant. Reply in the user's language.";
  let candidates = await orderedPool(env);
  // Smart avoidance: keys the latest health check found broken (within 24h) go last — still tried, just not first.
  const health = await kvGet(env, "config:health", null);
  if (health?.results && candidates.length > 1) {
    const bad = new Set(Object.entries(health.results).filter(([, r]) => !r.ok && Date.now() - (r.at || 0) < 24 * 3600 * 1000).map(([n]) => n));
    if (bad.size && bad.size < candidates.length) candidates = [...candidates.filter(e => !bad.has(e.name)), ...candidates.filter(e => bad.has(e.name))];
  }
  if (opts?.key) { const i = candidates.findIndex(e => e.name === opts.key); if (i > 0) { const [e] = candidates.splice(i, 1); candidates.unshift(e); } }
  return { model, system, candidates };
}
async function getFallbackCfg(env) { const c = await kvGet(env, "config:fallback", null); return { timeout: [15, 25, 40, 60].includes(c?.timeout) ? c.timeout : 25, chain: Array.isArray(c?.chain) ? c.chain.filter(x => x && x.key && x.model).slice(0, 5) : [] }; }
async function buildRoutes(env, opts, model, candidates) {
  if (opts?.key || opts?.model) return null;
  const cfg = await getFallbackCfg(env);
  if (!cfg.chain.length || !candidates.length) return null;
  const pool = await getPool(env);
  const routes = [{ entry: candidates[0], model }];
  const seen = new Set([`${candidates[0].name}|${model}`]);
  for (const c of cfg.chain) {
    const e = pool.find(x => x.name === c.key);
    if (!e) continue;
    const k = `${e.name}|${c.model}`;
    if (seen.has(k)) continue;
    seen.add(k); routes.push({ entry: e, model: c.model });
  }
  return routes.length > 1 ? { routes, timeout: cfg.timeout } : null;
}
async function askAIR(env, history, opts) {
  const { model, system, candidates } = await orderCandidates(env, opts);
  if (!candidates.length) throw new Error("还没有配置任何 Key，请管理员在管理面板添加");
  const fr = await buildRoutes(env, opts, model, candidates);
  let lastErr;
  if (fr) {
    for (let i = 0; i < fr.routes.length; i++) { const r = fr.routes[i]; try { return { text: await tryEntry(env, r.entry, r.model, system, history, fr.timeout * 1000), idx: i, keyName: r.entry.name, model: r.model }; } catch (e) { lastErr = e; } }
    throw lastErr || new Error("主模型和备用模型都调用失败");
  }
  for (const entry of candidates) { try { return { text: await tryEntry(env, entry, model, system, history), idx: 0, keyName: entry.name, model }; } catch (e) { lastErr = e; } }
  throw lastErr || new Error("所有 Key 都调用失败");
}
async function askAI(env, history, opts) { return (await askAIR(env, history, opts)).text; }
async function readSse(r, onDelta, stallMs = 25000, totalMs = 40000) {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", acc = "", emitted = false;
  const started = Date.now();
  const readChunk = () => Promise.race([
    reader.read(),
    new Promise((_, rej) => setTimeout(() => { reader.cancel().catch(() => {}); rej(new Error(`流式输出停滞（${Math.round(stallMs / 1000)} 秒无新内容）`)); }, stallMs)),
  ]);
  try {
    for (;;) {
      if (Date.now() - started > totalMs) { await reader.cancel().catch(() => {}); throw new Error(`流式输出总时长超时（${Math.round(totalMs / 1000)} 秒）`); }
      const { done, value } = await readChunk();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let j; try { j = JSON.parse(payload); } catch { continue; }
        const d = j.choices?.[0]?.delta?.content || (j.type === "response.output_text.delta" ? (j.delta || "") : "");
        if (d) { acc += d; emitted = true; await onDelta(acc); }
        if (j.type === "error") throw new Error(j.error?.message || "流式接口报错");
      }
    }
  } catch (e) { if (emitted) return acc + "\n\n（连接中断，回答可能不完整）"; throw e; }
  if (!emitted) throw new Error("流式输出为空");
  return acc;
}
async function streamChat(env, entry, model, system, history, onText, fetchMs = 50000, stallMs, totalMs) {
  const r = await fetchTimeout(`${normBase(entry.base_url)}/chat/completions`, { method: "POST", headers: uaH(entry, { "content-type": "application/json", authorization: `Bearer ${entry.key}` }), body: JSON.stringify({ model, stream: true, messages: [{ role: "system", content: system }, ...history] }) }, fetchMs);
  if (!r.ok) { const data = await r.json().catch(() => ({})); throw new Error(data.error?.message || `HTTP ${r.status}`); }
  if (!r.body) throw new Error("接口不支持流式输出");
  return readSse(r, onText, stallMs, totalMs);
}
async function streamResponses(entry, model, system, history, onText, fetchMs = 50000, stallMs, totalMs) {
  const r = await fetchTimeout(`${normBase(entry.base_url)}/responses`, { method: "POST", headers: uaH(entry, { "content-type": "application/json", authorization: `Bearer ${entry.key}` }), body: JSON.stringify({ model, stream: true, instructions: system, input: history.map(m => ({ role: m.role, content: toResponsesContent(m.content) })) }) }, fetchMs);
  if (!r.ok) { const data = await r.json().catch(() => ({})); throw new Error(data.error?.message || `HTTP ${r.status}`); }
  if (!r.body) throw new Error("接口不支持流式输出");
  return readSse(r, onText, stallMs, totalMs);
}
async function tryEntryStream(env, entry, model, system, history, onText, fetchMs, stallMs, totalMs) {
  const kind = await apiTypeFor(env, entry);
  if (kind === "responses") return streamResponses(entry, model, system, history, onText, fetchMs, stallMs, totalMs);
  try { return await streamChat(env, entry, model, system, history, onText, fetchMs, stallMs, totalMs); }
  catch (e) {
    if (/responses/i.test(e.message || "")) {
      const out = await streamResponses(entry, model, system, history, onText, fetchMs, stallMs, totalMs);
      if (!(await kvGuardOn(env))) await cachePut(env, `apitype:${entry.base_url}`, "responses");
      return out;
    }
    throw e;
  }
}
async function askAIStreamR(env, history, opts, onText) {
  const { model, system, candidates } = await orderCandidates(env, opts);
  if (!candidates.length) throw new Error("还没有配置任何 Key，请管理员在管理面板添加");
  const fr = await buildRoutes(env, opts, model, candidates);
  let lastErr;
  if (fr) {
    for (let i = 0; i < fr.routes.length; i++) {
      const r = fr.routes[i];
      let emitted = false;
      const wrapped = async (t) => { emitted = true; await onText(t); };
      try { return { text: await tryEntryStream(env, r.entry, r.model, system, history, wrapped, fr.timeout * 1000 + 5000, fr.timeout * 1000, (fr.timeout + 20) * 1000), idx: i, keyName: r.entry.name, model: r.model }; }
      catch (e) { lastErr = e; if (emitted) throw e; }
    }
    throw lastErr || new Error("主模型和备用模型都调用失败");
  }
  for (const entry of candidates) { try { return { text: await tryEntryStream(env, entry, model, system, history, onText), idx: 0, keyName: entry.name, model }; } catch (e) { lastErr = e; } }
  throw lastErr || new Error("所有 Key 都调用失败");
}
async function askAIStream(env, history, opts, onText) { return (await askAIStreamR(env, history, opts, onText)).text; }
async function fetchModels(env, entry) {
  const r = await fetchTimeout(`${normBase(entry.base_url)}/models`, { headers: uaH(entry, { authorization: `Bearer ${entry.key}` }) }, 30000);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
  return (data.data || []).map(m => m.id).filter(Boolean);
}

// ---------- Group features: message log, summary, search, stats ----------
const GLOG_MAX = 1500;
const fmtT = (ts, withDate) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", ...(withDate ? { month: "2-digit", day: "2-digit" } : {}), hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ts));
async function logGroupMessage(env, msg) {
  if (!msg.text || msg.text.startsWith("/")) return;
  if (await ecoOn(env)) return;
  if (hasDb(env)) {
    await ensureDbX(env);
    try {
      const mts = msg.date ? msg.date * 1000 : Date.now();
      await env.DB.prepare("INSERT INTO members (chat_id, user_id, name, lang, first_seen, last_seen, msg_count, joined_at, left_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, NULL) ON CONFLICT(chat_id, user_id) DO UPDATE SET name=excluded.name, lang=excluded.lang, last_seen=excluded.last_seen, msg_count=members.msg_count+1, left_at=NULL").bind(String(msg.chat.id), String(msg.from.id), (msg.from.first_name || "") + (msg.from.last_name ? " " + msg.from.last_name : ""), msg.from.language_code || "", mts, mts).run();
    } catch {}
    try {
      await env.DB.prepare("INSERT INTO glog (chat_id, ts, user_id, name, text) VALUES (?, ?, ?, ?, ?)")
        .bind(String(msg.chat.id), msg.date ? msg.date * 1000 : Date.now(), String(msg.from.id), (msg.from.first_name || "") + (msg.from.last_name ? " " + msg.from.last_name : ""), msg.text.slice(0, 500)).run();
      if (Math.random() < 0.02) await env.DB.prepare("DELETE FROM glog WHERE chat_id = ? AND ts < ?").bind(String(msg.chat.id), Date.now() - 72 * 3600 * 1000).run();
      return;
    } catch {}
  }
  const key = `glog:${msg.chat.id}`;
  const log = await kvGet(env, key, []);
  log.push({ t: msg.date ? msg.date * 1000 : Date.now(), u: msg.from.id, n: (msg.from.first_name || "") + (msg.from.last_name ? " " + msg.from.last_name : ""), x: msg.text.slice(0, 500) });
  await kvPut(env, key, log.slice(-GLOG_MAX), 60 * 60 * 72);
}
async function groupLogSince(env, chatId, hours) {
  const since = Date.now() - hours * 3600 * 1000;
  if (hasDb(env)) {
    try {
      const res = await env.DB.prepare("SELECT ts, user_id, name, text FROM glog WHERE chat_id = ? AND ts >= ? ORDER BY ts ASC LIMIT 1500").bind(String(chatId), since).all();
      if (res?.results?.length) return res.results.map(r => ({ t: r.ts, u: Number(r.user_id), n: r.name, x: r.text }));
    } catch {}
  }
  return (await kvGet(env, `glog:${chatId}`, [])).filter(e => e.t >= since);
}
async function buildSummary(env, chatId, hours) {
  const entries = await groupLogSince(env, chatId, hours);
  if (entries.length < 3) return null;
  let transcript = "", count = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const line = `[${fmtT(entries[i].t)}] ${entries[i].n}: ${entries[i].x}\n`;
    if (transcript.length + line.length > 13000) break;
    transcript = line + transcript; count++;
  }
  const prompt = `下面是群聊最近 ${hours} 小时内的聊天记录（共 ${entries.length} 条${count < entries.length ? `，太长了只取了最近 ${count} 条` : ""}）。请用中文做一份简洁的群聊总结，分点输出：\n1) 主要聊了哪些话题\n2) 达成的结论或决定（如有）\n3) 提到的待办/未解决的问题（如有）\n4) 最活跃的成员\n不要逐条复述原文，不要编造记录里没有的内容。\n\n聊天记录：\n${transcript}`;
  const reply = await askAI(env, [{ role: "user", content: prompt }]);
  return { title: `📝 最近 ${hours} 小时群聊总结（${entries.length} 条消息）`, body: reply };
}
const escHtml = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function summaryHtml(title, body) {
  // Telegram style: bold title + short visible intro, the rest inside an expandable (collapsible) blockquote.
  const lines = String(body).split("\n");
  const intro = []; let rest = [], len = 0, started = false;
  for (const line of lines) { if (!started && line.trim() && len < 300) { intro.push(line); len += line.length + 1; } else { started = true; rest.push(line); } }
  while (rest.length && !rest[0].trim()) rest.shift();
  const head = `<b>${escHtml(title)}</b>` + (intro.length ? "\n" + escHtml(intro.join("\n")) : "");
  if (!rest.length) return head;
  let restText = rest.join("\n");
  const overhead = head.length + "<blockquote expandable></blockquote>".length + 1;
  const room = 3900 - overhead;
  if (escHtml(restText).length > room) restText = restText.slice(0, Math.max(0, room)) + "\n…（内容过长，已截断）";
  return head + `\n<blockquote expandable>${escHtml(restText)}</blockquote>`;
}
function collapsibleHtml(body) {
  // Long reply in ONE message: a short visible intro + the rest in an expandable (collapsible) blockquote.
  // Returns null when the reply is short or cannot fit in a single message (caller falls back to splitting).
  const lines = String(body).split("\n");
  const intro = []; let rest = [], len = 0, started = false;
  for (const line of lines) { if (!started && line.trim() && len < 350) { intro.push(line); len += line.length + 1; } else { started = true; rest.push(line); } }
  while (rest.length && !rest[0].trim()) rest.shift();
  if (!rest.length) return null;
  const html = (intro.length ? escHtml(intro.join("\n")) + "\n" : "") + `<blockquote expandable>${escHtml(rest.join("\n"))}</blockquote>`;
  return html.length <= MAX_TG ? html : null;
}
async function groupStatsText(env, chatId) {
  const entries = await groupLogSince(env, chatId, 24);
  if (!entries.length) return "📊 最近 24 小时还没有记录到群消息。\n（只有授权群、且机器人能看到的消息才会被记录：需要关掉 BotFather 的隐私模式，或把机器人设为群管理员）";
  const byUser = {};
  for (const e of entries) { byUser[e.n] = byUser[e.n] || { n: e.n, c: 0 }; byUser[e.n].c++; }
  const top = Object.values(byUser).sort((a, b) => b.c - a.c).slice(0, 5);
  return `📊 最近 24 小时群活跃\n总消息：${entries.length} 条，发言人数：${Object.keys(byUser).length}\n\n话痨榜：\n` + top.map((u, i) => `${i + 1}. ${u.n} — ${u.c} 条`).join("\n");
}
function searchGroupLog(entries, kw) {
  const k = kw.toLowerCase();
  return entries.filter(e => e.x.toLowerCase().includes(k)).slice(-10).reverse();
}
function fmtHits(kw, hits) {
  return hits.length
    ? `🔍 「${kw}」最近 ${hits.length} 条匹配：\n` + hits.map(e => `[${fmtT(e.t, true)}] ${e.n}：${e.x.slice(0, 90)}`).join("\n")
    : `🔍 没找到包含「${kw}」的群消息（只搜机器人记录到的消息）。`;
}
async function isGroupAdmin(env, chatId, userId) {
  if (await isAdmin(env, userId)) return true;
  try { const r = await tg(env.BOT_TOKEN, "getChatMember", { chat_id: chatId, user_id: userId }); return ["creator", "administrator"].includes(r?.result?.status); } catch { return false; }
}
const pgGroupMenu = async (env, chatId) => {
  const cfg = await kvGet(env, `gcfg:${chatId}`, { auto: 0 });
  const cur = Number(cfg.auto) || 0;
  const autoLabel = (h) => (cur === h ? "✅ " : "") + (h === 0 ? "关" : `${h}h`);
  return pg(`👥 群功能菜单\n总结和检索基于机器人记录到的群消息（仅授权群）。\n⏰ 自动总结：${cur ? `已开启，每 ${cur} 小时一次` : "已关闭"}（点最下面一行切换，仅群主/群管理员可改）\n🛡 AI 反垃圾：${cfg.spam ? "已开启（判定垃圾会删除、记 1 分并请管理员核验，满 3 分移出）" : "已关闭（记分管理仍可手动使用：回复成员消息发 /score）"}（仅群主/群管理员可改）\n🎛 本群模型：${cfg.model ? `${cfg.key ? `Key「${cfg.key}」· ` : ""}${cfg.model}` : "跟随全局"}${cfg.prompt ? " · 已设本群提示词" : ""}（仅群主/群管理员可改）`, [
    [{ text: "📝 AI 消息总结", callback_data: "gsummary" }, { text: "🔍 关键词检索", callback_data: "gsearch" }],
    [{ text: "📊 活跃统计", callback_data: "gstats" }],
    [{ text: cfg.spam ? "🛡 反垃圾 ✅ 开" : "🛡 反垃圾 关", callback_data: "gspam" }, { text: "🚨 垃圾记录", callback_data: "gspamlog" }],
    [{ text: "⚖️ 记分管理（满 3 分移出）", callback_data: "gscore" }, { text: "👥 成员数据", callback_data: "gmembers" }],
    [{ text: "🧹 自动删机器人消息", callback_data: "gautodel" }],
    [{ text: `🎛 本群模型：${cfg.model || "跟随全局"}`, callback_data: "gmodel" }],
    [{ text: "📝 本群提示词", callback_data: "gprompt" }, { text: "🧹 清除本群设置", callback_data: "gclear" }],
    [{ text: autoLabel(0), callback_data: "gauto:0" }, { text: autoLabel(6), callback_data: "gauto:6" }, { text: autoLabel(12), callback_data: "gauto:12" }, { text: autoLabel(24), callback_data: "gauto:24" }],
  ]);
};
async function pgGroupModels(env, chatId) {
  const back = [[{ text: "⬅ 返回群菜单", callback_data: "gmenu" }]];
  const pool = await getPool(env);
  if (!pool.length) return pg("还没有配置任何 Key。", back);
  const cfg = await kvGet(env, `gcfg:${chatId}`, {});
  const pinned = cfg.key ? pool.find(e => e.name === cfg.key) : null;
  const entry = pinned || (await orderedPool(env))[0];
  if (!entry) return pg("还没有配置任何 Key。", back);
  let models = [], fetchErr = "";
  try { models = await fetchModels(env, entry); } catch (e) { fetchErr = e.message; }
  const base = normBase(entry.base_url);
  const customs = (await getAllCustoms(env)).filter(c => c.base === base).map(c => c.name);
  await kvPut(env, `gmodellist:${chatId}`, { models, customs }, 600);
  const rows = [];
  if (!cfg.key) rows.push([{ text: (cfg.model ? "" : "✅ ") + "跟随全局模型", callback_data: "gmodel:clear" }]);
  models.forEach((m, i) => rows.push([{ text: ((cfg.model === m ? "✅ " : "") + m.slice(0, 30) + " " + modelCaps(m)).slice(0, 42), callback_data: `gmodel:${i}` }]));
  customs.forEach((m, i) => rows.push([{ text: ((cfg.model === m ? "✅ " : "✏️ ") + m.slice(0, 30) + " " + modelCaps(m)).slice(0, 42), callback_data: `gcmodel:${i}` }]));
  rows.push(...back);
  const head = cfg.key
    ? (pinned
      ? `🎛 本群模型\n本群的接口已由机器人管理员指定为 Key「${cfg.key}」，只能在这个 Key 的模型里换（要换 Key 请找机器人管理员）。\n当前模型：${cfg.model || "未指定"}`
      : `🎛 本群模型\n机器人管理员指定的 Key「${cfg.key}」已不存在，先按全局 Key「${entry.name}」的模型显示，请联系机器人管理员重新指定。`)
    : `🎛 给本群单独选模型\n用的是当前 Key「${entry.name}」接口的模型，选的只在本群生效；其他群和私聊仍用全局模型。`;
  return pg(head + (fetchErr ? `\n⚠️ 模型列表获取失败：${fetchErr}` : ""), rows);
}
// ---------- AI anti-spam (per-group opt-in) ----------
async function getGroupAdminIds(env, chatId) {
  const key = `gadmins:${chatId}`;
  const cached = await kvGet(env, key, null);
  if (cached && Date.now() - cached.at < 3600 * 1000) return cached.ids;
  try {
    const r = await tg(env.BOT_TOKEN, "getChatAdministrators", { chat_id: chatId });
    const ids = (r.result || []).map(m => String(m.user.id));
    if (!(await kvGuardOn(env))) await kvPut(env, key, { at: Date.now(), ids }, 60 * 60 * 2);
    return ids;
  } catch { return cached?.ids || []; }
}
async function judgeSpam(env, msg) {
  const pool = await orderedPool(env);
  if (!pool.length) return null;
  const model = (await kvGet(env, "config:model", null)) || env.OPENAI_MODEL || "kilo-auto/free";
  const system = "你是群聊垃圾消息检测器。判断用户消息是否为垃圾信息。只有明确属于以下类别才算垃圾：广告推广、博彩赌博、诈骗、色情低俗、引流加联系方式（微信/QQ/Telegram等）、虚假兼职招聘、刷屏灌水。正常聊天、提问、求助、玩笑、表达观点、分享正常链接都不算垃圾。不确定时判为不是垃圾（宁可放过，不可误杀）。只输出一个 JSON，不要任何其他文字：{\"spam\": true或false, \"category\": \"类别\", \"reason\": \"一句话理由\"}";
  const name = (msg.from.first_name || "") + (msg.from.last_name ? " " + msg.from.last_name : "");
  for (const entry of pool) {
    try {
      const out = await tryEntry(env, entry, model, system, [{ role: "user", content: `发送者：${name}\n消息内容：${msg.text.slice(0, 800)}` }]);
      const m = String(out).match(/\{[\s\S]*\}/);
      if (!m) return null;
      const v = JSON.parse(m[0]);
      return { spam: v.spam === true, category: String(v.category || "其他垃圾信息").slice(0, 20), reason: String(v.reason || "").slice(0, 100) };
    } catch { /* try next key */ }
  }
  return null;
}
function spamNoticeHtml(rec) {
  return `🛡 <b>垃圾信息已被删除</b>\n发送者：<a href="tg://user?id=${rec.u}">${escHtml(rec.n || "未知")}</a>（ID：${rec.u}）\n匹配类别：${escHtml(rec.category)}${rec.reason ? `\n判定理由：${escHtml(rec.reason)}` : ""}\n<blockquote expandable>原消息：${escHtml(rec.x)}</blockquote>\n记录已存档，管理员可在 /group 菜单「垃圾记录」中查处。`;
}
async function loadScores(env, chatId) { return (await cacheGet(env, `gscore:${chatId}`)) || {}; }
async function saveScores(env, chatId, all) { await cachePut(env, `gscore:${chatId}`, all); }
async function addScore(env, chatId, uid, name, delta, event) {
  const all = await loadScores(env, chatId);
  const u = all[uid] || { n: name || "", s: 0, events: [] };
  if (name) u.n = name;
  u.s = Math.max(0, (u.s || 0) + delta);
  if (event) u.events = [...(u.events || []), event].slice(-20);
  all[uid] = u;
  await saveScores(env, chatId, all);
  return u;
}
async function kickUser(env, chatId, uid) {
  const b = await tg(env.BOT_TOKEN, "banChatMember", { chat_id: chatId, user_id: uid });
  if (!b.ok) return false;
  await tg(env.BOT_TOKEN, "unbanChatMember", { chat_id: chatId, user_id: uid, only_if_banned: true }).catch(() => {});
  return true;
}
async function pgScoreUser(env, chatId, uid, nameHint) {
  const all = await loadScores(env, chatId);
  const u = all[uid];
  const name = u?.n || nameHint || String(uid);
  const sc = u?.s || 0;
  const evs = (u?.events || []).slice(-5).reverse().map(e => `• [${fmtT(e.t, true)}] ${e.kind === "ai" ? `AI 判定「${e.category}」${e.status === "pending" ? "（待核验）" : e.status === "cleared" ? "（核验：误判）" : "（核验：维持原判）"}` : (e.note || "管理员调整")} ${e.delta > 0 ? `+${e.delta}` : e.delta} 分`);
  let prof = "";
  if (hasDb(env)) {
    try {
      await ensureDbX(env);
      const m = await env.DB.prepare("SELECT lang, first_seen, last_seen, msg_count, joined_at, left_at FROM members WHERE chat_id = ? AND user_id = ?").bind(String(chatId), String(uid)).first();
      if (m) prof = `\n账号注册：${regEstimate(Number(uid))}\n界面语言：${m.lang || "未知"}（客户端语言，不代表地区；地区 Telegram 不提供）\n进群时间：${m.joined_at ? fmtT(m.joined_at, true) + "（机器人记录到的）" : "未知（在机器人入群之前加入）"}${m.left_at ? "｜已退群" : ""}\n发言统计：共 ${m.msg_count || 0} 条｜首次 ${m.first_seen ? fmtT(m.first_seen, true) : "未知"}｜最近 ${m.last_seen ? fmtT(m.last_seen, true) : "未知"}`;
    } catch {}
  }
  if (!prof) prof = `\n账号注册：${regEstimate(Number(uid))}\n（这个成员还没在机器人面前出现过，暂无进群/发言记录）`;
  return pg(`⚖️ 记分管理\n成员：${name}（${uid}）${prof}\n当前记分：${sc} / 3 分${sc === 2 ? "\n⚠️ 再加 1 分将达到 3 分，会被移出群聊" : ""}${evs.length ? `\n\n最近记录：\n${evs.join("\n")}` : ""}`, [
    [{ text: "➕ 加 1 分", callback_data: `sc:add:${uid}` }, { text: "➖ 减 1 分", callback_data: `sc:sub:${uid}` }],
    [{ text: "🧹 清零", callback_data: `sc:clear:${uid}` }, { text: "👢 移出群聊", callback_data: `sc:kick:${uid}` }],
    [{ text: "⬅ 记分列表", callback_data: "gscore" }, { text: "⬅ 群菜单", callback_data: "gmenu" }]
  ]);
}
const REG_OLD = [[1e6, "2013-08"], [1e7, "2014-02"], [3e7, "2014-08"], [6e7, "2015-03"], [1e8, "2015-10"], [1.5e8, "2016-06"], [2e8, "2017-02"], [2.5e8, "2017-09"], [3e8, "2018-04"], [3.5e8, "2018-11"], [4e8, "2019-05"], [4.5e8, "2019-11"], [5e8, "2020-05"], [5.5e8, "2020-11"], [6e8, "2021-05"], [6.5e8, "2021-11"], [7e8, "2022-06"], [7.5e8, "2022-12"], [8e8, "2023-08"], [8.5e8, "2024-03"], [9e8, "2024-10"], [1.05e9, "2025-05"]];
const REG_NEW = [[4.9e9, "2022-02"], [5.5e9, "2022-09"], [6e9, "2023-03"], [6.5e9, "2023-08"], [7e9, "2024-02"], [7.5e9, "2024-08"], [8e9, "2025-03"], [8.5e9, "2025-10"]];
function regEstimate(id) {
  const tbl = id >= 4.9e9 ? REG_NEW : id <= 1.05e9 ? REG_OLD : null;
  if (!tbl) return "号段特殊，无法估算";
  const toM = (t) => { const [y, m] = t.split("-").map(Number); return y * 12 + m; };
  if (id <= tbl[0][0]) return `约 ${tbl[0][1].replace("-", " 年 ")} 月（按 ID 号段估算）`;
  for (let i = 1; i < tbl.length; i++) {
    if (id <= tbl[i][0]) {
      const [id0, t0] = tbl[i - 1], [id1, t1] = tbl[i];
      const mm = Math.round(toM(t0) + (toM(t1) - toM(t0)) * (id - id0) / (id1 - id0));
      return `约 ${Math.floor((mm - 1) / 12)} 年 ${(mm - 1) % 12 + 1} 月（按 ID 号段估算，误差可达数月）`;
    }
  }
  const last = tbl[tbl.length - 1][1];
  return `约 ${last.replace("-", " 年 ")} 月之后（按 ID 号段估算）`;
}
async function trackMembership(env, msg) {
  if (!hasDb(env)) return;
  if (!(await kvGet(env, "allowed_groups", [])).map(String).includes(String(msg.chat.id))) return;
  await ensureDbX(env);
  const ts = msg.date ? msg.date * 1000 : Date.now();
  for (const m of msg.new_chat_members || []) {
    if (m.is_bot) continue;
    const nm = (m.first_name || "") + (m.last_name ? " " + m.last_name : "");
    try { await env.DB.prepare("INSERT INTO members (chat_id, user_id, name, lang, first_seen, last_seen, msg_count, joined_at, left_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL) ON CONFLICT(chat_id, user_id) DO UPDATE SET name=excluded.name, joined_at=excluded.joined_at, left_at=NULL").bind(String(msg.chat.id), String(m.id), nm, m.language_code || "", ts, ts, ts).run(); } catch {}
  }
  const left = msg.left_chat_member;
  if (left && !left.is_bot) {
    try { await env.DB.prepare("INSERT INTO members (chat_id, user_id, name, lang, first_seen, last_seen, msg_count, joined_at, left_at) VALUES (?, ?, ?, '', ?, ?, 0, NULL, ?) ON CONFLICT(chat_id, user_id) DO UPDATE SET left_at=excluded.left_at").bind(String(msg.chat.id), String(left.id), left.first_name || "", ts, ts, ts).run(); } catch {}
  }
}
async function pgMembers(env, chatId) {
  let rows = [];
  if (hasDb(env)) {
    try {
      await ensureDbX(env);
      const rs = await env.DB.prepare("SELECT user_id, name, msg_count, left_at FROM members WHERE chat_id = ? ORDER BY last_seen DESC LIMIT 15").bind(String(chatId)).all();
      rows = (rs.results || []).map(m => [{ text: `${(m.name || m.user_id).slice(0, 20)} · 发言 ${m.msg_count || 0} 条${m.left_at ? " · 已退群" : ""}`, callback_data: `gsu:${m.user_id}` }]);
    } catch {}
  }
  rows.push([{ text: "⬅ 返回群菜单", callback_data: "gmenu" }]);
  return pg(`👥 成员数据（机器人见过的成员，按最近活跃排序）\n点任意成员查看档案：名称、ID、注册时间估算、进群时间、发言统计和记分。\n也可以在群里回复某人的消息发 /info 或 /score 直接打开。\n说明：列表只包含机器人入群后见过的人；进群时间从机器人入群后开始记录；注册时间是按 ID 号段估算的；地区信息 Telegram 不提供，查不到。${rows.length <= 1 ? "\n\n暂时还没有记录到成员（等大家发言、或有新人进群后就会出现）。" : ""}`, rows);
}
async function pgScoreList(env, chatId) {
  const all = await loadScores(env, chatId);
  const users = Object.entries(all).filter(([, u]) => (u.s || 0) > 0 || (u.events || []).length).sort((a, b) => (b[1].s || 0) - (a[1].s || 0)).slice(0, 20);
  const rows = users.map(([uid, u]) => [{ text: `${(u.n || uid).slice(0, 24)} · ${u.s || 0} 分`, callback_data: `gsu:${uid}` }]);
  rows.push([{ text: "⬅ 返回群菜单", callback_data: "gmenu" }]);
  return pg(`⚖️ 本群记分管理\n规则：AI 判定垃圾自动 +1 分并请管理员核验（误判可清分）；累计满 3 分移出群聊。\n手动操作：在群里回复任意成员的消息，发送 /score 即可打开他的记分菜单——反垃圾关着也能用。${users.length ? "\n\n点下面成员进行加分 / 减分 / 清零 / 移出：" : "\n\n目前还没有被记分的成员。"}`, rows);
}
async function trackBotMsg(env, chatId, messageId, pin, temp) {
  if (!messageId || !hasDb(env)) return;
  try { await ensureDbX(env); await env.DB.prepare("INSERT OR IGNORE INTO botmsgs (chat_id, message_id, ts, pin, temp) VALUES (?, ?, ?, ?, ?)").bind(String(chatId), messageId, Date.now(), pin ? 1 : 0, temp ? 1 : 0).run(); } catch {}
}
async function sendTemp(env, chatId, text, extra) {
  for (const part of splitText(text)) {
    const res = await tg(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: part, ...(extra || {}) });
    if (res.ok) await trackBotMsg(env, chatId, res.result?.message_id, 0, 1);
    else if (extra?.parse_mode) { const r2 = await tg(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: extra.parse_mode === "HTML" ? part.replace(/<[^>]+>/g, "") : part }); if (r2.ok) await trackBotMsg(env, chatId, r2.result?.message_id, 0, 1); }
  }
}
async function sweepTempMsgs(env, chatId) {
  if (!hasDb(env) || !chatId) return;
  try {
    const rs = await env.DB.prepare("SELECT message_id FROM botmsgs WHERE chat_id = ? AND temp = 1 AND ts < ? LIMIT 5").bind(String(chatId), Date.now() - 120000).all();
    for (const r of rs.results || []) {
      await tg(env.BOT_TOKEN, "deleteMessage", { chat_id: chatId, message_id: r.message_id }).catch(() => {});
      await env.DB.prepare("DELETE FROM botmsgs WHERE chat_id = ? AND message_id = ?").bind(String(chatId), r.message_id).run();
    }
  } catch {}
}
async function autodelHours(env, chatId) {
  if (String(chatId).startsWith("-")) { const g = await kvGet(env, `gcfg:${chatId}`, {}); return Number(g.autodel) || 0; }
  const u = await kvGet(env, `ucfg:${chatId}`, {}); return Number(u.autodel) || 0;
}
async function cleanBotMsgsNow(env, chatId, hours) {
  if (!hasDb(env) || !hours) return 0;
  await ensureDbX(env);
  let rows = [];
  try { const rs = await env.DB.prepare("SELECT message_id FROM botmsgs WHERE chat_id = ? AND pin = 0 AND ts < ? ORDER BY ts ASC LIMIT 100").bind(String(chatId), Date.now() - hours * 3600 * 1000).all(); rows = rs.results || []; } catch {}
  let n = 0;
  for (const r of rows) {
    const res = await tg(env.BOT_TOKEN, "deleteMessage", { chat_id: chatId, message_id: r.message_id });
    try { await env.DB.prepare("DELETE FROM botmsgs WHERE chat_id = ? AND message_id = ?").bind(String(chatId), r.message_id).run(); } catch {}
    if (res.ok) n++;
  }
  return n;
}
async function sweepBotMsgs(env) {
  if (!hasDb(env)) return;
  await ensureDbX(env);
  try { await env.DB.prepare("DELETE FROM botmsgs WHERE ts < ?").bind(Date.now() - 49 * 3600 * 1000).run(); } catch {}
  let rows = [];
  try { const rs = await env.DB.prepare("SELECT chat_id, message_id, ts FROM botmsgs WHERE pin = 0 AND ts < ? ORDER BY ts ASC LIMIT 300").bind(Date.now() - 3600 * 1000).all(); rows = rs.results || []; } catch {}
  try {
    const trs = await env.DB.prepare("SELECT chat_id, message_id FROM botmsgs WHERE temp = 1 AND ts < ? LIMIT 100").bind(Date.now() - 120000).all();
    for (const r of trs.results || []) {
      await tg(env.BOT_TOKEN, "deleteMessage", { chat_id: r.chat_id, message_id: r.message_id }).catch(() => {});
      await env.DB.prepare("DELETE FROM botmsgs WHERE chat_id = ? AND message_id = ?").bind(r.chat_id, r.message_id).run();
    }
  } catch {}
  const cache = new Map(); let done = 0;
  for (const r of rows) {
    if (done >= 100) break;
    if (!cache.has(r.chat_id)) cache.set(r.chat_id, await autodelHours(env, r.chat_id));
    const h = cache.get(r.chat_id);
    if (!h || Date.now() - r.ts < h * 3600 * 1000) continue;
    await tg(env.BOT_TOKEN, "deleteMessage", { chat_id: r.chat_id, message_id: r.message_id }).catch(() => {});
    try { await env.DB.prepare("DELETE FROM botmsgs WHERE chat_id = ? AND message_id = ?").bind(r.chat_id, r.message_id).run(); } catch {}
    done++;
  }
}
const AUTODEL_OPTS = [0, 1, 6, 12, 24, 48];
const autodelRows = (cur, prefix) => [AUTODEL_OPTS.map(h => ({ text: (cur === h ? "✅ " : "") + (h === 0 ? "关闭" : `${h} 小时`), callback_data: `${prefix}:${h}` }))];
async function pgAutoDelPrivate(env, chatId) {
  const cur = await autodelHours(env, chatId);
  return pg(`🧹 自动删除机器人消息（本私聊）\n开启后，机器人会定时删掉它在咱俩私聊里发的旧消息——只删机器人自己发的，你发的不会动。\n当前设置：${cur ? `删除 ${cur} 小时前的` : "关闭"}`, [...autodelRows(cur, "autodel"), [{ text: "🧹 立即按当前设置清理一次", callback_data: "autodelnow" }]]);
}
async function pgAutoDelGroup(env, chatId) {
  const cur = await autodelHours(env, chatId);
  return pg(`🧹 自动删除机器人消息（本群）\n开启后，机器人会定时删掉它在本群发的旧消息——只删它自己发的，成员的消息不会动（需要机器人有删除消息权限）。\n当前设置：${cur ? `删除 ${cur} 小时前的` : "关闭"}`, [...autodelRows(cur, "gautodel"), [{ text: "🧹 立即按当前设置清理一次", callback_data: "gautodelnow" }], [{ text: "⬅ 返回群菜单", callback_data: "gmenu" }]]);
}
async function pgSpamLog(env, chatId) {
  const log = await spamLogGet(env, chatId);
  const rows = [[{ text: "⬅ 返回群菜单", callback_data: "gmenu" }]];
  if (!log.length) return pg("🚨 暂无垃圾拦截记录。", rows);
  const lines = log.slice(-8).reverse().map(r => `[${fmtT(r.t, true)}] ${r.n}（${r.u}）\n类别：${r.category}${r.reason ? `｜${r.reason}` : ""}\n内容：${String(r.x).slice(0, 80)}`);
  return pg(`🚨 最近垃圾拦截记录（共 ${log.length} 条，显示最近 8 条）：\n\n` + lines.join("\n\n"), rows);
}
const pgSumPicker = () => pg("📝 选择总结的时间范围：", [
  [{ text: "1 小时", callback_data: "sum:1" }, { text: "6 小时", callback_data: "sum:6" }, { text: "12 小时", callback_data: "sum:12" }],
  [{ text: "24 小时", callback_data: "sum:24" }, { text: "48 小时", callback_data: "sum:48" }],
  [{ text: "⬅ 返回群菜单", callback_data: "gmenu" }],
]);

// ---------- Page builders ----------
const pgPanel = (owner = true) => owner ? pg("🛠 管理面板\n所有管理功能都在这里，点按钮进入，子页面都有返回键。", [
  [{ text: "🤖 模型与接口", callback_data: "menu_model" }, { text: "🔑 Key 管理", callback_data: "menu_keys" }],
  [{ text: "👥 授权管理", callback_data: "menu_auth" }, { text: "📊 状态与维护", callback_data: "menu_data" }],
  [{ text: "📖 管理说明", callback_data: "adminhelp" }],
]) : pg("🛠 管理面板（次级管理员）\n你能用的功能都在这里。Key、授权名单、管理员、备份这些重要设置只有超级管理员能操作，对你不显示。", [
  [{ text: "🤖 模型与接口", callback_data: "menu_model" }, { text: "📊 状态与维护", callback_data: "menu_data" }],
  [{ text: "📖 管理说明", callback_data: "adminhelp" }],
]);
const SUBMENUS = {
  menu_model: { title: "🤖 模型与接口", rows: [
    [{ text: "🔑 选择 Key（Key 池）", callback_data: "keys" }],
    [{ text: "🎛 选择模型（点选）", callback_data: "models" }],
    [{ text: "🔁 备用模型链（超时自动切换）", callback_data: "fbchain" }],
    [{ text: "📝 设置系统提示词", callback_data: "setprompt" }],
    [{ text: "🩺 测试当前接口", callback_data: "selftest" }],
    [{ text: "🎙 语音转写设置", callback_data: "asr" }],
  ]},
  menu_keys: { title: "🔑 Key 管理", rows: [
    [{ text: "📋 Key 池 / 选择 Key", callback_data: "keys" }],
    [{ text: "➕ 添加 Key", callback_data: "addkey" }, { text: "🔄 更新 Key/地址", callback_data: "setapi" }],
    [{ text: "🔀 使用模式", callback_data: "modes" }],
  ]},
  menu_auth: { title: "👥 授权管理", rows: [
    [{ text: "📋 授权名单", callback_data: "listauth" }],
    [{ text: "✅ 授权用户", callback_data: "auth:allow" }, { text: "✅ 授权群", callback_data: "auth:allowgroup" }],
    [{ text: "🚫 取消用户授权", callback_data: "auth:deny" }, { text: "🚫 取消群授权", callback_data: "auth:denygroup" }],
    [{ text: "👑 添加管理员", callback_data: "auth:addadmin" }, { text: "👑 删除管理员", callback_data: "auth:deladmin" }],
    [{ text: "🎛 独立模型授权（成员/群）", callback_data: "tmodels" }],
  ]},
  menu_data: { title: "📊 状态与维护", rows: [
    [{ text: "📈 系统状态", callback_data: "sysstatus" }, { text: "📊 使用统计", callback_data: "stats" }],
    [{ text: "☁️ CF 用量", callback_data: "cfusage" }, { text: "📣 群发通知", callback_data: "bcast" }],
    [{ text: "🩺 Key 健康巡检", callback_data: "health" }],
    [{ text: "💾 配置备份/恢复", callback_data: "backup" }, { text: "📊 存储总览", callback_data: "storage" }],
    [{ text: "🧹 存储清理", callback_data: "cleanup" }],
  ]},
};
const pgSubmenu = (key, owner = true) => {
  const m = SUBMENUS[key]; if (!m) return pgPanel(owner);
  if (owner) return pg(m.title, [...m.rows, ROW_PANEL]);
  if (key === "menu_model") return pg(m.title, [[{ text: "🎛 选择模型（点选）", callback_data: "models" }], ROW_PANEL]);
  if (key === "menu_data") return pg(m.title, [[{ text: "📊 使用统计", callback_data: "stats" }, { text: "📊 存储总览", callback_data: "storage" }], ROW_PANEL]);
  return pgPanel(false);
};

async function getAllCustoms(env) {
  const raw = await kvGet(env, "config:custom_models", []);
  if (raw.length && typeof raw[0] === "string") {
    // Legacy global list: scope it to the currently active key's interface.
    const pool = await getPool(env);
    const activeName = await kvGet(env, "config:active_key", null);
    const act = pool.find(e => e.name === activeName) || pool[0];
    const scoped = raw.map(name => ({ name, base: act ? normBase(act.base_url) : "" }));
    await kvPut(env, "config:custom_models", scoped);
    return scoped;
  }
  return raw.filter(c => c && c.name);
}
function modelCaps(name) {
  const n = String(name).toLowerCase();
  if (/(gpt-image|dall-e|imagen|flux|stable-diffusion|sdxl|kolors|midjourney|cogview|janus)/.test(n)) return "🎨画图";
  const tags = ["💬"];
  if (/(vl|vision|gpt-4o|gpt-5|gpt-6|gemma-4|gemini|claude|glm-4v|llava|pixtral|internvl|omni)/.test(n)) tags.push("👁");
  if (/(audio|whisper|asr|tts|speech|realtime|omni)/.test(n)) tags.push("🎙");
  return tags.join(" ");
}
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=";
async function probeModel(env, entry, model) {
  const res = { t: 0, v: 0 };
  try { await tryEntry(env, entry, model, "Answer with exactly: ok", [{ role: "user", content: "hi" }]); res.t = 1; } catch { return res; }
  try { await tryEntry(env, entry, model, "Answer with exactly: ok", [{ role: "user", content: [{ type: "text", text: "What is in this image? One word." }, { type: "image_url", image_url: { url: TINY_PNG } }] }]); res.v = 1; } catch {}
  return res;
}
async function runProbe(env, entry, models) {
  const key = `caps:${normBase(entry.base_url)}`;
  const caps = (await cacheGet(env, key)) || {};
  const list = [...new Set(models)].slice(0, 24);
  for (let i = 0; i < list.length; i += 5) {
    const batch = list.slice(i, i + 5).filter(m => !r[m]);
    const results = await Promise.all(batch.map(m => probeModel(env, entry, m)));
    batch.forEach((m, j) => { caps[m] = { ...results[j], ts: Date.now() }; });
  }
  await cachePut(env, key, caps);
  return caps;
}
async function pingModel(env, entry, model) {
  const t0 = Date.now();
  try {
    await Promise.race([
      tryEntry(env, entry, model, "Answer with exactly: ok", [{ role: "user", content: "hi" }]),
      new Promise((_, rej) => setTimeout(() => rej(new Error("检测超时（20 秒无响应）")), 20000)),
    ]);
    return { ok: 1, ms: Date.now() - t0, at: Date.now() };
  } catch (e) { return { ok: 0, ms: Date.now() - t0, at: Date.now(), err: String(e.message || e).slice(0, 140) }; }
}
async function runUseCheck(env, entry, models) {
  const list = [...new Set(models)].slice(0, 40);
  const prev = (await cacheGet(env, `use:${normBase(entry.base_url)}`))?.r || {};
  const r = {};
  for (const m of list) if (prev[m]?.at && Date.now() - prev[m].at < 600000) r[m] = prev[m];
  const rec = { at: Date.now(), r };
  for (let i = 0; i < list.length; i += 5) {
    const batch = list.slice(i, i + 5);
    const results = await Promise.all(batch.map(m => pingModel(env, entry, m)));
    batch.forEach((m, j) => { r[m] = results[j]; });
    await cachePut(env, `use:${normBase(entry.base_url)}`, rec);
  }
  return rec;
}
async function pgUseResults(env, chatId) {
  const pool = await orderedPool(env); const entry = pool[0];
  const back = [[{ text: "🔁 重新检测", callback_data: "usecheck" }, { text: "🎛 返回选模型", callback_data: "models" }], ROW_PANEL];
  if (!entry) return pg("还没有配置任何 Key。", back);
  const rec = await cacheGet(env, `use:${normBase(entry.base_url)}`);
  if (!rec?.r) return pg("还没有检测结果，点「重新检测」跑一次。", back);
  const names = Object.keys(rec.r);
  const oks = names.filter(n => rec.r[n].ok), bads = names.filter(n => !rec.r[n].ok);
  const time = new Date(rec.at).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  let text = `🔍 模型可用性检测（Key「${entry.name}」，${time}）\n共 ${names.length} 个：✅ 可用 ${oks.length} · ❌ 不可用 ${bads.length}\n检测方式：逐个真发一条消息，能正常回话才算可用。`;
  if (bads.length) text += "\n\n❌ 不可用的：\n" + bads.map(n => `· ${n}：${(rec.r[n].err || "调用失败").slice(0, 70)}`).join("\n");
  if (oks.length) text += "\n\n✅ 可用的：\n" + oks.map(n => `${n}（${(rec.r[n].ms / 1000).toFixed(1)}s）`).join("、");
  return pg(text.slice(0, 3900), back);
}
async function pgModels(env, chatId, owner = true) {
  const pool = await orderedPool(env);
  if (!pool.length) return resultPage("还没有配置任何 Key，先在「Key 管理」里添加。");
  const entry = pool[0];
  const base = normBase(entry.base_url);
  const customs = (await getAllCustoms(env)).filter(c => c.base === base);
  const current = (await kvGet(env, "config:model", null)) || env.OPENAI_MODEL || "未设置";
  let models = [], fetchErr = "";
  try { models = await fetchModels(env, entry); } catch (e) { fetchErr = e.message; }
  await kvPut(env, `modellist:${chatId}`, models, 600);
  await kvPut(env, `customlist:${chatId}`, { base, names: customs.map(c => c.name) }, 600);
  const caps = (await cacheGet(env, `caps:${base}`)) || {};
  const useMap = (await cacheGet(env, `use:${base}`))?.r || {};
  const capTag = (m) => { const u = useMap[m]; if (u) return u.ok ? "✅可用" : "❌不可用"; const c = caps[m]; if (!c) return modelCaps(m); if (!c.t) return "❌不可用"; return "💬✓" + (c.v ? " 👁✓" : ""); };
  const rows = models.map((m, i) => [{ text: ((m === current ? "✅ " : "") + m.slice(0, 30) + " " + capTag(m)).slice(0, 42), callback_data: `model:${i}` }]);
  customs.forEach((c, i) => rows.push([{ text: ((c.name === current ? "✅ " : "✏️ ") + c.name.slice(0, 30) + " " + capTag(c.name)).slice(0, 42), callback_data: `cmodel:${i}` }]));
  if (owner) {
    const actionRow = [{ text: "➕ 添加自定义模型", callback_data: "addmodel" }];
    if (customs.length) actionRow.push({ text: "🗑 删除自定义", callback_data: "delmodels" });
    rows.push(actionRow);
    rows.push([{ text: "🔄 手动重新获取模型", callback_data: "models" }, { text: "🧪 实测能力", callback_data: "probe" }]);
    rows.push([{ text: "🔍 检测模型可用性（逐个真调用）", callback_data: "usecheck" }]);
  } else rows.push([{ text: "🔄 手动重新获取模型", callback_data: "models" }]);
  rows.push(ROW_PANEL);
  const head = fetchErr
    ? `🎛 选择模型\n当前 Key「${entry.name}」的接口没返回模型列表（${fetchErr}）。\n有些接口（如智谱）需要手动填模型名：点「添加自定义模型」加上名字，就能直接点选使用。`
    : `🎛 选择模型\n当前模型：${current}\n当前 Key：${entry.name}（${entry.base_url}）\n已从接口获取 ${models.length} 个模型（更新于 ${new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}），点一个直接切换；列表里没有的模型，点「添加自定义模型」手动加。`;
  const curBad = useMap[current] && !useMap[current].ok ? useMap[current] : null;
  const head2 = (curBad ? `⚠️ 当前模型最近一次检测不可用：${(curBad.err || "调用失败").slice(0, 80)}\n` : "") + (owner ? head : `🎛 选择模型\n当前模型：${current}\n点一个直接切换。（Key、接口和自定义模型只有超级管理员能管理，这里不显示。）`);
  return pg(head2 + (owner ? "\n按钮后的图标：💬 文本 · 👁 看图 · 🎙 语音 · 🎨 画图（画图模型不能聊天）。带 ✓ 是实测通过，❌ 是实测调不通（虚标或已下线）；没带 ✓ 的是按名字推测。点「🧪 实测能力」逐个真测（最多 24 个，测文本和看图）。" + (customs.length ? "\n✏️ 开头的是给当前接口添加的自定义模型，只在这个 Key 下显示。" : "") : ""), rows);
}
async function pgDelModels(env, chatId) {
  const back = [[{ text: "⬅ 返回选模型", callback_data: "models" }], ROW_PANEL];
  let cache = chatId ? await kvGet(env, `customlist:${chatId}`, null) : null;
  if (!cache) {
    const pool = await orderedPool(env); const entry = pool[0];
    if (!entry) return pg("还没有自定义模型。", back);
    const base = normBase(entry.base_url);
    cache = { base, names: (await getAllCustoms(env)).filter(c => c.base === base).map(c => c.name) };
    if (chatId) await kvPut(env, `customlist:${chatId}`, cache, 600);
  }
  if (!cache.names.length) return pg("当前接口下还没有自定义模型。", back);
  const rows = cache.names.map((m, i) => [{ text: `🗑 ${m}`.slice(0, 40), callback_data: `delmodel:${i}` }]);
  rows.push(...back);
  return pg("点一个要删除的自定义模型（只删当前接口下的）：", rows);
}
async function pgKeys(env) {
  const pool = await getPool(env);
  const activeName = await kvGet(env, "config:active_key", null);
  const mode = await kvGet(env, "config:key_mode", "fallback");
  const envOverride = await kvGet(env, "config:envkey", null);
  if (!pool.length && !envOverride?.disabled) return pg("🔑 Key 池是空的。点「添加 Key」先加一个。", [[{ text: "➕ 添加 Key", callback_data: "addkey" }], ROW_PANEL]);
  const lines = pool.map((e, i) => `${i + 1}. ${e.name}${e.name === activeName || (!activeName && i === 0) ? "（使用中）" : ""}${e.isEnv ? "（默认 Key）" : ""}\n   地址：${e.base_url}\n   Key：${maskKey(e.key)}`);
  if (envOverride?.disabled) lines.push("（默认 Key 已停用，可点下面按钮恢复）");
  const rows = pool.map((e, i) => [{ text: `🔑 ${e.name}${e.name === activeName || (!activeName && i === 0) ? "（使用中）" : ""} — 点开管理`.slice(0, 40), callback_data: `keydetail:${i}` }]);
  rows.push(["fallback", "rotate", "single"].map(m => ({ text: (m === mode ? "✅ " : "") + m, callback_data: `keymode:${m}` })));
  if (envOverride?.disabled) rows.push([{ text: "♻️ 恢复默认 Key", callback_data: "keyrestore" }]);
  rows.push([{ text: "🎛 选好 Key 了，去选模型", callback_data: "models" }]);
  rows.push(ROW_PANEL);
  return pg("🔑 Key 池\n点某个 Key 进入详情（可改名、改地址、更新 Key 值、切换、删除）。\n下面一行是使用模式：fallback=出错自动换，rotate=轮流，single=只用当前。\n\n" + lines.join("\n"), rows);
}
async function pgKeyDetail(env, poolIdx) {
  const pool = await getPool(env); const e = pool[poolIdx];
  if (!e) return pgKeys(env);
  const stored = await getStoredKeys(env);
  const storedIdx = e.isEnv ? -1 : stored.findIndex(x => x.name === e.name && x.key === e.key);
  const idS = storedIdx >= 0 ? String(storedIdx) : "env";
  const activeName = await kvGet(env, "config:active_key", null);
  const isActive = e.name === activeName || (!activeName && poolIdx === 0);
  const rows = [];
  if (!isActive) rows.push([{ text: "✅ 设为使用中", callback_data: `keyuse:${poolIdx}` }]);
  rows.push([{ text: "🎛 选择模型", callback_data: "models" }]);
  const apiLabel = e.api === "responses" ? "Responses" : e.api === "chat" ? "Chat" : "自动";
  rows.push([{ text: `🔌 接口类型：${apiLabel}（点切换）`, callback_data: `keyapi:${idS}` }]);
  rows.push([{ text: `🪪 自定义 UA：${e.ua ? "已设置" : "未设置"}（点修改）`, callback_data: `keyedit:ua:${idS}` }]);
  rows.push([{ text: "✏️ 改名", callback_data: `keyedit:name:${idS}` }, { text: "🔄 改地址", callback_data: `keyedit:base:${idS}` }]);
  rows.push([{ text: "🔑 更新 Key 值", callback_data: `keyedit:key:${idS}` }, { text: "🗑 删除此 Key", callback_data: `delkey:${idS}` }]);
  rows.push([{ text: "⬅ 返回 Key 池", callback_data: "keys" }]);
  rows.push(ROW_PANEL);
  const note = e.isEnv ? "\n说明：这个 Key 最初来自环境变量，在这里改名/改地址/更新值会存为覆盖配置、立即生效；删除会停用它，之后可在 Key 池一键恢复成环境变量的原始值。" : "";
  const cachedApi = await cacheGet(env, `apitype:${e.base_url}`);
  const apiLine = `\n接口类型：${e.api ? (e.api === "responses" ? "Responses（手动）" : "Chat Completions（手动）") : `自动（当前按 ${cachedApi === "responses" ? "Responses" : "Chat Completions"} 调用）`}`;
  const uaLine = `\n自定义 UA：${e.ua ? e.ua.slice(0, 80) : "未设置（用程序默认）"}`;
  return pg(`🔑 Key 详情\n名称：${e.name}${isActive ? "（使用中）" : ""}\n地址：${e.base_url}\nKey：${maskKey(e.key)}${apiLine}${uaLine}${note}`, rows);
}
async function pgDelKeys(env) {
  const stored = await getStoredKeys(env);
  const pool = await getPool(env); const envE = pool.find(x => x.isEnv);
  if (!stored.length && !envE) return resultPage("没有可删的 Key。");
  const rows = stored.map((e, i) => [{ text: `🗑 ${e.name}（${maskKey(e.key)}）`.slice(0, 40), callback_data: `delkey:${i}` }]);
  if (envE) rows.push([{ text: `🗑 ${envE.name}（默认 Key，删除=停用）`.slice(0, 40), callback_data: "delkey:env" }]);
  rows.push(ROW_PANEL);
  return pg("点一个要删除的 Key：", rows);
}
async function pgModes(env) {
  const mode = await kvGet(env, "config:key_mode", "fallback");
  const rows = [["fallback", "出错自动换下一个"], ["rotate", "轮流使用"], ["single", "只用当前"]].map(([m, desc]) => [{ text: `${m === mode ? "✅ " : ""}${m} — ${desc}`, callback_data: `keymode:${m}` }]);
  rows.push(ROW_PANEL);
  return pg("🔀 选择 Key 使用模式：", rows);
}
async function pgSysStatus(env) {
  const [model, activeName, mode, users, groups, admins, stats, pool] = await Promise.all([
    kvGet(env, "config:model", null), kvGet(env, "config:active_key", null), kvGet(env, "config:key_mode", "fallback"),
    kvGet(env, "allowed_users", []), kvGet(env, "allowed_groups", []), kvGet(env, "admins", []), getStats(env), getPool(env),
  ]);
  const active = pool.find(e => e.name === activeName) || pool[0];
  const text = ["📈 系统状态",
    `模型：${model || env.OPENAI_MODEL || "kilo-auto/free"}`,
    `当前 Key：${active ? `${active.name}（${active.base_url} / ${maskKey(active.key)}）` : "未配置"}`,
    `Key 总数：${pool.length}，模式：${mode}`,
    `授权：${users.length} 个用户，${groups.length} 个群`,
    `管理员：${(env.ADMIN_IDS ? env.ADMIN_IDS.split(",").filter(Boolean).length : 0) + admins.length} 个`,
    `累计消息：${stats.messages || 0}，活跃用户：${Object.keys(stats.users || {}).length}`,
    `存储：${env.DB ? "D1（群日志/历史/统计/限流）+ KV（配置）" : "仅 KV"}`].join("\n");
  return pg(text, [[{ text: "🩺 测试当前接口", callback_data: "selftest" }, { text: "🔄 刷新", callback_data: "sysstatus" }], ROW_PANEL]);
}
async function pgSelfTest(env) {
  const pool = await orderedPool(env);
  if (!pool.length) return resultPage("没有可用的 Key。");
  const entry = pool[0], t0 = Date.now();
  try {
    const models = await fetchModels(env, entry);
    const current = (await kvGet(env, "config:model", null)) || env.OPENAI_MODEL;
    return resultPage(`🩺 接口正常\nKey：${entry.name}（${entry.base_url}）\n耗时：${Date.now() - t0}ms\n可用模型：${models.length} 个\n当前模型${models.includes(current) ? "在列表中 ✅" : "不在该接口列表中 ⚠️（建议重新选模型）"}`);
  } catch (e) { return resultPage(`🩺 接口异常\nKey：${entry.name}（${entry.base_url}）\n错误：${e.message}`); }
}
async function pgListAuth(env) {
  const [u, g, admins] = await Promise.all([kvGet(env, "allowed_users", []), kvGet(env, "allowed_groups", []), kvGet(env, "admins", [])]);
  return resultPage(`📋 授权名单\n授权用户: ${u.join(", ") || "无"}\n授权群: ${g.join(", ") || "无"}\n额外管理员: ${admins.join(", ") || "无"}\n环境管理员: ${env.ADMIN_IDS || "未设置"}\n\n增删在「授权管理」里点按钮按提示操作。`);
}
async function pgStats(env) { const s = await getStats(env); return resultPage(`📊 使用统计\n总消息: ${s.messages || 0}\n活跃用户数: ${Object.keys(s.users || {}).length}`); }

// ---------- Key health check (manual + scheduled auto) ----------
async function runHealthCheck(env, notify) {
  const pool = await getPool(env);
  const results = {};
  for (const e of pool) {
    const t0 = Date.now();
    try { const models = await fetchModels(env, e); results[e.name] = { ok: true, at: Date.now(), ms: Date.now() - t0, models: models.length }; }
    catch (err) { results[e.name] = { ok: false, at: Date.now(), ms: Date.now() - t0, error: String(err.message || err).slice(0, 120) }; }
  }
  const cfg = await kvGet(env, "config:health", { auto: 0, last: 0, results: {}, failed: [] });
  const failed = Object.entries(results).filter(([, r]) => !r.ok).map(([n]) => n);
  const prevFailed = cfg.failed || [];
  cfg.results = results; cfg.last = Date.now(); cfg.failed = failed;
  await kvPut(env, "config:health", cfg);
  if (notify && failed.length && JSON.stringify([...failed].sort()) !== JSON.stringify([...prevFailed].sort())) {
    const admins = [...new Set([...String(env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean), ...(await kvGet(env, "admins", []))])];
    const text = `⚠️ Key 健康巡检发现异常\n失败的 Key：${failed.join("、")}\n` + failed.map(n => `• ${n}：${results[n].error}`).join("\n") + `\n其余 ${pool.length - failed.length} 个正常。详情在管理面板「状态与维护 → Key 健康巡检」。`;
    for (const a of admins) await send(env, a, text).catch(() => {});
  }
  return { results, failed, total: pool.length };
}
async function pgHealth(env) {
  const cfg = await kvGet(env, "config:health", { auto: 0, last: 0, results: {} });
  const pool = await getPool(env);
  const lines = ["🩺 Key 健康巡检", `自动巡检：${cfg.auto ? `已开启，每 ${cfg.auto} 小时一次` : "已关闭"}（点下面一行切换）`, `上次巡检：${cfg.last ? fmtT(cfg.last, true) : "还没巡检过"}`];
  if (!pool.length) lines.push("\nKey 池是空的。");
  for (const e of pool) {
    const r = cfg.results?.[e.name];
    if (!r) lines.push(`• ${e.name}：未检测`);
    else if (r.ok) lines.push(`• ${e.name}：✅ 正常（${r.ms}ms，${r.models} 个模型）`);
    else lines.push(`• ${e.name}：❌ 异常（${r.error}）`);
  }
  const autoRow = [0, 1, 4, 8, 12, 24].map(h => ({ text: (Number(cfg.auto) === h ? "✅ " : "") + (h === 0 ? "关" : `${h}h`), callback_data: `healthauto:${h}` }));
  return pg(lines.join("\n"), [[{ text: "🔍 立即巡检", callback_data: "healthrun" }, { text: "🔄 刷新", callback_data: "health" }], autoRow, ROW_PANEL]);
}

// ---------- Cloudflare usage (free-plan quotas, via GraphQL analytics) ----------
async function cfGQL(env, cfg, query, variables) {
  const r = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` }, body: JSON.stringify({ query, variables }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.errors?.length) throw new Error(data.errors?.[0]?.message || `HTTP ${r.status}（Token 可能无效或没权限）`);
  return data.data?.viewer?.accounts?.[0] || {};
}
const cfBar = (used, limit) => { const pct = limit ? Math.min(100, Math.round(used / limit * 100)) : 0; const f = Math.round(pct / 10); return "▓".repeat(f) + "░".repeat(10 - f) + ` ${pct}%`; };
const cfLine = (label, used, limit) => `${label}：${used.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")}（剩余 ${Math.max(0, limit - used).toLocaleString("en-US")}）\n${cfBar(used, limit)}`;
async function pgCfUsage(env) {
  const cfg = await kvGet(env, "config:cf", null);
  if (!cfg?.token || !cfg?.account) {
    return pg("☁️ Cloudflare 用量（免费版额度）\n\n还没配置查询凭证。需要两样：\n1) 你的 CF 账户 ID（控制台首页能看到）\n2) 一个只读 API Token：CF 控制台 → 右上角头像 → 我的个人资料 → API 令牌 → 创建令牌 → 自定义令牌，权限给「账户 · 账户分析 · 读取」即可\n\n配好后这里能看 Workers 请求量、KV 读写量用了多少免费额度。", [[{ text: "🔑 设置 CF 账户/Token", callback_data: "cfset" }], ROW_PANEL]);
  }
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const iso = (d) => d.toISOString().replace(/\.\d+Z$/, "Z");
  const vars = { a: cfg.account, s: iso(start), e: iso(new Date(start.getTime() + 86400000)) };
  const day = start.toISOString().slice(0, 10);
  const lines = [`☁️ Cloudflare 今日用量（UTC ${day}，免费版）`, `Token：${maskKey(cfg.token)}`];
  try {
    const acc = await cfGQL(env, cfg, `query($a: string, $s: Time, $e: Time) { viewer { accounts(filter: {accountTag: $a}) { workersInvocationsAdaptive(limit: 1, filter: {datetime_geq: $s, datetime_lt: $e}) { sum { requests errors } } } } }`, vars);
    const t = acc.workersInvocationsAdaptive?.[0]?.sum || { requests: 0, errors: 0 };
    lines.push("", cfLine("Workers 请求", t.requests || 0, 100000), `错误数：${t.errors || 0}`);
  } catch (e) { lines.push("", `Workers 请求：查询失败（${e.message}）`); }
  try {
    const acc = await cfGQL(env, cfg, `query($a: string, $s: Time, $e: Time) { viewer { accounts(filter: {accountTag: $a}) { workersInvocationsAdaptive(limit: 100, filter: {datetime_geq: $s, datetime_lt: $e}) { sum { requests } dimensions { scriptName } } } } }`, vars);
    const rows = (acc.workersInvocationsAdaptive || []).filter(r => r.sum?.requests > 0).sort((a, b) => b.sum.requests - a.sum.requests).slice(0, 5);
    if (rows.length) { lines.push("", "请求最多的 Worker："); for (const r of rows) lines.push(`• ${r.dimensions.scriptName}：${r.sum.requests}`); }
  } catch { /* optional */ }
  try {
    const acc = await cfGQL(env, cfg, `query($a: string, $s: Time, $e: Time) { viewer { accounts(filter: {accountTag: $a}) { kvOperationsAdaptiveGroups(limit: 100, filter: {datetime_geq: $s, datetime_lt: $e}) { count dimensions { actionType } } } } }`, vars);
    const groups = acc.kvOperationsAdaptiveGroups || [];
    if (!groups.length) lines.push("", "KV 操作：暂无数据（官方统计有几小时延迟，刚部署时为空是正常的）");
    else {
      const by = {};
      for (const g of groups) by[String(g.dimensions.actionType).toLowerCase()] = (by[String(g.dimensions.actionType).toLowerCase()] || 0) + (g.count || 0);
      const pick = (...names) => names.reduce((n, k) => n + (by[k] || 0), 0);
      lines.push("", cfLine("KV 读取", pick("read", "get"), 100000), cfLine("KV 写入", pick("write", "put"), 1000), cfLine("KV 删除", pick("delete"), 1000), cfLine("KV 列出", pick("list"), 1000));
    }
  } catch (e) { lines.push("", `KV 操作：查询失败（${e.message}）`); }
  lines.push("", "说明：免费版额度按 UTC 自然日重置；Workers 另有 CPU 时间限制（每次请求 10ms 免费档），这里不单独统计。");
  return pg(lines.join("\n"), [[{ text: "🔄 刷新", callback_data: "cfusage" }, { text: "🗑 删除 CF Token", callback_data: "cfdel" }], ROW_PANEL]);
}

const BACKUP_KEYS = ["keys", "admins", "allowed_users", "allowed_groups"];
async function collectBackup(env) {
  const data = {};
  for (const k of BACKUP_KEYS) { const v = await env.AUTH_KV.get(k, "json"); if (v !== null && v !== undefined) data[k] = v; }
  for (const prefix of ["config:", "gcfg:", "ucfg:"]) {
    let cursor;
    do {
      const page = await env.AUTH_KV.list({ prefix, cursor });
      for (const item of page.keys) { const v = await env.AUTH_KV.get(item.name, "json"); if (v !== null && v !== undefined) data[item.name] = v; }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  }
  return { app: "openai-tg-bot", version: 1, exported_at: new Date().toISOString(), data };
}
async function applyBackup(env, data) {
  let n = 0;
  for (const [k, v] of Object.entries(data || {})) {
    if (!(BACKUP_KEYS.includes(k) || k.startsWith("config:") || k.startsWith("gcfg:") || k.startsWith("ucfg:"))) continue;
    await env.AUTH_KV.put(k, JSON.stringify(v)); n++;
  }
  return n;
}
async function pgTargetModels(env) {
  const users = await kvGet(env, "allowed_users", []);
  const groups = await kvGet(env, "allowed_groups", []);
  const rows = [];
  const lines = ["🎛 独立模型授权", "给某个成员或群单独指定模型：成员的只对他和机器人的私聊生效，群的只对该群生效；不指定就跟随全局模型。点一个进去选："];
  if (!users.length && !groups.length) lines.push("\n还没有已授权的成员或群，先在授权管理里完成授权，这里才会出现。");
  for (const u of users) { const c = await kvGet(env, `ucfg:${u}`, {}); rows.push([{ text: `👤 成员 ${u} · ${c.model ? (c.key ? `${c.key}·${c.model}` : c.model) : "跟随全局"}`.slice(0, 42), callback_data: `tmodel:u:${u}` }]); }
  for (const g of groups) { const c = await kvGet(env, `gcfg:${g}`, {}); rows.push([{ text: `👥 群 ${g} · ${c.model ? (c.key ? `${c.key}·${c.model}` : c.model) : "跟随全局"}`.slice(0, 42), callback_data: `tmodel:g:${g}` }]); }
  rows.push(ROW_PANEL);
  return pg(lines.join("\n"), rows);
}
async function pgTargetKeyPick(env, chatId, kind, tid) {
  const back = [[{ text: "⬅ 返回独立模型授权", callback_data: "tmodels" }], ROW_PANEL];
  const pool = await getPool(env);
  if (!pool.length) return pg("还没有配置任何 Key。", back);
  const c = kind === "u" ? await kvGet(env, `ucfg:${tid}`, {}) : await kvGet(env, `gcfg:${tid}`, {});
  const activeName = await kvGet(env, "config:active_key", null);
  const rows = [[{ text: (!c.model ? "✅ " : "") + "跟随全局（不单独指定）", callback_data: `tmclear:${kind}:${tid}` }]];
  pool.forEach((e, i) => rows.push([{ text: `🔑 ${e.name}${c.key === e.name ? "（已选）" : ""}${e.name === activeName ? "（全局使用中）" : ""}`.slice(0, 42), callback_data: `tkey:${kind}:${tid}:${i}` }]));
  rows.push(...back);
  const who = kind === "u" ? `成员 ${tid}` : `群 ${tid}`;
  const cur = c.model ? `当前独立设置：${c.key ? `Key「${c.key}」的 ` : ""}${c.model}` : "当前：跟随全局";
  return pg(`🎛 独立模型授权 · ${who}\n${cur}\n先选一个 Key，再进去选这个 Key 下的模型：`, rows);
}
async function pgTargetModelPick(env, chatId) {
  const cache = await kvGet(env, `targetpick:${chatId}`, null);
  if (!cache) return resultPage("选择已过期，重新打开独立模型授权。");
  const { kind, tid, entryName, models, customs } = cache;
  const back = [[{ text: "⬅ 返回选 Key", callback_data: `tmodel:${kind}:${tid}` }], ROW_PANEL];
  const c = kind === "u" ? await kvGet(env, `ucfg:${tid}`, {}) : await kvGet(env, `gcfg:${tid}`, {});
  const caps = (await cacheGet(env, `caps:${cache.base}`)) || {};
  const capTag = (m) => { const cc = caps[m]; if (!cc) return modelCaps(m); if (!cc.t) return "❌不可用"; return "💬✓" + (cc.v ? " 👁✓" : ""); };
  const rows = models.map((m, i) => [{ text: ((c.model === m && c.key === entryName ? "✅ " : "") + m.slice(0, 30) + " " + capTag(m)).slice(0, 42), callback_data: `tmsel2:${i}` }]);
  customs.forEach((m, i) => rows.push([{ text: ((c.model === m && c.key === entryName ? "✅ " : "✏️ ") + m.slice(0, 30) + " " + capTag(m)).slice(0, 42), callback_data: `tmsel2:c${i}` }]));
  rows.push(...back);
  const who = kind === "u" ? `成员 ${tid}` : `群 ${tid}`;
  return pg(`🎛 独立模型授权 · ${who}\nKey「${entryName}」下的模型，点一个设为独立模型：`, rows);
}
async function pgFallback(env) {
  const cfg = await getFallbackCfg(env);
  const first = (await orderedPool(env))[0];
  const model = (await kvGet(env, "config:model", null)) || env.OPENAI_MODEL || "";
  const lines = ["🔁 备用模型链（超时自动切换）", "", `主模型：${first ? first.name : "（无）"} · ${model}`, `切换超时：${cfg.timeout} 秒——主模型在 ${cfg.timeout} 秒内没开始出内容、中途卡住超过 ${cfg.timeout} 秒、或直接报错，就自动切下一个备用模型。`, ""];
  if (!cfg.chain.length) lines.push("还没有备用模型。加上之后，主模型卡住会自动按顺序切换，不会再一直「思考中」。");
  else cfg.chain.forEach((c, i) => lines.push(`备用 ${i + 1}：${c.key} · ${c.model}`));
  const rows = [];
  cfg.chain.forEach((c, i) => rows.push([{ text: `🗑 删除备用 ${i + 1}：${c.model}`.slice(0, 42), callback_data: `fbdel:${i}` }]));
  if (cfg.chain.length < 5) rows.push([{ text: "➕ 添加备用模型", callback_data: "fbadd" }]);
  rows.push([{ text: `⏱ 切换超时：${cfg.timeout} 秒`, callback_data: "fbtimeout" }]);
  if (cfg.chain.length) rows.push([{ text: "🧹 清空备用链", callback_data: "fbclear" }]);
  rows.push([{ text: "⬅ 返回模型与接口", callback_data: "menu_model" }], ROW_PANEL);
  return pg(lines.join("\n"), rows);
}
async function pgFallbackKeyPick(env) {
  const pool = await getPool(env);
  const rows = pool.map((e, i) => [{ text: `🔑 ${e.name}`.slice(0, 42), callback_data: `fbkey:${i}` }]);
  rows.push([{ text: "⬅ 返回备用模型链", callback_data: "fbchain" }], ROW_PANEL);
  return pg("🔁 添加备用模型：先选这个备用模型用哪个 Key：", rows);
}
async function pgFallbackModelPick(env, chatId) {
  const cache = await kvGet(env, `fbpick:${chatId}`, null);
  if (!cache) return resultPage("选择已过期，重新打开备用模型链。");
  const rows = cache.models.map((m, i) => [{ text: m.slice(0, 42), callback_data: `fbmodel:${i}` }]);
  cache.customs.forEach((m, i) => rows.push([{ text: `✏️ ${m}`.slice(0, 42), callback_data: `fbmodel:c${i}` }]));
  rows.push([{ text: "⬅ 返回选 Key", callback_data: "fbadd" }], ROW_PANEL);
  return pg(`🔁 给 Key「${cache.entryName}」选备用模型，点一个加入备用链：`, rows);
}
async function pgFallbackTimeout(env) {
  const cfg = await getFallbackCfg(env);
  const rows = [15, 25, 40, 60].map(n => [{ text: (cfg.timeout === n ? "✅ " : "") + `${n} 秒`, callback_data: `fbtime:${n}` }]);
  rows.push([{ text: "⬅ 返回备用模型链", callback_data: "fbchain" }], ROW_PANEL);
  return pg("⏱ 切换超时：主模型在多少秒内没开始出内容（或中途卡住超过这个秒数），就自动切换到下一个备用模型：\n注意：设得太短，慢但能答的模型也会被切走。", rows);
}
async function cleanupStorage(env) {
  const out = { at: Date.now(), glog: 0, hist: 0, kv: 0, rate: 0, spam: 0 };
  if (hasDb(env)) {
    await ensureDbX(env);
    try { const r = await env.DB.prepare("DELETE FROM rate WHERE minute < ?").bind(Math.floor(Date.now() / 60000) - 5).run(); out.rate = r.meta?.changes || 0; } catch {}
    try { const r = await env.DB.prepare("DELETE FROM glog WHERE ts < ?").bind(Date.now() - 72 * 3600 * 1000).run(); out.glog = r.meta?.changes || 0; } catch {}
    try { const r = await env.DB.prepare("DELETE FROM spamlog WHERE ts < ?").bind(Date.now() - 7 * 86400 * 1000).run(); out.spam = r.meta?.changes || 0; } catch {}
    try { const r = await env.DB.prepare("DELETE FROM hist WHERE updated_at < ?").bind(Date.now() - 90 * 86400 * 1000).run(); out.hist = r.meta?.changes || 0; } catch {}
    try {
      const st = await getStats(env);
      if (st.users) {
        const cut = Date.now() - 90 * 86400 * 1000; let changed = false;
        for (const [u, t] of Object.entries(st.users)) if (t < cut) { delete st.users[u]; changed = true; }
        if (changed) { try { await env.DB.prepare("INSERT INTO stats (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").bind(JSON.stringify(st)).run(); } catch { await kvPut(env, "stats", st); } }
      }
    } catch {}
    try {
      let swept = 0;
      for (const prefix of ["hist:", "glog:", "spamlog:"]) {
        const page = await env.AUTH_KV.list({ prefix, limit: 50 });
        for (const item of page.keys) {
          if (prefix === "hist:") {
            const rest = item.name.slice(5); const sep = rest.lastIndexOf(":");
            if (sep > 0) { const cid = rest.slice(0, sep), uid = rest.slice(sep + 1); await loadConvo(env, cid, uid); await env.AUTH_KV.delete(`histmemo:${cid}:${uid}`); await env.AUTH_KV.delete(`lastprompt:${cid}:${uid}`); }
          } else if (prefix === "spamlog:") {
            const log = await kvGet(env, item.name, []);
            for (const e of log) { try { await env.DB.prepare("INSERT INTO spamlog (chat_id, ts, user_id, name, category, reason, text) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(item.name.slice(8), e.t || Date.now(), String(e.u || ""), e.n || "", e.category || "", e.reason || "", e.x || "").run(); } catch {} }
          } else {
            const log = await kvGet(env, item.name, []);
            for (const e of log) { try { await env.DB.prepare("INSERT INTO glog (chat_id, ts, user_id, name, text) VALUES (?, ?, ?, ?, ?)").bind(item.name.slice(5), e.t || Date.now(), String(e.u || ""), e.n || "", e.x || "").run(); } catch {} }
          }
          await env.AUTH_KV.delete(item.name); swept++;
        }
      }
      out.kv = swept;
    } catch {}
  }
  await kvPut(env, "config:cleanup", out);
  return out;
}
function fmtBytes(b) { if (b < 1024) return `${b} B`; if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`; return `${(b / 1024 / 1024).toFixed(2)} MB`; }
function vbar(frac, w = 12) { const f = Math.max(0, Math.min(1, frac || 0)); const n = Math.round(f * w); return "▓".repeat(n) + "░".repeat(Math.max(0, w - n)); }
async function pgStorage(env) {
  await ensureDbX(env);
  let gN = 0, gB = 0, hN = 0, hB = 0, rN = 0, sB = 0, spN = 0, spB = 0;
  if (hasDb(env)) {
    try {
      const row = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM glog) AS gn, (SELECT COALESCE(SUM(LENGTH(text) + LENGTH(name) + 24), 0) FROM glog) AS gb, (SELECT COUNT(*) FROM hist) AS hn, (SELECT COALESCE(SUM(LENGTH(data) + 24), 0) FROM hist) AS hb, (SELECT COUNT(*) FROM rate) AS rn, (SELECT COALESCE(LENGTH(data), 0) FROM stats WHERE id = 1) AS sb, (SELECT COUNT(*) FROM spamlog) AS spn, (SELECT COALESCE(SUM(LENGTH(text) + LENGTH(name) + 24), 0) FROM spamlog) AS spb").first();
      if (row) { gN = row.gn; gB = row.gb; hN = row.hn; hB = row.hb; rN = row.rn; sB = row.sb; spN = row.spn; spB = row.spb; }
    } catch {}
  }
  const d1Bytes = gB + hB + sB + spB + rN * 24;
  const d1Cap = 500 * 1024 * 1024;
  const cats = [["⚙️ 配置", 0], ["🔑 Key 池", 0], ["👥 授权名单", 0], ["🏠 群设置", 0], ["👤 成员独立设置", 0], ["🚨 垃圾记录", 0], ["📦 旧版残留（待清理）", 0], ["🗂 其它/临时缓存", 0]];
  let kvTotal = 0, kvComplete = true;
  try {
    const page = await env.AUTH_KV.list({ limit: 1000 });
    kvComplete = page.list_complete !== false;
    for (const k of page.keys) {
      kvTotal++;
      const n = k.name;
      if (n.startsWith("config:")) cats[0][1]++;
      else if (n === "keys") cats[1][1]++;
      else if (n === "admins" || n === "allowed_users" || n === "allowed_groups") cats[2][1]++;
      else if (n.startsWith("gcfg:")) cats[3][1]++;
      else if (n.startsWith("ucfg:")) cats[4][1]++;
      else if (n.startsWith("spamlog:")) cats[5][1]++;
      else if (n.startsWith("hist:") || n.startsWith("glog:") || n.startsWith("histmemo:") || n.startsWith("lastprompt:")) cats[6][1]++;
      else cats[7][1]++;
    }
  } catch {}
  const ccfg = await kvGet(env, "config:cleanup_cfg", { hours: 24 });
  const cur = ccfg?.hours ?? 24;
  const lbl = cur === 0 ? "已关闭" : cur === 24 ? "每天" : cur === 72 ? "每 3 天" : cur === 168 ? "每周" : `每 ${cur} 小时`;
  const last = await kvGet(env, "config:cleanup", null);
  const share = (b) => d1Bytes > 0 ? ` ${vbar(b / d1Bytes, 8)}` : "";
  const kvLines = cats.filter(([, n]) => n > 0).map(([t, n]) => `• ${t}：${n}`).join("\n");
  return pg(`📊 存储总览（${fmtT(Date.now(), true)} 更新）\n\n💾 D1 数据库 ≈ ${fmtBytes(d1Bytes)} / 500 MB（免费版）\n${vbar(d1Bytes / d1Cap, 16)} ${(d1Bytes / d1Cap * 100).toFixed(2)}%\n• 群日志：${gN} 条 · ${fmtBytes(gB)}${share(gB)}\n• 对话记录：${hN} 份 · ${fmtBytes(hB)}${share(hB)}\n• 统计数据：${fmtBytes(sB)}\n• 垃圾存档：${spN} 条 · ${fmtBytes(spB)}${share(spB)}\n• 限流计数：${rN} 条（临时）\n\n🗄 KV 存储：共 ${kvTotal}${kvComplete ? "" : "+"} 个键\n${kvLines || "（暂无数据）"}\n\n🧹 自动清理：${lbl}${last ? ` · 上次 ${fmtT(last.at, true)}` : ""}`, [[{ text: "🔄 刷新", callback_data: "storage" }, { text: "🧹 去清理", callback_data: "cleanup" }], ROW_PANEL]);
}
async function pgCleanup(env) {
  let g = 0, h = 0, r = 0;
  if (hasDb(env)) { try { const row = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM glog) AS g, (SELECT COUNT(*) FROM hist) AS h, (SELECT COUNT(*) FROM rate) AS r").first(); if (row) { g = row.g; h = row.h; r = row.r; } } catch {} }
  const last = await kvGet(env, "config:cleanup", null);
  const ccfg = await kvGet(env, "config:cleanup_cfg", { hours: 24 });
  const cur = ccfg?.hours ?? 24;
  const lbl = (x) => x === 0 ? "已关闭" : x === 24 ? "每天" : x === 72 ? "每 3 天" : x === 168 ? "每周" : `每 ${x} 小时`;
  const btn = (t, x) => ({ text: (cur === x ? "✅ " : "") + t, callback_data: `cleanupcfg:${x}` });
  return pg(`🧹 存储清理\n当前 D1 数据量：\n• 群日志：${g} 条（只保留最近 72 小时，和总结/检索范围一致）\n• 对话记录：${h} 份（90 天没聊过的才清，正在聊的永远不清）\n• 限流计数：${r} 条（只保留最近几分钟）\n上次清理：${last ? `${fmtT(last.at, true)}（删了群日志 ${last.glog} 条、旧对话 ${last.hist} 份、KV 残留 ${last.kv} 个）` : "还没跑过"}\n\n⏱ 自动清理周期：${lbl(cur)}——到期才会真正跑一次，平时不耗量。只有限流小表每小时顺手清一次（就一条查询，可忽略）。\n点「立即清理一次」随时手动清，不受周期影响。`, [
    [btn("关闭自动", 0), btn("每天", 24), btn("每3天", 72), btn("每周", 168)],
    [{ text: "🧹 立即清理一次", callback_data: "cleanuprun" }],
    ROW_PANEL
  ]);
}
async function pgBackup(env) {
  const b = await collectBackup(env);
  const counts = { keys: (b.data.keys || []).length, users: (b.data.allowed_users || []).length, groups: (b.data.allowed_groups || []).length, cfg: Object.keys(b.data).filter(k => k.startsWith("gcfg:")).length };
  return pg(`💾 配置备份/恢复\n备份包含：Key 池（${counts.keys} 个 Key，含密钥原文）、授权名单（用户 ${counts.users} / 群 ${counts.groups}）、全部设置（当前模型、系统提示词、自定义模型、默认 Key 覆盖、CF 凭证、健康巡检设置）、各群的群设置（${counts.cfg} 个群）。\n不包含：对话记忆、群消息日志、使用统计。\n\n⚠️ 导出的文件里有 Key 原文，只会发到你和机器人的私聊，请自己妥善保存，别转发给任何人。`, [[{ text: "📤 导出备份文件", callback_data: "backupexport" }], [{ text: "📥 导入恢复", callback_data: "backupimport" }], ROW_PANEL]);
}
async function sendBackupFile(env, chatId) {
  const b = await collectBackup(env);
  const fd = new FormData();
  fd.append("chat_id", String(chatId));
  fd.append("document", new Blob([JSON.stringify(b, null, 2)], { type: "application/json" }), `tg-bot-backup-${new Date().toISOString().slice(0, 10)}.json`);
  fd.append("caption", "💾 机器人配置备份（含 Key 原文，请妥善保存、不要转发给任何人）");
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
  return r.json().catch(() => ({}));
}
async function handleRestoreFile(env, msg, flow) {
  const chatId = msg.chat.id, userId = msg.from.id, fKey = `flow:${chatId}:${userId}`;
  try {
    const doc = msg.document;
    if (doc.file_size && doc.file_size > 2 * 1024 * 1024) throw new Error("文件太大，不像备份文件");
    const gf = await tg(env.BOT_TOKEN, "getFile", { file_id: doc.file_id });
    const path = gf?.result?.file_path; if (!path) throw new Error("读取文件失败");
    const fr = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`);
    if (!fr.ok) throw new Error("下载文件失败");
    const parsed = JSON.parse(await fr.text());
    if (!parsed || parsed.app !== "openai-tg-bot" || !parsed.data) throw new Error("这不是本机器人的备份文件");
    const n = await applyBackup(env, parsed.data);
    await env.AUTH_KV.delete(fKey);
    await tryDelete(env, chatId, msg.message_id);
    return flowShow(env, chatId, flow, resultPage(`✅ 已恢复 ${n} 项配置（备份时间：${parsed.exported_at || "未知"}）。Key 池、授权名单和设置已按备份还原。你刚发的备份文件已从聊天里删除（里面有 Key 原文）。`));
  } catch (e) {
    return flowShow(env, chatId, flow, pg(`恢复失败：${e.message}。请重新发送正确的备份文件，或点取消：`, CANCEL_ROW));
  }
}
const ADMIN_HELP = [
  "📖 管理说明（所有功能都在管理面板里点按钮，本条消息原地切换，不刷屏）",
  "• 模型与接口：从接口实时拉模型列表点选切换；可设系统提示词；可一键自检接口",
  "• Key 管理：点 Key 进详情，可改名、改地址、更新 Key 值、设为使用中、删除；多个 Key 支持出错自动切换/轮流/只用当前",
  "• 授权管理：点按钮后按提示发对方 ID 即可授权/取消，管理员也在那里增删",
  "• 状态与维护：系统状态、使用统计、群发通知",
  "• 隐私：管理功能只能在私聊用；Key 只打码显示；误发的密钥消息会被自动删除",
].join("\n");
const USER_HELP = "❓ 使用说明\n• 直接发消息就能和我聊天，我会记住上下文\n• 发图片我也能看：把问题写在图片的说明文字里发给我（群里发图要在说明里 @我；需要当前模型支持视觉）\n• 发语音我也能听：我会先转成文字再回答（群里请用回复我的方式发语音）\n• 想画图用 /draw 加描述，比如 /draw 一只在太空里的猫；或者对我说「帮我画……」\n• 群里请 @我、回复我，或用 /ask 提问；回复别人的消息时 @我，我会结合被回复的内容回答；@我 说「总结」可直接选时间范围\n• 群功能（仅授权群）：/summary 选 1/6/12/24/48 小时让 AI 总结群消息；/search 关键词 检索群消息；/group 打开群功能菜单（总结、检索、活跃统计、自动总结）\n• 按钮可以查你的 ID、清空你自己的对话记忆\n• 你的对话只有你自己能看，密钥和管理信息只有管理员能看\n• 说明：授权群里机器人会记录最近的群消息（最多保留 72 小时）只用于总结和检索，密钥类消息永远不会被记录";

// ---------- Flows (prompt lives in the panel message and is edited in place) ----------
const CANCEL_ROW = [[{ text: "⬅ 取消并返回", callback_data: "flowcancel" }]];
async function startFlowEdit(env, chatId, userId, messageId, flow, prompt) {
  flow.prompt = messageId || null;
  await kvPut(env, `flow:${chatId}:${userId}`, flow, 600);
  const page = pg(prompt, CANCEL_ROW);
  if (messageId) { const r = await editPage(env, chatId, messageId, page); flow.prompt = r?.result?.message_id || messageId; await kvPut(env, `flow:${chatId}:${userId}`, flow, 600); }
  else { const r = await sendPage(env, chatId, page); flow.prompt = r?.result?.message_id || null; await kvPut(env, `flow:${chatId}:${userId}`, flow, 600); }
}
async function flowShow(env, chatId, flow, page) { return editPage(env, chatId, flow?.prompt, page); }
const AUTH_ACTIONS = {
  allow:      { list: "allowed_users", add: true,  label: "授权用户", ask: "请发送要授权的用户 ID（对方发 /id 可查到）：", done: (v) => `已授权用户 ${v}` },
  allowgroup: { list: "allowed_groups", add: true, label: "授权群", ask: "请发送要授权的群 ID（在群里发 /id 可查到，是负数）：", done: (v) => `已授权群 ${v}` },
  deny:       { list: "allowed_users", add: false, label: "取消用户授权", ask: "请发送要取消授权的用户 ID：", done: (v) => `已取消用户 ${v} 的授权` },
  denygroup:  { list: "allowed_groups", add: false, label: "取消群授权", ask: "请发送要取消授权的群 ID：", done: (v) => `已取消群 ${v} 的授权` },
  addadmin:   { list: "admins", add: true,  label: "添加管理员", ask: "请发送要添加为管理员的用户 ID：", done: (v) => `已添加管理员 ${v}` },
  deladmin:   { list: "admins", add: false, label: "删除管理员", ask: "请发送要删除的管理员 ID（环境变量里的管理员删不掉）：", done: (v) => `已删除管理员 ${v}` },
};
const EDIT_FIELDS = {
  name: { label: "改名", ask: (e) => `✏️ 给 Key「${e.name}」改名，请发送新名称：`, step: "input" },
  base: { label: "改地址", ask: (e) => `🔄 修改 Key「${e.name}」的接口地址（当前：${e.base_url}），请发送新地址：`, step: "input" },
  key:  { label: "更新 Key 值", ask: (e) => `🔑 更新 Key「${e.name}」的 Key 值（当前：${maskKey(e.key)}），请发送新 Key（发完我会立即删除你那条消息）：`, step: "key" },
  ua:   { label: "自定义 UA", ask: (e) => `🪪 设置 Key「${e.name}」的 User-Agent（当前：${e.ua || "未设置，用程序默认"}）。\n有些接口只认特定客户端（比如只认 claude-cli），把对方要求的 UA 原样发给我即可；发送「清除」可恢复默认：`, step: "input" },
};

async function handleFlow(env, msg, flow) {
  const chatId = msg.chat.id, userId = msg.from.id, text = msg.text.trim(), fKey = `flow:${chatId}:${userId}`;
  if (text.startsWith("/cancel")) { await env.AUTH_KV.delete(fKey); return flowShow(env, chatId, flow, resultPage("已取消。")); }
  const OWNER_FLOWS = ["auth", "setprompt", "broadcast", "editkey", "cfset", "restore", "addkey", "addmodel", "setapi"];
  if (OWNER_FLOWS.includes(flow.type) && !isOwner(env, userId)) { await env.AUTH_KV.delete(fKey); return flowShow(env, chatId, flow, resultPage("仅超级管理员可用。")); }
  if (flow.type === "auth") {
    const a = AUTH_ACTIONS[flow.action];
    if (!/^-?\d+$/.test(text)) return flowShow(env, chatId, flow, pg("这个 ID 不是纯数字，请重新发送（对方发 /id 可查到）：", CANCEL_ROW));
    await modList(env, a.list, text, a.add); await env.AUTH_KV.delete(fKey); await tryDelete(env, chatId, msg.message_id);
    return flowShow(env, chatId, flow, resultPage(`✅ ${a.done(text)}`));
  }
  if (flow.type === "setprompt") { await kvPut(env, "config:system_prompt", text); await env.AUTH_KV.delete(fKey); const d = await tryDelete(env, chatId, msg.message_id); return flowShow(env, chatId, flow, resultPage("📝 系统提示词已更新" + (d ? "（你刚发的那条已删除）" : ""))); }
  if (flow.type === "broadcast") {
    await kvPut(env, `bcast:${chatId}:${userId}`, text, 600); await env.AUTH_KV.delete(fKey); await tryDelete(env, chatId, msg.message_id);
    return flowShow(env, chatId, flow, pg(`📣 确认群发这条通知？\n\n${text}`, [[{ text: "确认群发", callback_data: "bcastgo" }], ROW_PANEL]));
  }
  if (flow.type === "editkey") {
    let stored = null, e = null;
    if (flow.target === "env") { const pool = await getPool(env); e = pool.find(x => x.isEnv) || null; }
    else { stored = await getStoredKeys(env); e = stored[flow.idx]; }
    if (!e) { await env.AUTH_KV.delete(fKey); return flowShow(env, chatId, flow, resultPage("这个 Key 已经不存在了。")); }
    const persistEdit = async () => { if (flow.target === "env") await kvPut(env, "config:envkey", { name: e.name, base_url: e.base_url, key: e.key, ...(e.api ? { api: e.api } : {}), ...(e.ua ? { ua: e.ua } : {}) }); else { stored[flow.idx] = e; await kvPut(env, "keys", stored); } };
    if (flow.field === "name") {
      const name = text.slice(0, 30);
      if (stored && stored.some((x, i) => i !== flow.idx && x.name === name)) return flowShow(env, chatId, flow, pg(`名称「${name}」已经被另一个 Key 用了，请换一个名称重新发送：`, CANCEL_ROW));
      const old = e.name; e.name = name; await persistEdit();
      const active = await kvGet(env, "config:active_key", null); if (active === old) await kvPut(env, "config:active_key", name);
      await env.AUTH_KV.delete(fKey); await tryDelete(env, chatId, msg.message_id);
      return flowShow(env, chatId, flow, pg(`✅ 已改名：「${old}」→「${name}」`, [[{ text: "⬅ 返回 Key 池", callback_data: "keys" }], ROW_PANEL]));
    }
    if (flow.field === "base") {
      e.base_url = normBase(text); await persistEdit();
      const deleted = await tryDelete(env, chatId, msg.message_id); await env.AUTH_KV.delete(fKey);
      return flowShow(env, chatId, flow, pg(`✅ Key「${e.name}」的地址已更新为：${e.base_url}` + (deleted ? "" : ""), [[{ text: "⬅ 返回 Key 池", callback_data: "keys" }], ROW_PANEL]));
    }
    if (flow.field === "key") {
      e.key = text; await persistEdit();
      const deleted = await tryDelete(env, chatId, msg.message_id); await env.AUTH_KV.delete(fKey);
      return flowShow(env, chatId, flow, pg(`✅ Key「${e.name}」的 Key 值已更新：${maskKey(text)}` + (deleted ? "\n你刚发 Key 的那条消息已删除。" : "\n⚠️ 你刚发 Key 的那条消息我没能删掉，请马上手动删除。"), [[{ text: "⬅ 返回 Key 池", callback_data: "keys" }], ROW_PANEL]));
    }
    if (flow.field === "ua") {
      if (text === "清除" || text === "删除" || text.toLowerCase() === "clear") delete e.ua;
      else e.ua = text.replace(/\s+/g, " ").slice(0, 200);
      await persistEdit();
      await env.AUTH_KV.delete(fKey); await tryDelete(env, chatId, msg.message_id);
      return flowShow(env, chatId, flow, pg(`✅ Key「${e.name}」的 UA 已${e.ua ? `设置为：${e.ua}` : "清除，恢复默认"}`, [[{ text: "⬅ 返回 Key 池", callback_data: "keys" }], ROW_PANEL]));
    }
  }
  if (flow.type === "cfset") {
    if (flow.step === "account") {
      if (!/^[0-9a-f]{32}$/i.test(text)) return flowShow(env, chatId, flow, pg("这个账户 ID 格式不对（应是 32 位十六进制），请重新发送：", CANCEL_ROW));
      flow.step = "key"; flow.account = text.toLowerCase(); await kvPut(env, fKey, flow, 600); await tryDelete(env, chatId, msg.message_id);
      return flowShow(env, chatId, flow, pg("好，再发只读 API Token（权限：账户分析 读取；发完我会立即删除你那条消息，Token 只打码显示）：", CANCEL_ROW));
    }
    if (flow.step === "key") {
      await kvPut(env, "config:cf", { account: flow.account, token: text });
      await env.AUTH_KV.delete(fKey);
      const deleted = await tryDelete(env, chatId, msg.message_id);
      return flowShow(env, chatId, flow, pg(`✅ CF 查询凭证已保存：账户 ${flow.account.slice(0, 8)}… / Token ${maskKey(text)}` + (deleted ? "\n你刚发 Token 的那条消息已删除。" : "\n⚠️ 你刚发 Token 的那条消息我没能删掉，请马上手动删除。"), [[{ text: "☁️ 查看 CF 用量", callback_data: "cfusage" }], ROW_PANEL]));
    }
  }
  if (flow.type === "restore") {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || parsed.app !== "openai-tg-bot" || !parsed.data) throw new Error("格式不对");
      const n = await applyBackup(env, parsed.data);
      await env.AUTH_KV.delete(fKey);
      await tryDelete(env, chatId, msg.message_id);
      return flowShow(env, chatId, flow, resultPage(`✅ 已恢复 ${n} 项配置（备份时间：${parsed.exported_at || "未知"}）。你刚粘贴的那条消息已删除（里面有 Key 原文）。`));
    } catch { return flowShow(env, chatId, flow, pg("这段内容不是有效的备份 JSON。请发送备份文件，或把完整的 JSON 内容粘贴过来（别漏开头和结尾的大括号）：", CANCEL_ROW)); }
  }
  if (flow.type === "addmodel") {
    const name = text.trim();
    if (!name || /\s/.test(name) || name.length > 80) return flowShow(env, chatId, flow, pg("模型名格式不对（不能有空格，最长 80 个字符），请重新发送：", CANCEL_ROW));
    const base = flow.base || "";
    const all = await getAllCustoms(env);
    if (!all.some(c => c.name === name && c.base === base)) { all.push({ name, base }); await kvPut(env, "config:custom_models", all); }
    await kvPut(env, "config:model", name);
    await env.AUTH_KV.delete(fKey); await tryDelete(env, chatId, msg.message_id);
    return flowShow(env, chatId, flow, pg(`✅ 已给当前接口添加自定义模型「${name}」并切换为当前模型。\n它只会出现在这个 Key/接口的选模型列表里，切到别的 Key 不会显示。\n随便发条消息试试；如果接口报错说模型不存在，就是名字和接口要求的不一致，删掉重加即可。`, [[{ text: "🎛 返回选模型", callback_data: "models" }], ROW_PANEL]));
  }
  if (flow.type === "addkey") {
    if (flow.step === "name") { flow.step = "base"; flow.name = text.slice(0, 30); await kvPut(env, fKey, flow, 600); await tryDelete(env, chatId, msg.message_id); return flowShow(env, chatId, flow, pg("好，再发接口地址（比如 https://api.openai.com/v1）：", CANCEL_ROW)); }
    if (flow.step === "base") { flow.step = "key"; flow.base_url = normBase(text); await kvPut(env, fKey, flow, 600); await tryDelete(env, chatId, msg.message_id); return flowShow(env, chatId, flow, pg("最后发 Key（发完我会立即删除你那条消息）：", CANCEL_ROW)); }
    if (flow.step === "key") {
      const stored = await getStoredKeys(env); stored.push({ name: flow.name || `key${stored.length + 1}`, base_url: flow.base_url, key: text }); await kvPut(env, "keys", stored);
      await kvPut(env, "config:active_key", stored[stored.length - 1].name); await env.AUTH_KV.delete(fKey);
      const deleted = await tryDelete(env, chatId, msg.message_id);
      return flowShow(env, chatId, flow, resultPage(`✅ 已添加并切换到 Key「${stored[stored.length - 1].name}」：${flow.base_url} / ${maskKey(text)}` + (deleted ? "\n你刚发 Key 的那条消息已删除。" : "\n⚠️ 你刚发 Key 的那条消息我没能删掉，请马上手动删除。") + "\n在「模型与接口」里点选模型就能用了。"));
    }
  }
  if (flow.type === "setapi") {
    if (flow.step === "base") { flow.step = "key"; flow.base_url = normBase(text); await kvPut(env, fKey, flow, 600); await tryDelete(env, chatId, msg.message_id); return flowShow(env, chatId, flow, pg("好，再发新的 Key（发完我会立即删除你那条消息）：", CANCEL_ROW)); }
    if (flow.step === "key") {
      const stored = await getStoredKeys(env); const ex = stored.find(e => e.name === "当前");
      if (ex) { ex.base_url = flow.base_url; ex.key = text; const i = stored.findIndex(e => e.name === "当前"); stored[i] = ex; } else stored.push({ name: "当前", base_url: flow.base_url, key: text });
      await kvPut(env, "keys", stored); await kvPut(env, "config:active_key", "当前"); await env.AUTH_KV.delete(fKey);
      const deleted = await tryDelete(env, chatId, msg.message_id);
      return flowShow(env, chatId, flow, resultPage(`✅ 接口已更新并切换：${flow.base_url} / ${maskKey(text)}` + (deleted ? "\n你刚发 Key 的那条消息已删除。" : "\n⚠️ 你刚发 Key 的那条消息我没能删掉，请马上手动删除。") + "\n在「模型与接口」里重新选一下模型吧。"));
    }
  }
}

// ---------- Typed admin commands (entry points; they open a fresh panel message) ----------
async function handleAdminCmd(env, msg, text) {
  const chatId = msg.chat.id, userId = msg.from.id, parts = text.trim().split(/\s+/), cmd = parts[0].split("@")[0], arg = parts[1], rest = text.trim().slice(parts[0].length).trim();
  if (cmd === "/panel" || cmd === "/admin") return sendPage(env, chatId, pgPanel(isOwner(env, userId)));
  if (cmd === "/model") return sendPage(env, chatId, await pgModels(env, chatId, isOwner(env, userId)));
  if (cmd === "/keys") return sendPage(env, chatId, await pgKeys(env));
  if (cmd === "/keymode") { if (arg && ["fallback", "rotate", "single"].includes(arg)) { await kvPut(env, "config:key_mode", arg); return sendPage(env, chatId, resultPage(`Key 模式已切换为：${arg}`)); } return sendPage(env, chatId, await pgModes(env)); }
  if (cmd === "/addkey") {
    if (parts.length >= 4) {
      const [_, name, base, ...keyParts] = parts, key = keyParts.join("");
      const stored = await getStoredKeys(env); stored.push({ name, base_url: normBase(base), key }); await kvPut(env, "keys", stored);
      const deleted = await tryDelete(env, chatId, msg.message_id);
      return sendPage(env, chatId, resultPage(`已添加 Key「${name}」：${normBase(base)} / ${maskKey(key)}` + (deleted ? "\n你刚发的那条消息已删除。" : "\n⚠️ 你刚发的那条消息我没能删掉，请马上手动删除。")));
    }
    return startFlowEdit(env, chatId, userId, null, { type: "addkey", step: "name" }, "➕ 添加 Key：先发一个名称（比如：主力、备用1）：");
  }
  if (cmd === "/setapi") return startFlowEdit(env, chatId, userId, null, { type: "setapi", step: "base" }, "🔄 更新接口：先发新的接口地址（比如 https://api.openai.com/v1）：");
  if (cmd === "/delkey") {
    if (!arg) return sendPage(env, chatId, await pgDelKeys(env));
    const stored = await getStoredKeys(env); const idx = /^\d+$/.test(arg) ? Number(arg) - 1 : stored.findIndex(e => e.name === arg);
    if (idx < 0 || !stored[idx]) return sendPage(env, chatId, resultPage("没找到这个 Key（默认 Key 来自环境变量，不能在这里删）。"));
    const [gone] = stored.splice(idx, 1); await kvPut(env, "keys", stored); return sendPage(env, chatId, resultPage(`已删除 Key「${gone.name}」`));
  }
  if (cmd === "/usekey" && arg) { const pool = await getPool(env); const idx = /^\d+$/.test(arg) ? Number(arg) - 1 : pool.findIndex(e => e.name === arg); if (idx < 0 || !pool[idx]) return sendPage(env, chatId, resultPage("没找到这个 Key。")); await kvPut(env, "config:active_key", pool[idx].name); return sendPage(env, chatId, resultPage(`已切换到 Key「${pool[idx].name}」`)); }
  if (cmd === "/allow" && arg) { await modList(env, "allowed_users", arg, true); return sendPage(env, chatId, resultPage(`已授权用户 ${arg}`)); }
  if (cmd === "/allowgroup" && arg) { await modList(env, "allowed_groups", arg, true); return sendPage(env, chatId, resultPage(`已授权群 ${arg}`)); }
  if (cmd === "/deny" && arg) { await modList(env, "allowed_users", arg, false); return sendPage(env, chatId, resultPage(`已取消用户 ${arg}`)); }
  if (cmd === "/denygroup" && arg) { await modList(env, "allowed_groups", arg, false); return sendPage(env, chatId, resultPage(`已取消群 ${arg}`)); }
  if (cmd === "/addadmin" && arg) { await modList(env, "admins", arg, true); return sendPage(env, chatId, resultPage(`已添加管理员 ${arg}`)); }
  if (cmd === "/deladmin" && arg) { await modList(env, "admins", arg, false); return sendPage(env, chatId, resultPage(`已删除管理员 ${arg}`)); }
  if (cmd === "/listauth") return sendPage(env, chatId, await pgListAuth(env));
  if (cmd === "/setprompt") { if (rest) { await kvPut(env, "config:system_prompt", rest); return sendPage(env, chatId, resultPage("系统提示词已更新")); } return startFlowEdit(env, chatId, userId, null, { type: "setprompt", step: "input" }, "📝 请发送新的系统提示词："); }
  if (cmd === "/stats") return sendPage(env, chatId, await pgStats(env));
  if (cmd === "/broadcast") { if (rest) { await kvPut(env, `bcast:${chatId}:${userId}`, rest, 600); return tg(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: `📣 确认群发这条通知？\n\n${rest}`, reply_markup: { inline_keyboard: [[{ text: "确认群发", callback_data: "bcastgo" }], ROW_PANEL] } }); } return startFlowEdit(env, chatId, userId, null, { type: "broadcast", step: "input" }, "📣 请发送要群发给所有已授权用户/群的通知内容："); }
  return sendPage(env, chatId, resultPage(ADMIN_HELP));
}

// ---------- Chat (placeholder edited into the reply) ----------
async function chatReply(env, msg, prompt, image) {
  const chatId = msg.chat.id, userId = msg.from.id;
  if (!(await rateOk(env, userId))) return sendTemp(env, chatId, "太频繁了，请稍等一分钟。");
  await setLast(env, chatId, userId, prompt);
  const placeholder = await tg(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: image ? "🖼 正在看图…" : "⏳ 思考中…", ...(msg.chat.type !== "private" ? { reply_parameters: { message_id: msg.message_id } } : {}) });
  if (placeholder.ok) await trackBotMsg(env, chatId, placeholder.result.message_id, 0);
  const convo = await loadConvo(env, chatId, userId);
  let history = convo.history, memo = convo.memo;
  history.push({ role: "user", content: image ? `[图片] ${prompt}` : prompt });
  if (history.length > HISTORY_TURNS * 2 - 2) {
    const keep = history.slice(-10), old = history.slice(0, -10);
    try {
      const digest = await askAI(env, [{ role: "user", content: `请把下面内容压缩成一份简短备忘（300 字以内），保留：用户透露的个人信息与偏好、重要话题和结论、未完成的事。用第三人称分点记录，只记录真实出现过的内容，不要编造。\n${memo ? `【已有备忘】\n${memo}\n` : ""}【较早的对话】\n${old.map(m => `${m.role === "user" ? "用户" : "AI"}：${String(m.content).slice(0, 300)}`).join("\n")}` }]);
      memo = String(digest).slice(0, 1200);
      history = keep;
    } catch { history = history.slice(-HISTORY_TURNS * 2); }
  }
  try {
    const recent = history.slice(-HISTORY_TURNS * 2);
    const sendHistory = memo ? [{ role: "system", content: `这是你和这位用户之前对话的备忘，回答时可以参考：\n${memo}` }, ...recent] : recent;
    if (image) sendHistory[sendHistory.length - 1] = { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: image } }] };
    let aiOpts;
    if (msg.chat.type !== "private") { const gcfg = await kvGet(env, `gcfg:${chatId}`, {}); if (gcfg.model || gcfg.prompt) aiOpts = { model: gcfg.model || undefined, key: gcfg.key || undefined, system: gcfg.prompt || undefined }; }
    else { const ucfg = await kvGet(env, `ucfg:${userId}`, {}); if (ucfg.model) aiOpts = { model: ucfg.model, key: ucfg.key || undefined }; }
    let streamed = false, lastEdit = 0, lastLen = 0, edits = 0;
    const onText = async (acc) => {
      streamed = true;
      if (!placeholder.ok || edits >= 35) return;
      const now = Date.now();
      if (now - lastEdit < 1200 && acc.length - lastLen < 200) return;
      if (acc.length - lastLen < 30 && now - lastEdit < 3000) return;
      lastEdit = now; lastLen = acc.length; edits++;
      await tg(env.BOT_TOKEN, "editMessageText", { chat_id: chatId, message_id: placeholder.result.message_id, text: acc.slice(0, 3900) + " ▌" }).catch(() => {});
    };
    let reply, usedRoute = null;
    try { const r = await askAIStreamR(env, sendHistory, aiOpts, onText); reply = r.text; if (r.idx > 0) usedRoute = r; }
    catch (e) { if (streamed) throw e; const r2 = await askAIR(env, sendHistory, aiOpts); reply = r2.text; if (r2.idx > 0) usedRoute = r2; }
    if (usedRoute && msg.chat.type === "private") reply += `\n\n（主模型无响应，已自动切换备用模型：${usedRoute.keyName} · ${usedRoute.model}）`;
    history.push({ role: "assistant", content: reply });
    await saveConvo(env, chatId, userId, history.slice(-HISTORY_TURNS * 2), memo, prompt);
    await bumpStats(env, userId);
    const chunks = splitText(reply);
    const buttons = { inline_keyboard: [[{ text: "🔄 重新生成", callback_data: "regen" }, { text: "🧹 清空记忆", callback_data: "clearmine" }]] };
    if (placeholder.ok) {
      const mid = placeholder.result.message_id;
      let done = false;
      if (chunks.length === 1 && reply.length > 1500) {
        const html = collapsibleHtml(reply);
        if (html) { const r = await tg(env.BOT_TOKEN, "editMessageText", { chat_id: chatId, message_id: mid, text: html, parse_mode: "HTML", reply_markup: buttons }); done = !!r.ok; }
      }
      if (!done) {
        await tg(env.BOT_TOKEN, "editMessageText", { chat_id: chatId, message_id: mid, text: chunks[0], reply_markup: chunks.length === 1 ? buttons : { inline_keyboard: [] } });
        for (let i = 1; i < chunks.length; i++) await send(env, chatId, chunks[i], i === chunks.length - 1 ? { reply_markup: buttons } : undefined);
      }
      await kvPut(env, `regenowner:${chatId}:${mid}`, String(userId), 60 * 60 * 6);
    } else await send(env, chatId, reply);
  } catch (e) {
    const isAdm = isOwner(env, userId);
    const errText = isAdm ? `调用模型失败：${e.message}` : "调用失败，请稍后再试，或联系管理员。";
    if (placeholder.ok) await tg(env.BOT_TOKEN, "editMessageText", { chat_id: chatId, message_id: placeholder.result.message_id, text: errText }).catch(async () => send(env, chatId, errText));
    else await send(env, chatId, errText);
  }
}
async function handlePhoto(env, msg) {
  const chatId = msg.chat.id, userId = msg.from.id;
  const caption = (msg.caption || "").trim();
  if (caption && looksSecret(caption)) {
    const deleted = await tryDelete(env, chatId, msg.message_id);
    await send(env, chatId, deleted ? "⚠️ 图片说明里有疑似密钥/Token，我已经帮你删掉了这条消息，也不会保存或转发。" : "⚠️ 图片说明里有疑似密钥/Token，我不会保存或转发，但没能替你删掉，请马上手动删除这条消息。");
    return;
  }
  if (msg.chat.type !== "private") {
    const mentioned = !!msg.caption_entities?.some(e => e.type === "mention");
    const isReply = msg.reply_to_message?.from?.is_bot;
    if (!mentioned && !isReply) return;
    if (!(await isAllowed(env, msg.chat, userId))) return;
    await logGroupMessage(env, { ...msg, text: caption ? `[图片] ${caption.replace(/@\S+/g, "").trim()}` : "[图片]" });
  } else if (!(await isAllowed(env, msg.chat, userId))) {
    await send(env, chatId, `未授权。请把你的 ID 发给管理员授权：${userId}`);
    return;
  }
  const photo = msg.photo[msg.photo.length - 1];
  if (photo.file_size && photo.file_size > 10 * 1024 * 1024) { await send(env, chatId, "这张图太大了（超过 10MB），压缩一下再发。"); return; }
  try {
    const gf = await tg(env.BOT_TOKEN, "getFile", { file_id: photo.file_id });
    const path = gf?.result?.file_path; if (!path) throw new Error("读取图片失败");
    const fr = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`);
    if (!fr.ok) throw new Error("下载图片失败");
    const buf = new Uint8Array(await fr.arrayBuffer());
    let bin = ""; const CH = 0x8000;
    for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
    const mime = /\.png$/i.test(path) ? "image/png" : /\.webp$/i.test(path) ? "image/webp" : "image/jpeg";
    const dataUrl = `data:${mime};base64,${btoa(bin)}`;
    const question = caption.replace(/@\S+/g, "").trim() || "请描述并分析这张图片";
    await chatReply(env, msg, question, dataUrl);
  } catch (e) {
    await send(env, chatId, isOwner(env, userId) ? `看图失败：${e.message}（当前模型可能不支持图片输入，换个支持视觉的模型试试）` : "看图失败，当前模型可能不支持图片，联系管理员换个支持视觉的模型试试。");
  }
}
async function scanAsrModels(env) {
  const pool = await getPool(env); const found = [];
  for (const e of pool) {
    try { const ms = await fetchModels(env, e); for (const m of ms) if (/(whisper|sensevoice|paraformer|funasr|asr|speech-recognition)/i.test(m)) found.push({ entry: e.name, model: m }); } catch {}
  }
  return found;
}
async function pgAsr(env, chatId) {
  const cur = await kvGet(env, "config:asr", null);
  const rows = [[{ text: "🔍 扫描各接口的转写模型", callback_data: "asrscan" }]];
  if (cur) rows.push([{ text: "🗑 清除转写设置（改用自动扫描）", callback_data: "asrclear" }]);
  rows.push(ROW_PANEL);
  return pg(`🎙 语音转写设置\n当前：${cur ? `用 Key「${cur.entry}」的 ${cur.model}` : "未指定（收到语音时自动扫描各接口找转写模型，找到能用的会自动记住）"}\n\n说明：用户发语音时，机器人先用转写模型把语音转成文字，再交给当前聊天模型回答。转写模型在接口的模型列表里，名字一般带 whisper / SenseVoice / Paraformer / ASR。`, rows);
}
async function pgAsrScan(env, chatId) {
  const found = await scanAsrModels(env);
  await kvPut(env, `asrscan:${chatId}`, found, 600);
  if (!found.length) return pg("🔍 扫描完了：所有接口的模型列表里都没找到转写模型（名字带 whisper/SenseVoice/Paraformer/ASR 的）。\n把带转写模型的接口（比如硅基）加进 Key 池后再扫描。", [[{ text: "⬅ 返回语音设置", callback_data: "asr" }], ROW_PANEL]);
  const rows = found.map((f, i) => [{ text: `🎙 ${f.entry} · ${f.model}`.slice(0, 42), callback_data: `asrpick:${i}` }]);
  rows.push([{ text: "⬅ 返回语音设置", callback_data: "asr" }], ROW_PANEL);
  return pg("🔍 找到这些转写模型，点一个设为默认转写模型：", rows);
}
async function transcribe(env, blob, filename) {
  const pool = await getPool(env);
  const tryOne = async (entry, model) => {
    const fd = new FormData();
    fd.append("file", blob, filename);
    fd.append("model", model);
    const r = await fetch(`${normBase(entry.base_url)}/audio/transcriptions`, { method: "POST", headers: uaH(entry, { authorization: `Bearer ${entry.key}` }), body: fd });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
    if (!data.text) throw new Error("转写结果为空");
    return data.text;
  };
  const cfg = await kvGet(env, "config:asr", null);
  if (cfg) { const e = pool.find(x => x.name === cfg.entry); if (e) return tryOne(e, cfg.model); }
  const found = await scanAsrModels(env);
  for (const f of found) {
    const e = pool.find(x => x.name === f.entry);
    if (!e) continue;
    try { const text = await tryOne(e, f.model); await kvPut(env, "config:asr", { entry: f.entry, model: f.model }); return text; } catch {}
  }
  throw new Error("没有可用的语音转写模型");
}
async function handleVoice(env, msg) {
  const chatId = msg.chat.id, userId = msg.from.id;
  const voice = msg.voice || msg.audio;
  if (msg.chat.type !== "private") {
    if (!msg.reply_to_message?.from?.is_bot) return;
    if (!(await isAllowed(env, msg.chat, userId))) return;
    await logGroupMessage(env, { ...msg, text: "[语音消息]" });
  } else if (!(await isAllowed(env, msg.chat, userId))) {
    await send(env, chatId, `未授权。请把你的 ID 发给管理员授权：${userId}`);
    return;
  }
  if (voice.duration && voice.duration > 300) { await send(env, chatId, "这条语音太长了（超过 5 分钟），请分段发。"); return; }
  if (voice.file_size && voice.file_size > 10 * 1024 * 1024) { await send(env, chatId, "语音文件太大了，换条短一点的。"); return; }
  const note = await tg(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "🎙 正在转写语音…" });
  const noteEdit = async (t) => { if (note.ok) await tg(env.BOT_TOKEN, "editMessageText", { chat_id: chatId, message_id: note.result.message_id, text: t }).catch(() => {}); else await send(env, chatId, t); };
  try {
    const gf = await tg(env.BOT_TOKEN, "getFile", { file_id: voice.file_id });
    const path = gf?.result?.file_path; if (!path) throw new Error("读取语音失败");
    const fr = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${path}`);
    if (!fr.ok) throw new Error("下载语音失败");
    const blob = new Blob([await fr.arrayBuffer()], { type: voice.mime_type || "audio/ogg" });
    const text = (await transcribe(env, blob, "voice.ogg")).trim();
    if (!text) throw new Error("没听清内容");
    if (looksSecret(text)) { await noteEdit("⚠️ 转写内容里有疑似密钥/Token，已停止处理。不要用语音发送密钥类信息。"); return; }
    await noteEdit(`🎙 转写：${text}`.slice(0, 3900));
    await chatReply(env, msg, text);
  } catch (e) {
    await noteEdit(isOwner(env, userId) ? `语音转写失败：${e.message}。到管理面板「模型与接口 → 语音转写设置」里扫描并指定一个转写模型试试。` : "语音转写失败：可能还没配置转写模型，请联系管理员。");
  }
}
async function cfToday(env) {
  const cfg = await kvGet(env, "config:cf", null);
  if (!cfg?.token || !cfg?.account) return null;
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const iso = (d) => d.toISOString().replace(/\.\d+Z$/, "Z");
  const vars = { a: cfg.account, s: iso(start), e: iso(new Date(start.getTime() + 86400000)) };
  const acc = await cfGQL(env, cfg, `query($a: string, $s: Time, $e: Time) { viewer { accounts(filter: {accountTag: $a}) { workersInvocationsAdaptive(limit: 1, filter: {datetime_geq: $s, datetime_lt: $e}) { sum { requests } } kvOperationsAdaptiveGroups(limit: 100, filter: {datetime_geq: $s, datetime_lt: $e}) { count dimensions { actionType } } } } }`, vars);
  const req = acc.workersInvocationsAdaptive?.[0]?.sum?.requests || 0;
  let kvW = 0;
  for (const g of acc.kvOperationsAdaptiveGroups || []) { const a = String(g.dimensions.actionType).toLowerCase(); if (a === "write" || a === "put") kvW += g.count || 0; }
  return { req, kvW };
}
const IMG_MODEL_RE = /(gpt-image|dall-e|imagen|flux|kolors|stable-diffusion|sdxl|cogview|midjourney)/i;
async function drawImage(env, msg, promptText) {
  const chatId = msg.chat.id, userId = msg.from.id;
  if (!(await rateOk(env, userId))) return sendTemp(env, chatId, "太频繁了，请稍等一分钟。");
  const note = await tg(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "🎨 正在画图，稍等…" });
  const noteEdit = async (t) => { if (note.ok) await tg(env.BOT_TOKEN, "editMessageText", { chat_id: chatId, message_id: note.result.message_id, text: t }).catch(() => {}); else await send(env, chatId, t); };
  try {
    const pool = await getPool(env);
    if (!pool.length) throw new Error("还没有配置任何 Key");
    let cfg = await kvGet(env, "config:draw", null);
    let entry = cfg ? pool.find(e => e.name === cfg.entry) : null, model = cfg?.model;
    if (!entry || !model) {
      let found = false;
      for (const e of pool) {
        try { const ms = await fetchModels(env, e); const m = ms.find(x => IMG_MODEL_RE.test(x)); if (m) { entry = e; model = m; await kvPut(env, "config:draw", { entry: e.name, model: m }); found = true; break; } } catch {}
      }
      if (!found) { entry = null; model = null; }
    }
    if (!entry || !model) throw new Error("Key 池里没有任何接口提供画图模型（gpt-image、Kolors、Flux 等），先加一个带画图模型的 Key");
    const r = await fetch(`${normBase(entry.base_url)}/images/generations`, { method: "POST", headers: uaH(entry, { "content-type": "application/json", authorization: `Bearer ${entry.key}` }), body: JSON.stringify({ model, prompt: promptText, n: 1, size: "1024x1024" }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
    const item = data.data?.[0];
    if (!item) throw new Error("接口没有返回图片");
    const caption = `🎨 ${promptText}`.slice(0, 900);
    let sent = null;
    if (item.url) sent = await tg(env.BOT_TOKEN, "sendPhoto", { chat_id: chatId, photo: item.url, caption });
    else if (item.b64_json) {
      const bin = Uint8Array.from(atob(item.b64_json), c => c.charCodeAt(0));
      const fd = new FormData(); fd.append("chat_id", String(chatId)); fd.append("photo", new Blob([bin], { type: "image/png" }), "draw.png"); fd.append("caption", caption);
      const rr = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`, { method: "POST", body: fd });
      sent = await rr.json().catch(() => ({}));
    }
    if (!sent || !sent.ok) throw new Error(sent?.description || "发送图片失败");
    await trackBotMsg(env, chatId, sent.result?.message_id, 0);
    if (note.ok) await tg(env.BOT_TOKEN, "deleteMessage", { chat_id: chatId, message_id: note.result.message_id }).catch(() => {});
  } catch (e) {
    await noteEdit(isOwner(env, userId) ? `画图失败：${e.message}` : "画图失败，请稍后再试或联系管理员。");
  }
}
function userKeyboard(isAdm) {
  const rows = [[{ text: "🆔 我的 ID", callback_data: "myid" }, { text: "🧹 清空记忆", callback_data: "clearmine" }], [{ text: "❓ 使用说明", callback_data: "userhelp" }, { text: "🎨 画图", callback_data: "drawbtn" }]];
  rows.push([{ text: "🧹 自动清理机器人消息", callback_data: "autodel" }]);
  if (isAdm) rows.push([{ text: "🛠 管理面板", callback_data: "panel" }]);
  return rows;
}

async function handleFetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") { const ready = !!(env.BOT_TOKEN && env.AUTH_KV); return Response.json({ ok: true, service: "openai-tg-bot", ready, hint: ready ? "POST webhook is live" : "Missing BOT_TOKEN / AUTH_KV binding" }); }
    if (request.method === "GET" && url.pathname === "/setwebhook") {
      if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET) return Response.json({ ok: false, error: "Set BOT_TOKEN and WEBHOOK_SECRET first" }, { status: 400 });
      const res = await tg(env.BOT_TOKEN, "setWebhook", { url: `${url.origin}/webhook`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
      return Response.json(res);
    }
    if (request.method === "GET" && url.pathname === "/setcommands") {
      if (!env.BOT_TOKEN) return Response.json({ ok: false, error: "Set BOT_TOKEN first" }, { status: 400 });
      const basic = [
        { command: "start", description: "开始使用" }, { command: "help", description: "查看帮助" },
        { command: "id", description: "查看我的ID" }, { command: "clear", description: "清空我的对话记忆" },
        { command: "ask", description: "在群里向我提问" },
        { command: "draw", description: "画图，如 /draw 一只猫" },
      ];
      const groupCmds = [...basic,
        { command: "summary", description: "AI 总结群消息（选时间范围）" },
        { command: "search", description: "检索群消息关键词，如 /search 报价" },
        { command: "group", description: "群功能菜单" },
        { command: "score", description: "记分管理（回复成员消息后发送）" },
        { command: "info", description: "查看成员档案（回复成员消息后发送）" }];
      const adminMenu = [...basic, { command: "panel", description: "管理面板（管理员专用）" }];
      const results = {};
      results.default = await tg(env.BOT_TOKEN, "setMyCommands", { commands: basic, scope: { type: "default" } });
      results.groups = await tg(env.BOT_TOKEN, "setMyCommands", { commands: groupCmds, scope: { type: "all_group_chats" } });
      const adminId = String(env.ADMIN_IDS || "").split(",")[0].trim();
      if (adminId) results.admin_chat = await tg(env.BOT_TOKEN, "setMyCommands", { commands: adminMenu, scope: { type: "chat", chat_id: Number(adminId) } });
      return Response.json(results);
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") return new Response("not found", { status: 404 });
    if (env.WEBHOOK_SECRET && request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
    if (!env.BOT_TOKEN) return Response.json({ ok: false, error: "not configured" }, { status: 500 });

    const update = await request.json().catch(() => null);
    if (!update) return Response.json({ ok: true });

    // ---------- callbacks ----------
    if (update.callback_query) {
      const cq = update.callback_query, chatId = cq.message.chat.id, fromId = cq.from.id, data = cq.data || "", mid = cq.message.message_id;
      await sweepTempMsgs(env, chatId);
      if (data === "autodel" || data.startsWith("autodel:") || data === "autodelnow") {
        if (cq.message.chat.type !== "private" || !(await isAllowed(env, cq.message.chat, fromId))) { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "只能在已授权的私聊里设置", show_alert: true }); return Response.json({ ok: true }); }
        if (data.startsWith("autodel:")) {
          const h = Number(data.slice(8));
          const u = await kvGet(env, `ucfg:${fromId}`, {}); u.autodel = h; await kvPut(env, `ucfg:${fromId}`, u);
          await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: h ? `✅ 已开启：自动删除 ${h} 小时前的机器人消息` : "✅ 已关闭自动删除" });
        } else if (data === "autodelnow") {
          const h = await autodelHours(env, chatId);
          if (!h) { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "先选一个时间档位，再立即清理", show_alert: true }); return Response.json({ ok: true }); }
          await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "正在清理…" });
          const n = await cleanBotMsgsNow(env, chatId, h);
          await sendTemp(env, chatId, `🧹 已清理 ${n} 条超过 ${h} 小时的机器人消息。（这类操作提示 2 分钟后会自动删除）`);
          return Response.json({ ok: true });
        } else await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id });
        await editPage(env, chatId, mid, await pgAutoDelPrivate(env, chatId));
        return Response.json({ ok: true });
      }
      if (["myid", "clearmine", "userhelp", "regen", "drawbtn"].includes(data)) {
        if (data === "myid") { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: `你的 ID：${fromId}`, show_alert: true }); return Response.json({ ok: true }); }
        await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id });
        if (data === "userhelp") await send(env, chatId, USER_HELP);
        if (data === "drawbtn") {
          if (!(await isAllowed(env, cq.message.chat, fromId))) { await send(env, chatId, "未授权。"); return Response.json({ ok: true }); }
          await kvPut(env, `drawflow:${chatId}:${fromId}`, { at: Date.now() }, 300);
          await send(env, chatId, "🎨 想画什么？直接把描述发给我，比如：一只在太空里喝奶茶的猫");
        }
        if (data === "clearmine") { await dbHistClear(env, chatId, fromId); await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "已清空你自己的对话记忆" }).catch(() => {}); await send(env, chatId, "🧹 你自己的对话记忆已清空，其他人的不受影响。"); }
        if (data === "regen") {
          const owner = await env.AUTH_KV.get(`regenowner:${chatId}:${mid}`);
          if (owner && owner !== String(fromId) && !(await isAdmin(env, fromId))) { await send(env, chatId, "这是别人的对话，只能由本人重新生成。"); return Response.json({ ok: true }); }
          const convo = await loadConvo(env, chatId, fromId);
          const last = convo.last;
          if (!last) { await send(env, chatId, "没有可重新生成的上一条消息。"); return Response.json({ ok: true }); }
          if (!(await isAllowed(env, cq.message.chat, fromId))) { await send(env, chatId, "未授权。"); return Response.json({ ok: true }); }
          const h = convo.history;
          if (h.length && h[h.length - 1].role === "assistant") h.pop();
          if (h.length && h[h.length - 1].role === "user") h.pop();
          await saveConvo(env, chatId, fromId, h, convo.memo, last);
          await chatReply(env, { chat: cq.message.chat, from: cq.from }, last);
        }
        return Response.json({ ok: true });
      }
      // Group features (authorized groups only; not admin-gated; edited in place).
      if (cq.message.chat.type !== "private" && (data === "gmenu" || data === "gsummary" || data === "gsearch" || data === "gstats" || data === "gspam" || data === "gspamlog" || data === "gmodel" || data.startsWith("gmodel:") || data.startsWith("gcmodel:") || data === "gprompt" || data === "gclear" || data.startsWith("sum:") || data.startsWith("gauto:") || data === "gscore" || data === "gmembers" || data === "gautodel" || data.startsWith("gautodel:") || data === "gautodelnow" || data.startsWith("gsu:") || data.startsWith("sc:") || data.startsWith("spok:") || data.startsWith("spup:"))) {
        if (!(await isAllowed(env, cq.message.chat, fromId))) { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "本群未授权" }); return Response.json({ ok: true }); }
        const gedit = (page) => editPage(env, chatId, mid, page);
        if (data.startsWith("gauto:")) {
          const want = Number(data.slice(6));
          if (!(await isGroupAdmin(env, chatId, fromId))) { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "只有群主/群管理员或机器人管理员能改自动总结", show_alert: true }); return Response.json({ ok: true }); }
          const cfg = await kvGet(env, `gcfg:${chatId}`, { auto: 0, last: 0 });
          if (Number(cfg.auto) === want) { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: want === 0 ? "自动总结已经是关闭状态" : `自动总结已经是每 ${want} 小时` }); return Response.json({ ok: true }); }
          cfg.auto = want; cfg.last = Date.now(); await kvPut(env, `gcfg:${chatId}`, cfg);
          await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: want === 0 ? "✅ 已关闭自动总结" : `✅ 已开启：每 ${want} 小时自动总结一次` });
          await gedit(await pgGroupMenu(env, chatId));
          return Response.json({ ok: true });
        }
        if (data === "gspam") {
          if (!(await isGroupAdmin(env, chatId, fromId))) { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "只有群主/群管理员或机器人管理员能改反垃圾设置", show_alert: true }); return Response.json({ ok: true }); }
          const cfg = await kvGet(env, `gcfg:${chatId}`, { auto: 0, spam: 0 });
          cfg.spam = cfg.spam ? 0 : 1; await kvPut(env, `gcfg:${chatId}`, cfg);
          await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: cfg.spam ? "✅ AI 反垃圾已开启" : "已关闭 AI 反垃圾" });
          await gedit(await pgGroupMenu(env, chatId));
          return Response.json({ ok: true });
        }
        if (data === "gmodel" || data.startsWith("gmodel:") || data.startsWith("gcmodel:")) {
          if (data === "gmodel") { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id }); await gedit(await pgGroupModels(env, chatId)); return Response.json({ ok: true }); }
          if (!(await isGroupAdmin(env, chatId, fromId))) { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "只有群主/群管理员或机器人管理员能改本群模型", show_alert: true }); return Response.json({ ok: true }); }
          const cache = await kvGet(env, `gmodellist:${chatId}`, { models: [], customs: [] });
          const cfg = await kvGet(env, `gcfg:${chatId}`, { auto: 0 });
          if (data === "gmodel:clear") delete cfg.model;
          else if (data.startsWith("gcmodel:")) cfg.model = cache.customs[Number(data.slice(8))];
          else cfg.model = cache.models[Number(data.slice(7))];
          if (data !== "gmodel:clear" && !cfg.model) { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "列表过期了，重新打开本群模型页", show_alert: true }); return Response.json({ ok: true }); }
          await kvPut(env, `gcfg:${chatId}`, cfg);
          await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: cfg.model ? `✅ 本群模型已设为：${cfg.model}` : "✅ 本群模型已改为跟随全局" });
          await gedit(await pgGroupMenu(env, chatId));
          return Response.json({ ok: true });
        }
        if (data === "gprompt" || data === "gclear") {
          if (!(await isGroupAdmin(env, chatId, fromId))) { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "只有群主/群管理员或机器人管理员能改本群设置", show_alert: true }); return Response.json({ ok: true }); }
          if (data === "gclear") {
            const cfg = await kvGet(env, `gcfg:${chatId}`, { auto: 0 }); delete cfg.model; delete cfg.prompt; delete cfg.key; await kvPut(env, `gcfg:${chatId}`, cfg);
            await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "✅ 已清除本群模型和提示词，跟随全局" });
            await gedit(await pgGroupMenu(env, chatId));
            return Response.json({ ok: true });
          }
          await kvPut(env, `gflow:${chatId}:${fromId}`, { type: "gprompt" }, 300);
          await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id });
          await gedit(pg("📝 请直接在群里发送本群专用的系统提示词（5 分钟内有效，只认你发的；发送「清除」两个字可恢复跟随全局）：", [[{ text: "⬅ 返回群菜单", callback_data: "gmenu" }]]));
          return Response.json({ ok: true });
        }
        if (data.startsWith("spok:") || data.startsWith("spup:")) {
          if (!(await isGroupAdmin(env, chatId, fromId)) && !(await isAdmin(env, fromId))) { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "只有群主/群管理员或机器人管理员能核验", show_alert: true }); return Response.json({ ok: true }); }
          const [, tuid, eid] = data.split(":");
          const all = await loadScores(env, chatId);
          const tu = all[tuid];
          const ev = tu?.events?.find(e => e.id === eid);
          if (!ev || ev.status !== "pending") { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "这条已经核验过了" }); return Response.json({ ok: true }); }
          const reviewer = (cq.from.first_name || "") + (cq.from.last_name ? " " + cq.from.last_name : "");
          if (data.startsWith("spok:")) { ev.status = "cleared"; tu.s = Math.max(0, (tu.s || 0) - 1); }
          else ev.status = "upheld";
          await saveScores(env, chatId, all);
          const rec2 = { u: tuid, n: tu.n, category: ev.category, reason: ev.reason, x: ev.x };
          const verdict = ev.status === "cleared" ? `\n🧑‍⚖️ 管理员 ${escHtml(reviewer)} 核验：误判，已清除这 1 分（当前 ${tu.s} 分）` : `\n🧑‍⚖️ 管理员 ${escHtml(reviewer)} 核验：维持原判（当前 ${tu.s} 分）`;
          await tg(env.BOT_TOKEN, "editMessageText", { chat_id: chatId, message_id: mid, text: spamNoticeHtml(rec2) + verdict, parse_mode: "HTML" }).catch(() => {});
          if (hasDb(env)) { try { await env.DB.prepare("UPDATE botmsgs SET pin = 0 WHERE chat_id = ? AND message_id = ?").bind(String(chatId), mid).run(); } catch {} }
          await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: ev.status === "cleared" ? "✅ 已判定误判并清除记分" : "✅ 已维持原判" });
          return Response.json({ ok: true });
        }
        if (data.startsWith("sc:") || data.startsWith("gsu:")) {
          if (!(await isGroupAdmin(env, chatId, fromId)) && !(await isAdmin(env, fromId))) { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "只有群主/群管理员或机器人管理员能管理记分", show_alert: true }); return Response.json({ ok: true }); }
          if (data.startsWith("gsu:")) {
            const tuid = data.slice(4);
            const all0 = await loadScores(env, chatId);
            if (all0[tuid]?.n) await kvPut(env, `scctx:${chatId}:${tuid}`, { n: all0[tuid].n }, 3600);
            await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id });
            await gedit(await pgScoreUser(env, chatId, tuid));
            return Response.json({ ok: true });
          }
          const [, act, tuid] = data.split(":");
          if ((await isAdmin(env, tuid)) || (await isGroupAdmin(env, chatId, tuid))) { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "对方是管理员，不能记分", show_alert: true }); return Response.json({ ok: true }); }
          const ctx = await kvGet(env, `scctx:${chatId}:${tuid}`, null);
          const tname = ctx?.n || "";
          const mkEv = (delta, note) => ({ id: Date.now().toString(36), t: Date.now(), kind: "manual", delta, note });
          if (act === "add") {
            const tu = await addScore(env, chatId, tuid, tname, 1, mkEv(1, "管理员手动加分"));
            if (tu.s >= 3) {
              const ok = await kickUser(env, chatId, tuid);
              const all2 = await loadScores(env, chatId);
              if (all2[tuid]) { all2[tuid].s = 0; all2[tuid].events = [...(all2[tuid].events || []), mkEv(0, ok ? "满 3 分，已移出群聊" : "满 3 分，移出失败（机器人权限不足）")].slice(-20); await saveScores(env, chatId, all2); }
              await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: ok ? "已满 3 分，已移出群聊并清零" : "已满 3 分，但移出失败：请确认机器人有封禁权限", show_alert: true });
            } else await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: `已加 1 分，当前 ${tu.s} 分` });
          }
          else if (act === "sub") {
            const before = (await loadScores(env, chatId))[tuid]?.s || 0;
            if (!before) { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "已经是 0 分了" }); }
            else { const tu = await addScore(env, chatId, tuid, tname, -1, mkEv(-1, "管理员手动减分")); await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: `已减 1 分，当前 ${tu.s} 分` }); }
          }
          else if (act === "clear") {
            const before = (await loadScores(env, chatId))[tuid]?.s || 0;
            await addScore(env, chatId, tuid, tname, -before, mkEv(-before, "管理员清零"));
            await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "已清零" });
          }
          else if (act === "kick") {
            const ok = await kickUser(env, chatId, tuid);
            if (ok) { await addScore(env, chatId, tuid, tname, 0, mkEv(0, "管理员手动移出群聊")); const all3 = await loadScores(env, chatId); if (all3[tuid]) { all3[tuid].s = 0; await saveScores(env, chatId, all3); } }
            await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: ok ? "已移出群聊并清零" : "移出失败：请确认机器人有封禁权限", show_alert: !ok });
          }
          await gedit(await pgScoreUser(env, chatId, tuid, tname));
          return Response.json({ ok: true });
        }
        if (data === "gautodel" || data.startsWith("gautodel:") || data === "gautodelnow") {
          if (data === "gautodel") { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id }); await gedit(await pgAutoDelGroup(env, chatId)); return Response.json({ ok: true }); }
          if (!(await isGroupAdmin(env, chatId, fromId)) && !(await isAdmin(env, fromId))) { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "只有群主/群管理员或机器人管理员能改这个设置", show_alert: true }); return Response.json({ ok: true }); }
          if (data.startsWith("gautodel:")) {
            const h = Number(data.slice(9));
            const cfg = await kvGet(env, `gcfg:${chatId}`, { auto: 0 }); cfg.autodel = h; await kvPut(env, `gcfg:${chatId}`, cfg);
            await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: h ? `✅ 本群已开启：自动删除 ${h} 小时前的机器人消息` : "✅ 本群已关闭自动删除" });
            await gedit(await pgAutoDelGroup(env, chatId));
            return Response.json({ ok: true });
          }
          const h = await autodelHours(env, chatId);
          if (!h) { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "先选一个时间档位，再立即清理", show_alert: true }); return Response.json({ ok: true }); }
          await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "正在清理…" });
          const n = await cleanBotMsgsNow(env, chatId, h);
          await sendTemp(env, chatId, `🧹 已清理本群 ${n} 条超过 ${h} 小时的机器人消息。（这类操作提示 2 分钟后会自动删除）`);
          await gedit(await pgAutoDelGroup(env, chatId));
          return Response.json({ ok: true });
        }
        if (data === "gspamlog" && !(await isGroupAdmin(env, chatId, fromId))) { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "垃圾记录仅群主/群管理员或机器人管理员可看", show_alert: true }); return Response.json({ ok: true }); }
        if (data === "gmembers" && !(await isGroupAdmin(env, chatId, fromId)) && !(await isAdmin(env, fromId))) { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "成员数据仅群主/群管理员或机器人管理员可看", show_alert: true }); return Response.json({ ok: true }); }
        await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id });
        if (data === "gmenu") await gedit(await pgGroupMenu(env, chatId));
        else if (data === "gspamlog") await gedit(await pgSpamLog(env, chatId));
        else if (data === "gscore") await gedit(await pgScoreList(env, chatId));
        else if (data === "gmembers") await gedit(await pgMembers(env, chatId));
        else if (data === "gsummary") await gedit(pgSumPicker());
        else if (data === "gstats") await gedit(pg(await groupStatsText(env, chatId), [[{ text: "⬅ 返回群菜单", callback_data: "gmenu" }]]));
        else if (data === "gsearch") { await kvPut(env, `gflow:${chatId}:${fromId}`, { type: "search" }, 120); await gedit(pg("🔍 请直接在群里发送你要检索的关键词（2 分钟内有效，只认你发的）：", [[{ text: "⬅ 返回群菜单", callback_data: "gmenu" }]])); }
        else if (data.startsWith("sum:")) {
          const hours = Number(data.slice(4));
          await gedit(pg(`⏳ 正在总结最近 ${hours} 小时的群消息…`, []));
          try {
            const s = await buildSummary(env, chatId, hours);
            if (!s) await gedit(pg(`最近 ${hours} 小时记录到的消息太少（少于 3 条），没法总结。\n注意：机器人只能总结它能看到的消息——需要关掉 BotFather 隐私模式，或把机器人设为群管理员，它才会记录群消息。`, [[{ text: "⬅ 返回群菜单", callback_data: "gmenu" }]]));
            else await gedit({ text: summaryHtml(s.title, s.body), rows: [[{ text: "⬅ 返回群菜单", callback_data: "gmenu" }]], html: true });
          } catch (e) { await gedit(pg(`总结失败：${isOwner(env, fromId) ? e.message : "调用失败，请稍后再试"}`, [[{ text: "⬅ 返回群菜单", callback_data: "gmenu" }]])); }
        }
        return Response.json({ ok: true });
      }
      // Admin-only, private-only, and edited in place on the same message.
      if (!(await isAdmin(env, fromId))) { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "仅管理员可用" }); return Response.json({ ok: true }); }
      if (cq.message.chat.type !== "private") { await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id, text: "管理功能涉及隐私，请私聊我操作" }); const dm = await sendPage(env, fromId, pgPanel(isOwner(env, fromId))).catch(() => null); return Response.json({ ok: true }); }
      await tg(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cq.id });
      const edit = (page) => editPage(env, chatId, mid, page);
      const own = isOwner(env, fromId);
      const OWNER_EXACT = new Set(["menu_keys", "menu_auth", "keys", "keyrestore", "addkey", "setapi", "modes", "delkey", "listauth", "tmodels", "setprompt", "bcast", "bcastgo", "backup", "backupexport", "backupimport", "cfusage", "cfset", "cfdel", "health", "healthrun", "cleanup", "cleanuprun", "sysstatus", "selftest", "asr", "asrscan", "asrclear", "probe", "usecheck", "addmodel", "delmodels", "fbchain", "fbadd", "fbclear", "fbtimeout"]);
      const OWNER_PREFIX = ["auth:", "keydetail:", "keyedit:", "keyuse:", "keymode:", "delconfirm:", "tmodel:", "tkey:", "tmsel2:", "tmclear:", "healthauto:", "cleanupcfg:", "asrpick:", "delmodel:", "fbkey:", "fbmodel:", "fbdel:", "fbtime:"];
      if (!own && (OWNER_EXACT.has(data) || OWNER_PREFIX.some(x => data.startsWith(x)))) { await edit(pgPanel(false)); return Response.json({ ok: true }); }
      if (data === "panel") await edit(pgPanel(own));
      else if (SUBMENUS[data]) await edit(pgSubmenu(data, own));
      else if (data === "adminhelp") await edit(resultPage(ADMIN_HELP));
      else if (data === "flowcancel") { await env.AUTH_KV.delete(`flow:${chatId}:${fromId}`); await edit(pgPanel(own)); }
      else if (data === "listauth") await edit(await pgListAuth(env));
      else if (data === "tmodels") await edit(await pgTargetModels(env));
      else if (data.startsWith("tmodel:")) { const [, kind, tid] = data.split(":"); await edit(await pgTargetKeyPick(env, chatId, kind, tid)); }
      else if (data.startsWith("tkey:")) {
        const [, kind, tid, idxS] = data.split(":");
        const pool = await getPool(env); const entry = pool[Number(idxS)];
        if (!entry) await edit(resultPage("这个 Key 已经不存在了。"));
        else {
          let models = []; try { models = await fetchModels(env, entry); } catch {}
          const base = normBase(entry.base_url);
          const customs = (await getAllCustoms(env)).filter(c => c.base === base).map(c => c.name);
          await kvPut(env, `targetpick:${chatId}`, { kind, tid, entryName: entry.name, base, models, customs }, 600);
          await edit(await pgTargetModelPick(env, chatId));
        }
      }
      else if (data.startsWith("tmsel2:")) {
        const cache = await kvGet(env, `targetpick:${chatId}`, null);
        const pick = data.slice(7);
        const model = cache ? (pick.startsWith("c") ? cache.customs[Number(pick.slice(1))] : cache.models[Number(pick)]) : null;
        if (!cache || !model) await edit(resultPage("列表过期了，重新打开独立模型授权再选。"));
        else {
          if (cache.kind === "u") { const c = await kvGet(env, `ucfg:${cache.tid}`, {}); c.model = model; c.key = cache.entryName; await kvPut(env, `ucfg:${cache.tid}`, c); }
          else { const c = await kvGet(env, `gcfg:${cache.tid}`, { auto: 0 }); c.model = model; c.key = cache.entryName; await kvPut(env, `gcfg:${cache.tid}`, c); }
          await edit(await pgTargetKeyPick(env, chatId, cache.kind, cache.tid));
        }
      }
      else if (data.startsWith("tmclear:")) {
        const [, kind, tid] = data.split(":");
        if (kind === "u") { const c = await kvGet(env, `ucfg:${tid}`, {}); delete c.model; delete c.key; await kvPut(env, `ucfg:${tid}`, c); }
        else { const c = await kvGet(env, `gcfg:${tid}`, { auto: 0 }); delete c.model; delete c.key; await kvPut(env, `gcfg:${tid}`, c); }
        await edit(await pgTargetKeyPick(env, chatId, kind, tid));
      }
      else if (data === "stats") await edit(await pgStats(env));
      else if (data === "sysstatus") await edit(await pgSysStatus(env));
      else if (data === "cfusage") await edit(await pgCfUsage(env));
      else if (data === "health") await edit(await pgHealth(env));
      else if (data === "healthrun") { await edit(pg("⏳ 正在逐个巡检 Key，请稍等…", [])); await runHealthCheck(env, false); await edit(await pgHealth(env)); }
      else if (data.startsWith("healthauto:")) { const cfg = await kvGet(env, "config:health", { auto: 0, last: 0, results: {} }); cfg.auto = Number(data.slice(11)); await kvPut(env, "config:health", cfg); await edit(await pgHealth(env)); }
      else if (data.startsWith("cleanupcfg:")) { const hh = parseInt(data.slice(11), 10); await kvPut(env, "config:cleanup_cfg", { hours: isNaN(hh) ? 24 : hh }); await edit(await pgCleanup(env)); }
      else if (data === "storage") await edit(await pgStorage(env));
      else if (data === "cleanup") await edit(await pgCleanup(env));
      else if (data === "cleanuprun") { await edit(pg("🧹 正在清理…", [])); await cleanupStorage(env); await edit(await pgCleanup(env)); }
      else if (data === "backup") await edit(await pgBackup(env));
      else if (data === "backupexport") { const r = await sendBackupFile(env, chatId); if (!r.ok) await edit(resultPage("导出失败：" + (r.description || "未知错误"))); else await edit(await pgBackup(env)); }
      else if (data === "backupimport") await startFlowEdit(env, chatId, fromId, mid, { type: "restore", step: "input" }, "📥 导入恢复：把之前导出的备份 JSON 文件直接发给我（以文件形式发送），或者把 JSON 内容粘贴发给我。\n⚠️ 恢复会覆盖当前同名配置（Key 池、授权名单、设置都会按备份还原），发错文件会把现在的配置冲掉，请确认文件无误：");
      else if (data === "cfdel") { await env.AUTH_KV.delete("config:cf"); await edit(await pgCfUsage(env)); }
      else if (data === "cfset") await startFlowEdit(env, chatId, fromId, mid, { type: "cfset", step: "account" }, "☁️ 设置 CF 用量查询：先发你的 Cloudflare 账户 ID（控制台首页右侧能看到，32 位十六进制）：");
      else if (data === "selftest") await edit(await pgSelfTest(env));
      else if (data === "asr") await edit(await pgAsr(env, chatId));
      else if (data === "asrscan") { await edit(pg("🔍 正在逐个接口扫描转写模型，稍等…", [])); await edit(await pgAsrScan(env, chatId)); }
      else if (data === "asrclear") { await env.AUTH_KV.delete("config:asr"); await edit(await pgAsr(env, chatId)); }
      else if (data.startsWith("asrpick:")) { const found = await kvGet(env, `asrscan:${chatId}`, []); const f = found[Number(data.slice(8))]; if (f) { await kvPut(env, "config:asr", { entry: f.entry, model: f.model }); await edit(pg(`✅ 转写模型已设为：Key「${f.entry}」的 ${f.model}\n现在给机器人发条语音试试。`, [[{ text: "⬅ 返回语音设置", callback_data: "asr" }], ROW_PANEL])); } else await edit(resultPage("扫描结果过期了，重新扫描一次。")); }
      else if (data === "models") await edit(await pgModels(env, chatId, own));
      else if (data === "probe") {
        const pool = await orderedPool(env); const entry = pool[0];
        if (!entry) await edit(resultPage("还没有配置任何 Key。"));
        else {
          await edit(pg("🧪 正在逐个实测模型（先测文本、再测看图），模型多的话要等一会儿…", []));
          let models = []; try { models = await fetchModels(env, entry); } catch {}
          const customs = (await getAllCustoms(env)).filter(c => c.base === normBase(entry.base_url)).map(c => c.name);
          const all = [...new Set([...models, ...customs])];
          if (all.length) await runProbe(env, entry, all).catch(() => {});
          await edit(await pgModels(env, chatId, own));
        }
      }
      else if (data === "fbchain") await edit(await pgFallback(env));
      else if (data === "fbadd") await edit(await pgFallbackKeyPick(env));
      else if (data.startsWith("fbkey:")) {
        const pool = await getPool(env); const entry = pool[Number(data.slice(6))];
        if (!entry) await edit(resultPage("这个 Key 已经不存在了。"));
        else {
          let models = []; try { models = await fetchModels(env, entry); } catch {}
          const customs = (await getAllCustoms(env)).filter(c => c.base === normBase(entry.base_url)).map(c => c.name);
          await kvPut(env, `fbpick:${chatId}`, { entryName: entry.name, models, customs }, 600);
          await edit(await pgFallbackModelPick(env, chatId));
        }
      }
      else if (data.startsWith("fbmodel:")) {
        const cache = await kvGet(env, `fbpick:${chatId}`, null);
        const pick = data.slice(8);
        const model = cache ? (pick.startsWith("c") ? cache.customs[Number(pick.slice(1))] : cache.models[Number(pick)]) : null;
        if (!cache || !model) await edit(resultPage("列表过期了，重新打开备用模型链再选。"));
        else {
          const cfg = await getFallbackCfg(env);
          if (cfg.chain.length >= 5) await edit(resultPage("备用链最多 5 个，先删掉一个再加。"));
          else if (cfg.chain.some(c => c.key === cache.entryName && c.model === model)) await edit(resultPage("这个备用模型已经在链里了。"));
          else { cfg.chain.push({ key: cache.entryName, model }); await kvPut(env, "config:fallback", cfg); await edit(await pgFallback(env)); }
        }
      }
      else if (data.startsWith("fbdel:")) { const cfg = await getFallbackCfg(env); cfg.chain.splice(Number(data.slice(6)), 1); await kvPut(env, "config:fallback", cfg); await edit(await pgFallback(env)); }
      else if (data === "fbclear") { const cfg = await getFallbackCfg(env); cfg.chain = []; await kvPut(env, "config:fallback", cfg); await edit(await pgFallback(env)); }
      else if (data === "fbtimeout") await edit(await pgFallbackTimeout(env));
      else if (data.startsWith("fbtime:")) { const cfg = await getFallbackCfg(env); const n = Number(data.slice(7)); if ([15, 25, 40, 60].includes(n)) cfg.timeout = n; await kvPut(env, "config:fallback", cfg); await edit(await pgFallback(env)); }
      else if (data === "usecheck") {
        const pool = await orderedPool(env); const entry = pool[0];
        if (!entry) await edit(resultPage("还没有配置任何 Key。"));
        else {
          await edit(pg("🔍 正在逐个检测模型可用性（每个模型都会真发一条消息验证），模型多的话要等一会儿…", []));
          let models = []; try { models = await fetchModels(env, entry); } catch {}
          const customs = (await getAllCustoms(env)).filter(c => c.base === normBase(entry.base_url)).map(c => c.name);
          const all = [...new Set([...models, ...customs])];
          if (all.length) await runUseCheck(env, entry, all).catch(() => {});
          await edit(await pgUseResults(env, chatId));
        }
      }
      else if (data === "addmodel") { const pool = await orderedPool(env); const entry = pool[0]; await startFlowEdit(env, chatId, fromId, mid, { type: "addmodel", step: "input", base: entry ? normBase(entry.base_url) : "" }, `✏️ 给当前接口（${entry ? entry.base_url : "未知"}）添加自定义模型：请发送模型名（必须和接口要求的一字不差，比如智谱的 glm-4-flash）。加好的模型只会在这个 Key 下显示：`); }
      else if (data === "delmodels") await edit(await pgDelModels(env, chatId));
      else if (data.startsWith("delmodel:")) { const cache = await kvGet(env, `customlist:${chatId}`, null); const name = cache?.names?.[Number(data.slice(9))]; if (name) { const all = await getAllCustoms(env); await kvPut(env, "config:custom_models", all.filter(c => !(c.name === name && c.base === cache.base))); } await edit(await pgDelModels(env, chatId)); }
      else if (data.startsWith("cmodel:")) { const cache = await kvGet(env, `customlist:${chatId}`, null); const m = cache?.names?.[Number(data.slice(7))]; if (m) { await kvPut(env, "config:model", m); await edit(pg(`✅ 模型已切换为：${m}（自定义）`, [[{ text: "🎛 再选模型", callback_data: "models" }], ROW_PANEL])); } else await edit(resultPage("这个自定义模型已经不在了，返回重新选。")); }
      else if (data === "keys") await edit(await pgKeys(env));
      else if (data === "modes") await edit(await pgModes(env));
      else if (data === "delkeys") await edit(await pgDelKeys(env));
      else if (data === "setapi") await startFlowEdit(env, chatId, fromId, mid, { type: "setapi", step: "base" }, "🔄 更新接口：先发新的接口地址（比如 https://api.openai.com/v1）：");
      else if (data === "addkey") await startFlowEdit(env, chatId, fromId, mid, { type: "addkey", step: "name" }, "➕ 添加 Key：先发一个名称（比如：主力、备用1）：");
      else if (data === "setprompt") await startFlowEdit(env, chatId, fromId, mid, { type: "setprompt", step: "input" }, "📝 请发送新的系统提示词：");
      else if (data === "bcast") await startFlowEdit(env, chatId, fromId, mid, { type: "broadcast", step: "input" }, "📣 请发送要群发给所有已授权用户/群的通知内容：");
      else if (data.startsWith("auth:")) { const a = AUTH_ACTIONS[data.slice(5)]; if (a) await startFlowEdit(env, chatId, fromId, mid, { type: "auth", action: data.slice(5) }, `${a.label}：${a.ask}`); }
      else if (data === "bcastgo") {
        const pending = await env.AUTH_KV.get(`bcast:${chatId}:${fromId}`);
        if (!pending) await edit(resultPage("没有待群发的内容，已过期。"));
        else { await env.AUTH_KV.delete(`bcast:${chatId}:${fromId}`); const targets = [...(await kvGet(env, "allowed_users", [])), ...(await kvGet(env, "allowed_groups", []))]; for (const t of targets) await send(env, t, pending).catch(() => {}); await edit(resultPage(`📣 已发送给 ${targets.length} 个目标`)); }
      }
      else if (data.startsWith("keymode:")) { const m = data.slice(8); if (["fallback", "rotate", "single"].includes(m)) { await kvPut(env, "config:key_mode", m); await edit(await pgKeys(env)); } }
      else if (data.startsWith("keydetail:")) await edit(await pgKeyDetail(env, Number(data.slice(10))));
      else if (data.startsWith("keyuse:")) {
        const pool = await getPool(env); const e = pool[Number(data.slice(7))];
        if (e) { await kvPut(env, "config:active_key", e.name); await edit(await pgKeyDetail(env, Number(data.slice(7)))); }
      }
      else if (data === "keyrestore") { await env.AUTH_KV.delete("config:envkey"); await edit(await pgKeys(env)); }
      else if (data.startsWith("keyapi:")) {
        const idS = data.slice(7);
        if (idS === "env") {
          const pool = await getPool(env); const e = pool.find(x => x.isEnv);
          if (e) { const order = ["", "chat", "responses"]; const next = order[(order.indexOf(e.api || "") + 1) % 3]; const ov = { name: e.name, base_url: e.base_url, key: e.key }; if (next) ov.api = next; if (e.ua) ov.ua = e.ua; await kvPut(env, "config:envkey", ov); await edit(await pgKeyDetail(env, pool.indexOf(e))); }
          else await edit(resultPage("默认 Key 已经不存在了。"));
        } else {
          const idx = Number(idS); const stored = await getStoredKeys(env); const e = stored[idx];
          if (e) { const order = ["", "chat", "responses"]; const next = order[(order.indexOf(e.api || "") + 1) % 3]; if (next) e.api = next; else delete e.api; stored[idx] = e; await kvPut(env, "keys", stored); await edit(await pgKeyDetail(env, idx)); }
          else await edit(resultPage("这个 Key 已经不存在了。"));
        }
      }
      else if (data.startsWith("keyedit:")) {
        const [, field, idxS] = data.split(":");
        if (idxS === "env") {
          const pool = await getPool(env); const e = pool.find(x => x.isEnv);
          if (e && EDIT_FIELDS[field]) await startFlowEdit(env, chatId, fromId, mid, { type: "editkey", field, target: "env", step: EDIT_FIELDS[field].step }, EDIT_FIELDS[field].ask(e));
          else await edit(resultPage("默认 Key 已经不存在了。"));
        } else {
          const idx = Number(idxS); const stored = await getStoredKeys(env); const e = stored[idx];
          if (e && EDIT_FIELDS[field]) await startFlowEdit(env, chatId, fromId, mid, { type: "editkey", field, idx, step: EDIT_FIELDS[field].step }, EDIT_FIELDS[field].ask(e));
          else await edit(resultPage("这个 Key 已经不存在了。"));
        }
      }
      else if (data === "delconfirm:env") {
        const pool = await getPool(env); const e = pool.find(x => x.isEnv);
        await kvPut(env, "config:envkey", { disabled: true });
        if (e && (await kvGet(env, "config:active_key", null)) === e.name) await env.AUTH_KV.delete("config:active_key");
        await edit(await pgKeys(env));
      }
      else if (data.startsWith("delconfirm:")) {
        const stored = await getStoredKeys(env); const idx = Number(data.slice(11)); const gone = stored[idx];
        if (gone) { stored.splice(idx, 1); await kvPut(env, "keys", stored); await edit(await pgKeys(env)); } else await edit(resultPage("这个 Key 已经不在了。"));
      }
      else if (data === "delkey:env") {
        const pool = await getPool(env); const e = pool.find(x => x.isEnv); const pi = pool.indexOf(e);
        if (e) await edit(pg(`确认停用默认 Key「${e.name}」（${e.base_url} / ${maskKey(e.key)}）？停用后可在 Key 池恢复。`, [[{ text: "确认停用", callback_data: "delconfirm:env" }, { text: "取消", callback_data: `keydetail:${pi}` }], ROW_PANEL]));
        else await edit(resultPage("默认 Key 已经不在了。"));
      }
      else if (data.startsWith("delkey:")) {
        const stored = await getStoredKeys(env); const idx = Number(data.slice(7)); const e = stored[idx];
        if (e) await edit(pg(`确认删除 Key「${e.name}」（${e.base_url} / ${maskKey(e.key)}）？`, [[{ text: "确认删除", callback_data: `delconfirm:${idx}` }, { text: "取消", callback_data: `keydetail:${idx}` }], ROW_PANEL]));
        else await edit(resultPage("这个 Key 已经不在了。"));
      }
      else if (data.startsWith("model:")) {
        const models = await kvGet(env, `modellist:${chatId}`, []); const m = models[Number(data.slice(6))];
        if (m) { await kvPut(env, "config:model", m); await edit(pg(`✅ 模型已切换为：${m}`, [[{ text: "🎛 再选模型", callback_data: "models" }], ROW_PANEL])); }
        else await edit(resultPage("列表过期了，返回面板重新选模型。"));
      }
      return Response.json({ ok: true });
    }

    // ---------- messages ----------
    const msg = update.message;
    if (!msg) return Response.json({ ok: true });
    if (msg.chat.type !== "private" && (msg.new_chat_members?.length || msg.left_chat_member)) await trackMembership(env, msg).catch(() => {});
    if (msg.photo && msg.photo.length) { await handlePhoto(env, msg); return Response.json({ ok: true }); }
    if (msg.document && msg.chat.type === "private") {
      const adm = await isAdmin(env, msg.from.id);
      const flow = adm ? await kvGet(env, `flow:${msg.chat.id}:${msg.from.id}`, null) : null;
      if (flow && flow.type === "restore") { await handleRestoreFile(env, msg, flow); return Response.json({ ok: true }); }
    }
    if (msg.voice || msg.audio) { await handleVoice(env, msg); return Response.json({ ok: true }); }
    if (!msg.text) return Response.json({ ok: true });
    const chatId = msg.chat.id, userId = msg.from.id, text = msg.text.trim();
    const cmd = text.split(/\s+/)[0].split("@")[0];
    await sweepTempMsgs(env, chatId);
    const isAdm = await isAdmin(env, userId);

    if (looksSecret(text)) {
      let inKeyStep = false;
      if (msg.chat.type === "private" && isAdm) { const f = await kvGet(env, `flow:${chatId}:${userId}`, null); inKeyStep = !!(f && (f.step === "key" || f.type === "restore")); }
      const oneLineAdd = cmd === "/addkey" && text.trim().split(/\s+/).length >= 4;
      if (!inKeyStep && !oneLineAdd) {
        const deleted = await tryDelete(env, chatId, msg.message_id);
        await send(env, chatId, deleted
          ? "⚠️ 检测到这条消息里有疑似密钥/Token，我已经帮你删掉了，也不会保存或转发它。\n添加/更新 Key 请在私聊用管理面板，不要直接发在聊天里。"
          : "⚠️ 检测到这条消息里有疑似密钥/Token，我不会保存或转发它，但我没能替你删掉（权限限制），请你马上长按这条消息手动删除。\n添加/更新 Key 请在私聊用管理面板。");
        return Response.json({ ok: true });
      }
    }

    if (msg.chat.type === "private" && isAdm) {
      const flow = await kvGet(env, `flow:${chatId}:${userId}`, null);
      if (flow && (text.startsWith("/cancel") || !text.startsWith("/"))) { await handleFlow(env, msg, flow); return Response.json({ ok: true }); }
    }

    if (cmd === "/id") { await send(env, chatId, `你的 ID: ${userId}\n本会话 ID (${msg.chat.type}): ${chatId}`); await tryDelete(env, chatId, msg.message_id); return Response.json({ ok: true }); }
    if (cmd === "/start") {
      const welcome = `👋 你好，我是你的 AI 助手。\n直接发消息就能聊天，群里请 @我 或回复我。\n你的对话只有你自己能看。`;
      if (msg.chat.type === "private") await tg(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: welcome, reply_markup: { inline_keyboard: userKeyboard(isAdm) } });
      else await send(env, chatId, welcome);
      await tryDelete(env, chatId, msg.message_id); return Response.json({ ok: true });
    }
    if (cmd === "/help") { await send(env, chatId, USER_HELP + (isAdm && msg.chat.type === "private" ? "\n\n管理员：发 /panel 打开管理面板，功能都在里面，面板会在同一条消息里切换，不刷屏。" : "")); await tryDelete(env, chatId, msg.message_id); return Response.json({ ok: true }); }

    const adminCmds = ["/panel","/admin","/model","/keys","/keymode","/addkey","/setapi","/delkey","/usekey","/allow","/allowgroup","/deny","/denygroup","/listauth","/addadmin","/deladmin","/setprompt","/stats","/broadcast"];
    if (adminCmds.includes(cmd)) {
      if (!isAdm) { await sendTemp(env, chatId, "仅管理员可用。"); await tryDelete(env, chatId, msg.message_id); return Response.json({ ok: true }); }
      if (msg.chat.type !== "private") {
        await send(env, chatId, "管理功能涉及密钥和授权名单等隐私信息，不能在群里操作。我已把管理面板私发给你，请在私聊里操作。");
        const dm = await sendPage(env, userId, pgPanel(isOwner(env, userId))).catch(() => null);
        if (!dm || dm.ok === false) await send(env, chatId, "私发失败：请先私聊我发一次 /start，再在私聊里用管理面板。");
        await tryDelete(env, chatId, msg.message_id); return Response.json({ ok: true });
      }
      const OWNER_CMDS = ["/keys", "/addkey", "/setapi", "/delkey", "/usekey", "/keymode", "/allow", "/allowgroup", "/deny", "/denygroup", "/listauth", "/addadmin", "/deladmin", "/setprompt", "/broadcast"];
      if (OWNER_CMDS.includes(cmd) && !isOwner(env, userId)) { await sendTemp(env, chatId, "仅超级管理员可用。"); await tryDelete(env, chatId, msg.message_id); return Response.json({ ok: true }); }
      await handleAdminCmd(env, msg, text); await tryDelete(env, chatId, msg.message_id); return Response.json({ ok: true });
    }

    if (!(await isAllowed(env, msg.chat, userId))) { await send(env, chatId, `未授权。请把你的 ID 发给管理员授权：${userId}` + (msg.chat.type !== "private" ? `\n群 ID：${chatId}` : "")); return Response.json({ ok: true }); }
    if (cmd === "/clear") { await dbHistClear(env, chatId, userId); await sendTemp(env, chatId, "🧹 你自己的对话记忆已清空。"); await tryDelete(env, chatId, msg.message_id); return Response.json({ ok: true }); }
    if (msg.chat.type === "private") {
      const df = await kvGet(env, `drawflow:${chatId}:${userId}`, null);
      if (df && !text.startsWith("/")) { await env.AUTH_KV.delete(`drawflow:${chatId}:${userId}`); await drawImage(env, msg, text); return Response.json({ ok: true }); }
    }
    if (cmd === "/draw") {
      const dp = text.replace(/^\/draw(@\S+)?\s*/i, "").trim();
      if (!dp) { await sendTemp(env, chatId, "用法：/draw 一只在太空里喝奶茶的猫（把想画的内容写在命令后面）"); await tryDelete(env, chatId, msg.message_id); return Response.json({ ok: true }); }
      await drawImage(env, msg, dp);
      await tryDelete(env, chatId, msg.message_id); return Response.json({ ok: true });
    }

    let prompt = text;
    if (msg.chat.type !== "private") {
      // Keyword-search flow: the requester's next group message is the keyword.
      const gf = await kvGet(env, `gflow:${chatId}:${userId}`, null);
      if (gf && gf.type === "gprompt" && !text.startsWith("/")) {
        await env.AUTH_KV.delete(`gflow:${chatId}:${userId}`);
        const cfg = await kvGet(env, `gcfg:${chatId}`, { auto: 0 });
        if (text.trim() === "清除") { delete cfg.prompt; await kvPut(env, `gcfg:${chatId}`, cfg); await sendTemp(env, chatId, "✅ 本群提示词已清除，恢复跟随全局。"); }
        else { cfg.prompt = text.slice(0, 2000); await kvPut(env, `gcfg:${chatId}`, cfg); await sendTemp(env, chatId, "✅ 本群专用提示词已设置，本群的对话都会按它来。"); }
        await tryDelete(env, chatId, msg.message_id);
        return Response.json({ ok: true });
      }
      if (gf && gf.type === "search" && !text.startsWith("/")) {
        await env.AUTH_KV.delete(`gflow:${chatId}:${userId}`);
        await send(env, chatId, fmtHits(text, searchGroupLog(await kvGet(env, `glog:${chatId}`, []), text)));
        return Response.json({ ok: true });
      }
      await logGroupMessage(env, msg);
      if (cmd === "/summary") { await sendPage(env, chatId, pgSumPicker()); await tryDelete(env, chatId, msg.message_id); return Response.json({ ok: true }); }
      if (cmd === "/group") { await sendPage(env, chatId, await pgGroupMenu(env, chatId)); await tryDelete(env, chatId, msg.message_id); return Response.json({ ok: true }); }
      if (cmd === "/score" || cmd === "/info") {
        const rt = msg.reply_to_message;
        if (!rt?.from || rt.from.is_bot || rt.sender_chat) { await sendTemp(env, chatId, "用法：先回复某个成员的一条消息，再发送 /score，就会打开他的记分菜单（加分 / 减分 / 清零 / 移出）。"); await tryDelete(env, chatId, msg.message_id); return Response.json({ ok: true }); }
        const target = rt.from;
        if (!(await isAdmin(env, userId)) && !(await isGroupAdmin(env, chatId, userId))) { await sendTemp(env, chatId, "记分管理只有群主/群管理员或机器人管理员能用。"); await tryDelete(env, chatId, msg.message_id); return Response.json({ ok: true }); }
        if (String(target.id) === String(userId)) { await sendTemp(env, chatId, "不能给自己记分。"); await tryDelete(env, chatId, msg.message_id); return Response.json({ ok: true }); }
        if ((await isAdmin(env, target.id)) || (await isGroupAdmin(env, chatId, target.id))) { await sendTemp(env, chatId, "对方是管理员，不能记分。"); await tryDelete(env, chatId, msg.message_id); return Response.json({ ok: true }); }
        const tname = (target.first_name || "") + (target.last_name ? " " + target.last_name : "");
        await kvPut(env, `scctx:${chatId}:${target.id}`, { n: tname }, 3600);
        await sendPage(env, chatId, await pgScoreUser(env, chatId, String(target.id), tname));
        await tryDelete(env, chatId, msg.message_id); return Response.json({ ok: true }); }
      if (cmd === "/search") {
        const kw = text.replace(/^\/search(@\S+)?\s*/i, "").trim();
        if (!kw) { await sendTemp(env, chatId, "用法：/search 关键词（比如 /search 报价），或在 /group 菜单里点「关键词检索」后直接发关键词。"); await tryDelete(env, chatId, msg.message_id); return Response.json({ ok: true }); }
        await send(env, chatId, fmtHits(kw, searchGroupLog(await kvGet(env, `glog:${chatId}`, []), kw)));
        await tryDelete(env, chatId, msg.message_id); return Response.json({ ok: true });
      }
      const mentioned = msg.entities?.some(e => e.type === "mention");
      const isReply = msg.reply_to_message?.from?.is_bot;
      // AI anti-spam (opt-in): judge ordinary group messages; admins and bot-directed messages are exempt.
      if (!mentioned && !isReply && !text.startsWith("/") && !msg.sender_chat) {
        const gcfg = await kvGet(env, `gcfg:${chatId}`, { auto: 0, spam: 0 });
        if (gcfg.spam && text.trim().length >= 3 && !(await isAdmin(env, userId))) {
          const adminIds = await getGroupAdminIds(env, chatId);
          if (!adminIds.includes(String(userId))) {
            const verdict = await judgeSpam(env, msg).catch(() => null);
            if (verdict?.spam) {
              await tryDelete(env, chatId, msg.message_id);
              const rec = { t: Date.now(), u: userId, n: (msg.from.first_name || "") + (msg.from.last_name ? " " + msg.from.last_name : ""), x: text.slice(0, 200), category: verdict.category, reason: verdict.reason || "" };
              await spamLogAdd(env, chatId, rec);
              const ev = { id: Date.now().toString(36), t: Date.now(), kind: "ai", delta: 1, category: rec.category, reason: rec.reason, x: rec.x, status: "pending" };
              const su = await addScore(env, chatId, String(userId), rec.n, 1, ev);
              let kicked = false;
              if (su.s >= 3) {
                kicked = await kickUser(env, chatId, userId);
                const all2 = await loadScores(env, chatId);
                if (all2[String(userId)]) { all2[String(userId)].s = 0; await saveScores(env, chatId, all2); }
              }
              const notice = spamNoticeHtml(rec) + `\n⚖️ 当前记分：${kicked ? 0 : su.s} / 3 分` + (kicked ? "\n👢 已累计满 3 分，已移出群聊（记分清零）。" : "\n请群主/管理员核验：如属误判，可清除这 1 分。");
              const payload = { chat_id: chatId, text: notice, parse_mode: "HTML" };
              if (!kicked) payload.reply_markup = { inline_keyboard: [[{ text: "✅ 误判 · 清除这 1 分", callback_data: `spok:${userId}:${ev.id}` }, { text: "✔️ 维持原判", callback_data: `spup:${userId}:${ev.id}` }]] };
              const sentN = await tg(env.BOT_TOKEN, "sendMessage", payload);
              if (sentN.ok) await trackBotMsg(env, chatId, sentN.result.message_id, kicked ? 0 : 1);
              else await send(env, chatId, notice.replace(/<[^>]+>/g, ""));
              return Response.json({ ok: true });
            }
          }
        }
      }
      if (cmd === "/ask") prompt = text.slice(4).trim();
      else if (!mentioned && !isReply) return Response.json({ ok: true });
      prompt = prompt.replace(/@\S+/g, "").trim();
      if (!prompt) return Response.json({ ok: true });
      if (prompt.includes("总结")) { await sendPage(env, chatId, pgSumPicker()); return Response.json({ ok: true }); }
      const quoted = msg.reply_to_message && !msg.reply_to_message.from?.is_bot && msg.reply_to_message.text;
      if (quoted) prompt = `（我回复的这条消息是 ${msg.reply_to_message.from?.first_name || "某人"} 说的：「${msg.reply_to_message.text.slice(0, 400)}」）\n我的问题：${prompt}`;
    }
    if (prompt.startsWith("帮我画")) {
      const dp = prompt.replace(/^帮我画(一下)?[：:]?\s*/, "").trim();
      if (dp) { await drawImage(env, msg, dp); return Response.json({ ok: true }); }
    }
    if (prompt.startsWith("/")) return Response.json({ ok: true });
    await chatReply(env, msg, prompt);
    if (cmd === "/ask") await tryDelete(env, chatId, msg.message_id);
    return Response.json({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/webhook") {
      if (env.WEBHOOK_SECRET && request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const raw = await request.text();
      const inner = new Request(request.url, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": env.WEBHOOK_SECRET || "" }, body: raw });
      return handleFetch(inner, env);
    }
    return handleFetch(request, env);
  },
  async scheduled(event, env, ctx) {
    await migrateToD1(env).catch(() => {});
    try {
      if (hasDb(env)) await env.DB.prepare("DELETE FROM rate WHERE minute < ?").bind(Math.floor(Date.now() / 60000) - 5).run();
      const ccfg = await kvGet(env, "config:cleanup_cfg", { hours: 24 });
      const lastC = await kvGet(env, "config:cleanup", null);
      if ((ccfg?.hours || 0) > 0 && (!lastC || Date.now() - (lastC.at || 0) >= ccfg.hours * 3600 * 1000)) await cleanupStorage(env);
    } catch {}
    await sweepBotMsgs(env).catch(() => {});
    try {
      const u = await cfToday(env);
      if (u) {
        const today = new Date().toISOString().slice(0, 10);
        const pct = Math.max(u.req / 100000, u.kvW / 1000);
        if (pct >= 0.95) await kvPut(env, "config:eco", today);
        if (u.kvW >= 900) await kvPut(env, "config:kvguard", today);
        if (pct >= 0.8 && (await kvGet(env, `alert:${today}`, "")) !== "sent") {
          await kvPut(env, `alert:${today}`, "sent", 60 * 60 * 30);
          const adminIds = [...new Set([...String(env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean), ...(await kvGet(env, "admins", [])).map(String)])];
          const text = `⚠️ CF 免费额度预警（UTC ${today}）\nWorkers 请求：${u.req.toLocaleString("en-US")} / 100,000\nKV 写入：${u.kvW.toLocaleString("en-US")} / 1,000` + (pct >= 0.95 ? "\n已自动开启今日省流模式：暂停群消息记录和自动总结，保住聊天与管理，明日额度重置后自动恢复。" : "\n已接近上限；到 95% 会自动开启省流模式（暂停群日志和自动总结）。");
          for (const a of adminIds) await send(env, a, text).catch(() => {});
        }
      }
    } catch {}
    const hcfg = await kvGet(env, "config:health", { auto: 0, last: 0 });
    if (hcfg.auto && Date.now() - (hcfg.last || 0) >= hcfg.auto * 3600 * 1000 - 60 * 1000) await runHealthCheck(env, true).catch(() => {});
    const eco = await ecoOn(env);
    const groups = await kvGet(env, "allowed_groups", []);
    for (const gid of groups) {
      const cfg = await kvGet(env, `gcfg:${gid}`, { auto: 0, last: 0 });
      if (eco || !cfg.auto) continue;
      if (Date.now() - (cfg.last || 0) < cfg.auto * 3600 * 1000 - 60 * 1000) continue;
      try {
        const s = await buildSummary(env, gid, cfg.auto);
        cfg.last = Date.now(); await kvPut(env, `gcfg:${gid}`, cfg);
        if (s) await send(env, gid, summaryHtml(`⏰ 自动总结 · ${s.title}`, s.body), { parse_mode: "HTML" });
      } catch { /* keep going */ }
    }
  },
};

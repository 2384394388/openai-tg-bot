-- 建表 SQL：D1 数据库建表语句，与《部署教程.md》第二节完全一致。
-- 网页部署：在 Cloudflare 控制台 D1 的 Console 里整段粘贴执行。
-- 命令行部署：wrangler d1 execute openai-tg-bot-db --remote --file=建表.sql
-- 重复执行也不会报错（都有 IF NOT EXISTS）。

CREATE TABLE IF NOT EXISTS hist (chat_id TEXT, user_id TEXT, data TEXT, memo TEXT, last TEXT, updated_at INTEGER, PRIMARY KEY (chat_id, user_id));
CREATE TABLE IF NOT EXISTS glog (chat_id TEXT, ts INTEGER, user_id TEXT, name TEXT, text TEXT);
CREATE TABLE IF NOT EXISTS stats (id INTEGER PRIMARY KEY, data TEXT);
CREATE TABLE IF NOT EXISTS rate (user_id TEXT, minute INTEGER, n INTEGER, PRIMARY KEY (user_id, minute));
CREATE TABLE IF NOT EXISTS spamlog (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, ts INTEGER, user_id TEXT, name TEXT, category TEXT, reason TEXT, text TEXT);
CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS members (chat_id TEXT, user_id TEXT, name TEXT, lang TEXT, first_seen INTEGER, last_seen INTEGER, msg_count INTEGER, joined_at INTEGER, left_at INTEGER, PRIMARY KEY (chat_id, user_id));
CREATE TABLE IF NOT EXISTS botmsgs (chat_id TEXT, message_id INTEGER, ts INTEGER, pin INTEGER DEFAULT 0, temp INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
CREATE INDEX IF NOT EXISTS idx_glog_chat_ts ON glog (chat_id, ts);
CREATE INDEX IF NOT EXISTS idx_spamlog_chat ON spamlog (chat_id, ts);
CREATE INDEX IF NOT EXISTS idx_hist_upd ON hist (updated_at);
CREATE INDEX IF NOT EXISTS idx_botmsgs_ts ON botmsgs (ts);

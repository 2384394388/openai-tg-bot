# openai-tg-bot

一个部署在 **Cloudflare Workers 免费额度** 上的 Telegram AI 机器人。全部功能都在单个 `worker.js` 里：多接口 Key 池、流式输出、图片/语音理解、画图、群聊总结、AI 反垃圾与记分管理、两级管理员权限面板。

不需要服务器，不需要数据库运维，跟着教程点鼠标 20 分钟部署完成；部署后所有管理都在 Telegram 面板里点按钮，不用再碰代码。

**📖 部署看这里：[超级小白部署教程](部署教程.md)**

---

## 功能一览

**聊天**
- 多轮对话记忆（长对话自动压缩成备忘，不丢上下文）
- 流式输出（逐字编辑消息）；流式卡住 25 秒自动切换普通模式，不会无限「思考中」
- 图片识别（发图提问）、语音消息自动转写后回答
- `/draw` 画图（自动在 Key 池里寻找画图模型）
- 长回复自动用 Telegram 可折叠引用展示，超长才分段

**多接口 / Key 池**
- 无限添加 OpenAI 兼容接口（地址 + Key），支持 Chat Completions 与 Responses 两种接口类型（可手动指定或自动识别）
- 失败自动切换 / 轮换 / 只用当前 三种模式
- 每个 Key 可单独：改名、改地址、更新 Key 值、设自定义 User-Agent（应对只认特定客户端 UA 的接口）
- 模型列表点选切换；拉不到列表的接口可手动添加自定义模型（按接口隔离）
- 模型可用性检测（逐个真调用）、看图能力实测、Key 健康巡检（手动 + 定时）

**权限与隐私**
- 授权制：只有名单内的用户/群能使用
- 两级管理员：超级管理员（环境变量 `ADMIN_IDS`）掌管 Key 与授权；二级管理员只能切模型、看统计，**看不到任何 Key 和地址**，无权的功能在面板里直接不显示
- 疑似 Key/Token 的消息会被立即删除，不保存、不发给模型
- 面板操作类消息、命令消息自动清理，聊天保持干净

**群管理**
- AI 总结（1/6/12/24/48 小时）+ 定时自动总结，长文可折叠引用
- 关键词检索、活跃统计
- AI 反垃圾：自动删垃圾消息并公告（发送者 + 类别）；记分制——AI 判定 +1 分，管理员按钮复核，满 3 分自动移出群；`/score` 可手动记分
- 成员数据：进群时间、注册时间估算、发言统计
- 每群独立模型 / 独立提示词；机器人消息按群设置自动过期删除

**运维**
- 面板内查看 Cloudflare 当日用量（Workers 请求 / KV 读写 / 等）与存储总览
- 用量护栏：80% 私聊预警，95% 自动省流
- 配置一键备份/恢复（JSON 文件，含 Key 明文，请妥善保管）
- 存储清理可手动/按周期执行，避免无谓消耗额度

---

## 快速开始

1. 准备：BotFather 的机器人 Token、一个 OpenAI 兼容 API（地址 + Key）、你自己的 Telegram 数字 ID
2. 在 Cloudflare 建 KV + D1（教程里有整段现成 SQL）
3. 建 Worker，把 `worker.js` 全文粘贴进去部署
4. 绑定 `AUTH_KV`（KV）和 `DB`（D1），填好变量与机密，设整点 Cron `0 * * * *`
5. 依次打开 `https://你的worker地址/setwebhook` 和 `/setcommands`，回 Telegram 发 `/panel`

每一步的截图级说明都在 **[部署教程](部署教程.md)** 里。

---

## 配置参考

### 环境变量与机密（Worker Settings → Variables and Secrets）

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `BOT_TOKEN` | Secret | ✅ | BotFather 给的机器人 Token |
| `OPENAI_API_KEY` | Secret | ✅ | 默认 Key 的 API Key |
| `WEBHOOK_SECRET` | Secret | ✅ | Webhook 校验口令，自己编一串长随机字符 |
| `ADMIN_IDS` | Text | ✅ | 超级管理员的 Telegram 数字 ID，多个用英文逗号隔开 |
| `OPENAI_BASE_URL` | Text | ✅ | 默认 Key 的接口地址，如 `https://api.openai.com/v1` |
| `OPENAI_MODEL` | Text | ✅ | 默认模型名，如 `gpt-4o-mini` |
| `SYSTEM_PROMPT` | Text | ⬜ | 系统提示词，不填用内置默认；面板里可再改 |

### 绑定（变量名必须一字不差）

| 绑定名 | 类型 | 用途 |
|---|---|---|
| `AUTH_KV` | KV Namespace | 配置类数据：Key 池、授权名单、各项设置（写入少，契合 KV 免费额度） |
| `DB` | D1 Database | 高频数据：对话历史、群日志、统计、限流、记分、成员、消息追踪 |

### 定时任务

Cron 填 `0 * * * *`（每小时整点）：驱动自动总结、健康巡检、消息过期清理、存储清理和额度护栏。

---

## 技术说明（给想改代码的人）

- **单文件架构**：所有逻辑在 `worker.js`（约 190 KB），无构建步骤，粘贴即部署。入口 `fetch` 处理 Webhook（校验 `x-telegram-bot-api-secret-token` 头）、`/` 健康检查、`/setwebhook`、`/setcommands`；`scheduled` 处理整点任务。
- **处理模型**：Webhook 采用同步处理（在请求内完成回复）。Cloudflare 的 `waitUntil` 在响应后最多续命约 30 秒，慢接口会把回答掐死在半路，所以**不要**改成「先 ACK 再后台处理」。
- **超时纪律**（血泪教训）：代码里所有外部调用都有超时——接口请求（fetch 在收到响应头后会解除初始计时，所以读流单独设了 25 秒无新内容即中断、40 秒总上限）、Telegram API 调用 20 秒。改代码时请勿引入无超时的 `fetch` / 流读取，否则慢接口会让机器人无限「思考中」，Telegram 还会不断重投同一条消息。
- **存储分工**：KV 只存配置（免费版每天仅 1000 次写）；一切高频写都走 D1。新增数据时请遵循这个原则。
- **接口适配**：每个 Key 可指定 `api` 类型（`chat` / `responses`），未指定时按缓存的学习结果走，Chat 报错提到 responses 时自动改走 Responses 并记住。
- **数据表**：D1 共 8 张表（`hist` `glog` `stats` `rate` `spamlog` `cache` `members` `botmsgs`），建表 SQL 在教程第二节；其中 `spamlog/cache/members/botmsgs` 代码也会懒创建。

---

## 安全说明

- 本仓库代码不含任何密钥与个人信息；你的 Token/Key 只存在你自己的 Cloudflare 账户里（Secret / 你自己的 KV）。
- 「配置备份」导出的 JSON 含 Key 明文，按密码文件保管。
- 只把信得过的人和群加入授权名单：被授权者消耗的是你的 API 额度。

## 更新

新版 `worker.js` 覆盖粘贴到 Worker 编辑器重新 Deploy 即可，KV/D1 里的数据不受影响。更新前建议先在面板导出一份配置备份。

## License

MIT

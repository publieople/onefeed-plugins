# OneFeed 插件规范 v1（公开版）

宿主版本 ≥ 0.2.0 按本规范加载插件。规范全文（含宿主内部实现、验收标准、排期）在主仓库
`onefeed/specs/002-plugin-arch/spec.md`；这里是插件作者需要遵守的部分。

## 1. 插件是目录

```
my-plugin/
  plugin.json    清单（必需）
  index.js       入口（默认名，可在清单改）
  README.md      可选
```

插件只依赖 `module.exports` 上的方法，不需要 `require`、不需要打包、不需要 npm。
运行时是 QuickJS（ES2020 子集），**没有** `fetch`、`fs`、`process`、`setTimeout`；网络与命令走 `ctx`。

## 2. plugin.json

| 字段 | 必填 | 说明 |
|---|---|---|
| `schemaVersion` | ✅ | 固定 `1` |
| `id` | ✅ | 小写字母开头，`[a-z0-9-]`，2–32 位，全局唯一 |
| `name` | ✅ | 显示名 |
| `version` | ✅ | semver，如 `0.1.0` |
| `minHostVersion` | ✅ | 低于它的宿主拒绝装载 |
| `entry` | | 默认 `index.js`，只能是文件名 |
| `capabilities` | ✅ | `http` / `cli` / `browser` 的非空子集 |
| `cli.allow` | 声明 cli 时必填 | 字符串数组的数组，第一段是裸命令名，后续是参数前缀 |
| `kinds` | ✅ | 会产出的卡片形态 |
| `feeds` | ✅ | `[{id,name,requiresAuth?,personalized?}]` |
| `settings` | | `[{key,label,type,default,secret?,help?}]` |
| `description` / `author` / `license` / `homepage` / `themeColor` | | 展示用 |

`cli.allow` 示例：`[["bili","feed"],["bili","video"]]` 允许 `bili feed ...` 与 `bili video ...`；
`bili comment`（写操作）不在白名单里，插件调不动。参数仍由宿主做前缀匹配，逃逸到别的子命令会被拒绝。

## 3. 生命周期

```js
module.exports = {
  async pull(ctx, { feedId, limit, cursor }) { return { items: [], next: null }; },
  async comments(ctx, { item, limit }) { return { items: [] }; },  // 可选
  async auth(ctx) { return { state: "ok" }; }                      // 可选
};
```

- `pull`：拉一页，返回 `{items, next}`；`next` 为 null 表示没有下一页（本轮可不实现）
- `comments`：给一条 item 拉评论，返回 `{items: [{id, author, text, like_count, created_at, replies?}]}`
- `auth`：`{state:"ok"|"need_login"|"expired", hint?}`；只在 `requiresAuth` 的流上被调用

约定：

- 抛 `Error("人话")` 表示这条流当前不可用；宿主显示「该平台暂不可用」并保留上次缓存
- 单次调用 25s 内必须 resolve（超出被子进程强杀）
- 返回值必须可 `JSON.stringify`（不要返回函数、Map、循环引用）
- `ctx.env.demo === true` 时插件**必须零网络**，返回内置快照（演示兜底）

## 4. ctx API

```js
// HTTP（宿主代发，自动带 UA；失败会尝试本机常见代理）
const res = await ctx.http.request({
  url: "https://api.example.com/feed",
  method: "GET",                       // 默认 GET；有 body 时默认 POST
  query: { limit: 20 },                // 自动 urlencode
  headers: { "Referer": "https://example.com/" },
  body: { a: 1 },                      // 对象自动 JSON 序列化
  timeoutMs: 15000,                    // ≤ 30s
  credential: "self"                   // 注入用户存的 cookie（插件拿不到明文）
});
res.status; res.text; res.json(); res.headers;

// 本机 CLI（只允许 cli.allow 里的命令；干净环境、无代理变量、cwd=用户目录）
const r = await ctx.cli.run({ argv: ["bili", "feed", "recommend", "--count", "20"], timeoutMs: 60000 });
r.code; r.stdout; r.stderr;

// 浏览器粗粒度抓取（持久档案在 ~/.onefeed/browser/<plugin-id>，用完即销毁）
const cap = await ctx.browser.capture({
  url: "https://example.com/",
  patterns: ["/api/feed/"],            // 正则，命中 URL 的 JSON 响应会被收集（最多 20 条）
  scroll: { times: 3, dy: 2400, intervalMs: 900 },  // times ≤ 10
  settleMs: 3000,                      // 页面加载后等待
  timeoutMs: 60000                     // ≤ 90s
});
cap.responses;                         // [{url, json?|text?}]

// 私有存储 / 缓存 / 设置
ctx.storage.set("cursor", "abc"); const c = ctx.storage.get("cursor");
ctx.cache.set("feed", data, 300);
const token = ctx.settings.get("token");   // secret 项只返回布尔值

// 工具
ctx.util.clamp("1.2万")   // → 12000
ctx.log.info("拉取完成，20 条")
```

## 5. item（RawItem）

见 README「一条 item 长什么样」。宿主负责补 `platform`、`fetched_at`、`id` 前缀与字段截断，
并对缺失字段做降级显示——插件只要如实填，别编造。

## 6. kind（卡片形态）

| kind | 宿主怎么渲染 | 典型来源 |
|---|---|---|
| `video` | 16:9 封面 + 时长角标 + 标题 + 作者/播放/弹幕 | B 站、抖音、小红书视频笔记 |
| `images` | 1/2/3/4/9 宫格 + 标题 + 作者 | 小红书图文、B 站动态 |
| `article` | 左文右图（宽屏）/ 上图下文（窄屏）+ 摘要 | 掘金、公众号 |
| `short` | 纯文本 + 来源/时间 + 互动数（无大图） | V2EX、微博 |
| `list` | 编号 + 标题 + 热度（榜单类，无作者） | 知乎热榜、GitHub Trending |

## 7. 版本兼容

- 宿主加载时比对 `minHostVersion`；低于则拒绝并提示升级宿主
- `schemaVersion` 升级意味着破坏性变更；本版固定 1

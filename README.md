# OneFeed 插件仓库

OneFeed 是一个本地信息流阅读器：一屏刷完 B 站、抖音、小红书、掘金、V2EX、知乎。
**它自己不含任何平台代码**——每个平台都是一个装进来的插件，本仓库就是官方示例插件集。

> 只读、自用、公开内容。不含任何平台密钥，不下载视频，不写操作。见 [DISCLAIMER.md](DISCLAIMER.md)。

## 目录

```
plugins/
  bilibili/       cli 引擎   B 站推荐流 + 关注动态      video / short
  douyin/         browser   抖音推荐流                 video
  xiaohongshu/    browser    小红书发现页               images / video
  juejin/         http      掘金推荐                   article
  v2ex/           http      V2EX 热门                  short
  zhihu-hot/      http      知乎热榜                   list
templates/
  basic/          http 引擎模板（60 行，含 demo 分支）
  browser/        browser 引擎模板（抓页面里的 JSON 响应）
schema/plugin.schema.json
scripts/validate.py      清单校验 + 沙箱干跑
scripts/build_registry.py 生成 registry.json（含 sha256）
registry.json            宿主「插件市场」订阅这个地址
SPEC.md                  插件规范（公开版）
```

## 五分钟写一个插件

**1. 建目录** `plugins/my-platform/`，两个文件：

`plugin.json`

```json
{
  "schemaVersion": 1,
  "id": "my-platform",
  "name": "我的平台",
  "version": "0.1.0",
  "author": "你的名字",
  "description": "我的平台热榜（只读）",
  "license": "MIT",
  "minHostVersion": "0.2.0",
  "entry": "index.js",
  "capabilities": ["http"],
  "kinds": ["list"],
  "feeds": [{ "id": "hot", "name": "热榜" }]
}
```

`index.js`

```js
module.exports = {
  async pull(ctx, args) {
    const res = await ctx.http.request({
      url: "https://example.com/api/hot",
      query: { limit: args.limit || 20 }
    });
    if (res.status !== 200) throw new Error("接口返回 " + res.status);
    const list = res.json().data || [];
    return {
      items: list.map(function (row) {
        return {
          native_id: String(row.id),
          kind: "list",
          title: row.title,
          url: row.url,
          cover: row.cover || "",
          author: { name: "example" },
          published_at: Math.floor(Date.now() / 1000),
          stats: { view: ctx.util.clamp(row.heat) }
        };
      }),
      next: null
    };
  }
};
```

**2. 出错了就抛 Error**（宿主会把这条流标成「暂不可用」，不会白屏）。
**3. 本地验证**：

```bash
# 只校验清单（不联网）
python scripts/validate.py

# 用宿主运行时真正跑一遍（需要宿主仓库的 .venv）
ONEFEED_PLUGINS_DIR=$PWD/plugins python ../onefeed/pull_all.py my-platform --limit 5
```

## 插件能拿到什么

插件跑在 QuickJS 沙箱里（每插件一个子进程，内存 64MB、25s 强制返回）。
给插件的只有「动词」，没有文件句柄、socket、cookie 明文：

| API | 说明 |
|---|---|
| `ctx.http.request({url, method, query, headers, body, timeoutMs, credential})` | 宿主代发 HTTP。`credential:"self"` 会用用户在设置里存的 cookie 自动注入，插件读不到明文 |
| `ctx.cli.run({argv, timeoutMs})` | 跑 `plugin.json` 里 `cli.allow` 白名单内的命令（如 `bili`、`xhs`），干净环境、无代理变量 |
| `ctx.browser.capture({url, patterns, scroll, settleMs, timeoutMs})` | 用持久浏览器档案打开页面，把命中正则的 JSON 响应交回来；用完即销毁 |
| `ctx.storage.get/set/delete/keys` | 插件私有持久存储（宿主状态目录下的 `plugins/<id>/`） |
| `ctx.cache.get/set(key, value, ttlSec)` | 带 TTL 的缓存 |
| `ctx.settings.get(key)` | 读 manifest `settings` 里声明的配置；`secret:true` 的项只返回布尔值 |

需要登录的平台不要在插件里碰 cookie：客户端把凭证写到宿主的
`<状态目录>/cookies/<plugin-id>.json`，宿主按 `settings.cookieFile` → 该默认路径找到它，
在 `browser.capture` 前自动注入。插件拿到的永远是页面已经签好名的响应。
小红书插件就是这么做的（`plugins/xiaohongshu/`）。
| `ctx.util.clamp("1.2万")` | 中文计数归一化 → `12000` |
| `ctx.log.info/warn/error(msg)` | 写宿主的插件日志 |
| `ctx.env.demo` | DEMO 模式（断网演示），插件应返回内置快照 |

## 一条 item 长什么样

最少三个字段：`native_id`、`kind`、`title`（或 `text`）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `native_id` | string | 平台内唯一 id，宿主拼成 `<plugin>:<native_id>` |
| `kind` | string | `video` / `images` / `article` / `short` / `list` |
| `title` | string | 卡片标题；缺省时宿主取 `text` 首行 |
| `text` | string | 正文/摘要 |
| `url` | string | 原文链接 |
| `cover` / `images[]` | string | 封面 / 图集（最多 9 张） |
| `author` | `{name,id,avatar}` | 作者 |
| `published_at` | int | unix 秒；不知道就填 0，别填当前时间 |
| `duration` | int | 秒（视频） |
| `stats` | `{view,like,comment,share}` | 数字，或交给 `ctx.util.clamp` |
| `tags` | string[] | 最多 6 个 |
| `extra` | object | 插件自定义补充字段，宿主原样保留 |

缺字段的降级规则（宿主负责，插件不用凑）：

| 缺什么 | 怎么显示 |
|---|---|
| 封面 | 显示 kind 图标 + 平台主色块，不拉伸 |
| 作者 | 隐藏作者行 |
| 时间 | 不显示时间（**不显示"刚刚"**） |
| 互动数 | 整块隐藏（**不显示 0**） |
| 正文 | 卡片只显示标题 |

## 引擎怎么选

| 数据在哪 | 用 | 例子 |
|---|---|---|
| 公开 JSON 接口 | `http` | 掘金、V2EX、知乎热榜 |
| 本机已有 CLI | `cli` | `bili`（登录态由 CLI 自己管） |
| 只能在网页里跑出来 | `browser` | 抖音、小红书（接口要签名，改抓页面自己发的请求） |

## 发布一个新版本

```bash
# 1) 改代码后把 plugin.json 的 version 加一位
# 2) 自检
python scripts/validate.py
# 3) 重新生成 registry.json（含目录级 sha256，宿主安装时用它校验）
python scripts/build_registry.py
# 4) 提交推送
git add -A && git commit -m "feat(bilibili): ..." && git push
```

宿主订阅 `https://cdn.jsdelivr.net/gh/publieople/onefeed-plugins@main/registry.json` 就能看到全部插件；
没被订阅的插件不会被自动拉取，也不会自动更新。

## 边界（写插件前请读）

- **只读**：不点赞、不评论、不发帖、不关注；不提供任何写操作的 API。
- **不下载**：不抓视频文件、不做离线缓存，只取展示需要的元数据与封面链接。
- **不带密钥**：插件里不写死任何平台的 app secret / token；需要登录的走宿主 `credential:"self"` 或用户自己的 CLI 登录态。
- **不收集数据**：不往第三方服务器上报用户内容。
- 各平台内容版权归原平台与作者，抓取行为由使用者自行判断合规性。

## 许可

MIT（插件代码）；各平台内容版权归原平台与作者。

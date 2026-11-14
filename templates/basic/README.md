# HTTP 模板

公开 JSON 接口 + 无需登录 = 最省事的插件。

1. 复制本目录到 `plugins/my-platform/`
2. 改 `plugin.json` 的 `id` / `name` / `kinds` / `feeds`
3. 改 `index.js` 里的接口地址和字段映射
4. `python scripts/validate.py` 然后跑 `pull_all.py` 验证

注意：`ctx.http.request` 会拒绝内网地址；超时上限 30s；响应体上限 5MB。

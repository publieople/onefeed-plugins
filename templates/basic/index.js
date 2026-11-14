// HTTP 插件模板：公开 JSON 接口 → 统一 item。
// 复制整个目录，改 plugin.json 的 id/name/kinds 和下面的接口地址。
"use strict";

// DEMO 快照：ctx.env.demo 为 true 时必须走这里（断网演示用）
const DEMO_ITEMS = [
  { native_id: "demo-1", kind: "list", title: "示例条目一", url: "https://example.com/1",
    cover: "", published_at: 0, stats: { view: 12345 } }
];

module.exports = {
  async pull(ctx, args) {
    const limit = Math.min(args.limit || 20, 50);
    if (ctx.env.demo) return { items: DEMO_ITEMS, next: null };

    const res = await ctx.http.request({
      url: "https://example.com/api/hot",
      query: { limit: limit },
      timeoutMs: 15000
    });
    if (res.status !== 200) throw new Error("接口返回 HTTP " + res.status);

    const body = res.json();
    const rows = body.data || body.items || body || [];
    return {
      items: rows.map(function (row) {
        return {
          native_id: String(row.id),
          kind: "list",
          title: String(row.title || ""),
          text: String(row.summary || ""),
          url: String(row.url || ""),
          cover: String(row.cover || ""),
          published_at: Number(row.timestamp || 0) || 0,
          stats: { view: ctx.util.clamp(row.heat), like: ctx.util.clamp(row.like) },
          tags: (row.tags || []).slice(0, 6)
        };
      }),
      next: null
    };
  }
};

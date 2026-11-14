// Browser 插件模板：接口要签名时，别去逆向——让页面自己发，抓它的响应。
// 用法：填好 url 与 patterns，用 Chrome（headless 会更容易被拦）打开一次页面。
"use strict";

const FEED_PATTERN = "/api/feed/";   // 改成目标站点的真实接口路径

module.exports = {
  async pull(ctx, args) {
    const limit = args.limit || 20;
    if (ctx.env.demo) return { items: [], next: null };

    const cap = await ctx.browser.capture({
      url: "https://example.com/",
      patterns: [FEED_PATTERN],
      scroll: { times: 2, dy: 2400, intervalMs: 900 },
      settleMs: 2500,
      timeoutMs: 60000
    });

    const payload = pickJson(cap.responses, function (j) { return j && j.items; });
    if (!payload) {
      throw new Error("没抓到 " + FEED_PATTERN + " 的响应：确认已在本机浏览器里登录，或检查页面结构是否变了");
    }
    return { items: payload.items.slice(0, limit).map(normalize), next: null };
  }
};

function pickJson(responses, test) {
  const list = responses || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].json && test(list[i].json)) return list[i].json;
  }
  return null;
}

function normalize(row) {
  return {
    native_id: String(row.id),
    kind: "video",
    title: String(row.title || ""),
    url: String(row.url || ""),
    cover: String(row.cover || ""),
    author: { name: String(row.author || ""), id: String(row.author_id || "") },
    published_at: Number(row.created_at || 0) || 0,
    duration: Number(row.duration || 0) || 0,
    stats: { view: row.view || 0, like: row.like || 0, comment: row.comment || 0 }
  };
}

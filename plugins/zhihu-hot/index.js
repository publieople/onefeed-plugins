// 知乎热榜插件：hot-list-web 接口免登录（20 条，返回 target 结构）。
"use strict";

const ENDPOINT = "https://www.zhihu.com/api/v3/feed/topstory/hot-list-web";

function pick() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return "";
}

function hotItem(entry, index) {
  const target = entry.target || {};
  const titleArea = target.title_area || {};
  const excerptArea = target.excerpt_area || {};
  const imageArea = target.image_area || {};
  const metricsText = String((target.metrics_area || {}).text || "");
  const id = String(pick(target.id, entry.id, index));
  const link = (target.link || {}).url || "";
  const title = String(pick(titleArea.text, target.title, "知乎热榜"));
  return {
    native_id: "hot:" + id,
    kind: "list",
    title: title.slice(0, 200),
    text: String(pick(excerptArea.text, "")),
    url: link ? (link.indexOf("http") === 0 ? link : "https://www.zhihu.com" + link) : "",
    cover: String(pick(imageArea.url, "")),
    images: [],
    author: { name: "", id: "", avatar: "" },
    published_at: 0,
    duration: 0,
    stats: { view: metricCount(metricsText) },
    tags: [],
    extra: { metrics_text: metricsText, rank: index + 1 }
  };
}

// "442 万热度" → 4420000；"1234 热度" → 1234
function metricCount(text) {
  const m = String(text || "").match(/([\d.]+)\s*(万|亿)?/);
  if (!m) return 0;
  const value = Number(m[1]);
  if (!isFinite(value)) return 0;
  if (m[2] === "万") return Math.round(value * 10000);
  if (m[2] === "亿") return Math.round(value * 100000000);
  return Math.round(value);
}

module.exports = {
  async pull(ctx, args) {
    const limit = Math.min(Number(args.limit) || 20, 40);
    if (ctx.env.demo) return { items: [], next: null };

    const res = await ctx.http.request({
      url: ENDPOINT,
      query: { limit: limit, desktop: "true" },
      headers: { "Referer": "https://www.zhihu.com/hot" },
      timeoutMs: 15000
    });
    if (res.status !== 200) throw new Error("知乎接口返回 HTTP " + res.status);
    const body = res.json();
    const rows = body.data || [];
    return { items: rows.slice(0, limit).map(hotItem), next: null };
  }
};

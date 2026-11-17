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

function esc(text) {
  return String(text === undefined || text === null ? "" : text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function decodeEntities(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

// 问题描述在页面数据里是 HTML 片段，转成纯文本再分段；回答正文保留 HTML（前端 DOMPurify 兜底）
function paragraphs(html) {
  return decodeEntities(html).split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean)
    .map(function (line) { return "<p>" + esc(line) + "</p>"; }).join("");
}

function clip(html, max) {
  const value = String(html || "");
  return value.length <= max ? value : value.slice(0, max) + "…";
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
  },

  // 热榜条目只有标题和热度，详情要进问答页取：用宿主内置的 zhihu.question 提取器
  // （只能点名提取器，插件塞不进自己的 JS；页面数据由宿主在浏览器里读）。
  async detail(ctx, args) {
    const item = args.item || {};
    const url = String(item.url || "");
    const extra = item.extra || {};
    const stats = { view: metricCount(extra.metrics_text) };
    if (!url) throw new Error("这条热榜没有原问题链接，取不到正文");

    const res = await ctx.browser.extract({
      name: "zhihu.question",
      url: url,
      settleMs: 4000,
      timeoutMs: 75000
    });
    const value = (res && res.value) || {};
    if (!value.ok) {
      return {
        body: { kind: "text", value: String(item.text || "") },
        stats: stats,
        note: "问答页没取到正文（" + String(value.reason || "页面结构可能变了") + "）。点下面的「去知乎看原帖」看完整讨论。"
      };
    }

    const question = value.question || {};
    const answers = value.answers || [];
    const parts = [];
    if (question.detail) parts.push(paragraphs(question.detail));
    const top = Math.min(answers.length, 5);
    for (let i = 0; i < top; i++) {
      const answer = answers[i] || {};
      const votes = Number(answer.voteup || 0);
      const commentCount = Number(answer.comment || 0);
      parts.push(
        "<h3>「" + esc(answer.author || "匿名") + "」的回答 · " + votes + " 赞" +
        (commentCount > 0 ? " · " + commentCount + " 评论" : "") + "</h3>"
      );
      parts.push(clip(answer.content, 6000));
    }

    if (question.answerCount) stats.answer = Number(question.answerCount) || 0;
    if (question.commentCount) stats.comment = Number(question.commentCount) || 0;

    return {
      body: { kind: "html", value: parts.join("").slice(0, 150000) },
      stats: stats,
      note: top
        ? "正文与回答取自问答页自身数据（宿主内置 zhihu.question 提取器），回答只列赞数前 " + top + " 条。"
        : "这条问题暂时没有可读的回答，正文取自问题描述。"
    };
  }
};

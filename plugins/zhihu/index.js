// 知乎插件：推荐流要登录态 + x-zse-96 签名（签名在浏览器里现算，纯 HTTP 拿不到）。
// 做法与抖音一致：用持久浏览器打开首页，抓页面自己发出的 recommend 响应。
"use strict";

const RECOMMEND_PATTERN = "/api/v3/feed/topstory/recommend";
// 评论区：回答走 questions/{问题id}，专栏走 articles/{文章id}，都要页面自己带签名发。
const COMMENT_PATTERN = "/api/v4/comment_v5/(questions|articles)/\\d+/root_comment";

function count(value) {
  const v = Number(value);
  return isFinite(v) && v > 0 ? Math.round(v) : 0;
}

function clean(text) {
  let s = String(text || "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|h\d|li)>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

function webUrl(type, target) {
  const q = target.question || {};
  if (type === "answer") {
    return q.id ? "https://www.zhihu.com/question/" + q.id + "/answer/" + target.id : "";
  }
  if (type === "article") return "https://zhuanlan.zhihu.com/p/" + target.id;
  if (type === "zvideo" || type === "video") return "https://www.zhihu.com/zvideo/" + target.id;
  return "";
}

function feedItem(row) {
  const target = row.target || {};
  const type = String(target.type || "");
  const question = target.question || {};
  const author = target.author || {};
  const thumbs = Array.isArray(target.thumbnails) ? target.thumbnails : [];
  const cover = String(target.image_url || target.thumbnail || thumbs[0] || "");
  const title = type === "article"
    ? String(target.title || "")
    : String(question.title || target.title || "");
  const kind = (type === "zvideo" || type === "video") ? "video" : "article";
  return {
    native_id: type + ":" + String(target.id || ""),
    kind: kind,
    title: title.slice(0, 200) || "知乎内容",
    text: clean(target.excerpt_new || target.excerpt || ""),
    url: webUrl(type, target),
    cover: cover,
    images: [],
    author: {
      name: String(author.name || ""),
      id: String(author.url_token || ""),
      avatar: String(author.avatar_url || "")
    },
    published_at: count(target.created_time || target.created),
    duration: 0,
    stats: {
      like: count(target.voteup_count),
      comment: count(target.comment_count),
      collect: count(target.favorite_count),
      view: count(target.visited_count)
    },
    tags: [],
    extra: {
      zhihu_type: type,
      question_id: String(question.id || "")
    }
  };
}

function commentRow(row) {
  const author = row.author || {};
  const children = Array.isArray(row.child_comments) ? row.child_comments : [];
  return {
    id: String(row.id || ""),
    author: String(author.name || ""),
    author_id: String(author.id || ""),
    text: clean(row.content || ""),
    like_count: count(row.like_count),
    reply_count: count(row.child_comment_count),
    created_at: count(row.created_time),
    replies: children.slice(0, 3).map(function (reply) {
      const ra = reply.author || {};
      return {
        id: String(reply.id || ""),
        author: String(ra.name || ""),
        text: clean(reply.content || ""),
        like_count: count(reply.like_count),
        created_at: count(reply.created_time)
      };
    })
  };
}

module.exports = {
  async pull(ctx, args) {
    const limit = Math.min(Number(args.limit) || 20, 50);
    if (ctx.env.demo) return { items: [], next: null };

    const cap = await ctx.browser.capture({
      url: "https://www.zhihu.com/",
      patterns: [RECOMMEND_PATTERN],
      scroll: { times: 8, dy: 3000, intervalMs: 2200 },
      settleMs: 6000,
      timeoutMs: 85000,
      // 推荐流是分页拉取的，第一屏只有 6 条，要一直滚才会继续发请求
      stopWhenMatched: false
    });

    const seen = {};
    const items = [];
    const responses = cap.responses || [];
    for (let i = 0; i < responses.length; i++) {
      const payload = responses[i] && responses[i].json;
      if (!payload || !payload.data || !payload.data.length) continue;
      for (let k = 0; k < payload.data.length; k++) {
        const row = payload.data[k];
        if (!row || !row.target || !row.target.id) continue;
        const key = String(row.target.type) + ":" + String(row.target.id);
        if (seen[key]) continue;
        seen[key] = true;
        items.push(feedItem(row));
      }
    }
    if (!items.length) {
      throw new Error("没抓到知乎推荐流：先在设置页给知乎扫码登录（登录态只存在本机），或知乎页面结构变了");
    }
    return { items: items.slice(0, limit), next: null };
  },

  async detail(ctx, args) {
    const item = args.item || {};
    const extra = item.extra || {};
    const type = String(extra.zhihu_type || "");
    const url = String(item.url || "");
    const stats = {
      like: Math.round(Number(item.like_count) || 0),
      comment: Math.round(Number(item.comment_count) || 0),
      collect: Math.round(Number(item.collect_count) || 0),
      view: Math.round(Number(item.view_count) || 0)
    };

    // 全文在页面的 js-initialData 里：回答读 zhihu.question，专栏读 zhihu.article。
    // 提取器由宿主内置，插件只能按名字点名，拿不到页面句柄。
    if (url && (type === "answer" || type === "article")) {
      try {
        const name = type === "article" ? "zhihu.article" : "zhihu.question";
        const out = await ctx.browser.extract({ name: name, url: url, timeoutMs: 60000 });
        const value = (out && out.value) || {};
        if (value.ok) {
          let content = "";
          if (type === "article") {
            content = String(value.content || "");
            stats.like = Math.round(Number(value.voteup) || stats.like);
            stats.comment = Math.round(Number(value.comment) || stats.comment);
          } else {
            const first = (value.answers && value.answers[0]) || {};
            content = String(first.content || "");
            stats.like = Math.round(Number(first.voteup) || stats.like);
            stats.comment = Math.round(Number(first.comment) || stats.comment);
          }
          if (content) {
            return {
              body: { kind: "html", value: content },
              stats: stats,
              note: type === "article"
                ? "正文取自专栏页面（登录态由宿主注入），图片仍从知乎站点加载。"
                : "正文取自回答页面（登录态由宿主注入），评论在知乎原帖里看。"
            };
          }
        }
      } catch (err) {
        // 取不到全文就落回推荐流里的摘要，不把详情页整块弄坏
      }
    }

    return {
      body: { kind: "text", value: String(item.text || "") },
      stats: stats,
      note: "推荐流只带摘要，完整正文没取到；点「去知乎看原帖」看全文与评论。"
    };
  },

  async comments(ctx, args) {
    const item = args.item || {};
    const extra = item.extra || {};
    const type = String(extra.zhihu_type || "");
    const limit = Math.min(Number(args.limit) || 20, 50);
    const url = String(item.url || "");
    if (!url) throw new Error("这条知乎内容没有原帖地址，取不到评论");

    // 回答页的评论要点头部的「N 条评论」才展开（展开后继续滚还能翻页）；
    // 专栏页反过来：不点、只滚页面，底部评论列表跟着加载得更全，点开后反而只剩几条精选。
    const cap = await ctx.browser.capture({
      url: url,
      patterns: [COMMENT_PATTERN],
      scroll: { times: 6, dy: 2400, intervalMs: 900 },
      click: type === "answer" ? ['button:has-text("条评论")'] : [],
      // 弹层盖在页面上时滚轮得落在它中间才翻页；专栏页是普通页面，交给默认行为
      scrollPoint: type === "answer" ? { x: 720, y: 600 } : {},
      settleMs: 3500,
      timeoutMs: 75000,
      // 评论是一页一页翻的，抓到第一页别停
      stopWhenMatched: false
    });

    const seen = {};
    const rows = [];
    const responses = cap.responses || [];
    for (let i = 0; i < responses.length; i++) {
      const payload = responses[i] && responses[i].json;
      if (!payload || !Array.isArray(payload.data)) continue;
      for (let k = 0; k < payload.data.length; k++) {
        const row = payload.data[k];
        const key = String((row && row.id) || "");
        if (!key || seen[key]) continue;
        seen[key] = true;
        rows.push(row);
      }
    }
    if (!rows.length) {
      throw new Error("没抓到知乎评论：评论区没展开，或这条内容关闭了评论");
    }
    // 知乎评论是页面自己按滚轮一页页拉，宿主拿不到可复用的游标：只出第一页。
    return { items: rows.slice(0, limit).map(commentRow), next: null };
  }
};

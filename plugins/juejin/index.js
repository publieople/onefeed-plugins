// 掘金插件：公开推荐接口，免登录。
"use strict";

const ENDPOINT = "https://api.juejin.cn/recommend_api/v1/article/recommend_all_feed";

function count(value) {
  const v = Number(value);
  return isFinite(v) && v > 0 ? Math.round(v) : 0;
}

function articleItem(entry) {
  const info = entry.item_info || {};
  const article = info.article_info || {};
  const author = info.author_user_info || {};
  const id = String(article.article_id || "");
  const tags = [];
  const rawTags = entry.tags || info.tags || [];
  for (let i = 0; i < rawTags.length && tags.length < 6; i++) {
    const name = rawTags[i] && rawTags[i].tag_name;
    if (name) tags.push(String(name));
  }
  return {
    native_id: "article:" + id,
    kind: "article",
    title: String(article.title || "").slice(0, 200),
    text: String(article.brief_content || ""),
    url: "https://juejin.cn/post/" + id,
    cover: String(article.cover_image || ""),
    images: [],
    author: {
      name: String(author.user_name || ""),
      id: String(author.user_id || ""),
      avatar: String(author.avatar_large || author.avatar_uri || "")
    },
    published_at: count(article.ctime),
    duration: Math.round(count(article.read_time) / 60),
    stats: {
      view: count(article.view_count),
      like: count(article.digg_count),
      comment: count(article.comment_count),
      collect: count(article.collect_count)
    },
    tags: tags,
    extra: {}
  };
}

module.exports = {
  async pull(ctx, args) {
    const limit = Math.min(Number(args.limit) || 20, 50);
    if (ctx.env.demo) return { items: [], next: null };

    const res = await ctx.http.request({
      url: ENDPOINT,
      method: "POST",
      body: { id_type: 2, client_type: 2608, sort_type: 200, cursor: String(args.cursor || "0"), limit: limit },
      headers: { "Referer": "https://juejin.cn/" },
      timeoutMs: 15000
    });
    if (res.status !== 200) throw new Error("掘金接口返回 HTTP " + res.status);

    const body = res.json();
    if (body.err_no) throw new Error("掘金接口报错：" + (body.err_msg || body.err_no));
    const rows = body.data || [];
    return {
      items: rows.map(articleItem),
      next: body.cursor ? String(body.cursor) : null
    };
  }
};

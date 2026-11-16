// 掘金插件：公开推荐接口，免登录。
"use strict";

const ENDPOINT = "https://api.juejin.cn/recommend_api/v1/article/recommend_all_feed";
const PAGE_PREFIX = "https://juejin.cn/post/";

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
    url: PAGE_PREFIX + id,
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

function articleIdOf(item) {
  const native = String((item && item.native_id) || "");
  if (native.indexOf("article:") === 0) return native.slice("article:".length);
  const m = String((item && item.url) || "").match(/\/post\/(\d+)/);
  return m ? m[1] : "";
}

// 掘金文章是服务端渲染的，正文在 <article> 里；这里只截标签内部的 HTML。
// 标签开头还带着复制过来的 meta / h1 标题 / 作者块，页面上已经显示过了，这里切掉。
function extractArticle(html) {
  const text = String(html || "");
  const open = text.search(/<article[\s>]/i);
  if (open < 0) return "";
  const close = text.indexOf("</article>", open);
  if (close < 0) return "";
  const start = text.indexOf(">", open) + 1;
  let body = text.slice(start, close).replace(/<meta[^>]*>/gi, "").trim();

  const h1 = body.search(/<h1[\s>]/i);
  if (h1 > 0) body = body.slice(h1);
  const h1End = body.indexOf("</h1>");
  if (h1End >= 0) {
    const rest = body.slice(h1End + "</h1>".length);
    const firstBlock = rest.search(/<(p|blockquote|h2|pre|ul|ol|figure)[\s>]/i);
    body = firstBlock >= 0 ? rest.slice(firstBlock) : body;
  }
  return body.trim();
}

async function buildDetail(ctx, args) {
  const item = args.item || {};
  const id = articleIdOf(item);
  if (!id) throw new Error("这条掘金内容没有文章号");

  const res = await ctx.http.request({
    url: PAGE_PREFIX + id,
    headers: { "Referer": PAGE_PREFIX, "Accept-Language": "zh-CN,zh;q=0.9" },
    timeoutMs: 25000
  });
  if (res.status !== 200) throw new Error("掘金文章页返回 HTTP " + res.status);

  const html = extractArticle(res.text);
  if (!html) {
    return {
      body: { kind: "text", value: String(item.text || "") },
      media: null,
      images: [],
      stats: null,
      note: "掘金文章页没截到正文，先显示摘要；点下面的原帖看全文。"
    };
  }
  return {
    body: { kind: "html", value: html },
    media: null,
    images: [],
    stats: null,
    note: "正文取自掘金文章页，图片仍是掘金自己的地址。"
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
  },

  async detail(ctx, args) {
    return buildDetail(ctx, args);
  }
};

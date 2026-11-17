// B 站插件：所有数据经本机 bili CLI 取，插件不碰登录凭证。
// 数据来源：bili feed recommend / bili feed timeline / bili video info / bili comment list
"use strict";

const DETAIL_BUDGET = 6;   // 推荐流列表不带封面与回复数，前 N 条逐条补详情
const MAX_TITLE = 200;

function unixOf(value) {
  if (typeof value === "number" && isFinite(value) && value > 0) return Math.floor(value);
  const t = Date.parse(String(value || ""));
  return isFinite(t) ? Math.floor(t / 1000) : 0;
}

function count(value) {
  const v = Number(value);
  return isFinite(v) && v > 0 ? Math.round(v) : 0;
}

async function run(ctx, argv, timeoutMs) {
  const res = await ctx.cli.run({ argv: argv, timeoutMs: timeoutMs || 60000 });
  const text = String((res.stdout || "")).trim();
  if (!text) {
    throw new Error(argv.join(" ") + " 没有输出" + (res.stderr ? "：" + res.stderr.trim().slice(0, 200) : ""));
  }
  let payload;
  try { payload = JSON.parse(text); }
  catch (e) { throw new Error(argv.join(" ") + " 输出不是 JSON：" + text.slice(0, 200)); }
  if (payload.ok === false) {
    const err = payload.error || {};
    throw new Error("bili 报错：" + (err.message || "未知错误") + (err.hint ? "（" + err.hint + "）" : ""));
  }
  return payload.data === undefined ? payload : payload.data;
}

function withTarget(item, id, type) {
  item.extra = item.extra || {};
  item.extra.comment_target = { id: String(id), type: type };
  return item;
}

// ---------------------------------------------------------------- 推荐流
function recommendItem(row) {
  const bvid = String(row.bvid || "");
  const author = row.author || {};
  const stat = row.stat || {};
  const item = {
    native_id: "video:" + bvid,
    kind: "video",
    title: String(row.title || "").slice(0, MAX_TITLE),
    text: "",
    url: row.url || ("https://www.bilibili.com/video/" + bvid),
    cover: String(row.pic || ""),
    images: [],
    author: { name: String(author.name || ""), id: String(author.mid || ""), avatar: "" },
    published_at: unixOf(row.pubdate),
    duration: count(row.duration),
    stats: { view: count(stat.view), like: count(stat.like), comment: count(stat.reply) },
    tags: [],
    extra: { followed: !!row.followed_author, danmaku: count(stat.danmaku) }
  };
  return withTarget(item, bvid, "video");
}

async function pullRecommend(ctx, limit, cursor) {
  const page = Math.max(1, Math.min(Number(cursor) || 1, 50));
  const data = await run(ctx, [
    "bili", "feed", "recommend", "--count", String(Math.min(Math.max(limit, 1), 50)), "--page", String(page)
  ]);
  const items = (data.items || []).map(recommendItem);

  const needDetail = items.slice(0, Math.min(items.length, DETAIL_BUDGET));
  for (let i = 0; i < needDetail.length; i++) {
    const item = needDetail[i];
    if (item.cover) continue;
    const bvid = item.native_id.slice("video:".length);
    try {
      const info = await run(ctx, ["bili", "video", "info", bvid, "--raw"], 30000);
      item.cover = String(info.pic || "");
      item.text = String(info.desc || "");
      item.duration = count(info.duration) || item.duration;
      const owner = info.owner || {};
      item.author.avatar = String(owner.face || "");
      item.stats.comment = count((info.stat || {}).reply) || item.stats.comment;
      if (info.dimension && info.dimension.width) {
        item.extra.width = count(info.dimension.width);
        item.extra.height = count(info.dimension.height);
      }
    } catch (e) {
      ctx.log.warn("补 " + bvid + " 详情失败：" + String(e).slice(0, 160));
    }
  }
  return { items: items, next: String(page + 1) };
}

// ---------------------------------------------------------------- 关注动态
function dynamicItem(row) {
  const type = String(row.type || "text");
  const original = row.original || null;
  const source = original || row;            // 转发：正文取原文，转发语放 text 前
  const sourceType = String(source.type || type);
  const video = source.video || row.video || null;
  const images = (source.images || row.images || []).slice(0, 9);
  const text = String(source.text || row.text || "");
  const forwardText = original && row.text ? String(row.text) : "";
  const author = source.author || row.author || {};
  const stat = row.stat || {};

  let kind = "short";
  let title = "";
  let url = String(source.url || row.url || "");
  let cover = "";
  let duration = 0;

  if (video && video.bvid) {
    kind = "video";
    title = String(video.title || "");
    url = "https://www.bilibili.com/video/" + video.bvid;
    cover = String(video.pic || "");
    duration = count(video.duration);
  } else if (images.length) {
    kind = "images";
    cover = String(images[0] || "");
  }

  if (!title) {
    const firstLine = text.split("\n")[0] || "动态";
    title = firstLine.slice(0, MAX_TITLE);
  }
  if (kind !== "video") url = String(source.url || row.url || url);

  const item = {
    native_id: "dynamic:" + String(row.id),
    kind: kind,
    title: title,
    text: (forwardText ? "转发：" + forwardText + "\n" : "") + text,
    url: url,
    cover: cover,
    images: kind === "images" ? images : [],
    author: { name: String(author.name || ""), id: String(author.mid || ""), avatar: "" },
    published_at: unixOf(row.time),
    duration: duration,
    stats: { like: count(stat.like), comment: count(stat.comment), share: count(stat.forward) },
    tags: [],
    extra: {
      dynamic_type: type,
      original_id: original ? String(original.id) : ""
    }
  };
  const commentType = sourceType === "image" ? "draw" : (sourceType === "article" ? "article" : "dynamic");
  return withTarget(item, String(row.id), commentType);
}

async function pullTimeline(ctx, limit, cursor) {
  const argv = ["bili", "feed", "timeline"];
  if (cursor) argv.push("--offset", String(cursor));
  const data = await run(ctx, argv);
  const items = (data.items || []).map(dynamicItem).slice(0, Math.min(limit, 50));
  return { items: items, next: data.next_offset ? String(data.next_offset) : null };
}

// ---------------------------------------------------------------- 评论
function commentItem(row) {
  return {
    id: String(row.rpid),
    author: String((row.user || {}).name || ""),
    author_id: String((row.user || {}).mid || ""),
    text: String(row.content || ""),
    like_count: count(row.like),
    reply_count: count(row.reply_count),
    created_at: unixOf(row.time),
    replies: (row.replies_preview || []).map(function (reply) {
      return {
        id: String(reply.rpid),
        author: String((reply.user || {}).name || ""),
        text: String(reply.content || ""),
        like_count: count(reply.like),
        created_at: unixOf(reply.time)
      };
    })
  };
}

// ---------------------------------------------------------------- 详情
function bvidOf(item) {
  const id = String(item.native_id || "");
  if (id.indexOf("video:") === 0) return id.slice("video:".length);
  const url = String(item.url || "");
  const idx = url.indexOf("/video/");
  if (idx < 0) return "";
  const rest = url.slice(idx + "/video/".length);
  return rest.split("?")[0].split("/")[0];
}

async function buildDetail(ctx, args) {
  const item = args.item || {};
  const bvid = bvidOf(item);
  if (!bvid) {
    return {
      body: { kind: "text", value: String(item.text || "") },
      note: "动态没有独立详情页，正文就是全部内容。"
    };
  }
  const info = await run(ctx, ["bili", "video", "info", bvid, "--raw"], 40000);
  const stat = info.stat || {};
  const owner = info.owner || {};
  return {
    body: { kind: "text", value: String(info.desc || item.text || "") },
    media: {
      type: "embed",
      embedUrl: "https://player.bilibili.com/player.html?bvid=" + bvid + "&page=1&autoplay=0",
      poster: String(info.pic || item.cover || ""),
      duration: count(info.duration) || count(item.duration)
    },
    stats: {
      view: count(stat.view),
      like: count(stat.like),
      comment: count(stat.reply),
      share: count(stat.share),
      danmaku: count(stat.danmaku)
    },
    note: ""
  };
}

module.exports = {
  async pull(ctx, args) {
    const feedId = String(args.feedId || "recommend");
    const limit = Number(args.limit) || 20;
    if (feedId === "timeline") return pullTimeline(ctx, limit, args.cursor);
    if (feedId === "recommend") return pullRecommend(ctx, limit, args.cursor);
    throw new Error("未知的流：" + feedId + "（支持 recommend / timeline）");
  },

  async detail(ctx, args) {
    return buildDetail(ctx, args);
  },

  async comments(ctx, args) {
    const item = args.item || {};
    const target = (item.extra || {}).comment_target || null;
    if (!target) throw new Error("这条内容没有可用的评论区标识");
    const page = Math.max(1, Math.min(Number(args.cursor) || 1, 20));
    const argv = ["bili", "comment", "list", String(target.id),
      "--type", String(target.type), "--sort", "hot"];
    if (page > 1) argv.push("--page", String(page));
    let data;
    try {
      data = await run(ctx, argv);
    } catch (err) {
      // 第 2 页起要登录态，取不到就当翻到底，别把整个评论区打红
      if (page > 1) return { items: [], next: null };
      throw err;
    }
    const rows = (page === 1 ? (data.pinned || []) : []).concat(data.items || []);
    const limit = Number(args.limit) || 20;
    const plain = data.items || [];
    return {
      items: rows.map(commentItem).slice(0, limit),
      next: plain.length >= 10 ? String(page + 1) : null
    };
  },

  async auth(ctx) {
    try {
      const data = await run(ctx, ["bili", "feed", "recommend", "--count", "1"], 30000);
      const items = data.items || [];
      if (!items.length) return { state: "need_login", hint: "bili CLI 返回空推荐流，先在终端执行 bili login 扫码" };
      return { state: "ok", hint: "已登录 " + String((items[0].author || {}).name || "") };
    } catch (e) {
      return { state: "need_login", hint: String(e).slice(0, 200) };
    }
  }
};
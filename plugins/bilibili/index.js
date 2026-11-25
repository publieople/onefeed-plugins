// B 站插件：所有数据经本机 bili CLI 取，插件不碰登录凭证。
// 数据来源：bili feed recommend / bili feed timeline / bili video info / bili comment list
"use strict";

const DETAIL_BUDGET = 6;   // 推荐流列表不带封面与回复数，前 N 条逐条补详情
const MAX_TITLE = 200;
const API = "https://api.bilibili.com";
const FOLLOWING_PAGE_SIZE = 50;

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

function isLiveDynamic(row) {
  const type = String(row.type || "").toLowerCase();
  const original = row.original || {};
  const sourceType = String(original.type || "").toLowerCase();
  if (type.indexOf("live") >= 0 || sourceType.indexOf("live") >= 0) return true;
  if (row.live || original.live) return true;
  return false;
}

async function pullTimeline(ctx, limit, cursor) {
  const argv = ["bili", "feed", "timeline"];
  if (cursor) argv.push("--offset", String(cursor));
  const data = await run(ctx, argv);
  // 直播动态没有可读正文，点进去也是空的；这一版只把图文/视频交给信息流。
  const items = (data.items || [])
    .filter(function (row) { return !isLiveDynamic(row); })
    .map(dynamicItem)
    .slice(0, Math.min(limit, 50));
  return { items: items, next: data.next_offset ? String(data.next_offset) : null };
}

// ---------------------------------------------------------------- 接口取数
function cookieFile(ctx) {
  // 默认值在 plugin.json 里；空字符串表示用宿主状态目录里的标准 cookie 文件。
  return String(ctx.settings.get("cookieFile") || "");
}

async function apiJson(ctx, path, query, timeoutMs) {
  const opts = {
    url: API + path,
    query: query || {},
    credential: "self",
    cookieCase: "upper",   // B 站只认 SESSDATA/DedeUserID 这种大写键名
    headers: {
      Referer: "https://www.bilibili.com/",
      Origin: "https://www.bilibili.com"
    },
    timeoutMs: timeoutMs || 20000
  };
  const file = cookieFile(ctx);
  if (file) opts.cookieFile = file;
  const res = await ctx.http.request(opts);
  if (!res || res.status !== 200) {
    throw new Error("B 站接口 HTTP " + String((res && res.status) || "?") + "：" + path);
  }
  let payload;
  try { payload = JSON.parse(String(res.text || "{}")); }
  catch (e) { throw new Error("B 站接口返回不是 JSON：" + path); }
  if (Number(payload.code) !== 0) {
    const msg = String(payload.message || payload.msg || "未知错误");
    if (Number(payload.code) === -101 || Number(payload.code) === -400) {
      throw new Error("B 站登录态失效（" + msg + "）：先在终端执行 bili login 扫码");
    }
    throw new Error("B 站接口报错 " + payload.code + "：" + msg);
  }
  return payload.data === undefined ? {} : payload.data;
}

function accountItem(row) {
  const mid = String(row.mid || row.uid || "");
  return {
    account_id: mid,
    name: String(row.uname || row.name || ""),
    avatar: String(row.face || row.avatar || ""),
    url: mid ? "https://space.bilibili.com/" + mid : "",
    bio: String(row.sign || row.bio || ""),
    relation: "following",
    followed_at: 0,
    extra: {
      official_verify: row.official_verify || null,
      vip: row.vip || null
    }
  };
}

async function followingAccounts(ctx, args) {
  const limit = Math.max(1, Math.min(Number(args.limit) || 200, 500));
  const page = Math.max(1, Number(args.cursor) || 1);
  const size = Math.min(FOLLOWING_PAGE_SIZE, limit);
  const me = await run(ctx, ["bili", "me", "show", "--raw"], 30000);
  const mid = String(((me || {}).myinfo || {}).mid || "");
  if (!mid) throw new Error("bili CLI 没返回当前账号 mid，先执行 bili login");
  const data = await apiJson(ctx, "/x/relation/followings", {
    vmid: mid,
    pn: page,
    ps: size,
    order: "desc",
    order_type: "attention"
  }, 30000);
  const rows = Array.isArray(data.list) ? data.list : [];
  const total = Number(data.total) || 0;
  const items = rows.map(accountItem).filter(function (a) { return a.account_id; });
  const next = total && page * size < total ? String(page + 1) : null;
  return { items: items, next: next, total: total };
}

function durationOf(text) {
  const parts = String(text || "").split(":");
  if (parts.length === 2) return (Number(parts[0]) || 0) * 60 + (Number(parts[1]) || 0);
  if (parts.length === 3) {
    return (Number(parts[0]) || 0) * 3600 + (Number(parts[1]) || 0) * 60 + (Number(parts[2]) || 0);
  }
  return count(text);
}

function authorVideoItem(row, fallbackMid) {
  const bvid = String(row.bvid || "");
  return {
    native_id: "video:" + bvid,
    kind: "video",
    title: String(row.title || "").slice(0, MAX_TITLE),
    text: String(row.description || ""),
    url: bvid ? "https://www.bilibili.com/video/" + bvid : "",
    cover: String(row.pic || ""),
    images: [],
    author: {
      name: String(row.author || ""),
      id: String(row.mid || fallbackMid || ""),
      avatar: ""
    },
    published_at: count(row.created),
    duration: durationOf(row.length),
    stats: { view: count(row.play), comment: count(row.comment), danmaku: count(row.video_review) },
    tags: [],
    extra: {}
  };
}

async function authorProfile(ctx, args) {
  const mid = String(args.id || "");
  if (!mid) throw new Error("authorProfile 缺少作者 id");
  const data = await run(ctx, ["bili", "user", "info", mid, "--raw"], 35000);
  const info = data.info || {};
  const relation = data.relation || {};
  return {
    account_id: String(info.mid || mid),
    name: String(info.name || ""),
    avatar: String(info.face || ""),
    bio: String(info.sign || ""),
    url: "https://space.bilibili.com/" + String(info.mid || mid),
    following: count(relation.following),
    follower: count(relation.follower)
  };
}

async function authorPosts(ctx, args) {
  const mid = String(args.id || "");
  if (!mid) throw new Error("authorPosts 缺少作者 id");
  const limit = Math.max(1, Math.min(Number(args.limit) || 20, 50));
  const page = Math.max(1, Number(args.cursor) || 1);
  const data = await run(ctx, ["bili", "user", "videos", mid, "--raw",
    "--page", String(page), "--size", String(limit)], 45000);
  const list = (data.list || {});
  const rows = Array.isArray(list.vlist) ? list.vlist : [];
  const meta = data.page || {};
  const total = Number(meta.count) || 0;
  const items = rows.map(function (row) { return authorVideoItem(row, mid); })
    .filter(function (item) { return item.native_id !== "video:"; });
  const next = total && page * limit < total ? String(page + 1) : null;
  return { items: items, next: next, total: total };
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

// ---------------------------------------------------------------- 总结素材
// 总结要两样东西：能带时间点的字幕（subtitle 的 items），以及官方总结/简介/热评（watch）。
// 字幕拿不到就退回 watch 的纯文本，要点没有时间点也比编时间点强。
const SUMMARY_LINE_MAX = 900;

function splitTranscript(text) {
  return String(text || "").split(/\n+/).map(function (line) {
    return line.trim();
  }).filter(function (line) {
    return line.length > 1;
  }).slice(0, SUMMARY_LINE_MAX);
}

async function buildSummarySource(ctx, args) {
  const item = args.item || {};
  const bvid = bvidOf(item);
  if (!bvid) throw new Error("这条不是 B 站视频，取不到字幕");
  const data = await run(ctx, [
    "bili", "video", "watch", bvid,
    "--frames", "0", "--comments", "5", "--max-chars", "6000"
  ], 70000);

  let lines = [];
  let source = "";
  try {
    const sub = await run(ctx, ["bili", "video", "subtitle", bvid], 45000);
    const rows = Array.isArray(sub.items) ? sub.items : [];
    lines = rows.map(function (row) {
      return {
        t: Math.max(0, Math.round(Number(row.from) || 0)),
        text: String(row.content || "").trim()
      };
    }).filter(function (row) { return row.text; }).slice(0, SUMMARY_LINE_MAX);
    source = String(sub.lang || "");
  } catch (e) {
    ctx.log.warn("字幕取不到，退回 watch 的纯文本：" + String(e).slice(0, 120));
  }
  if (!lines.length) {
    lines = splitTranscript((data.transcript || {}).text).map(function (text) {
      return { t: null, text: text };
    });
  }
  const official = String(data.ai_summary || "");
  return {
    basis: lines.length ? "transcript" : (official ? "official" : "desc"),
    duration: count(data.duration) || count(item.duration),
    title: String(data.title || item.title || ""),
    desc: String(data.desc || item.text || ""),
    official: official,
    transcript: lines.length
      ? { source: source ? "subtitle:" + source : "watch", lines: lines }
      : null,
    chapters: (data.chapters || []).map(function (c) {
      const at = Number(c.t || c.from || c.start || c.time || 0) || 0;
      return { t: Math.max(0, Math.round(at)), title: String(c.title || "") };
    }).filter(function (c) { return c.title; }),
    comments: (data.hot_comments || []).map(function (c) {
      return { user: String(c.user || ""), text: String(c.content || ""), like: count(c.like) };
    })
  };
}

module.exports = {
  async pull(ctx, args) {
    const feedId = String(args.feedId || "recommend");
    const limit = Number(args.limit) || 20;
    // following 与 timeline 是同一份动态流；timeline 是旧 id，保留兼容
    if (feedId === "timeline" || feedId === "following") return pullTimeline(ctx, limit, args.cursor);
    if (feedId === "recommend") return pullRecommend(ctx, limit, args.cursor);
    throw new Error("未知的流：" + feedId + "（支持 recommend / timeline / following）");
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

  async summarySource(ctx, args) {
    return buildSummarySource(ctx, args);
  },

  async followingAccounts(ctx, args) {
    return followingAccounts(ctx, args || {});
  },

  async authorProfile(ctx, args) {
    return authorProfile(ctx, args || {});
  },

  async authorPosts(ctx, args) {
    return authorPosts(ctx, args || {});
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
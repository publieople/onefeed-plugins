// 小红书插件：宿主浏览器打开发现页，截 homefeed 接口响应。
// 不依赖 xhs-cli（它必须 Camoufox）；登录态由宿主注入 cookie 提供，
// 插件本身看不到 cookie 明文，只拿到页面已经签过名的响应。
"use strict";

function pick() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return "";
}

function count(value) {
  if (value === undefined || value === null || value === "") return 0;
  const v = Number(value);
  if (isFinite(v) && v > 0) return Math.round(v);
  // "1.2万" 这类
  const m = String(value).match(/^([\d.]+)\s*万/);
  return m ? Math.round(parseFloat(m[1]) * 10000) : 0;
}

function textOf(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function imageUrlOf(image) {
  if (!image) return "";
  if (typeof image === "string") return image;
  // info_list 里 WB_DFT 是原图宽度档，url_default 兜底
  const list = image.info_list || image.infoList || [];
  let dft = "";
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].image_scene === "WB_DFT" && list[i].url) dft = list[i].url;
  }
  return textOf(pick(dft, image.url_default, image.urlDefault, image.url_pre, image.urlPre, image.url));
}

function noteItem(row) {
  const card = (row && row.note_card) || {};
  const id = textOf(pick(row.id, card.note_id, card.noteId));
  const title = textOf(pick(card.display_title, card.displayTitle, card.title, card.desc));
  const cover = imageUrlOf(card.cover || card.image || null);
  const user = card.user || card.author || {};
  const interact = card.interact_info || card.interactInfo || {};
  const type = textOf(card.type).toLowerCase();
  const isVideo = type === "video";
  const token = textOf(row.xsec_token);

  // 详情页现在必须带 xsec_token，否则会跳登录或 404
  let url = "https://www.xiaohongshu.com/explore/" + id;
  if (token) {
    url += "?xsec_token=" + encodeURIComponent(token) + "&xsec_source=pc_feed";
  }

  return {
    native_id: "note:" + id,
    kind: isVideo ? "video" : "images",
    title: title.slice(0, 200),
    text: textOf(pick(card.desc, card.description)),
    url: url,
    cover: cover,
    images: cover ? [cover] : [],
    author: {
      name: textOf(pick(user.nickname, user.nick_name, user.nickName, user.name)),
      id: textOf(pick(user.user_id, user.userId, user.id)),
      avatar: textOf(pick(user.avatar, user.image))
    },
    // 首页信息流不带发布时间，留 0 由宿主排到后面，不编造
    published_at: 0,
    duration: count(pick(card.video_time, card.videoTime, card.duration)),
    stats: {
      like: count(pick(interact.liked_count, interact.likedCount, interact.like_count)),
      comment: count(pick(interact.comment_count, interact.commentCount)),
      share: count(pick(interact.share_count, interact.shareCount)),
      collect: count(pick(interact.collected_count, interact.collectedCount))
    },
    tags: [],
    extra: { model_type: textOf(row.model_type) }
  };
}

function homefeedOf(responses) {
  const rows = responses || [];
  for (let i = 0; i < rows.length; i++) {
    const payload = rows[i] && rows[i].json;
    const data = payload && payload.data;
    const items = data && data.items;
    if (Array.isArray(items) && items.length) return items;
  }
  return [];
}

async function captureExplore(ctx, settleMs) {
  return ctx.browser.capture({
    url: "https://www.xiaohongshu.com/explore",
    patterns: ["/api/sns/web/v1/homefeed"],
    scroll: { times: 2, dy: 2400, intervalMs: 1500 },
    timeoutMs: 60000,
    settleMs: settleMs || 4500
  });
}

function bestStream(streams) {
  const list = Array.isArray(streams) ? streams : [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].url) return list[i];
  }
  return null;
}

// ---------------------------------------------------------------- 评论
const COMMENT_PATTERN = "/api/sns/web/v2/comment/page";
const COMMENT_CACHE_MS = 600000;

function noteIdOf(item) {
  const native = textOf(item.native_id || "");
  if (native.indexOf("note:") === 0) return native.slice("note:".length);
  const url = textOf(item.url || "");
  const m = url.match(/\/explore\/([0-9a-zA-Z]+)/);
  return m ? m[1] : "";
}

function commentItem(row) {
  const user = row.user_info || {};
  const replies = [];
  const kids = Array.isArray(row.sub_comments) ? row.sub_comments : [];
  for (let i = 0; i < kids.length && replies.length < 3; i++) {
    const kid = kids[i] || {};
    const ku = kid.user_info || {};
    replies.push({
      id: textOf(kid.id),
      author: textOf(ku.nickname),
      text: textOf(kid.content),
      like_count: count(kid.like_count),
      created_at: Math.round(count(kid.create_time) / 1000)
    });
  }
  return {
    id: textOf(row.id),
    author: textOf(user.nickname),
    author_id: textOf(user.user_id),
    text: textOf(row.content),
    like_count: count(row.like_count),
    reply_count: count(row.sub_comment_count),
    created_at: Math.round(count(row.create_time) / 1000),
    replies: replies
  };
}

function collectCommentRows(responses) {
  const rows = [];
  const seen = {};
  const list = responses || [];
  for (let i = 0; i < list.length; i++) {
    const payload = list[i] && list[i].json;
    const data = payload && payload.data;
    const items = data && data.comments;
    if (!Array.isArray(items)) continue;
    for (let j = 0; j < items.length; j++) {
      const row = items[j];
      if (!row || !row.id) continue;
      const id = String(row.id);
      if (seen[id]) continue;
      seen[id] = 1;
      rows.push(row);
    }
  }
  return rows;
}

async function buildDetail(ctx, args) {
  const item = args.item || {};
  const url = String(item.url || "");
  if (!url) throw new Error("这条笔记没有可打开的地址");
  const res = await ctx.browser.extract({ name: "xhs.note", url: url, timeoutMs: 60000, settleMs: 4000 });
  const value = (res && res.value) || {};
  if (!value.ok) {
    throw new Error("小红书页内提取失败：" + String(value.reason || "未知原因") + "（停在 " + String((res && res.url) || "") + "）");
  }
  const images = (value.images || []).slice(0, 12);
  const stream = bestStream(value.streams);
  // 直链能取到，但浏览器里 <video>/<img> 会带上本地页面的 Referer，xhscdn 那边直接 403。
  // 所以带上 referer 标记，让宿主边车代取（/api/media/<item>/video），请求头由宿主拼。
  const media = stream ? {
    type: "file",
    url: String(stream.url),
    poster: images[0] || String(item.cover || ""),
    referer: "https://www.xiaohongshu.com/",
    duration: Math.round(Number(value.duration) || 0)
  } : null;
  const interact = value.interact || {};
  return {
    body: { kind: "text", value: String(value.desc || item.text || "") },
    media: media,
    images: images,
    stats: {
      like: count(interact.like),
      comment: count(interact.comment),
      collect: count(interact.collect),
      share: count(interact.share)
    },
    note: stream
      ? "正文与图片取自页面自身数据；视频和图片都由宿主代取（xhscdn 会看 Referer），直链带时效签名，过期后点一次刷新。"
      : "正文与图片取自页面自身数据；图片由宿主代取（xhscdn 会看 Referer）。图文笔记的正文常常只有话题标签，内容在图片里。"
  };
}

module.exports = {
  async pull(ctx, args) {
    const limit = Math.min(Number(args.limit) || 20, 50);
    const res = await captureExplore(ctx);
    const rows = homefeedOf(res.responses);
    if (!rows.length) {
      const landed = String(res.url || "");
      if (landed.indexOf("/login") >= 0) {
        throw new Error("小红书未登录：请在客户端扫码登录，cookie 会写入本机状态目录");
      }
      throw new Error("没有截到 homefeed 响应（页面停留 " + landed + "，可能被风控或页面改版）");
    }
    const items = [];
    for (let i = 0; i < rows.length && items.length < limit; i++) {
      const row = rows[i];
      if (!row || row.model_type !== "note" || !row.note_card) continue;
      if (row.ignore === true) continue;
      try {
        const it = noteItem(row);
        if (it.native_id !== "note:") items.push(it);
      } catch (e) {
        ctx.log.warn("跳过一条解析失败的笔记: " + String(e));
      }
    }
    if (!items.length) throw new Error("homefeed 有 " + rows.length + " 条，但没有可用 note 卡片");
    return { items: items, next: null };
  },

  async detail(ctx, args) {
    return buildDetail(ctx, args);
  },

  async comments(ctx, args) {
    const item = args.item || {};
    const noteId = noteIdOf(item);
    if (!noteId) throw new Error("这条笔记没有 note_id，取不到评论");
    const limit = Math.min(Number(args.limit) || 20, 50);
    const offset = Math.max(0, Number(args.cursor) || 0);
    const key = "comments:" + (item.id || noteId);

    // 页面的评论 cursor 是它自己算的 opaque 值，插件没法直接续；
    // 所以一次滚到底把能拿的都抓下来，缓在插件存储里，翻页时切片。十分钟内再翻不重开浏览器。
    let all = ctx.cache.get(key);
    if (!Array.isArray(all) || !all.length) {
      const cap = await ctx.browser.capture({
        url: String(item.url || ("https://www.xiaohongshu.com/explore/" + noteId)),
        patterns: [COMMENT_PATTERN],
        // 评论列在右侧，滚轮必须落在这块，否则页面只滚正文、不发评论请求
        scrollPoint: { x: 1180, y: 620 },
        scroll: { times: 10, dy: 1100, intervalMs: 1000 },
        settleMs: 4000,
        timeoutMs: 90000,
        stopWhenMatched: false
      });
      const rows = collectCommentRows(cap.responses);
      if (!rows.length) {
        const landed = String(cap.url || "");
        if (landed.indexOf("/login") >= 0) {
          throw new Error("小红书未登录：先在客户端扫码登录，评论才拿得到");
        }
        throw new Error("没截到小红书评论：这条可能关闭了评论，或页面被风控（停在 " + landed + "）");
      }
      all = rows.map(commentItem);
      ctx.cache.set(key, all, 600);
    }
    const slice = all.slice(offset, offset + limit);
    return {
      items: slice,
      next: all.length > offset + limit ? String(offset + limit) : null
    };
  },

  async auth(ctx) {
    try {
      const res = await captureExplore(ctx, 3500);
      const rows = homefeedOf(res.responses);
      if (rows.length) return { state: "ok", hint: "已登录，信息流可用（" + rows.length + " 条/屏）" };
      if (String(res.url || "").indexOf("/login") >= 0) {
        return { state: "need_login", hint: "在客户端扫码登录小红书" };
      }
      return { state: "error", hint: "没能截到 homefeed，停留页 " + res.url };
    } catch (e) {
      return { state: "error", hint: String(e).slice(0, 200) };
    }
  }
};
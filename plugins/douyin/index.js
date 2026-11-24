// 抖音插件：接口要私有签名，所以不逆向——用持久浏览器档案打开网页，
// 抓页面自己发出的 /aweme/v2/web/module/feed/ 响应（宿主提供粗粒度 capture，用完即销毁）。
"use strict";

const FEED_PATTERN = "/aweme/v2/web/module/feed/";
const FOLLOW_PATTERN = "/aweme/v1/web/follow/feed/";
const COMMENT_PATTERN = "/aweme/v1/web/comment/list/";

function count(value) {
  const v = Number(value);
  return isFinite(v) && v > 0 ? Math.round(v) : 0;
}

function firstUrl(list) {
  if (!list || !list.length) return "";
  const raw = list[0];
  // 抖音的封面 URL 常带 &amp; 转义，浏览器里通常已是正常字符，这里统一兜一下
  return String(raw).replace(/&amp;/g, "&");
}

function pickJson(responses, test) {
  const list = responses || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].json && test(list[i].json)) return list[i].json;
  }
  return null;
}

function awemeItem(row) {
  const id = String(row.aweme_id);
  const video = row.video || {};
  const stats = row.statistics || {};
  const author = row.author || {};
  const cover = firstUrl(video.cover && video.cover.url_list) ||
                firstUrl(video.origin_cover && video.origin_cover.url_list) ||
                firstUrl(video.dynamic_cover && video.dynamic_cover.url_list);
  const desc = String(row.desc || "");
  // 详情页的兜底：官方播放器偶尔不认 vid，把网页端这条直链一起存下来
  const playAddr = firstUrl(video.play_addr && video.play_addr.url_list);
  const tags = [];
  const extraText = row.text_extra || [];
  for (let i = 0; i < extraText.length && tags.length < 6; i++) {
    if (extraText[i] && extraText[i].hashtag_name) tags.push(String(extraText[i].hashtag_name));
  }
  return {
    native_id: "video:" + id,
    kind: "video",
    title: desc.split("\n")[0].slice(0, 200) || "抖音视频",
    text: desc,
    url: "https://www.douyin.com/video/" + id,
    cover: cover,
    images: [],
    author: {
      name: String(author.nickname || ""),
      id: String(author.sec_uid || ""),
      avatar: firstUrl(author.avatar_thumb && author.avatar_thumb.url_list)
    },
    published_at: count(row.create_time),
    duration: Math.round(count(video.duration) / 1000),
    stats: {
      like: count(stats.digg_count),
      comment: count(stats.comment_count),
      share: count(stats.share_count),
      view: count(stats.play_count),
      collect: count(stats.collect_count)
    },
    tags: tags,
    extra: playAddr ? { play_addr: playAddr } : {}
  };
}

function commentItem(row) {
  const user = row.user || {};
  const replies = [];
  const kids = Array.isArray(row.reply_comment) ? row.reply_comment : [];
  for (let i = 0; i < kids.length && replies.length < 3; i++) {
    const kid = kids[i] || {};
    const ku = kid.user || {};
    replies.push({
      id: String(kid.cid || ""),
      author: String(ku.nickname || ""),
      text: String(kid.text || ""),
      like_count: count(kid.digg_count),
      created_at: count(kid.create_time)
    });
  }
  return {
    id: String(row.cid || ""),
    author: String(user.nickname || ""),
    author_id: String(user.sec_uid || ""),
    text: String(row.text || ""),
    like_count: count(row.digg_count),
    reply_count: count(row.reply_comment_total),
    created_at: count(row.create_time),
    replies: replies
  };
}

// 滚屏会多次触发 comment/list，每页 5-20 条，按 cid 合并成一份
function collectCommentRows(responses) {
  const rows = [];
  const seen = {};
  const list = responses || [];
  for (let i = 0; i < list.length; i++) {
    const json = list[i] && list[i].json;
    const items = json && json.comments;
    if (!Array.isArray(items)) continue;
    for (let j = 0; j < items.length; j++) {
      const row = items[j];
      if (!row || !row.cid) continue;
      const id = String(row.cid);
      if (seen[id]) continue;
      seen[id] = 1;
      rows.push(row);
    }
  }
  return rows;
}

function awemeIdOf(item) {
  const id = String(item.native_id || "");
  if (id.indexOf("video:") === 0) return id.slice("video:".length);
  const url = String(item.url || "");
  const idx = url.indexOf("/video/");
  return idx < 0 ? "" : url.slice(idx + "/video/".length).split("?")[0].split("/")[0];
}

// 关注流：页面自己发 /aweme/v1/web/follow/feed/，响应 data[].aweme 才是内容，
// feed_type=3 是直播/卡片占位，aweme 为空，跳过
function followRows(responses) {
  const rows = [];
  const list = responses || [];
  for (let i = 0; i < list.length; i++) {
    const json = list[i] && list[i].json;
    const data = json && json.data;
    if (!Array.isArray(data)) continue;
    for (let j = 0; j < data.length; j++) {
      const row = data[j];
      const aweme = row && row.aweme;
      if (!aweme || !aweme.aweme_id) continue;
      rows.push(aweme);
    }
  }
  return rows;
}

async function pullFollowing(ctx, limit) {
  const cap = await ctx.browser.capture({
    url: "https://www.douyin.com/follow",
    patterns: [FOLLOW_PATTERN],
    scroll: { times: 3, dy: 2400, intervalMs: 900 },
    settleMs: 3000,
    timeoutMs: 65000
  });

  const seen = {};
  const items = [];
  const rows = followRows(cap.responses);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const id = String(row.aweme_id);
    if (seen[id]) continue;
    seen[id] = true;
    items.push(awemeItem(row));
  }
  if (!items.length) {
    throw new Error("没抓到抖音关注流：确认本机浏览器档案已登录抖音并且关注了一些账号，或网页结构变了");
  }
  items.sort(function (a, b) { return (b.published_at || 0) - (a.published_at || 0); });
  return { items: items.slice(0, limit), next: null };
}

module.exports = {
  async pull(ctx, args) {
    const feedId = String(args.feedId || "recommend");
    const limit = Math.min(Number(args.limit) || 20, 50);
    if (ctx.env.demo) return { items: [], next: null };
    if (feedId === "following") return pullFollowing(ctx, limit);
    if (feedId !== "recommend") throw new Error("未知的流：" + feedId + "（支持 recommend / following）");

    const cap = await ctx.browser.capture({
      url: "https://www.douyin.com/?recommend=1",
      patterns: [FEED_PATTERN],
      scroll: { times: 3, dy: 2400, intervalMs: 900 },
      settleMs: 3000,
      timeoutMs: 65000
    });

    const payload = pickJson(cap.responses, function (json) {
      return json && json.aweme_list && json.aweme_list.length;
    });
    if (!payload) {
      throw new Error("没抓到抖音推荐流：确认本机浏览器档案已登录抖音（首次会弹出窗口），或网页结构变了");
    }
    const items = payload.aweme_list.slice(0, limit).map(awemeItem);
    return { items: items, next: null };
  },

  async detail(ctx, args) {
    const item = args.item || {};
    const id = awemeIdOf(item);
    if (!id) throw new Error("这条内容没有 aweme_id，没法拼官方播放器");
    const extra = item.extra || {};
    const media = {
      type: "embed",
      embedUrl: "https://open.douyin.com/player/video?vid=" + id + "&autoplay=0",
      poster: String(item.cover || ""),
      duration: Math.round(Number(item.duration) || 0)
    };
    // 采集时存下来的网页直链：官方播放器打不开时，前端可以切到它（宿主边车补 Referer）
    if (extra.play_addr) {
      media.fallbackUrl = String(extra.play_addr);
      media.fallbackReferer = "https://www.douyin.com/";
    }
    // 正文与评论不硬凑：抖音网页端的 detail 接口要 a_bogus 签名，这里只给能稳定拿到的东西。
    return {
      body: { kind: "text", value: String(item.text || "") },
      media: media,
      stats: {
        like: Math.round(Number(item.like_count) || 0),
        comment: Math.round(Number(item.comment_count) || 0),
        share: Math.round(Number(item.share_count) || 0)
      },
      note: extra.play_addr
        ? "抖音只开放官方播放器；打不开时点「换直链播放」，直链由宿主边车补 Referer 后转发。评论未登录时只给第一页，更多要去原帖看。"
        : "抖音只开放官方播放器；评论未登录时只给第一页，更多要去原帖看。"
    };
  },

  async comments(ctx, args) {
    const item = args.item || {};
    const id = awemeIdOf(item);
    if (!id) throw new Error("这条内容没有 aweme_id，取不到评论");
    const limit = Math.min(Number(args.limit) || 20, 50);
    // 未登录时抖音只给第一页 5 条就提示登录，登录后才继续翻；这里滚几次把能拿的都收下，
    // 拿不到更多就 next=null，由前端提示去原帖看。
    const cap = await ctx.browser.capture({
      url: "https://www.douyin.com/video/" + id,
      patterns: [COMMENT_PATTERN],
      scroll: { times: 6, dy: 1400, intervalMs: 900 },
      settleMs: 3000,
      timeoutMs: 70000,
      stopWhenMatched: false
    });
    const rows = collectCommentRows(cap.responses);
    if (!rows.length) {
      throw new Error("没抓到抖音评论：这条可能关闭了评论，或页面停在登录提示上");
    }
    const items = rows.slice(0, limit).map(commentItem);
    return { items: items, next: null };
  }
};
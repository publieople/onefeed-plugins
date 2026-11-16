// 抖音插件：接口要私有签名，所以不逆向——用持久浏览器档案打开网页，
// 抓页面自己发出的 /aweme/v2/web/module/feed/ 响应（宿主提供粗粒度 capture，用完即销毁）。
"use strict";

const FEED_PATTERN = "/aweme/v2/web/module/feed/";
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
    extra: {}
  };
}

function awemeIdOf(item) {
  const id = String(item.native_id || "");
  if (id.indexOf("video:") === 0) return id.slice("video:".length);
  const url = String(item.url || "");
  const idx = url.indexOf("/video/");
  return idx < 0 ? "" : url.slice(idx + "/video/".length).split("?")[0].split("/")[0];
}

module.exports = {
  async pull(ctx, args) {
    const limit = Math.min(Number(args.limit) || 20, 50);
    if (ctx.env.demo) return { items: [], next: null };

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
    // 正文与评论不硬凑：抖音网页端的 detail 接口要 a_bogus 签名，这里只给能稳定拿到的东西。
    return {
      body: { kind: "text", value: String(item.text || "") },
      media: {
        type: "embed",
        embedUrl: "https://open.douyin.com/player/video?vid=" + id + "&autoplay=0",
        poster: String(item.cover || ""),
        duration: Math.round(Number(item.duration) || 0)
      },
      stats: {
        like: Math.round(Number(item.like_count) || 0),
        comment: Math.round(Number(item.comment_count) || 0),
        share: Math.round(Number(item.share_count) || 0)
      },
      note: "抖音只开放官方播放器，评论要在原帖看。"
    };
  },

  async comments(ctx, args) {
    const item = args.item || {};
    const secUid = (item.author || {}).id || "";
    if (!secUid) throw new Error("这条内容没有可用的 aweme_id");
    const cap = await ctx.browser.capture({
      url: item.url || "https://www.douyin.com/",
      patterns: [COMMENT_PATTERN],
      scroll: { times: 1, dy: 1200, intervalMs: 900 },
      settleMs: 2500,
      timeoutMs: 65000
    });
    const payload = pickJson(cap.responses, function (json) {
      return json && json.comments && json.comments.length;
    });
    if (!payload) throw new Error("没抓到抖音评论");
    return {
      items: payload.comments.slice(0, Number(args.limit) || 20).map(function (row) {
        return {
          id: String(row.cid),
          author: String((row.user || {}).nickname || ""),
          text: String(row.text || ""),
          like_count: count(row.digg_count),
          reply_count: count(row.reply_comment_total),
          created_at: count(row.create_time),
          replies: []
        };
      })
    };
  }
};
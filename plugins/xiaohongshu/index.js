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

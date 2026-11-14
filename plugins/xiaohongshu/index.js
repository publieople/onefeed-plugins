// 小红书插件：经本机 xhs CLI 取发现页（CLI 自己管登录态）。
// 未登录时 CLI 会输出 "Not logged in. Run `xhs login` first."（纯文本，不是 JSON）。
"use strict";

function pick() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return "";
}

function unixOf(value) {
  if (typeof value === "number" && isFinite(value) && value > 0) {
    const n = Math.floor(value);
    return n > 1e12 ? Math.floor(n / 1000) : n;   // 毫秒 → 秒
  }
  const t = Date.parse(String(value || ""));
  return isFinite(t) ? Math.floor(t / 1000) : 0;
}

function count(value) {
  const v = Number(value);
  return isFinite(v) && v > 0 ? Math.round(v) : 0;
}

function coverOf(note) {
  const image = note.image || note.cover || note.cover_image || null;
  if (!image) return "";
  if (typeof image === "string") return image;
  return String(pick(image.url_default, image.url, image.url_pre, image.cover));
}

function noteItem(note) {
  const id = String(pick(note.note_id, note.id, note.noteId));
  const user = note.user || note.author || {};
  const interact = note.interact_info || note.interactInfo || note.stats || {};
  const images = [];
  const rawImages = note.images || note.image_list || note.imageList || [];
  for (let i = 0; i < rawImages.length && images.length < 9; i++) {
    const row = rawImages[i];
    if (typeof row === "string") images.push(row);
    else images.push(String(pick(row.url_default, row.url, row.url_pre)));
  }
  const cover = coverOf(note) || (images.length ? images[0] : "");
  if (images.length === 0 && cover) images.push(cover);
  const type = String(note.type || note.note_type || "");
  const isVideo = type.toLowerCase().indexOf("video") >= 0;

  return {
    native_id: "note:" + id,
    kind: isVideo ? "video" : "images",
    title: String(pick(note.title, note.display_title, note.desc)).slice(0, 200),
    text: String(pick(note.desc, note.content, note.text)),
    url: "https://www.xiaohongshu.com/explore/" + id,
    cover: cover,
    images: images,
    author: {
      name: String(pick(user.nickname, user.nick_name, user.name)),
      id: String(pick(user.user_id, user.userId, user.id)),
      avatar: String(pick(user.avatar, user.image))
    },
    published_at: unixOf(pick(note.time, note.create_time, note.publish_time, note.published_at)),
    duration: count(note.video_time || note.duration),
    stats: {
      like: count(pick(interact.liked_count, interact.like_count, interact.likedCount)),
      comment: count(pick(interact.comment_count, interact.commentCount)),
      share: count(pick(interact.share_count, interact.shareCount)),
      collect: count(pick(interact.collected_count, interact.collect_count))
    },
    tags: (note.tag_list || note.tags || []).map(function (t) {
      return typeof t === "string" ? t : String(t.name || "");
    }).filter(function (t) { return t; }).slice(0, 6),
    extra: {}
  };
}

module.exports = {
  async pull(ctx, args) {
    const limit = Math.min(Number(args.limit) || 20, 50);
    const res = await ctx.cli.run({ argv: ["xhs", "feed", "--json"], timeoutMs: 60000 });
    const text = String(res.stdout || "").trim();
    if (/not logged in|未登录/i.test(text + " " + String(res.stderr || ""))) {
      throw new Error("小红书未登录：先在终端执行 xhs login 扫码");
    }
    if (!text) throw new Error("xhs feed 没有输出" + (res.stderr ? "：" + res.stderr.trim().slice(0, 200) : ""));

    let payload;
    try { payload = JSON.parse(text); }
    catch (e) { throw new Error("xhs feed 输出不是 JSON：" + text.slice(0, 200)); }

    let rows = payload;
    if (!Array.isArray(rows)) {
      rows = payload.items || payload.notes || payload.data || payload.feeds || [];
      if (!Array.isArray(rows)) rows = [];
    }
    return { items: rows.slice(0, limit).map(noteItem), next: null };
  },

  async auth(ctx) {
    try {
      const res = await ctx.cli.run({ argv: ["xhs", "status"], timeoutMs: 20000 });
      const text = String(res.stdout || "") + " " + String(res.stderr || "");
      if (/not logged in|未登录/i.test(text)) {
        return { state: "need_login", hint: "在终端执行 xhs login 扫码" };
      }
      return { state: "ok", hint: text.trim().slice(0, 120) };
    } catch (e) {
      return { state: "need_login", hint: String(e).slice(0, 200) };
    }
  }
};

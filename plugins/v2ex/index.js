// V2EX 插件：公开热门主题接口。国内直连常被墙，宿主 http 会自动回退本机代理。
"use strict";

const ENDPOINT = "https://www.v2ex.com/api/topics/hot.json";
const SHOW_ENDPOINT = "https://www.v2ex.com/api/topics/show.json";

function count(value) {
  const v = Number(value);
  return isFinite(v) && v > 0 ? Math.round(v) : 0;
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}

function topicItem(row) {
  const node = row.node || {};
  const member = row.member || {};
  const id = String(row.id);
  return {
    native_id: "topic:" + id,
    kind: "short",
    title: String(row.title || "").slice(0, 200),
    text: stripHtml(row.content).slice(0, 600),
    url: String(row.url || ("https://www.v2ex.com/t/" + id)),
    cover: "",
    images: [],
    author: { name: String(member.username || ""), id: String(member.id || ""), avatar: "" },
    published_at: count(row.created),
    duration: 0,
    stats: { comment: count(row.replies) },
    tags: node.name ? [String(node.name)] : [],
    extra: { node_title: String(node.title || "") }
  };
}

function topicIdOf(item) {
  const native = String((item && item.native_id) || "");
  if (native.indexOf("topic:") === 0) return native.slice("topic:".length);
  const m = String((item && item.url) || "").match(/\/t\/(\d+)/);
  return m ? m[1] : "";
}

async function buildDetail(ctx, args) {
  const item = args.item || {};
  const id = topicIdOf(item);
  if (!id) throw new Error("这条 V2EX 内容没有主题号");

  const res = await ctx.http.request({
    url: SHOW_ENDPOINT,
    query: { id: id },
    headers: { "Referer": "https://www.v2ex.com/t/" + id },
    timeoutMs: 20000
  });
  if (res.status !== 200) throw new Error("V2EX 详情接口返回 HTTP " + res.status);
  const rows = res.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw new Error("V2EX 没有返回这个主题");

  const html = String(row.content_rendered || "").trim();
  const nodeName = String((row.node || {}).name || "");
  return {
    body: html
      ? { kind: "html", value: html }
      : { kind: "text", value: item.text || stripHtml(row.content) },
    media: null,
    images: [],
    stats: { comment: count(row.replies) },
    note: ""
  };
}

module.exports = {
  async pull(ctx, args) {
    const limit = Math.min(Number(args.limit) || 20, 50);
    if (ctx.env.demo) return { items: [], next: null };

    const res = await ctx.http.request({
      url: ENDPOINT,
      headers: { "Referer": "https://www.v2ex.com/" },
      timeoutMs: 20000
    });
    if (res.status !== 200) throw new Error("V2EX 接口返回 HTTP " + res.status);
    const rows = res.json();
    if (!Array.isArray(rows)) throw new Error("V2EX 返回了非数组：" + res.text.slice(0, 160));
    return { items: rows.slice(0, limit).map(topicItem), next: null };
  },

  async detail(ctx, args) {
    return buildDetail(ctx, args);
  }
};

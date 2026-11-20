import { marked } from "marked";

// ═══════════════════════════════════════════════════════════
// POSTS: markdown files in src/content/posts/, bundled at build time
// ═══════════════════════════════════════════════════════════
// File name: YYYY-MM-DD-some-slug.md  →  /posts/some-slug
// Front matter (between --- lines), one `key: value` per line:
//   title:   Required.
//   date:    YYYY-MM-DD (defaults to the file name's date).
//   type:    article | update   (updates show in full in the Home feed).
//   summary: One line for cards and the feed.
//   cover:   /posts/some-slug/cover.png   (optional; images go in public/posts/<slug>/).
//   tags:    [mlb, pitch-plus]
//   pinned:  true   (shown first on Home)
//   draft:   true   (left off the site)
//   slug:    override the URL slug
// Files whose name starts with "_" (like _TEMPLATE.md) are ignored.

const files = import.meta.glob("../content/posts/*.md", { query: "?raw", import: "default", eager: true });

function parseValue(v) {
  v = v.trim();
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(",").map(s => parseValue(s)).filter(s => s !== "");
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^(["']).*\1$/.test(v)) return v.slice(1, -1);
  return v;
}

export function parsePost(raw, filename) {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const meta = {};
  if (m) {
    for (const line of m[1].split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim()] = parseValue(line.slice(i + 1));
    }
  }
  const body = m ? m[2] : raw;
  const base = filename.replace(/^.*\//, "").replace(/\.md$/, "");
  const dm = base.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
  const slug = meta.slug || (dm ? dm[2] : base);
  const date = String(meta.date || (dm ? dm[1] : ""));
  const type = meta.type === "update" ? "update" : "article";
  const words = body.split(/\s+/).filter(Boolean).length;
  return {
    slug, date, type, body,
    title: meta.title || slug.replace(/-/g, " "),
    summary: meta.summary || "",
    cover: meta.cover || null,
    tags: Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : [],
    pinned: meta.pinned === true,
    draft: meta.draft === true,
    minutes: Math.max(1, Math.round(words / 230)),
  };
}

export const POSTS = Object.entries(files)
  .filter(([path]) => !/\/_[^/]*$/.test(path))
  .map(([path, raw]) => parsePost(raw, path))
  .filter(p => !p.draft)
  .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));

export const postBySlug = slug => POSTS.find(p => p.slug === slug) || null;

marked.setOptions({ gfm: true, breaks: false });
export const renderMarkdown = md => marked.parse(md || "");

// "Nov 20, 2026", or with `long` "November 20, 2026".
export function formatDate(d, long = false) {
  const dt = new Date(`${d}T12:00:00Z`);
  return isNaN(dt) ? d : dt.toLocaleDateString("en-US", { month: long ? "long" : "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

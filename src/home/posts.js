import { marked } from "marked";
import { parsePost } from "./postParse.js";
export { SITE_URL } from "./postParse.js";

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
//   preview: /posts/some-slug/thumb.png   (optional; the Home thumbnail. Defaults to the
//            cover, else the post's first image.)
//   share:   /posts/some-slug/share.jpg   (optional; the picture in the X card, best at
//            1200x630: see scripts/make_share_image.py. Defaults to the preview.)
//   tags:    [mlb, pitch-plus]
//   pinned:  true   (shown first on Home)
//   draft:   true   (left off the site)
//   slug:    override the URL slug
// Files whose name starts with "_" (like _TEMPLATE.md) are ignored.

const files = import.meta.glob("../content/posts/*.md", { query: "?raw", import: "default", eager: true });

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

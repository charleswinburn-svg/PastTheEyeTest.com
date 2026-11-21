// Front-matter parsing for posts. Plain JS with no imports, so the build (vite.config.js,
// which writes each post's social-card page) and the site share one parser.

// The live site. Links shared to X and the image in the X card must be absolute URLs.
export const SITE_URL = "https://www.pasttheeyetest.com";

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
  // Preview for the home page: the first paragraph as plain text, and the first image.
  const firstPara = body.split(/\n\s*\n/).map(b => b.trim())
    .find(b => b && !b.startsWith("<") && !b.startsWith("#") && !b.startsWith("|") && !b.startsWith("!["));
  const excerpt = (firstPara || "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>]/g, "")
    .replace(/\s+/g, " ").trim();
  const img = body.match(/<img[^>]*\ssrc="([^"]+)"/) || body.match(/!\[[^\]]*\]\(([^)\s]+)/);
  return {
    slug, date, type, body, excerpt, previewImage: meta.preview || meta.cover || (img ? img[1] : null),
    // The X / social card picture: `share`, else the preview, cover or first image.
    shareImage: meta.share || meta.preview || meta.cover || (img ? img[1] : null),
    title: meta.title || slug.replace(/-/g, " "),
    summary: meta.summary || "",
    cover: meta.cover || null,
    tags: Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : [],
    pinned: meta.pinned === true,
    draft: meta.draft === true,
    minutes: Math.max(1, Math.round(words / 230)),
  };
}

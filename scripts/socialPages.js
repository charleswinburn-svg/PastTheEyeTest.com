// ═══════════════════════════════════════════════════════════
// Build step: one social-card page per post (X, iMessage, Discord, …)
// ═══════════════════════════════════════════════════════════
// Link previews come from <meta> tags in the HTML a crawler downloads, and crawlers don't
// run JavaScript, so a single-page app shows every link with the site's default card.
// After `vite build`, this writes dist/posts/<slug>/index.html for every published post:
// the same app page, with that post's title, description and share picture in the
// og:/twitter: tags (a large-image card). People who open the link get the normal
// site; vercel.json sends /posts/<slug> to that file.

import fs from "node:fs";
import path from "node:path";
import { parsePost, SITE_URL } from "../src/home/postParse.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const abs = (u) => (!u ? null : /^https?:\/\//.test(u) ? u : SITE_URL + (u.startsWith("/") ? u : `/${u}`));
const clip = (s, n) => (s.length <= n ? s : s.slice(0, s.lastIndexOf(" ", n - 1)).replace(/[,;:.\s]+$/, "") + "…");

// Width × height of a PNG or JPEG, so X can lay out the card on the first share.
function imageSize(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b[0] === 0xff && b[1] === 0xd8) {
      for (let i = 2; i < b.length - 9;) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1], len = b.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
  } catch { /* missing or unreadable: leave the size out */ }
  return null;
}

function socialBlock(post, publicDir) {
  const url = `${SITE_URL}/posts/${post.slug}`;
  const desc = clip(post.summary || post.excerpt || "", 200);
  const img = abs(post.shareImage);
  const size = post.shareImage && !/^https?:/.test(post.shareImage) ? imageSize(path.join(publicDir, post.shareImage)) : null;
  const imgAlt = post.title;
  return [
    `<title>${esc(post.title)} | Past The Eye Test</title>`,
    `<meta name="description" content="${esc(desc)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="Past The Eye Test" />`,
    `<meta property="og:title" content="${esc(post.title)}" />`,
    `<meta property="og:description" content="${esc(desc)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    post.date && `<meta property="article:published_time" content="${esc(post.date)}" />`,
    img && `<meta property="og:image" content="${esc(img)}" />`,
    img && size && `<meta property="og:image:width" content="${size.w}" />`,
    img && size && `<meta property="og:image:height" content="${size.h}" />`,
    img && `<meta property="og:image:alt" content="${esc(imgAlt)}" />`,
    `<meta name="twitter:card" content="${img ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:site" content="@pasttheeyetest" />`,
    `<meta name="twitter:creator" content="@pasttheeyetest" />`,
    `<meta name="twitter:title" content="${esc(post.title)}" />`,
    `<meta name="twitter:description" content="${esc(desc)}" />`,
    img && `<meta name="twitter:image" content="${esc(img)}" />`,
    img && `<meta name="twitter:image:alt" content="${esc(imgAlt)}" />`,
  ].filter(Boolean).map(l => `  ${l}`).join("\n");
}

export function writeSocialPages({ root, outDir }) {
  const template = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
  const re = /<!-- social:start[\s\S]*?<!-- social:end -->/;
  if (!re.test(template)) throw new Error("socialPages: index.html has no <!-- social:start --> … <!-- social:end --> block");
  const postsDir = path.join(root, "src/content/posts");
  const publicDir = path.join(root, "public");
  let n = 0;
  for (const f of fs.readdirSync(postsDir)) {
    if (!f.endsWith(".md") || f.startsWith("_")) continue;
    const post = parsePost(fs.readFileSync(path.join(postsDir, f), "utf8"), f);
    if (post.draft) continue;
    const html = template.replace(re, () => `<!-- social: ${post.slug} -->\n${socialBlock(post, publicDir)}`);
    const dir = path.join(outDir, "posts", post.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), html);
    n++;
  }
  console.log(`[social] wrote ${n} post page${n === 1 ? "" : "s"} with X / Open Graph cards`);
}

// Vite plugin: runs after the production build.
export const socialPagesPlugin = () => {
  let cfg;
  return {
    name: "ptet-social-pages",
    apply: "build",
    configResolved(c) { cfg = c; },
    closeBundle() { writeSocialPages({ root: cfg.root, outDir: path.resolve(cfg.root, cfg.build.outDir) }); },
  };
};

// `vite preview`: serve /posts/<slug> from its card page, as vercel.json does in production.
export const socialPagesPreviewPlugin = () => {
  let cfg;
  return {
    name: "ptet-social-pages-preview",
    configResolved(c) { cfg = c; },
    configurePreviewServer(server) {
      const outDir = path.resolve(cfg.root, cfg.build.outDir);
      server.middlewares.use((req, _res, next) => {
        const m = /^\/posts\/([^/?#.]+)\/?(\?.*)?$/.exec(req.url || "");
        if (m && fs.existsSync(path.join(outDir, "posts", m[1], "index.html"))) req.url = `/posts/${m[1]}/index.html${m[2] || ""}`;
        next();
      });
    },
  };
};

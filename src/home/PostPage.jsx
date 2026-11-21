import { useEffect, useMemo, useState } from "react";
import { useTheme } from "../baseball/ThemeContext.jsx";
import { Link } from "../router.jsx";
import Prose, { SERIF, SANS } from "./Prose.jsx";
import { POSTS, postBySlug, renderMarkdown, formatDate, SITE_URL } from "./posts.js";

const MEASURE = 680;

export default function PostPage({ slug }) {
  const { theme: t } = useTheme();
  const post = postBySlug(slug);
  const html = useMemo(() => (post ? renderMarkdown(post.body) : ""), [post]);
  useEffect(() => {
    document.title = post ? `${post.title} | Past The Eye Test` : "Post not found | Past The Eye Test";
  }, [post]);

  const back = (
    <Link to="/" style={{ fontFamily: SANS, fontSize: 14, color: t.textMuted, textDecoration: "none" }}>← Articles and Updates</Link>
  );

  if (!post) {
    return (
      <div style={{ maxWidth: MEASURE, margin: "0 auto", padding: "40px 20px" }}>
        {back}
        <h1 style={{ fontFamily: SERIF, fontWeight: 600, fontSize: 34, color: t.text, margin: "28px 0 10px" }}>Post not found</h1>
        <p style={{ fontFamily: SERIF, fontSize: 19, color: t.textSecondary }}>It may have been renamed or taken down.</p>
      </div>
    );
  }

  // Newer / older neighbours, by date.
  const i = POSTS.indexOf(post);
  const newer = i > 0 ? POSTS[i - 1] : null;
  const older = i < POSTS.length - 1 ? POSTS[i + 1] : null;
  const meta = [post.type === "update" ? "Update" : "Article", formatDate(post.date, true),
                post.type === "article" ? `${post.minutes} min read` : null].filter(Boolean);

  return (
    <article style={{ maxWidth: MEASURE, margin: "0 auto", padding: "32px 20px 72px" }}>
      {back}
      <header style={{ margin: "36px 0 0", paddingBottom: 28, borderBottom: `1px solid ${t.divider}` }}>
        <h1 style={{ fontFamily: SERIF, fontWeight: 600, fontSize: "clamp(31px, 5vw, 42px)", lineHeight: 1.14,
                     letterSpacing: "-0.012em", color: t.text, fontVariantNumeric: "lining-nums" }}>
          {post.title}
        </h1>
        {post.summary && (
          <p style={{ fontFamily: SERIF, fontSize: 21, lineHeight: 1.45, color: t.textMuted, margin: "14px 0 0" }}>{post.summary}</p>
        )}
        <p style={{ fontFamily: SANS, fontSize: 14, color: t.textFaint, margin: "20px 0 0", letterSpacing: 0 }}>
          {meta.join("  ·  ")}
          {post.tags.length > 0 && <span style={{ color: t.textFaint }}>{"  ·  "}{post.tags.join(", ")}</span>}
        </p>
      </header>
      {post.cover && <img src={post.cover} alt="" style={{ width: "100%", display: "block", margin: "28px 0 0", borderRadius: 2 }} />}
      <div style={{ marginTop: 30 }}><Prose html={html} /></div>
      <ShareBar t={t} post={post} />
      <nav style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginTop: 56, paddingTop: 20, borderTop: `1px solid ${t.divider}` }}>
        <div>{older && <NavLink t={t} post={older} label="Previous" />}</div>
        <div style={{ textAlign: "right" }}>{newer && <NavLink t={t} post={newer} label="Next" />}</div>
      </nav>
    </article>
  );
}

// Share the post to X. The link X gets is the post's public URL; its page carries a
// large-image card (scripts/socialPages.js), so X shows the share picture and title,
// and hides the link itself when it's the last thing in the post.
function ShareBar({ t, post }) {
  const [copied, setCopied] = useState(false);
  const url = `${SITE_URL}/posts/${post.slug}`;
  const intent = `https://x.com/intent/post?text=${encodeURIComponent(post.title)}&url=${encodeURIComponent(url)}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch { window.prompt("Copy this link:", url); }
  };
  const btn = { fontFamily: SANS, fontSize: 14, fontWeight: 600, padding: "8px 14px", borderRadius: 8, cursor: "pointer",
                textDecoration: "none", border: `1px solid ${t.inputBorder}`, background: t.inputBg, color: t.text,
                display: "inline-flex", alignItems: "center", gap: 8 };
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 40 }}>
      <span style={{ fontFamily: SANS, fontSize: 14, color: t.textMuted, marginRight: 4 }}>Share</span>
      <a href={intent} target="_blank" rel="noopener noreferrer" style={btn}>
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
        Post on X
      </a>
      <button type="button" onClick={copy} style={btn}>{copied ? "Link copied" : "Copy link"}</button>
    </div>
  );
}

function NavLink({ t, post, label }) {
  return (
    <Link to={`/posts/${post.slug}`} style={{ textDecoration: "none", display: "inline-grid", gap: 4 }}>
      <span style={{ fontFamily: SANS, fontSize: 13, color: t.textFaint }}>{label}</span>
      <span style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 600, lineHeight: 1.3, color: t.text }}>{post.title}</span>
    </Link>
  );
}

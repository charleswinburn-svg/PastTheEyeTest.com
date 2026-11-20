import { useEffect, useMemo } from "react";
import { useTheme } from "../baseball/ThemeContext.jsx";
import SCALE from "../ui/colorScale.js";
import { Link } from "../router.jsx";
import Prose from "./Prose.jsx";
import { POSTS, postBySlug, renderMarkdown, formatDate } from "./posts.js";

const SERIF = "'Playfair Display', Georgia, serif";

export default function PostPage({ slug }) {
  const { theme: t, isDark } = useTheme();
  const post = postBySlug(slug);
  const html = useMemo(() => (post ? renderMarkdown(post.body) : ""), [post]);
  useEffect(() => {
    document.title = post ? `${post.title} · Past The Eye Test` : "Post not found · Past The Eye Test";
  }, [post]);

  const back = (
    <Link to="/" style={{ fontSize: 13, fontWeight: 700, color: t.accent, textDecoration: "none" }}>← All posts</Link>
  );

  if (!post) {
    return (
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "48px 16px" }}>
        {back}
        <h1 style={{ fontFamily: SERIF, fontSize: 34, color: t.text, margin: "18px 0 8px" }}>Post not found</h1>
        <p style={{ color: t.textMuted }}>It may have been renamed or taken down.</p>
      </div>
    );
  }

  // Newer / older neighbours, by date.
  const i = POSTS.indexOf(post);
  const newer = i > 0 ? POSTS[i - 1] : null;
  const older = i < POSTS.length - 1 ? POSTS[i + 1] : null;

  return (
    <article style={{ maxWidth: 720, margin: "0 auto", padding: "28px 16px 64px" }}>
      {back}
      <header style={{ margin: "22px 0 26px" }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: t.accent, marginBottom: 10 }}>
          {post.type === "update" ? "Update" : "Article"}
        </div>
        <h1 style={{ fontFamily: SERIF, fontSize: "clamp(30px, 5vw, 44px)", lineHeight: 1.12, color: t.text, letterSpacing: "-0.02em" }}>{post.title}</h1>
        {post.summary && <p style={{ fontSize: 18, lineHeight: 1.55, color: t.textSecondary, margin: "12px 0 0" }}>{post.summary}</p>}
        <div style={{ fontSize: 13, color: t.textFaint, margin: "14px 0 0", display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span>{formatDate(post.date)}</span>
          {post.type === "article" && <><span aria-hidden>·</span><span>{post.minutes} min read</span></>}
          {post.tags.length > 0 && <><span aria-hidden>·</span><span>{post.tags.join(", ")}</span></>}
        </div>
        <div style={{ height: 3, width: 120, borderRadius: 2, background: SCALE.gradient(isDark, 10), margin: "20px 0 0" }} />
      </header>
      {post.cover && <img src={post.cover} alt="" style={{ width: "100%", borderRadius: 12, margin: "0 0 26px", display: "block" }} />}
      <Prose html={html} />
      <nav style={{ display: "flex", justifyContent: "space-between", gap: 16, marginTop: 44, paddingTop: 18, borderTop: `1px solid ${t.divider}`, flexWrap: "wrap" }}>
        {older ? <NavLink t={t} post={older} label="← Older" /> : <span />}
        {newer ? <NavLink t={t} post={newer} label="Newer →" align="right" /> : <span />}
      </nav>
    </article>
  );
}

function NavLink({ t, post, label, align = "left" }) {
  return (
    <Link to={`/posts/${post.slug}`} style={{ textDecoration: "none", textAlign: align, maxWidth: 320, display: "grid", gap: 3 }}>
      <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: t.textFaint }}>{label}</span>
      <span style={{ fontSize: 15, fontWeight: 700, color: t.text, lineHeight: 1.35 }}>{post.title}</span>
    </Link>
  );
}

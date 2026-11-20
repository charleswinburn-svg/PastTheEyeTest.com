import { useEffect } from "react";
import { useTheme } from "../baseball/ThemeContext.jsx";
import { Link } from "../router.jsx";
import Prose, { SERIF, SANS } from "./Prose.jsx";
import { POSTS, renderMarkdown, formatDate } from "./posts.js";

// ═══════════════════════════════════════════════════════════
// HOME: "Articles and Updates"
// ═══════════════════════════════════════════════════════════
// An editorial index: serif headlines and decks, small sans dates, hairline rules.
// Articles on the left (newest first), updates in a narrower column on the right.

const CSS = `
.ptet-home-cols { display: grid; grid-template-columns: minmax(0, 1.75fr) minmax(0, 1fr); gap: 56px; align-items: start; }
.ptet-headline-link:hover .ptet-headline { text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 0.16em; }
@media (max-width: 900px) { .ptet-home-cols { grid-template-columns: minmax(0, 1fr); gap: 40px; } }
`;

function SectionTitle({ t, children }) {
  return (
    <h2 style={{ fontFamily: SANS, fontSize: 14, fontWeight: 600, color: t.text, letterSpacing: 0,
                 paddingBottom: 10, marginBottom: 4, borderBottom: `1px solid ${t.text}` }}>
      {children}
    </h2>
  );
}

function Dateline({ t, post }) {
  const bits = [formatDate(post.date, true), post.type === "article" ? `${post.minutes} min read` : null].filter(Boolean);
  return <div style={{ fontFamily: SANS, fontSize: 13, color: t.textFaint }}>{bits.join("  ·  ")}</div>;
}

function ArticleItem({ post, t, lead = false }) {
  return (
    <Link to={`/posts/${post.slug}`} className="ptet-headline-link"
          style={{ display: "block", textDecoration: "none", color: "inherit", padding: lead ? "18px 0 28px" : "20px 0",
                   borderBottom: `1px solid ${t.divider}` }}>
      {post.cover && (
        <img src={post.cover} alt="" style={{ width: "100%", aspectRatio: lead ? "16 / 8" : "16 / 9", objectFit: "cover",
                                              display: "block", marginBottom: 14, borderRadius: 2 }} />
      )}
      <h3 className="ptet-headline" style={{ fontFamily: SERIF, fontWeight: 600, fontSize: lead ? 32 : 23, lineHeight: 1.18,
                                             letterSpacing: "-0.01em", color: t.text }}>
        {post.title}
      </h3>
      {post.summary && (
        <p style={{ fontFamily: SERIF, fontSize: lead ? 19 : 17, lineHeight: 1.5, color: t.textMuted, margin: "8px 0 10px" }}>
          {post.summary}
        </p>
      )}
      <Dateline t={t} post={post} />
    </Link>
  );
}

function UpdateItem({ post, t }) {
  return (
    <div style={{ padding: "18px 0", borderBottom: `1px solid ${t.divider}` }}>
      <Dateline t={t} post={post} />
      <Link to={`/posts/${post.slug}`} className="ptet-headline-link" style={{ textDecoration: "none", display: "block", margin: "6px 0 8px" }}>
        <span className="ptet-headline" style={{ fontFamily: SERIF, fontWeight: 600, fontSize: 19, lineHeight: 1.3, color: t.text }}>{post.title}</span>
      </Link>
      <Prose html={renderMarkdown(post.body)} compact />
    </div>
  );
}

export default function HomePage() {
  const { theme: t } = useTheme();
  useEffect(() => { document.title = "Articles and Updates | Past The Eye Test"; }, []);

  const pinned = POSTS.find(p => p.pinned) || null;
  const articles = POSTS.filter(p => p.type === "article" && p !== pinned);
  const updates = POSTS.filter(p => p.type === "update" && p !== pinned);
  // The pinned post, or else the newest article, leads the page.
  const lead = pinned || articles[0] || null;
  const rest = articles.filter(p => p !== lead);

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "40px 20px 72px" }}>
      <style>{CSS}</style>

      <h1 style={{ fontFamily: SERIF, fontWeight: 600, fontSize: "clamp(30px, 4.5vw, 40px)", lineHeight: 1.1,
                   letterSpacing: "-0.015em", color: t.text, margin: "0 0 32px" }}>
        Articles and Updates
      </h1>

      <div className="ptet-home-cols">
        <section>
          <SectionTitle t={t}>Articles</SectionTitle>
          {lead && lead.type === "update" ? <UpdateItem post={lead} t={t} /> : lead ? <ArticleItem post={lead} t={t} lead /> : null}
          {rest.map(p => <ArticleItem key={p.slug} post={p} t={t} />)}
          {!lead && (
            <p style={{ fontFamily: SERIF, fontSize: 17, color: t.textMuted, padding: "20px 0" }}>No articles yet.</p>
          )}
        </section>
        <aside>
          <SectionTitle t={t}>Updates</SectionTitle>
          {updates.length
            ? updates.map(p => <UpdateItem key={p.slug} post={p} t={t} />)
            : <p style={{ fontFamily: SERIF, fontSize: 17, color: t.textMuted, padding: "20px 0" }}>No updates yet.</p>}
        </aside>
      </div>
    </div>
  );
}

import { useEffect } from "react";
import { useTheme } from "../baseball/ThemeContext.jsx";
import { Link } from "../router.jsx";
import { SERIF, SANS } from "./Prose.jsx";
import { POSTS, formatDate } from "./posts.js";

// ═══════════════════════════════════════════════════════════
// HOME: "Articles and Updates"
// ═══════════════════════════════════════════════════════════
// An editorial index: serif headlines and decks, small sans dates, hairline rules.
// Articles on the left (newest first), updates on the right: two equal columns, and every
// post shown as the same preview card (its 1200×630 share picture, the one X shows).

const CSS = `
.ptet-home-cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 48px; align-items: start; }
.ptet-headline-link:hover .ptet-headline { text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 0.16em; }
.ptet-preview-card img { transition: transform 0.2s ease, box-shadow 0.2s ease; }
.ptet-preview-card:hover img { transform: translateY(-2px); }
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

// One preview card for articles and updates alike: date, title, the share picture at
// 1200×630, the opening lines (clamped), and a prompt. The whole card opens the post.
function PreviewCard({ post, t }) {
  return (
    <Link to={`/posts/${post.slug}`} className="ptet-headline-link ptet-preview-card"
          style={{ display: "block", textDecoration: "none", color: "inherit", padding: "18px 0 22px", borderBottom: `1px solid ${t.divider}` }}>
      <Dateline t={t} post={post} />
      <div className="ptet-headline" style={{ fontFamily: SERIF, fontWeight: 600, fontSize: 23, lineHeight: 1.22, letterSpacing: "-0.01em",
                                              color: t.text, margin: "6px 0 12px" }}>
        {post.title}
      </div>
      {post.shareImage && (
        <img src={post.shareImage} alt="" loading="lazy"
             style={{ display: "block", width: "100%", aspectRatio: "1200 / 630", objectFit: "cover",
                      borderRadius: 4, marginBottom: 12, boxShadow: "0 2px 12px rgba(0,0,0,0.2)" }} />
      )}
      {(post.summary || post.excerpt) && (
        <p style={{ fontFamily: SERIF, fontSize: 16, lineHeight: 1.55, color: t.textSecondary, margin: 0,
                    display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {post.summary || post.excerpt}
        </p>
      )}
      <div style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: t.accent, marginTop: 10 }}>
        {post.type === "update" ? "Read the full update →" : "Read the full article →"}
      </div>
    </Link>
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
          {lead && <PreviewCard post={lead} t={t} />}
          {rest.map(p => <PreviewCard key={p.slug} post={p} t={t} />)}
          {!lead && (
            <p style={{ fontFamily: SERIF, fontSize: 17, color: t.textMuted, padding: "20px 0" }}>No articles yet.</p>
          )}
        </section>
        <aside>
          <SectionTitle t={t}>Updates</SectionTitle>
          {updates.length
            ? updates.map(p => <PreviewCard key={p.slug} post={p} t={t} />)
            : <p style={{ fontFamily: SERIF, fontSize: 17, color: t.textMuted, padding: "20px 0" }}>No updates yet.</p>}
        </aside>
      </div>
    </div>
  );
}

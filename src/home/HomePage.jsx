import { useEffect } from "react";
import { useTheme } from "../baseball/ThemeContext.jsx";
import SCALE from "../ui/colorScale.js";
import { Link } from "../router.jsx";
import Prose from "./Prose.jsx";
import { POSTS, renderMarkdown, formatDate } from "./posts.js";

// ═══════════════════════════════════════════════════════════
// HOME: "Articles and Updates": pinned post, articles grid + updates feed
// ═══════════════════════════════════════════════════════════

const SERIF = "'Playfair Display', Georgia, serif";

const CSS = `
.ptet-home-cols { display: grid; grid-template-columns: minmax(0, 1.9fr) minmax(0, 1fr); gap: 28px; align-items: start; }
.ptet-home-articles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.ptet-card-link { transition: transform 0.15s ease, border-color 0.15s ease; }
.ptet-card-link:hover { transform: translateY(-2px); }
@media (max-width: 900px) { .ptet-home-cols { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 620px) { .ptet-home-articles { grid-template-columns: minmax(0, 1fr); } }
`;

function SectionTitle({ t, children, right }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, margin: "0 0 12px" }}>
      <h2 style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: t.textMuted }}>{children}</h2>
      {right}
    </div>
  );
}

function Meta({ t, post }) {
  return (
    <div style={{ fontSize: 12, color: t.textFaint, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <span>{formatDate(post.date)}</span>
      {post.type === "article" && <><span aria-hidden>·</span><span>{post.minutes} min read</span></>}
      {post.tags.slice(0, 3).map(tag => (
        <span key={tag} style={{ padding: "1px 7px", borderRadius: 999, border: `1px solid ${t.inputBorder}`, color: t.textMuted, fontSize: 11 }}>{tag}</span>
      ))}
    </div>
  );
}

function Cover({ post, isDark, height }) {
  if (post.cover) {
    return <img src={post.cover} alt="" style={{ width: "100%", height, objectFit: "cover", display: "block" }} />;
  }
  // No cover: a band of the site's scale, offset per post so cards don't all match.
  const shift = [...post.slug].reduce((a, c) => a + c.charCodeAt(0), 0) % 60;
  return <div style={{ height: Math.round(height / 3), background: SCALE.gradient(isDark, 10), backgroundSize: "200% 100%", backgroundPosition: `${shift}% 0` }} />;
}

function ArticleCard({ post, t, isDark, big = false }) {
  return (
    <Link to={`/posts/${post.slug}`} className="ptet-card-link" style={{
      display: "block", textDecoration: "none", color: "inherit", background: t.cardBg, border: `1px solid ${t.cardBorder}`,
      borderRadius: 14, overflow: "hidden", boxShadow: `0 4px 18px ${t.shadow}`,
    }}>
      <Cover post={post} isDark={isDark} height={big ? 240 : 150} />
      <div style={{ padding: big ? "18px 20px 20px" : "14px 16px 16px", display: "grid", gap: 8 }}>
        {big && <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: t.accent }}>Pinned</span>}
        <h3 style={{ fontFamily: SERIF, fontSize: big ? 28 : 20, lineHeight: 1.2, color: t.text, letterSpacing: "-0.01em" }}>{post.title}</h3>
        {post.summary && <p style={{ fontSize: big ? 15 : 13.5, lineHeight: 1.55, color: t.textSecondary }}>{post.summary}</p>}
        <Meta t={t} post={post} />
      </div>
    </Link>
  );
}

function UpdateItem({ post, t, last }) {
  return (
    <div style={{ position: "relative", paddingLeft: 20, paddingBottom: last ? 0 : 22 }}>
      <div style={{ position: "absolute", left: 4, top: 6, bottom: last ? "auto" : -6, width: 2, height: last ? 0 : undefined, background: t.divider }} />
      <div style={{ position: "absolute", left: 0, top: 4, width: 10, height: 10, borderRadius: 3, background: t.accent, boxShadow: `0 0 0 3px ${t.bg}` }} />
      <div style={{ fontSize: 11.5, color: t.textFaint, marginBottom: 3 }}>{formatDate(post.date)}</div>
      <Link to={`/posts/${post.slug}`} style={{ fontSize: 15, fontWeight: 700, color: t.text, textDecoration: "none", lineHeight: 1.35, display: "block", marginBottom: 6 }}>
        {post.title}
      </Link>
      <Prose html={renderMarkdown(post.body)} compact />
    </div>
  );
}

export default function HomePage() {
  const { theme: t, isDark } = useTheme();
  useEffect(() => { document.title = "Articles and Updates · Past The Eye Test"; }, []);

  const pinned = POSTS.find(p => p.pinned) || null;
  const articles = POSTS.filter(p => p.type === "article" && p !== pinned);
  const updates = POSTS.filter(p => p.type === "update" && p !== pinned);

  return (
    <div style={{ maxWidth: 1120, margin: "0 auto", padding: "28px 16px 56px" }}>
      <style>{CSS}</style>

      <h1 style={{ fontSize: 26, fontWeight: 800, color: t.text, letterSpacing: "-0.02em", margin: "4px 0 24px" }}>
        Articles and Updates
      </h1>

      {pinned && (
        <section style={{ marginBottom: 32 }}>
          {pinned.type === "article"
            ? <ArticleCard post={pinned} t={t} isDark={isDark} big />
            : (
              <div style={{ background: t.cardBg, border: `1px solid ${t.cardBorder}`, borderRadius: 14, padding: "18px 20px" }}>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: t.accent }}>Pinned update</span>
                <div style={{ marginTop: 10 }}><UpdateItem post={pinned} t={t} last /></div>
              </div>
            )}
        </section>
      )}

      <div className="ptet-home-cols">
        <section>
          <SectionTitle t={t}>Articles</SectionTitle>
          {articles.length ? (
            <div className="ptet-home-articles">
              {articles.map(p => <ArticleCard key={p.slug} post={p} t={t} isDark={isDark} />)}
            </div>
          ) : (
            <div style={{ padding: "22px 18px", borderRadius: 12, border: `1px dashed ${t.inputBorder}`, color: t.textMuted, fontSize: 14 }}>
              No articles yet. The first one is on its way.
            </div>
          )}
        </section>
        <aside>
          <SectionTitle t={t}>Updates</SectionTitle>
          {updates.length ? (
            <div style={{ background: t.cardBg, border: `1px solid ${t.cardBorder}`, borderRadius: 14, padding: "18px 18px 18px 16px" }}>
              {updates.map((p, i) => <UpdateItem key={p.slug} post={p} t={t} last={i === updates.length - 1} />)}
            </div>
          ) : (
            <div style={{ color: t.textMuted, fontSize: 14 }}>No updates yet.</div>
          )}
        </aside>
      </div>
    </div>
  );
}

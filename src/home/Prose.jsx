import { useEffect, useState } from "react";
import { useTheme } from "../baseball/ThemeContext.jsx";

// ═══════════════════════════════════════════════════════════
// Article typography: rendered-markdown styles for posts
// ═══════════════════════════════════════════════════════════
// Set like a publication, not an app: one text serif (Source Serif 4, optical sizes)
// for body and headings, a readable measure and leading, quiet links and rules, and
// tables in the UI sans with lining, tabular figures so stats line up.

export const SERIF = "'Source Serif 4', 'Source Serif Pro', Georgia, 'Times New Roman', serif";
export const SANS = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

const CSS = `
.ptet-prose {
  font-family: ${SERIF}; font-optical-sizing: auto; font-size: 19px; line-height: 1.65;
  letter-spacing: 0; color: var(--p-body); font-kerning: normal; font-variant-ligatures: common-ligatures;
  font-variant-numeric: oldstyle-nums proportional-nums; overflow-wrap: break-word; hyphens: manual;
}
.ptet-prose.compact { font-size: 16px; line-height: 1.6; }
.ptet-prose > :first-child { margin-top: 0; }
.ptet-prose > :last-child { margin-bottom: 0; }
.ptet-prose p { margin: 0 0 1.15em; }
.ptet-prose h2, .ptet-prose h3 {
  font-family: ${SERIF}; color: var(--p-head); font-weight: 600; letter-spacing: -0.005em;
  font-variant-numeric: lining-nums;
}
.ptet-prose h1 { font-family: ${SERIF}; font-weight: 600; font-size: 1.5em; line-height: 1.2; margin: 1.8em 0 0.5em; color: var(--p-head); }
.ptet-prose h2 { font-size: 1.32em; line-height: 1.25; margin: 1.9em 0 0.55em; }
.ptet-prose h3 { font-size: 1.1em; line-height: 1.3; margin: 1.6em 0 0.45em; }
.ptet-prose h4 { font-family: ${SANS}; font-size: 0.78em; font-weight: 600; letter-spacing: 0.02em; color: var(--p-muted); margin: 1.6em 0 0.4em; }
.ptet-prose.compact h1, .ptet-prose.compact h2, .ptet-prose.compact h3 { font-size: 1.05em; margin: 1.1em 0 0.35em; }
.ptet-prose a { color: inherit; text-decoration: underline; text-decoration-color: var(--p-link); text-decoration-thickness: 1px; text-underline-offset: 0.18em; }
.ptet-prose a:hover { text-decoration-thickness: 2px; }
.ptet-prose strong { font-weight: 600; color: var(--p-head); }
.ptet-prose em { font-style: italic; }
.ptet-prose ul, .ptet-prose ol { padding-left: 1.25em; margin: 0 0 1.15em; }
.ptet-prose li { margin: 0.35em 0; padding-left: 0.15em; }
.ptet-prose li::marker { color: var(--p-muted); }
.ptet-prose blockquote { margin: 1.5em 0; padding: 0 0 0 1.1em; border-left: 2px solid var(--p-rule); color: var(--p-muted); font-style: italic; }
.ptet-prose img { display: block; max-width: 100%; height: auto; margin: 1.6em auto; border-radius: 2px; }
/* Figures: image + small caption underneath (write <figure><img …><figcaption>…</figcaption></figure>). */
.ptet-prose figure { margin: 1.4em 0 1.7em; text-align: center; }
.ptet-prose figure img { margin: 0 auto; border-radius: 4px; box-shadow: 0 2px 14px rgba(0,0,0,0.22); }
.ptet-prose figcaption { font-family: ${SANS}; font-size: 12.5px; line-height: 1.45; color: var(--p-muted); margin: 0.75em auto 0; max-width: 34em; }
.ptet-prose.compact figure { margin: 1em 0 1.3em; }
.ptet-prose.compact figcaption { font-size: 11.5px; margin-top: 0.55em; }
.ptet-prose ul + figure, .ptet-prose ol + figure { margin-top: 1.1em; }
.ptet-prose li > p { margin: 0 0 0.6em; }
.ptet-prose code { font-family: 'DM Mono', ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82em; background: var(--p-code); padding: 0.1em 0.3em; border-radius: 3px; }
.ptet-prose pre { background: var(--p-code); padding: 14px 16px; border-radius: 4px; overflow-x: auto; margin: 0 0 1.3em; line-height: 1.5; }
.ptet-prose pre code { background: none; padding: 0; font-size: 0.8em; }
.ptet-prose table {
  font-family: ${SANS}; font-size: 14px; line-height: 1.4; font-variant-numeric: lining-nums tabular-nums;
  border-collapse: collapse; display: block; overflow-x: auto; max-width: 100%; margin: 1.4em 0 1.6em;
}
.ptet-prose thead th { font-weight: 600; color: var(--p-head); border-bottom: 1px solid var(--p-head); }
.ptet-prose th, .ptet-prose td { padding: 7px 14px 7px 0; text-align: left; white-space: nowrap; border-bottom: 1px solid var(--p-rule); }
.ptet-prose th[align="right"], .ptet-prose td[align="right"] { text-align: right; padding: 7px 0 7px 18px; }
.ptet-prose th[align="center"], .ptet-prose td[align="center"] { text-align: center; }
.ptet-prose td { color: var(--p-body); }
.ptet-prose hr { border: none; border-top: 1px solid var(--p-rule); margin: 2.2em 0; }
.ptet-prose img { cursor: zoom-in; }
.ptet-lightbox { position: fixed; inset: 0; z-index: 1000; background: rgba(5, 8, 15, 0.92); display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 14px; padding: 24px; cursor: zoom-out; animation: ptet-lb-in 0.15s ease; }
.ptet-lightbox img { max-width: 96vw; max-height: calc(100vh - 110px); object-fit: contain; border-radius: 4px;
  box-shadow: 0 10px 60px rgba(0,0,0,0.6); }
.ptet-lightbox figcaption { font-family: ${SANS}; font-size: 13.5px; line-height: 1.45; color: rgba(255,255,255,0.78);
  text-align: center; max-width: 60em; }
.ptet-lightbox-close { position: absolute; top: 14px; right: 16px; width: 40px; height: 40px; border-radius: 50%; border: none;
  background: rgba(255,255,255,0.12); color: #fff; font-size: 22px; line-height: 40px; cursor: pointer; }
.ptet-lightbox-close:hover { background: rgba(255,255,255,0.22); }
@keyframes ptet-lb-in { from { opacity: 0; } to { opacity: 1; } }
`;

export default function Prose({ html, compact = false }) {
  const { theme: t } = useTheme();
  const [zoom, setZoom] = useState(null);   // { src, alt, caption } while an image is enlarged
  const vars = {
    "--p-head": t.text, "--p-body": t.textSecondary, "--p-muted": t.textMuted,
    "--p-link": t.textFaint, "--p-rule": t.divider, "--p-code": t.inputBg,
  };

  // Click an image in the post → show it full screen (with its caption). Esc, a click
  // anywhere or the × closes it; the page behind doesn't scroll while it's open.
  const onClick = e => {
    const img = e.target.closest?.("img");
    if (!img || !e.currentTarget.contains(img)) return;
    const caption = img.closest("figure")?.querySelector("figcaption")?.textContent || "";
    setZoom({ src: img.currentSrc || img.src, alt: img.alt || "", caption });
  };
  useEffect(() => {
    if (!zoom) return;
    const onKey = e => { if (e.key === "Escape") setZoom(null); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [zoom]);

  return (
    <>
      <style>{CSS}</style>
      <div className={`ptet-prose${compact ? " compact" : ""}`} style={vars} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      {zoom && (
        <div className="ptet-lightbox" role="dialog" aria-modal="true" aria-label={zoom.alt || "Image"} onClick={() => setZoom(null)}>
          <button type="button" className="ptet-lightbox-close" aria-label="Close" onClick={() => setZoom(null)}>×</button>
          <img src={zoom.src} alt={zoom.alt} />
          {zoom.caption && <figcaption>{zoom.caption}</figcaption>}
        </div>
      )}
    </>
  );
}

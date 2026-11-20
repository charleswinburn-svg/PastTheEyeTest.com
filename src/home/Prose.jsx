import { useTheme } from "../baseball/ThemeContext.jsx";
import SCALE from "../ui/colorScale.js";

// Rendered-markdown styles for posts, driven by the theme tokens.
const CSS = `
.ptet-prose { font-size: 16.5px; line-height: 1.72; color: var(--p-text2); overflow-wrap: anywhere; }
.ptet-prose.compact { font-size: 14.5px; line-height: 1.6; }
.ptet-prose > :first-child { margin-top: 0; }
.ptet-prose > :last-child { margin-bottom: 0; }
.ptet-prose h1, .ptet-prose h2, .ptet-prose h3, .ptet-prose h4 {
  font-family: 'Playfair Display', Georgia, serif; color: var(--p-text); line-height: 1.25; margin: 1.6em 0 0.5em; letter-spacing: -0.01em; }
.ptet-prose h1 { font-size: 1.9em; } .ptet-prose h2 { font-size: 1.5em; } .ptet-prose h3 { font-size: 1.22em; }
.ptet-prose h4 { font-family: inherit; font-size: 1em; text-transform: uppercase; letter-spacing: 0.06em; }
.ptet-prose.compact h1, .ptet-prose.compact h2, .ptet-prose.compact h3 { font-size: 1.1em; margin: 1em 0 0.4em; }
.ptet-prose p { margin: 0 0 1.05em; }
.ptet-prose a { color: var(--p-accent); text-decoration: underline; text-underline-offset: 2px; }
.ptet-prose strong { color: var(--p-text); }
.ptet-prose ul, .ptet-prose ol { padding-left: 1.3em; margin: 0 0 1.05em; }
.ptet-prose li { margin: 0.3em 0; }
.ptet-prose blockquote { border-left: 3px solid var(--p-accent); padding: 0.2em 0 0.2em 1em; color: var(--p-muted); margin: 1.2em 0; }
.ptet-prose img { max-width: 100%; height: auto; border-radius: 10px; display: block; margin: 1.3em auto; }
.ptet-prose code { font-family: 'DM Mono', ui-monospace, monospace; font-size: 0.86em; background: var(--p-input); padding: 0.12em 0.36em; border-radius: 4px; }
.ptet-prose pre { background: var(--p-input); padding: 14px 16px; border-radius: 10px; overflow-x: auto; margin: 0 0 1.2em; }
.ptet-prose pre code { background: none; padding: 0; }
.ptet-prose table { border-collapse: collapse; display: block; overflow-x: auto; max-width: 100%; font-size: 0.92em; margin: 0 0 1.2em; }
.ptet-prose th, .ptet-prose td { border-bottom: 1px solid var(--p-divider); padding: 6px 12px; text-align: left; white-space: nowrap; }
.ptet-prose th { color: var(--p-text); font-weight: 700; }
.ptet-prose hr { border: none; height: 3px; background: var(--p-grad); border-radius: 2px; margin: 2em 0; }
`;

export default function Prose({ html, compact = false }) {
  const { theme: t, isDark } = useTheme();
  const vars = {
    "--p-text": t.text, "--p-text2": t.textSecondary, "--p-muted": t.textMuted, "--p-accent": t.accent,
    "--p-input": t.inputBg, "--p-divider": t.divider, "--p-grad": SCALE.gradient(isDark, 12),
  };
  return (
    <>
      <style>{CSS}</style>
      <div className={`ptet-prose${compact ? " compact" : ""}`} style={vars} dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}

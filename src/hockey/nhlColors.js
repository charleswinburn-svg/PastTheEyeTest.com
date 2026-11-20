// Colours for the NHL tab. Everything comes from the site-wide scale in
// src/ui/colorScale.js: ice = below average, grey = average, fire = above.

import { pctRgb, pctHex, inkOn as scaleInkOn } from "../ui/colorScale.js";

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

// Smooth scale for a 0-100 percentile (the low end is lifted on dark cards).
export const spectrumRgb = (pct, isDark = true) => pctRgb(pct, isDark);
export const spectrum = (pct, isDark) => `rgb(${spectrumRgb(pct, isDark).join(",")})`;

// Black or white text, whichever reads better on a fill.
export const inkOn = scaleInkOn;

export const POSITIVE = pctHex(88, true);    // adds value
export const NEGATIVE = pctHex(15, false);   // costs value

// Impact-by-season tier bands, best tier first: bold -> neutral -> bold.
// Four for forwards (the four lines), three for defensemen (pairs) and goalies (roles).
// Skaters below the last line or pair ("Depth") sit on the plain card below the bands.
export const TIERS = {
  F: ["1st line", "2nd line", "3rd line", "4th line", "Depth"],
  D: ["1st pair", "2nd pair", "3rd pair", "Depth"],
  G: ["Starter (1)", "1B", "Backup"],
};
const TOP = pctHex(92, false), HIGH = pctHex(68, false), MID = pctHex(50, false), LOW = pctHex(32, false), BOTTOM = pctHex(12, false);
export const TIER_COLORS = {
  F: { "1st line": TOP, "2nd line": HIGH, "3rd line": LOW, "4th line": BOTTOM },
  D: { "1st pair": TOP, "2nd pair": MID, "3rd pair": BOTTOM },
  G: { "Starter (1)": TOP, "1B": MID, "Backup": BOTTOM },
};

export function luminance(hexColor) {
  return hex(hexColor).reduce((sum, c, i) => {
    const v = c / 255;
    return sum + (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)) * [0.2126, 0.7152, 0.0722][i];
  }, 0);
}

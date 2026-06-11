// Country flag helpers — maps bzzoiro team names to flagcdn.com codes.
// flagcdn uses ISO 3166-1 alpha-2, plus gb-eng style for UK home nations.

const NAME_TO_CODE = {
  // CONCACAF
  "mexico": "mx", "canada": "ca", "usa": "us", "united states": "us",
  "costa rica": "cr", "panama": "pa", "jamaica": "jm", "honduras": "hn",
  "el salvador": "sv", "guatemala": "gt", "haiti": "ht",
  "trinidad and tobago": "tt", "curacao": "cw", "suriname": "sr",
  // UEFA
  "england": "gb-eng", "scotland": "gb-sct", "wales": "gb-wls", "northern ireland": "gb-nir",
  "france": "fr", "germany": "de", "spain": "es", "portugal": "pt", "italy": "it",
  "netherlands": "nl", "belgium": "be", "croatia": "hr", "switzerland": "ch",
  "austria": "at", "denmark": "dk", "norway": "no", "sweden": "se", "poland": "pl",
  "czechia": "cz", "czech republic": "cz", "turkiye": "tr", "turkey": "tr",
  "serbia": "rs", "ukraine": "ua", "hungary": "hu", "romania": "ro",
  "slovakia": "sk", "slovenia": "si", "bosnia and herzegovina": "ba",
  "albania": "al", "north macedonia": "mk", "greece": "gr",
  "ireland": "ie", "republic of ireland": "ie", "iceland": "is", "finland": "fi",
  "georgia": "ge", "montenegro": "me", "israel": "il", "russia": "ru",
  // CONMEBOL
  "brazil": "br", "argentina": "ar", "uruguay": "uy", "colombia": "co",
  "ecuador": "ec", "paraguay": "py", "peru": "pe", "chile": "cl",
  "venezuela": "ve", "bolivia": "bo",
  // CAF
  "morocco": "ma", "senegal": "sn", "tunisia": "tn", "algeria": "dz",
  "egypt": "eg", "nigeria": "ng", "ghana": "gh", "cameroon": "cm",
  "ivory coast": "ci", "cote divoire": "ci", "south africa": "za",
  "mali": "ml", "burkina faso": "bf", "dr congo": "cd", "congo dr": "cd",
  "cape verde": "cv", "cabo verde": "cv", "zambia": "zm", "gabon": "ga",
  // AFC
  "japan": "jp", "south korea": "kr", "korea republic": "kr",
  "saudi arabia": "sa", "iran": "ir", "ir iran": "ir", "qatar": "qa",
  "australia": "au", "uzbekistan": "uz", "jordan": "jo", "iraq": "iq",
  "united arab emirates": "ae", "uae": "ae", "china": "cn", "china pr": "cn",
  "indonesia": "id", "oman": "om", "bahrain": "bh", "kuwait": "kw",
  "palestine": "ps", "kyrgyzstan": "kg", "north korea": "kp", "korea dpr": "kp",
  // OFC
  "new zealand": "nz", "new caledonia": "nc", "fiji": "fj",
};

const normName = s =>
  (s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/&/g, "and")
    .replace(/\s+/g, " ")
    .trim();

// Accepts a team object ({name, country_code, ...}) or a plain name string
export function flagCode(teamLike) {
  if (!teamLike) return null;
  const t = typeof teamLike === "string" ? { name: teamLike } : teamLike;
  const direct = t.country_code ?? t.alpha2 ?? t.cc;
  if (direct && /^[a-z]{2}(-[a-z]{3})?$/i.test(direct)) return direct.toLowerCase();
  return NAME_TO_CODE[normName(t.name ?? t.team ?? "")] ?? null;
}

export function Flag({ team, size = 20 }) {
  const code = flagCode(team);
  if (!code) return <span style={{ width: size, height: Math.round(size * 0.66), display: "inline-block", flexShrink: 0 }} />;
  return (
    <img
      src={`/flag-assets/w80/${code}.png`}
      alt={code}
      style={{
        width: size, height: Math.round(size * 0.66),
        objectFit: "cover", flexShrink: 0,
        borderRadius: 2, boxShadow: "0 0 0 1px rgba(255,255,255,0.12)",
      }}
      onError={e => { e.target.style.visibility = "hidden"; }}
    />
  );
}

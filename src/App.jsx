import { useState } from "react";
import HockeyApp from "./hockey/HockeyApp.jsx";
import BaseballApp from "./baseball/BaseballApp.jsx";

const SPORTS = [
  { id: "hockey",  label: "NHL",           icon: "🏒" },
  { id: "baseball", label: "MLB",          icon: "⚾" },
];

export default function App() {
  const [sport, setSport] = useState("hockey");

  return (
    <div style={{ minHeight: "100vh", background: "#0d0d0d" }}>
      {/* ── Sport Selector Bar ── */}
      <div style={{
        background: "#080808",
        borderBottom: "1px solid #1a1a1a",
        padding: "0 16px",
        display: "flex",
        alignItems: "stretch",
        gap: 0,
        position: "sticky",
        top: 0,
        zIndex: 100,
      }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "10px 16px 10px 4px",
          marginRight: 8,
          borderRight: "1px solid #1a1a1a",
        }}>
          <span style={{
            fontSize: 13,
            fontWeight: 800,
            color: "#fff",
            letterSpacing: "-0.03em",
          }}>
            <span style={{ color: "#888" }}>Past</span>TheEyeTest
          </span>
        </div>
        {SPORTS.map(s => (
          <button
            key={s.id}
            onClick={() => setSport(s.id)}
            style={{
              padding: "10px 18px",
              fontSize: 12,
              fontWeight: sport === s.id ? 700 : 500,
              letterSpacing: "0.02em",
              color: sport === s.id ? "#fff" : "#666",
              background: "transparent",
              border: "none",
              borderBottom: sport === s.id ? "2px solid #d22d49" : "2px solid transparent",
              cursor: "pointer",
              transition: "all 0.15s",
              fontFamily: "inherit",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span style={{ fontSize: 14 }}>{s.icon}</span>
            {s.label}
          </button>
        ))}
      </div>

      {/* ── Sport Content ── */}
      {sport === "hockey" && <HockeyApp />}
      {sport === "baseball" && <BaseballApp />}
    </div>
  );
}

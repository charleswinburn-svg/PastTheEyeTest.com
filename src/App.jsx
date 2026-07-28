import { useState } from "react";
import HockeyApp from "./hockey/HockeyApp.jsx";
import BaseballApp from "./baseball/BaseballApp.jsx";
import SoccerApp from "./soccer/SoccerApp.jsx";

const SPORTS = [
  { id: "hockey",  label: "NHL",           icon: "🏒" },
  { id: "baseball", label: "MLB",          icon: "⚾" },
  { id: "soccer",  label: "World Cup",     icon: "⚽" },
];

export default function App() {
  const [sport, setSport] = useState("hockey");

  return (
    <div style={{ minHeight: "100vh", background: "#0a0f1a" }}>
      {/* ── Sport Selector Bar ── */}
      {/* flexWrap so the logo + all sport buttons stay fully visible on narrow
          screens (they wrap to a second row instead of clipping off the right). */}
      <div style={{
        background: "#0f172a",
        borderBottom: "2px solid #f59e0b",
        padding: "0 16px",
        display: "flex",
        alignItems: "stretch",
        flexWrap: "wrap",
        gap: 0,
        position: "sticky",
        top: 0,
        zIndex: 100,
        boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
      }}>
        {/* Logo — left-anchored */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 20px 10px 4px",
          marginRight: 8,
          borderRight: "1px solid #1e3a5f",
          flexShrink: 0,
        }}>
          <img
            src="/logo.jpg"
            alt="Past The Eye Test"
            style={{
              height: 32,
              width: 32,
              borderRadius: 6,
              objectFit: "cover",
            }}
          />
          <span style={{
            fontSize: 14,
            fontWeight: 700,
            color: "#f8fafc",
            letterSpacing: "-0.02em",
            fontStyle: "italic",
          }}>
            <span style={{ color: "#3b82f6" }}>Past The</span>{" "}
            <span style={{ color: "#f59e0b" }}>Eye Test</span>
          </span>
        </div>
        {/* Sport buttons — left-aligned next to logo */}
        <div style={{ display: "flex", alignItems: "stretch", flexWrap: "wrap" }}>
          {SPORTS.map(s => (
            <button
              key={s.id}
              onClick={() => setSport(s.id)}
              style={{
                padding: "12px 20px",
                fontSize: 12,
                fontWeight: sport === s.id ? 700 : 600,
                letterSpacing: "0.04em",
                color: sport === s.id ? "#f59e0b" : "#94a3b8",
                background: sport === s.id ? "rgba(245,158,11,0.1)" : "transparent",
                border: "none",
                borderBottom: sport === s.id ? "3px solid #f59e0b" : "3px solid transparent",
                cursor: "pointer",
                transition: "all 0.2s",
                fontFamily: "inherit",
                display: "flex",
                alignItems: "center",
                gap: 8,
                whiteSpace: "nowrap",
              }}
            >
              <span style={{ fontSize: 14 }}>{s.icon}</span>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Sport Content ── */}
      {sport === "hockey" && <HockeyApp />}
      {sport === "baseball" && <BaseballApp />}
      {sport === "soccer" && <SoccerApp />}
    </div>
  );
}

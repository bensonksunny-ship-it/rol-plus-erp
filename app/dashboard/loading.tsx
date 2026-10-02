// Shown in the content area the moment a dashboard page is opened, until that
// page is ready — so a sidebar click always responds visibly (the sidebar itself
// stays in place; see the progress bar / spinner in app/dashboard/layout.tsx).

const bar = (w: string, h = 12, mb = 10): React.CSSProperties => ({
  width: w, height: h, marginBottom: mb, borderRadius: 6, background: "var(--color-surface-2)",
});

export default function DashboardLoading() {
  return (
    <div role="status" aria-label="Loading page" className="rl-skel" style={{ maxWidth: 1100, margin: "0 auto", padding: "4px 0" }}>
      <style>{`
        .rl-skel > * { animation: rl-skel-pulse 1.2s ease-in-out infinite; }
        @keyframes rl-skel-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
        @media (prefers-reduced-motion: reduce) { .rl-skel > * { animation: none; } }
      `}</style>
      <div style={bar("220px", 22, 8)} />
      <div style={bar("340px", 12, 22)} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12, marginBottom: 20 }}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} style={{ height: 78, borderRadius: 12, background: "var(--color-surface)", border: "1px solid var(--color-border)" }} />
        ))}
      </div>
      <div style={{ borderRadius: 12, background: "var(--color-surface)", border: "1px solid var(--color-border)", padding: 16 }}>
        {[0, 1, 2, 3, 4, 5].map(i => <div key={i} style={bar(i % 2 ? "70%" : "90%", 12, 14)} />)}
      </div>
      <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Loading…</span>
    </div>
  );
}

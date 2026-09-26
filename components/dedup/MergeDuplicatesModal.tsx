"use client";

// Registry → "Scan & Merge Duplicates" (Founder / Admin / Director).
// Lists suspected duplicate student pairs; each is merged or kept separate by
// a person — nothing merges on its own. See services/dedup/dedup.service.

import { useEffect, useState } from "react";
import { useAuthContext } from "@/features/auth/AuthContext";
import {
  keepSeparate, mergeStudents, scanStudentDuplicates, suggestPrimary,
  type DuplicatePair, type StudentRecord,
} from "@/services/dedup/dedup.service";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const LEVEL: Record<string, { label: string; fg: string; bg: string }> = {
  same:     { label: "Same person",           fg: "#991b1b", bg: "#fee2e2" },
  possible: { label: "Same name",             fg: "#92400e", bg: "#fef3c7" },
  family:   { label: "Shared phone / email",  fg: "#1e40af", bg: "#dbeafe" },
};

function Side({ rec, keep, onKeep, centreName }: {
  rec: StudentRecord; keep: boolean; onKeep: () => void; centreName: (id: string) => string;
}) {
  const d = rec.data;
  const row = (k: string, v: string) => (
    <div style={{ display: "flex", gap: 6, fontSize: 12 }}>
      <span style={{ color: "#9ca3af", minWidth: 74 }}>{k}</span><span style={{ color: "#111", wordBreak: "break-word" }}>{v || "—"}</span>
    </div>
  );
  return (
    <label style={{
      flex: "1 1 240px", border: keep ? "2px solid #4f46e5" : "1.5px solid #e5e7eb", background: keep ? "#eef2ff" : "#fff",
      borderRadius: 10, padding: "10px 12px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 3,
    }}>
      <span style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <input type="radio" checked={keep} onChange={onKeep} />
        <span style={{ fontSize: 13.5, fontWeight: 800, color: "#111" }}>{str(d.displayName) || str(d.name) || "—"}</span>
        {keep && <span style={{ fontSize: 10.5, fontWeight: 700, color: "#4f46e5" }}>KEEP</span>}
      </span>
      {row("Adm. no.", str(d.admissionNumber))}
      {row("Phone", str(d.phone))}
      {row("DOB", str(d.dob))}
      {row("Centre", centreName(str(d.centerId)))}
      {row("Status", str(d.status))}
    </label>
  );
}

export default function MergeDuplicatesModal({ onClose, centreName }: {
  onClose: () => void;
  centreName: (id: string) => string;
}) {
  const { user } = useAuthContext();
  const [pairs, setPairs] = useState<DuplicatePair[] | null>(null);
  const [err, setErr] = useState("");
  const [keepId, setKeepId] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});   // pair key → outcome text
  const [showFamily, setShowFamily] = useState(false);

  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);

  // Re-scan after merges: a student imported 3× shows up as overlapping pairs,
  // and once one merge lands the others must be recomputed.
  async function rescan() {
    try {
      const list = await scanStudentDuplicates();
      setPairs(list);
      setKeepId(k => ({ ...Object.fromEntries(list.map(p => [p.key, suggestPrimary(p)])), ...k }));
    } catch (e) {
      console.error("[MergeDuplicates] scan:", e);
      setErr("Could not scan the Registry.");
      setPairs(prev => prev ?? []);
    }
  }
  useEffect(() => { rescan(); }, []);

  /** Highest-confidence tier: same admission number AND name AND phone. */
  const isExact = (p: DuplicatePair) =>
    p.level === "same" && ["same admission number", "same name", "same phone"].every(r => p.reasons.includes(r));

  async function mergeAllExact() {
    setConfirmBulk(false);
    setErr("");
    let current = (pairs ?? []).filter(p => isExact(p) && !done[p.key]);
    const total = current.length;
    let merged = 0, failed = 0;
    setBulk({ done: 0, total });
    // Merge pair by pair, re-scanning so chains (A~B~C) resolve to one record.
    while (current.length) {
      const p = current[0];
      const primary = suggestPrimary(p);
      const secondary = primary === p.a.id ? p.b.id : p.a.id;
      try { await mergeStudents(primary, secondary, user?.uid ?? ""); merged++; }
      catch (e) { console.warn("[MergeDuplicates] bulk merge:", e); failed++; }
      setBulk({ done: merged + failed, total });
      const list = await scanStudentDuplicates();
      setPairs(list);
      current = list.filter(isExact);
      if (merged + failed > total + 5) break;   // safety stop
    }
    setBulk(null);
    setErr(failed ? `${failed} pair${failed !== 1 ? "s" : ""} could not be merged — review them below.` : "");
    setDone(d => ({ ...d, __bulk: `✓ Merged ${merged} exact duplicate${merged !== 1 ? "s" : ""}` }));
    await rescan();
  }

  async function merge(p: DuplicatePair) {
    const primary = keepId[p.key];
    const secondary = primary === p.a.id ? p.b.id : p.a.id;
    const keptName = str((primary === p.a.id ? p.a : p.b).data.displayName) || str((primary === p.a.id ? p.a : p.b).data.name);
    setBusy(p.key); setErr("");
    try {
      const moved = await mergeStudents(primary, secondary, user?.uid ?? "");
      setDone(d => ({ ...d, [p.key]: `✓ Merged into ${keptName} — ${moved} linked record${moved !== 1 ? "s" : ""} moved` }));
      await rescan();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Merge failed.");
    } finally {
      setBusy(null);
    }
  }
  async function separate(p: DuplicatePair) {
    setBusy(p.key); setErr("");
    try {
      await keepSeparate(p.a.id, p.b.id, user?.uid ?? "");
      setDone(d => ({ ...d, [p.key]: "Kept separate — won't be suggested again" }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(null);
    }
  }

  const strong = (pairs ?? []).filter(p => p.level !== "family");
  const family = (pairs ?? []).filter(p => p.level === "family");

  const renderPair = (p: DuplicatePair) => {
    const lv = LEVEL[p.level];
    const outcome = done[p.key];
    return (
      <div key={p.key} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: outcome ? "#f9fafb" : "#fff", opacity: outcome ? 0.75 : 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: lv.fg, background: lv.bg, borderRadius: 99, padding: "2px 9px" }}>{lv.label}</span>
          <span style={{ fontSize: 12, color: "#6b7280" }}>Matched on {p.reasons.join(", ")}</span>
        </div>
        {outcome ? (
          <div style={{ fontSize: 13, fontWeight: 700, color: "#15803d" }}>{outcome}</div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {[p.a, p.b].map(r => (
                <Side key={r.id} rec={r} keep={keepId[p.key] === r.id} centreName={centreName}
                  onKeep={() => setKeepId(k => ({ ...k, [p.key]: r.id }))} />
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
              <button onClick={() => separate(p)} disabled={!!busy} style={btn("#fff", "#374151", "#d1d5db")}>Keep Separate</button>
              <button onClick={() => merge(p)} disabled={!!busy} style={btn("#4f46e5", "#fff", "#4f46e5")}>
                {busy === p.key ? "Merging…" : "Merge Records"}
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div onClick={busy || bulk ? undefined : onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, overflowY: "auto" }}>
      <div role="dialog" aria-label="Scan and merge duplicates" onClick={e => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 820, background: "#faf9f7", borderRadius: 18, padding: 20, margin: "24px 0", boxShadow: "0 24px 64px rgba(0,0,0,0.25)", boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 900, color: "#111" }}>🔍 Scan &amp; Merge Duplicates</div>
            <div style={{ fontSize: 12.5, color: "#6b7280", marginTop: 3, maxWidth: 620 }}>
              Pick the record to keep, then <b>Merge Records</b>: fees, attendance, screening and lessons move to it, blanks are
              filled from the other, and the duplicate is removed from rosters, Finance and Attendance (kept hidden for tracing).
            </div>
          </div>
          <button onClick={onClose} disabled={!!busy} aria-label="Close" style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#9ca3af" }}>✕</button>
        </div>

        {err && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "9px 12px", fontSize: 13, color: "#dc2626", marginBottom: 10 }}>{err}</div>}

        {pairs === null ? (
          <div style={{ padding: 30, textAlign: "center", fontSize: 13, color: "#9ca3af" }}>Scanning the Registry…</div>
        ) : pairs.length === 0 ? (
          <div style={{ padding: 30, textAlign: "center", fontSize: 13, color: "#15803d", fontWeight: 700 }}>✓ No duplicates found.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {done.__bulk && <div style={{ fontSize: 13, fontWeight: 700, color: "#15803d" }}>{done.__bulk}</div>}
            {(() => {
              const exact = strong.filter(p => isExact(p) && !done[p.key]);
              if (bulk) return (
                <div style={{ background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 10, padding: "10px 12px", fontSize: 13, color: "#3730a3", fontWeight: 700 }}>
                  Merging… {bulk.done} / {bulk.total}
                </div>
              );
              if (exact.length < 2) return null;
              return (
                <div style={{ background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 10, padding: "10px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12.5, color: "#3730a3" }}>
                    <b>{exact.length}</b> pairs match on admission number, name <i>and</i> phone — almost certainly the same student entered twice.
                  </span>
                  {confirmBulk ? (
                    <span style={{ display: "flex", gap: 6 }}>
                      <button onClick={mergeAllExact} disabled={!!busy} style={btn("#4f46e5", "#fff", "#4f46e5")}>Yes, merge all {exact.length}</button>
                      <button onClick={() => setConfirmBulk(false)} style={btn("#fff", "#374151", "#d1d5db")}>Cancel</button>
                    </span>
                  ) : (
                    <button onClick={() => setConfirmBulk(true)} disabled={!!busy} style={btn("#fff", "#3730a3", "#a5b4fc")}>Merge all exact duplicates…</button>
                  )}
                </div>
              );
            })()}
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "#374151" }}>
              {strong.length} likely duplicate{strong.length !== 1 ? "s" : ""}
            </div>
            {strong.length === 0 && <div style={{ fontSize: 12.5, color: "#6b7280" }}>None — only shared phone / email pairs below.</div>}
            {strong.map(renderPair)}

            {family.length > 0 && (
              <>
                <button onClick={() => setShowFamily(v => !v)}
                  style={{ alignSelf: "flex-start", marginTop: 6, background: "none", border: "none", padding: 0, fontSize: 12.5, fontWeight: 700, color: "#1e40af", cursor: "pointer" }}>
                  {showFamily ? "▾" : "▸"} {family.length} pair{family.length !== 1 ? "s" : ""} sharing a phone / email — usually siblings or a parent
                </button>
                {showFamily && family.map(renderPair)}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function btn(bg: string, fg: string, border: string): React.CSSProperties {
  return { padding: "8px 16px", borderRadius: 9, border: `1px solid ${border}`, background: bg, color: fg, fontSize: 12.5, fontWeight: 700, cursor: "pointer" };
}

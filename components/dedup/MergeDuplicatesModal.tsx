"use client";

// Registry / centre roster → "Scan & Merge Duplicates" (Founder / Admin / Director).
// Rules (services/dedup/dedup.service):
//   same admission no. + same name        → "Merge all exact duplicates" merges them
//   same name, different admission numbers → different students: kept separate
//   same admission no., different names    → conflicting names: manual review
//   anything else                          → reviewed pair by pair below
// Shared by both wings.

import { useEffect, useState } from "react";
import { useAuthContext } from "@/features/auth/AuthContext";
import {
  isAutoMergePair, isConflictingNames, isSameNameDifferentAdmission,
  keepSeparate, mergeStudents, scanStudentDuplicates, suggestPrimary,
  type DuplicatePair, type StudentRecord,
} from "@/services/dedup/dedup.service";
import { mergeExactGroups } from "@/services/dedup/autoMerge.service";

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

  const [bulk, setBulk] = useState<{ done: number; total: number; label: string } | null>(null);
  // Multi-select: pairs ticked for "Merge selected".
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const togglePick = (key: string) => setPicked(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
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

  /** Auto-merge tier: same admission number AND same name. */
  const isExact = isAutoMergePair;

  async function mergeAllExact() {
    setConfirmBulk(false);
    setErr("");
    // Same name, different admission numbers = different students → record "keep separate".
    const distinct = (pairs ?? []).filter(p => isSameNameDifferentAdmission(p) && !done[p.key]);
    let keptSeparate = 0;
    for (const p of distinct) {
      try { await keepSeparate(p.a.id, p.b.id, user?.uid ?? ""); keptSeparate++; }
      catch (e) { console.warn("[MergeDuplicates] keep separate:", e); }
    }
    // One pass: copies grouped per student (A~B~C → one), the record with the
    // most attendance + payments kept — no rescans between merges.
    const exact = (pairs ?? []).filter(p => isExact(p) && !done[p.key]);
    const { merged, failed } = await mergeExactGroups(exact, user?.uid ?? "",
      (d, t) => setBulk({ done: d, total: t, label: "Merging exact duplicates" }));
    setBulk(null);
    setPicked(new Set());
    setErr(failed ? `${failed} pair${failed !== 1 ? "s" : ""} could not be merged — review them below.` : "");
    setDone(d => ({ ...d, __bulk:
      `✓ Successfully auto-merged ${merged} duplicate student record${merged !== 1 ? "s" : ""} (matching Name + Admission No). `
      + `${keptSeparate} distinct record${keptSeparate !== 1 ? "s" : ""} with identical names ${keptSeparate !== 1 ? "were" : "was"} kept separate.` }));
    await rescan();
  }

  /** Merge every ticked pair into the record marked KEEP on it; pairs already gone are skipped. */
  async function mergeSelected() {
    const list = (pairs ?? []).filter(p => picked.has(p.key) && !done[p.key]);
    if (list.length === 0) return;
    setErr("");
    const retired = new Set<string>();
    let merged = 0, skipped = 0, failed = 0;
    setBulk({ done: 0, total: list.length, label: "Merging selected pairs" });
    for (const p of list) {
      const primary = keepId[p.key] ?? suggestPrimary(p);
      const secondary = primary === p.a.id ? p.b.id : p.a.id;
      if (retired.has(primary) || retired.has(secondary)) { skipped++; }
      else {
        try { await mergeStudents(primary, secondary, user?.uid ?? ""); merged++; retired.add(secondary); }
        catch (e) { console.warn("[MergeDuplicates] selected merge:", e); failed++; }
      }
      setBulk({ done: merged + skipped + failed, total: list.length, label: "Merging selected pairs" });
    }
    setBulk(null);
    setPicked(new Set());
    setDone(d => ({ ...d, __bulk: `✓ Merged ${merged} selected pair${merged !== 1 ? "s" : ""}${skipped ? ` · ${skipped} skipped (already merged in this run — rescan shows what's left)` : ""}.` }));
    setErr(failed ? `${failed} pair${failed !== 1 ? "s" : ""} could not be merged — review them below.` : "");
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

  const all = pairs ?? [];
  const exactPairs  = all.filter(isExact);
  const reviewPairs = all.filter(p => isSameNameDifferentAdmission(p) || isConflictingNames(p));
  const inGroup = (p: DuplicatePair) => isExact(p) || isSameNameDifferentAdmission(p) || isConflictingNames(p);
  const strong = all.filter(p => !inGroup(p) && p.level !== "family");
  const family = all.filter(p => !inGroup(p) && p.level === "family");

  const renderPair = (p: DuplicatePair) => {
    const sameName = isSameNameDifferentAdmission(p);
    const conflict = isConflictingNames(p);
    const distinct = sameName || conflict;   // default action: Keep Separate
    const lv = sameName ? { label: "Different students — same name", fg: "#065f46", bg: "#d1fae5" }
      : conflict ? { label: "Conflicting names — review required", fg: "#9a3412", bg: "#ffedd5" }
      : LEVEL[p.level];
    const outcome = done[p.key];
    return (
      <div key={p.key} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: outcome ? "#f9fafb" : "#fff", opacity: outcome ? 0.75 : 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          {!outcome && (
            <input type="checkbox" checked={picked.has(p.key)} onChange={() => togglePick(p.key)} disabled={!!bulk}
              aria-label="Select this pair" style={{ width: 16, height: 16, cursor: "pointer" }} />
          )}
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
              {distinct ? (
                <>
                  <span style={{ fontSize: 11.5, color: "#6b7280", alignSelf: "center", marginRight: "auto" }}>
                    {conflict ? "Same admission number but different names — check which is right before merging." : "Different admission numbers — not merged automatically."}
                  </span>
                  <button onClick={() => merge(p)} disabled={!!busy} style={btn("#fff", "#6b7280", "#e5e7eb")}>
                    {busy === p.key ? "Merging…" : "Merge anyway"}
                  </button>
                  <button onClick={() => separate(p)} disabled={!!busy} style={btn("#059669", "#fff", "#059669")}>✓ Keep Separate</button>
                </>
              ) : (
                <>
                  <button onClick={() => separate(p)} disabled={!!busy} style={btn("#fff", "#374151", "#d1d5db")}>Keep Separate</button>
                  <button onClick={() => merge(p)} disabled={!!busy} style={btn("#4f46e5", "#fff", "#4f46e5")}>
                    {busy === p.key ? "Merging…" : "Merge Records"}
                  </button>
                </>
              )}
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
              const exact = exactPairs.filter(p => !done[p.key]);
              const conflictCount = all.filter(p => isConflictingNames(p) && !done[p.key]).length;
              const distinctCount = (pairs ?? []).filter(p => isSameNameDifferentAdmission(p) && !done[p.key]).length;
              if (bulk) return (
                <div role="progressbar" aria-valuemin={0} aria-valuemax={bulk.total} aria-valuenow={bulk.done}
                  style={{ background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 10, padding: "10px 12px", fontSize: 13, color: "#3730a3", fontWeight: 700 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span>{bulk.label}…</span><span>{bulk.done} / {bulk.total}</span>
                  </div>
                  <div style={{ height: 8, borderRadius: 99, background: "#c7d2fe", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${bulk.total ? Math.round((bulk.done / bulk.total) * 100) : 100}%`, background: "#4f46e5", transition: "width 0.2s" }} />
                  </div>
                  <div style={{ fontSize: 11.5, fontWeight: 500, marginTop: 6 }}>Keep this window open until it finishes.</div>
                </div>
              );
              if (exact.length === 0 && distinctCount === 0) return null;
              return (
                <div style={{ background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 10, padding: "10px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12.5, color: "#3730a3" }}>
                    <b>{exact.length}</b> pair{exact.length !== 1 ? "s" : ""} match on admission number <i>and</i> name — the same student entered twice.
                    {distinctCount > 0 && <> <b>{distinctCount}</b> same-name pair{distinctCount !== 1 ? "s" : ""} with different admission numbers will be kept separate.</>}
                    {conflictCount > 0 && <> <b>{conflictCount}</b> pair{conflictCount !== 1 ? "s" : ""} with the same admission number but different names won&apos;t be touched — review below.</>}
                  </span>
                  {confirmBulk ? (
                    <span style={{ display: "flex", gap: 6 }}>
                      <button onClick={mergeAllExact} disabled={!!busy} style={btn("#4f46e5", "#fff", "#4f46e5")}>Yes, merge {exact.length}{distinctCount ? ` · keep ${distinctCount} separate` : ""}</button>
                      <button onClick={() => setConfirmBulk(false)} style={btn("#fff", "#374151", "#d1d5db")}>Cancel</button>
                    </span>
                  ) : (
                    <button onClick={() => setConfirmBulk(true)} disabled={!!busy} style={btn("#fff", "#3730a3", "#a5b4fc")}>Merge all exact duplicates…</button>
                  )}
                </div>
              );
            })()}
            {(() => {
              const selectable = all.filter(p => !done[p.key] && (p.level !== "family" || showFamily));
              const allOn = selectable.length > 0 && selectable.every(p => picked.has(p.key));
              return selectable.length > 0 && !bulk ? (
                <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 700, color: "#374151", cursor: "pointer", alignSelf: "flex-start" }}>
                  <input type="checkbox" checked={allOn} style={{ width: 16, height: 16 }}
                    onChange={() => setPicked(allOn ? new Set() : new Set(selectable.map(p => p.key)))} />
                  Select all ({selectable.length})
                </label>
              ) : null;
            })()}
            {exactPairs.length > 0 && (
              <>
                <div style={groupHead}>Exact Duplicates (Auto-Merged) · {exactPairs.length}</div>
                <div style={groupNote}>Same name and same admission number — merged by “Merge all exact duplicates”.</div>
                {exactPairs.map(renderPair)}
              </>
            )}
            {reviewPairs.length > 0 && (
              <>
                <div style={groupHead}>Requires Manual Review · {reviewPairs.length}</div>
                <div style={groupNote}>Same name with different admission numbers, or same admission number with different names. Never merged automatically.</div>
                {reviewPairs.map(renderPair)}
              </>
            )}
            {strong.length > 0 && (
              <>
                <div style={groupHead}>Other possible duplicates · {strong.length}</div>
                {strong.map(renderPair)}
              </>
            )}

            {family.length > 0 && (
              <>
                <button onClick={() => setShowFamily(v => !v)}
                  style={{ alignSelf: "flex-start", marginTop: 6, background: "none", border: "none", padding: 0, fontSize: 12.5, fontWeight: 700, color: "#1e40af", cursor: "pointer" }}>
                  {showFamily ? "▾" : "▸"} {family.length} pair{family.length !== 1 ? "s" : ""} sharing a phone / email — usually siblings or a parent
                </button>
                {showFamily && family.map(renderPair)}
              </>
            )}
            {picked.size > 0 && !bulk && (
              <div style={{ position: "sticky", bottom: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap",
                background: "#111827", color: "#fff", borderRadius: 12, padding: "10px 14px", marginTop: 8, boxShadow: "0 -6px 20px rgba(0,0,0,0.18)" }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{picked.size} pair{picked.size !== 1 ? "s" : ""} selected · each merges into the record marked KEEP</span>
                <span style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setPicked(new Set())} style={btn("transparent", "#e5e7eb", "#4b5563")}>Clear</button>
                  <button onClick={mergeSelected} disabled={!!busy} style={btn("#4f46e5", "#fff", "#4f46e5")}>Merge selected ({picked.size} pair{picked.size !== 1 ? "s" : ""})</button>
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const groupHead: React.CSSProperties = { fontSize: 13, fontWeight: 800, color: "#374151", marginTop: 6 };
const groupNote: React.CSSProperties = { fontSize: 12, color: "#6b7280", marginTop: -6 };

function btn(bg: string, fg: string, border: string): React.CSSProperties {
  return { padding: "8px 16px", borderRadius: 9, border: `1px solid ${border}`, background: bg, color: fg, fontSize: 12.5, fontWeight: 700, cursor: "pointer" };
}

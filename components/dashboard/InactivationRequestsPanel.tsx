"use client";

// Dashboard approvals for student inactivation requests raised by teachers.
// Shown to the current wing's approvers — ROL+: Admin (+ Founder); School of
// Music: Director / Chief Teacher / Admin (+ Founder) — and only when there's
// something to review.

import { useCallback, useEffect, useState } from "react";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import { useAuth } from "@/hooks/useAuth";
import { useWing } from "@/hooks/useWing";
import { inWing } from "@/lib/wing";
import { computeStudentBalances } from "@/services/finance/finance.service";
import {
  DEACTIVATION_REQUESTED, approveStudentDeactivation, canApproveDeactivation, rejectStudentDeactivation,
} from "@/services/student/deactivation.service";
import type { Transaction } from "@/types/finance";

interface RequestRow {
  uid: string;
  name: string;
  centerName: string;
  requestedBy: string | null;
  requesterName: string;
  requestedAt: string;
  reason: string;
  balance: number;
}

const INR = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
};

export default function InactivationRequestsPanel() {
  const { user, role } = useAuth();
  const { wing } = useWing();
  const [rows, setRows]     = useState<RequestRow[]>([]);
  const [busy, setBusy]     = useState<string | null>(null);
  const [flash, setFlash]   = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const snap = await getDocs(query(collection(db, "users"),
        where("role", "==", "student"), where("status", "==", DEACTIVATION_REQUESTED)));
      const docs = snap.docs.filter(d => inWing(d.data(), wing));
      if (docs.length === 0) { setRows([]); return; }

      const centreIds = Array.from(new Set(docs.map(d => d.data().centerId as string).filter(Boolean)));
      const requesterIds = Array.from(new Set(docs
        .filter(d => !d.data().deactivationRequestedByName && d.data().deactivationRequestedBy)
        .map(d => d.data().deactivationRequestedBy as string)));

      const [centres, requesters, ledgers] = await Promise.all([
        Promise.all(centreIds.map(id => getDoc(doc(db, "centers", id)))),
        Promise.all(requesterIds.map(id => getDoc(doc(db, "users", id)))),
        Promise.all(docs.map(d => getDocs(query(collection(db, "transactions"), where("studentUid", "==", d.id))))),
      ]);
      const centreName = new Map(centres.map(c => [c.id, (c.data()?.name as string) ?? c.id]));
      const requesterName = new Map(requesters.map(u => [u.id, ((u.data()?.preferredName ?? u.data()?.displayName) as string) ?? ""]));

      setRows(docs.map((d, i) => {
        const st = d.data();
        const txs = ledgers[i].docs.map(t => ({ id: t.id, ...t.data() }) as Transaction);
        const by = (st.deactivationRequestedBy ?? null) as string | null;
        return {
          uid: d.id,
          name: (st.displayName ?? st.name ?? "—") as string,
          centerName: centreName.get(st.centerId as string) ?? "—",
          requestedBy: by,
          requesterName: (st.deactivationRequestedByName as string) || (by ? requesterName.get(by) ?? "" : ""),
          requestedAt: (st.deactivationRequestedAt ?? "") as string,
          reason: (st.deactivationReason ?? "") as string,
          balance: computeStudentBalances(txs).get(d.id) ?? 0,
        };
      }).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)));
    } catch (err) {
      console.error("[InactivationRequestsPanel] load failed:", err);
    }
  }, [wing]);

  const allowed = canApproveDeactivation(role, wing);
  useEffect(() => { if (allowed) load(); else setRows([]); }, [load, allowed]);

  async function decide(r: RequestRow, approve: boolean) {
    if (!user) return;
    setBusy(r.uid); setFlash(null);
    const by = { uid: user.uid, role, name: user.displayName, wing };
    try {
      if (approve) await approveStudentDeactivation(r.uid, by, r.requestedBy);
      else         await rejectStudentDeactivation(r.uid, by, r.requestedBy);
      setRows(prev => prev.filter(x => x.uid !== r.uid));
      setFlash({
        ok: true,
        text: approve
          ? `${r.name} is now inactive.${r.balance > 0 ? ` ${INR(r.balance)} outstanding stays on Finance until paid.` : ""}`
          : `Request rejected — ${r.name} stays active.`,
      });
    } catch (e) {
      setFlash({ ok: false, text: e instanceof Error ? e.message : "Could not update the request." });
    } finally {
      setBusy(null);
    }
  }

  if (!allowed || (rows.length === 0 && !flash)) return null;

  return (
    <section aria-label="Inactivation requests" style={{
      background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 14, padding: "14px 16px", marginBottom: 18,
    }}>
      <div style={{ fontSize: 14, fontWeight: 800, color: "#78350f", marginBottom: rows.length ? 10 : 0 }}>
        ⚠ Inactivation Requests {rows.length > 0 && <span style={{ fontWeight: 600 }}>({rows.length})</span>}
      </div>
      {flash && (
        <div role="status" style={{ fontSize: 12.5, marginBottom: 10, color: flash.ok ? "#15803d" : "#dc2626" }}>{flash.text}</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map(r => (
          <div key={r.uid} style={{
            background: "#fff", border: "1px solid #fde68a", borderRadius: 10, padding: "10px 12px",
            display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
          }}>
            <div style={{ flex: "1 1 260px", minWidth: 0 }}>
              <div style={{ fontSize: 13.5, color: "#111827" }}>
                <b>Inactivation Request:</b> {r.name} <span style={{ color: "#6b7280" }}>({r.centerName})</span>
                {r.requesterName && <> requested by <b>{r.requesterName}</b></>}
              </div>
              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                {r.requestedAt && fmtDate(r.requestedAt)}
                {r.reason && <> · “{r.reason}”</>}
                {r.balance > 0
                  ? <span style={{ color: "#b91c1c", fontWeight: 600 }}> · {INR(r.balance)} due — stays on Finance until paid</span>
                  : <span> · no dues</span>}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" disabled={busy === r.uid} onClick={() => decide(r, true)}
                style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "#dc2626", color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: "pointer", opacity: busy === r.uid ? 0.6 : 1 }}>
                {busy === r.uid ? "…" : "Approve Inactivation"}
              </button>
              <button type="button" disabled={busy === r.uid} onClick={() => decide(r, false)}
                style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 12.5, fontWeight: 700, cursor: "pointer", opacity: busy === r.uid ? 0.6 : 1 }}>
                Reject Request
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

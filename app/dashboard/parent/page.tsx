"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { db } from "@/services/firebase/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { CAPABILITIES } from "@/config/permissions";
import { useAuth } from "@/hooks/useAuth";
import { computeStudentBalances } from "@/services/finance/finance.service";
import type { Transaction } from "@/types/finance";

export default function ParentPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.PARENT]} requiredCapability={CAPABILITIES.PARENT_VIEW_CHILD}>
      <ParentContent />
    </ProtectedRoute>
  );
}

interface ChildInfo {
  uid: string;
  name: string;
  studentID: string;
  centerName: string;
  instrument: string;
  course: string;
  status: string;
  balance: number;
  attThisMonth: { present: number; absent: number; total: number };
}

function ParentContent() {
  const { user } = useAuth();
  const childUids = useMemo(
    () => (user && "childUids" in user && Array.isArray(user.childUids) ? (user.childUids as string[]) : []),
    [user],
  );

  const [children, setChildren] = useState<ChildInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const month = new Date().toISOString().slice(0, 7);
        const results = await Promise.all(childUids.map(async (uid) => {
          const [snap, centerSnap, txSnap, attSnap] = await Promise.all([
            getDoc(doc(db, "users", uid)),
            getDocs(collection(db, "centers")),
            getDocs(query(collection(db, "transactions"), where("studentUid", "==", uid))),
            getDocs(query(collection(db, "attendance"), where("studentUid", "==", uid))),
          ]);
          if (!snap.exists()) return null;
          const s = snap.data();
          const centerName =
            centerSnap.docs.find(c => c.id === s.centerId)?.data().name ?? (s.centerId as string) ?? "—";
          const txs = txSnap.docs.map(d => ({ id: d.id, ...d.data() }) as Transaction);
          const balance = computeStudentBalances(txs).get(uid) ?? 0;
          const monthAtt = attSnap.docs
            .map(d => d.data())
            .filter(a => typeof a.date === "string" && a.date.startsWith(month));
          const present = monthAtt.filter(a => a.status === "present").length;
          const absent = monthAtt.filter(a => a.status === "absent").length;
          return {
            uid,
            name: (s.displayName ?? s.name ?? "—") as string,
            studentID: (s.studentID ?? "—") as string,
            centerName,
            instrument: (s.instrument ?? "—") as string,
            course: (s.course ?? "—") as string,
            status: (s.status ?? s.studentStatus ?? "active") as string,
            balance,
            attThisMonth: { present, absent, total: monthAtt.length },
          } as ChildInfo;
        }));
        if (cancelled) return;
        const clean = results.filter((r): r is ChildInfo => r !== null);
        setChildren(clean);
        setSelected(prev => prev ?? clean[0]?.uid ?? null);
      } catch (err) {
        console.error("Parent load failed:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [childUids]);

  if (loading) return <div style={s.empty}>Loading…</div>;
  if (children.length === 0) {
    return (
      <div style={s.empty}>
        No children are linked to your account yet. Please contact the school office.
      </div>
    );
  }

  const child = children.find(c => c.uid === selected) ?? children[0];

  return (
    <div style={{ maxWidth: 760, margin: "0 auto" }}>
      <h1 style={s.title}>My Family</h1>

      {children.length > 1 && (
        <div style={s.tabs}>
          {children.map(c => (
            <button
              key={c.uid}
              onClick={() => setSelected(c.uid)}
              style={{ ...s.tab, ...(c.uid === child.uid ? s.tabActive : {}) }}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      <div style={s.card}>
        <div style={s.childName}>{child.name}</div>
        <div style={s.sub}>{child.studentID} · {child.centerName}</div>

        <div style={s.statGrid}>
          <Stat label="Instrument" value={child.instrument} />
          <Stat label="Course" value={child.course} />
          <Stat label="Status" value={child.status} />
          <Stat
            label="Balance"
            value={child.balance > 0 ? `₹${child.balance.toLocaleString("en-IN")} due` : child.balance < 0 ? `₹${Math.abs(child.balance).toLocaleString("en-IN")} credit` : "Clear"}
            color={child.balance > 0 ? "#dc2626" : "#16a34a"}
          />
          <Stat label="Present (this month)" value={String(child.attThisMonth.present)} color="#16a34a" />
          <Stat label="Absent (this month)" value={String(child.attThisMonth.absent)} color={child.attThisMonth.absent > 0 ? "#dc2626" : undefined} />
        </div>

        <Link href={`/dashboard/student-syllabus/${child.uid}`} style={s.link}>
          View syllabus progress →
        </Link>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={s.stat}>
      <div style={s.statLabel}>{label}</div>
      <div style={{ ...s.statValue, color: color ?? "var(--color-text-primary)" }}>{value}</div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  title: { fontSize: 22, fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 16 },
  empty: { textAlign: "center", padding: "60px 24px", color: "var(--color-text-secondary)", fontSize: 14 },
  tabs: { display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" },
  tab: { padding: "7px 14px", borderRadius: 8, border: "1px solid var(--color-border)", background: "var(--color-surface-2)", color: "var(--color-text-secondary)", fontSize: 13, cursor: "pointer" },
  tabActive: { background: "#ede9fe", borderColor: "#4f46e5", color: "#4338ca", fontWeight: 700 },
  card: { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 14, padding: 24 },
  childName: { fontSize: 18, fontWeight: 800, color: "var(--color-text-primary)" },
  sub: { fontSize: 13, color: "var(--color-text-secondary)", marginTop: 2, marginBottom: 18 },
  statGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 20 },
  stat: { background: "var(--color-bg)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "12px 14px" },
  statLabel: { fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-text-muted)", marginBottom: 4 },
  statValue: { fontSize: 16, fontWeight: 700 },
  link: { fontSize: 13, fontWeight: 600, color: "#4f46e5", textDecoration: "none" },
};

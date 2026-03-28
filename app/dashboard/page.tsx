"use client";

import { useEffect, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/config/firebase";
import { useAuth } from "@/hooks/useAuth";
import { ROLES } from "@/config/constants";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { getCenters } from "@/services/center/center.service";
import { getClassesByCenter } from "@/services/attendance/attendance.service";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Stats {
  totalStudents:   number;
  totalCenters:    number;
  attendanceToday: number;
  pendingFees:     number;
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER, ROLES.STUDENT]}>
      <DashboardContent />
    </ProtectedRoute>
  );
}

function DashboardContent() {
  const { user } = useAuth();
  const [stats, setStats]     = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    async function fetchStats() {
      try {
        // 1. Total students
        const studentsSnap = await getDocs(
          query(collection(db, "users"), where("role", "==", "student"))
        );
        const totalStudents = studentsSnap.size;

        // 2. Total centers + 3. Attendance today
        const centers = await getCenters();
        const totalCenters = centers.length;

        const classesNested = await Promise.all(
          centers.map(c => getClassesByCenter(c.id))
        );
        const allClasses = classesNested.flat();
        const attendanceToday = allClasses.filter(
          cls => (cls.date ?? "") === today
        ).length;

        // 4. Pending fees — sum currentBalance > 0 across all students
        let pendingFees = 0;
        studentsSnap.forEach(doc => {
          const bal = doc.data().currentBalance as number | undefined;
          if (bal && bal > 0) pendingFees += bal;
        });

        setStats({ totalStudents, totalCenters, attendanceToday, pendingFees });
      } catch (err) {
        console.error("Failed to fetch dashboard stats:", err);
        setStats({ totalStudents: 0, totalCenters: 0, attendanceToday: 0, pendingFees: 0 });
      } finally {
        setLoading(false);
      }
    }

    fetchStats();
  }, []);

  if (!user) return null;

  const cards = [
    { label: "Total Students",   value: stats?.totalStudents,   accent: "#4f46e5" },
    { label: "Total Centers",    value: stats?.totalCenters,    accent: "#0891b2" },
    { label: "Attendance Today", value: stats?.attendanceToday, accent: "#16a34a" },
    { label: "Pending Fees",     value: stats?.pendingFees != null
        ? `₹${stats.pendingFees.toLocaleString("en-IN")}`
        : undefined,
      accent: "#d97706" },
  ];

  return (
    <div>
      <h1 style={styles.heading}>Welcome, {user.displayName}</h1>
      <p style={styles.subheading}>
        {new Date().toLocaleDateString("en-IN", {
          weekday: "long", year: "numeric", month: "long", day: "numeric",
        })}
      </p>

      <div style={styles.grid}>
        {cards.map(card => (
          <StatCard
            key={card.label}
            label={card.label}
            value={loading ? null : (card.value ?? 0)}
            accent={card.accent}
          />
        ))}
      </div>
    </div>
  );
}

// ─── StatCard ──────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number | null;
  accent: string;
}) {
  return (
    <div style={styles.card}>
      <div style={{ ...styles.cardAccent, background: accent }} />
      <div style={styles.cardBody}>
        <div style={styles.cardLabel}>{label}</div>
        <div style={styles.cardValue}>
          {value === null ? (
            <span style={styles.cardLoading}>—</span>
          ) : (
            String(value)
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  heading: {
    fontSize: 22,
    fontWeight: 600,
    marginBottom: 6,
    color: "var(--color-text-primary)",
  },
  subheading: {
    fontSize: 13,
    color: "var(--color-text-secondary)",
    marginBottom: 28,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: 16,
  },
  card: {
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 10,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    boxShadow: "var(--shadow-sm)",
  },
  cardAccent: {
    height: 4,
    width: "100%",
  },
  cardBody: {
    padding: "18px 20px",
  },
  cardLabel: {
    fontSize: 12,
    color: "var(--color-text-secondary)",
    marginBottom: 8,
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  cardValue: {
    fontSize: 28,
    fontWeight: 700,
    color: "var(--color-text-primary)",
  },
  cardLoading: {
    fontSize: 28,
    fontWeight: 700,
    color: "var(--color-text-secondary)",
  },
};

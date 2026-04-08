"use client";

/**
 * Historical Data Entry — Super Admin & Admin only
 *
 * Three tabs:
 *  1. Finance   — backdate transactions (fee payments / deposits / adjustments)
 *  2. Attendance — bulk-mark past attendance for any centre on any past date
 *  3. Students   — register students with a past admission date
 *
 * All writes include a `backdated: true` flag so reports can distinguish them.
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  collection,
  getDocs,
  addDoc,
  updateDoc,
  doc,
  query,
  where,
  increment,
  Timestamp,
} from "firebase/firestore";
import { db } from "@/config/firebase";
import { useAuth } from "@/hooks/useAuth";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";

// ─── Local types ──────────────────────────────────────────────────────────────

interface StudentOption {
  uid:       string;
  name:      string;
  studentID: string;
  centerId:  string;
  centerName: string;
  billingMode: string;
  balance:   number;
}

interface CenterOption {
  id:   string;
  name: string;
  code: string;
}

interface AttendanceStudentRow {
  uid:    string;
  name:   string;
  status: "present" | "absent" | null;
}

type FinanceTxType = "payment" | "deposit" | "adjustment";
type PayMethod     = "UPI" | "Cash" | "Bank";
type ActiveTab     = "finance" | "attendance" | "students";

// ─── Page shell ───────────────────────────────────────────────────────────────

export default function HistoryPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN]}>
      <HistoryContent />
    </ProtectedRoute>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function monthStart(iso: string) {
  return iso.slice(0, 7); // "YYYY-MM"
}

function toTimestamp(isoDate: string, time = "12:00"): Timestamp {
  return Timestamp.fromDate(new Date(`${isoDate}T${time}:00`));
}

// ─── Main content ─────────────────────────────────────────────────────────────

function HistoryContent() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<ActiveTab>("finance");

  // ── Shared data ────────────────────────────────────────────────────────────
  const [students, setStudents]   = useState<StudentOption[]>([]);
  const [centers,  setCenters]    = useState<CenterOption[]>([]);
  const [dataLoaded, setDataLoaded] = useState(false);

  const loadSharedData = useCallback(async () => {
    const [studSnap, ctrSnap] = await Promise.all([
      getDocs(query(collection(db, "users"), where("role", "==", "student"))),
      getDocs(collection(db, "centers")),
    ]);

    const ctrMap: Record<string, string> = {};
    const ctrs: CenterOption[] = ctrSnap.docs.map(d => {
      const data = d.data();
      ctrMap[d.id] = (data.name as string) || d.id;
      return { id: d.id, name: (data.name as string) || d.id, code: (data.centerCode as string) || "" };
    });

    const studs: StudentOption[] = studSnap.docs.map(d => {
      const data = d.data();
      return {
        uid:        d.id,
        name:       (data.displayName as string) || "",
        studentID:  (data.studentID as string) || "",
        centerId:   (data.centerId as string) || "",
        centerName: ctrMap[(data.centerId as string)] || "",
        billingMode: (data.billingMode as string) || "postpay",
        balance:    (data.currentBalance as number) ?? 0,
      };
    });

    setStudents(studs.sort((a, b) => a.name.localeCompare(b.name)));
    setCenters(ctrs.sort((a, b) => a.name.localeCompare(b.name)));
    setDataLoaded(true);
  }, []);

  useEffect(() => { loadSharedData(); }, [loadSharedData]);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={s.page}>
      {/* Header */}
      <div style={s.header}>
        <div>
          <h1 style={s.title}>📅 Historical Data Entry</h1>
          <p style={s.subtitle}>Backfill past records — all entries are flagged as backdated</p>
        </div>
        <div style={s.adminBadge}>🔒 Admin / Super Admin only</div>
      </div>

      {/* Tab bar */}
      <div style={s.tabBar}>
        {(["finance","attendance","students"] as ActiveTab[]).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{ ...s.tabBtn, ...(activeTab === tab ? s.tabBtnActive : {}) }}
          >
            {tab === "finance"    && "₹ Finance"}
            {tab === "attendance" && "✓ Attendance"}
            {tab === "students"   && "🎓 Students"}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {!dataLoaded ? (
        <div style={s.loading}>Loading data…</div>
      ) : (
        <>
          {activeTab === "finance"    && <FinanceTab    students={students} user={user} onRefresh={loadSharedData} />}
          {activeTab === "attendance" && <AttendanceTab centers={centers}  user={user} />}
          {activeTab === "students"   && <StudentsTab   centers={centers}  user={user} onRefresh={loadSharedData} />}
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// FINANCE TAB
// ═══════════════════════════════════════════════════════════════════════════════

function FinanceTab({
  students,
  user,
  onRefresh,
}: {
  students: StudentOption[];
  user: ReturnType<typeof useAuth>["user"];
  onRefresh: () => Promise<void>;
}) {
  const [studentUid,  setStudentUid]  = useState("");
  const [txType,      setTxType]      = useState<FinanceTxType>("payment");
  const [amount,      setAmount]      = useState("");
  const [txDate,      setTxDate]      = useState(todayISO());
  const [method,      setMethod]      = useState<PayMethod>("Cash");
  const [note,        setNote]        = useState("");
  const [submitting,  setSubmitting]  = useState(false);
  const [feedback,    setFeedback]    = useState<{ ok: boolean; msg: string } | null>(null);

  const chosenStudent = useMemo(() => students.find(s => s.uid === studentUid), [students, studentUid]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!studentUid || !amount || !txDate || !user) return;
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) { setFeedback({ ok: false, msg: "Enter a valid positive amount." }); return; }

    setSubmitting(true);
    setFeedback(null);
    try {
      const txAt = toTimestamp(txDate);

      // Build transaction doc
      const txDoc: Record<string, unknown> = {
        studentUid,
        centerId:   chosenStudent?.centerId ?? "",
        amount:     amt,
        type:       txType,      // "payment" | "deposit" | "adjustment"
        method,
        note,
        status:     "completed",
        backdated:  true,
        billedMonth: monthStart(txDate),
        createdAt:  txAt,
        paidAt:     txAt,
        performedBy: user.uid,
      };

      await addDoc(collection(db, "transactions"), txDoc);

      // Update balance
      const userRef = doc(db, "users", studentUid);
      if (txType === "payment") {
        // Payment reduces debt (or over-pays into credit for prepay)
        await updateDoc(userRef, { currentBalance: increment(-amt), updatedAt: new Date().toISOString() });
      } else if (txType === "deposit") {
        // Deposit adds credit (negative balance = credit)
        await updateDoc(userRef, { currentBalance: increment(-amt), updatedAt: new Date().toISOString() });
      } else if (txType === "adjustment") {
        // Adjustment: positive amount = charge extra; negative handled via note
        await updateDoc(userRef, { currentBalance: increment(amt), updatedAt: new Date().toISOString() });
      }

      setFeedback({ ok: true, msg: `✅ ${txType} of ₹${amt} recorded for ${txDate}` });
      setAmount(""); setNote(""); setStudentUid(""); setTxDate(todayISO());
      await onRefresh();
    } catch (err) {
      setFeedback({ ok: false, msg: `Error: ${String(err)}` });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={s.tabContent}>
      <div style={s.sectionTitle}>Add Backdated Financial Transaction</div>
      <p style={s.sectionDesc}>
        Record payments, deposits, or adjustments for any past date. Entries are flagged
        as <strong>backdated</strong> and included in historical trend reports.
      </p>

      <form onSubmit={handleSubmit} style={s.form}>
        {/* Student picker */}
        <div style={s.formRow}>
          <label style={s.label}>Student *</label>
          <select style={s.select} value={studentUid} onChange={e => setStudentUid(e.target.value)} required>
            <option value="">— Select student —</option>
            {students.map(st => (
              <option key={st.uid} value={st.uid}>
                {st.name} ({st.studentID}) — {st.centerName}
              </option>
            ))}
          </select>
          {chosenStudent && (
            <span style={s.hint}>
              Balance: {chosenStudent.balance < 0
                ? `Credit ₹${Math.abs(chosenStudent.balance).toFixed(2)}`
                : chosenStudent.balance > 0
                  ? `Owes ₹${chosenStudent.balance.toFixed(2)}`
                  : "Cleared"
              } · {chosenStudent.billingMode === "prepay" ? "⬆ Prepay" : "⬇ Postpay"}
            </span>
          )}
        </div>

        {/* Tx type */}
        <div style={s.formRow}>
          <label style={s.label}>Transaction Type *</label>
          <div style={s.chipRow}>
            {(["payment","deposit","adjustment"] as FinanceTxType[]).map(t => (
              <button key={t} type="button"
                style={{ ...s.chip, ...(txType === t ? s.chipActive : {}) }}
                onClick={() => setTxType(t)}
              >
                {t === "payment" ? "💳 Payment" : t === "deposit" ? "⬆ Deposit" : "⚙ Adjustment"}
              </button>
            ))}
          </div>
          <span style={s.hint}>
            {txType === "payment"    && "Reduces student's outstanding balance."}
            {txType === "deposit"    && "Adds advance credit (prepay students)."}
            {txType === "adjustment" && "Adds a charge (e.g. late fee). Use negative amount if waiving."}
          </span>
        </div>

        {/* Date + Amount row */}
        <div style={s.twoCol}>
          <div style={s.formRow}>
            <label style={s.label}>Date *</label>
            <input
              type="date" style={s.input}
              value={txDate} max={todayISO()}
              onChange={e => setTxDate(e.target.value)}
              required
            />
          </div>
          <div style={s.formRow}>
            <label style={s.label}>Amount (₹) *</label>
            <input
              type="number" style={s.input} placeholder="0.00"
              value={amount} min="0.01" step="0.01"
              onChange={e => setAmount(e.target.value)}
              required
            />
          </div>
        </div>

        {/* Method */}
        <div style={s.formRow}>
          <label style={s.label}>Method</label>
          <div style={s.chipRow}>
            {(["Cash","UPI","Bank"] as PayMethod[]).map(m => (
              <button key={m} type="button"
                style={{ ...s.chip, ...(method === m ? s.chipActive : {}) }}
                onClick={() => setMethod(m)}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Note */}
        <div style={s.formRow}>
          <label style={s.label}>Note (optional)</label>
          <input type="text" style={s.input}
            placeholder="Reason for backdated entry…"
            value={note} onChange={e => setNote(e.target.value)}
          />
        </div>

        {feedback && (
          <div style={{ ...s.feedback, background: feedback.ok ? "#dcfce7" : "#fee2e2",
            color: feedback.ok ? "#15803d" : "#dc2626" }}>
            {feedback.msg}
          </div>
        )}

        <button type="submit" disabled={submitting} style={s.submitBtn}>
          {submitting ? "Saving…" : "💾 Save Backdated Transaction"}
        </button>
      </form>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ATTENDANCE TAB
// ═══════════════════════════════════════════════════════════════════════════════

function AttendanceTab({
  centers,
  user,
}: {
  centers: CenterOption[];
  user: ReturnType<typeof useAuth>["user"];
}) {
  const [centerId,    setCenterId]    = useState("");
  const [date,        setDate]        = useState(todayISO());
  const [students,    setStudents]    = useState<AttendanceStudentRow[]>([]);
  const [loadingStud, setLoadingStud] = useState(false);
  const [submitting,  setSubmitting]  = useState(false);
  const [feedback,    setFeedback]    = useState<{ ok: boolean; msg: string } | null>(null);

  // Load students for chosen centre
  useEffect(() => {
    if (!centerId) { setStudents([]); return; }
    setLoadingStud(true);
    getDocs(query(collection(db, "users"),
      where("role", "==", "student"),
      where("centerId", "==", centerId),
      where("status", "==", "active"),
    )).then(snap => {
      setStudents(snap.docs.map(d => ({
        uid:    d.id,
        name:   (d.data().displayName as string) || d.id,
        status: null,
      })));
    }).finally(() => setLoadingStud(false));
  }, [centerId]);

  function toggleAll(val: "present" | "absent") {
    setStudents(prev => prev.map(s => ({ ...s, status: val })));
  }

  function toggleOne(uid: string) {
    setStudents(prev => prev.map(s =>
      s.uid === uid
        ? { ...s, status: s.status === "present" ? "absent" : "present" }
        : s
    ));
  }

  function setOneStatus(uid: string, val: "present" | "absent") {
    setStudents(prev => prev.map(s => s.uid === uid ? { ...s, status: val } : s));
  }

  const marked    = useMemo(() => students.filter(s => s.status !== null), [students]);
  const presentCt = useMemo(() => students.filter(s => s.status === "present").length, [students]);
  const absentCt  = useMemo(() => students.filter(s => s.status === "absent").length,  [students]);

  async function handleSave() {
    if (!centerId || !date || marked.length === 0 || !user) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const txAt = toTimestamp(date);
      const writes = marked.map(s =>
        addDoc(collection(db, "attendance"), {
          centerId,
          studentUid: s.uid,
          date,
          present:    s.status === "present",
          mode:       "manual",
          backdated:  true,
          markedBy:   user.uid,
          flagReason: "manual",
          createdAt:  txAt,
        })
      );
      await Promise.all(writes);
      setFeedback({ ok: true, msg: `✅ Saved ${marked.length} attendance records for ${date}` });
      // Reset marks but keep centre/date
      setStudents(prev => prev.map(s => ({ ...s, status: null })));
    } catch (err) {
      setFeedback({ ok: false, msg: `Error: ${String(err)}` });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={s.tabContent}>
      <div style={s.sectionTitle}>Bulk Manual Attendance Entry</div>
      <p style={s.sectionDesc}>
        Select a centre and date, then mark each student. Records are saved as{" "}
        <strong>manual + backdated</strong> — visible in attendance history with a flag.
      </p>

      {/* Controls */}
      <div style={s.twoCol}>
        <div style={s.formRow}>
          <label style={s.label}>Centre *</label>
          <select style={s.select} value={centerId} onChange={e => setCenterId(e.target.value)}>
            <option value="">— Select centre —</option>
            {centers.map(c => (
              <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
            ))}
          </select>
        </div>
        <div style={s.formRow}>
          <label style={s.label}>Date *</label>
          <input type="date" style={s.input}
            value={date} max={todayISO()}
            onChange={e => setDate(e.target.value)}
          />
        </div>
      </div>

      {/* Student list */}
      {loadingStud && <div style={s.loading}>Loading students…</div>}

      {!loadingStud && students.length > 0 && (
        <>
          {/* Bulk buttons */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
            <button onClick={() => toggleAll("present")} style={s.bulkBtn}>✓ All Present</button>
            <button onClick={() => toggleAll("absent")}  style={{ ...s.bulkBtn, background: "#fee2e2", color: "#dc2626" }}>
              ✗ All Absent
            </button>
            <span style={s.hint}>{presentCt} present · {absentCt} absent · {students.length - marked.length} unmarked</span>
          </div>

          {/* Student grid */}
          <div style={s.attendanceGrid}>
            {students.map(st => (
              <div key={st.uid} style={{
                ...s.attendanceCard,
                background: st.status === "present" ? "#dcfce7"
                  : st.status === "absent" ? "#fee2e2"
                  : "#f9fafb",
                borderColor: st.status === "present" ? "#16a34a"
                  : st.status === "absent" ? "#dc2626"
                  : "#e5e7eb",
              }}>
                <div style={s.attendanceStudentName}>{st.name}</div>
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <button
                    onClick={() => setOneStatus(st.uid, "present")}
                    style={{
                      ...s.attBtn,
                      background: st.status === "present" ? "#16a34a" : "#e5e7eb",
                      color:      st.status === "present" ? "#fff" : "#374151",
                    }}
                  >✓</button>
                  <button
                    onClick={() => setOneStatus(st.uid, "absent")}
                    style={{
                      ...s.attBtn,
                      background: st.status === "absent" ? "#dc2626" : "#e5e7eb",
                      color:      st.status === "absent" ? "#fff" : "#374151",
                    }}
                  >✗</button>
                </div>
              </div>
            ))}
          </div>

          {feedback && (
            <div style={{ ...s.feedback, background: feedback.ok ? "#dcfce7" : "#fee2e2",
              color: feedback.ok ? "#15803d" : "#dc2626", marginTop: 12 }}>
              {feedback.msg}
            </div>
          )}

          <button
            onClick={handleSave}
            disabled={submitting || marked.length === 0}
            style={{ ...s.submitBtn, marginTop: 16, opacity: marked.length === 0 ? 0.5 : 1 }}
          >
            {submitting ? "Saving…" : `💾 Save ${marked.length} Records`}
          </button>
        </>
      )}

      {!loadingStud && centerId && students.length === 0 && (
        <div style={s.emptyState}>No active students found for this centre.</div>
      )}
      {!centerId && (
        <div style={s.emptyState}>Select a centre to load students.</div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STUDENTS TAB
// ═══════════════════════════════════════════════════════════════════════════════

function StudentsTab({
  centers,
  user,
  onRefresh,
}: {
  centers: CenterOption[];
  user: ReturnType<typeof useAuth>["user"];
  onRefresh: () => Promise<void>;
}) {
  // We link to the students page with a query param to pre-fill a backdated admission date.
  // But since creating a user requires Firebase Auth (which needs email/password from the student),
  // this tab instead lets you SET the createdAt of an EXISTING student who was recently added
  // but should have an earlier admission date.

  const [students,     setStudents]     = useState<StudentOption[]>([]);
  const [studentUid,   setStudentUid]   = useState("");
  const [admissionDate, setAdmissionDate] = useState(todayISO());
  const [note,         setNote]         = useState("");
  const [submitting,   setSubmitting]   = useState(false);
  const [feedback,     setFeedback]     = useState<{ ok: boolean; msg: string } | null>(null);

  const chosenStudent = useMemo(() => students.find(s => s.uid === studentUid), [students, studentUid]);

  // Load all students for picker
  useEffect(() => {
    getDocs(query(collection(db, "users"), where("role", "==", "student"))).then(snap => {
      const studs: StudentOption[] = snap.docs.map(d => {
        const data = d.data();
        return {
          uid:        d.id,
          name:       (data.displayName as string) || "",
          studentID:  (data.studentID as string) || "",
          centerId:   (data.centerId as string) || "",
          centerName: "",
          billingMode: (data.billingMode as string) || "postpay",
          balance:    (data.currentBalance as number) ?? 0,
        };
      });
      setStudents(studs.sort((a, b) => a.name.localeCompare(b.name)));
    });
  }, []);

  async function handleSetAdmission(e: React.FormEvent) {
    e.preventDefault();
    if (!studentUid || !admissionDate || !user) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const newCreatedAt = new Date(`${admissionDate}T00:00:00`).toISOString();
      await updateDoc(doc(db, "users", studentUid), {
        createdAt:  newCreatedAt,
        backdatedAdmission: true,
        backdatedAdmissionNote: note,
        backdatedBy: user.uid,
        updatedAt:  new Date().toISOString(),
      });
      setFeedback({ ok: true, msg: `✅ Admission date updated to ${admissionDate} for ${chosenStudent?.name}` });
      setStudentUid(""); setNote(""); setAdmissionDate(todayISO());
      await onRefresh();
    } catch (err) {
      setFeedback({ ok: false, msg: `Error: ${String(err)}` });
    } finally {
      setSubmitting(false);
    }
  }

  // Bulk import form
  const [bulkCenterId,   setBulkCenterId]   = useState("");
  const [bulkRows,       setBulkRows]       = useState("");   // CSV-like
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkFeedback,   setBulkFeedback]   = useState<{ ok: boolean; msg: string } | null>(null);

  async function handleBulkNote(e: React.FormEvent) {
    e.preventDefault();
    if (!bulkCenterId || !bulkRows.trim() || !user) return;

    // Parse lines: "Name | YYYY-MM-DD | monthly/per_class | monthly_fee | fee_per_class"
    const lines = bulkRows.trim().split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return;

    setBulkSubmitting(true);
    setBulkFeedback(null);
    try {
      // We only update notes / registration records here.
      // Actual student accounts must be created via Students page (requires Auth).
      // This tab records historical enrollment notes.
      const writes = lines.map((line, i) => {
        const [name, dateStr, feeCycle, monthlyFee, feePerClass] = line.split("|").map(p => p.trim());
        if (!name || !dateStr) return null;
        return addDoc(collection(db, "historical_enrollment_notes"), {
          centerId:   bulkCenterId,
          name:       name || `Student ${i+1}`,
          enrollmentDate: dateStr || admissionDate,
          feeCycle:   feeCycle || "monthly",
          monthlyFee: parseFloat(monthlyFee || "0"),
          feePerClass: parseFloat(feePerClass || "0"),
          recordedBy: user.uid,
          backdated:  true,
          createdAt:  new Date().toISOString(),
        });
      }).filter(Boolean);

      await Promise.all(writes);
      setBulkFeedback({ ok: true, msg: `✅ Saved ${writes.length} historical enrollment notes.` });
      setBulkRows(""); setBulkCenterId("");
    } catch (err) {
      setBulkFeedback({ ok: false, msg: `Error: ${String(err)}` });
    } finally {
      setBulkSubmitting(false);
    }
  }

  return (
    <div style={s.tabContent}>
      {/* Section A — fix admission date */}
      <div style={s.sectionTitle}>Correct Student Admission Date</div>
      <p style={s.sectionDesc}>
        If a student was enrolled but entered into the system late, set their actual
        admission date here. This corrects their <code>createdAt</code> for trend reports.
      </p>

      <form onSubmit={handleSetAdmission} style={s.form}>
        <div style={s.twoCol}>
          <div style={s.formRow}>
            <label style={s.label}>Student *</label>
            <select style={s.select} value={studentUid}
              onChange={e => setStudentUid(e.target.value)} required>
              <option value="">— Select student —</option>
              {students.map(st => (
                <option key={st.uid} value={st.uid}>
                  {st.name} ({st.studentID})
                </option>
              ))}
            </select>
          </div>
          <div style={s.formRow}>
            <label style={s.label}>Actual Admission Date *</label>
            <input type="date" style={s.input}
              value={admissionDate} max={todayISO()}
              onChange={e => setAdmissionDate(e.target.value)}
              required
            />
          </div>
        </div>

        <div style={s.formRow}>
          <label style={s.label}>Reason / Note</label>
          <input type="text" style={s.input}
            placeholder="e.g. Late entry — joined Jan 2025"
            value={note} onChange={e => setNote(e.target.value)}
          />
        </div>

        {feedback && (
          <div style={{ ...s.feedback, background: feedback.ok ? "#dcfce7" : "#fee2e2",
            color: feedback.ok ? "#15803d" : "#dc2626" }}>
            {feedback.msg}
          </div>
        )}
        <button type="submit" disabled={submitting} style={s.submitBtn}>
          {submitting ? "Saving…" : "📅 Update Admission Date"}
        </button>
      </form>

      <hr style={{ margin: "32px 0", borderColor: "#e5e7eb" }} />

      {/* Section B — bulk historical enrollment notes */}
      <div style={s.sectionTitle}>Record Historical Enrollment Data (Bulk)</div>
      <p style={s.sectionDesc}>
        Log past student enrollments for trend analysis. One line per student.
        Format: <code>Name | YYYY-MM-DD | monthly | 1500 | 0</code>
        <br/>Fields: Name · Enrollment Date · Fee Cycle (monthly/per_class) · Monthly Fee · Fee Per Class
      </p>

      <form onSubmit={handleBulkNote} style={s.form}>
        <div style={s.formRow}>
          <label style={s.label}>Centre *</label>
          <select style={s.select} value={bulkCenterId}
            onChange={e => setBulkCenterId(e.target.value)} required>
            <option value="">— Select centre —</option>
            {centers.map(c => (
              <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
            ))}
          </select>
        </div>

        <div style={s.formRow}>
          <label style={s.label}>Student Records (one per line) *</label>
          <textarea
            style={{ ...s.input, height: 160, resize: "vertical", fontFamily: "monospace", fontSize: 13 }}
            placeholder={`Ravi Kumar | 2024-06-01 | monthly | 1500 | 0\nPriya Sharma | 2024-08-15 | per_class | 0 | 300`}
            value={bulkRows}
            onChange={e => setBulkRows(e.target.value)}
            required
          />
        </div>

        {bulkFeedback && (
          <div style={{ ...s.feedback, background: bulkFeedback.ok ? "#dcfce7" : "#fee2e2",
            color: bulkFeedback.ok ? "#15803d" : "#dc2626" }}>
            {bulkFeedback.msg}
          </div>
        )}
        <button type="submit" disabled={bulkSubmitting} style={s.submitBtn}>
          {bulkSubmitting ? "Saving…" : "📥 Import Historical Enrollments"}
        </button>
      </form>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════════════════

const s: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 900,
    margin: "0 auto",
    padding: "24px 20px",
    fontFamily: "system-ui, -apple-system, sans-serif",
    color: "#111827",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 24,
    flexWrap: "wrap",
    gap: 12,
  },
  title: {
    margin: 0,
    fontSize: 22,
    fontWeight: 700,
  },
  subtitle: {
    margin: "4px 0 0",
    fontSize: 14,
    color: "#6b7280",
  },
  adminBadge: {
    background: "#fef3c7",
    color: "#92400e",
    border: "1px solid #fde68a",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 13,
    fontWeight: 600,
  },
  tabBar: {
    display: "flex",
    gap: 4,
    borderBottom: "2px solid #e5e7eb",
    marginBottom: 24,
  },
  tabBtn: {
    padding: "10px 20px",
    border: "none",
    background: "none",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 500,
    color: "#6b7280",
    borderBottom: "2px solid transparent",
    marginBottom: -2,
    borderRadius: "4px 4px 0 0",
  },
  tabBtnActive: {
    color: "#b45309",
    borderBottomColor: "#b45309",
    background: "#fffbeb",
  },
  tabContent: {
    padding: "4px 0",
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 700,
    marginBottom: 6,
    color: "#111827",
  },
  sectionDesc: {
    fontSize: 14,
    color: "#6b7280",
    marginBottom: 20,
    lineHeight: 1.5,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  formRow: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  twoCol: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 16,
  },
  label: {
    fontSize: 13,
    fontWeight: 600,
    color: "#374151",
  },
  input: {
    padding: "9px 12px",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    fontSize: 14,
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
  },
  select: {
    padding: "9px 12px",
    border: "1px solid #d1d5db",
    borderRadius: 8,
    fontSize: 14,
    width: "100%",
    background: "#fff",
  },
  hint: {
    fontSize: 12,
    color: "#6b7280",
  },
  chipRow: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
  },
  chip: {
    padding: "6px 14px",
    border: "1.5px solid #d1d5db",
    borderRadius: 20,
    background: "#f9fafb",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
    color: "#374151",
  },
  chipActive: {
    background: "#fef3c7",
    borderColor: "#b45309",
    color: "#92400e",
  },
  submitBtn: {
    padding: "11px 24px",
    background: "#b45309",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    alignSelf: "flex-start",
  },
  feedback: {
    padding: "10px 14px",
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 500,
  },
  loading: {
    color: "#6b7280",
    fontSize: 14,
    padding: "20px 0",
  },
  emptyState: {
    padding: "32px 0",
    color: "#9ca3af",
    textAlign: "center",
    fontSize: 14,
  },
  bulkBtn: {
    padding: "6px 14px",
    border: "none",
    borderRadius: 6,
    background: "#dcfce7",
    color: "#16a34a",
    fontWeight: 600,
    fontSize: 13,
    cursor: "pointer",
  },
  attendanceGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
    gap: 10,
  },
  attendanceCard: {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1.5px solid #e5e7eb",
    cursor: "pointer",
  },
  attendanceStudentName: {
    fontSize: 13,
    fontWeight: 600,
    color: "#111827",
  },
  attBtn: {
    width: 36,
    height: 28,
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    fontWeight: 700,
    fontSize: 14,
  },
};

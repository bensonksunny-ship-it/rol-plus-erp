"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/config/firebase";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import {
  getLessonsByCenter,
  getItemsByLesson,
  getLessonsForStudent,
} from "@/services/lesson/lesson.service";
import { seedMasterSyllabus } from "@/services/syllabus/lm-syllabus.service";
import { TRACK_UI_CONFIG, PROGRAM_LABELS, COURSE_LABELS, MASTER_COURSE_DATA } from "@/services/syllabus/lm-master.data";
import { parseFile } from "@/lib/xlsx-parser";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";
import type { Lesson } from "@/types/lesson";
import type {
  LittleMozartsTrack,
  MasterSyllabusItem,
  LMItemType,
  LMProgram,
  LMCourse,
} from "@/types/syllabus";

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function SyllabusPage() {
  return (
    <ProtectedRoute allowedRoles={[ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.TEACHER]}>
      <SyllabusContent />
    </ProtectedRoute>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface StudentOption {
  uid:         string;
  displayName: string;
  studentID:   string;
  admissionNo: string;
  centerId:    string;
}

interface CenterOption {
  id:   string;
  name: string;
}

interface LessonWithCount extends Lesson {
  itemCount: number;
}

type Tab = "lessons" | "track" | "master";

// ─── Master tab helpers ───────────────────────────────────────────────────────

const TRACK_LABELS: Record<LittleMozartsTrack, string> = {
  delta_track:   "Level 1: Delta Track Template",
  epsilon_track: "Level 2: Epsilon Track Template",
  zeta_track:    "Level 3: Zeta Track Template",
};

const TRACK_SHORT: Record<LittleMozartsTrack, string> = {
  delta_track:   "Delta",
  epsilon_track: "Epsilon",
  zeta_track:    "Zeta",
};

const TRACK_COLORS: Record<LittleMozartsTrack, { bg: string; border: string; accent: string }> = {
  delta_track:   { bg: "#eff6ff", border: "#bfdbfe", accent: "#2563eb" },
  epsilon_track: { bg: "#f0fdf4", border: "#bbf7d0", accent: "#15803d" },
  zeta_track:    { bg: "#faf5ff", border: "#ddd6fe", accent: "#7c3aed" },
};

const SYLLABUS_SLOTS: Array<{ track: LittleMozartsTrack; course: LMCourse }> = [
  { track: "delta_track",   course: "course_1_1" },
  { track: "delta_track",   course: "course_1_2" },
  { track: "epsilon_track", course: "course_1_1" },
  { track: "epsilon_track", course: "course_1_2" },
  { track: "zeta_track",    course: "course_1_1" },
  { track: "zeta_track",    course: "course_1_2" },
];

const VALID_ITEM_TYPES = ["concept", "exercise", "songsheet"] as const;

const TYPE_COLORS: Record<string, React.CSSProperties> = {
  concept:   { background: "#ede9fe", color: "#4f46e5" },
  exercise:  { background: "#dcfce7", color: "#15803d" },
  songsheet: { background: "#fef9c3", color: "#a16207" },
  _other:    { background: "#fee2e2", color: "#b91c1c" },
};

function mapToMasterItems(
  rows: Record<string, string>[],
  track: LittleMozartsTrack,
): MasterSyllabusItem[] {
  const cfg = TRACK_UI_CONFIG[track];
  return rows.map(r => {
    const it       = r["itemtype"]?.trim().toLowerCase() as LMItemType;
    const isConcept = it === "concept";
    return {
      lessonNumber:   parseInt(r["lessonnumber"] ?? "0", 10),
      lessonName:     r["lessonname"]?.trim() ?? "",
      itemType:       it,
      itemTitle:      r["itemtitle"]?.trim() ?? "",
      metronomeBpm:   isConcept ? null : cfg.metronomeBpm,
      handAllocation: isConcept ? null : cfg.handIntegration,
    };
  });
}

function validateMasterRows(rows: Record<string, string>[]): string[] {
  const errors: string[] = [];
  const headers = Object.keys(rows[0] ?? {});
  const required = ["lessonnumber", "lessonname", "itemtype", "itemtitle"];

  for (const col of required) {
    if (!headers.includes(col)) errors.push(`Missing required column: "${col}"`);
  }
  if (errors.length > 0) return errors;

  rows.forEach((r, i) => {
    const rowNum = i + 2;
    if (!r["lessonname"]?.trim()) errors.push(`Row ${rowNum}: lessonName is required`);
    if (!r["itemtitle"]?.trim())  errors.push(`Row ${rowNum}: itemTitle is required`);
    const it = r["itemtype"]?.trim().toLowerCase();
    if (!VALID_ITEM_TYPES.includes(it as typeof VALID_ITEM_TYPES[number])) {
      errors.push(`Row ${rowNum}: invalid itemType "${it}" — must be concept, exercise, or songsheet`);
    }
    const ln = parseInt(r["lessonnumber"] ?? "0", 10);
    if (isNaN(ln) || ln < 1) errors.push(`Row ${rowNum}: lessonNumber must be a positive integer`);
    if (ln === 10 && it === "concept") {
      errors.push(`Row ${rowNum}: Lesson 10 may not contain concept items (pure-exercise rule)`);
    }
  });

  return errors;
}

// ─── Content ──────────────────────────────────────────────────────────────────

function SyllabusContent() {
  const { role }                              = useAuth();
  const router                                = useRouter();
  const [tab, setTab]                         = useState<Tab>("lessons");
  const [centers, setCenters]                 = useState<CenterOption[]>([]);
  const [students, setStudents]               = useState<StudentOption[]>([]);
  const [selectedCenter, setSelectedCenter]   = useState<string>("");
  const [lessons, setLessons]                 = useState<LessonWithCount[]>([]);
  const [loading, setLoading]                 = useState(false);
  const [initialising, setInitialising]       = useState(true);
  const { toasts, toast, remove }             = useToast();

  // Track tab state
  const [trackStudent, setTrackStudent]           = useState<string>("");
  const [trackLessonCount, setTrackLessonCount]   = useState<number | null>(null);
  const [trackLoadingCount, setTrackLoadingCount] = useState(false);

  // Master tab state
  const masterFileRef                           = useRef<HTMLInputElement>(null);
  const [masterProgram, setMasterProgram]       = useState<LMProgram>("intro_keyboard");
  const [masterTrack, setMasterTrack]           = useState<LittleMozartsTrack>("epsilon_track");
  const [masterCourse, setMasterCourse]         = useState<LMCourse>("course_1_1");
  const [masterFile, setMasterFile]             = useState<File | null>(null);
  const [masterRawRows, setMasterRawRows]       = useState<Record<string, string>[]>([]);
  const [masterPreview, setMasterPreview]       = useState<MasterSyllabusItem[]>([]);
  const [masterErrors, setMasterErrors]         = useState<string[]>([]);
  const [masterValid, setMasterValid]           = useState(false);
  const [masterImporting, setMasterImporting]   = useState(false);
  const [masterDragOver, setMasterDragOver]     = useState(false);
  const [masterTrackPreview, setMasterTrackPreview] = useState<MasterSyllabusItem[] | null>(null);

  // ─── Load centers + students ─────────────────────────────────────────────

  useEffect(() => {
    async function init() {
      try {
        const [centersSnap, studentsSnap] = await Promise.all([
          getDocs(collection(db, "centers")),
          getDocs(query(collection(db, "users"), where("role", "==", "student"))),
        ]);
        setCenters(centersSnap.docs.map(d => ({ id: d.id, name: (d.data().name as string) ?? d.id })));
        setStudents(studentsSnap.docs.map(d => {
          const dt = d.data();
          return {
            uid:         d.id,
            displayName: (dt.displayName as string) ?? (dt.name as string) ?? "",
            studentID:   (dt.studentID  as string) ?? "",
            admissionNo: (dt.admissionNo as string) ?? (dt.admissionNumber as string) ?? "",
            centerId:    (dt.centerId   as string) ?? "",
          };
        }));
      } catch {
        toast("Failed to load centers/students.", "error");
      } finally {
        setInitialising(false);
      }
    }
    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Lessons tab ─────────────────────────────────────────────────────────

  const loadLessons = useCallback(async (centerId: string) => {
    if (!centerId) { setLessons([]); return; }
    setLoading(true);
    setLessons([]);
    try {
      const data   = await getLessonsByCenter(centerId);
      const counts = await Promise.all(data.map(l => getItemsByLesson(l.id)));
      setLessons(data.map((l, i) => ({ ...l, itemCount: counts[i]?.length ?? 0 })));
      if (data.length === 0) toast("No lessons found for this center.", "success");
    } catch (err) {
      toast(`Failed to load lessons: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleCenterChange(centerId: string) {
    setSelectedCenter(centerId);
    setLessons([]);
    loadLessons(centerId);
  }

  // ─── Track tab ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!trackStudent) { setTrackLessonCount(null); return; }
    setTrackLoadingCount(true);
    getLessonsForStudent(trackStudent)
      .then(data => setTrackLessonCount(data.lessons.length))
      .catch(() => setTrackLessonCount(null))
      .finally(() => setTrackLoadingCount(false));
  }, [trackStudent]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Master tab ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (masterRawRows.length === 0) return;
    setMasterPreview(mapToMasterItems(masterRawRows, masterTrack));
  }, [masterTrack]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleMasterFile(file: File) {
    setMasterFile(file);
    setMasterPreview([]);
    setMasterErrors([]);
    setMasterValid(false);
    setMasterRawRows([]);

    const { rows, error } = await parseFile(file);
    if (error)          { setMasterErrors([error]); return; }
    if (rows.length === 0) { setMasterErrors(["File has no data rows."]); return; }

    setMasterRawRows(rows);
    const errs = validateMasterRows(rows);
    setMasterErrors(errs);
    setMasterValid(errs.length === 0);
    if (errs.length === 0) setMasterPreview(mapToMasterItems(rows, masterTrack));
  }

  function handleMasterDrop(e: React.DragEvent) {
    e.preventDefault();
    setMasterDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleMasterFile(file);
  }

  async function handleMasterImport() {
    if (masterImporting || !masterValid || masterPreview.length === 0) return;
    // Snapshot all state synchronously before any async work or state mutation
    const target   = { program: masterProgram, track: masterTrack, course: masterCourse } as const;
    const items    = masterPreview;
    const rowCount = masterPreview.length;
    setMasterImporting(true);
    try {
      await seedMasterSyllabus(target, items);
      toast(
        `${COURSE_LABELS[target.course]} template saved — ${PROGRAM_LABELS[target.program]} › ${TRACK_LABELS[target.track]} · ${rowCount} rows imported.`,
        "success",
      );
      resetMaster();
    } catch (err) {
      toast(`Upload failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setMasterImporting(false);
    }
  }

  function resetMaster() {
    setMasterFile(null);
    setMasterRawRows([]);
    setMasterPreview([]);
    setMasterErrors([]);
    setMasterValid(false);
    setMasterDragOver(false);
    if (masterFileRef.current) masterFileRef.current.value = "";
    // Intentionally not resetting program/track/course — those are user choices
    // that should persist across uploads in the same session.
  }

  const isAdmin       = role === "admin" || role === "super_admin";
  const uniqueLessons = Array.from(new Set(masterPreview.map(r => r.lessonNumber))).sort((a, b) => a - b);

  const previewByLesson = useMemo(() => {
    if (!masterTrackPreview) return [];
    const map = new Map<number, { lessonName: string; items: MasterSyllabusItem[] }>();
    for (const item of masterTrackPreview) {
      if (!map.has(item.lessonNumber)) map.set(item.lessonNumber, { lessonName: item.lessonName, items: [] });
      map.get(item.lessonNumber)!.items.push(item);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a - b)
      .map(([num, { lessonName, items }]) => ({ num, lessonName, items }));
  }, [masterTrackPreview]);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={{ background: "#fff", minHeight: "100%", color: "#111" }}>
      <ToastContainer toasts={toasts} onRemove={remove} />

      <div style={s.header}>
        <h1 style={s.heading}>Syllabus</h1>
      </div>

      {/* Tabs */}
      <div style={s.tabs}>
        {(["lessons", "track", ...(isAdmin ? ["master"] : [])] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ ...s.tab, ...(tab === t ? s.tabActive : {}) }}
          >
            {t === "lessons" ? "📚 Lessons" : t === "track" ? "📊 Track" : "🎼 Master"}
          </button>
        ))}
      </div>

      {/* ─── LESSONS TAB ─────────────────────────────────────────────────── */}
      {tab === "lessons" && (
        <>
          <div style={s.filterCard}>
            <div style={s.filterTitle}>Select Center</div>
            <select
              value={selectedCenter}
              onChange={e => handleCenterChange(e.target.value)}
              style={s.select}
              disabled={initialising}
            >
              <option value="">— Select center —</option>
              {centers.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            {loading && <span style={s.loadingText}>Loading lessons…</span>}
            {isAdmin && selectedCenter && (
              <button
                onClick={() => router.push(`/dashboard/lessons/import?scope=center&id=${selectedCenter}`)}
                style={{ ...s.importBtn, marginLeft: "auto" }}
              >
                ↑ Import Syllabus
              </button>
            )}
          </div>

          {lessons.length > 0 && (
            <div style={s.tableWrapper}>
              <div style={s.tableHeader}>
                <span style={s.tableTitle}>
                  {lessons.length} lesson{lessons.length !== 1 ? "s" : ""}
                  {" · "}{centers.find(c => c.id === selectedCenter)?.name ?? ""}
                </span>
              </div>
              <table style={s.table}>
                <thead>
                  <tr>
                    {["Order", "No.", "Title", "Items"].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lessons.map((lesson, i) => (
                    <tr key={lesson.id} style={i % 2 === 0 ? s.rowEven : s.rowOdd}>
                      <td style={{ ...s.td, ...s.mono }}>{lesson.order}</td>
                      <td style={{ ...s.td, ...s.mono }}>{lesson.lessonNumber}</td>
                      <td style={{ ...s.td, fontWeight: 600, color: "#111" }}>{lesson.title}</td>
                      <td style={{ ...s.td, ...s.mono }}>
                        <span style={s.itemCountBadge}>{lesson.itemCount}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!loading && lessons.length === 0 && (
            <div style={s.emptyState}>
              <div style={s.emptyIcon}>📚</div>
              <div style={s.emptyText}>
                {selectedCenter ? "No lessons found for this center." : "Select a center above to view its lessons."}
              </div>
              {isAdmin && (
                <div style={s.emptyHint}>
                  No lessons yet?{" "}
                  <button
                    onClick={() =>
                      router.push(selectedCenter
                        ? `/dashboard/lessons/import?scope=center&id=${selectedCenter}`
                        : "/dashboard/lessons/import")
                    }
                    style={s.linkBtn}
                  >
                    Import from Excel
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ─── TRACK TAB ───────────────────────────────────────────────────── */}
      {tab === "track" && (
        <div style={s.trackCard}>
          <div style={s.trackTitle}>Track Student Progress</div>
          <div style={s.fieldGroup}>
            <label style={s.label}>Student</label>
            <select
              value={trackStudent}
              onChange={e => setTrackStudent(e.target.value)}
              style={s.select}
              disabled={initialising}
            >
              <option value="">— Select student —</option>
              {students.map(st => (
                <option key={st.uid} value={st.uid}>
                  {st.studentID ? `[${st.studentID}] ` : (st.admissionNo ? `[${st.admissionNo}] ` : "")}
                  {st.displayName || st.uid}
                  {st.centerId ? ` · ${centers.find(c => c.id === st.centerId)?.name ?? st.centerId}` : ""}
                </option>
              ))}
            </select>
          </div>
          {trackStudent ? (
            <>
              <div style={s.trackStatus}>
                {trackLoadingCount ? (
                  <span style={s.trackStatusChecking}>Checking syllabus…</span>
                ) : trackLessonCount === null ? null : trackLessonCount === 0 ? (
                  <span style={s.trackStatusNone}>
                    ⚠ No lessons assigned to this student yet — import one below
                  </span>
                ) : (
                  <span style={s.trackStatusFound}>
                    ✓ {trackLessonCount} lesson{trackLessonCount !== 1 ? "s" : ""} found for this student
                  </span>
                )}
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                <button
                  onClick={() => router.push(`/dashboard/student-syllabus/${trackStudent}`)}
                  style={s.viewProgressBtn}
                >
                  View Full Syllabus Progress →
                </button>
                {isAdmin && (
                  <button
                    onClick={() =>
                      router.push(`/dashboard/lessons/import?scope=student&id=${trackStudent}`)
                    }
                    style={s.importBtn}
                  >
                    ↑ Import Custom Lessons
                  </button>
                )}
              </div>
            </>
          ) : (
            <div style={s.emptyInline}>Select a student above to view their progress.</div>
          )}
        </div>
      )}

      {/* ─── MASTER TAB ──────────────────────────────────────────────────── */}
      {tab === "master" && isAdmin && (
        <div>
          {/* Bento grid — pathway selector + upload zone */}
          <div style={s.bentoGrid}>

            {/* Card 1: Program + Slot grid */}
            <div style={s.bentoCard}>
              <div style={s.bentoCardLabel}>Import Target</div>
              <div style={s.programHeader}>
                <span style={s.programIcon}>🎹</span>
                <span style={s.programTitle}>{PROGRAM_LABELS[masterProgram]}</span>
              </div>
              <div style={s.slotGrid}>
                {SYLLABUS_SLOTS.map(slot => {
                  const cfg      = TRACK_UI_CONFIG[slot.track];
                  const isActive = masterTrack === slot.track && masterCourse === slot.course;
                  const colors   = TRACK_COLORS[slot.track];
                  return (
                    <div
                      key={`${slot.track}_${slot.course}`}
                      onClick={() => {
                        setMasterTrack(slot.track);
                        setMasterCourse(slot.course);
                        setMasterTrackPreview(MASTER_COURSE_DATA[slot.track][slot.course]);
                      }}
                      style={{
                        ...s.slotCard,
                        background: isActive ? "#4f46e5" : colors.bg,
                        border:     `1.5px solid ${isActive ? "#4f46e5" : colors.border}`,
                      }}
                    >
                      <div style={{ ...s.slotTrackName, color: isActive ? "#fff" : colors.accent }}>
                        {TRACK_SHORT[slot.track]}
                      </div>
                      <div style={{ ...s.slotCourseNum, color: isActive ? "rgba(255,255,255,0.9)" : "#111" }}>
                        {COURSE_LABELS[slot.course]}
                      </div>
                      <div style={{ ...s.slotMeta, color: isActive ? "rgba(255,255,255,0.6)" : "#9ca3af" }}>
                        {cfg.metronome ? `${cfg.metronomeBpm} BPM` : "No metronome"}
                        {" · "}{cfg.handIntegration}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Card 2: Upload zone */}
            <div style={s.bentoCard}>
              <div style={s.bentoCardLabel}>Import File</div>
              <div
                onDrop={handleMasterDrop}
                onDragOver={e => { e.preventDefault(); setMasterDragOver(true); }}
                onDragLeave={() => setMasterDragOver(false)}
                onClick={() => masterFileRef.current?.click()}
                style={{ ...s.dropZone, ...(masterDragOver ? s.dropZoneActive : {}) }}
              >
                <div style={s.dropIcon}>
                  {masterFile ? "📄" : "📥"}
                </div>
                <div style={s.dropText}>
                  {masterFile ? masterFile.name : "Drag & drop .xlsx or .csv here"}
                </div>
                {masterFile && masterPreview.length > 0 && (
                  <div style={{ ...s.dropHint, color: "#16a34a", fontWeight: 600 }}>
                    {masterPreview.length} rows · {uniqueLessons.length} lessons
                  </div>
                )}
                {!masterFile && (
                  <div style={s.dropHint}>or click to browse</div>
                )}
              </div>
              <input
                ref={masterFileRef}
                type="file"
                accept=".xlsx,.csv"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleMasterFile(f); }}
                style={{ display: "none" }}
              />
              <button
                onClick={() => masterFileRef.current?.click()}
                style={s.uploadBtn}
              >
                Import Course Syllabus from Excel
              </button>

              {/* Required columns hint */}
              <div style={s.colHint}>
                Required columns:{" "}
                {["lessonNumber", "lessonName", "itemType", "itemTitle"].map(c => (
                  <span key={c} style={s.colChip}>{c}</span>
                ))}
              </div>
            </div>
          </div>

          {/* Track syllabus preview */}
          {masterTrackPreview && previewByLesson.length > 0 && (
            <div style={s.trackPreviewPanel}>
              <div style={s.trackPreviewHeader}>
                <span style={s.trackPreviewTitle}>
                  {TRACK_LABELS[masterTrack]} — Syllabus Preview
                </span>
                <span style={s.trackPreviewCount}>
                  {masterTrackPreview.length} items · {previewByLesson.length} lessons
                </span>
              </div>
              <div style={s.trackPreviewBody}>
                {previewByLesson.map(({ num, lessonName, items }) => (
                  <div key={num} style={s.lessonGroup}>
                    <div style={s.lessonGroupHeader}>
                      <span style={s.lessonNum}>Lesson {num}</span>
                      <span style={s.lessonName}>{lessonName}</span>
                    </div>
                    <div style={s.lessonItems}>
                      {items.map((item, i) => (
                        <div key={i} style={s.lessonItem}>
                          <span style={{ ...s.typeBadge, ...(TYPE_COLORS[item.itemType] ?? TYPE_COLORS._other) }}>
                            {item.itemType}
                          </span>
                          <span style={s.lessonItemTitle}>{item.itemTitle}</span>
                          {item.metronomeBpm && (
                            <span style={s.lessonItemMeta}>{item.metronomeBpm} BPM</span>
                          )}
                          {item.handAllocation && (
                            <span style={s.lessonItemMeta}>{item.handAllocation}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Validation errors */}
          {masterErrors.length > 0 && (
            <div style={s.errorBox}>
              <div style={s.errorTitle}>✕ {masterErrors.length} error{masterErrors.length !== 1 ? "s" : ""}</div>
              {masterErrors.slice(0, 15).map((e, i) => (
                <div key={i} style={s.errorRow}>• {e}</div>
              ))}
              {masterErrors.length > 15 && (
                <div style={s.errorRow}>…and {masterErrors.length - 15} more</div>
              )}
            </div>
          )}

          {/* Validation success banner */}
          {masterValid && masterPreview.length > 0 && (
            <div style={s.successBox}>
              ✓ {masterPreview.length} row{masterPreview.length !== 1 ? "s" : ""} validated
              {" · "}{uniqueLessons.length} lesson{uniqueLessons.length !== 1 ? "s" : ""} ready
              {" · "}Destination:{" "}
              <strong>
                {PROGRAM_LABELS[masterProgram]} › {COURSE_LABELS[masterCourse]} › {TRACK_LABELS[masterTrack]}
              </strong>
            </div>
          )}

          {/* Preview table */}
          {masterValid && masterPreview.length > 0 && (
            <div style={{ ...s.tableWrapper, marginBottom: 16 }}>
              <div style={s.tableHeader}>
                <span style={s.tableTitle}>Preview — first 25 rows</span>
                {masterPreview.length > 25 && (
                  <span style={{ fontSize: 11, color: "#9ca3af" }}>
                    +{masterPreview.length - 25} more rows not shown
                  </span>
                )}
              </div>
              <table style={s.table}>
                <thead>
                  <tr>
                    {["#", "Lesson", "Lesson Name", "Type", "Title", "BPM", "Hand"].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {masterPreview.slice(0, 25).map((item, i) => (
                    <tr key={i} style={i % 2 === 0 ? s.rowEven : s.rowOdd}>
                      <td style={{ ...s.td, ...s.mono }}>{i + 1}</td>
                      <td style={{ ...s.td, ...s.mono }}>{item.lessonNumber}</td>
                      <td style={{ ...s.td, fontSize: 12, color: "#374151" }}>{item.lessonName}</td>
                      <td style={s.td}>
                        <span style={{ ...s.typeBadge, ...(TYPE_COLORS[item.itemType] ?? TYPE_COLORS._other) }}>
                          {item.itemType}
                        </span>
                      </td>
                      <td style={s.td}>{item.itemTitle}</td>
                      <td style={{ ...s.td, ...s.mono, color: item.metronomeBpm ? "#059669" : "#9ca3af" }}>
                        {item.metronomeBpm ?? "—"}
                      </td>
                      <td style={{ ...s.td, fontSize: 11, color: "#6b7280" }}>
                        {item.handAllocation ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Actions */}
          {masterFile && (
            <div style={s.actions}>
              <button onClick={resetMaster} style={s.resetBtn}>Reset</button>
              {masterValid && (
                <button
                  onClick={handleMasterImport}
                  disabled={masterImporting}
                  style={{ ...s.confirmBtn, opacity: masterImporting ? 0.6 : 1, cursor: masterImporting ? "not-allowed" : "pointer" }}
                >
                  {masterImporting
                    ? "Saving to Firestore…"
                    : `Confirm Upload → ${PROGRAM_LABELS[masterProgram]} / ${COURSE_LABELS[masterCourse]}`}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  header:    { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 },
  heading:   { fontSize: 24, fontWeight: 700, color: "#111", margin: 0 },
  importBtn: {
    background:   "#4f46e5",
    color:        "#fff",
    border:       "none",
    padding:      "9px 18px",
    borderRadius: 8,
    fontSize:     13,
    fontWeight:   700,
    cursor:       "pointer",
  },

  tabs: {
    display:      "flex",
    gap:          4,
    marginBottom: 20,
    background:   "#f3f4f6",
    borderRadius: 12,
    padding:      4,
    border:       "1px solid #e5e7eb",
  },
  tab: {
    flex:         1,
    padding:      "9px 0",
    borderRadius: 8,
    border:       "none",
    background:   "transparent",
    fontSize:     13,
    fontWeight:   500,
    color:        "#6b7280",
    cursor:       "pointer",
    textAlign:    "center" as const,
  },
  tabActive: {
    background: "#fff",
    color:      "#4f46e5",
    fontWeight: 700,
    boxShadow:  "0 1px 4px rgba(0,0,0,0.10)",
  },

  filterCard: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 12,
    padding:      "16px 20px",
    marginBottom: 16,
    display:      "flex",
    alignItems:   "center",
    gap:          14,
    flexWrap:     "wrap" as const,
    boxShadow:    "0 1px 3px rgba(0,0,0,0.06)",
  },
  filterTitle: { fontSize: 10, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: "0.1em" },
  loadingText: { fontSize: 12, color: "#9ca3af", fontStyle: "italic" as const },

  select: {
    padding:      "9px 12px",
    border:       "1px solid #d1d5db",
    borderRadius: 8,
    fontSize:     13,
    color:        "#111",
    background:   "#fff",
    outline:      "none",
    minWidth:     200,
    cursor:       "pointer",
  },

  tableWrapper: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 12,
    overflow:     "hidden",
    marginBottom: 16,
    boxShadow:    "0 1px 3px rgba(0,0,0,0.06)",
  },
  tableHeader: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    padding:        "14px 18px",
    borderBottom:   "1px solid #e5e7eb",
    background:     "#f9fafb",
  },
  tableTitle:  { fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: "0.06em" },
  table:       { width: "100%", borderCollapse: "collapse" as const },
  th: {
    padding:       "10px 18px",
    textAlign:     "left" as const,
    fontSize:      11,
    fontWeight:    600,
    color:         "#6b7280",
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    background:    "#f9fafb",
    borderBottom:  "1px solid #e5e7eb",
  },
  td: {
    padding:      "12px 18px",
    fontSize:     13,
    color:        "#111",
    borderBottom: "1px solid #f3f4f6",
  },
  rowEven: { background: "#fff" },
  rowOdd:  { background: "#fafafa" },
  mono:    { fontFamily: "monospace", fontSize: 12, color: "#6b7280" },
  itemCountBadge: {
    background:   "#fef3c7",
    color:        "#92400e",
    padding:      "2px 8px",
    borderRadius: 99,
    fontSize:     11,
    fontWeight:   700,
    fontFamily:   "monospace",
  },

  emptyState: { padding: "56px 16px", textAlign: "center" as const },
  emptyIcon:  { fontSize: 44, marginBottom: 14 },
  emptyText:  { fontSize: 14, color: "#374151", marginBottom: 8 },
  emptyHint:  { fontSize: 13, color: "#6b7280" },
  linkBtn: {
    background:     "none",
    border:         "none",
    color:          "#4f46e5",
    cursor:         "pointer",
    fontWeight:     700,
    fontSize:       13,
    padding:        0,
    textDecoration: "underline",
  },
  emptyInline: { padding: "16px 0", fontSize: 13, color: "#6b7280" },

  fieldGroup: { marginBottom: 18 },
  label: {
    display:       "block",
    fontSize:      11,
    fontWeight:    600,
    color:         "#374151",
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    marginBottom:  7,
  },

  trackCard: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 12,
    padding:      "22px",
    boxShadow:    "0 1px 3px rgba(0,0,0,0.06)",
  },
  trackTitle:          { fontSize: 15, fontWeight: 700, color: "#111", marginBottom: 18 },
  trackStatus:         { marginTop: 10, fontSize: 12 },
  trackStatusChecking: { color: "#9ca3af", fontStyle: "italic" as const },
  trackStatusNone:     { color: "#d97706", fontWeight: 600 },
  trackStatusFound:    { color: "#16a34a", fontWeight: 600 },
  viewProgressBtn: {
    background:   "#059669",
    color:        "#fff",
    border:       "none",
    padding:      "11px 24px",
    borderRadius: 8,
    fontSize:     13,
    fontWeight:   700,
    cursor:       "pointer",
    marginTop:    10,
  },

  // ─── Master tab ────────────────────────────────────────────────────────────
  bentoGrid: {
    display:             "grid",
    gridTemplateColumns: "1fr 1fr",
    gap:                 16,
    marginBottom:        16,
  },
  bentoCard: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 14,
    padding:      "22px",
    boxShadow:    "0 1px 3px rgba(0,0,0,0.06)",
  },
  bentoCardLabel: {
    fontSize:      10,
    fontWeight:    700,
    color:         "#6b7280",
    textTransform: "uppercase" as const,
    letterSpacing: "0.12em",
    marginBottom:  16,
  },

  programHeader: {
    display:      "flex",
    alignItems:   "center",
    gap:          8,
    padding:      "9px 13px",
    background:   "#f9fafb",
    borderRadius: 8,
    marginBottom: 14,
    border:       "1px solid #e5e7eb",
  },
  programIcon:  { fontSize: 16 },
  programTitle: { fontSize: 13, fontWeight: 700, color: "#111" },

  slotGrid: {
    display:             "grid",
    gridTemplateColumns: "1fr 1fr",
    gap:                 8,
  },
  slotCard: {
    borderRadius: 10,
    padding:      "13px 14px",
    cursor:       "pointer",
  },
  slotTrackName: {
    fontSize:     15,
    fontWeight:   800,
    marginBottom: 2,
    lineHeight:   1,
  },
  slotCourseNum: {
    fontSize:     12,
    fontWeight:   600,
    marginBottom: 5,
  },
  slotMeta: {
    fontSize:   10,
    lineHeight: 1.3,
  },

  dropZone: {
    border:        "2px dashed #d1d5db",
    borderRadius:  12,
    padding:       "30px 16px",
    textAlign:     "center" as const,
    cursor:        "pointer",
    marginBottom:  12,
    background:    "#fafafa",
  },
  dropZoneActive: {
    border:     "2px dashed #4f46e5",
    background: "#f5f3ff",
  },
  dropIcon: { fontSize: 28, marginBottom: 8 },
  dropText: { fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 4 },
  dropHint: { fontSize: 12, color: "#9ca3af" },

  uploadBtn: {
    width:        "100%",
    background:   "#f9fafb",
    border:       "1px solid #e5e7eb",
    color:        "#374151",
    padding:      "10px 0",
    borderRadius: 8,
    fontSize:     13,
    fontWeight:   600,
    cursor:       "pointer",
    marginBottom: 12,
  },
  colHint: {
    display:    "flex",
    flexWrap:   "wrap" as const,
    alignItems: "center",
    gap:        5,
    fontSize:   11,
    color:      "#9ca3af",
  },
  colChip: {
    background:   "#f3f4f6",
    color:        "#374151",
    padding:      "1px 7px",
    borderRadius: 99,
    fontFamily:   "monospace",
    fontSize:     10,
    fontWeight:   600,
  },

  errorBox:   { background: "#fff5f5", border: "1px solid #fca5a5", borderRadius: 10, padding: "14px 18px", marginBottom: 14 },
  errorTitle: { fontSize: 12, fontWeight: 700, color: "#dc2626", marginBottom: 8 },
  errorRow:   { fontSize: 12, color: "#b91c1c", marginBottom: 3 },

  successBox: {
    background:   "#f0fdf4",
    border:       "1px solid #86efac",
    borderRadius: 10,
    padding:      "11px 18px",
    marginBottom: 14,
    fontSize:     13,
    fontWeight:   500,
    color:        "#15803d",
  },

  typeBadge: { padding: "2px 8px", borderRadius: 99, fontSize: 11, fontWeight: 600, textTransform: "capitalize" as const },

  trackPreviewPanel: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 14,
    marginBottom: 16,
    overflow:     "hidden",
    boxShadow:    "0 1px 3px rgba(0,0,0,0.06)",
  },
  trackPreviewHeader: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    padding:        "14px 20px",
    background:     "#f9fafb",
    borderBottom:   "1px solid #e5e7eb",
  },
  trackPreviewTitle: {
    fontSize:      11,
    fontWeight:    700,
    color:         "#374151",
    textTransform: "uppercase" as const,
    letterSpacing: "0.07em",
  },
  trackPreviewCount: {
    fontSize: 11,
    color:    "#9ca3af",
  },
  trackPreviewBody: {
    padding:    "16px 20px",
    display:    "flex",
    flexDirection: "column" as const,
    gap:        12,
  },
  lessonGroup: {
    borderRadius: 8,
    border:       "1px solid #f3f4f6",
    overflow:     "hidden",
  },
  lessonGroupHeader: {
    display:     "flex",
    alignItems:  "center",
    gap:         10,
    padding:     "8px 14px",
    background:  "#f9fafb",
    borderBottom: "1px solid #f3f4f6",
  },
  lessonNum: {
    fontFamily:  "monospace",
    fontSize:    10,
    fontWeight:  700,
    color:       "#4f46e5",
    background:  "#ede9fe",
    padding:     "2px 7px",
    borderRadius: 99,
    flexShrink:  0,
  },
  lessonName: {
    fontSize:   12,
    fontWeight: 600,
    color:      "#374151",
  },
  lessonItems: {
    display:       "flex",
    flexDirection: "column" as const,
  },
  lessonItem: {
    display:     "flex",
    alignItems:  "center",
    gap:         8,
    padding:     "7px 14px",
    borderBottom: "1px solid #f9fafb",
  },
  lessonItemTitle: {
    fontSize:   12,
    color:      "#111",
    flex:       1,
  },
  lessonItemMeta: {
    fontSize:   11,
    color:      "#9ca3af",
    fontFamily: "monospace",
    flexShrink: 0,
  },

  actions:    { display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4 },
  resetBtn:   { background: "#f3f4f6", color: "#374151", border: "none", padding: "10px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  confirmBtn: {
    background:    "#4f46e5",
    color:         "#fff",
    border:        "none",
    padding:       "11px 28px",
    borderRadius:  8,
    fontSize:      13,
    fontWeight:    700,
    letterSpacing: "0.02em",
  },
};

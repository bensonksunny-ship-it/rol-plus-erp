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
import {
  seedMasterSyllabus,
  getMasterSyllabusWithMeta,
  deleteMasterSyllabus,
  getStudentSyllabus,
  updateStudentSyllabusItems,
} from "@/services/syllabus/lm-syllabus.service";
import {
  TRACK_UI_CONFIG,
  PROGRAM_LABELS,
  COURSE_LABELS,
  TRACK_LABELS,
  TRACK_SHORT,
  PROGRAM_SLOTS,
  isTrackBasedProgram,
  getProgramPathway,
} from "@/services/syllabus/lm-master.data";
import { parseFile } from "@/lib/xlsx-parser";
import { ToastContainer } from "@/components/ui/Toast";
import { useToast } from "@/hooks/useToast";
import type { Lesson } from "@/types/lesson";
import type {
  LittleMozartsTrack,
  LMTrackOrBridge,
  MasterSyllabusItem,
  StudentSyllabusItem,
  LMStudentSyllabus,
  LMItemType,
  LMProgram,
  LMCourse,
  HandAllocation,
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

const TRACK_COLORS: Record<LMTrackOrBridge, { bg: string; border: string; accent: string }> = {
  delta_track:   { bg: "#eff6ff", border: "#bfdbfe", accent: "#2563eb" },
  epsilon_track: { bg: "#f0fdf4", border: "#bbf7d0", accent: "#15803d" },
  zeta_track:    { bg: "#faf5ff", border: "#ddd6fe", accent: "#7c3aed" },
  bridge:        { bg: "#fff7ed", border: "#fed7aa", accent: "#c2410c" },
  standard:      { bg: "#f0f9ff", border: "#bae6fd", accent: "#0369a1" },
};

function slotKey(track: LMTrackOrBridge, course: LMCourse): string {
  return `${track}__${course}`;
}

interface SlotStatus { exists: boolean; items: MasterSyllabusItem[] }

const VALID_ITEM_TYPES = ["concept", "exercise", "songsheet"] as const;

const TYPE_COLORS: Record<string, React.CSSProperties> = {
  concept:   { background: "#ede9fe", color: "#4f46e5" },
  exercise:  { background: "#dcfce7", color: "#15803d" },
  songsheet: { background: "#fef9c3", color: "#a16207" },
  _other:    { background: "#fee2e2", color: "#b91c1c" },
};

function mapToMasterItems(
  rows: Record<string, string>[],
  track: LMTrackOrBridge,
): MasterSyllabusItem[] {
  const cfg = (track !== "bridge" && track !== "standard") ? TRACK_UI_CONFIG[track as LittleMozartsTrack] : null;
  return rows.map(r => {
    const it        = r["itemtype"]?.trim().toLowerCase() as LMItemType;
    const isConcept = it === "concept";
    const rawBpm    = r["metronome"]?.trim();
    const rawHand   = r["hands"]?.trim();
    return {
      lessonNumber:   parseInt(r["lessonnumber"] ?? "0", 10),
      lessonName:     r["lessonname"]?.trim() ?? "",
      itemType:       it,
      itemTitle:      r["itemtitle"]?.trim() ?? "",
      metronomeBpm:   isConcept ? null : (rawBpm ? (parseInt(rawBpm) || null) : (cfg?.metronomeBpm ?? null)),
      handAllocation: isConcept ? null : ((rawHand as HandAllocation | undefined) || cfg?.handIntegration || null),
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
  const { user, role }                        = useAuth();
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

  // Track tab — LM individual syllabus
  const [trackLMSyllabus, setTrackLMSyllabus]     = useState<LMStudentSyllabus | null>(null);
  const [trackLMLoading, setTrackLMLoading]       = useState(false);
  const [trackLMEditItems, setTrackLMEditItems]   = useState<StudentSyllabusItem[] | null>(null);
  const [trackLMSaving, setTrackLMSaving]         = useState(false);

  // Master tab state
  const masterFileRef                           = useRef<HTMLInputElement>(null);
  const [masterProgram, setMasterProgram]       = useState<LMProgram>("intro_keyboard");
  const [masterTrack, setMasterTrack]           = useState<LMTrackOrBridge>("epsilon_track");
  const [masterCourse, setMasterCourse]         = useState<LMCourse>("course_1_1");
  const [masterFile, setMasterFile]             = useState<File | null>(null);
  const [masterRawRows, setMasterRawRows]       = useState<Record<string, string>[]>([]);
  const [masterPreview, setMasterPreview]       = useState<MasterSyllabusItem[]>([]);
  const [masterErrors, setMasterErrors]         = useState<string[]>([]);
  const [masterValid, setMasterValid]           = useState(false);
  const [masterImporting, setMasterImporting]   = useState(false);
  const [masterDragOver, setMasterDragOver]     = useState(false);
  const [masterTrackPreview, setMasterTrackPreview] = useState<MasterSyllabusItem[] | null>(null);

  // Manage existing syllabuses
  const [slotStatuses, setSlotStatuses]         = useState<Record<string, SlotStatus>>({});
  const [statusLoading, setStatusLoading]       = useState(false);
  const [deleteConfirmKey, setDeleteConfirmKey] = useState<string | null>(null);
  const [deleteProcessing, setDeleteProcessing] = useState(false);
  const [clearAllConfirm, setClearAllConfirm]   = useState(false);
  const [clearAllProcessing, setClearAllProcessing] = useState(false);
  const [editSlot, setEditSlot]                 = useState<{ track: LMTrackOrBridge; course: LMCourse } | null>(null);
  const [editItems, setEditItems]               = useState<MasterSyllabusItem[]>([]);
  const [editSaving, setEditSaving]             = useState(false);

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

  useEffect(() => {
    if (!trackStudent) { setTrackLMSyllabus(null); setTrackLMEditItems(null); return; }
    setTrackLMLoading(true);
    getStudentSyllabus(trackStudent)
      .then(data => setTrackLMSyllabus(data))
      .catch(() => setTrackLMSyllabus(null))
      .finally(() => setTrackLMLoading(false));
  }, [trackStudent]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleStartStudentEdit() {
    if (!trackLMSyllabus) return;
    setTrackLMEditItems(trackLMSyllabus.items.map(i => ({ ...i })));
  }

  function handleCancelStudentEdit() { setTrackLMEditItems(null); }

  async function handleSaveStudentEdit() {
    if (!trackLMEditItems || !trackStudent || trackLMSaving) return;
    const items = trackLMEditItems;
    setTrackLMSaving(true);
    try {
      await updateStudentSyllabusItems(trackStudent, items, user?.uid ?? "");
      toast(`Student syllabus updated — ${items.length} items.`, "success");
      setTrackLMSyllabus(prev => prev ? { ...prev, items } : prev);
      setTrackLMEditItems(null);
    } catch (err) {
      toast(`Save failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setTrackLMSaving(false);
    }
  }

  function updateStudentEditItem(index: number, field: keyof MasterSyllabusItem, value: MasterSyllabusItem[keyof MasterSyllabusItem]) {
    setTrackLMEditItems(prev => prev ? prev.map((item, i) => i === index ? { ...item, [field]: value } : item) : prev);
  }

  function updateStudentEditItemType(index: number, type: LMItemType) {
    setTrackLMEditItems(prev => prev ? prev.map((item, i) => {
      if (i !== index) return item;
      return { ...item, itemType: type, metronomeBpm: type === "concept" ? null : item.metronomeBpm, handAllocation: type === "concept" ? null : item.handAllocation };
    }) : prev);
  }

  function removeStudentEditItem(index: number) {
    setTrackLMEditItems(prev => prev ? prev.filter((_, i) => i !== index) : prev);
  }

  function addStudentEditItem() {
    const last = trackLMEditItems?.[trackLMEditItems.length - 1];
    const cfg  = trackLMSyllabus ? TRACK_UI_CONFIG[trackLMSyllabus.track] : null;
    setTrackLMEditItems(prev => prev ? [...prev, {
      lessonNumber:   last?.lessonNumber ?? 1,
      lessonName:     last?.lessonName  ?? "",
      itemType:       "exercise" as LMItemType,
      itemTitle:      "",
      metronomeBpm:   cfg?.metronomeBpm    ?? null,
      handAllocation: cfg?.handIntegration ?? null,
      completed:      false,
      completedAt:    null,
    }] : prev);
  }

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
      setSlotStatuses(prev => ({
        ...prev,
        [slotKey(target.track, target.course)]: { exists: true, items },
      }));
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

  // ─── Manage existing syllabuses ───────────────────────────────────────────

  const loadSlotStatuses = useCallback(async (program: LMProgram) => {
    setStatusLoading(true);
    try {
      const slots   = PROGRAM_SLOTS[program];
      const results = await Promise.all(
        slots.map(slot =>
          getMasterSyllabusWithMeta({ program, track: slot.track, course: slot.course })
            .then(data => ({ key: slotKey(slot.track, slot.course), data }))
        )
      );
      const statuses: Record<string, SlotStatus> = {};
      for (const { key, data } of results) statuses[key] = data;
      setSlotStatuses(statuses);
    } catch {
      toast("Failed to load syllabus statuses.", "error");
    } finally {
      setStatusLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab === "master") loadSlotStatuses(masterProgram);
  }, [tab, masterProgram]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleDeleteSlot(track: LMTrackOrBridge, course: LMCourse) {
    setDeleteProcessing(true);
    try {
      await deleteMasterSyllabus({ program: masterProgram, track, course });
      toast(`${TRACK_SHORT[track]} ${COURSE_LABELS[course]} syllabus deleted.`, "success");
      setDeleteConfirmKey(null);
      setMasterTrackPreview(null);
      const key = slotKey(track, course);
      setSlotStatuses(prev => ({ ...prev, [key]: { exists: false, items: [] } }));
    } catch (err) {
      toast(`Delete failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setDeleteProcessing(false);
    }
  }

  async function handleClearAll() {
    setClearAllProcessing(true);
    const prog  = masterProgram;
    const slots = PROGRAM_SLOTS[prog];
    try {
      await Promise.all(slots.map(slot => deleteMasterSyllabus({ program: prog, track: slot.track, course: slot.course })));
      const cleared: Record<string, SlotStatus> = {};
      for (const slot of slots) cleared[slotKey(slot.track, slot.course)] = { exists: false, items: [] };
      setSlotStatuses(cleared);
      setEditSlot(null);
      setEditItems([]);
      setMasterTrackPreview(null);
      setClearAllConfirm(false);
      toast(`All ${slots.length} syllabuses cleared.`, "success");
    } catch (err) {
      toast(`Clear failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setClearAllProcessing(false);
    }
  }

  function handleProgramChange(prog: LMProgram) {
    if (prog === masterProgram) return;
    setMasterProgram(prog);
    setSlotStatuses({});
    setEditSlot(null);
    setEditItems([]);
    setMasterTrackPreview(null);
    setDeleteConfirmKey(null);
    setClearAllConfirm(false);
    resetMaster();
    const slots = PROGRAM_SLOTS[prog];
    if (slots.length > 0) {
      setMasterTrack(slots[0].track);
      setMasterCourse(slots[0].course);
    }
  }

  function handleStartEdit(track: LMTrackOrBridge, course: LMCourse, items: MasterSyllabusItem[]) {
    setEditSlot({ track, course });
    setEditItems(items.map(i => ({ ...i })));
    setDeleteConfirmKey(null);
  }

  function handleEditCancel() {
    setEditSlot(null);
    setEditItems([]);
  }

  async function handleEditSave() {
    if (!editSlot || editSaving) return;
    const target = { program: masterProgram, track: editSlot.track, course: editSlot.course };
    const items  = editItems;
    setEditSaving(true);
    try {
      await seedMasterSyllabus(target, items);
      toast(`${TRACK_SHORT[editSlot.track]} ${COURSE_LABELS[editSlot.course]} saved — ${items.length} items.`, "success");
      const key = slotKey(editSlot.track, editSlot.course);
      setSlotStatuses(prev => ({ ...prev, [key]: { exists: true, items } }));
      setEditSlot(null);
      setEditItems([]);
    } catch (err) {
      toast(`Save failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setEditSaving(false);
    }
  }

  function updateEditItem(index: number, field: keyof MasterSyllabusItem, value: MasterSyllabusItem[keyof MasterSyllabusItem]) {
    setEditItems(prev => prev.map((item, i) => i === index ? { ...item, [field]: value } : item));
  }

  function updateEditItemType(index: number, type: LMItemType) {
    setEditItems(prev => prev.map((item, i) => {
      if (i !== index) return item;
      return { ...item, itemType: type, metronomeBpm: type === "concept" ? null : item.metronomeBpm, handAllocation: type === "concept" ? null : item.handAllocation };
    }));
  }

  function removeEditItem(index: number) {
    setEditItems(prev => prev.filter((_, i) => i !== index));
  }

  function addEditItem() {
    const last = editItems[editItems.length - 1];
    const cfg  = editSlot && editSlot.track !== "bridge" && editSlot.track !== "standard" ? TRACK_UI_CONFIG[editSlot.track as LittleMozartsTrack] : null;
    setEditItems(prev => [...prev, {
      lessonNumber:   last?.lessonNumber ?? 1,
      lessonName:     last?.lessonName  ?? "",
      itemType:       "exercise" as LMItemType,
      itemTitle:      "",
      metronomeBpm:   cfg?.metronomeBpm    ?? null,
      handAllocation: cfg?.handIntegration ?? null,
    }]);
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

          {/* LM individual syllabus */}
          {trackStudent && (
            <div style={s.lmSection}>
              <div style={s.lmSectionHeader}>
                <span style={s.lmSectionTitle}>Little Mozarts Syllabus</span>
                {trackLMSyllabus && !trackLMEditItems && isAdmin && (
                  <button onClick={handleStartStudentEdit} style={{ ...s.mgmtBtn, ...s.editBtn }}>
                    Edit Syllabus
                  </button>
                )}
              </div>

              {trackLMLoading ? (
                <div style={s.lmEmpty}>Loading…</div>
              ) : !trackLMSyllabus ? (
                <div style={s.lmEmpty}>No Little Mozarts syllabus found for this student.</div>
              ) : !trackLMEditItems ? (
                <div style={s.lmInfo}>
                  <span style={{ ...s.mgmtTrackBadge, ...TRACK_COLORS[trackLMSyllabus.track], border: `1px solid ${TRACK_COLORS[trackLMSyllabus.track].border}` }}>
                    {TRACK_SHORT[trackLMSyllabus.track]}
                  </span>
                  <span style={s.lmStatChip}>{trackLMSyllabus.items.length} items</span>
                  <span style={{ ...s.lmStatChip, color: "#16a34a" }}>
                    {trackLMSyllabus.items.filter(i => i.completed).length} completed
                  </span>
                  <span style={{ ...s.lmStatChip, color: "#9ca3af" }}>
                    {trackLMSyllabus.items.filter(i => !i.completed).length} remaining
                  </span>
                </div>
              ) : (
                <div>
                  <div style={s.lmEditHeader}>
                    <div>
                      <span style={s.lmEditTitle}>
                        Editing: {TRACK_SHORT[trackLMSyllabus.track]} syllabus — {trackLMEditItems.length} items
                      </span>
                      <div style={s.lmEditNote}>Changes apply to this student only, not the master syllabus</div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={handleSaveStudentEdit} disabled={trackLMSaving} style={{ ...s.mgmtBtn, ...s.saveBtn }}>
                        {trackLMSaving ? "Saving…" : "Save changes"}
                      </button>
                      <button onClick={handleCancelStudentEdit} style={{ ...s.mgmtBtn, ...s.cancelBtn }}>Cancel</button>
                    </div>
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={s.editTable}>
                      <thead>
                        <tr>
                          {["#", "Lesson", "Lesson Name", "Type", "Title", "BPM", "Hand", "Done", ""].map(h => (
                            <th key={h} style={s.editTh}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {trackLMEditItems.map((item, i) => {
                          const isConcept = item.itemType === "concept";
                          return (
                            <tr key={i} style={i % 2 === 0 ? s.rowEven : s.rowOdd}>
                              <td style={{ ...s.editTd, ...s.mono, color: "#9ca3af" }}>{i + 1}</td>
                              <td style={s.editTd}>
                                <input type="number" value={item.lessonNumber} min={1}
                                  onChange={e => updateStudentEditItem(i, "lessonNumber", parseInt(e.target.value) || 1)}
                                  style={{ ...s.editInput, width: 48 }} />
                              </td>
                              <td style={s.editTd}>
                                <input value={item.lessonName}
                                  onChange={e => updateStudentEditItem(i, "lessonName", e.target.value)}
                                  style={{ ...s.editInput, minWidth: 130 }} />
                              </td>
                              <td style={s.editTd}>
                                <select value={item.itemType}
                                  onChange={e => updateStudentEditItemType(i, e.target.value as LMItemType)}
                                  style={s.editSelect}>
                                  {VALID_ITEM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                                </select>
                              </td>
                              <td style={s.editTd}>
                                <input value={item.itemTitle}
                                  onChange={e => updateStudentEditItem(i, "itemTitle", e.target.value)}
                                  style={{ ...s.editInput, minWidth: 180 }} />
                              </td>
                              <td style={s.editTd}>
                                <input type="number" value={item.metronomeBpm ?? ""} disabled={isConcept} placeholder="—"
                                  onChange={e => updateStudentEditItem(i, "metronomeBpm", e.target.value ? parseInt(e.target.value) : null)}
                                  style={{ ...s.editInput, width: 52, opacity: isConcept ? 0.3 : 1 }} />
                              </td>
                              <td style={s.editTd}>
                                <select value={item.handAllocation ?? ""} disabled={isConcept}
                                  onChange={e => updateStudentEditItem(i, "handAllocation", (e.target.value || null) as HandAllocation | null)}
                                  style={{ ...s.editSelect, opacity: isConcept ? 0.3 : 1 }}>
                                  <option value="">—</option>
                                  <option value="RH Only">RH Only</option>
                                  <option value="Hands Separated">Hands Separated</option>
                                  <option value="Hands Together">Hands Together</option>
                                </select>
                              </td>
                              <td style={{ ...s.editTd, textAlign: "center" as const }}>
                                {item.completed
                                  ? <span style={{ color: "#16a34a", fontSize: 13, fontWeight: 700 }}>✓</span>
                                  : <span style={{ color: "#d1d5db" }}>—</span>}
                              </td>
                              <td style={s.editTd}>
                                <button onClick={() => removeStudentEditItem(i)} style={s.removeRowBtn}>✕</button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <button onClick={addStudentEditItem} style={s.addRowBtn}>+ Add Row</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ─── MASTER TAB ──────────────────────────────────────────────────── */}
      {tab === "master" && isAdmin && (
        <div>

          {/* ── Program Selector ── */}
          <div style={{ padding: "16px 16px 4px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 10 }}>
              Program
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
              {(Object.entries(PROGRAM_LABELS) as [LMProgram, string][]).map(([prog, label]) => {
                const isSelected = prog === masterProgram;
                const isGuitar   = prog.includes("guitar");
                return (
                  <button
                    key={prog}
                    type="button"
                    onClick={() => handleProgramChange(prog)}
                    style={{
                      padding:     "8px 14px",
                      borderRadius: 8,
                      cursor:       "pointer",
                      border:       isSelected ? "2px solid #4f46e5" : "1px solid #e5e7eb",
                      background:   isSelected ? "#ede9fe" : "#f9fafb",
                      color:        isSelected ? "#4f46e5" : "#374151",
                      fontSize:     12,
                      fontWeight:   isSelected ? 700 : 500,
                      display:      "flex",
                      alignItems:   "center",
                      gap:          5,
                    }}
                  >
                    <span>{isGuitar ? "🎸" : "🎹"}</span>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Manage existing syllabuses ── */}
          <div style={s.mgmtSection}>
            <div style={s.mgmtHeader}>
              <span style={s.mgmtTitle}>{PROGRAM_LABELS[masterProgram]} — Imported Syllabuses</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {clearAllConfirm ? (
                  <>
                    <span style={{ fontSize: 12, color: "#374151", fontWeight: 500 }}>Clear all {PROGRAM_SLOTS[masterProgram].length} syllabuses?</span>
                    <button
                      onClick={handleClearAll}
                      disabled={clearAllProcessing}
                      style={{ ...s.mgmtBtn, ...s.confirmDeleteBtn }}
                    >
                      {clearAllProcessing ? "Clearing…" : "Yes, clear all"}
                    </button>
                    <button onClick={() => setClearAllConfirm(false)} style={{ ...s.mgmtBtn, ...s.cancelBtn }}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={() => setClearAllConfirm(true)} style={{ ...s.mgmtBtn, ...s.deleteBtn }}>
                      Clear All
                    </button>
                    <button onClick={() => loadSlotStatuses(masterProgram)} disabled={statusLoading} style={s.refreshBtn}>
                      {statusLoading ? "Loading…" : "↺ Refresh"}
                    </button>
                  </>
                )}
              </div>
            </div>

            {PROGRAM_SLOTS[masterProgram].map(slot => {
              const key      = slotKey(slot.track, slot.course);
              const status   = slotStatuses[key];
              const colors   = TRACK_COLORS[slot.track];
              const isConfirm = deleteConfirmKey === key;
              const isEditing = editSlot?.track === slot.track && editSlot?.course === slot.course;
              return (
                <div key={key} style={{ ...s.mgmtRow, ...(isEditing ? s.mgmtRowEditing : {}) }}>
                  <div style={s.mgmtSlotCell}>
                    <span style={{ ...s.mgmtTrackBadge, background: colors.bg, color: colors.accent, border: `1px solid ${colors.border}` }}>
                      {TRACK_SHORT[slot.track]}
                    </span>
                    <span style={s.mgmtCourseLabel}>{COURSE_LABELS[slot.course]}</span>
                  </div>
                  <div style={s.mgmtStatusCell}>
                    {status === undefined ? (
                      <span style={s.statusLoading}>…</span>
                    ) : status.exists ? (
                      <span style={s.statusLive}>● Live · {status.items.length} items</span>
                    ) : (
                      <span style={s.statusEmpty}>○ Empty</span>
                    )}
                  </div>
                  <div style={s.mgmtActionsCell}>
                    {status?.exists && !isConfirm && (
                      <>
                        <button
                          onClick={() => handleStartEdit(slot.track, slot.course, status.items)}
                          style={{ ...s.mgmtBtn, ...s.editBtn, ...(isEditing ? s.editBtnActive : {}) }}
                        >
                          {isEditing ? "Editing…" : "Edit"}
                        </button>
                        <button
                          onClick={() => setDeleteConfirmKey(key)}
                          style={{ ...s.mgmtBtn, ...s.deleteBtn }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                    {isConfirm && (
                      <div style={s.confirmRow}>
                        <span style={s.confirmText}>Delete this syllabus?</span>
                        <button
                          onClick={() => handleDeleteSlot(slot.track, slot.course)}
                          disabled={deleteProcessing}
                          style={{ ...s.mgmtBtn, ...s.confirmDeleteBtn }}
                        >
                          {deleteProcessing ? "Deleting…" : "Yes, delete"}
                        </button>
                        <button onClick={() => setDeleteConfirmKey(null)} style={{ ...s.mgmtBtn, ...s.cancelBtn }}>
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Edit panel */}
            {editSlot && (
              <div style={s.editPanel}>
                <div style={s.masterEditNoteBanner}>
                  ℹ Editing the master syllabus affects new enrollments only. Students already enrolled keep their own copy — edit those individually from the Track tab.
                </div>
                <div style={s.editPanelHeader}>
                  <span style={s.editPanelTitle}>
                    Editing: {TRACK_SHORT[editSlot.track]} {COURSE_LABELS[editSlot.course]}
                    <span style={s.editPanelCount}>{editItems.length} items</span>
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={handleEditSave} disabled={editSaving} style={{ ...s.mgmtBtn, ...s.saveBtn }}>
                      {editSaving ? "Saving…" : "Save changes"}
                    </button>
                    <button onClick={handleEditCancel} style={{ ...s.mgmtBtn, ...s.cancelBtn }}>Cancel</button>
                  </div>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={s.editTable}>
                    <thead>
                      <tr>
                        {["#", "Lesson", "Lesson Name", "Type", "Title", "BPM", "Hand", ""].map(h => (
                          <th key={h} style={s.editTh}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {editItems.map((item, i) => {
                        const isConcept = item.itemType === "concept";
                        return (
                          <tr key={i} style={i % 2 === 0 ? s.rowEven : s.rowOdd}>
                            <td style={{ ...s.editTd, ...s.mono, color: "#9ca3af" }}>{i + 1}</td>
                            <td style={s.editTd}>
                              <input
                                type="number"
                                value={item.lessonNumber}
                                min={1}
                                onChange={e => updateEditItem(i, "lessonNumber", parseInt(e.target.value) || 1)}
                                style={{ ...s.editInput, width: 48 }}
                              />
                            </td>
                            <td style={s.editTd}>
                              <input
                                value={item.lessonName}
                                onChange={e => updateEditItem(i, "lessonName", e.target.value)}
                                style={{ ...s.editInput, minWidth: 130 }}
                              />
                            </td>
                            <td style={s.editTd}>
                              <select
                                value={item.itemType}
                                onChange={e => updateEditItemType(i, e.target.value as LMItemType)}
                                style={s.editSelect}
                              >
                                {VALID_ITEM_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                              </select>
                            </td>
                            <td style={s.editTd}>
                              <input
                                value={item.itemTitle}
                                onChange={e => updateEditItem(i, "itemTitle", e.target.value)}
                                style={{ ...s.editInput, minWidth: 180 }}
                              />
                            </td>
                            <td style={s.editTd}>
                              <input
                                type="number"
                                value={item.metronomeBpm ?? ""}
                                disabled={isConcept}
                                placeholder="—"
                                onChange={e => updateEditItem(i, "metronomeBpm", e.target.value ? parseInt(e.target.value) : null)}
                                style={{ ...s.editInput, width: 52, opacity: isConcept ? 0.3 : 1 }}
                              />
                            </td>
                            <td style={s.editTd}>
                              <select
                                value={item.handAllocation ?? ""}
                                disabled={isConcept}
                                onChange={e => updateEditItem(i, "handAllocation", (e.target.value || null) as HandAllocation | null)}
                                style={{ ...s.editSelect, opacity: isConcept ? 0.3 : 1 }}
                              >
                                <option value="">—</option>
                                <option value="RH Only">RH Only</option>
                                <option value="Hands Separated">Hands Separated</option>
                                <option value="Hands Together">Hands Together</option>
                              </select>
                            </td>
                            <td style={s.editTd}>
                              <button onClick={() => removeEditItem(i)} style={s.removeRowBtn}>✕</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <button onClick={addEditItem} style={s.addRowBtn}>+ Add Row</button>
              </div>
            )}
          </div>

          {/* Bento grid — pathway selector + upload zone */}
          <div style={s.bentoGrid}>

            {/* Card 1: Program + Slot grid */}
            <div style={s.bentoCard}>
              <div style={s.bentoCardLabel}>Import Target</div>
              <div style={s.programHeader}>
                <span style={s.programIcon}>{masterProgram.includes("guitar") ? "🎸" : "🎹"}</span>
                <span style={s.programTitle}>{PROGRAM_LABELS[masterProgram]}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {getProgramPathway(masterProgram).map(({ track, steps }) => {
                  const trackColors = TRACK_COLORS[track];
                  return (
                    <div key={track} style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" as const }}>
                      <div style={{
                        width:         52,
                        flexShrink:    0,
                        fontSize:      9,
                        fontWeight:    700,
                        color:         trackColors.accent,
                        textTransform: "uppercase" as const,
                        letterSpacing: "0.08em",
                        background:    trackColors.bg,
                        border:        `1px solid ${trackColors.border}`,
                        borderRadius:  6,
                        padding:       "4px 5px",
                        textAlign:     "center" as const,
                      }}>
                        {TRACK_SHORT[track]}
                      </div>
                      {steps.map((target, idx) => {
                        const isActive   = masterTrack === target.track && masterCourse === target.course;
                        const stepColors = TRACK_COLORS[target.track];
                        const slotSt     = slotStatuses[slotKey(target.track, target.course)];
                        return (
                          <div key={`${target.track}__${target.course}`} style={{ display: "contents" }}>
                            {idx > 0 && (
                              <div style={{ color: "#d1d5db", fontSize: 11, flexShrink: 0 }}>→</div>
                            )}
                            <div
                              onClick={() => {
                                setMasterTrack(target.track);
                                setMasterCourse(target.course);
                                setMasterTrackPreview(slotSt?.exists ? slotSt.items : null);
                              }}
                              style={{
                                borderRadius: 8,
                                padding:      "7px 10px",
                                cursor:       "pointer",
                                background:   isActive ? "#4f46e5" : stepColors.bg,
                                border:       `1.5px solid ${isActive ? "#4f46e5" : (slotSt?.exists ? stepColors.accent : stepColors.border)}`,
                                flexShrink:   0,
                                textAlign:    "center" as const,
                                minWidth:     72,
                              }}
                            >
                              <div style={{
                                fontSize:     10,
                                fontWeight:   700,
                                color:        isActive ? "#fff" : stepColors.accent,
                                marginBottom: 2,
                                whiteSpace:   "nowrap" as const,
                              }}>
                                {COURSE_LABELS[target.course]}
                              </div>
                              <div style={{
                                fontSize:   9,
                                fontWeight: 500,
                                color:      isActive ? "rgba(255,255,255,0.65)" : (slotSt?.exists ? "#16a34a" : "#9ca3af"),
                              }}>
                                {slotSt === undefined ? "…" : slotSt.exists ? `${slotSt.items.length} items` : "Empty"}
                              </div>
                            </div>
                          </div>
                        );
                      })}
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
                Required:{" "}
                {["lessonNumber", "lessonName", "itemType", "itemTitle"].map(c => (
                  <span key={c} style={s.colChip}>{c}</span>
                ))}
                <span style={{ margin: "0 3px", color: "#d1d5db" }}>|</span>
                Optional:{" "}
                {["metronome", "hands"].map(c => (
                  <span key={c} style={{ ...s.colChip, opacity: 0.55 }}>{c}</span>
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

  // ─── Manage section ───────────────────────────────────────────────────────
  mgmtSection: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 14,
    overflow:     "hidden",
    marginBottom: 16,
    boxShadow:    "0 1px 3px rgba(0,0,0,0.06)",
  },
  mgmtHeader: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    padding:        "14px 20px",
    background:     "#f9fafb",
    borderBottom:   "1px solid #e5e7eb",
  },
  mgmtTitle: {
    fontSize:      11,
    fontWeight:    700,
    color:         "#374151",
    textTransform: "uppercase" as const,
    letterSpacing: "0.07em",
  },
  refreshBtn: {
    background:   "none",
    border:       "1px solid #e5e7eb",
    color:        "#6b7280",
    padding:      "4px 12px",
    borderRadius: 6,
    fontSize:     12,
    fontWeight:   600,
    cursor:       "pointer",
  },
  mgmtRow: {
    display:        "flex",
    alignItems:     "center",
    padding:        "11px 20px",
    borderBottom:   "1px solid #f3f4f6",
    gap:            16,
  },
  mgmtRowEditing: {
    background:  "#f5f3ff",
    borderLeft:  "3px solid #4f46e5",
  },
  mgmtSlotCell: {
    display:    "flex",
    alignItems: "center",
    gap:        8,
    width:      160,
    flexShrink: 0,
  },
  mgmtTrackBadge: {
    fontSize:     11,
    fontWeight:   700,
    padding:      "2px 8px",
    borderRadius: 99,
    flexShrink:   0,
  },
  mgmtCourseLabel: {
    fontSize:   12,
    fontWeight: 600,
    color:      "#374151",
  },
  mgmtStatusCell: {
    flex:     1,
    fontSize: 12,
  },
  statusLoading: { color: "#9ca3af", fontStyle: "italic" as const },
  statusLive:    { color: "#16a34a", fontWeight: 600 },
  statusEmpty:   { color: "#9ca3af" },
  mgmtActionsCell: {
    display:    "flex",
    alignItems: "center",
    gap:        8,
    flexShrink: 0,
  },
  mgmtBtn: {
    padding:      "5px 12px",
    borderRadius: 6,
    fontSize:     12,
    fontWeight:   600,
    cursor:       "pointer",
    border:       "none",
  },
  editBtn:       { background: "#ede9fe", color: "#4f46e5" },
  editBtnActive: { background: "#4f46e5", color: "#fff" },
  deleteBtn:     { background: "#fee2e2", color: "#dc2626" },
  confirmRow:    { display: "flex", alignItems: "center", gap: 8 },
  confirmText:   { fontSize: 12, color: "#374151", fontWeight: 500 },
  confirmDeleteBtn: { background: "#dc2626", color: "#fff" },
  cancelBtn:     { background: "#f3f4f6", color: "#374151" },
  saveBtn:       { background: "#4f46e5", color: "#fff" },

  // ─── Edit panel ────────────────────────────────────────────────────────────
  editPanel: {
    margin:       "0 20px 20px",
    border:       "1px solid #e5e7eb",
    borderRadius: 10,
    overflow:     "hidden",
  },
  editPanelHeader: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    padding:        "11px 16px",
    background:     "#f9fafb",
    borderBottom:   "1px solid #e5e7eb",
  },
  editPanelTitle: {
    fontSize:   13,
    fontWeight: 700,
    color:      "#111",
    display:    "flex",
    alignItems: "center",
    gap:        10,
  },
  editPanelCount: {
    fontSize:   11,
    fontWeight: 500,
    color:      "#9ca3af",
  },
  editTable:  { width: "100%", borderCollapse: "collapse" as const },
  editTh: {
    padding:       "8px 10px",
    textAlign:     "left" as const,
    fontSize:      10,
    fontWeight:    600,
    color:         "#6b7280",
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    background:    "#f9fafb",
    borderBottom:  "1px solid #e5e7eb",
    whiteSpace:    "nowrap" as const,
  },
  editTd:    { padding: "5px 8px", borderBottom: "1px solid #f3f4f6", verticalAlign: "middle" as const },
  editInput: {
    padding:      "5px 8px",
    border:       "1px solid #e5e7eb",
    borderRadius: 6,
    fontSize:     12,
    color:        "#111",
    background:   "#fff",
    outline:      "none",
    width:        "100%",
  },
  editSelect: {
    padding:      "5px 6px",
    border:       "1px solid #e5e7eb",
    borderRadius: 6,
    fontSize:     12,
    color:        "#111",
    background:   "#fff",
    outline:      "none",
    cursor:       "pointer",
  },
  removeRowBtn: {
    background:   "none",
    border:       "none",
    color:        "#dc2626",
    cursor:       "pointer",
    fontSize:     12,
    fontWeight:   700,
    padding:      "2px 6px",
    borderRadius: 4,
  },
  addRowBtn: {
    display:      "block",
    width:        "100%",
    padding:      "9px 0",
    background:   "#f9fafb",
    border:       "none",
    borderTop:    "1px solid #e5e7eb",
    color:        "#4f46e5",
    fontSize:     12,
    fontWeight:   700,
    cursor:       "pointer",
    textAlign:    "center" as const,
  },

  masterEditNoteBanner: {
    background:  "#fffbeb",
    borderBottom:"1px solid #fde68a",
    color:       "#92400e",
    fontSize:    12,
    padding:     "9px 16px",
  },

  // ─── Track tab — LM section ────────────────────────────────────────────────
  lmSection: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 12,
    overflow:     "hidden",
    marginTop:    14,
    boxShadow:    "0 1px 3px rgba(0,0,0,0.06)",
  },
  lmSectionHeader: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    padding:        "12px 18px",
    background:     "#f9fafb",
    borderBottom:   "1px solid #e5e7eb",
  },
  lmSectionTitle: {
    fontSize:      11,
    fontWeight:    700,
    color:         "#374151",
    textTransform: "uppercase" as const,
    letterSpacing: "0.07em",
  },
  lmEmpty: { padding: "18px", fontSize: 13, color: "#9ca3af", fontStyle: "italic" as const },
  lmInfo:  { display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", flexWrap: "wrap" as const },
  lmStatChip: {
    fontSize:   12,
    fontWeight: 600,
    color:      "#374151",
    background: "#f3f4f6",
    borderRadius: 99,
    padding:    "3px 10px",
    border:     "1px solid #e5e7eb",
  },
  lmEditHeader: {
    display:        "flex",
    alignItems:     "flex-start",
    justifyContent: "space-between",
    padding:        "12px 16px",
    background:     "#f5f3ff",
    borderBottom:   "1px solid #e5e7eb",
    gap:            12,
    flexWrap:       "wrap" as const,
  },
  lmEditTitle: { fontSize: 13, fontWeight: 700, color: "#111", display: "block", marginBottom: 3 },
  lmEditNote:  { fontSize: 11, color: "#7c3aed", fontStyle: "italic" as const },

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

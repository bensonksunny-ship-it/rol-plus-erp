"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import ProtectedRoute from "@/components/layout/ProtectedRoute";
import { ROLES } from "@/config/constants";
import { useAuth } from "@/hooks/useAuth";
import {
  seedMasterSyllabus,
  getMasterSyllabusWithMeta,
  deleteMasterSyllabus,
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
import type {
  LittleMozartsTrack,
  LMTrackOrBridge,
  MasterSyllabusItem,
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

type Tab = "general" | "master";

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
  const [tab, setTab]                         = useState<Tab>("general");
  const { toasts, toast, remove }             = useToast();

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
  const [expandedSlot, setExpandedSlot]         = useState<{ track: LMTrackOrBridge; course: LMCourse } | null>(null);
  const [importOpen, setImportOpen]             = useState(false);

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
    setExpandedSlot(null);
    resetMaster();
    const slots = PROGRAM_SLOTS[prog];
    if (slots.length > 0) {
      setMasterTrack(slots[0].track);
      setMasterCourse(slots[0].course);
    }
  }

  function handleToggleSlot(track: LMTrackOrBridge, course: LMCourse) {
    const isOpen = expandedSlot?.track === track && expandedSlot?.course === course;
    setMasterTrack(track);
    setMasterCourse(course);
    setDeleteConfirmKey(null);
    setImportOpen(false);
    if (isOpen) {
      setMasterTrackPreview(null);
      setExpandedSlot(null);
    } else {
      const selSt = slotStatuses[slotKey(track, course)];
      setMasterTrackPreview(selSt?.exists ? selSt.items : null);
      setExpandedSlot({ track, course });
      resetMaster();
    }
  }

  function handleStartEdit(track: LMTrackOrBridge, course: LMCourse, items: MasterSyllabusItem[]) {
    setEditSlot({ track, course });
    setEditItems(items.map(i => ({ ...i })));
    setDeleteConfirmKey(null);
  }

  function handlePreviewSlot(track: LMTrackOrBridge, course: LMCourse, items: MasterSyllabusItem[]) {
    const key = slotKey(track, course);
    // Toggle: clicking the currently-previewed slot closes the preview
    if (previewSlotKey === key) {
      setMasterTrackPreview(null);
      return;
    }
    setMasterTrack(track);
    setMasterCourse(course);
    setMasterTrackPreview(items);
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
  const previewSlotKey = masterTrackPreview ? slotKey(masterTrack, masterCourse) : null;

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
        {(["general", ...(isAdmin ? ["master"] : [])] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ ...s.tab, ...(tab === t ? s.tabActive : {}) }}
          >
            {t === "general" ? "📖 General" : "🎼 Master"}
          </button>
        ))}
      </div>

      {/* ─── GENERAL TAB ─────────────────────────────────────────────────── */}
      {tab === "general" && (
        <div style={s.emptyState}>
          <div style={s.emptyIcon}>📖</div>
          <div style={s.emptyText}>Import a syllabus from an Excel file for a center or a student.</div>
          <button
            onClick={() => router.push("/dashboard/lessons/import")}
            style={s.importBtn}
          >
            ↑ Import Syllabus
          </button>
        </div>
      )}

      {/* ─── MASTER: per-course view & import (each course slot carries its own View/Import actions) ── */}
      {isAdmin && tab === "master" && (
        <div>

          {/* ── Program Selector ── */}
          <div style={{ padding: "0 0 12px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 8 }}>
              Program
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const }}>
              {(Object.entries(PROGRAM_LABELS) as [LMProgram, string][]).map(([prog, label]) => {
                const isSelected = prog === masterProgram;
                const isGuitar   = prog.includes("guitar");
                return (
                  <button
                    key={prog}
                    type="button"
                    onClick={() => handleProgramChange(prog)}
                    style={{
                      padding:     isSelected ? "6px 12px" : "7px 13px",
                      borderRadius: 7,
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

          {/* Edit panel — opens when you click Edit on a slot in the Import Target pathway below */}
          {editSlot && (
              <div style={s.editPanel}>
                <div style={s.masterEditNoteBanner}>
                  ℹ Editing the master syllabus affects new enrollments only. Students already enrolled keep their own copy and are not affected.
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

          {/* Import Target — click a course to open it and import/view its syllabus right there */}
          <div style={s.bentoCard}>
            <div style={s.bentoCardHead}>
              <span style={{ ...s.bentoCardLabel, marginBottom: 0 }}>Import Target</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {clearAllConfirm ? (
                  <>
                    <span style={{ fontSize: 11, color: "#374151", fontWeight: 500 }}>Clear all {PROGRAM_SLOTS[masterProgram].length}?</span>
                    <button onClick={handleClearAll} disabled={clearAllProcessing} style={{ ...s.mgmtBtn, ...s.confirmDeleteBtn }}>
                      {clearAllProcessing ? "Clearing…" : "Yes"}
                    </button>
                    <button onClick={() => setClearAllConfirm(false)} style={{ ...s.mgmtBtn, ...s.cancelBtn }}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => setClearAllConfirm(true)} style={{ ...s.mgmtBtn, ...s.deleteBtn }}>Clear All</button>
                    <button onClick={() => loadSlotStatuses(masterProgram)} disabled={statusLoading} style={s.refreshBtn} title="Refresh statuses">
                      {statusLoading ? "…" : "↺"}
                    </button>
                  </>
                )}
              </div>
            </div>
            <div style={s.programHeader}>
              <span style={s.programIcon}>{masterProgram.includes("guitar") ? "🎸" : "🎹"}</span>
              <span style={s.programTitle}>{PROGRAM_LABELS[masterProgram]}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {getProgramPathway(masterProgram).map(({ track, steps }) => {
                const trackColors = TRACK_COLORS[track];
                const isTrackOpen = expandedSlot?.track === track;
                return (
                  <div key={track}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" as const }}>
                      <div style={{
                        width:         72,
                        flexShrink:    0,
                        fontSize:      11,
                        fontWeight:    800,
                        color:         trackColors.accent,
                        textTransform: "uppercase" as const,
                        letterSpacing: "0.08em",
                        background:    trackColors.bg,
                        border:        `1.5px solid ${trackColors.border}`,
                        borderRadius:  9,
                        padding:       "9px 6px",
                        textAlign:     "center" as const,
                      }}>
                        {TRACK_SHORT[track]}
                      </div>
                      {steps.map((target, idx) => {
                        const isOpen     = expandedSlot?.track === target.track && expandedSlot?.course === target.course;
                        const stepColors = TRACK_COLORS[target.track];
                        const slotSt     = slotStatuses[slotKey(target.track, target.course)];
                        return (
                          <div key={`${target.track}__${target.course}`} style={{ display: "contents" }}>
                            {idx > 0 && (
                              <div style={{ color: "#c7cbd3", fontSize: 18, flexShrink: 0 }}>→</div>
                            )}
                            <div
                              onClick={() => handleToggleSlot(target.track, target.course)}
                              style={{
                                borderRadius: 12,
                                padding:      "13px 18px",
                                cursor:       "pointer",
                                background:   isOpen ? "#4f46e5" : stepColors.bg,
                                border:       `2px solid ${isOpen ? "#4f46e5" : (slotSt?.exists ? stepColors.accent : stepColors.border)}`,
                                boxShadow:    isOpen ? "0 4px 14px rgba(79,70,229,0.28)" : "0 1px 2px rgba(0,0,0,0.03)",
                                flexShrink:   0,
                                textAlign:    "center" as const,
                                minWidth:     120,
                                transition:   "box-shadow 0.15s ease",
                              }}
                            >
                              <div style={{
                                fontSize:     14,
                                fontWeight:   700,
                                color:        isOpen ? "#fff" : stepColors.accent,
                                marginBottom: 4,
                                whiteSpace:   "nowrap" as const,
                              }}>
                                {COURSE_LABELS[target.course]}
                              </div>
                              <div style={{
                                fontSize:   11.5,
                                fontWeight: 600,
                                color:      isOpen ? "rgba(255,255,255,0.75)" : (slotSt?.exists ? "#16a34a" : "#9ca3af"),
                              }}>
                                {slotSt === undefined ? "…" : slotSt.exists ? `● ${slotSt.items.length} items` : "○ Empty"}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Opens inline under the clicked course — view + import scoped to that course only */}
                    {isTrackOpen && (() => {
                      const selKey       = slotKey(masterTrack, masterCourse);
                      const selSt        = slotStatuses[selKey];
                      const selColors    = TRACK_COLORS[masterTrack];
                      const isConfirm    = deleteConfirmKey === selKey;
                      const isEditing    = editSlot?.track === masterTrack && editSlot?.course === masterCourse;
                      const isPreviewing = previewSlotKey === selKey;
                      return (
                        <div style={s.coursePanel}>
                          <div style={s.slotActionBar}>
                            <div style={s.slotActionInfo}>
                              <span style={{ ...s.mgmtTrackBadge, background: selColors.bg, color: selColors.accent, border: `1px solid ${selColors.border}` }}>
                                {TRACK_SHORT[masterTrack]}
                              </span>
                              <span style={s.mgmtCourseLabel}>{COURSE_LABELS[masterCourse]}</span>
                              {selSt === undefined ? (
                                <span style={s.statusLoading}>…</span>
                              ) : selSt.exists ? (
                                <span style={s.statusLive}>● {selSt.items.length} items</span>
                              ) : (
                                <span style={s.statusEmpty}>○ Empty</span>
                              )}
                            </div>
                            <div style={s.slotActionBtns}>
                              {!isConfirm && (
                                <>
                                  {selSt?.exists && (
                                    <>
                                      <button
                                        onClick={() => handlePreviewSlot(masterTrack, masterCourse, selSt.items)}
                                        style={{ ...s.mgmtBtn, ...s.previewBtn, ...(isPreviewing ? s.previewBtnActive : {}) }}
                                      >
                                        {isPreviewing ? "Hide" : "👁 View"}
                                      </button>
                                      <button
                                        onClick={() => handleStartEdit(masterTrack, masterCourse, selSt.items)}
                                        style={{ ...s.mgmtBtn, ...s.editBtn, ...(isEditing ? s.editBtnActive : {}) }}
                                      >
                                        {isEditing ? "Editing…" : "Edit"}
                                      </button>
                                      <button onClick={() => setDeleteConfirmKey(selKey)} style={{ ...s.mgmtBtn, ...s.deleteBtn }}>
                                        Delete
                                      </button>
                                    </>
                                  )}
                                  <button
                                    onClick={() => setImportOpen(o => !o)}
                                    style={{ ...s.mgmtBtn, ...s.importToggleBtn, ...(importOpen ? s.importToggleBtnActive : {}) }}
                                  >
                                    {importOpen ? "Close" : "📥 Import"}
                                  </button>
                                </>
                              )}
                              {isConfirm && (
                                <div style={s.confirmRow}>
                                  <span style={s.confirmText}>Delete?</span>
                                  <button
                                    onClick={() => handleDeleteSlot(masterTrack, masterCourse)}
                                    disabled={deleteProcessing}
                                    style={{ ...s.mgmtBtn, ...s.confirmDeleteBtn }}
                                  >
                                    {deleteProcessing ? "Deleting…" : "Yes, delete"}
                                  </button>
                                  <button onClick={() => setDeleteConfirmKey(null)} style={{ ...s.mgmtBtn, ...s.cancelBtn }}>Cancel</button>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Track syllabus preview — independent of the Import toggle */}
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

                          {/* Import File — only shown once "Import" is pressed */}
                          {importOpen && (
                          <>
                          <div style={s.bentoCardLabel}>Import File — {COURSE_LABELS[masterCourse]}</div>
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
                          </>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  header:    { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 },
  heading:   { fontSize: 19, fontWeight: 700, color: "#111", margin: 0, letterSpacing: "-0.01em" },
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
    gap:          3,
    marginBottom: 14,
    background:   "#f3f4f6",
    borderRadius: 10,
    padding:      3,
    border:       "1px solid #e5e7eb",
    maxWidth:     440,
  },
  tab: {
    flex:         1,
    padding:      "7px 0",
    borderRadius: 7,
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

  tableWrapper: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 10,
    overflow:     "hidden",
    marginBottom: 12,
    boxShadow:    "0 1px 2px rgba(0,0,0,0.05)",
  },
  tableHeader: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    padding:        "9px 14px",
    borderBottom:   "1px solid #e5e7eb",
    background:     "#f9fafb",
  },
  tableTitle:  { fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase" as const, letterSpacing: "0.06em" },
  table:       { width: "100%", borderCollapse: "collapse" as const },
  th: {
    padding:       "7px 14px",
    textAlign:     "left" as const,
    fontSize:      10,
    fontWeight:    600,
    color:         "#6b7280",
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    background:    "#f9fafb",
    borderBottom:  "1px solid #e5e7eb",
  },
  td: {
    padding:      "7px 14px",
    fontSize:     13,
    color:        "#111",
    borderBottom: "1px solid #f3f4f6",
  },
  rowEven: { background: "#fff" },
  rowOdd:  { background: "#fafafa" },
  mono:    { fontFamily: "monospace", fontSize: 12, color: "#6b7280" },

  emptyState: { padding: "36px 16px", textAlign: "center" as const },
  emptyIcon:  { fontSize: 34, marginBottom: 10 },
  emptyText:  { fontSize: 14, color: "#374151", marginBottom: 8 },

  // ─── Master tab ────────────────────────────────────────────────────────────
  bentoCard: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 14,
    padding:      "22px",
    boxShadow:    "0 1px 3px rgba(0,0,0,0.05)",
    marginBottom: 14,
  },
  coursePanel: {
    marginTop:    16,
    marginBottom: 4,
    padding:      "22px",
    background:   "#f9fafb",
    border:       "1px solid #e5e7eb",
    borderRadius: 14,
    display:      "flex",
    flexDirection: "column" as const,
    gap:          14,
    boxShadow:    "inset 0 1px 2px rgba(0,0,0,0.03)",
  },
  bentoCardLabel: {
    fontSize:      11,
    fontWeight:    700,
    color:         "#6b7280",
    textTransform: "uppercase" as const,
    letterSpacing: "0.12em",
    marginBottom:  14,
  },
  bentoCardHead: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    gap:            8,
    marginBottom:   16,
    minHeight:      24,
  },
  slotActionBar: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    gap:            12,
    flexWrap:       "wrap" as const,
    padding:        "14px 16px",
    background:     "#fff",
    border:         "1px solid #e5e7eb",
    borderRadius:   11,
  },
  slotActionInfo: {
    display:    "flex",
    alignItems: "center",
    gap:        10,
    fontSize:   13,
    flexWrap:   "wrap" as const,
  },
  slotActionBtns: {
    display:    "flex",
    alignItems: "center",
    gap:        8,
    flexWrap:   "wrap" as const,
  },

  programHeader: {
    display:      "flex",
    alignItems:   "center",
    gap:          10,
    padding:      "12px 16px",
    background:   "#f9fafb",
    borderRadius: 11,
    marginBottom: 18,
    border:       "1px solid #e5e7eb",
  },
  programIcon:  { fontSize: 22 },
  programTitle: { fontSize: 16, fontWeight: 700, color: "#111" },

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
    padding:       "30px 20px",
    textAlign:     "center" as const,
    cursor:        "pointer",
    marginBottom:  12,
    background:    "#fafafa",
    transition:    "border-color 0.15s ease, background 0.15s ease",
  },
  dropZoneActive: {
    border:     "2px dashed #4f46e5",
    background: "#f5f3ff",
  },
  dropIcon: { fontSize: 34, marginBottom: 8 },
  dropText: { fontSize: 15, fontWeight: 600, color: "#374151", marginBottom: 4 },
  dropHint: { fontSize: 13, color: "#9ca3af" },

  uploadBtn: {
    width:        "100%",
    background:   "#f9fafb",
    border:       "1px solid #e5e7eb",
    color:        "#374151",
    padding:      "12px 0",
    borderRadius: 9,
    fontSize:     14,
    fontWeight:   700,
    cursor:       "pointer",
    marginBottom: 10,
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

  typeBadge: { padding: "3px 10px", borderRadius: 99, fontSize: 11.5, fontWeight: 600, textTransform: "capitalize" as const },

  trackPreviewPanel: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 12,
    marginBottom: 4,
    overflow:     "hidden",
    boxShadow:    "0 1px 2px rgba(0,0,0,0.05)",
  },
  trackPreviewHeader: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    padding:        "12px 18px",
    background:     "#f9fafb",
    borderBottom:   "1px solid #e5e7eb",
  },
  trackPreviewTitle: {
    fontSize:      12,
    fontWeight:    700,
    color:         "#374151",
    textTransform: "uppercase" as const,
    letterSpacing: "0.07em",
  },
  trackPreviewCount: {
    fontSize: 12,
    color:    "#9ca3af",
  },
  trackPreviewBody: {
    padding:             "18px",
    display:             "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
    gap:                 14,
    alignItems:          "start" as const,
  },
  lessonGroup: {
    borderRadius: 10,
    border:       "1px solid #e5e7eb",
    overflow:     "hidden",
  },
  lessonGroupHeader: {
    display:     "flex",
    alignItems:  "center",
    gap:         10,
    padding:     "10px 14px",
    background:  "#f9fafb",
    borderBottom: "1px solid #f3f4f6",
  },
  lessonNum: {
    fontFamily:  "monospace",
    fontSize:    11,
    fontWeight:  700,
    color:       "#4f46e5",
    background:  "#ede9fe",
    padding:     "3px 9px",
    borderRadius: 99,
    flexShrink:  0,
  },
  lessonName: {
    fontSize:   13,
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
    padding:     "8px 14px",
    borderBottom: "1px solid #f6f6f6",
  },
  lessonItemTitle: {
    fontSize:   13,
    color:      "#111",
    flex:       1,
  },
  lessonItemMeta: {
    fontSize:   11.5,
    color:      "#9ca3af",
    fontFamily: "monospace",
    flexShrink: 0,
  },

  // ─── Manage section ───────────────────────────────────────────────────────
  mgmtSection: {
    background:   "#fff",
    border:       "1px solid #e5e7eb",
    borderRadius: 10,
    overflow:     "hidden",
    marginBottom: 12,
    boxShadow:    "0 1px 2px rgba(0,0,0,0.05)",
  },
  mgmtHeader: {
    display:        "flex",
    alignItems:     "center",
    justifyContent: "space-between",
    padding:        "10px 16px",
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
    padding:        "8px 16px",
    borderBottom:   "1px solid #f3f4f6",
    gap:            14,
  },
  mgmtRowEditing: {
    background:  "#f5f3ff",
    borderLeft:  "3px solid #4f46e5",
  },
  mgmtRowPreviewing: {
    background:  "#f0f9ff",
    borderLeft:  "3px solid #0369a1",
  },
  mgmtSlotCell: {
    display:    "flex",
    alignItems: "center",
    gap:        8,
    width:      160,
    flexShrink: 0,
  },
  mgmtSlotCellClickable: {
    cursor: "pointer",
  },
  mgmtTrackBadge: {
    fontSize:     12,
    fontWeight:   700,
    padding:      "4px 11px",
    borderRadius: 99,
    flexShrink:   0,
  },
  mgmtCourseLabel: {
    fontSize:   15,
    fontWeight: 700,
    color:      "#111827",
  },
  mgmtStatusCell: {
    flex:     1,
    fontSize: 13,
  },
  statusLoading: { color: "#9ca3af", fontStyle: "italic" as const, fontSize: 13 },
  statusLive:    { color: "#16a34a", fontWeight: 600, fontSize: 13 },
  statusEmpty:   { color: "#9ca3af", fontSize: 13 },
  mgmtActionsCell: {
    display:    "flex",
    alignItems: "center",
    gap:        8,
    flexShrink: 0,
  },
  mgmtBtn: {
    padding:      "8px 16px",
    borderRadius: 8,
    fontSize:     13,
    fontWeight:   700,
    cursor:       "pointer",
    border:       "none",
  },
  editBtn:       { background: "#ede9fe", color: "#4f46e5" },
  editBtnActive: { background: "#4f46e5", color: "#fff" },
  importToggleBtn:       { background: "#fef3c7", color: "#b45309" },
  importToggleBtnActive: { background: "#b45309", color: "#fff" },
  previewBtn:       { background: "#e0f2fe", color: "#0369a1" },
  previewBtnActive: { background: "#0369a1", color: "#fff" },
  deleteBtn:     { background: "#fee2e2", color: "#dc2626" },
  confirmRow:    { display: "flex", alignItems: "center", gap: 8 },
  confirmText:   { fontSize: 12, color: "#374151", fontWeight: 500 },
  confirmDeleteBtn: { background: "#dc2626", color: "#fff" },
  cancelBtn:     { background: "#f3f4f6", color: "#374151" },
  saveBtn:       { background: "#4f46e5", color: "#fff" },

  // ─── Edit panel ────────────────────────────────────────────────────────────
  editPanel: {
    margin:       "0 0 12px",
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

  actions:    { display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 4, marginBottom: 4 },
  resetBtn:   { background: "#f3f4f6", color: "#374151", border: "none", padding: "9px 18px", borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: "pointer" },
  confirmBtn: {
    background:    "#4f46e5",
    color:         "#fff",
    border:        "none",
    padding:       "9px 22px",
    borderRadius:  7,
    fontSize:      13,
    fontWeight:    700,
    letterSpacing: "0.02em",
  },
};

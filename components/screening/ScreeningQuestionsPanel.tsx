"use client";

// "Screening Questions" tab — shown inside Admissions (School of Music) and the
// ROL+ Screening hub. Everyone who can screen sees the Fast Track tests
// read-only; Founder / Admin / Director / Chief Teacher also get an editor.
// Saves go through /api/admin/screening-questions, which re-checks the role.

import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { isElevatedAccount } from "@/lib/elevatedAccount";
import {
  FAST_TRACK_TEST_MEASURES, MAX_STEPS,
  type FastTrackTest, type ScreeningGrade,
} from "@/lib/screeningQuestions";
import {
  getFastTrackTests, resetFastTrackTests, saveFastTrackTests,
} from "@/services/screening/screeningQuestions.service";

const ACCENT = "#d97706";

const GRADE_STYLE: Record<ScreeningGrade, { color: string; bg: string; border: string }> = {
  High:   { color: "#15803d", bg: "#f0fdf4", border: "#bbf7d0" },
  Medium: { color: "#92400e", bg: "#fffbeb", border: "#fde68a" },
  Low:    { color: "#991b1b", bg: "#fef2f2", border: "#fecaca" },
};

const card: React.CSSProperties = {
  background: "#fff", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 18,
  padding: 22, boxShadow: "0 1px 3px rgba(0,0,0,0.05), 0 4px 14px rgba(0,0,0,0.03)",
};
const btn: React.CSSProperties = {
  padding: "9px 16px", borderRadius: 10, border: "none", fontSize: 12.5, fontWeight: 700,
  cursor: "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 6,
};
const input: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", border: "1.5px solid #e5e7eb", borderRadius: 9,
  padding: "8px 11px", fontSize: 13, fontFamily: "inherit", color: "#111", background: "#fff",
};
const fieldLabel: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, color: "#6b7280", textTransform: "uppercase",
  letterSpacing: "0.08em", display: "block", marginBottom: 6,
};
const iconBtn: React.CSSProperties = {
  border: "1px solid #e5e7eb", background: "#fff", borderRadius: 7, width: 28, height: 28,
  cursor: "pointer", fontSize: 12, color: "#6b7280", flexShrink: 0, fontFamily: "inherit",
};

const clone = (t: FastTrackTest[]): FastTrackTest[] => JSON.parse(JSON.stringify(t));

export function ScreeningQuestionsPanel({ wing }: { wing: string }) {
  const { user } = useAuth();
  const canEdit = isElevatedAccount(user);

  const [tests, setTests]           = useState<FastTrackTest[] | null>(null);
  const [customised, setCustomised] = useState(false);
  const [draft, setDraft]           = useState<FastTrackTest[] | null>(null);
  const [busy, setBusy]             = useState(false);
  const [err, setErr]               = useState("");
  const [flash, setFlash]           = useState("");

  async function load() {
    setErr("");
    try {
      const res = await getFastTrackTests(wing);
      setTests(res.tests);
      setCustomised(res.customised);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load screening questions.");
    }
  }
  useEffect(() => { setTests(null); setDraft(null); load(); }, [wing]); // eslint-disable-line react-hooks/exhaustive-deps

  function showFlash(text: string) {
    setFlash(text);
    setTimeout(() => setFlash(""), 2500);
  }

  function patch(ti: number, fn: (t: FastTrackTest) => void) {
    setDraft(d => {
      if (!d) return d;
      const next = clone(d);
      fn(next[ti]);
      return next;
    });
  }

  async function save() {
    if (!draft) return;
    setBusy(true); setErr("");
    try {
      await saveFastTrackTests(wing, draft);
      setDraft(null);
      await load();
      showFlash("Screening questions saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!window.confirm("Reset all three tests to the original wording? Your edits will be lost.")) return;
    setBusy(true); setErr("");
    try {
      await resetFastTrackTests(wing);
      setDraft(null);
      await load();
      showFlash("Reset to the default questions.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Reset failed.");
    } finally {
      setBusy(false);
    }
  }

  const editing = !!draft;
  const shown = draft ?? tests;

  return (
    <div>
      {/* Header */}
      <div style={{ ...card, padding: "16px 20px", marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 220, flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#111" }}>Fast Track screening questions</div>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 3 }}>
            {canEdit
              ? "Teachers see these exact tests when they screen a student. Edits apply to every new screening in this wing."
              : "The tests you run and grade during screening. Only the Founder, Admin, Director or Chief Teacher can change them."}
            {customised && !editing && <span style={{ color: "#9ca3af" }}> · Customised</span>}
          </div>
        </div>
        {canEdit && tests && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {editing ? (
              <>
                <button onClick={() => setDraft(null)} disabled={busy} style={{ ...btn, background: "#f3f4f6", color: "#374151" }}>Cancel</button>
                <button onClick={save} disabled={busy} style={{ ...btn, background: ACCENT, color: "#fff", opacity: busy ? 0.6 : 1 }}>
                  {busy ? "Saving…" : "Save questions"}
                </button>
              </>
            ) : (
              <>
                {customised && (
                  <button onClick={reset} disabled={busy} style={{ ...btn, background: "#fff", color: "#6b7280", border: "1px solid #e5e7eb" }}>
                    Reset to defaults
                  </button>
                )}
                <button onClick={() => setDraft(clone(tests))} style={{ ...btn, background: ACCENT, color: "#fff" }}>
                  ✏ Edit screening questions
                </button>
              </>
            )}
          </div>
        )}
        {!canEdit && (
          <span style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", background: "#f3f4f6", borderRadius: 999, padding: "4px 10px" }}>🔒 View only</span>
        )}
      </div>

      {err && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: "9px 13px", fontSize: 13, color: "#dc2626", marginBottom: 12 }}>{err}</div>}
      {flash && <div style={{ fontSize: 13, color: "#15803d", fontWeight: 600, marginBottom: 12 }}>✓ {flash}</div>}

      {!shown ? (
        <div style={{ padding: 30, textAlign: "center", fontSize: 13, color: "#9ca3af" }}>Loading questions…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {shown.map((t, ti) => (
            <div key={t.code} style={card}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 16 }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: ACCENT, background: "#fef3c7", borderRadius: 8, padding: "4px 11px", letterSpacing: "0.08em", fontFamily: "monospace", flexShrink: 0, marginTop: 2 }}>
                  {t.code}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {editing ? (
                    <div style={{ display: "grid", gap: 8 }}>
                      <input value={t.title} maxLength={80} placeholder="Test title" aria-label={`${t.code} title`}
                        onChange={e => patch(ti, x => { x.title = e.target.value; })} style={{ ...input, fontWeight: 700 }} />
                      <input value={t.sub} maxLength={160} placeholder="One-line summary (optional)" aria-label={`${t.code} summary`}
                        onChange={e => patch(ti, x => { x.sub = e.target.value; })} style={{ ...input, fontSize: 12 }} />
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: 14, fontWeight: 800, color: "#111" }}>{t.title}</div>
                      {t.sub && <div style={{ fontSize: 11.5, color: "#9ca3af", marginTop: 2 }}>{t.sub}</div>}
                    </>
                  )}
                </div>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: "#6b7280", background: "#f3f4f6", borderRadius: 999, padding: "3px 9px", flexShrink: 0 }}
                  title="What this test scores — fixed, because the slab result depends on it">
                  Scores {FAST_TRACK_TEST_MEASURES[ti]}
                </span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
                {/* Procedure */}
                <div style={{ background: "#f8f9fb", border: "1px solid #f0f0f0", borderRadius: 14, padding: "16px 18px" }}>
                  <span style={fieldLabel}>Procedure</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {t.steps.map((s, si) => editing ? (
                      <div key={si} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                        <input value={s.tag} maxLength={30} placeholder="Label" aria-label={`Step ${si + 1} label`}
                          onChange={e => patch(ti, x => { x.steps[si].tag = e.target.value; })}
                          style={{ ...input, width: 92, flexShrink: 0, fontSize: 12 }} />
                        <textarea value={s.text} maxLength={300} rows={2} placeholder="What to do" aria-label={`Step ${si + 1} text`}
                          onChange={e => patch(ti, x => { x.steps[si].text = e.target.value; })}
                          style={{ ...input, fontSize: 12, resize: "vertical" }} />
                        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                          <button type="button" title="Move up" aria-label="Move step up" disabled={si === 0}
                            onClick={() => patch(ti, x => { [x.steps[si - 1], x.steps[si]] = [x.steps[si], x.steps[si - 1]]; })}
                            style={{ ...iconBtn, opacity: si === 0 ? 0.35 : 1 }}>↑</button>
                          <button type="button" title="Move down" aria-label="Move step down" disabled={si === t.steps.length - 1}
                            onClick={() => patch(ti, x => { [x.steps[si + 1], x.steps[si]] = [x.steps[si], x.steps[si + 1]]; })}
                            style={{ ...iconBtn, opacity: si === t.steps.length - 1 ? 0.35 : 1 }}>↓</button>
                        </div>
                        <button type="button" title="Remove step" aria-label="Remove step" disabled={t.steps.length <= 1}
                          onClick={() => patch(ti, x => { x.steps.splice(si, 1); })}
                          style={{ ...iconBtn, color: "#dc2626", opacity: t.steps.length <= 1 ? 0.35 : 1 }}>✕</button>
                      </div>
                    ) : (
                      <div key={si} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: ACCENT, minWidth: 66, flexShrink: 0 }}>{s.tag}</span>
                        <span style={{ fontSize: 12, color: "#374151", lineHeight: 1.55 }}>{s.text}</span>
                      </div>
                    ))}
                    {editing && t.steps.length < MAX_STEPS && (
                      <button type="button" onClick={() => patch(ti, x => { x.steps.push({ tag: "", text: "" }); })}
                        style={{ ...btn, background: "#fff", color: ACCENT, border: "1px dashed #fcd34d", alignSelf: "flex-start", padding: "6px 12px" }}>
                        + Add step
                      </button>
                    )}
                  </div>
                  <div style={{ borderTop: "1px solid #f0f0f0", marginTop: 12, paddingTop: 10 }}>
                    {editing ? (
                      <>
                        <span style={fieldLabel}>Evaluator tip</span>
                        <textarea value={t.tip} maxLength={400} rows={2} aria-label={`${t.code} tip`}
                          onChange={e => patch(ti, x => { x.tip = e.target.value; })}
                          style={{ ...input, fontSize: 12, resize: "vertical" }} />
                      </>
                    ) : (
                      t.tip && <div style={{ fontSize: 11, color: "#9ca3af", lineHeight: 1.6 }}>{t.tip}</div>
                    )}
                  </div>
                </div>

                {/* Rubric */}
                <div>
                  <span style={fieldLabel}>Scoring rubric</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {t.rubric.map((r, ri) => {
                      const g = GRADE_STYLE[r.grade];
                      return (
                        <div key={r.grade} style={{ border: `1.5px solid ${g.border}`, background: g.bg, borderRadius: 12, padding: "10px 12px" }}>
                          <div style={{ fontSize: 11, fontWeight: 800, color: g.color, marginBottom: 4 }}>
                            {r.grade.toUpperCase()} · {r.grade === "High" ? 5 : r.grade === "Medium" ? 3 : 1}/5
                          </div>
                          {editing ? (
                            <textarea value={r.desc} maxLength={300} rows={2} aria-label={`${t.code} ${r.grade} description`}
                              onChange={e => patch(ti, x => { x.rubric[ri].desc = e.target.value; })}
                              style={{ ...input, fontSize: 12, resize: "vertical" }} />
                          ) : (
                            <div style={{ fontSize: 12, color: "#374151", lineHeight: 1.5 }}>{r.desc}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          ))}
          {editing && (
            <div style={{ fontSize: 11.5, color: "#9ca3af" }}>
              The three tests and their High / Medium / Low scores are fixed — the Delta / Epsilon / Zeta slab result depends on them.
              Blank fields fall back to the original wording when saved.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

# Finance UI Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify the Finance page UI — 8 summary cards → 4, student table 9 columns → 5, chip filters → dropdowns, and a single primary action button per row with an expandable detail section.

**Architecture:** All changes are in `app/dashboard/finance/page.tsx` only. No business logic, Firestore queries, or service layer changes. Each task is an isolated JSX/state edit in that one file.

**Tech Stack:** Next.js 14, React 18, TypeScript, Firestore (no changes), inline styles via `st` object.

---

## File Structure

Only one file changes:

- **Modify:** `app/dashboard/finance/page.tsx` — all 4 tasks edit this file

---

## Task 1: Summary Cards (8 → 4)

**Files:**
- Modify: `app/dashboard/finance/page.tsx:718-736` (cards JSX)
- Modify: `app/dashboard/finance/page.tsx:1927` (cardGrid style — widen minmax)

- [ ] **Step 1: Replace the 8-card block with 4 cards**

Find lines 718–736 (the `{/* ── Summary Cards */}` block) and replace the entire `<div style={st.cardGrid}>…</div>` with:

```tsx
{/* ── Summary Cards ────────────────────────────────────────────────────── */}
<div style={st.cardGrid}>
  <SummaryCard
    label={`Collected — ${fmtMonth(selectedMonth)}`}
    value={loading ? "…" : fmtINR(summary.total)}
    accent="#16a34a" icon="💰"
    hint={loading ? undefined : isCurrentMonth
      ? `${fmtINR(summary.todayAmt)} today`
      : "Historical view"}
  />
  <SummaryCard
    label="Overdue"
    value={loading ? "…" : String(summary.overdueCount)}
    accent="#dc2626" icon="🚨"
    urgent={summary.overdueCount > 0}
    hint={loading ? undefined : `${fmtINR(summary.pendingBal)} pending`}
  />
  <SummaryCard
    label="Active Students"
    value={loading ? "…" : String(summary.activeCount)}
    accent="#059669" icon="🎓"
    hint={loading ? undefined : `${summary.groupCount} group · ${summary.personalCount} personal`}
  />
  <SummaryCard
    label="Prepay Credit"
    value={loading ? "…" : fmtINR(summary.prepayCredit)}
    accent="#9d174d" icon="⬆"
    urgent={summary.lowCreditCount > 0}
    hint={loading ? undefined : summary.lowCreditCount > 0
      ? `⚠ ${summary.lowCreditCount} low credit`
      : `${summary.prepayCount} prepay students`}
  />
</div>
```

- [ ] **Step 2: Widen cardGrid minmax so 4 cards fill the row properly**

Find line ~1927 (the `cardGrid` entry in the `st` object):
```ts
// Before
cardGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(155px, 1fr))", gap: 14, marginBottom: 24 },
// After
cardGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginBottom: 24 },
```

- [ ] **Step 3: Verify in browser**

The dev server is already running on `http://localhost:3000`. Open the Finance page. You should see 4 wider cards instead of 8 smaller ones. The "Collected" card should show today's amount as a hint line. The "Overdue" card should show the pending balance as a hint. The "Active Students" card should show the group/personal split.

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/finance/page.tsx
git commit -m "ui: reduce finance summary cards from 8 to 4 with hint lines"
```

---

## Task 2: Filter Row Simplification

**Files:**
- Modify: `app/dashboard/finance/page.tsx:155-156` (remove 2 states, add 1)
- Modify: `app/dashboard/finance/page.tsx:627-647` (filteredStudents useMemo)
- Modify: `app/dashboard/finance/page.tsx:757-820` (filter row JSX)

- [ ] **Step 1: Replace the two chip-filter states with one combined `filterType` state**

Find lines 155–156:
```ts
// Remove these two lines:
const [filterClassType, setFilterClassType]   = useState<string>("all");  // "all" | "group" | "personal"
const [filterBillingMode, setFilterBillingMode] = useState<string>("all"); // "all" | "prepay" | "postpay"
```
Replace with:
```ts
const [filterType, setFilterType] = useState<string>("all"); // "all"|"group"|"personal"|"prepay"|"postpay"
```

- [ ] **Step 2: Update the `filteredStudents` useMemo**

Find the `filteredStudents` useMemo (lines ~627–647) and replace it entirely:

```ts
const filteredStudents = useMemo(() => {
  let list = filterCenter === "all" ? students : students.filter(s => s.centerId === filterCenter);
  if      (filterType === "group")    list = list.filter(s => s.classType  === "group");
  else if (filterType === "personal") list = list.filter(s => s.classType  === "personal");
  else if (filterType === "prepay")   list = list.filter(s => s.billingMode === "prepay");
  else if (filterType === "postpay")  list = list.filter(s => s.billingMode === "postpay");
  if (studentSearch.trim()) {
    const q = studentSearch.toLowerCase();
    list = list.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.studentID.toLowerCase().includes(q)
    );
  }
  return [...list].sort((a, b) => {
    if (b.balance > 0 && a.balance <= 0) return 1;
    if (a.balance > 0 && b.balance <= 0) return -1;
    return a.name.localeCompare(b.name);
  });
}, [students, filterCenter, studentSearch, filterType]);
```

- [ ] **Step 3: Replace the filter row JSX**

Find the `{/* ── Shared filters */}` block (lines ~757–820) and replace the entire `<div style={st.filterRow}>…</div>` with:

```tsx
{/* ── Shared filters ───────────────────────────────────────────────────── */}
<div style={st.filterRow}>
  <select value={filterCenter} onChange={e => setFilterCenter(e.target.value)} style={st.filterSelect}>
    <option value="all">All Centers</option>
    {centers.map(c => (
      <option key={c.id} value={c.id}>[{c.centerCode}] {c.name}</option>
    ))}
  </select>
  {tab === "students" && (
    <>
      <input
        type="search"
        placeholder="Search name or ID…"
        value={studentSearch}
        onChange={e => setStudentSearch(e.target.value)}
        style={{ ...st.searchInput, flex: 1 }}
      />
      <select value={filterType} onChange={e => setFilterType(e.target.value)} style={st.filterSelect}>
        <option value="all">All Types</option>
        <option value="group">👥 Group</option>
        <option value="personal">👤 Personal</option>
        <option value="postpay">⬇ Postpay</option>
        <option value="prepay">⬆ Prepay</option>
      </select>
    </>
  )}
  {tab === "transactions" && (
    <>
      <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={st.filterSelect}>
        <option value="all">All Statuses</option>
        <option value="completed">Completed</option>
        <option value="pending">Pending</option>
        <option value="failed">Failed</option>
      </select>
      <input type="date" value={filterDate} onChange={e => setFilterDate(e.target.value)}
        style={st.filterDate} />
      {filterDate && (
        <button onClick={() => setFilterDate("")} style={st.clearDate}>✕ Clear date</button>
      )}
    </>
  )}
</div>
```

- [ ] **Step 4: Verify in browser**

Open Finance → Students tab. The two chip groups (Group/Personal and Postpay/Prepay) should be gone. There should be a wider search box and a single "All Types" dropdown that filters by group, personal, prepay, or postpay. Test each option to confirm filtering still works.

- [ ] **Step 5: Commit**

```bash
git add app/dashboard/finance/page.tsx
git commit -m "ui: replace student filter chip groups with single Type dropdown"
```

---

## Task 3: Student Table Row — 5 Columns + Primary Action Button

**Files:**
- Modify: `app/dashboard/finance/page.tsx:880-903` (table headers)
- Modify: `app/dashboard/finance/page.tsx:935-1098` (student row `<tr>`)

- [ ] **Step 1: Replace the table headers**

Find the `<thead>` block inside the students table (lines ~880–903) and replace it:

```tsx
<thead>
  <tr>
    <th style={st.th}>Student</th>
    <th style={st.th}>Type</th>
    <th style={st.th}>Fee</th>
    <th style={st.th}>
      Balance
      {!isCurrentMonth && (
        <span style={{ fontSize: 10, fontWeight: 400, color: "#b45309", display: "block" }}>
          as of {fmtMonth(selectedMonth)}
        </span>
      )}
    </th>
    <th style={st.th}>Action</th>
  </tr>
</thead>
```

- [ ] **Step 2: Replace the main student `<tr>` with the new 5-column row**

Find the `{/* ── Main data row */}` comment (line ~934) through the closing `</tr>` of the main row (line ~1098). Replace that entire `<tr>…</tr>` with:

```tsx
{/* ── Main data row ─────────────────────────────── */}
<tr
  key={s.uid}
  style={{ background: rowBg, transition: "background 0.15s", cursor: "pointer" }}
  onClick={(e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const defaultAction: RowAction = isPrepay ? "deposit" : "pay";
    openPanel(s.uid, defaultAction, s);
  }}
>
  {/* Student + center */}
  <td style={{ ...st.td, minWidth: 160 }}>
    <div style={{ fontWeight: 600 }}>{s.name}</div>
    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 2 }}>
      {s.centerName}{" · "}<span style={st.studentIDChip}>{s.studentID}</span>
    </div>
  </td>

  {/* Type */}
  <td style={st.td}>
    <span style={{
      ...st.badge,
      ...(s.classType === "personal"
        ? { background: "#fef9c3", color: "#92400e" }
        : { background: "#dcfce7", color: "#166534" }),
    }}>
      {s.classType === "personal" ? "👤 Personal" : "👥 Group"}
    </span>
    <div style={{ fontSize: 11, color: "var(--color-text-secondary)", marginTop: 3 }}>
      {s.feeCycle === "monthly" ? "Monthly" : "Per Class"} · {isPrepay ? "Prepay" : "Postpay"}
    </div>
  </td>

  {/* Fee */}
  <td style={{ ...st.td, fontWeight: 600 }}>
    {fmtINR(s.feeCycle === "monthly" ? s.monthlyFee : s.feePerClass)}
  </td>

  {/* Balance */}
  <td style={{ ...st.td, fontWeight: 700 }}>
    {overdue ? (
      <span style={{ color: "#dc2626", display: "flex", alignItems: "center", gap: 4 }}>
        {fmtINR(s.balance)}
        <span style={st.overduePill}>DUE</span>
      </span>
    ) : hasCredit ? (
      <div>
        <span style={{ color: "#16a34a" }}>Credit {fmtINR(creditAmt)}</span>
        {lowCredit && (
          <div style={{ fontSize: 10, color: "#b45309", fontWeight: 600, marginTop: 2 }}>
            ⚠ Low credit
          </div>
        )}
      </div>
    ) : (
      <span style={{ color: "#16a34a" }}>✓ Cleared</span>
    )}
  </td>

  {/* Primary action */}
  <td style={{ ...st.td, whiteSpace: "nowrap" as const }}>
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      {overdue ? (
        <button
          onClick={() => openPanel(s.uid, "pay", s)}
          style={{ ...st.actionBtn, background: "#dc2626", color: "#fff", border: "none" }}
        >
          💳 Collect
        </button>
      ) : isPrepay && lowCredit ? (
        <button
          onClick={() => openPanel(s.uid, "deposit", s)}
          style={{ ...st.actionBtn, background: "#9d174d", color: "#fff", border: "none" }}
        >
          ⬆ Top Up
        </button>
      ) : isPrepay ? (
        <button
          onClick={() => openPanel(s.uid, "deposit", s)}
          style={{
            ...st.actionBtn,
            ...(isOpen && activeAction === "deposit" ? st.actionBtnActive : {}),
          }}
        >
          ⬆ Deposit
        </button>
      ) : (
        <button
          onClick={() => openPanel(s.uid, "pay", s)}
          style={{
            ...st.actionBtn,
            ...(isOpen && activeAction === "pay" ? st.actionBtnActive : {}),
          }}
        >
          ⋯ More
        </button>
      )}
      {isOpen && (
        <button onClick={closePanel} style={st.closePanelBtn} title="Close">✕</button>
      )}
    </div>
  </td>
</tr>
```

- [ ] **Step 3: Verify in browser**

Open Finance → Students tab. The table should have 5 columns: Student (with center + ID sub-line), Type (badge + sub-text), Fee, Balance, Action. Overdue students show a red "💳 Collect" button; prepay low-credit students show a maroon "⬆ Top Up"; prepay ok-credit show "⬆ Deposit"; cleared postpay show "⋯ More".

- [ ] **Step 4: Commit**

```bash
git add app/dashboard/finance/page.tsx
git commit -m "ui: student table 9 columns → 5 with single primary action button"
```

---

## Task 4: Expanded Row — Attendance Strip + Action Tabs

**Files:**
- Modify: `app/dashboard/finance/page.tsx:1100-1538` (inline panel `<tr>`)

- [ ] **Step 1: Replace the panel row wrapper and add attendance strip + action tabs**

Find `{isOpen && (` after the closing `</tr>` of the main row (line ~1100). The panel row currently is:

```tsx
{isOpen && (
  <tr key={`${s.uid}-panel`}>
    <td colSpan={9} style={{ padding: "0 14px 16px", background: "#fffbeb" }}>
      {/* 4 panels rendered by activeAction */}
```

Replace only the opening wrapper — change `colSpan={9}` to `colSpan={5}` and add the attendance strip + action tabs **before** the existing panel content:

```tsx
{isOpen && (
  <tr key={`${s.uid}-panel`}>
    <td colSpan={5} style={{ padding: "0 14px 16px", background: "#fffbeb" }}>

      {/* ── Attendance info strip ─────────────────────── */}
      <div style={{
        display: "flex", gap: 20, alignItems: "center",
        padding: "10px 0", borderBottom: "1px solid #fde68a", marginBottom: 14,
        flexWrap: "wrap" as const, fontSize: 13, color: "#6b7280",
      }}>
        <span>
          <span style={{ fontWeight: 700, color: "#1d4ed8" }}>{s.attendanceCount}</span>
          {" classes — "}{fmtMonth(selectedMonth)}
        </span>
        {s.feeCycle === "per_class" && (
          <span>
            Est. fee:{" "}
            <span style={{ fontWeight: 700, color: "#7c3aed" }}>{fmtINR(s.estimatedFee)}</span>
          </span>
        )}
        {lastTxMap.get(s.uid) && (
          <span>
            Last payment:{" "}
            <span style={{ fontWeight: 600 }}>{fmtINR(lastTxMap.get(s.uid)!.amount)}</span>
            {" · "}{formatDate(lastTxMap.get(s.uid)!.date ?? lastTxMap.get(s.uid)!.createdAt)}
          </span>
        )}
      </div>

      {/* ── Action tabs ───────────────────────────────── */}
      <div style={{ display: "flex", gap: 4, marginBottom: 14, flexWrap: "wrap" as const }}>
        {(!isPrepay || overdue) && (
          <button
            onClick={() => setActiveAction("pay")}
            style={{
              ...st.tab, flex: "none" as const, padding: "6px 14px",
              ...(activeAction === "pay" ? st.tabActive : {}),
            }}
          >
            💳 Pay
          </button>
        )}
        {isPrepay && (
          <button
            onClick={() => setActiveAction("deposit")}
            style={{
              ...st.tab, flex: "none" as const, padding: "6px 14px",
              ...(activeAction === "deposit" ? st.tabActive : {}),
            }}
          >
            ⬆ Deposit
          </button>
        )}
        <button
          onClick={() => setActiveAction("adjust")}
          style={{
            ...st.tab, flex: "none" as const, padding: "6px 14px",
            ...(activeAction === "adjust" ? st.tabActive : {}),
          }}
        >
          ✏️ Adjust Fee
        </button>
        {s.feeCycle === "monthly" && (
          <button
            onClick={() => setActiveAction("bill")}
            disabled={!canBill}
            title={
              alreadyBilled
                ? `Fee due already generated for ${fmtMonth(month)}`
                : !cycleComplete
                  ? `Available after ${fmtMonth(month)} ends — pick a completed month`
                  : `Generate fee due for ${fmtMonth(month)}`
            }
            style={{
              ...st.tab, flex: "none" as const, padding: "6px 14px",
              ...(activeAction === "bill" ? st.tabActive : {}),
              ...(!canBill ? { opacity: 0.4, cursor: "not-allowed" as const } : {}),
            }}
          >
            🗓 Generate Due
          </button>
        )}
      </div>

      {/* ════ PAY PANEL ══════════ keep existing content unchanged ════ */}
      {/* ════ ADJUST FEE PANEL ═══ keep existing content unchanged ════ */}
      {/* ════ BILL PANEL ══════════ keep existing content unchanged ════ */}
      {/* ════ DEPOSIT PANEL ═══════ keep existing content unchanged ════ */}
```

**Important:** The 4 panel blocks (`{activeAction === "pay" && …}`, `{activeAction === "adjust" && …}`, `{activeAction === "bill" && …}`, `{activeAction === "deposit" && …}`) stay **exactly as they are** — do not change their content. Only the outer wrapper (`colSpan` and what's prepended before them) changes.

The closing `</td></tr>` and `)}` remain as-is.

- [ ] **Step 2: Verify in browser**

Open Finance → Students tab. Click any student row (not on the button). The row should expand showing:
- An info strip with class count for the month, estimated fee (for per-class), and last payment date
- Tab buttons: Pay / Deposit (prepay only) / Adjust Fee / Generate Due (monthly only)
- The currently active panel below the tabs

Switch between tabs — each should show its correct panel. Clicking the primary button should open the panel with the right tab pre-selected. Clicking the row body (not a button) should expand with the appropriate default tab.

- [ ] **Step 3: Commit**

```bash
git add app/dashboard/finance/page.tsx
git commit -m "ui: expanded row with attendance strip and action tabs"
```

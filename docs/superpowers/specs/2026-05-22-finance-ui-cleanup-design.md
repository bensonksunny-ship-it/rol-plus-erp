# Finance UI Cleanup — Design Spec
**Date:** 2026-05-22  
**Goal:** Make the finance page cleaner and easier to understand for admins, without removing any features.

---

## 1. Summary Cards (8 → 4)

Reduce cognitive load at the top of the page by collapsing 8 cards into 4. Secondary metrics become hint lines on each card.

| Card | Primary value | Hint line |
|---|---|---|
| 💰 Collected | Month total | "₹X today" |
| 🚨 Overdue | Student count | "₹X pending" — red when > 0 |
| 🎓 Active Students | Count | "X group · X personal" |
| ⬆ Prepay Credit | Credit held | "⚠ X low credit" when applicable |

**Removed cards:** Collected Today, Pending Balance, Low Credit Alert, Est. Fees.  
All four values remain visible — just moved to hint lines or the expanded row.

---

## 2. Student Table Columns (9 → 5)

Reduce table width and scanning effort by merging related columns.

### New column layout

| Column | Content |
|---|---|
| **Student** | Name (bold) + center name + student ID as sub-line |
| **Type** | Group/Personal badge + "Monthly · Postpay" sub-text |
| **Fee** | Monthly fee or per-class fee amount |
| **Balance** | Due (red) / Credit (green) / Cleared (green) — same logic as now |
| **Action** | One primary button (context-sensitive) |

### Primary button logic

| Student state | Button |
|---|---|
| Balance > 0 (overdue) | 💳 Collect — red |
| Prepay + low credit (credit ≤ one fee cycle) | ⬆ Top Up — maroon, highlighted |
| Prepay + ok credit | ⬆ Deposit — subtle |
| Cleared / no urgent action | ⋯ More — grey (opens the expanded row, same as clicking the row) |

### Expandable row (click anywhere on the row)

Clicking a row expands a detail section below it containing:
- Attendance count this month + estimated fee (per-class students)
- **Adjust Fee** form (same as current)
- **Generate Fee Due** button (monthly students, past months only)
- All four action panels (Pay, Deposit, Adjust, Bill) remain fully functional — just accessed from the expanded row instead of individual buttons

The current inline panel system stays — the row expansion replaces the "Actions" column's 3–4 buttons.

---

## 3. Filter Row Simplification

Replace two chip-button groups with two dropdowns, reducing visual clutter.

**Before:**
- Center dropdown
- Search input
- [All / 👥 Group / 👤 Personal] chip group
- [All Billing / ⬇ Postpay / ⬆ Prepay] chip group

**After:**
- 🔍 Search input (wide, prominent)
- Centers dropdown
- Type dropdown: All / Group / Personal / Prepay / Postpay

Same filter capability — fewer controls visible at once.

---

## 4. What Does NOT Change

- All transaction logic (pay, deposit, adjust fee, generate fee due, edit, delete)
- Overview and Transactions tabs — no changes
- Month selector behaviour
- Historical month view
- Balance calculations and display logic
- Overdue banner in students tab
- Past-month notice
- Role-based permissions

---

## 5. Implementation Tasks (short, independent)

1. **Cards** — Reduce `SummaryCard` grid from 8 to 4; add hint lines for secondary values
2. **Filter row** — Replace chip groups with Type dropdown; widen search input
3. **Table columns** — Merge Student+Center, Class+Billing into Type, remove Att./Est.Fee columns
4. **Row expand** — Add click-to-expand row showing attendance, est. fee, + secondary action panels
5. **Primary action button** — Replace multi-button Actions column with single context-sensitive button

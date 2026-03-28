import type { Timestamp } from "firebase/firestore";

// ─── Teacher Quality Score ────────────────────────────────────────────────────

export interface QualityFactors {
  attendanceDiscipline: number;  // 0–100
  syllabusProgress:     number;  // 0–100
  studentRetention:     number;  // 0–100
}

export interface TeacherQuality {
  id:           string;   // same as teacherId
  teacherId:    string;
  score:        number;   // 0–100 — weighted average of factors
  factors:      QualityFactors;
  lastUpdated:  Timestamp | string;
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

export interface RankEntry {
  teacherId:    string;
  displayName:  string;
  score:        number;
  rank:         number;
}

export interface Leaderboard {
  id:               string;   // same as centerId
  centerId:         string;
  monthlyRankings:  RankEntry[];
  lifetimeRankings: RankEntry[];
  lastUpdated:      Timestamp | string;
}

// ─── Computation helpers (returned from score functions, not stored) ──────────

export interface TeacherScoreInput {
  teacherId:    string;
  centerIds:    string[];
  displayName:  string;
}

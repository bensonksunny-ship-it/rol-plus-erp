"use client";

/**
 * useCentreAccess
 *
 * Single source of truth for centre-based access control.
 *
 * Rules:
 *  - Teachers: may only access centres in their centerIds array.
 *  - Admins / Super Admins: may access all centres.
 *
 * Usage:
 *   const { teacherCentreIds, isTeacherRole, isAllowed } = useCentreAccess();
 *   if (!isAllowed(selectedCentreId)) return <AccessDenied />;
 */

import { useMemo } from "react";
import { useAuthContext } from "@/features/auth/AuthContext";
import { ROLES } from "@/config/constants";
import { isTeacher } from "@/types";

export interface CentreAccessResult {
  /** UIDs of centres this user may access (empty array = all for admins). */
  teacherCentreIds: string[];
  /** True when the logged-in user has the TEACHER role. */
  isTeacherRole: boolean;
  /**
   * Returns true if the user is allowed to access the given centreId.
   * Admins always get true. Teachers get true only if centreId is in their list.
   */
  isAllowed: (centreId: string) => boolean;
  /**
   * Filter a list of centre objects to only those the user may access.
   * Admin: returns the full list unchanged.
   * Teacher: returns only centres in their centerIds.
   */
  filterCentres: <T extends { id: string }>(centres: T[]) => T[];
}

export function useCentreAccess(): CentreAccessResult {
  const { user } = useAuthContext();

  // Serialise centerIds to a stable string so useMemo re-runs when the list changes.
  // isTeacher() type guard safely narrows to TeacherUser before accessing centerIds.
  const centreIdsKey = user && isTeacher(user) ? user.centerIds.join(",") : "";

  return useMemo<CentreAccessResult>(() => {
    const isTeacherRole    = user?.role === ROLES.TEACHER;
    const teacherCentreIds = centreIdsKey ? centreIdsKey.split(",") : [];

    const isAllowed = (centreId: string): boolean => {
      if (!isTeacherRole) return true;    // admin / super_admin: always allowed
      if (!centreId)      return false;   // nothing selected yet
      return teacherCentreIds.includes(centreId);
    };

    const filterCentres = <T extends { id: string }>(centres: T[]): T[] => {
      if (!isTeacherRole) return centres;
      return centres.filter(c => teacherCentreIds.includes(c.id));
    };

    return { teacherCentreIds, isTeacherRole, isAllowed, filterCentres };
  // Re-evaluate when uid changes OR when the centerIds list actually changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, centreIdsKey]);
}

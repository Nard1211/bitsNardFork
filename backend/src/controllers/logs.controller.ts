import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a dateStr like "2026-03-05" (PHT) to UTC Date range [start, end] */
function phtDateToUTCRange(dateStr: string): { start: Date; end: Date } {
    // PHT midnight = UTC-8h of that day  →  UTC 16:00 of the PREVIOUS day
    const start = new Date(`${dateStr}T00:00:00+08:00`);
    const end = new Date(`${dateStr}T23:59:59.999+08:00`);
    return { start, end };
}

/** Derive on-time/late status from a UTC check-in timestamp */
function deriveStatus(checkInUTC: Date): 'on-time' | 'late' {
    const phtHour = new Date(checkInUTC.getTime() + 8 * 3600_000).getUTCHours();
    const phtMinute = new Date(checkInUTC.getTime() + 8 * 3600_000).getUTCMinutes();
    return phtHour > 8 || (phtHour === 8 && phtMinute > 0) ? 'late' : 'on-time';
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface LogEntry {
    id: string;
    type: 'timekeeping' | 'system';
    timestamp: string;   // ISO string (UTC)
    employeeName: string;
    employeeId: number;
    action: string;
    details: string;
    source: string;
    status?: string;
}

// ── Controller ────────────────────────────────────────────────────────────────

/**
 * GET /api/logs
 * Query params:
 *   startDate  - YYYY-MM-DD (PHT)
 *   endDate    - YYYY-MM-DD (PHT)
 *   type       - 'all' | 'timekeeping' | 'system'   (default: 'all')
 *   page       - number (default: 1)
 *   limit      - number (default: 30)
 */
export const getLogs = async (req: Request, res: Response) => {
    try {
        const {
            startDate,
            endDate,
            type = 'all',
            page = '1',
            limit = '30',
        } = req.query as Record<string, string>;

        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(200, Math.max(1, parseInt(limit)));

        // Build UTC date boundaries from PHT dates
        const startUTC = startDate
            ? phtDateToUTCRange(startDate).start
            : new Date('2000-01-01');
        const endUTC = endDate
            ? phtDateToUTCRange(endDate).end
            : new Date();

        // ── 1. Always compute accurate counts (independent of type filter) ────
        //    We use cheap COUNT queries so the tab badges are always correct
        //    regardless of which tab is active.

        // Timekeeping count = Attendance rows × up to 2 events each
        const attCount = await prisma.attendance.count({
            where: { date: { gte: startUTC, lte: endUTC } },
        });
        // We need the actual expanded count (check-ins + check-outs)
        const attsForCount = await prisma.attendance.count({
            where: { date: { gte: startUTC, lte: endUTC }, checkOutTime: { not: null } },
        });
        // timekeeping events = all check-ins + only those that have check-outs
        const timekeepingCount = attCount + attsForCount;

        // System count = raw AttendanceLog rows in date range
        const systemCount = await prisma.attendanceLog.count({
            where: { timestamp: { gte: startUTC, lte: endUTC } },
        });

        // ── 2. Fetch data entries only for the active type ─────────────────
        let timekeepingEntries: LogEntry[] = [];
        let systemEntries: LogEntry[] = [];

        if (type === 'all' || type === 'timekeeping') {
            const atts = await prisma.attendance.findMany({
                where: { date: { gte: startUTC, lte: endUTC } },
                include: {
                    employee: {
                        select: {
                            id: true,
                            firstName: true,
                            lastName: true,
                            branch: true,
                            department: true,          // legacy string
                            Department: { select: { name: true } },  // FK relation
                            Shift: { select: { name: true } },
                        }
                    }
                },
                orderBy: { checkInTime: 'desc' },
            });

            for (const att of atts) {
                const emp = att.employee;
                const empName = `${emp.firstName} ${emp.lastName}`.trim();
                const source = emp.branch || 'Unassigned';
                // Use FK relation name first, then legacy string, then fallback
                const deptName = emp.Department?.name || emp.department || 'No Department';
                const shiftName = emp.Shift?.name || 'MORNING';
                const ciStatus = deriveStatus(att.checkInTime);

                timekeepingEntries.push({
                    id: `att-${att.id}-in`,
                    type: 'timekeeping',
                    timestamp: att.checkInTime.toISOString(),
                    employeeName: empName,
                    employeeId: emp.id,
                    action: 'Check In',
                    details: `${deptName} — ${ciStatus === 'late' ? 'Late arrival' : 'On time'}`,
                    source,
                    status: ciStatus,
                });

                if (att.checkOutTime) {
                    timekeepingEntries.push({
                        id: `att-${att.id}-out`,
                        type: 'timekeeping',
                        timestamp: att.checkOutTime.toISOString(),
                        employeeName: empName,
                        employeeId: emp.id,
                        action: 'Check Out',
                        details: `${deptName} — ${shiftName} shift`,
                        source,
                        status: ciStatus,
                    });
                }
            }

            timekeepingEntries.sort((a, b) =>
                new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            );
        }

        if (type === 'all' || type === 'system') {
            const rawLogs = await prisma.attendanceLog.findMany({
                where: { timestamp: { gte: startUTC, lte: endUTC } },
                include: {
                    employee: {
                        select: {
                            id: true,
                            firstName: true,
                            lastName: true,
                            branch: true,
                            department: true,
                            Department: { select: { name: true } },
                        }
                    },
                    Device: { select: { name: true, location: true } }
                },
                orderBy: { timestamp: 'desc' },
            });

            for (const log of rawLogs) {
                const emp = log.employee;
                const device = log.Device;
                const deptName = emp.Department?.name || emp.department || 'No Department';
                // AttendanceLog.status: 0 = check-in scan, 1 = check-out scan
                const scanType = log.status === 0 ? 'Check-in scan' : log.status === 1 ? 'Check-out scan' : 'Biometric scan';
                const deviceLabel = device?.location || device?.name || 'Unknown Device';

                systemEntries.push({
                    id: `log-${log.id}`,
                    type: 'system',
                    timestamp: log.timestamp.toISOString(),
                    employeeName: `${emp.firstName} ${emp.lastName}`.trim(),
                    employeeId: emp.id,
                    action: 'Device Scan',
                    details: `${scanType} · ${deptName}`,
                    source: deviceLabel,
                });
            }
        }

        // ── 3. Merge, sort, paginate ───────────────────────────────────────
        const activeEntries = type === 'all'
            ? [...timekeepingEntries, ...systemEntries].sort(
                (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
            )
            : type === 'timekeeping' ? timekeepingEntries : systemEntries;

        const activeTotal = type === 'all'
            ? timekeepingCount + systemCount
            : type === 'timekeeping' ? timekeepingCount : systemCount;

        const paginated = activeEntries.slice((pageNum - 1) * limitNum, pageNum * limitNum);

        return res.json({
            success: true,
            data: paginated,
            meta: {
                total: activeTotal,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(activeTotal / limitNum),
                counts: {
                    timekeeping: timekeepingCount,   // always accurate
                    system: systemCount,          // always accurate
                },
            },
        });

    } catch (error: any) {
        console.error('[Logs] Error fetching logs:', error);
        return res.status(500).json({ success: false, message: 'Failed to fetch logs', error: error.message });
    }
};

import { prisma } from '../lib/prisma';

/**
 * Attendance Service - Strategy C (Grace Period Toggle)
 * 
 * This service processes raw AttendanceLog records into clean Attendance check-in/check-out pairs.
 * 
 * Logic:
 * - First scan of the day → Create new Attendance record with checkInTime
 * - Second scan of the day → Update same record with checkOutTime
 * - Midnight cleanup → Mark incomplete records from previous days
 */

/**
 * Convert a UTC timestamp to its Philippine calendar date, stored as UTC.
 * e.g. 7 AM PHT Feb 28 (= 11 PM UTC Feb 27) → PHT midnight Feb 28 (= 4 PM UTC Feb 27)
 * This ensures scans between 12 AM–8 AM PHT are grouped under the correct PHT date.
 */
const toPHTDate = (utcDate: Date): Date => {
    // Shift to PHT (+8 hours)
    const pht = new Date(utcDate.getTime() + 8 * 60 * 60 * 1000);
    // Zero out time to get PHT midnight (still represented as UTC internally)
    pht.setUTCHours(0, 0, 0, 0);
    // Shift back to UTC: PHT midnight = UTC - 8 hours
    return new Date(pht.getTime() - 8 * 60 * 60 * 1000);
};

/** Get "today" in Philippine Time, returned as UTC equivalent of PHT midnight */
const getTodayPHT = (): Date => toPHTDate(new Date());

interface ProcessResult {
    success: boolean;
    processed: number;
    created: number;
    updated: number;
}

interface AttendanceFilters {
    startDate?: Date;
    endDate?: Date;
    employeeId?: number;
    status?: string;
    branch?: string;           // filter by employee.branch (string)
    departmentId?: number;    // filter by employee.departmentId (FK)
    departmentName?: string;  // filter by employee.department (string, fallback)
}

/**
 * Process unprocessed attendance logs into Attendance records
 * This implements the toggle logic: check-in → check-out
 */
export const processAttendanceLogs = async (): Promise<ProcessResult> => {
    try {
        // Get all logs ordered by timestamp
        const logs = await prisma.attendanceLog.findMany({
            orderBy: { timestamp: 'asc' },
            include: { employee: true }
        });

        let created = 0;
        let updated = 0;

        for (const log of logs) {
            // Normalize to Philippine calendar date for consistent grouping
            const dateOnly = toPHTDate(log.timestamp);

            // Check if attendance record exists for this employee on this date
            const existingAttendance = await prisma.attendance.findUnique({
                where: {
                    employeeId_date: {
                        employeeId: log.employeeId,
                        date: dateOnly
                    }
                }
            });

            if (!existingAttendance) {
                // No record exists → This is a CHECK-IN
                // Determine if late: check-in after 08:00 AM PHT
                // AttendanceLog timestamps are stored as UTC where PHT midnight = UTC midnight
                // (because convertPHTtoUTC subtracts 8 hours from device-reported PHT time)
                // So PHT 08:00 AM = UTC 00:00 AM in our stored representation.
                const checkInPHT = new Date(log.timestamp.getTime() + 8 * 60 * 60 * 1000);
                const isLate = checkInPHT.getUTCHours() > 8 ||
                    (checkInPHT.getUTCHours() === 8 && checkInPHT.getUTCMinutes() > 0);

                await prisma.attendance.create({
                    data: {
                        employeeId: log.employeeId,
                        date: dateOnly,
                        checkInTime: log.timestamp,
                        status: isLate ? 'late' : 'present'
                    }
                });
                created++;
            } else {
                // Record exists. Check if this is a valid check-out or just a duplicate/early scan
                const checkInTime = new Date(existingAttendance.checkInTime);
                const logTime = new Date(log.timestamp);
                const diffMs = logTime.getTime() - checkInTime.getTime();
                const diffHours = diffMs / (1000 * 60 * 60); //for every 1000 milliseconds, it will be 1 second

                // RULE: User must be checked in for at least 2 hours before checking out
                if (diffHours < 2) {
                    // Too soon to check out - ignore this log
                    // This prevents accidental double-scans from closing the attendance
                    continue;
                }

                // If existing check-out exists, only update if this new log is LATER (user left later)
                if (existingAttendance.checkOutTime) {
                    if (log.timestamp > existingAttendance.checkOutTime) {
                        await prisma.attendance.update({
                            where: { id: existingAttendance.id },
                            data: {
                                checkOutTime: log.timestamp,
                                updatedAt: new Date()
                            }
                        });
                        updated++;
                    }
                } else {
                    // No check-out yet, and > 2 hours have passed -> Valid Check-Out
                    await prisma.attendance.update({
                        where: { id: existingAttendance.id },
                        data: {
                            checkOutTime: log.timestamp,
                            updatedAt: new Date()
                        }
                    });
                    updated++;
                }
            }
        }

        console.log(`[Attendance] Processed ${logs.length} logs: ${created} created, ${updated} updated`);

        return {
            success: true,
            processed: logs.length,
            created,
            updated
        };
    } catch (error: any) {
        console.error('[Attendance] Error processing logs:', error);
        return {
            success: false,
            processed: 0,
            created: 0,
            updated: 0
        };
    }
};

/**
 * Auto-close incomplete attendance records from previous days
 * Runs at midnight to mark forgotten check-outs
 */
export const autoCloseIncompleteAttendance = async (): Promise<number> => {
    try {
        const today = getTodayPHT();

        // Find all records before today with no check-out time
        const result = await prisma.attendance.updateMany({
            where: {
                date: { lt: today },
                checkOutTime: null
            },
            data: {
                status: 'incomplete',
                updatedAt: new Date()
            }
        });

        console.log(`[Attendance] Auto-closed ${result.count} incomplete records`);
        return result.count;
    } catch (error: any) {
        console.error('[Attendance] Error auto-closing records:', error);
        return 0;
    }
};

/**
 * Auto-checkout employees who haven't manually checked out
 * Runs at 11:59 PM and sets checkout time to 5:00 PM for flexibility
 * This allows employees to work overtime while preventing unrealistic work hours for forgotten checkouts
 */
export const autoCheckoutEmployees = async (): Promise<number> => {
    try {
        // Get today's date in PHT
        const today = getTodayPHT();

        // Create checkout time at 5:00 PM Philippine Time
        // PHT midnight + 17 hours = 5 PM PHT
        const autoCheckoutTime = new Date(today.getTime() + 17 * 60 * 60 * 1000);

        // Find all records for TODAY that still don't have a checkout time
        const result = await prisma.attendance.updateMany({
            where: {
                date: today,
                checkOutTime: null
            },
            data: {
                checkOutTime: autoCheckoutTime,
                notes: 'Auto checkout - No manual checkout detected by 11:59 PM',
                updatedAt: new Date()
            }
        });

        console.log(`[Attendance] Auto-checkout completed: ${result.count} employees checked out at 5:00 PM`);
        return result.count;
    } catch (error: any) {
        console.error('[Attendance] Error during auto-checkout:', error);
        return 0;
    }
};

/**
 * Startup Repair: Fix any missing checkouts from previous days
 * This ensures that if the server was off at 11:59 PM, the records are fixed on next startup
 */
export const repairMissingCheckouts = async (): Promise<number> => {
    try {
        const today = getTodayPHT();

        // Find all records from dates BEFORE today that have no checkout time
        const records = await prisma.attendance.findMany({
            where: {
                date: { lt: today },
                checkOutTime: null
            }
        });

        if (records.length === 0) return 0;

        let repairedCount = 0;
        for (const record of records) {
            // Set checkout time to 5:00 PM PHT for that specific date
            // record.date is PHT midnight in UTC, so +17 hours = 5 PM PHT
            const repairTime = new Date(record.date.getTime() + 17 * 60 * 60 * 1000);

            await prisma.attendance.update({
                where: { id: record.id },
                data: {
                    checkOutTime: repairTime,
                    status: 'present', // Assume present if they checked in but forgot to check out
                    notes: record.notes
                        ? `${record.notes} | Auto-checkout set to 5:00 PM (Forgotten checkout)`
                        : 'Auto-checkout set to 5:00 PM (Forgotten checkout)',
                    updatedAt: new Date()
                }
            });
            repairedCount++;
        }

        console.log(`[Attendance] Startup Repair: Fixed ${repairedCount} missing checkouts from previous days`);
        return repairedCount;
    } catch (error: any) {
        console.error('[Attendance] Error during startup repair:', error);
        return 0;
    }
};

/**
 * Get attendance records with filters
 */
export const getAttendanceRecords = async (filters: AttendanceFilters = {}, page: number = 1, limit: number = 10000) => {
    const where: any = {};

    if (filters.startDate || filters.endDate) {
        where.date = {};
        if (filters.startDate) where.date.gte = filters.startDate;
        if (filters.endDate) where.date.lte = filters.endDate;
    }

    if (filters.employeeId) {
        where.employeeId = filters.employeeId;
    }

    if (filters.status) {
        where.status = filters.status;
    }

    // Branch / department filters — applied via nested employee relation
    // Use OR for department: filter by FK (if set) OR string field (legacy)
    const empConditions: any = {}
    if (filters.branch) empConditions.branch = filters.branch

    if (filters.departmentId || filters.departmentName) {
        const deptOr: any[] = []
        if (filters.departmentId) deptOr.push({ departmentId: filters.departmentId })
        if (filters.departmentName) deptOr.push({ department: { equals: filters.departmentName, mode: 'insensitive' } })
        if (Object.keys(empConditions).length > 0 || deptOr.length > 0) {
            where.employee = deptOr.length === 1
                ? { ...empConditions, ...deptOr[0] }
                : { ...empConditions, OR: deptOr }
        }
    } else if (Object.keys(empConditions).length > 0) {
        where.employee = empConditions
    }

    // Calculate pagination
    const skip = (page - 1) * limit;

    const [total, records] = await Promise.all([
        prisma.attendance.count({ where }),
        prisma.attendance.findMany({
            where,
            include: {
                employee: {
                    include: {
                        Department: {
                            select: { name: true }
                        }
                    }
                }
            },
            orderBy: [{ date: 'desc' }, { checkInTime: 'desc' }],
            skip,
            take: limit
        })
    ]);

    // Add Philippine Time formatted strings for easier reading
    const data = records.map((record: any) => ({
        ...record,
        // employee relation is already included as 'employee'
        checkInTimePH: formatToPhilippineTime(record.checkInTime),
        checkOutTimePH: record.checkOutTime ? formatToPhilippineTime(record.checkOutTime) : null
    }));

    return { data, total };
};

/**
 * Helper: Convert UTC date to Philippine Time string
 */
const formatToPhilippineTime = (utcDate: Date): string => {
    // Just use toLocaleString with timeZone option. 
    // The input utcDate is already a valid Date object (UTC).
    return utcDate.toLocaleString('en-US', {
        timeZone: 'Asia/Manila',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });
};

/**
 * Get today's attendance
 */
export const getTodayAttendance = async () => {
    const today = getTodayPHT();

    const result = await getAttendanceRecords({
        startDate: today,
        endDate: today
    });
    return result.data;
};

/**
 * Get attendance history for a specific employee
 */
export const getEmployeeAttendanceHistory = async (
    employeeId: number,
    startDate?: Date,
    endDate?: Date
) => {
    const result = await getAttendanceRecords({
        employeeId,
        startDate,
        endDate
    });
    return result.data;
};

/**
 * Get today's raw attendance logs (individual scan events)
 * Returns each scan as a separate entry for a real-time activity feed
 */
export const getTodayLogs = async () => {
    const todayStart = getTodayPHT();
    // End of today in PHT: PHT midnight + 24 hours
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    const logs = await prisma.attendanceLog.findMany({
        where: {
            timestamp: {
                gte: todayStart,
                lt: todayEnd
            }
        },
        include: {
            employee: {
                include: {
                    Department: { select: { name: true } }
                }
            }
        },
        orderBy: { timestamp: 'desc' }
    });

    return logs.map((log: any) => ({
        id: log.id,
        employeeId: log.employeeId,
        timestamp: log.timestamp,
        timestampPH: formatToPhilippineTime(log.timestamp),
        employee: log.employee
    }));
};

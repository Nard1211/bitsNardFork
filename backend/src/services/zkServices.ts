import { prisma } from '../lib/prisma';
import { ZKDriver } from '../lib/zk-driver';
import { EnrollmentResult } from './fingerprintEnrollment.service';
import { processAttendanceLogs } from './attendance.service';

interface SyncResult {
    success: boolean;
    message?: string;
    error?: string;
    newLogs?: number;
    count?: number;
}

// UIDs on the device that must NEVER be overwritten by employee sync/add.
// UID 1 is the SUPER ADMIN on the ZKTeco device.
const PROTECTED_DEVICE_UIDS = [1];

/**
 * Convert Philippine Time to UTC
 * ZKTeco device returns timestamps in Philippine Time (UTC+8)
 * We need to subtract 8 hours to get UTC for proper storage
 */
const convertPHTtoUTC = (phtDate: Date): Date => {
    const utcTime = new Date(phtDate.getTime() - (8 * 60 * 60 * 1000));
    return utcTime;
};

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1: Increased timeout (10 s instead of 5 s)
// ─────────────────────────────────────────────────────────────────────────────
/** Create a ZKDriver for a specific device IP+port. Falls back to env vars if not provided. */
const getDriver = (ip?: string, port?: number): ZKDriver => {
    const resolvedIp = ip ?? process.env.ZK_HOST ?? '192.168.1.201';
    const resolvedPort = port ?? parseInt(process.env.ZK_PORT || '4370');
    const timeout = parseInt(process.env.ZK_TIMEOUT || '10000');
    return new ZKDriver(resolvedIp, resolvedPort, timeout);
};

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2: Device-busy lock
// The ZKTeco device only accepts ONE TCP connection at a time.
// This mutex ensures that concurrent API calls are queued instead of racing.
// ─────────────────────────────────────────────────────────────────────────────
let _deviceBusy = false;
const _deviceQueue: Array<() => void> = [];

function acquireDeviceLock(): Promise<void> {
    return new Promise((resolve) => {
        if (!_deviceBusy) {
            _deviceBusy = true;
            resolve();
        } else {
            console.log('[ZK] Device busy — queuing request...');
            _deviceQueue.push(() => {
                _deviceBusy = true;
                resolve();
            });
        }
    });
}

function releaseDeviceLock(): void {
    const next = _deviceQueue.shift();
    if (next) {
        // Small delay before handing off so the device can fully close the previous socket
        setTimeout(next, 500);
    } else {
        _deviceBusy = false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Non-blocking lock attempt — used by the cron job.
// Returns true if the lock was acquired, false if the device is already busy.
// Cron jobs should SKIP (not queue) when the device is busy; the next cron
// tick 10 seconds later will try again. This prevents an ever-growing queue
// of pending syncs from stacking up while enrollment or another operation
// is holding the lock.
// ─────────────────────────────────────────────────────────────────────────────
function tryAcquireDeviceLock(): boolean {
    if (!_deviceBusy) {
        _deviceBusy = true;
        return true;
    }
    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// ZKError unwrapper — node-zklib throws { err: Error, ip, command } objects
// which don't have a .message property, so we extract it manually.
// ─────────────────────────────────────────────────────────────────────────────
function zkErrMsg(err: any): string {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    // ZKError shape: { err: Error, ip, command }
    if (err.err instanceof Error) return `${err.command || 'ZK'}: ${err.err.message}`;
    if (err.message) return err.message;
    return JSON.stringify(err);
}

async function connectWithRetry(zk: ZKDriver, maxRetries: number = 2): Promise<void> {
    let lastError: any;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
            await zk.connect();
            if (attempt > 1) console.log(`[ZK] Connected on attempt ${attempt}.`);
            return;
        } catch (err: any) {
            lastError = err;
            console.warn(`[ZK] Connection attempt ${attempt} failed: ${zkErrMsg(err)}`);
            if (attempt <= maxRetries) {
                console.log(`[ZK] Retrying in 2.5 s...`);
                await new Promise(r => setTimeout(r, 2500));
            }
        }
    }
    throw lastError;
}

export const syncZkData = async (): Promise<SyncResult> => {
    // ── Cron-safe lock: SKIP if device is already busy ──────────────────────
    // The cron fires every 10 seconds. If a previous sync, enrollment, or
    // any other device operation is still running, we skip this tick instead
    // of queuing — the next cron tick will try again. This prevents an
    // ever-growing backlog of pending syncs from piling up.
    // ────────────────────────────────────────────────────────────────────────
    if (!tryAcquireDeviceLock()) {
        console.debug('[ZK] Cron sync skipped — device is busy with another operation.');
        return { success: true, message: 'Skipped — device busy' };
    }

    let totalNewLogs = 0;

    try {
        // Load ALL devices from the DB — this way IP changes via Configure take effect immediately
        const dbDevices = await prisma.device.findMany({ orderBy: { id: 'asc' } });

        if (dbDevices.length === 0) {
            console.warn('[ZK] No devices found in DB — skipping sync.');
            return { success: true, message: 'No devices configured', newLogs: 0 };
        }

        for (const dbDevice of dbDevices) {
            const zk = getDriver(dbDevice.ip, dbDevice.port);
            console.log(`[ZK] Syncing device "${dbDevice.name}" at ${dbDevice.ip}:${dbDevice.port}...`);

            try {
                await connectWithRetry(zk);

                const info = await zk.getInfo();
                console.log(`[ZK] Connected! Serial: ${info.serialNumber}`);

                // Mark ONLINE using device.id (not the env-var IP) so Configure changes apply immediately
                await prisma.device.update({
                    where: { id: dbDevice.id },
                    data: { isActive: true, updatedAt: new Date() }
                }).catch(() => { /* ignore */ });

                const logs = await zk.getLogs();

                // Sort: Oldest -> Newest
                logs.sort((a, b) => a.recordTime.getTime() - b.recordTime.getTime());

                let newCount = 0;
                for (const log of logs) {
                    try {
                        const zkUserId = parseInt(log.deviceUserId);

                        if (isNaN(zkUserId)) continue;

                        // 1. Find Employee by zkId — SKIP if not in DB (prevents ghost re-creation)
                        const employee = await prisma.employee.findUnique({
                            where: { zkId: zkUserId }
                        });

                        if (!employee) {
                            // This zkId was removed from the DB intentionally. Do not re-create.
                            console.log(`[ZK] Skipping unknown zkId ${zkUserId} — not in database`);
                            continue;
                        }

                        // 2. Fetch Last Log to prevent duplicates
                        const lastLog = await prisma.attendanceLog.findFirst({
                            where: { employeeId: employee.id },
                            orderBy: { timestamp: 'desc' }
                        });

                        // Convert PHT to UTC for storage and comparison
                        const utcTime = convertPHTtoUTC(log.recordTime);

                        // Logic: Prevent duplicates within 1 minute (accidental double-scans)
                        if (lastLog) {
                            const diffMs = utcTime.getTime() - lastLog.timestamp.getTime();
                            const diffMinutes = diffMs / (1000 * 60);

                            // Only skip if it's within 1 minute (likely accidental double-scan)
                            if (diffMinutes < 1) continue;
                        }

                        // 3. Check for exact duplicate in DB
                        const exists = await prisma.attendanceLog.findUnique({
                            where: {
                                timestamp_employeeId: {
                                    timestamp: utcTime,
                                    employeeId: employee.id
                                }
                            }
                        });

                        if (!exists) {
                            await prisma.attendanceLog.create({
                                data: {
                                    timestamp: utcTime,  // Store UTC time
                                    employeeId: employee.id,
                                    status: log.status,
                                },
                            });
                            newCount++;
                        }
                    } catch (logErr) {
                        console.error(`[ZK] Error processing log:`, logErr);
                    }
                }

                console.log(`[ZK] Device "${dbDevice.name}" sync complete. ${newCount} new logs.`);
                totalNewLogs += newCount;

            } catch (deviceErr: any) {
                console.error(`[ZK] Error syncing "${dbDevice.name}" (${dbDevice.ip}): ${zkErrMsg(deviceErr)}`);
                // Mark this specific device as OFFLINE
                await prisma.device.update({
                    where: { id: dbDevice.id },
                    data: { isActive: false, updatedAt: new Date() }
                }).catch(() => { /* ignore */ });
            } finally {
                try { await zk.disconnect(); } catch { /* ignore */ }
            }
        }

        // Always process logs into Attendance records (handles both new and existing logs)
        console.log(`[ZK] Processing ${totalNewLogs} new logs into attendance records...`);
        await processAttendanceLogs();

        return { success: true, newLogs: totalNewLogs };

    } catch (error: any) {
        console.error('[ZK] Sync fatal error:', zkErrMsg(error));
        return { success: false, error: `Sync Error: ${zkErrMsg(error)}`, message: 'Failed to sync attendance data' };
    } finally {
        releaseDeviceLock();
    }
};

export const addUserToDevice = async (zkId: number, name: string, role: string = 'USER', badgeNumber: string = ""): Promise<SyncResult> => {
    await acquireDeviceLock();

    try {
        console.log(`[ZK] Adding User with zkId=${zkId} (${name})...`);

        // ── Always read device IPs from the DB — never from env vars ────────
        // getDriver() with no args falls back to ZK_HOST env var which may be
        // stale. We must use the same DB-first approach as syncZkData.
        const dbDevices = await prisma.device.findMany({
            where: { isActive: true },
            orderBy: { id: 'asc' },
        });

        if (dbDevices.length === 0) {
            console.warn('[ZK] No active devices in DB — cannot add user.');
            return { success: false, message: 'No active devices configured.' };
        }

        let lastError: any;
        let addedToAtLeastOne = false;

        for (const dbDevice of dbDevices) {
            const zk = getDriver(dbDevice.ip, dbDevice.port);
            try {
                console.log(`[ZK] Connecting to "${dbDevice.name}" (${dbDevice.ip}:${dbDevice.port})...`);
                await connectWithRetry(zk, 2);

                const deviceRole = role === 'ADMIN' ? 14 : 0;
                const visibleId = zkId.toString();

                const existingUsers = await zk.getUsers();

                const existingUser = existingUsers.find(
                    (u: any) => u.userId === visibleId || u.userId === zkId.toString()
                );

                let deviceUid: number;

                if (existingUser) {
                    if (PROTECTED_DEVICE_UIDS.includes(existingUser.uid)) {
                        deviceUid = await zk.getNextUid();
                        while (PROTECTED_DEVICE_UIDS.includes(deviceUid)) deviceUid++;
                    } else {
                        deviceUid = existingUser.uid;
                        console.log(`[ZK] User already exists on "${dbDevice.name}" (UID: ${deviceUid}). Updating...`);
                    }
                } else {
                    deviceUid = await zk.getNextUid();
                    while (PROTECTED_DEVICE_UIDS.includes(deviceUid)) deviceUid++;
                    console.log(`[ZK] New user on "${dbDevice.name}". Assigning device UID: ${deviceUid}`);
                }

                await zk.clearUserFingerprints(deviceUid);
                await zk.setUser(deviceUid, name, "", deviceRole, 0, visibleId);

                console.log(`[ZK] ${existingUser && !PROTECTED_DEVICE_UIDS.includes(existingUser.uid) ? 'Updated' : 'Added'} user "${name}" on "${dbDevice.name}" (UID: ${deviceUid}).`);
                addedToAtLeastOne = true;
            } catch (err: any) {
                lastError = err;
                console.error(`[ZK] Failed to add user to "${dbDevice.name}": ${zkErrMsg(err)}`);
            } finally {
                try { await zk.disconnect(); } catch { /* ignore */ }
            }
        }

        if (!addedToAtLeastOne) {
            throw lastError ?? new Error('All devices failed');
        }

        return { success: true, message: `User ${name} synced to device(s).` };
    } catch (error: any) {
        console.error('[ZK] Add User Error:', zkErrMsg(error));
        throw new Error(`Failed to add employee: ${zkErrMsg(error)}`);
    } finally {
        releaseDeviceLock();
    }
};



export const deleteUserFromDevice = async (zkId: number): Promise<SyncResult> => {
    await acquireDeviceLock();
    try {
        console.log(`[ZK] Deleting User with zkId=${zkId} from all devices...`);

        const dbDevices = await prisma.device.findMany({
            where: { isActive: true },
            orderBy: { id: 'asc' },
        });

        if (dbDevices.length === 0) {
            return { success: true, message: 'No active devices — nothing to delete from.' };
        }

        for (const dbDevice of dbDevices) {
            const zk = getDriver(dbDevice.ip, dbDevice.port);
            try {
                await connectWithRetry(zk, 2);

                const deviceUsers = await zk.getUsers();
                const targetUser = deviceUsers.find((u: any) => u.userId === zkId.toString());

                if (!targetUser) {
                    console.log(`[ZK] User zkId=${zkId} not found on "${dbDevice.name}". Skipping.`);
                    continue;
                }

                console.log(`[ZK] Clearing fingerprints + deleting UID=${targetUser.uid} on "${dbDevice.name}"...`);
                await zk.clearUserFingerprints(targetUser.uid);
                await zk.deleteUser(targetUser.uid);
                console.log(`[ZK] Deleted zkId=${zkId} from "${dbDevice.name}".`);
            } catch (err: any) {
                console.error(`[ZK] Failed to delete from "${dbDevice.name}": ${zkErrMsg(err)}`);
            } finally {
                try { await zk.disconnect(); } catch { /* ignore */ }
            }
        }

        return { success: true, message: `User ${zkId} removed from device(s).` };
    } catch (error: any) {
        console.error('[ZK] Delete User Error:', zkErrMsg(error));
        return { success: false, message: `Failed to delete user: ${zkErrMsg(error)}`, error: zkErrMsg(error) };
    } finally {
        releaseDeviceLock();
    }
};

export const syncEmployeesToDevice = async (): Promise<SyncResult> => {
    const zk = getDriver();
    await acquireDeviceLock();

    try {
        console.log(`[ZK] Fetching DB employees...`);
        const employees = await prisma.employee.findMany({
            where: {
                zkId: { not: null, gt: 1 }, // Skip Admin (zkId = 1)
                employmentStatus: 'ACTIVE',
            },
            select: {
                zkId: true,
                firstName: true,
                lastName: true,
                employeeNumber: true,
                role: true,
            }
        });

        if (employees.length === 0) {
            return { success: true, message: "No employees to sync.", count: 0 };
        }

        console.log(`[ZK] Connecting...`);
        await connectWithRetry(zk);

        // 1. Fetch current device users — map by visible userId string for safe lookup
        console.log(`[ZK] Fetching existing device users...`);
        const deviceUsers = await zk.getUsers();
        const deviceUserByVisibleId = new Map<string, any>();
        deviceUsers.forEach(u => deviceUserByVisibleId.set(u.userId, u));
        console.log(`[ZK] Found ${deviceUsers.length} existing users on device.`);

        // Track the next available UID for new users — skip protected UIDs
        const existingUids = deviceUsers.map((u: any) => u.uid);
        let nextUid = existingUids.length > 0 ? Math.max(...existingUids) + 1 : 1;
        while (PROTECTED_DEVICE_UIDS.includes(nextUid)) nextUid++;

        let successCount = 0;
        let failedCount = 0;
        const errors: string[] = [];

        for (const employee of employees) {
            const fullName = `${employee.firstName} ${employee.lastName}`;
            try {
                const role = employee.role === 'ADMIN' ? 14 : 0; // 14 = Admin, 0 = User
                const zkId = employee.zkId!;
                const displayName = fullName;

                // IMPORTANT: Always use zkId as the visible device User ID.
                // employeeNumber is a company HR field — NOT a biometric device identifier.
                const userIdString = zkId.toString();

                // Look up by visible userId string — NOT by internal UID
                const existingUser = deviceUserByVisibleId.get(userIdString) || deviceUserByVisibleId.get(zkId.toString());

                // Preserve existing password/cardno if user already on device
                const password = existingUser ? existingUser.password : "";
                const cardno = existingUser ? existingUser.cardno : 0;

                // Use existing UID if found, otherwise assign next available UID
                // CRITICAL: Never overwrite a protected UID
                let deviceUid: number;
                if (existingUser) {
                    if (PROTECTED_DEVICE_UIDS.includes(existingUser.uid)) {
                        console.warn(`[ZK]   ⚠ SKIPPING ${displayName} — matched protected UID ${existingUser.uid} ("${existingUser.name}"). Assigning new UID.`);
                        deviceUid = nextUid++;
                        while (PROTECTED_DEVICE_UIDS.includes(deviceUid)) deviceUid = nextUid++;
                    } else {
                        deviceUid = existingUser.uid;
                    }
                } else {
                    deviceUid = nextUid++;
                    while (PROTECTED_DEVICE_UIDS.includes(deviceUid)) deviceUid = nextUid++;
                }

                await zk.setUser(deviceUid, displayName, password, role, cardno, userIdString);

                if (existingUser) {
                    console.log(`[ZK]   ✓ Updated: ${displayName} (UID: ${deviceUid}, ID: ${userIdString}, Role: ${role}, Card: ${cardno})`);
                } else {
                    console.log(`[ZK]   ✓ Added: ${displayName} (UID: ${deviceUid}, ID: ${userIdString}, Role: ${role})`);
                }

                successCount++;
            } catch (error: any) {
                failedCount++;
                errors.push(`Failed ${fullName}: ${error.message}`);
                console.error(`[ZK]   ✗ Failed ${fullName}: ${error.message}`);
            }
        }

        return {
            success: successCount > 0,
            message: `Synced ${successCount}/${employees.length} employees.`,
            count: successCount,
        };

    } catch (error: any) {
        throw new Error(`Sync failed: ${error.message}`);
    } finally {
        try { await zk.disconnect(); } catch { /* ignore disconnect errors */ }
        releaseDeviceLock();
    }
};

// Finger index → human readable name (matches ZKTeco standard)
const FINGER_MAP: { [key: number]: string } = {
    0: 'Left Little Finger', 1: 'Left Ring Finger',
    2: 'Left Middle Finger', 3: 'Left Index Finger',
    4: 'Left Thumb', 5: 'Right Thumb',
    6: 'Right Index Finger', 7: 'Right Middle Finger',
    8: 'Right Ring Finger', 9: 'Right Little Finger',
};

/**
 * Enroll fingerprint for an employee.
 *
 * Uses a SINGLE lock-protected connection to:
 *   1. Verify/add the user on the device (inline, no second connect)
 *   2. Send CMD_STARTENROLL with the correct visible userId string
 *
 * This fixes three previous bugs:
 *   a) Two separate connections racing each other
 *   b) Wrong user ID (internal UID) sent in CMD_STARTENROLL packet
 *   c) Enrollment service connecting outside the device-busy lock
 */
export const enrollEmployeeFingerprint = async (
    employeeId: number,
    fingerIndex: number = 0
): Promise<SyncResult> => {
    console.log(`[Enrollment] Starting for employee ${employeeId}, finger ${fingerIndex}...`);

    // 1. DB lookup — do this BEFORE acquiring the device lock
    const employee = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: {
            id: true,
            zkId: true,
            firstName: true,
            lastName: true,
            employmentStatus: true,
        }
    });

    if (!employee) return { success: false, message: 'Employee not found', error: 'not_found' };
    if (!employee.zkId) return { success: false, message: 'No zkId assigned', error: 'no_zkid' };
    if (employee.employmentStatus !== 'ACTIVE') return { success: false, message: 'Inactive employee', error: 'inactive' };
    if (fingerIndex < 0 || fingerIndex > 9) return { success: false, message: 'Finger index must be 0–9', error: 'bad_finger' };

    const fullName = `${employee.firstName} ${employee.lastName}`;
    const visibleId = String(employee.zkId); // This is what CMD_STARTENROLL expects
    const fingerName = FINGER_MAP[fingerIndex] || `Finger ${fingerIndex}`;

    // 2. Fetch device IP from DB — never trust env var (may be stale after Configure)
    const dbDevice = await prisma.device.findFirst({
        where: { isActive: true },
        orderBy: { id: 'asc' },
    });

    if (!dbDevice) {
        return { success: false, message: 'No active devices configured in DB', error: 'no_device' };
    }

    // 3. Acquire device lock — only ONE connection to the device at a time
    const zk = getDriver(dbDevice.ip, dbDevice.port);
    await acquireDeviceLock();

    try {
        console.log(`[Enrollment] Connecting to "${dbDevice.name}" (${dbDevice.ip}:${dbDevice.port})...`);
        await connectWithRetry(zk);

        // 4. Ensure user exists on device (add if missing) — all within the same connection
        const deviceUsers = await zk.getUsers();
        const existingUser = deviceUsers.find(
            (u: any) => u.userId === visibleId || u.name === fullName
        );

        if (!existingUser) {
            console.log(`[Enrollment] User not found on device — adding now (visibleId="${visibleId}")...`);
            let deviceUid = await zk.getNextUid();
            while (PROTECTED_DEVICE_UIDS.includes(deviceUid)) deviceUid++;
            await zk.setUser(deviceUid, fullName, '', 0, 0, visibleId);
            await zk.refreshData(); // commit new user to device memory
            console.log(`[Enrollment] User added to device (UID: ${deviceUid}).`);
        } else if (PROTECTED_DEVICE_UIDS.includes(existingUser.uid)) {
            // Matched a protected slot — re-add under a safe UID
            console.warn(`[Enrollment] ⚠ Matched protected UID ${existingUser.uid} — re-adding under new UID.`);
            let deviceUid = await zk.getNextUid();
            while (PROTECTED_DEVICE_UIDS.includes(deviceUid)) deviceUid++;
            await zk.setUser(deviceUid, fullName, '', 0, 0, visibleId);
            await zk.refreshData(); // commit to device memory
            console.log(`[Enrollment] User re-added (UID: ${deviceUid}).`);
        } else {
            console.log(`[Enrollment] User already on device (UID: ${existingUser.uid}, visibleId="${existingUser.userId}"). Proceeding to enroll.`);
        }

        // 5. Send CMD_STARTENROLL — visibleId (zkId string) is the correct payload
        console.log(`[Enrollment] Sending CMD_STARTENROLL: visibleId="${visibleId}", finger="${fingerName}"...`);
        await zk.startEnrollment(visibleId, fingerIndex);

        console.log(`[Enrollment] ✓ Enrollment command sent. Employee should now place their ${fingerName} on the device.`);
        return {
            success: true,
            message: `Enrollment started for ${fullName}. Please place their ${fingerName} on the scanner 3 times.`
        };

    } catch (error: any) {
        console.error(`[Enrollment] Error:`, zkErrMsg(error));
        return {
            success: false,
            message: zkErrMsg(error) || 'Enrollment failed',
            error: 'enrollment_error'
        };
    } finally {
        try { await zk.disconnect(); } catch { /* ignore disconnect errors */ }
        releaseDeviceLock();
    }
};


export const testDeviceConnection = async (): Promise<SyncResult> => {
    const zk = getDriver();
    await acquireDeviceLock();
    try {
        await connectWithRetry(zk);
        const info = await zk.getInfo();
        const time = await zk.getTime();
        return { success: true, message: `Connected! Serial: ${info.serialNumber}, Time: ${JSON.stringify(time)}` };
    } catch (error: any) {
        return { success: false, error: error.message };
    } finally {
        try { await zk.disconnect(); } catch { /* ignore disconnect errors */ }
        releaseDeviceLock();
    }
};

export const syncEmployeesFromDevice = async (): Promise<SyncResult> => {
    const zk = getDriver();
    await acquireDeviceLock();
    try {
        await connectWithRetry(zk);
        const users = await zk.getUsers();

        console.log(`[ZK] Found ${users.length} users on device.`);
        let newCount = 0;
        let updateCount = 0;

        for (const user of users) {
            let zkId = parseInt(user.userId);
            if (isNaN(zkId)) continue;

            // SPECIAL CASE: Map Device Admin (2948876) to Database Admin (1)
            if (zkId === 2948876) {
                zkId = 1;
            }

            const existing = await prisma.employee.findUnique({ where: { zkId } });

            if (existing) {
                // Update names if they exist on device
                const nameParts = user.name.split(' ');
                const firstName = nameParts[0] || existing.firstName;
                const lastName = nameParts.slice(1).join(' ') || existing.lastName;

                // Only update if names are different/better (simple check)
                if (user.name && (existing.firstName !== firstName || existing.lastName !== lastName)) {
                    await prisma.employee.update({
                        where: { id: existing.id },
                        data: {
                            firstName,
                            lastName
                        }
                    });
                    console.log(`[ZK] Updated Name for ID ${zkId}: ${user.name}`);
                }
                updateCount++;
            } else {
                // Unknown device user — do NOT auto-create in DB.
                // If this user was deleted from DB intentionally, they should stay deleted.
                console.log(`[ZK] Skipping unknown device user zkId=${zkId} ("${user.name}") — not in database. Delete from device if unwanted.`);
            }
        }

        return { success: true, message: `Scanned ${users.length}. Created ${newCount}, Found ${updateCount}.`, count: newCount };

    } catch (error: any) {
        return { success: false, error: error.message };
    } finally {
        try { await zk.disconnect(); } catch { /* ignore disconnect errors */ }
        releaseDeviceLock();
    }
};
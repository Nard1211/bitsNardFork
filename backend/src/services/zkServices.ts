import { prisma } from '../lib/prisma';
import { ZKDriver } from '../lib/zk-driver';
import { processAttendanceLogs } from './attendance.service';
import deviceEmitter from '../lib/deviceEmitter';
import { audit } from '../lib/auditLogger';

interface SyncResult {
    success: boolean;
    message?: string;
    error?: string;
    newLogs?: number;
    count?: number;
}

export interface SyncZkDataResult {
    success: boolean;
    status: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'NO_DEVICES';
    message: string;
    totalDevices: number;
    successfulDevices: number;
    failedDevices: Array<{ id: number; name: string; error: string }>;
    newLogs: number;
}

// UIDs on the device that must NEVER be overwritten by employee sync/add.
// UID 1 is the SUPER ADMIN on the ZKTeco device.
const PROTECTED_DEVICE_UIDS = [1];

// ─────────────────────────────────────────────────────────────────────────────
// The minimum zkId assignable to a regular employee.
// zkId 1 is always reserved for the device SUPER ADMIN.
// ─────────────────────────────────────────────────────────────────────────────
const MIN_EMPLOYEE_ZK_ID = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Registration mutex — prevents concurrent findNextSafeZkId() calls from
// racing to assign the same zkId to two different employees.
//
// WHY this is needed: findNextSafeZkId() is an async function that takes
// time (it connects to every active device). If two POST /api/employees
// requests arrive simultaneously, both calls read the same "current max zkId"
// before either has written its new employee to the DB. Both return the same
// next safe ID. The second prisma.employee.create() then fails with a P2002
// unique constraint violation.
//
// This mutex ensures the read-then-write sequence (findNextSafeZkId → create)
// is atomic from the perspective of concurrent registrations.
// ─────────────────────────────────────────────────────────────────────────────
let _registrationMutexBusy = false;
const _registrationMutexQueue: Array<() => void> = [];

/**
 * Acquires the registration mutex.
 * Returns a release function that MUST be called in a finally block.
 * Queues the caller if the mutex is already held — callers are served
 * in FIFO order so no request starves.
 */
export async function acquireRegistrationMutex(): Promise<() => void> {
    return new Promise((resolve) => {
        const release = () => {
            // Hand off to the next queued caller, if any.
            const next = _registrationMutexQueue.shift();
            if (next) {
                setTimeout(next, 50);
            } else {
                _registrationMutexBusy = false;
            }
        };

        if (!_registrationMutexBusy) {
            _registrationMutexBusy = true;
            resolve(release);
        } else {
            // FIFO: push to end of queue so registrations are processed
            // in the order they arrived
            _registrationMutexQueue.push(() => {
                _registrationMutexBusy = true;
                resolve(release);
            });
        }
    });
}

/**
 * Finds the lowest safe zkId to assign to a new employee.
 *
 * Queries BOTH the database (to avoid duplicate `Employee.zkId` values) AND
 * every active biometric device (to avoid colliding with ghost users whose
 * device UIDs are not present in the DB). Walks integers starting from
 * `MIN_EMPLOYEE_ZK_ID` (2) and returns the first value not in either set.
 *
 * If a device is offline, its UIDs cannot be verified. A warning is logged and
 * the function falls back to the DB-only check for that device — the caller's
 * downstream write guards (`addUserToDevice` visibleId conflict check) provide
 * a second layer of protection in that scenario.
 *
 * This function does NOT acquire the device lock because it is called before
 * the employee record exists, making it a read-only pre-flight check. Each
 * device connection is opened and closed within its own try/finally block.
 *
 * @returns The next safe integer zkId >= MIN_EMPLOYEE_ZK_ID
 */
export const findNextSafeZkId = async (): Promise<number> => {
    // 1. Collect all zkId values already used in the DB.
    const dbEmployees = await prisma.employee.findMany({
        where: { zkId: { not: null } },
        select: { zkId: true },
    });

    const usedIds = new Set<number>([
        ...dbEmployees.map(e => e.zkId!),
        ...PROTECTED_DEVICE_UIDS,
    ]);

    // 2. Collect all UIDs currently occupied on every active device.
    //    Each device is connected and disconnected independently so one offline
    //    device does not block the rest.
    const activeDevices = await prisma.device.findMany({
        where: { isActive: true },
        orderBy: { id: 'asc' },
    });

    for (const dbDevice of activeDevices) {
        const zk = getDriver(dbDevice.ip, dbDevice.port);
        try {
            await connectWithRetry(zk, 1); // 1 retry — this is a non-critical pre-flight
            const deviceUsers = await zk.getUsers();
            // node-zklib does not export its user type, so 'any' is required here
            deviceUsers.forEach((u: any) => {
                if (typeof u.uid === 'number') usedIds.add(u.uid);
            });
            console.log(`[ZK] findNextSafeZkId — scanned ${deviceUsers.length} UIDs from "${dbDevice.name}".`);
        } catch (err: any) {
            // Device is offline — log a warning but continue. The DB check still
            // prevents duplicates; the addUserToDevice write guards provide the
            // second layer of protection if the device comes back online.
            console.warn(`[ZK] findNextSafeZkId — could not reach "${dbDevice.name}" (${zkErrMsg(err)}). Device UIDs not verified for this device.`);
        } finally {
            try { await zk.disconnect(); } catch { /* ignore disconnect errors */ }
        }
    }

    // 3. Find the first integer >= MIN_EMPLOYEE_ZK_ID that is not in the used set.
    let candidate = MIN_EMPLOYEE_ZK_ID;
    while (usedIds.has(candidate)) {
        candidate++;
    }

    console.log(`[ZK] findNextSafeZkId — assigned zkId=${candidate} (checked ${usedIds.size} used IDs across DB + devices).`);
    return candidate;
};

/**
 * Convert Philippine Time to UTC reliably
 * ZKTeco device returns timestamps in Philippine Time (UTC+8)
 * node-zklib creates a completely local Date object. This guarantees we use
 * the raw PHT hour components to compute true UTC without subtracting 8 hours twice.
 */
const convertPHTtoUTC = (deviceDate: Date): Date => {
    // Extract what the device screen actually printed (which was mapped blindly to local OS components)
    const year = deviceDate.getFullYear();
    const month = deviceDate.getMonth();
    const date = deviceDate.getDate();
    const hours = deviceDate.getHours();
    const minutes = deviceDate.getMinutes();
    const seconds = deviceDate.getSeconds();

    // Map those raw screen components to a UTC string format, then subtract exactly 8 hours.
    const rawUTC = new Date(Date.UTC(year, month, date, hours, minutes, seconds));
    return new Date(rawUTC.getTime() - (8 * 60 * 60 * 1000));
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
// Per-device lock system
// Each ZKTeco device only accepts ONE TCP connection at a time.
// This Map-based mutex ensures that concurrent API calls to the SAME device
// are queued, while operations targeting DIFFERENT devices run in parallel.
// ─────────────────────────────────────────────────────────────────────────────

interface DeviceLockState {
    busy: boolean;
    interactivePending: boolean;
    queue: Array<() => void>;
    timeoutHandle: ReturnType<typeof setTimeout> | null;
}

// Key = device database ID (number). Created on first use.
const _deviceLocks = new Map<number, DeviceLockState>();

function getDeviceLockState(deviceId: number): DeviceLockState {
    if (!_deviceLocks.has(deviceId)) {
        _deviceLocks.set(deviceId, {
            busy: false,
            interactivePending: false,
            queue: [],
            timeoutHandle: null,
        });
    }
    return _deviceLocks.get(deviceId)!;
}

// Safety timeout: if the lock is held for more than 90 seconds,
// auto-release it. This prevents permanent deadlock if a request
// crashes before reaching its finally{} block.
const LOCK_TIMEOUT_MS = 90_000;

/**
 * Blocking lock for interactive UI operations (enrollment, addUser).
 * Jumps to the FRONT of the queue so it is not delayed by already-queued cron syncs.
 * Sets interactivePending so subsequent cron ticks skip while this is pending/held.
 */
function acquireInteractiveDeviceLock(deviceId: number): Promise<void> {
    const state = getDeviceLockState(deviceId);
    state.interactivePending = true;
    return new Promise((resolve) => {
        if (!state.busy) {
            state.busy = true;
            console.log(`[ZK] Interactive lock acquired for device ${deviceId}.`);
            resolve();
        } else {
            console.log(`[ZK] Device ${deviceId} busy — interactive request jumping to front of queue...`);
            // Unshift = front of queue, so this resolves before any already-queued cron syncs
            state.queue.unshift(() => {
                state.busy = true;
                resolve();
            });
        }
    });
}

/**
 * Blocking lock for background operations (syncEmployeesToDevice, deleteUserFromDevice, etc.).
 * Queues at the BACK — waits its turn behind any interactive operations.
 */
function acquireDeviceLock(deviceId: number): Promise<void> {
    const state = getDeviceLockState(deviceId);
    return new Promise((resolve) => {
        if (!state.busy) {
            state.busy = true;
            state.timeoutHandle = setTimeout(() => {
                console.warn(`[ZK] ⚠ Lock auto-released after timeout (90s) for device ${deviceId}.`);
                releaseDeviceLock(deviceId);
            }, LOCK_TIMEOUT_MS);
            resolve();
        } else {
            console.log(`[ZK] Device ${deviceId} busy — queuing background request...`);
            state.queue.push(() => {
                state.busy = true;
                state.timeoutHandle = setTimeout(() => {
                    console.warn(`[ZK] ⚠ Lock auto-released after timeout (90s) for device ${deviceId}.`);
                    releaseDeviceLock(deviceId);
                }, LOCK_TIMEOUT_MS);
                resolve();
            });
        }
    });
}

/**
 * Release the device lock and hand off to the next queued operation.
 * Always call this in a finally block.
 */
function releaseDeviceLock(deviceId: number): void {
    const state = getDeviceLockState(deviceId);
    if (state.timeoutHandle) {
        clearTimeout(state.timeoutHandle);
        state.timeoutHandle = null;
    }
    const next = state.queue.shift();
    if (next) {
        // Small delay so the device can fully close the previous TCP socket
        setTimeout(next, 500);
    } else {
        state.busy = false;
        // Only clear the interactive flag when the queue is fully drained —
        // if another interactive op is queued, it will set the flag again when it resolves.
        state.interactivePending = false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Non-blocking lock attempt — used by the cron job.
// Returns true if the lock was acquired, false if the device is already busy.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Non-blocking lock attempt for the cron job.
 * Returns false (skip this tick) if:
 *   - The device is already busy with any operation, OR
 *   - An interactive operation is pending in the queue
 * This ensures cron ticks never block or delay UI-triggered operations.
 */
function tryAcquireDeviceLock(deviceId: number): boolean {
    const state = getDeviceLockState(deviceId);
    // Skip if device is busy OR if an interactive operation is pending/active.
    // interactivePending ensures a queued enrollment/addUser is never
    // pushed back by a cron tick that sneaks in before it resolves.
    if (state.busy || state.interactivePending) {
        return false;
    }
    state.busy = true;
    // Apply the same safety timeout as interactive and background locks so a
    // crashed cron tick never leaves the device permanently locked.
    state.timeoutHandle = setTimeout(() => {
        console.warn(`[ZK] ⚠ Cron lock auto-released after timeout (90s) for device ${deviceId}.`);
        releaseDeviceLock(deviceId);
    }, LOCK_TIMEOUT_MS);
    return true;
}

// Force-release the lock from an external endpoint (e.g. POST /api/devices/unlock)
// If deviceId is provided, releases only that device. Otherwise releases ALL devices (emergency).
export function forceReleaseLock(deviceId?: number): void {
    if (deviceId !== undefined) {
        console.warn(`[ZK] Force-releasing device lock for device ${deviceId} via API.`);
        const state = getDeviceLockState(deviceId);
        state.queue.length = 0;
        if (state.timeoutHandle) { clearTimeout(state.timeoutHandle); state.timeoutHandle = null; }
        state.busy = false;
        state.interactivePending = false;
    } else {
        // No specific device — release all (emergency fallback)
        console.warn(`[ZK] Force-releasing ALL device locks via API.`);
        _deviceLocks.forEach((state, id) => {
            state.queue.length = 0;
            if (state.timeoutHandle) { clearTimeout(state.timeoutHandle); state.timeoutHandle = null; }
            state.busy = false;
            state.interactivePending = false;
        });
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// Private helper: fire a background reconcile when a device reconnects.
// Uses a DB-stored cooldown (lastReconciledAt) to prevent rapid flapping from
// queuing multiple concurrent reconcile operations on the same device.
// ─────────────────────────────────────────────────────────────────────────────
const AUTO_RECONCILE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between auto-reconciles

async function triggerAutoReconcile(deviceId: number, deviceName: string): Promise<void> {
    try {
        // Read the current lastReconciledAt from DB to enforce the cooldown.
        // We cannot rely on an in-memory value here because the process may
        // have restarted since the last reconcile, wiping any in-memory state.
        const deviceRecord = await prisma.device.findUnique({
            where: { id: deviceId },
            select: { lastReconciledAt: true },
        });

        const lastReconciledAt = deviceRecord?.lastReconciledAt ?? null;
        const now = new Date();

        if (lastReconciledAt !== null) {
            const msSinceLastReconcile = now.getTime() - lastReconciledAt.getTime();
            if (msSinceLastReconcile < AUTO_RECONCILE_COOLDOWN_MS) {
                const secondsRemaining = Math.ceil(
                    (AUTO_RECONCILE_COOLDOWN_MS - msSinceLastReconcile) / 1000
                );
                console.log(
                    `[ZK] Auto-reconcile for "${deviceName}" skipped — cooldown active ` +
                    `(${secondsRemaining}s remaining).`
                );
                return;
            }
        }

        console.log(`[ZK] Device "${deviceName}" reconnected — scheduling auto-reconcile...`);

        // Update lastReconciledAt BEFORE firing the reconcile so that any
        // subsequent reconnect events within the cooldown window are rejected
        // even if the reconcile is still running.
        await prisma.device.update({
            where: { id: deviceId },
            data: { lastReconciledAt: now },
        });

        // Fire the reconcile after the current event loop iteration completes.
        // reconcileDeviceWithDB will acquireDeviceLock(deviceId), which queues
        // behind the lock still held by syncSingleDevice. Once the sync finishes
        // and releases its lock, the reconcile proceeds.
        setImmediate(async () => {
            try {
                console.log(`[ZK] Auto-reconcile starting for "${deviceName}" (deviceId: ${deviceId})...`);
                const report = await reconcileDeviceWithDB(deviceId, false, true);
                console.log(
                    `[ZK] Auto-reconcile complete for "${deviceName}". ` +
                    `Pushed: ${report.pushed.length}, ` +
                    `Deleted: ${report.deleted.length}, ` +
                    `Needs enrollment: ${report.needsEnrollment.length}.`
                );
            } catch (reconcileErr: any) {
                // Auto-reconcile failure is non-fatal. The admin can run a
                // manual reconcile from the Devices page if needed.
                console.error(
                    `[ZK] Auto-reconcile failed for "${deviceName}": ${zkErrMsg(reconcileErr)}`
                );
            }
        });

    } catch (err: any) {
        // Errors in triggerAutoReconcile itself must not propagate up and
        // crash syncSingleDevice(). Log and swallow.
        console.error(
            `[ZK] triggerAutoReconcile error for "${deviceName}": ${zkErrMsg(err)}`
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helper: sync a single device (connect → getLogs → insert → disconnect).
// Manages its own per-device lock. NOT exported — only called by syncZkData().
// ─────────────────────────────────────────────────────────────────────────────
async function syncSingleDevice(dbDevice: {
    id: number;
    name: string;
    ip: string;
    port: number;
    isActive: boolean;
    syncEnabled: boolean;
}): Promise<{ deviceId: number; newLogs: number; skipped: boolean; error?: string }> {
    if (dbDevice.syncEnabled === false) {
        console.debug(`[ZK] Skipping "${dbDevice.name}" — sync is disabled.`);
        return { deviceId: dbDevice.id, newLogs: 0, skipped: true };
    }

    // Non-blocking lock: skip this device if it is already being used
    if (!tryAcquireDeviceLock(dbDevice.id)) {
        console.debug(`[ZK] Cron sync skipped for "${dbDevice.name}" — device is busy.`);
        return { deviceId: dbDevice.id, newLogs: 0, skipped: true };
    }

    // ── Read the sync watermark for this device ───────────────────────────
    // We re-query the device record here (not trusting the stale snapshot passed
    // in from syncZkData's findMany) to ensure we have the absolute latest
    // lastSyncedAt value, even if a previous tick updated it mid-cycle.
    const deviceRecord = await prisma.device.findUnique({
        where: { id: dbDevice.id },
        select: { lastSyncedAt: true },
    });

    // Determine the watermark: use lastSyncedAt if it exists, otherwise fall back
    // to 48 hours ago. The 48-hour window is deliberately wide to:
    //   1. Catch logs that span the midnight boundary (preventing the "today only" gap)
    //   2. Recover logs from any server downtime up to 48 hours
    // The @@unique([timestamp, employeeId]) constraint on AttendanceLog guarantees
    // that any log already in the DB will be silently skipped on insert — so fetching
    // a wide window is safe and never creates duplicates.
    const FALLBACK_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours
    const watermark: Date = deviceRecord?.lastSyncedAt ?? new Date(Date.now() - FALLBACK_WINDOW_MS);

    console.log(`[ZK] "${dbDevice.name}" watermark: ${watermark.toISOString()} (${deviceRecord?.lastSyncedAt ? 'from DB' : '48h fallback'})`);

    // ── Reconnect detection ───────────────────────────────────────────────────
    // Capture whether this device was marked offline BEFORE we attempt to connect.
    // If isActive was false but we connect successfully this tick, that is a
    // reconnect event and we should trigger a background reconcile.
    const wasOfflineBefore: boolean = !dbDevice.isActive;

    const zk = getDriver(dbDevice.ip, dbDevice.port);
    try {
        console.log(`[ZK] Syncing device "${dbDevice.name}" at ${dbDevice.ip}:${dbDevice.port}...`);
        // Single attempt — the 30s cron IS the retry loop. No need to waste
        // 5+ seconds retrying within a tick when the next tick is 30s away.
        await connectWithRetry(zk, 0);

        // getInfo() uses UDP — non-fatal if it fails (device still works via TCP)
        try {
            const info = await zk.getInfo();
            console.log(`[ZK] Connected! Serial: ${info?.serialNumber ?? 'N/A'}`);
        } catch {
            console.warn(`[ZK] getInfo() failed (UDP may be blocked) — continuing with TCP only.`);
        }

        // Mark ONLINE using device.id (not the env-var IP) so Configure changes apply immediately
        await prisma.device.update({
            where: { id: dbDevice.id },
            data: { isActive: true, updatedAt: new Date() }
        }).catch(() => { /* ignore */ });

        // If this device was offline at the start of this tick but is now reachable,
        // it just reconnected. Fire a background reconcile to push any employees that
        // were created, updated, or deleted while the device was offline.
        if (wasOfflineBefore) {
            void triggerAutoReconcile(dbDevice.id, dbDevice.name);

            // Notify SSE subscribers that this device just came back online.
            deviceEmitter.emit('status-change', {
                id: dbDevice.id,
                name: dbDevice.name,
                ip: dbDevice.ip,
                isActive: true,
            });

            // Persist device connect event to audit log
            void audit({
                action: 'DEVICE_CONNECT',
                entityType: 'Device',
                entityId: dbDevice.id,
                source: 'device-sync',
                details: `Device "${dbDevice.name}" (${dbDevice.ip}) came online`,
                metadata: { category: 'device', deviceName: dbDevice.name, ip: dbDevice.ip }
            });
        }

                // ENFORCE SOURCE OF TRUTH: Force the device's clock to match the Backend Server Time
                // This prevents physical clock drift on the hardware. 
                // The device expects the time in its local timezone (PHT UTC+8), so we send it raw 'new Date()'.
                try {
                    const nowUTC = new Date();
                    await zk.setTime(nowUTC);
                    console.log(`[ZK] Enforced Centralized Server Time on "${dbDevice.name}"`);
                } catch (timeErr) {
                    console.warn(`[ZK] setTime failed on "${dbDevice.name}" - continuing anyway: ${zkErrMsg(timeErr)}`);
                }

        const allLogs = await zk.getLogs();

        // ── Filter logs using the watermark ──────────────────────────────────
        // Convert each device log's recordTime to UTC using convertPHTtoUTC before
        // comparing against the watermark (which is already stored in UTC).
        // This ensures the comparison is timezone-safe regardless of how node-zklib
        // represents the device's local time internally.
        const logs = allLogs
            .filter((log: any) => {
                const logUTC = convertPHTtoUTC(log.recordTime);
                return logUTC > watermark;
            })
            .sort((a: any, b: any) =>
                convertPHTtoUTC(a.recordTime).getTime() -
                convertPHTtoUTC(b.recordTime).getTime()
            );

        console.log(`[ZK] Fetched ${allLogs.length} total logs, filtered to ${logs.length} logs newer than watermark.`);

        // Track the timestamp of the most recently inserted log so we can
        // advance the watermark after the loop. We only advance on successful
        // inserts — a failed insert does not move the watermark forward.
        let latestInsertedTimestamp: Date | null = null;
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
                    const diffMs = Math.abs(utcTime.getTime() - lastLog.timestamp.getTime());
                    const diffMinutes = diffMs / (1000 * 60);

                    // Only skip if it's within 1 minute (likely accidental double-scan)
                    if (diffMinutes < 1) {
                        // Log duplicate punch detection
                        void audit({
                            action: 'DUPLICATE_PUNCH',
                            level: 'WARN',
                            entityType: 'Attendance',
                            entityId: employee.id,
                            performedBy: employee.id,
                            source: 'device-sync',
                            details: `Duplicate punch detected for ${employee.firstName} ${employee.lastName} (${Math.round(diffMs / 1000)}s apart)`,
                            metadata: { category: 'attendance', employeeId: employee.id, zkId: zkUserId, diffSeconds: Math.round(diffMs / 1000), deviceId: dbDevice.id }
                        });
                        continue;
                    }
                }

                // 3. Check for exact duplicate in DB (same timestamp + same employee)
                const exists = await prisma.attendanceLog.findUnique({
                    where: {
                        timestamp_employeeId: {
                            timestamp: utcTime,
                            employeeId: employee.id
                        }
                    }
                });

                if (exists) {
                    // Exact-timestamp duplicate — log it and skip
                    void audit({
                        action: 'DUPLICATE_PUNCH',
                        level: 'WARN',
                        entityType: 'Attendance',
                        entityId: employee.id,
                        performedBy: employee.id,
                        source: 'device-sync',
                        details: `Duplicate punch detected for ${employee.firstName} ${employee.lastName} (exact timestamp match)`,
                        metadata: { category: 'attendance', employeeId: employee.id, zkId: zkUserId, diffSeconds: 0, deviceId: dbDevice.id }
                    });
                    continue;
                }

                await prisma.attendanceLog.create({
                    data: {
                        timestamp: utcTime,  // Store UTC time
                        employeeId: employee.id,
                        status: log.status,
                    },
                });
                newCount++;

                // ── Advance the in-memory watermark tracker ───────────
                // We track the maximum UTC timestamp across all successfully
                // inserted logs so that after the loop we can persist the new
                // high-water mark. Using a null-check + comparison ensures we
                // always end up with the latest timestamp even if logs arrive
                // out of order.
                if (latestInsertedTimestamp === null || utcTime > latestInsertedTimestamp) {
                    latestInsertedTimestamp = utcTime;
                }
            } catch (logErr) {
                console.error(`[ZK] Error processing log:`, logErr);
            }
        }

        // ── Persist the watermark if any new logs were inserted ──────────────
        // Only update lastSyncedAt when at least one log was successfully written.
        // This ensures that a sync cycle that finds no new logs does not
        // accidentally reset the watermark to null or move it backwards.
        if (latestInsertedTimestamp !== null) {
            await prisma.device.update({
                where: { id: dbDevice.id },
                data: { lastSyncedAt: latestInsertedTimestamp, lastSyncStatus: 'SUCCESS', lastSyncError: null, lastPolledAt: new Date() },
            });
            console.log(`[ZK] "${dbDevice.name}" watermark advanced to ${latestInsertedTimestamp.toISOString()}`);
        } else {
            await prisma.device.update({
                where: { id: dbDevice.id },
                data: { lastSyncStatus: 'SUCCESS', lastSyncError: null, lastPolledAt: new Date() }
            }).catch(() => { /* ignore */ });
        }

        deviceEmitter.emit('device-sync-result', {
            id: dbDevice.id,
            lastSyncStatus: 'SUCCESS',
            lastSyncedAt: latestInsertedTimestamp || watermark,
            lastSyncError: null,
            lastPolledAt: new Date()
        });

        await audit({
            action: 'DEVICE_SYNC',
            entityType: 'Device',
            entityId: dbDevice.id,
            source: 'cron',
            level: 'INFO',
            details: `Synced ${newCount} new logs from ${dbDevice.name}`,
            metadata: { deviceId: dbDevice.id, deviceName: dbDevice.name, newLogs: newCount }
        });

        console.log(`[ZK] Device "${dbDevice.name}" sync complete. ${newCount} new logs.`);
        return { deviceId: dbDevice.id, newLogs: newCount, skipped: false };

    } catch (deviceErr: any) {
        console.error(`[ZK] Error syncing "${dbDevice.name}" (${dbDevice.ip}): ${zkErrMsg(deviceErr)}`);

        // Only emit when the device was previously online — avoids redundant
        // broadcasts for a device that is already known to be offline.
        const transitionedToOffline = dbDevice.isActive;

        // Mark this specific device as OFFLINE
        await prisma.device.update({
            where: { id: dbDevice.id },
            data: { 
                isActive: false, 
                updatedAt: new Date(),
                lastSyncStatus: 'FAILED',
                lastSyncError: zkErrMsg(deviceErr),
                lastPolledAt: new Date()
            }
        }).catch(() => { /* ignore */ });

        deviceEmitter.emit('device-sync-result', {
            id: dbDevice.id,
            lastSyncStatus: 'FAILED',
            lastSyncedAt: watermark,
            lastSyncError: zkErrMsg(deviceErr),
            lastPolledAt: new Date()
        });

        await audit({
            action: 'DEVICE_SYNC',
            entityType: 'Device',
            entityId: dbDevice.id,
            source: 'cron',
            level: 'ERROR',
            details: `Sync failed for ${dbDevice.name}: ${zkErrMsg(deviceErr)}`,
            metadata: { deviceId: dbDevice.id, deviceName: dbDevice.name, error: zkErrMsg(deviceErr) }
        });

        if (transitionedToOffline) {
            deviceEmitter.emit('status-change', {
                id: dbDevice.id,
                name: dbDevice.name,
                ip: dbDevice.ip,
                isActive: false,
            });

            // Persist device disconnect event to audit log
            void audit({
                action: 'DEVICE_DISCONNECT',
                level: 'WARN',
                entityType: 'Device',
                entityId: dbDevice.id,
                source: 'device-sync',
                details: `Device "${dbDevice.name}" (${dbDevice.ip}) went offline`,
                metadata: { category: 'device', deviceName: dbDevice.name, ip: dbDevice.ip, error: zkErrMsg(deviceErr) }
            });
        }

        return { deviceId: dbDevice.id, newLogs: 0, skipped: false, error: zkErrMsg(deviceErr) };
    } finally {
        try { await zk.disconnect(); } catch { /* ignore */ }
        releaseDeviceLock(dbDevice.id);
    }
}

export const syncZkData = async (): Promise<SyncZkDataResult> => {
    try {
        // Load ALL devices from the DB — this way IP changes via Configure take effect immediately
        const dbDevices = await prisma.device.findMany({ orderBy: { id: 'asc' } });

        if (dbDevices.length === 0) {
            console.warn('[ZK] No devices found in DB — skipping sync.');
            return { 
                success: true, 
                status: 'NO_DEVICES', 
                message: 'No devices configured', 
                totalDevices: 0, 
                successfulDevices: 0, 
                failedDevices: [], 
                newLogs: 0 
            };
        }

        // Run all device syncs in PARALLEL — each device manages its own lock
        const results = await Promise.allSettled(
            dbDevices.map(dbDevice => syncSingleDevice(dbDevice))
        );

        let totalNewLogs = 0;
        let successfulDevices = 0;
        const failedDevices: Array<{ id: number; name: string; error: string }> = [];

        results.forEach((result, index) => {
            const dbDevice = dbDevices[index];
            if (result.status === 'fulfilled') {
                const deviceResult = result.value;
                totalNewLogs += deviceResult.newLogs;
                if (deviceResult.error) {
                    failedDevices.push({ id: dbDevice.id, name: dbDevice.name, error: deviceResult.error });
                } else {
                    successfulDevices++;
                }
            } else {
                failedDevices.push({ id: dbDevice.id, name: dbDevice.name, error: String(result.reason) });
                console.error('[ZK] Unexpected rejection in syncSingleDevice:', result.reason);
            }
        });

        // Process all new logs into Attendance records once, after all devices are done
        if (totalNewLogs > 0) {
            console.log(`[ZK] Processing ${totalNewLogs} total new logs across all devices...`);
            await processAttendanceLogs();
        }

        const activeDevicesCount = dbDevices.filter(d => d.syncEnabled).length;
        
        let status: 'SUCCESS' | 'PARTIAL' | 'FAILED' = 'SUCCESS';
        if (failedDevices.length > 0) {
            status = successfulDevices > 0 ? 'PARTIAL' : 'FAILED';
        }

        return { 
            success: status !== 'FAILED',
            status, 
            message: `Synced ${successfulDevices}/${activeDevicesCount} active devices.`,
            totalDevices: activeDevicesCount,
            successfulDevices,
            failedDevices,
            newLogs: totalNewLogs
        };

    } catch (error: any) {
        console.error('[ZK] syncZkData fatal error:', zkErrMsg(error));
        return { 
            success: false, 
            status: 'FAILED',
            error: `Sync Error: ${zkErrMsg(error)}`, 
            message: 'Failed to sync attendance data',
            totalDevices: 0,
            successfulDevices: 0,
            failedDevices: [],
            newLogs: 0
        } as any;
    }
    // NOTE: No top-level releaseDeviceLock() here — each device releases its own lock
};

export const addUserToDevice = async (zkId: number, name: string, role: string = 'USER', cardNumber: number = 0): Promise<SyncResult> => {
    // addUserToDevice is triggered from the UI after employee creation.
    // Each device gets its own interactive lock inside the loop so that
    // writing to Device 1 does not block access to Device 2.
    try {
        console.log(`[ZK] Adding User with zkId=${zkId} (${name})...`);

        const dbDevices = await prisma.device.findMany({
            where: { isActive: true, syncEnabled: true },
            orderBy: { id: 'asc' },
        });

        if (dbDevices.length === 0) {
            console.warn('[ZK] No active devices in DB — cannot add user.');
            return { success: false, message: 'No active devices configured.' };
        }

        let lastError: any;
        let addedToAtLeastOne = false;

        for (const dbDevice of dbDevices) {
            await acquireInteractiveDeviceLock(dbDevice.id);
            const zk = getDriver(dbDevice.ip, dbDevice.port);
            try {
                console.log(`[ZK] Connecting to "${dbDevice.name}" (${dbDevice.ip}:${dbDevice.port})...`);
                await connectWithRetry(zk, 2);

                const deviceRole = role === 'ADMIN' ? 14 : 0;
                const visibleId = zkId.toString();

                // ── UID = zkId (deterministic, collision-free) ────────────────
                // Using getNextUid() was the root cause of overwriting existing
                // users. Instead, we ALWAYS use the employee's DB zkId as their
                // device UID. This makes the mapping 1-to-1 and predictable:
                //   DB employee.zkId === device internal UID (always)
                const deviceUid = zkId;

                if (PROTECTED_DEVICE_UIDS.includes(deviceUid)) {
                    console.warn(`[ZK] ⚠ zkId=${zkId} collides with a protected device UID. Skipping device "${dbDevice.name}".`);
                    continue;
                }

                // ── Pre-write occupancy check ─────────────────────────────────
                // Two independent guards are required:
                //   Guard 1 (uid-based):    Is the TARGET SLOT already occupied?
                //   Guard 2 (userId-based): Does ANY slot already claim this visibleId?
                // Guard 2 catches ghost users who live at a DIFFERENT uid but carry
                // the same visible userId — the uid-only check is blind to those.
                const deviceUsers = await zk.getUsers();
                // node-zklib does not export its user type, so 'any' is required here
                const occupant = deviceUsers.find((u: any) => u.uid === deviceUid);
                const visibleConflict = deviceUsers.find((u: any) =>
                    String(u.userId).trim() === visibleId.trim() && u.uid !== deviceUid
                );

                if (occupant) {
                    if (String(occupant.userId).trim() === visibleId.trim()) {
                        // Same employee already in this slot — skip delete, just update name/role
                        console.log(`[ZK] Slot UID=${deviceUid} already belongs to "${name}" — updating in place.`);
                        await zk.setUser(deviceUid, name, "", deviceRole, cardNumber, visibleId);
                    } else {
                        // A DIFFERENT user occupies this slot — refuse to overwrite
                        console.warn(`[ZK] ⚠ UID conflict on "${dbDevice.name}": slot UID=${deviceUid} is occupied by userId="${occupant.userId}" ("${occupant.name}") — refusing to overwrite with "${name}".`);
                        lastError = new Error(`UID conflict: slot ${deviceUid} occupied by another user`);
                        continue; // Try next device; do NOT destroy this user's data
                    }
                } else if (visibleConflict) {
                    // Guard 2: A DIFFERENT uid already holds this visibleId (ghost user).
                    // Writing here would create duplicate visible IDs on the device and
                    // corrupt attendance attribution. Refuse until UID conflict is resolved.
                    console.warn(`[ZK] ⚠ visibleId conflict on "${dbDevice.name}": userId="${visibleId}" is already claimed by UID=${visibleConflict.uid} ("${visibleConflict.name}") — refusing to write "${name}" to UID=${deviceUid}.`);
                    lastError = new Error(`visibleId conflict: userId=${visibleId} already at uid=${visibleConflict.uid}`);
                    continue;
                } else {
                    // Slot is empty AND no other slot claims this visibleId — safe to write.
                    // Force-clear first to remove any stale fingerprint data.
                    console.log(`[ZK] Force-clearing UID=${deviceUid} on "${dbDevice.name}" before write...`);
                    try { await zk.deleteUser(deviceUid); } catch { /* slot already empty — ok */ }
                    await zk.clearUserFingerprints(deviceUid);
                    await zk.setUser(deviceUid, name, "", deviceRole, cardNumber, visibleId);
                }

                await zk.refreshData();
                console.log(`[ZK] ✓ Written "${name}" → UID=${deviceUid}, visibleId="${visibleId}" on "${dbDevice.name}".`);
                addedToAtLeastOne = true;
            } catch (err: any) {
                lastError = err;
                console.error(`[ZK] Failed to add user to "${dbDevice.name}": ${zkErrMsg(err)}`);
            } finally {
                try { await zk.disconnect(); } catch { /* ignore */ }
                releaseDeviceLock(dbDevice.id);
            }
        }

        if (!addedToAtLeastOne) {
            throw lastError ?? new Error('All devices failed');
        }

        return { success: true, message: `User ${name} synced to device(s).` };
    } catch (error: any) {
        console.error('[ZK] Add User Error:', zkErrMsg(error));
        throw new Error(`Failed to add employee: ${zkErrMsg(error)}`);
    }
};




export const deleteUserFromDevice = async (zkId: number): Promise<SyncResult> => {
    try {
        console.log(`[ZK] Deleting User with zkId=${zkId} from all devices...`);

        const dbDevices = await prisma.device.findMany({
            where: { isActive: true, syncEnabled: true },
            orderBy: { id: 'asc' },
        });

        if (dbDevices.length === 0) {
            return { success: true, message: 'No active devices — nothing to delete from.' };
        }

        for (const dbDevice of dbDevices) {
            await acquireDeviceLock(dbDevice.id);
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
                releaseDeviceLock(dbDevice.id);
            }
        }

        return { success: true, message: `User ${zkId} removed from device(s).` };
    } catch (error: any) {
        console.error('[ZK] Delete User Error:', zkErrMsg(error));
        return { success: false, message: `Failed to delete user: ${zkErrMsg(error)}`, error: zkErrMsg(error) };
    }
};

export const syncEmployeesToDevice = async (): Promise<SyncResult> => {
    try {
        console.log(`[ZK] syncEmployeesToDevice — fetching DB employees...`);
        const employees = await prisma.employee.findMany({
            where: {
                zkId: { not: null, gt: 1 }, // Skip Admin (zkId = 1)
                employmentStatus: 'ACTIVE',
            },
            select: { zkId: true, firstName: true, lastName: true, role: true, cardNumber: true }
        });

        if (employees.length === 0) {
            return { success: true, message: "No employees to sync.", count: 0 };
        }

        const dbDevices = await prisma.device.findMany({
            where: { isActive: true, syncEnabled: true },
            orderBy: { id: 'asc' },
        });

        if (dbDevices.length === 0) {
            return { success: false, message: 'No active devices configured.' };
        }

        let totalSuccess = 0;

        for (const dbDevice of dbDevices) {
            await acquireDeviceLock(dbDevice.id);
            const zk = getDriver(dbDevice.ip, dbDevice.port);
            let successCount = 0;
            try {
                console.log(`[ZK] Connecting to "${dbDevice.name}"...`);
                await connectWithRetry(zk);

                // ── Fetch device users ONCE before the employee loop ──────────
                // WHY: Calling getUsers() inside the loop would hammer the device
                // with one TCP round-trip per employee. The user list does not
                // change mid-loop so fetching it once is both correct and efficient.
                const deviceUsers = await zk.getUsers();

                for (const employee of employees) {
                    const fullName = `${employee.firstName} ${employee.lastName}`;
                    const zkId = employee.zkId!;
                    const visibleId = zkId.toString();
                    const deviceRole = employee.role === 'ADMIN' ? 14 : 0;
                    const deviceUid = zkId; // UID ≡ zkId — deterministic, no collisions

                    if (PROTECTED_DEVICE_UIDS.includes(deviceUid)) {
                        console.warn(`[ZK]   ⚠ SKIP ${fullName} — zkId=${zkId} is a protected UID.`);
                        continue;
                    }

                    try {
                        // ── Pre-write occupancy check ─────────────────────────
                        // WHY: Before touching any slot, verify who currently
                        // occupies it. If a different user is there, skip this
                        // employee and continue — do NOT abort the entire sync.
                        // node-zklib does not export its user type, so 'any' is required here
                        const occupant = deviceUsers.find((u: any) => u.uid === deviceUid);

                        if (occupant) {
                            if (String(occupant.userId).trim() === visibleId.trim()) {
                                // Same employee — update name/role in place, skip delete
                                await zk.setUser(deviceUid, fullName, "", deviceRole, employee.cardNumber ?? 0, visibleId);
                                console.log(`[ZK]   ✓ Updated: "${fullName}" → UID=${deviceUid} (slot already owned, skipped delete)`);
                                successCount++;
                            } else {
                                // Different user in this slot — skip, never overwrite
                                console.warn(`[ZK]   ⚠ UID conflict: slot UID=${deviceUid} occupied by userId="${occupant.userId}" ("${occupant.name}") — skipping "${fullName}".`);
                                // continue to next employee — do NOT return, do NOT abort the sync
                            }
                        } else {
                            // Slot is empty — safe to clear and write
                            try { await zk.deleteUser(deviceUid); } catch { /* empty slot — ok */ }
                            await zk.clearUserFingerprints(deviceUid);
                            await zk.setUser(deviceUid, fullName, "", deviceRole, employee.cardNumber ?? 0, visibleId);
                            console.log(`[ZK]   ✓ Written: "${fullName}" → UID=${deviceUid} on "${dbDevice.name}"`);
                            successCount++;
                        }
                    } catch (err: any) {
                        console.error(`[ZK]   ✗ Failed "${fullName}": ${zkErrMsg(err)}`);
                    }
                }

                await zk.refreshData();
                totalSuccess += successCount;
            } catch (err: any) {
                console.error(`[ZK] Could not sync to "${dbDevice.name}": ${zkErrMsg(err)}`);
            } finally {
                try { await zk.disconnect(); } catch { /* ignore */ }
                releaseDeviceLock(dbDevice.id);
            }
        }

        return {
            success: totalSuccess > 0,
            message: `Synced ${totalSuccess} employee(s) across ${dbDevices.length} device(s).`,
            count: totalSuccess,
        };

    } catch (error: any) {
        throw new Error(`Sync failed: ${error.message}`);
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
    fingerIndex: number = 5,
    deviceId?: number
): Promise<SyncResult> => {
    console.log(`[Enrollment] Starting for employee ${employeeId}, finger ${fingerIndex}, device ${deviceId ?? 'auto'}...`);

    // 1. Load employee from DB
    const employee = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { id: true, zkId: true, firstName: true, lastName: true, cardNumber: true },
    });

    if (!employee) {
        return { success: false, message: `Employee ${employeeId} not found in database.` };
    }

    if (!employee.zkId) {
        // Auto-assign zkid for imported employees at enrollment time
        const release = await acquireRegistrationMutex();
        try {
            const nextZkId = await findNextSafeZkId();
            const updated = await prisma.employee.update({
                where: { id: employeeId },
                data: { zkId: nextZkId, updatedAt: new Date() },
            });
            employee.zkId = nextZkId;
            console.log(`[Enrollment] Auto-assigned zkId=${nextZkId} to employee ${employeeId} (${employee.firstName} ${employee.lastName}).`);
        } finally {
            release();
        }
    }

    // 2. Resolve which device to use
    let dbDevice;

    if (deviceId) {
        // Use the specific device HR selected from the UI
        dbDevice = await prisma.device.findUnique({ where: { id: deviceId } });
        if (!dbDevice) {
            return { success: false, message: `Device ${deviceId} not found in database.` };
        }
    } else {
        // Fallback: use the first active device (legacy behaviour)
        dbDevice = await prisma.device.findFirst({
            where: { isActive: true },
            orderBy: { id: 'asc' },
        });
        if (!dbDevice) {
            return { success: false, message: 'No active devices configured.' };
        }
    }

    // Guard: refuse enrollment immediately if the device is known to be offline.
    // This avoids a 5-10 second wait for connectWithRetry to fail and gives
    // the user instant feedback.
    if (!dbDevice.isActive) {
        return {
            success: false,
            message: `Device "${dbDevice.name}" is currently offline. Please wait for it to come back online before enrolling.`,
        };
    }

    const fullName = `${employee.firstName} ${employee.lastName}`;
    const visibleId = employee.zkId.toString();
    // UID = zkId — deterministic 1-to-1 mapping (matches addUserToDevice strategy)
    const deviceUid = employee.zkId;

    // 3. Acquire interactive device lock — enrollment is UI-triggered and time-sensitive.
    // acquireInteractiveDeviceLock() places this at the FRONT of the queue so cron syncs
    // can never delay fingerprint capture.
    await acquireInteractiveDeviceLock(dbDevice.id);
    const zk = getDriver(dbDevice.ip, dbDevice.port);


    try {
        console.log(`[Enrollment] Connecting to "${dbDevice.name}" (${dbDevice.ip}:${dbDevice.port})...`);
        // 1 retry for enrollment — user is actively waiting, so one quick
        // retry is acceptable but 3 attempts is too slow for an interactive flow.
        await connectWithRetry(zk, 1);

        // 3. Ensure user exists on this specific device
        const deviceUsers = await zk.getUsers();
        // ── Pre-write occupancy check (uid-based) ───────────────────────────
        // WHY: The previous code searched ONLY by visible userId string, which
        // meant that if the target UID slot was held by a DIFFERENT user whose
        // userId didn't match visibleId, existingUser would be null and the code
        // would silently force-delete and overwrite that user's fingerprints.
        // We now check the SLOT first (by uid), then fall back to userId lookup.
        // node-zklib does not export its user type, so 'any' is required here.
        const slotOccupant = deviceUsers.find((u: any) => u.uid === deviceUid);
        const userByVisibleId = deviceUsers.find((u: any) => String(u.userId).trim() === visibleId.trim());

        if (slotOccupant && String(slotOccupant.userId).trim() !== visibleId.trim()) {
            // Guard 1: A DIFFERENT person occupies the target slot — refuse immediately.
            console.warn(`[Enrollment] ⚠ UID conflict: slot UID=${deviceUid} is occupied by userId="${slotOccupant.userId}" ("${slotOccupant.name}") — refusing enrollment for "${fullName}" (visibleId="${visibleId}").`);
            return {
                success: false,
                message: `Cannot enroll: slot UID=${deviceUid} is already occupied by a different user ("${slotOccupant.name}"). Resolve the UID conflict first.`,
                error: 'uid_conflict'
            };
        }

        if (slotOccupant && String(slotOccupant.userId).trim() === visibleId.trim()) {
            // Guard 2 (short-circuit): The correct user is already in the correct slot.
            // Do NOT fall through to userByVisibleId — that Array.find() could return a
            // ghost user with the same userId at a different uid, triggering a false rewrite.
            console.log(`[Enrollment] User already at correct slot UID=${deviceUid}. Proceeding to enroll.`);
        } else if (!userByVisibleId) {
            // Slot is empty and no other record claims this visibleId — safe to write fresh.
            console.log(`[Enrollment] User not found on device — force-clearing slot UID=${deviceUid} and adding (visibleId="${visibleId}")...`);
            try { await zk.deleteUser(deviceUid); } catch { /* slot empty — ok */ }
            await zk.clearUserFingerprints(deviceUid);
            await zk.setUser(deviceUid, fullName, '', 0, employee.cardNumber ?? 0, visibleId);
            await zk.refreshData();
            console.log(`[Enrollment] User written to UID=${deviceUid}.`);
        } else if (userByVisibleId.uid !== deviceUid) {
            // User exists at the wrong UID (target slot is confirmed empty from Guard 1 pass).
            console.warn(`[Enrollment] ⚠ User found at wrong UID=${userByVisibleId.uid} — re-writing to correct slot UID=${deviceUid}.`);
            try { await zk.deleteUser(deviceUid); } catch { /* slot may be empty */ }
            await zk.clearUserFingerprints(deviceUid);
            await zk.setUser(deviceUid, fullName, '', 0, employee.cardNumber ?? 0, visibleId);
            await zk.refreshData();
            console.log(`[Enrollment] User re-written to UID=${deviceUid}.`);
        } else {
            console.log(`[Enrollment] User already at correct slot UID=${deviceUid}. Proceeding to enroll.`);
        }

        // 4. Send enrollment command
        const fingerName = FINGER_MAP[fingerIndex] || `Finger ${fingerIndex}`;
        console.log(`[Enrollment] Sending CMD_STARTENROLL for "${fullName}" (${fingerName}) on "${dbDevice.name}"...`);
        await zk.startEnrollment(visibleId, fingerIndex);

        // 5. Record enrollment in DB
        await prisma.employeeDeviceEnrollment.upsert({
            where: {
                employeeId_deviceId: {
                    employeeId: employee.id,
                    deviceId: dbDevice.id,
                },
            },
            update: {
                enrolledAt: new Date(),
            },
            create: {
                employeeId: employee.id,
                deviceId: dbDevice.id,
            },
        });

        console.log(`[Enrollment] ✓ Enrollment recorded in DB for employee ${employeeId} on device "${dbDevice.name}".`);

        return {
            success: true,
            message: `Enrollment started for ${fullName} on device "${dbDevice.name}". Please scan finger now.`,
        };

    } catch (error: any) {
        console.error(`[Enrollment] Error:`, error);
        return {
            success: false,
            message: 'Enrollment failed',
            error: error.message,
        };
    } finally {
        try { await zk.disconnect(); } catch { /* ignore */ }
        releaseDeviceLock(dbDevice.id);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// RFID BADGE CARD ENROLLMENT
// Writes a card number into the user record on ALL active devices, then
// persists it to the Employee DB row.
// ─────────────────────────────────────────────────────────────────────────────
export const enrollEmployeeCard = async (
    employeeId: number,
    cardNumber: number,
): Promise<SyncResult> => {
    console.log(`[CardEnroll] Starting for employee ${employeeId}, card ${cardNumber}...`);

    // 1. Load employee from DB
    const employee = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { id: true, zkId: true, firstName: true, lastName: true, role: true, cardNumber: true },
    });

    if (!employee) {
        return { success: false, message: `Employee ${employeeId} not found in database.` };
    }

    if (!employee.zkId) {
        return { success: false, message: `Employee ${employeeId} has no zkId assigned. Sync to device first.` };
    }

    // 2. Validate card number uniqueness
    const existingHolder = await prisma.employee.findUnique({
        where: { cardNumber },
        select: { id: true, firstName: true, lastName: true },
    });

    if (existingHolder && existingHolder.id !== employeeId) {
        return {
            success: false,
            message: `Card #${cardNumber} is already assigned to ${existingHolder.firstName} ${existingHolder.lastName}.`,
            error: 'duplicate_card',
        };
    }

    // 3. Write to ALL active devices
    const fullName = `${employee.firstName} ${employee.lastName}`;
    const visibleId = employee.zkId.toString();
    const deviceUid = employee.zkId;
    const deviceRole = employee.role === 'ADMIN' ? 14 : 0;

    const dbDevices = await prisma.device.findMany({
        where: { isActive: true, syncEnabled: true },
        orderBy: { id: 'asc' },
    });

    if (dbDevices.length === 0) {
        // No devices online — still save to DB so next reconcile pushes it
        await prisma.employee.update({
            where: { id: employeeId },
            data: { cardNumber, updatedAt: new Date() },
        });
        return {
            success: true,
            message: `Card #${cardNumber} saved for ${fullName}, but no devices are online to sync.`,
        };
    }

    let syncedCount = 0;
    const failedDevices: string[] = [];

    for (const dbDevice of dbDevices) {
        await acquireInteractiveDeviceLock(dbDevice.id);
        const zk = getDriver(dbDevice.ip, dbDevice.port);
        try {
            await connectWithRetry(zk, 1);

            const deviceUsers = await zk.getUsers();
            const occupant = deviceUsers.find((u: any) => u.uid === deviceUid);

            if (occupant && String(occupant.userId).trim() !== visibleId.trim()) {
                // Slot occupied by a different user — skip
                console.warn(`[CardEnroll] ⚠ UID conflict on "${dbDevice.name}": slot UID=${deviceUid} occupied by "${occupant.name}" — skipping.`);
                failedDevices.push(`${dbDevice.name} (UID conflict)`);
                continue;
            }

            if (!occupant) {
                // User not on device yet — write fresh
                try { await zk.deleteUser(deviceUid); } catch { /* empty slot */ }
                await zk.clearUserFingerprints(deviceUid);
            }

            // Write user record WITH card number
            await zk.setUser(deviceUid, fullName, '', deviceRole, cardNumber, visibleId);
            await zk.refreshData();

            console.log(`[CardEnroll] ✓ Card #${cardNumber} → "${fullName}" on "${dbDevice.name}".`);
            syncedCount++;
        } catch (err: any) {
            console.error(`[CardEnroll] Failed on "${dbDevice.name}": ${zkErrMsg(err)}`);
            failedDevices.push(`${dbDevice.name} (${zkErrMsg(err)})`);
        } finally {
            try { await zk.disconnect(); } catch { /* ignore */ }
            releaseDeviceLock(dbDevice.id);
        }
    }

    // 4. Persist to DB
    await prisma.employee.update({
        where: { id: employeeId },
        data: { cardNumber, updatedAt: new Date() },
    });

    const msg = syncedCount > 0
        ? `Card #${cardNumber} enrolled for ${fullName}. Synced to ${syncedCount} device(s).`
        : `Card #${cardNumber} saved for ${fullName}, but all devices failed to sync.`;

    if (failedDevices.length > 0) {
        console.warn(`[CardEnroll] Failed devices: ${failedDevices.join(', ')}`);
    }

    return {
        success: true,
        message: msg + (failedDevices.length > 0 ? ` Failed: ${failedDevices.join(', ')}` : ''),
    };
};


export const testDeviceConnection = async (): Promise<SyncResult> => {
    const zk = getDriver();
    // Sentinel device ID 0 — testDeviceConnection uses env-var defaults, not a DB device,
    // so it gets its own lock slot that never conflicts with real DB device IDs (which start at 1).
    await acquireDeviceLock(0);
    try {
        await connectWithRetry(zk);

        let serial = 'N/A';
        try {
            const info = await zk.getInfo();
            serial = info?.serialNumber ?? 'N/A';
        } catch {
            console.warn('[ZK] getInfo() failed (UDP may be blocked) — serial unavailable.');
        }

        let timePart = '';
        try {
            const time = await zk.getTime();
            timePart = `, Time: ${JSON.stringify(time)}`;
        } catch {
            // getTime() failure is non-fatal
        }

        return { success: true, message: `Connected! Serial: ${serial}${timePart}` };
    } catch (error: any) {
        return { success: false, error: error.message };
    } finally {
        try { await zk.disconnect(); } catch { /* ignore disconnect errors */ }
        releaseDeviceLock(0);
    }
};

export const syncEmployeesFromDevice = async (): Promise<SyncResult> => {
    try {
        const dbDevices = await prisma.device.findMany({
            where: { isActive: true, syncEnabled: true },
            orderBy: { id: 'asc' },
        });

        if (dbDevices.length === 0) {
            return { success: true, message: 'No active, sync-enabled devices configured.' };
        }

        let totalUpdateCount = 0;
        let totalSkippedCount = 0;

        for (const dbDevice of dbDevices) {
            await acquireDeviceLock(dbDevice.id);
            const zk = getDriver(dbDevice.ip, dbDevice.port);
            try {
                console.log(`[ZK] syncEmployeesFromDevice — connecting to "${dbDevice.name}" (${dbDevice.ip}:${dbDevice.port})...`);
                await connectWithRetry(zk);
                const users = await zk.getUsers();

                console.log(`[ZK] Found ${users.length} users on "${dbDevice.name}".`);
                let updateCount = 0;
                let skippedCount = 0;

                for (const user of users) {
                    let zkId = parseInt(user.userId);
                    if (isNaN(zkId)) continue;

                    // SPECIAL CASE: Map Device Admin (2948876) to Database Admin (1)
                    if (zkId === 2948876) {
                        zkId = 1;
                    }

                    const existing = await prisma.employee.findUnique({ where: { zkId } });

                    if (existing) {
                        const nameParts = user.name.split(' ');
                        const firstName = nameParts[0] || existing.firstName;
                        const lastName = nameParts.slice(1).join(' ') || existing.lastName;

                        if (user.name && (existing.firstName !== firstName || existing.lastName !== lastName)) {
                            await prisma.employee.update({
                                where: { id: existing.id },
                                data: { firstName, lastName }
                            });
                            console.log(`[ZK] Updated Name for zkId=${zkId}: ${user.name}`);
                        }
                        updateCount++;
                    } else {
                        // Unknown device user — do NOT auto-create in DB.
                        // Ghost users are handled by reconcileDeviceWithDB, not this function.
                        console.log(`[ZK] Skipping unknown zkId ${zkId} — not in database`);
                        skippedCount++;
                    }
                }

                totalUpdateCount += updateCount;
                totalSkippedCount += skippedCount;
                console.log(`[ZK] "${dbDevice.name}" done. Matched: ${updateCount}, Skipped: ${skippedCount}.`);

            } catch (err: any) {
                console.error(`[ZK] Failed to read users from "${dbDevice.name}": ${zkErrMsg(err)}`);
            } finally {
                try { await zk.disconnect(); } catch { /* ignore */ }
                releaseDeviceLock(dbDevice.id);
            }
        }

        return {
            success: true,
            message: `Scanned ${dbDevices.length} device(s). Matched ${totalUpdateCount}, Skipped ${totalSkippedCount} unknown.`,
            count: totalUpdateCount,
        };

    } catch (error: any) {
        return { success: false, error: error.message };
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// RECONCILE: Two-way sync between a specific device and the database.
//
// Safety rules:
//   1. NEVER delete device users with role > 0 (device admins).
//   2. NEVER delete device users in PROTECTED_DEVICE_UIDS list.
//   3. Use UID = zkId for all writes (deterministic, no collisions).
//   4. Force-clear slot before each write (prevents stale fingerprint data).
// ─────────────────────────────────────────────────────────────────────────────

export interface ReconcileReport {
    deviceId: number;
    deviceName: string;
    dryRun: boolean;                                    // true = preview only, no writes made
    pushed: { zkId: number; name: string }[];           // DB-only → pushed to device (or would be)
    deleted: { uid: number; userId: string; name: string }[]; // device-only → removed (or would be)
    protected: { uid: number; name: string }[];          // admin users skipped
    needsEnrollment: { zkId: number; name: string }[];  // users with 0 fingerprints
    errors: string[];
}

/**
 * Two-way sync between a specific device and the database.
 *
 * Safety rules enforced on every run:
 *   1. NEVER delete device users with role > 0 (device admins).
 *   2. NEVER delete device users in PROTECTED_DEVICE_UIDS list.
 *   3. Use UID = zkId for all writes (deterministic, no collisions).
 *   4. Force-clear slot before each write (prevents stale fingerprint data).
 *
 * @param deviceId  DB id of the device to reconcile.
 * @param dryRun    When true, the report shows what WOULD change but no writes
 *                  are made to the device. Use this for a safe preview before
 *                  committing to a potentially destructive operation in production.
 *                  Defaults to false.
 * @param pushOnly  When true, ONLY push DB-only employees to the device —
 *                  never delete ghost users. This is used by auto-reconcile
 *                  on device reconnect to safely push missing employees without
 *                  risking deletion of pre-existing data on shared or newly
 *                  added devices. Defaults to false.
 */
export const reconcileDeviceWithDB = async (deviceId: number, dryRun: boolean = false, pushOnly: boolean = false): Promise<ReconcileReport> => {
    const report: ReconcileReport = {
        deviceId,
        deviceName: '',
        dryRun,
        pushed: [],
        deleted: [],
        protected: [],
        needsEnrollment: [],
        errors: [],
    };

    if (dryRun) {
        console.log(`[Reconcile] 🔍 DRY RUN — no writes will be made to the device.`);
    }

    // 1. Load device config from DB
    const dbDevice = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!dbDevice) throw new Error(`Device ${deviceId} not found in DB`);
    report.deviceName = dbDevice.name;

    // 2. Load all active DB employees
    const dbEmployees = await prisma.employee.findMany({
        where: { zkId: { not: null }, employmentStatus: 'ACTIVE' },
        select: { zkId: true, firstName: true, lastName: true, role: true }
    });
    const dbByZkId = new Map(dbEmployees.map(e => [e.zkId!.toString(), e]));

    await acquireDeviceLock(deviceId);
    const zk = getDriver(dbDevice.ip, dbDevice.port);

    try {
        console.log(`[Reconcile] Connecting to "${dbDevice.name}" (${dbDevice.ip}:${dbDevice.port})...`);
        await connectWithRetry(zk, 2);

        // 3. Get all users currently on device
        const deviceUsers = await zk.getUsers();
        console.log(`[Reconcile] Device has ${deviceUsers.length} users. DB has ${dbEmployees.length} active employees.`);

        // CRITICAL: Trim userId strings — ZKTeco devices often store userId with
        // trailing whitespace (e.g., "2 " instead of "2"). Without trimming,
        // every Map.has() lookup fails and ALL users get re-pushed destructively.
        const deviceByVisibleId = new Map(deviceUsers.map((u: any) => [String(u.userId).trim(), u]));
        // Also build a UID-based lookup for secondary matching
        const deviceByUid = new Map(deviceUsers.map((u: any) => [u.uid as number, u]));

        // ── STEP A: Delete device-only ghost users ──────────────────────────
        // Skipped entirely in pushOnly mode (auto-reconcile) to prevent
        // accidental deletion of pre-existing users on shared or newly added
        // devices. Ghost deletion is only performed during manual reconcile.
        if (pushOnly) {
            console.log(`[Reconcile] ⏩ Push-only mode — skipping ghost user deletion.`);
        } else {
        for (const dUser of deviceUsers) {
            const uid = dUser.uid;
            const visibleId = String(dUser.userId).trim();

            // Skip protected UIDs
            if (PROTECTED_DEVICE_UIDS.includes(uid)) {
                report.protected.push({ uid, name: dUser.name });
                continue;
            }

            // Skip device admins (role > 0) — never auto-delete admin accounts
            if ((dUser.role ?? 0) > 0) {
                report.protected.push({ uid, name: dUser.name });
                console.log(`[Reconcile] ⛔ Skipping admin UID=${uid} ("${dUser.name}") — protected.`);
                continue;
            }

            // Check if this user maps to an active DB employee (trimmed comparison)
            if (!dbByZkId.has(visibleId)) {
                // Ghost user — not in DB.
                if (dryRun) {
                    // Dry-run: record what would be deleted, touch nothing.
                    report.deleted.push({ uid, userId: visibleId, name: dUser.name });
                    console.log(`[Reconcile] 🔍 Would delete ghost UID=${uid} visibleId="${visibleId}" ("${dUser.name}").`);
                } else {
                    // Live run: delete the ghost from the device.
                    console.log(`[Reconcile] 🗑 Deleting ghost user UID=${uid} visibleId="${visibleId}" ("${dUser.name}")...`);
                    try {
                        await zk.clearUserFingerprints(uid);
                        await zk.deleteUser(uid);
                        report.deleted.push({ uid, userId: visibleId, name: dUser.name });
                        console.log(`[Reconcile] ✓ Deleted ghost UID=${uid}.`);
                    } catch (err: any) {
                        const msg = `Failed to delete UID=${uid}: ${zkErrMsg(err)}`;
                        report.errors.push(msg);
                        console.error(`[Reconcile] ✗ ${msg}`);
                    }
                }
            }
        }
        } // end if (!pushOnly)

        // ── STEP B: Push DB-only employees to device ────────────────────────
        for (const emp of dbEmployees) {
            const zkId = emp.zkId!;
            const visibleId = zkId.toString();
            const fullName = `${emp.firstName} ${emp.lastName}`;
            const deviceRole = emp.role === 'ADMIN' ? 14 : 0;

            if (PROTECTED_DEVICE_UIDS.includes(zkId)) continue;

            // Check by trimmed visibleId first, then by UID as fallback.
            // This prevents false "not on device" when the string has trailing spaces
            // or the user was written with a different visibleId format.
            const existsOnDevice = deviceByVisibleId.has(visibleId) || deviceByUid.has(zkId);

            if (!existsOnDevice) {
                // Employee in DB but genuinely not on device.
                if (dryRun) {
                    // Dry-run: record what would be pushed, touch nothing.
                    report.pushed.push({ zkId, name: fullName });
                    report.needsEnrollment.push({ zkId, name: fullName });
                    console.log(`[Reconcile] 🔍 Would push "${fullName}" (zkId=${zkId}) to device.`);
                } else {
                    // Live run: write the employee to the device.
                    // SAFE: Use setUser() only — NEVER deleteUser() or clearUserFingerprints()
                    // before pushing. This preserves any existing fingerprint data if the
                    // user somehow exists at a different UID or the lookup missed them.
                    console.log(`[Reconcile] ➕ Pushing "${fullName}" (zkId=${zkId}) to device...`);
                    try {
                        await zk.setUser(zkId, fullName, "", deviceRole, 0, visibleId);
                        report.pushed.push({ zkId, name: fullName });
                        // Newly pushed user has no fingerprints yet
                        report.needsEnrollment.push({ zkId, name: fullName });
                        console.log(`[Reconcile] ✓ Pushed "${fullName}" to UID=${zkId}.`);
                    } catch (err: any) {
                        const msg = `Failed to push "${fullName}": ${zkErrMsg(err)}`;
                        report.errors.push(msg);
                        console.error(`[Reconcile] ✗ ${msg}`);
                    }
                }
            } else {
                // User exists on device — check finger count
                const dUser = deviceByVisibleId.get(visibleId) ?? deviceByUid.get(zkId);
                try {
                    const fingerCount = await zk.getFingerCount(dUser.uid);
                    if (fingerCount === 0) {
                        report.needsEnrollment.push({ zkId, name: fullName });
                        console.log(`[Reconcile] ⚠ "${fullName}" (UID=${dUser.uid}) has 0 fingerprints — needs enrollment.`);
                    }
                } catch {
                    // getFingerCount is best-effort; non-critical
                }
            }
        }

        // Skip refresh and isActive update in dry-run — the device state was not changed
        if (!dryRun) {
            await zk.refreshData();
            await prisma.device.update({ where: { id: deviceId }, data: { isActive: true, updatedAt: new Date() } });
        }

        const mode = dryRun ? 'DRY RUN preview' : 'Live run';
        console.log(`[Reconcile] ✅ ${mode} complete. Pushed: ${report.pushed.length}, Deleted: ${report.deleted.length}, Needs enrollment: ${report.needsEnrollment.length}, Protected: ${report.protected.length}`);

        return report;

    } catch (error: any) {
        const msg = zkErrMsg(error);
        console.error(`[Reconcile] Fatal error: ${msg}`);
        // Mark device offline
        await prisma.device.update({ where: { id: deviceId }, data: { isActive: false, updatedAt: new Date() } }).catch(() => { });
        throw new Error(`Reconcile failed: ${msg}`);
    } finally {
        try { await zk.disconnect(); } catch { /* ignore */ }
        releaseDeviceLock(deviceId);
    }
};

/**
 * Sync the clock of ALL active devices to the server's PHT time.
 * Called by the cron job every hour — no attendance data is touched.
 */
export const syncAllDeviceClocks = async (): Promise<void> => {
    const activeDevices = await prisma.device.findMany({
        where: { isActive: true, syncEnabled: true }
    });

    if (activeDevices.length === 0) {
        console.log('[ClockSync] No active devices found.');
        return;
    }

    console.log(`[ClockSync] Syncing time on ${activeDevices.length} device(s)...`);

    for (const device of activeDevices) {
        // Use non-blocking lock — skip this device if already busy with attendance sync or enrollment
        if (!tryAcquireDeviceLock(device.id)) {
            console.warn(`[ClockSync] Skipping "${device.name}" — device busy.`);
            continue;
        }
        try {
            const zk = getDriver(device.ip, device.port || 4370);
            await zk.connect();
            try {
                const nowUTC = new Date();
                await zk.setTime(nowUTC);
                console.log(`[ClockSync] ✓ "${device.name}" (${device.ip}) — time set to PHT`);
            } finally {
                await zk.disconnect();
            }
        } catch (err: any) {
            console.warn(`[ClockSync] ✗ "${device.name}" (${device.ip}) — failed: ${err.message}`);
        } finally {
            releaseDeviceLock(device.id);
        }
    }

    console.log('[ClockSync] Done.');
};

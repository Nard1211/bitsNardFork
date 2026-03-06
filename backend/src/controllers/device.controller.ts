import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { ZKDriver } from '../lib/zk-driver';

/** Unwrap node-zklib's ZKError: { err: Error, ip, command } → readable string */
function zkErrMsg(err: any): string {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    if (err.err instanceof Error) return `${err.command || 'ZK'}: ${err.err.message}`;
    if (err.message) return err.message;
    return String(err);
}

// ─── GET /api/devices ────────────────────────────────────────────────────────
export const getAllDevices = async (req: Request, res: Response) => {
    try {
        const devices = await prisma.device.findMany({
            orderBy: { createdAt: 'asc' },
        });
        res.json({ success: true, devices });
    } catch (error: any) {
        console.error('[Devices] Error fetching devices:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch devices', error: error.message });
    }
};

// ─── POST /api/devices ───────────────────────────────────────────────────────
export const createDevice = async (req: Request, res: Response) => {
    try {
        const { name, ip, port = 4370, location } = req.body;

        if (!name?.trim()) {
            return res.status(400).json({ success: false, message: 'Device name is required' });
        }
        if (!ip?.trim()) {
            return res.status(400).json({ success: false, message: 'IP address is required' });
        }

        const existing = await prisma.device.findUnique({ where: { ip: ip.trim() } });
        if (existing) {
            return res.status(409).json({ success: false, message: `A device with IP ${ip} already exists` });
        }

        const device = await prisma.device.create({
            data: {
                name: name.trim(),
                ip: ip.trim(),
                port: Number(port),
                location: location?.trim() || null,
                isActive: false, // Unknown until tested
                updatedAt: new Date(),
            }
        });

        console.log(`[Devices] Created device "${device.name}" (${device.ip}:${device.port})`);
        res.status(201).json({ success: true, message: `Device "${device.name}" added successfully`, device });
    } catch (error: any) {
        console.error('[Devices] Error creating device:', error);
        res.status(500).json({ success: false, message: 'Failed to create device', error: error.message });
    }
};

// ─── PUT /api/devices/:id ────────────────────────────────────────────────────
export const updateDevice = async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id));
        const { name, ip, port, location } = req.body;

        const existing = await prisma.device.findUnique({ where: { id } });
        if (!existing) {
            return res.status(404).json({ success: false, message: 'Device not found' });
        }

        // Check if IP is being changed to one that's already in use
        if (ip && ip.trim() !== existing.ip) {
            const conflict = await prisma.device.findUnique({ where: { ip: ip.trim() } });
            if (conflict) {
                return res.status(409).json({ success: false, message: `A device with IP ${ip} already exists` });
            }
        }

        const device = await prisma.device.update({
            where: { id },
            data: {
                name: name?.trim() ?? existing.name,
                ip: ip?.trim() ?? existing.ip,
                port: port ? Number(port) : existing.port,
                location: location !== undefined ? (location?.trim() || null) : existing.location,
                isActive: false, // Reset status since config changed — must re-test
                updatedAt: new Date(),
            }
        });

        console.log(`[Devices] Updated device ID ${id}: "${device.name}" (${device.ip}:${device.port})`);
        res.json({ success: true, message: `Device "${device.name}" updated. Please test the connection.`, device });
    } catch (error: any) {
        console.error('[Devices] Error updating device:', error);
        res.status(500).json({ success: false, message: 'Failed to update device', error: error.message });
    }
};

// ─── DELETE /api/devices/:id ─────────────────────────────────────────────────
export const deleteDevice = async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id));

        const existing = await prisma.device.findUnique({ where: { id } });
        if (!existing) {
            return res.status(404).json({ success: false, message: 'Device not found' });
        }

        await prisma.device.delete({ where: { id } });

        console.log(`[Devices] Deleted device ID ${id}: "${existing.name}"`);
        res.json({ success: true, message: `Device "${existing.name}" removed successfully` });
    } catch (error: any) {
        console.error('[Devices] Error deleting device:', error);
        res.status(500).json({ success: false, message: 'Failed to delete device', error: error.message });
    }
};

// ─── POST /api/devices/:id/test ──────────────────────────────────────────────
// Tests the TCP connection to the ZKTeco device, retrieves its info,
// and updates isActive in the database based on whether it succeeded.
export const testDeviceConnection = async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id));

    try {
        const device = await prisma.device.findUnique({ where: { id } });
        if (!device) {
            return res.status(404).json({ success: false, message: 'Device not found' });
        }

        console.log(`[Devices] Testing connection to "${device.name}" at ${device.ip}:${device.port}...`);

        const timeout = Number(process.env.ZK_TIMEOUT) || 10000;
        const zk = new ZKDriver(device.ip, device.port, timeout);

        let connected = false;
        let info: any = null;
        let userCount = 0;

        try {
            await zk.connect();
            connected = true;

            // Gather device info
            try {
                info = await zk.getInfo();
            } catch {
                // Info retrieval is best-effort
            }

            // Count enrolled users
            try {
                const users = await zk.getUsers();
                userCount = users.length;
            } catch {
                // User count is best-effort
            }

        } finally {
            try { await zk.disconnect(); } catch { /* ignore */ }
        }

        // Update isActive based on test result
        await prisma.device.update({
            where: { id },
            data: { isActive: connected, updatedAt: new Date() }
        });

        if (connected) {
            console.log(`[Devices] ✓ "${device.name}" is ONLINE. Users: ${userCount}`);
            return res.json({
                success: true,
                message: `Device is online and responding`,
                info: {
                    serialNumber: info?.serialNumber || 'N/A',
                    userCount,
                    logCount: info?.logCounts ?? 'N/A',
                    logCapacity: info?.logCapacity ?? 'N/A',
                }
            });
        }

        // Should not reach here — connect() throws on failure
        await prisma.device.update({ where: { id }, data: { isActive: false, updatedAt: new Date() } });
        return res.status(502).json({ success: false, message: 'Device unreachable' });

    } catch (error: any) {
        // ZKError has shape { err: Error, ip, command } — extract inner message
        const msg = zkErrMsg(error);
        console.error(`[Devices] Connection test failed for device ${id}: ${msg}`);

        // Mark device as offline
        await prisma.device.update({
            where: { id },
            data: { isActive: false, updatedAt: new Date() }
        }).catch(() => { /* ignore if device was deleted */ });

        // Check if it's a network/timeout error (ZKError wraps it in .err)
        const innerErr = error?.err;
        const isNetworkError =
            error.code === 'ETIMEDOUT' ||
            error.code === 'ECONNREFUSED' ||
            error.code === 'ENOTFOUND' ||
            innerErr?.code === 'ETIMEDOUT' ||
            innerErr?.code === 'ECONNREFUSED' ||
            msg.toLowerCase().includes('timeout') ||
            msg.toLowerCase().includes('econnrefused') ||
            msg.toLowerCase().includes('enotfound') ||
            msg.toLowerCase().includes('connect');

        return res.json({
            success: false,
            message: isNetworkError
                ? `Device is offline or unreachable — ensure it's powered on and connected to the same network`
                : `Device error: ${msg}`
        });
    }
};

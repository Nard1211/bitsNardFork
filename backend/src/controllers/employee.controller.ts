import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { syncEmployeesToDevice, enrollEmployeeFingerprint, addUserToDevice, deleteUserFromDevice } from '../services/zkServices';

// GET /api/employees - Get all employees
export const getAllEmployees = async (req: Request, res: Response) => {
    try {
        const employees = await prisma.employee.findMany({
            select: {
                id: true,
                zkId: true,
                employeeNumber: true,
                firstName: true,
                lastName: true,
                email: true,
                role: true,
                department: true,
                departmentId: true,
                Department: { select: { name: true } },
                position: true,
                branch: true,
                contactNumber: true,
                hireDate: true,
                employmentStatus: true,
                createdAt: true,
            },
            // Order by ZK ID ascending
            orderBy: {
                zkId: 'asc',
            },
        });

        // Define role priority weights (Lower number = Higher priority)
        const roleWeights: { [key: string]: number } = {
            'ADMIN': 1,
            'HR': 2,
            'USER': 3
        };

        // Sort employees based on role weight
        const sortedEmployees = employees.sort((a, b) => {
            const weightA = roleWeights[a.role] || 99; // Default to high number if unknown
            const weightB = roleWeights[b.role] || 99;
            return weightA - weightB;
        });

        res.json({
            success: true,
            employees: employees,
        });
    } catch (error) {
        console.error('Error fetching employees:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch employees',
        });
    }
};

// POST /api/employees/sync-to-device - Sync all employees to device
export const syncEmployeesToDeviceController = async (req: Request, res: Response) => {
    try {
        console.log('[API] Request to sync all employees to device...');
        const result = await syncEmployeesToDevice();

        if (result.success) {
            res.json({
                success: true,
                message: result.message,
                count: result.count
            });
        } else {
            res.status(500).json({
                success: false,
                message: result.message || 'Sync failed',
                error: result.error
            });
        }
    } catch (error: any) {
        console.error('Error syncing employees:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to sync employees',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
};

// DELETE /api/employees/:id - Soft delete employee
export const deleteEmployee = async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const employeeId = parseInt(id);

        if (isNaN(employeeId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid employee ID',
            });
        }

        // Check if employee exists
        const employee = await prisma.employee.findUnique({
            where: { id: employeeId },
            select: { id: true, firstName: true, lastName: true, employmentStatus: true, zkId: true },
        });

        if (!employee) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found',
            });
        }

        // Delete from ZK Device if zkId exists
        if (employee.zkId) {
            try {
                await deleteUserFromDevice(employee.zkId);
            } catch (err) {
                console.error(`[API] Failed to delete user ${employee.zkId} from device:`, err);
                // Continue with soft delete even if device delete fails
            }
        }

        // Soft delete: Mark as INACTIVE instead of actually deleting
        const updatedEmployee = await prisma.employee.update({
            where: { id: employeeId },
            data: {
                employmentStatus: 'INACTIVE',
            },
            select: {
                id: true,
                firstName: true,
                lastName: true,
                employmentStatus: true,
            },
        });
        res.json({
            success: true,
            message: `Employee "${employee.firstName} ${employee.lastName}" marked as inactive`,
            employee: updatedEmployee,
        });
    } catch (error) {
        console.error('Error deleting employee:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete employee',
        });
    }
};

// PATCH /api/employees/:id/reactivate - Reactivate inactive employee
export const reactivateEmployee = async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const employeeId = parseInt(id);

        if (isNaN(employeeId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid employee ID',
            });
        }

        // Check if employee exists
        const existingEmployee = await prisma.employee.findUnique({
            where: { id: employeeId },
            select: { id: true, firstName: true, lastName: true, employmentStatus: true },
        });

        if (!existingEmployee) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found',
            });
        }

        if (existingEmployee.employmentStatus === 'ACTIVE') {
            return res.status(400).json({
                success: false,
                message: 'Employee is already active',
            });
        }

        const updatedEmployee = await prisma.employee.update({
            where: { id: employeeId },
            data: {
                employmentStatus: 'ACTIVE',
            },
            select: {
                id: true,
                firstName: true,
                lastName: true,
                employmentStatus: true,
            },
        });

        res.json({
            success: true,
            message: `Employee "${updatedEmployee.firstName} ${updatedEmployee.lastName}" reactivated`,
            employee: updatedEmployee,
        });
    } catch (error: any) {
        console.error('Error reactivating employee:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reactivate employee',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
        });
    }
};

// POST /api/employees - Create new employee
export const createEmployee = async (req: Request, res: Response) => {
    try {
        const {
            employeeNumber,
            firstName,
            lastName,
            email,
            role,
            department,
            position,
            branch,
            contactNumber,
            hireDate,
            employmentStatus
        } = req.body;

        // Validate required fields
        if (!firstName || !lastName) {
            return res.status(400).json({
                success: false,
                message: 'First name and Last name are required'
            });
        }

        // Validate email format if provided
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid email format'
            });
        }

        // Validate role
        if (role && !['USER', 'ADMIN', 'HR'].includes(role)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid role. Must be USER, ADMIN, or HR'
            });
        }

        // Validate employment status
        if (employmentStatus && !['ACTIVE', 'INACTIVE', 'TERMINATED'].includes(employmentStatus)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid employment status. Must be ACTIVE, INACTIVE, or TERMINATED'
            });
        }

        // Check for existing employee with same email, employee number
        const existingEmployee = await prisma.employee.findFirst({
            where: {
                OR: [
                    { email: email || undefined },
                    { employeeNumber: employeeNumber || undefined },
                ]
            }
        });

        if (existingEmployee) {
            return res.status(400).json({
                success: false,
                message: 'Employee with this email or employee number already exists'
            });
        }

        // Auto-assign zkId: find the next available zkId
        // NOTE: zkId 1 is reserved for admin, start from 2 for regular employees
        const maxZkIdEmployee = await prisma.employee.findFirst({
            where: {
                zkId: { not: null }
            },
            orderBy: {
                zkId: 'desc'
            },
            select: {
                zkId: true
            }
        });
        // Start from zkId 2 (skip 1 for admin), or increment from max
        // SAFETY: zkId 1 is ALWAYS reserved for the device SUPER ADMIN — never assign it
        let nextZkId = maxZkIdEmployee?.zkId ? maxZkIdEmployee.zkId + 1 : 2;
        if (nextZkId <= 1) nextZkId = 2;

        // Create employee
        const newEmployee = await prisma.employee.create({
            data: {
                employeeNumber,
                firstName,
                lastName,
                email,
                role: role || 'USER',
                department,
                position,
                branch,
                contactNumber,
                hireDate: hireDate ? new Date(hireDate) : undefined,
                employmentStatus: employmentStatus || 'ACTIVE',
                zkId: nextZkId,
                updatedAt: new Date()
            },
            select: {
                id: true,
                zkId: true,
                employeeNumber: true,
                firstName: true,
                lastName: true,
                email: true,
                role: true,
                department: true,
                position: true,
                branch: true,
                contactNumber: true,
                hireDate: true,
                employmentStatus: true,
                createdAt: true,
            }
        });

        console.log(`[API] Created employee: ${newEmployee.firstName} ${newEmployee.lastName} (zkId: ${newEmployee.zkId})`);

        // ── Respond immediately — device sync happens in the background ──────
        // We do NOT await the device call here. The ZKTeco device may take up to
        // 25 s to time out (3 retries × ~8 s each). Holding the HTTP response
        // open that long causes the success toast to never appear on the frontend.
        // Instead, we respond with 201 right away and let the sync run in the
        // background. If it fails, the admin can use the Fingerprint button later.
        res.status(201).json({
            success: true,
            message: 'Employee created successfully.',
            employee: newEmployee,
            deviceSync: { success: null, message: 'Device sync running in background' },
        });

        // Fire-and-forget: sync to biometric device after response is sent
        if (newEmployee.zkId) {
            setImmediate(async () => {
                try {
                    console.log(`[API] (background) Syncing ${newEmployee.firstName} ${newEmployee.lastName} to device...`);
                    const displayName = `${newEmployee.firstName} ${newEmployee.lastName}`;
                    await addUserToDevice(newEmployee.zkId!, displayName, newEmployee.role);
                    console.log(`[API] (background) Device sync OK: ${displayName} (zkId: ${newEmployee.zkId})`);
                } catch (syncErr: any) {
                    console.error(`[API] (background) Device sync failed for zkId ${newEmployee.zkId}:`, syncErr?.message || syncErr);
                }
            });
        }

    } catch (error: any) {
        console.error('Error creating employee:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create employee',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
        });
    }
};

// POST /api/employees/:id/enroll-fingerprint - Enroll fingerprint for employee
export const enrollEmployeeFingerprintController = async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const employeeId = parseInt(id);

        if (isNaN(employeeId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid employee ID',
            });
        }

        // Optional finger index from request body (default: 0 = Right Thumb)
        const body = req.body || {};
        const { fingerIndex } = body;
        const finger = fingerIndex !== undefined ? parseInt(fingerIndex) : 0;

        if (finger < 0 || finger > 9) {
            return res.status(400).json({
                success: false,
                message: 'Finger index must be between 0 and 9',
            });
        }

        console.log(`[API] Starting fingerprint enrollment for employee ${employeeId} (finger: ${finger})...`);

        // ── Respond immediately — enrollment happens in the background ─────────
        // enrollEmployeeFingerprint connects to the device and awaits physical
        // scans, which can take 25+ seconds. Holding the HTTP response open
        // causes the Enroll button to appear frozen. We return 202 right away
        // so the frontend can show feedback instantly.
        res.status(202).json({
            success: true,
            message: 'Fingerprint enrollment started — please have the employee scan their finger on the device now.',
        });

        // Fire-and-forget: run the actual enrollment after response is sent
        setImmediate(async () => {
            try {
                const result = await enrollEmployeeFingerprint(employeeId, finger);
                if (result.success) {
                    console.log(`[API] (background) Enrollment success for employee ${employeeId}: ${result.message}`);
                } else {
                    console.error(`[API] (background) Enrollment failed for employee ${employeeId}: ${result.message}`);
                }
            } catch (enrollErr: any) {
                console.error(`[API] (background) Enrollment error for employee ${employeeId}:`, enrollErr?.message || enrollErr);
            }
        });

    } catch (error: any) {
        console.error('Error enrolling fingerprint:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to enroll fingerprint',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
};

// PUT /api/employees/:id - Update an employee's details
export const updateEmployee = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const employeeId = parseInt(id as string, 10);

        if (isNaN(employeeId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid employee ID format',
            });
        }

        const {
            firstName,
            lastName,
            email,
            contactNumber,
            position,
            departmentId,
            branch,
            employmentStatus
        } = req.body;

        // Check if employee exists
        const existingEmployee = await prisma.employee.findUnique({
            where: { id: employeeId },
        });

        if (!existingEmployee) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found',
            });
        }

        // Prepare data for update
        const updateData: any = {};
        if (firstName !== undefined) updateData.firstName = firstName;
        if (lastName !== undefined) updateData.lastName = lastName;
        if (email !== undefined) updateData.email = email === '' ? null : email;
        if (contactNumber !== undefined) updateData.contactNumber = contactNumber;
        if (position !== undefined) updateData.position = position;
        if (departmentId !== undefined) {
            updateData.departmentId = departmentId ? parseInt(departmentId, 10) : null;
        }
        if (branch !== undefined) updateData.branch = branch;
        if (employmentStatus !== undefined && ['ACTIVE', 'INACTIVE', 'TERMINATED'].includes(employmentStatus)) {
            updateData.employmentStatus = employmentStatus;
        }

        updateData.updatedAt = new Date();

        // Update the employee
        const updatedEmployee = await prisma.employee.update({
            where: { id: employeeId },
            data: updateData,
            select: {
                id: true,
                zkId: true,
                employeeNumber: true,
                firstName: true,
                lastName: true,
                email: true,
                role: true,
                Department: { select: { name: true } },
                departmentId: true,
                position: true,
                branch: true,
                contactNumber: true,
                hireDate: true,
                employmentStatus: true,
                createdAt: true,
                updatedAt: true
            },
        });

        res.json({
            success: true,
            message: 'Employee updated successfully',
            employee: updatedEmployee,
        });

    } catch (error: any) {
        console.error('Error updating employee:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update employee',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
};

// DELETE /api/employees/:id/permanent - Permanently delete an inactive employee
export const permanentDeleteEmployee = async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const employeeId = parseInt(id);

        if (isNaN(employeeId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid employee ID',
            });
        }

        // Check if employee exists
        const employee = await prisma.employee.findUnique({
            where: { id: employeeId },
            select: { id: true, firstName: true, lastName: true, employmentStatus: true, zkId: true, role: true, email: true },
        });

        if (!employee) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found',
            });
        }

        // Prevent deleting the main admin account
        if (employee.email === 'admin@avegabros.com') {
            return res.status(403).json({
                success: false,
                message: 'Permanent deletion of the main admin account is protected.',
            });
        }

        // Only allow permanent deletion of inactive users
        if (employee.employmentStatus === 'ACTIVE') {
            return res.status(400).json({
                success: false,
                message: 'Cannot permanently delete an active user. Please deactivate them first.',
            });
        }

        // ── DB delete first — device removal is fire-and-forget ────────────
        // We must NOT await deleteUserFromDevice before the transaction.
        // If the device is offline it retries for up to 25 s, causing the
        // permanent delete to appear to fail. The DB is the source of truth.
        // Delete from DB unconditionally; remove from device in the background.
        await prisma.$transaction(async (tx) => {
            await tx.attendanceLog.deleteMany({ where: { employeeId } });
            await tx.attendance.deleteMany({ where: { employeeId } });
            await tx.employee.delete({ where: { id: employeeId } });
        });

        res.json({
            success: true,
            message: `User "${employee.firstName} ${employee.lastName}" permanently deleted`,
        });

        // Fire-and-forget: remove from biometric device after DB is clean
        if (employee.zkId) {
            setImmediate(async () => {
                try {
                    await deleteUserFromDevice(employee.zkId!);
                    console.log(`[API] (background) Removed zkId ${employee.zkId} from device.`);
                } catch (devErr: any) {
                    console.error(`[API] (background) Could not remove zkId ${employee.zkId} from device (user already removed from DB):`, devErr?.message || devErr);
                }
            });
        }
    } catch (error) {
        console.error('Error permanently deleting employee:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to permanently delete employee',
        });
    }
};
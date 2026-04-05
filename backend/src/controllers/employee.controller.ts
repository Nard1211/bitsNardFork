import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { syncEmployeesToDevice, enrollEmployeeFingerprint, enrollEmployeeCard, addUserToDevice, deleteUserFromDevice, findNextSafeZkId, acquireRegistrationMutex } from '../services/zkServices';
import { audit } from '../lib/auditLogger';
import bcrypt from 'bcryptjs';
import { generateRandomPassword } from '../utils/password.utils';
import { sendWelcomeEmail, sendPasswordResetEmail } from '../services/email.service';
import { validateEmployeeId } from '../utils/employeeValidation';

// GET /api/employees - Get all employees
export const getAllEmployees = async (req: Request, res: Response) => {
    try {
        const employees = await prisma.employee.findMany({
            select: {
                id: true,
                zkId: true,
                cardNumber: true,
                employeeNumber: true,
                firstName: true,
                lastName: true,
                middleName: true,
                suffix: true,
                gender: true,
                dateOfBirth: true,
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
                shiftId: true,
                Shift: { select: { id: true, name: true, shiftCode: true, startTime: true, endTime: true, workDays: true, halfDays: true, graceMinutes: true, breakMinutes: true } },
                createdAt: true, EmployeeDeviceEnrollment: {
                    select: {
                        enrolledAt: true,
                        device: {
                            select: {
                                id: true,
                                name: true,
                                location: true,
                                isActive: true,
                            },
                        },
                    },
                },
            },
            orderBy: [
                { role: 'asc' },
                { zkId: 'asc' },
            ],
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

        await audit({
            action: 'STATUS_CHANGE',
            entityType: 'Employee',
            entityId: employeeId,
            performedBy: req.user?.employeeId,
            details: `Employee ${employee.firstName} ${employee.lastName} deactivated`,
            metadata: { category: 'employee', previousStatus: employee.employmentStatus, newStatus: 'INACTIVE' }
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

        await audit({
            action: 'STATUS_CHANGE',
            entityType: 'Employee',
            entityId: employeeId,
            performedBy: req.user?.employeeId,
            details: `Employee ${updatedEmployee.firstName} ${updatedEmployee.lastName} reactivated`,
            metadata: { category: 'employee', previousStatus: existingEmployee.employmentStatus, newStatus: 'ACTIVE' }
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
            middleName,
            suffix,
            gender,
            dateOfBirth,
            email,
            role,
            department,
            position,
            branch,
            contactNumber,
            hireDate,
            employmentStatus,
            shiftId
        } = req.body;

        // Validate Employee ID
        const empIdValidation = validateEmployeeId(employeeNumber);
        if (!empIdValidation.isValid) {
            return res.status(400).json({
                success: false,
                message: empIdValidation.error
            });
        }

        // Validate required fields
        if (!firstName || !lastName) {
            return res.status(400).json({
                success: false,
                message: 'First name and Last name are required'
            });
        }

        // Validate email format and require it
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({
                success: false,
                message: 'A valid email is required to receive login credentials'
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
            const duplicateField = existingEmployee.email === email ? 'email address' : 'employee number';
            await audit({
                action: 'CREATE',
                level: 'WARN',
                entityType: 'Employee',
                performedBy: req.user?.employeeId,
                details: `Failed to create employee: duplicate ${duplicateField}`,
                metadata: { category: 'employee', email, employeeNumber }
            });

            return res.status(400).json({
                success: false,
                message: `This ${duplicateField} is already in use by another employee`
            });
        }

        // ── Acquire registration mutex before zkId assignment ─────────────────────
        // findNextSafeZkId() + prisma.employee.create() must run as an atomic unit.
        // Without this mutex, two simultaneous POST /api/employees requests both call
        // findNextSafeZkId() before either has written to the DB, both receive the
        // same integer, and one of the prisma.employee.create() calls fails with a
        // P2002 unique constraint violation on Employee.zkId.
        const release = await acquireRegistrationMutex();
        let newEmployee;
        const generatedPassword = generateRandomPassword(10);
        const hashedPassword = await bcrypt.hash(generatedPassword, 10);

        try {
            const nextZkId = await findNextSafeZkId();

            newEmployee = await prisma.employee.create({
                data: {
                    employeeNumber: employeeNumber.trim(),
                    firstName,
                    lastName,
                    middleName: middleName || null,
                    suffix: suffix || null,
                    gender: gender || null,
                    dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
                    email,
                    password: hashedPassword,
                    role: role || 'USER',
                    department,
                    position,
                    branch,
                    contactNumber,
                    hireDate: hireDate ? new Date(hireDate) : undefined,
                    employmentStatus: employmentStatus || 'ACTIVE',
                    zkId: nextZkId,
                    shiftId: shiftId ? parseInt(shiftId, 10) : null,
                    needsPasswordChange: true,
                    updatedAt: new Date()
                },
                select: {
                    id: true,
                    zkId: true,
                    employeeNumber: true,
                    firstName: true,
                    lastName: true,
                    middleName: true,
                    suffix: true,
                    gender: true,
                    dateOfBirth: true,
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
        } finally {
            // Always release — even on error — to prevent deadlocking future registrations
            release();
        }

        // Guard: if the mutex block threw, the outer try/catch handles it
        if (!newEmployee) {
            return res.status(500).json({
                success: false,
                message: 'Failed to create employee — unexpected state after registration.',
            });
        }

        console.log(`[API] Created employee: ${newEmployee.firstName} ${newEmployee.lastName} (zkId: ${newEmployee.zkId})`);

        await audit({
            action: 'CREATE',
            entityType: 'Employee',
            entityId: newEmployee.id,
            performedBy: req.user?.employeeId,
            details: `Created employee ${newEmployee.firstName} ${newEmployee.lastName}`,
            metadata: { category: 'employee', email, role: newEmployee.role, department, employeeNumber }
        });

        // ── Respond immediately — device sync happens in the background ──────
        // We do NOT await the device call here. The ZKTeco device may take up to
        // 25 s to time out (3 retries × ~8 s each). Holding the HTTP response
        // open that long causes the success toast to never appear on the frontend.
        // Instead, we respond with 201 right away and let the sync run in the
        // background. If it fails, the admin can use the Fingerprint button later.
        res.status(201).json({
            success: true,
            message: 'Employee created and credentials sent via email.',
            employee: newEmployee,
            deviceSync: { success: null, message: 'Device sync running in background' },
        });

        // Fire-and-forget: sync to biometric device and send email
        setImmediate(async () => {
            // Send welcome email
            if (email) {
                try {
                    await sendWelcomeEmail(email, `${firstName} ${lastName}`, generatedPassword);
                } catch (emailErr) {
                    console.error(`[API] (background) Failed to send welcome email to ${email}:`, emailErr);
                }
            }

            // Sync device
            if (newEmployee.zkId) {
                try {
                    console.log(`[API] (background) Syncing ${newEmployee.firstName} ${newEmployee.lastName} to device...`);
                    const displayName = `${newEmployee.firstName} ${newEmployee.lastName}`;
                    await addUserToDevice(newEmployee.zkId!, displayName, newEmployee.role);
                    console.log(`[API] (background) Device sync OK: ${displayName} (zkId: ${newEmployee.zkId})`);
                } catch (syncErr: any) {
                    console.error(`[API] (background) Device sync failed for zkId ${newEmployee.zkId}:`, syncErr?.message || syncErr);
                }
            }
        });

    } catch (error: any) {
        console.error('Error creating employee:', error);

        await audit({
            action: 'CREATE',
            level: 'ERROR',
            entityType: 'Employee',
            performedBy: req.user?.employeeId,
            details: `Failed to create employee due to server error: ${error.message}`,
            metadata: { category: 'employee', error: error.message }
        });

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

        const body = req.body || {};
        const { fingerIndex, deviceId } = body;

        const finger = fingerIndex !== undefined ? parseInt(fingerIndex) : 5;

        if (finger < 0 || finger > 9) {
            return res.status(400).json({
                success: false,
                message: 'Finger index must be between 0 and 9',
            });
        }

        const device = deviceId ? parseInt(deviceId) : undefined;

        console.log(`[API] Starting fingerprint enrollment for employee ${employeeId} (finger: ${finger}, device: ${device ?? 'auto'})...`);

        const result = await enrollEmployeeFingerprint(employeeId, finger, device);

        if (result.success) {
            const emp = await prisma.employee.findUnique({
                where: { id: employeeId },
                select: { firstName: true, lastName: true, zkId: true }
            });

            await audit({
                action: 'UPDATE',
                entityType: 'Employee',
                entityId: employeeId,
                performedBy: req.user?.employeeId,
                details: `Triggered fingerprint enrollment on device for ${emp?.firstName} ${emp?.lastName} (Finger ${finger})`,
                metadata: { category: 'employee', deviceId: device, fingerIndex: finger, zkId: emp?.zkId }
            });

            return res.status(200).json({
                success: true,
                message: result.message,
            });
        } else {
            const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { firstName: true, lastName: true } });

            await audit({
                action: 'UPDATE',
                level: 'ERROR',
                entityType: 'Employee',
                entityId: employeeId,
                performedBy: req.user?.employeeId,
                details: `Failed to enroll fingerprint for ${emp?.firstName} ${emp?.lastName} (Finger ${finger}): ${result.message}`,
                metadata: { category: 'employee', deviceId: device, fingerIndex: finger, error: result.error || result.message }
            });

            return res.status(500).json({
                success: false,
                message: result.message || 'Enrollment failed',
                error: result.error,
            });
        }

    } catch (error: any) {
        console.error('[API] Enrollment error:', error);

        const empId = req.params.id ? parseInt(req.params.id as string) : undefined;
        await audit({
            action: 'UPDATE',
            level: 'ERROR',
            entityType: 'Employee',
            entityId: isNaN(empId as number) ? undefined : empId,
            performedBy: req.user?.employeeId,
            details: `Exception while starting fingerprint enrollment: ${error.message}`,
            metadata: { category: 'employee', error: error.message, body: req.body }
        });

        return res.status(500).json({
            success: false,
            message: 'Failed to start enrollment',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// POST /api/employees/:id/enroll-card - Enroll RFID badge card for employee
export const enrollEmployeeCardController = async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const employeeId = parseInt(id);

        if (isNaN(employeeId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid employee ID',
            });
        }

        const body = req.body || {};
        const cardNumber = parseInt(body.cardNumber);

        if (isNaN(cardNumber) || cardNumber < 1 || cardNumber > 4294967295) {
            return res.status(400).json({
                success: false,
                message: 'Card number must be a valid uint32 (1–4294967295)',
            });
        }

        console.log(`[API] Starting RFID card enrollment for employee ${employeeId}, card ${cardNumber}...`);

        const result = await enrollEmployeeCard(employeeId, cardNumber);

        if (result.success) {
            const emp = await prisma.employee.findUnique({
                where: { id: employeeId },
                select: { firstName: true, lastName: true, zkId: true }
            });

            await audit({
                action: 'UPDATE',
                entityType: 'Employee',
                entityId: employeeId,
                performedBy: req.user?.employeeId,
                details: `Enrolled RFID badge #${cardNumber} for ${emp?.firstName} ${emp?.lastName}`,
                metadata: { cardNumber, zkId: emp?.zkId }
            });

            return res.status(200).json({
                success: true,
                message: result.message,
            });
        } else {
            const statusCode = result.error === 'duplicate_card' ? 409 : 500;

            await audit({
                action: 'UPDATE',
                level: 'ERROR',
                entityType: 'Employee',
                entityId: employeeId,
                performedBy: req.user?.employeeId,
                details: `Failed to enroll RFID badge #${cardNumber}: ${result.message}`,
                metadata: { cardNumber, error: result.error || result.message }
            });

            return res.status(statusCode).json({
                success: false,
                message: result.message || 'Card enrollment failed',
                error: result.error,
            });
        }

    } catch (error: any) {
        console.error('[API] Card enrollment error:', error);

        const empId = req.params.id ? parseInt(req.params.id as string) : undefined;
        await audit({
            action: 'UPDATE',
            level: 'ERROR',
            entityType: 'Employee',
            entityId: isNaN(empId as number) ? undefined : empId,
            performedBy: req.user?.employeeId,
            details: `Exception while enrolling RFID badge: ${error.message}`,
            metadata: { error: error.message, body: req.body }
        });

        return res.status(500).json({
            success: false,
            message: 'Failed to enroll RFID badge',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
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
            employeeNumber,
            firstName,
            lastName,
            middleName,
            suffix,
            gender,
            dateOfBirth,
            email,
            contactNumber,
            position,
            department,
            departmentId,
            branch,
            hireDate,
            shiftId,
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

        if (employeeNumber !== undefined) {
            const empIdValidation = validateEmployeeId(employeeNumber);
            if (!empIdValidation.isValid) {
                return res.status(400).json({
                    success: false,
                    message: empIdValidation.error
                });
            }

            if (employeeNumber && employeeNumber !== existingEmployee.employeeNumber) {
                const dup = await prisma.employee.findUnique({ where: { employeeNumber: employeeNumber.trim() } });
                if (dup) {
                    return res.status(400).json({
                        success: false,
                        message: 'Employee ID is already in use by another employee'
                    });
                }
            }
        }

        // Validate email uniqueness (exclude the current employee)
        if (email !== undefined && email !== '' && email !== existingEmployee.email) {
            const emailDup = await prisma.employee.findFirst({
                where: { email, id: { not: employeeId } }
            });
            if (emailDup) {
                return res.status(400).json({
                    success: false,
                    message: 'This email address is already in use by another employee'
                });
            }
        }

        // Prepare data for update
        const updateData: any = {};
        if (employeeNumber !== undefined) updateData.employeeNumber = employeeNumber.trim();
        if (firstName !== undefined) updateData.firstName = firstName;
        if (lastName !== undefined) updateData.lastName = lastName;
        if (middleName !== undefined) updateData.middleName = middleName || null;
        if (suffix !== undefined) updateData.suffix = suffix || null;
        if (gender !== undefined) updateData.gender = gender || null;
        if (dateOfBirth !== undefined) updateData.dateOfBirth = dateOfBirth ? new Date(dateOfBirth) : null;
        if (email !== undefined) updateData.email = email === '' ? null : email;
        if (contactNumber !== undefined) updateData.contactNumber = contactNumber;
        if (position !== undefined) updateData.position = position;
        if (department !== undefined) updateData.department = department || null;
        if (departmentId !== undefined) {
            updateData.departmentId = departmentId ? parseInt(departmentId, 10) : null;
        }
        if (branch !== undefined) updateData.branch = branch || null;
        if (hireDate !== undefined) updateData.hireDate = hireDate ? new Date(hireDate) : null;
        if (shiftId !== undefined) updateData.shiftId = shiftId ? parseInt(shiftId, 10) : null;
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
                middleName: true,
                suffix: true,
                gender: true,
                dateOfBirth: true,
                email: true,
                role: true,
                department: true,
                Department: { select: { name: true } },
                departmentId: true,
                position: true,
                branch: true,
                contactNumber: true,
                hireDate: true,
                employmentStatus: true,
                shiftId: true,
                Shift: { select: { id: true, name: true, shiftCode: true, startTime: true, endTime: true, workDays: true, halfDays: true, graceMinutes: true, breakMinutes: true } },
                createdAt: true,
                updatedAt: true
            },
        });

        const changes: string[] = [];
        for (const [key, newValue] of Object.entries(updateData)) {
            if (key === 'updatedAt' || key === 'password') continue;
            const oldValue = (existingEmployee as any)[key];
            if (oldValue !== newValue) {
                const oldValStr = oldValue instanceof Date ? oldValue.toISOString().split('T')[0] : (oldValue || 'empty');
                const newValStr = newValue instanceof Date ? newValue.toISOString().split('T')[0] : (newValue || 'empty');
                if (oldValStr !== newValStr) {
                    changes.push(`Updated ${key.replace(/([A-Z])/g, ' $1').toLowerCase().trim()} from "${oldValStr}" to "${newValStr}"`);
                }
            }
        }

        await audit({
            action: 'UPDATE',
            entityType: 'Employee',
            entityId: employeeId,
            performedBy: req.user?.employeeId,
            details: `Updated employee ${updatedEmployee.firstName} ${updatedEmployee.lastName}`,
            metadata: changes.length > 0 ? { category: 'employee', updates: changes } : { category: 'employee' }
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

        await audit({
            action: 'DELETE',
            entityType: 'Employee',
            entityId: employeeId,
            performedBy: req.user?.employeeId,
            details: `Permanently deleted employee ${employee.firstName} ${employee.lastName}`,
            metadata: { category: 'employee', email: employee.email, role: employee.role }
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

// POST /api/employees/:id/reset-password - HR/Admin initiated password reset
export const resetEmployeePassword = async (req: Request, res: Response) => {
    try {
        const id = req.params.id as string;
        const employeeId = parseInt(id);

        if (isNaN(employeeId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid employee ID',
            });
        }

        // Check if employee exists and has an email
        const employee = await prisma.employee.findUnique({
            where: { id: employeeId },
            select: { id: true, firstName: true, lastName: true, email: true },
        });

        if (!employee) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found',
            });
        }

        if (!employee.email) {
            return res.status(400).json({
                success: false,
                message: 'Employee does not have an email address configured',
            });
        }

        const generatedPassword = generateRandomPassword(10);
        const hashedPassword = await bcrypt.hash(generatedPassword, 10);

        // Update DB
        await prisma.employee.update({
            where: { id: employeeId },
            data: {
                password: hashedPassword,
                needsPasswordChange: true,
                updatedAt: new Date()
            }
        });

        // Send email
        const emailSent = await sendPasswordResetEmail(
            employee.email,
            `${employee.firstName} ${employee.lastName}`,
            generatedPassword
        );

        if (!emailSent) {
            return res.status(200).json({
                success: true,
                message: "Password reset in database, but failed to send email. The temporary password is: " + generatedPassword,
            });
        }

        res.json({
            success: true,
            message: `Password reset successfully. Email sent to ${employee.email}.`,
        });

    } catch (error: any) {
        console.error('Error resetting password:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reset password',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

// GET /api/employees/check-email?email=...&excludeId=...
export const checkEmailAvailability = async (req: Request, res: Response) => {
    try {
        const { email, excludeId } = req.query;

        if (!email || typeof email !== 'string') {
            return res.status(400).json({ success: false, message: 'Email is required' });
        }

        const where: any = { email: email.trim().toLowerCase() };
        if (excludeId) {
            where.id = { not: parseInt(excludeId as string, 10) };
        }

        const existing = await prisma.employee.findFirst({ where });

        res.json({
            success: true,
            available: !existing,
        });
    } catch (error: any) {
        console.error('Error checking email:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check email availability',
        });
    }
};

// POST /api/employees/import - Bulk import employees from spreadsheet
export const importEmployees = async (req: Request, res: Response) => {
    try {
        const { employees } = req.body;

        if (!Array.isArray(employees) || employees.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'employees must be a non-empty array',
            });
        }

        const imported: Array<{ id: number; firstName: string; lastName: string; email: string | null; employeeNumber: string | null }> = [];
        const errors: Array<{ row: number; data: any; errors: string[] }> = [];

        // Collect all emails and employeeNumbers from the batch for intra-batch duplicate detection
        const batchEmails = new Map<string, number>();
        const batchEmpIds = new Map<string, number>();

        for (let i = 0; i < employees.length; i++) {
            const emp = employees[i];
            const rowNum = i + 1;
            const rowErrors: string[] = [];

            if (!emp.firstName || !emp.firstName.trim()) rowErrors.push('First Name is required');
            if (!emp.lastName || !emp.lastName.trim()) rowErrors.push('Last Name is required');

            const email = emp.email ? String(emp.email).trim() : null;
            if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                rowErrors.push('Invalid email format');
            }

            const employeeNumber = emp.employeeNumber ? String(emp.employeeNumber).trim() : null;
            if (employeeNumber) {
                const empIdValidation = validateEmployeeId(employeeNumber);
                if (!empIdValidation.isValid) {
                    rowErrors.push(empIdValidation.error || 'Invalid Employee Number');
                }
            }

            const role = emp.role || 'USER';
            if (!['USER', 'ADMIN', 'HR'].includes(role)) {
                rowErrors.push('Invalid role. Must be USER, ADMIN, or HR');
            }

            const employmentStatus = emp.employmentStatus || 'ACTIVE';
            if (!['ACTIVE', 'INACTIVE', 'TERMINATED'].includes(employmentStatus)) {
                rowErrors.push('Invalid employment status');
            }

            if (email) {
                const lowerEmail = email.toLowerCase();
                if (batchEmails.has(lowerEmail)) {
                    rowErrors.push(`Duplicate email in batch (also on row ${batchEmails.get(lowerEmail)! + 1})`);
                } else {
                    batchEmails.set(lowerEmail, i);
                }
            }
            if (employeeNumber) {
                if (batchEmpIds.has(employeeNumber)) {
                    rowErrors.push(`Duplicate Employee Number in batch (also on row ${batchEmpIds.get(employeeNumber)! + 1})`);
                } else {
                    batchEmpIds.set(employeeNumber, i);
                }
            }

            if (rowErrors.length > 0) {
                errors.push({ row: i, data: emp, errors: rowErrors });
                continue;
            }

            const existingConditions: any[] = [];
            if (email) existingConditions.push({ email });
            if (employeeNumber) existingConditions.push({ employeeNumber });

            if (existingConditions.length > 0) {
                const existing = await prisma.employee.findFirst({
                    where: { OR: existingConditions },
                    select: { email: true, employeeNumber: true },
                });

                if (existing) {
                    const dupField = existing.email === email ? 'email address' : 'employee number';
                    errors.push({ row: i, data: emp, errors: [`This ${dupField} is already in use by another employee`] });
                    continue;
                }
            }

            const generatedPassword = generateRandomPassword(10);
            const hashedPassword = await bcrypt.hash(generatedPassword, 10);

            try {
                const newEmployee = await prisma.employee.create({
                    data: {
                        firstName: emp.firstName.trim(),
                        lastName: emp.lastName.trim(),
                        middleName: emp.middleName ? String(emp.middleName).trim() : null,
                        suffix: emp.suffix ? String(emp.suffix).trim() : null,
                        gender: emp.gender ? String(emp.gender).trim() : null,
                        dateOfBirth: emp.dateOfBirth ? new Date(emp.dateOfBirth) : null,
                        email: email || null,
                        password: hashedPassword,
                        role: role as any,
                        department: emp.department ? String(emp.department).trim() : null,
                        position: emp.position ? String(emp.position).trim() : null,
                        branch: emp.branch ? String(emp.branch).trim() : null,
                        contactNumber: emp.contactNumber ? String(emp.contactNumber).trim() : null,
                        employeeNumber: employeeNumber || null,
                        hireDate: emp.hireDate ? new Date(emp.hireDate) : null,
                        employmentStatus: employmentStatus as any,
                        zkId: null,
                        shiftId: emp.shiftId ? parseInt(emp.shiftId, 10) : null,
                        needsPasswordChange: true,
                        updatedAt: new Date(),
                    },
                    select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        email: true,
                        employeeNumber: true,
                    },
                });

                imported.push(newEmployee);

                await audit({
                    action: 'IMPORT',
                    entityType: 'Employee',
                    entityId: newEmployee.id,
                    performedBy: req.user?.employeeId,
                    details: `Imported employee ${newEmployee.firstName} ${newEmployee.lastName} via bulk import`,
                    metadata: { category: 'employee', email: newEmployee.email, employeeNumber: newEmployee.employeeNumber },
                });
            } catch (createErr: any) {
                console.error(`[Import] Failed to create employee row ${rowNum}:`, createErr.message);
                errors.push({ row: i, data: emp, errors: [`Database error: ${createErr.message}`] });
            }
        }

        res.status(200).json({
            success: true,
            message: `Import complete: ${imported.length} imported, ${errors.length} failed`,
            imported,
            errors,
        });
    } catch (error: any) {
        console.error('Error importing employees:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to import employees',
            error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
        });
    }
};
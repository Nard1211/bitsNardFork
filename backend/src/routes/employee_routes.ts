import { Router } from 'express';
import {
    getAllEmployees,
    syncEmployeesToDeviceController,
    deleteEmployee,
    reactivateEmployee,
    createEmployee,
    enrollEmployeeFingerprintController,
    enrollEmployeeCardController,
    updateEmployee,
    permanentDeleteEmployee,
    resetEmployeePassword,
    checkEmailAvailability,
    importEmployees
} from '../controllers/employee.controller';
import { authenticate } from '../middleware/auth.middleware';
import { adminOrHR } from '../middleware/role.middleware';
import { validate } from '../middleware/validation.middleware';
import { createEmployeeValidator, employeeQueryValidator, enrollFingerprintValidator, enrollCardValidator, importEmployeesValidator } from '../validators/employee.validator';

const router = Router();

// Apply authentication middleware to all routes
router.use(authenticate);

// Apply role-based authorization to all routes (ADMIN or HR only)
router.use(adminOrHR);

/**
 * @swagger
 * tags:
 *   name: Employees
 *   description: Employee management endpoints
 */

/**
 * @swagger
 * /api/employees:
 *   get:
 *     summary: Get all employees
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Items per page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by name or email
 *     responses:
 *       200:
 *         description: List of employees
 */
router.get('/', validate(employeeQueryValidator), getAllEmployees);

/**
 * @swagger
 * /api/employees:
 *   post:
 *     summary: Create a new employee
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - firstName
 *               - lastName
 *             properties:
 *               firstName:
 *                 type: string
 *               lastName:
 *                 type: string
 *               email:
 *                 type: string
 *               employeeNumber:
 *                 type: string
 *               department:
 *                 type: string
 *               position:
 *                 type: string
 *               branch:
 *                 type: string
 *               role:
 *                 type: string
 *                 enum: [USER, ADMIN, HR]
 *     responses:
 *       201:
 *         description: Employee created successfully
 */
router.post('/', validate(createEmployeeValidator), createEmployee);

/**
 * @swagger
 * /api/employees/import:
 *   post:
 *     summary: Bulk import employees from spreadsheet data
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - employees
 *             properties:
 *               employees:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required:
 *                     - firstName
 *                     - lastName
 *     responses:
 *       200:
 *         description: Import results with successes and errors
 */
router.post('/import', validate(importEmployeesValidator), importEmployees);

/**
 * @swagger
 * /api/employees/import:
 *   post:
 *     summary: Bulk import employees from spreadsheet data
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - employees
 *             properties:
 *               employees:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required:
 *                     - firstName
 *                     - lastName
 *     responses:
 *       200:
 *         description: Import results with successes and errors
 */
router.post('/import', validate(importEmployeesValidator), importEmployees);

/**
 * @swagger
 * /api/employees/check-email:
 *   get:
 *     summary: Check if an email address is already in use
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: email
 *         required: true
 *         schema:
 *           type: string
 *         description: Email address to check
 *       - in: query
 *         name: excludeId
 *         schema:
 *           type: integer
 *         description: Employee ID to exclude (for edit mode)
 *     responses:
 *       200:
 *         description: Returns availability status
 */
router.get('/check-email', checkEmailAvailability);

/**
 * @swagger
 * /api/employees/sync-to-device:
 *   post:
 *     summary: Sync all employees to ZKTeco device
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Sync successful
 */
router.post('/sync-to-device', syncEmployeesToDeviceController);


/**
 * @swagger
 * /api/employees/{id}/enroll-fingerprint:
 *   post:
 *     summary: Trigger fingerprint enrollment on device
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Employee ID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fingerIndex:
 *                 type: integer
 *                 description: Finger index (0-9). Default 0 (Right Thumb).
 *                 example: 0
 *     responses:
 *       200:
 *         description: Enrollment started
 *       404:
 *         description: Employee not found
 */
router.post('/:id/enroll-fingerprint', validate(enrollFingerprintValidator), enrollEmployeeFingerprintController);

/**
 * @swagger
 * /api/employees/{id}/enroll-card:
 *   post:
 *     summary: Enroll RFID badge card for employee
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Employee ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - cardNumber
 *             properties:
 *               cardNumber:
 *                 type: integer
 *                 description: RFID card number (uint32)
 *                 example: 12345678
 *     responses:
 *       200:
 *         description: Card enrolled successfully
 *       409:
 *         description: Card number already assigned to another employee
 */
router.post('/:id/enroll-card', validate(enrollCardValidator), enrollEmployeeCardController);

/**
 * @swagger
 * /api/employees/{id}/permanent:
 *   delete:
 *     summary: Permanently delete an inactive employee
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Employee permanently deleted
 *       400:
 *         description: Employee must be inactive first
 *       404:
 *         description: Employee not found
 */
router.delete('/:id/permanent', permanentDeleteEmployee);

/**
 * @swagger
 * /api/employees/{id}:
 *   delete:
 *     summary: Soft-delete an employee (mark as inactive)
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Employee deactivated
 *       404:
 *         description: Employee not found
 */
router.delete('/:id', deleteEmployee);

/**
 * @swagger
 * /api/employees/{id}/reactivate:
 *   patch:
 *     summary: Reactivate an inactive employee
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Employee reactivated
 *       404:
 *         description: Employee not found
 */
router.patch('/:id/reactivate', reactivateEmployee);

/**
 * @swagger
 * /api/employees/{id}:
 *   put:
 *     summary: Update an employee's details
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               firstName:
 *                 type: string
 *               lastName:
 *                 type: string
 *               email:
 *                 type: string
 *               department:
 *                 type: string
 *               position:
 *                 type: string
 *               branch:
 *                 type: string
 *               shiftId:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Employee updated
 *       404:
 *         description: Employee not found
 */
router.put('/:id', updateEmployee);

/**
 * @swagger
 * /api/employees/{id}/reset-password:
 *   post:
 *     summary: Reset an employee's password
 *     tags: [Employees]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Password reset successful (returns new temporary password)
 *       404:
 *         description: Employee not found
 */
router.post('/:id/reset-password', resetEmployeePassword);

export default router;
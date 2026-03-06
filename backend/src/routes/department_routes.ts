import express from 'express';
import { getAllDepartments, createDepartment, deleteDepartment } from '../controllers/department.controller';
import { authenticate } from '../middleware/auth.middleware';
import { adminOrHR } from '../middleware/role.middleware';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticate);

/**
 * @swagger
 * /api/departments:
 *   get:
 *     summary: Retrieve a list of departments
 *     tags: [Departments]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: A list of departments.
 */
router.get('/', getAllDepartments);

/**
 * @swagger
 * /api/departments:
 *   post:
 *     summary: Create a new department
 *     tags: [Departments]
 *     security:
 *       - bearerAuth: []
 */
router.post('/', adminOrHR, createDepartment);

/**
 * @swagger
 * /api/departments/{id}:
 *   delete:
 *     summary: Delete a department
 *     tags: [Departments]
 *     security:
 *       - bearerAuth: []
 */
router.delete('/:id', adminOrHR, deleteDepartment);

export default router;

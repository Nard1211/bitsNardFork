import express from 'express';
import { getBranches, createBranch, deleteBranch } from '../controllers/branch.controller';
import { authenticate } from '../middleware/auth.middleware';
import { adminOrHR } from '../middleware/role.middleware';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticate);

/**
 * @swagger
 * /api/branches:
 *   get:
 *     summary: Retrieve a list of branches
 *     tags: [Branches]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: A list of branches.
 */
router.get('/', getBranches);

/**
 * @swagger
 * /api/branches:
 *   post:
 *     summary: Create a new branch
 *     tags: [Branches]
 *     security:
 *       - bearerAuth: []
 */
router.post('/', adminOrHR, createBranch);

/**
 * @swagger
 * /api/branches/{id}:
 *   delete:
 *     summary: Delete a branch
 *     tags: [Branches]
 *     security:
 *       - bearerAuth: []
 */
router.delete('/:id', adminOrHR, deleteBranch);

export default router;

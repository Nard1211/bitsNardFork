import { Router } from 'express';
import { getLogs } from '../controllers/logs.controller';
import { authenticate } from '../middleware/auth.middleware';
import { adminOrHR } from '../middleware/role.middleware';

const router = Router();

router.use(authenticate);
router.use(adminOrHR);

// GET /api/logs
router.get('/', getLogs);

export default router;

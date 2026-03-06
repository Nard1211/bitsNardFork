import { Router } from 'express';
import {
    getAllDevices,
    createDevice,
    updateDevice,
    deleteDevice,
    testDeviceConnection,
} from '../controllers/device.controller';
import { authenticate } from '../middleware/auth.middleware';
import { adminOrHR } from '../middleware/role.middleware';

const router = Router();

// All device routes require authentication and admin/HR role
router.use(authenticate);
router.use(adminOrHR);

// List all devices
router.get('/', getAllDevices);

// Create a new device
router.post('/', createDevice);

// Update a device
router.put('/:id', updateDevice);

// Delete a device
router.delete('/:id', deleteDevice);

// Test connection to a specific device
router.post('/:id/test', testDeviceConnection);

export default router;

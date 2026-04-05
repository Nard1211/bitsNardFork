import { body, query } from 'express-validator';

export const createEmployeeValidator = [
    body('firstName').notEmpty().withMessage('First Name is required').trim(),
    body('lastName').notEmpty().withMessage('Last Name is required').trim(),
    body('email').optional().isEmail().withMessage('Valid email is required').normalizeEmail(),
    body('role').optional().isIn(['USER', 'ADMIN', 'HR']).withMessage('Invalid role'),
    body('zkId').optional().isInt().withMessage('ZK ID must be an integer'),
];

export const employeeQueryValidator = [
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: 10000 }).withMessage('Limit must be between 1 and 10000'),
    query('search').optional().isString().trim(),
];

export const enrollFingerprintValidator = [
    body('fingerIndex')
        .optional()
        .isInt({ min: 0, max: 9 })
        .withMessage('Finger index must be between 0 and 9'),
    body('deviceId')
        .optional()
        .isInt({ min: 1 })
        .withMessage('Device ID must be a positive integer'),
];

export const enrollCardValidator = [
    body('cardNumber')
        .notEmpty().withMessage('Card number is required')
        .isInt({ min: 1, max: 4294967295 })
        .withMessage('Card number must be a valid uint32 (1–4294967295)'),
];

export const importEmployeesValidator = [
    body('employees').isArray({ min: 1, max: 1000 }).withMessage('employees must be an array of 1-1000 items'),
    body('employees.*.firstName').notEmpty().withMessage('First Name is required').trim(),
    body('employees.*.lastName').notEmpty().withMessage('Last Name is required').trim(),
    body('employees.*.email').optional({ nullable: true, values: false }).isEmail().withMessage('Valid email is required').normalizeEmail(),
    body('employees.*.role').optional({ nullable: true, values: false }).isIn(['USER', 'ADMIN', 'HR']).withMessage('Invalid role'),
    body('employees.*.employmentStatus').optional({ nullable: true, values: false }).isIn(['ACTIVE', 'INACTIVE', 'TERMINATED']).withMessage('Invalid status'),
    body('employees.*.shiftId').optional({ nullable: true, values: false }).isInt({ min: 1 }).withMessage('shiftId must be a positive integer'),
];
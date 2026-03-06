import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';

// GET /api/departments
export const getAllDepartments = async (req: Request, res: Response) => {
    try {
        const departments = await prisma.department.findMany({
            orderBy: {
                name: 'asc'
            }
        });
        res.json({
            success: true,
            departments
        });
    } catch (error) {
        console.error('Error fetching departments:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch departments'
        });
    }
};

// POST /api/departments
export const createDepartment = async (req: Request, res: Response) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: 'Department name is required' });
        }
        const trimmedName = name.trim().toUpperCase();
        const existing = await prisma.department.findFirst({ where: { name: trimmedName } });
        if (existing) {
            return res.status(400).json({ success: false, message: 'Department already exists' });
        }
        const department = await prisma.department.create({ data: { name: trimmedName, updatedAt: new Date() } });
        res.status(201).json({ success: true, department });
    } catch (error) {
        console.error('Error creating department:', error);
        res.status(500).json({ success: false, message: 'Failed to create department' });
    }
};

// DELETE /api/departments/:id
export const deleteDepartment = async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id));
        if (isNaN(id)) {
            return res.status(400).json({ success: false, message: 'Invalid department ID' });
        }
        const existing = await prisma.department.findUnique({ where: { id } });
        if (!existing) {
            return res.status(404).json({ success: false, message: 'Department not found' });
        }
        await prisma.department.delete({ where: { id } });
        res.json({ success: true, message: `Department "${existing.name}" deleted` });
    } catch (error) {
        console.error('Error deleting department:', error);
        res.status(500).json({ success: false, message: 'Failed to delete department' });
    }
};

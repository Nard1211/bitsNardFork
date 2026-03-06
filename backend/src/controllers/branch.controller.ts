import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';

// GET /api/branches - Get all branches
export const getBranches = async (req: Request, res: Response) => {
    try {
        const branches = await prisma.branch.findMany({
            orderBy: {
                name: 'asc'
            }
        });

        res.json({
            success: true,
            branches
        });
    } catch (error) {
        console.error('Error fetching branches:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch branches'
        });
    }
};

// POST /api/branches - Create a new branch
export const createBranch = async (req: Request, res: Response) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: 'Branch name is required' });
        }

        const existing = await prisma.branch.findUnique({ where: { name: name.trim() } });
        if (existing) {
            return res.status(409).json({ success: false, message: 'Branch already exists' });
        }

        const branch = await prisma.branch.create({
            data: { name: name.trim(), updatedAt: new Date() }
        });

        res.status(201).json({ success: true, branch });
    } catch (error) {
        console.error('Error creating branch:', error);
        res.status(500).json({ success: false, message: 'Failed to create branch' });
    }
};

// DELETE /api/branches/:id - Delete a branch
export const deleteBranch = async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id));
        if (isNaN(id)) {
            return res.status(400).json({ success: false, message: 'Invalid branch ID' });
        }

        await prisma.branch.delete({ where: { id } });
        res.json({ success: true, message: 'Branch deleted' });
    } catch (error: any) {
        console.error('Error deleting branch:', error);
        if (error.code === 'P2003') {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete branch that has employees assigned to it'
            });
        }
        res.status(500).json({ success: false, message: 'Failed to delete branch' });
    }
};

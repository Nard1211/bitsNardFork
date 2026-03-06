import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const depts = await prisma.department.findMany();
    console.log('Departments:', depts);

    const empWithDeptStr = await prisma.employee.count({ where: { department: { not: null } } });
    console.log('Employees with department string:', empWithDeptStr);

    const empWithDeptId = await prisma.employee.count({ where: { departmentId: { not: null } } });
    console.log('Employees with departmentId:', empWithDeptId);
}
main().catch(console.error).finally(() => prisma.$disconnect());

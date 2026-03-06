import { prisma } from './lib/prisma';
async function main() {
    const employees = await prisma.employee.findMany({ select: { id: true, firstName: true, department: true, departmentId: true, Department: true } });
    console.log(JSON.stringify(employees.slice(0, 2), null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());

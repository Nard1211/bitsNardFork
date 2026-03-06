import { prisma } from './src/lib/prisma';

async function main() {
    try {
        const employees = await prisma.employee.findMany({
            select: {
                id: true,
                zkId: true,
                firstName: true,
                lastName: true,
                employmentStatus: true,
                role: true,
                email: true
            },
            orderBy: {
                zkId: 'asc'
            }
        });

        console.log('--- Employee Database State ---');
        console.log(`Total Records: ${employees.length}`);
        console.log('-------------------------------');

        employees.forEach(e => {
            console.log(`ID: ${e.id.toString().padEnd(3)} | zkId: ${String(e.zkId).padEnd(4)} | Status: ${e.employmentStatus.padEnd(10)} | Role: ${e.role.padEnd(6)} | Name: ${e.firstName} ${e.lastName}`);
        });
        console.log('-------------------------------');

        const activeWithZkId = employees.filter(e => e.employmentStatus === 'ACTIVE' && e.zkId !== null);
        console.log(`Active with zkId: ${activeWithZkId.length}`);

        const missingZkId = employees.filter(e => e.zkId === null);
        console.log(`Missing zkId: ${missingZkId.length}`);

        const inactive = employees.filter(e => e.employmentStatus !== 'ACTIVE');
        console.log(`Inactive/Other status: ${inactive.length}`);

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();

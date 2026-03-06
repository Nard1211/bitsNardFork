import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
    const branches = await prisma.employee.findMany({
        select: {
            branch: true,
            role: true,
            employmentStatus: true,
            firstName: true,
            lastName: true
        }
    });
    console.log(branches);
}
main().catch(e => console.error(e)).finally(() => prisma.$disconnect());

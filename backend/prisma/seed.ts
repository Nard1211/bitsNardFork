import { PrismaClient } from '@prisma/client'
import * as bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
    console.log('🌱 Starting seed...')

    // ──────────────────────────────────────────────
    // 1. Departments (matches frontend DEPARTMENTS constant)
    // ──────────────────────────────────────────────
    const departmentNames = [
        'ADMIN DEPARTMENT',
        'ACCOUNTING DEPARTMENT',
        'ENGINEERING DEPARTMENT',
        'HUMAN RESOURCES DEPARTMENT',
        'IT DEPARTMENT',
        'LOGISTICS DEPARTMENT',
        'MAINTENANCE DEPARTMENT',
        'MANAGEMENT DEPARTMENT',
        'MARKETING DEPARTMENT',
        'OPERATIONS DEPARTMENT',
        'PRODUCTION DEPARTMENT',
        'PURCHASING DEPARTMENT',
        'QUALITY ASSURANCE DEPARTMENT',
        'RESEARCH AND DEVELOPMENT DEPARTMENT',
        'SAFETY DEPARTMENT',
        'SALES DEPARTMENT',
        'SUPPLY CHAIN DEPARTMENT',
        'WAREHOUSE DEPARTMENT',
    ]

    const deptMap: Record<string, number> = {}
    for (const name of departmentNames) {
        const dept = await prisma.department.upsert({
            where: { name },
            update: {},
            create: { name, updatedAt: new Date() }
        })
        deptMap[name] = dept.id
    }
    console.log(`🏢 Seeded ${departmentNames.length} departments`)

    // ──────────────────────────────────────────────
    // 2. Branches
    // ──────────────────────────────────────────────
    const branchNames = ['NRA', 'MAIN OFFICE', 'WAREHOUSE A']
    const branchMap: Record<string, number> = {}
    for (const name of branchNames) {
        const branch = await prisma.branch.upsert({
            where: { name },
            update: {},
            create: { name, updatedAt: new Date() }
        })
        branchMap[name] = branch.id
    }
    console.log(`🏬 Seeded ${branchNames.length} branches`)

    // ──────────────────────────────────────────────
    // 3. Shifts
    // ──────────────────────────────────────────────
    const shifts = [
        { name: 'Morning Shift', startTime: '08:00', endTime: '17:00' },
        { name: 'Afternoon Shift', startTime: '13:00', endTime: '22:00' },
        { name: 'Night Shift', startTime: '22:00', endTime: '06:00' },
    ]
    const shiftMap: Record<string, number> = {}
    for (const s of shifts) {
        // Shift has no unique constraint, find by name or create
        let shift = await prisma.shift.findFirst({ where: { name: s.name } })
        if (!shift) {
            shift = await prisma.shift.create({
                data: { ...s, updatedAt: new Date() }
            })
        }
        shiftMap[s.name] = shift.id
    }
    console.log(`⏰ Seeded ${shifts.length} shifts`)

    // ──────────────────────────────────────────────
    // 4. Device
    // ──────────────────────────────────────────────
    await prisma.device.upsert({
        where: { ip: '192.168.1.201' },
        update: {},
        create: {
            name: 'Main Entrance Biometric',
            ip: '192.168.1.201',
            port: 4370,
            location: 'Main Lobby',
            isActive: true,
            updatedAt: new Date()
        }
    })
    console.log('📡 Seeded device')

    // ──────────────────────────────────────────────
    // 5. Employees
    // NOTE: zkId 1 is RESERVED for the ZKTeco device SUPER ADMIN — never use it.
    //       Employee zkIds start from 2.
    // ──────────────────────────────────────────────
    const passwordHash = await bcrypt.hash('password123', 10)

    const employees = [
        {
            email: 'admin@avegabros.com',
            firstName: 'Admin',
            lastName: 'User',
            role: 'ADMIN' as const,
            department: 'ADMIN DEPARTMENT',
            position: 'System Administrator',
            branch: 'NRA',
            contactNumber: '09171234567',
            employeeNumber: 'EMP001',
            preferredZkId: 2,
            shift: 'Morning Shift',
        },
        {
            email: 'hr@avegabros.com',
            firstName: 'Maria',
            lastName: 'Santos',
            role: 'HR' as const,
            department: 'HUMAN RESOURCES DEPARTMENT',
            position: 'HR Manager',
            branch: 'NRA',
            contactNumber: '09179876543',
            employeeNumber: 'EMP002',
            preferredZkId: 3,
            shift: 'Morning Shift',
        },
        {
            email: 'john@avegabros.com',
            firstName: 'John',
            lastName: 'Doe',
            role: 'USER' as const,
            department: 'ENGINEERING DEPARTMENT',
            position: 'Senior Developer',
            branch: 'NRA',
            contactNumber: '09171112222',
            employeeNumber: 'EMP003',
            preferredZkId: 4,
            shift: 'Morning Shift',
        },
        {
            email: 'jane@avegabros.com',
            firstName: 'Jane',
            lastName: 'Smith',
            role: 'USER' as const,
            department: 'ENGINEERING DEPARTMENT',
            position: 'UI/UX Designer',
            branch: 'NRA',
            contactNumber: '09173334444',
            employeeNumber: 'EMP004',
            preferredZkId: 5,
            shift: 'Morning Shift',
        },
        {
            email: 'alex@avegabros.com',
            firstName: 'Alex',
            lastName: 'Rivera',
            role: 'USER' as const,
            department: 'MARKETING DEPARTMENT',
            position: 'Marketing Lead',
            branch: 'MAIN OFFICE',
            contactNumber: '09175556666',
            employeeNumber: 'EMP005',
            preferredZkId: 6,
            shift: 'Morning Shift',
        },
        {
            email: 'carlos@avegabros.com',
            firstName: 'Carlos',
            lastName: 'Reyes',
            role: 'USER' as const,
            department: 'IT DEPARTMENT',
            position: 'Network Engineer',
            branch: 'NRA',
            contactNumber: '09177778888',
            employeeNumber: 'EMP006',
            preferredZkId: 7,
            shift: 'Morning Shift',
        },
        {
            email: 'anna@avegabros.com',
            firstName: 'Anna',
            lastName: 'Cruz',
            role: 'USER' as const,
            department: 'ACCOUNTING DEPARTMENT',
            position: 'Senior Accountant',
            branch: 'MAIN OFFICE',
            contactNumber: '09179990000',
            employeeNumber: 'EMP007',
            preferredZkId: 8,
            shift: 'Morning Shift',
        },
        {
            email: 'mike@avegabros.com',
            firstName: 'Mike',
            lastName: 'Garcia',
            role: 'USER' as const,
            department: 'WAREHOUSE DEPARTMENT',
            position: 'Warehouse Supervisor',
            branch: 'WAREHOUSE A',
            contactNumber: '09171230000',
            employeeNumber: 'EMP008',
            preferredZkId: 9,
            shift: 'Afternoon Shift',
        },
        {
            email: 'lisa@avegabros.com',
            firstName: 'Lisa',
            lastName: 'Tan',
            role: 'USER' as const,
            department: 'QUALITY ASSURANCE DEPARTMENT',
            position: 'QA Lead',
            branch: 'NRA',
            contactNumber: '09174561234',
            employeeNumber: 'EMP009',
            preferredZkId: 10,
            shift: 'Morning Shift',
        },
        {
            email: 'david@avegabros.com',
            firstName: 'David',
            lastName: 'Lim',
            role: 'USER' as const,
            department: 'OPERATIONS DEPARTMENT',
            position: 'Operations Manager',
            branch: 'MAIN OFFICE',
            contactNumber: '09177894561',
            employeeNumber: 'EMP010',
            preferredZkId: 11,
            shift: 'Morning Shift',
        },
    ]

    for (const u of employees) {
        const existing = await prisma.employee.findUnique({ where: { email: u.email } })
        let empId = existing?.id
        let empZkId = existing?.zkId

        if (!existing) {
            // Determine safe zkId — never use 1 (device SUPER ADMIN)
            const zkCheck = await prisma.employee.findUnique({ where: { zkId: u.preferredZkId } })
            let finalZkId = u.preferredZkId
            if (zkCheck) {
                const max = await prisma.employee.findFirst({ orderBy: { zkId: 'desc' } })
                finalZkId = Math.max((max?.zkId || 1) + 1, 2) // Never assign 1
            }

            const newEmp = await prisma.employee.create({
                data: {
                    firstName: u.firstName,
                    lastName: u.lastName,
                    email: u.email,
                    password: passwordHash,
                    role: u.role,
                    department: u.department,
                    departmentId: deptMap[u.department] ?? null,
                    position: u.position,
                    branch: u.branch,
                    branchId: branchMap[u.branch] ?? null,
                    shiftId: shiftMap[u.shift] ?? null,
                    contactNumber: u.contactNumber,
                    employeeNumber: u.employeeNumber,
                    zkId: finalZkId,
                    employmentStatus: 'ACTIVE',
                    hireDate: new Date('2024-01-15'),
                    updatedAt: new Date(),
                }
            })
            empId = newEmp.id
            empZkId = newEmp.zkId
            console.log(`👤 Created: ${u.firstName} ${u.lastName} (${u.role}, zkId: ${finalZkId})`)
        } else {
            console.log(`👤 Already exists: ${u.email}`)
        }

        // ──────────────────────────────────────────────
        // 6. Attendance records (last 7 weekdays)
        // ──────────────────────────────────────────────
        if (empId && empZkId) {
            const today = new Date()
            for (let i = 0; i < 7; i++) {
                const date = new Date(today)
                date.setDate(date.getDate() - i)

                // Skip weekends
                if (date.getDay() === 0 || date.getDay() === 6) continue

                const dateStr = date.toISOString().split('T')[0]

                // Skip if attendance already exists
                const existingAtt = await prisma.attendance.findUnique({
                    where: {
                        employeeId_date: {
                            employeeId: empId,
                            date: new Date(dateStr + 'T00:00:00.000Z')
                        }
                    }
                })
                if (existingAtt) continue

                // Randomised attendance: ~5% absent
                const rand = Math.random()
                if (rand > 0.95) continue

                // Check-in time: 7:45–7:59 (on time) or 8:00–8:30 (late)
                let inHour = 7, inMin = 45 + Math.floor(Math.random() * 15)
                if (rand > 0.80 && rand <= 0.95) {
                    inHour = 8
                    inMin = Math.floor(Math.random() * 30)
                }

                const checkIn = new Date(dateStr)
                checkIn.setHours(inHour, inMin, 0, 0)

                // Check-out time: 5:00–5:30 PM (~95% have checkout)
                let checkOut: Date | null = null
                if (Math.random() > 0.05) {
                    checkOut = new Date(dateStr)
                    checkOut.setHours(17, Math.floor(Math.random() * 30), 0, 0)
                }

                const status = (inHour === 7 || (inHour === 8 && inMin === 0)) ? 'present' : 'late'

                await prisma.attendance.create({
                    data: {
                        employeeId: empId,
                        date: new Date(dateStr + 'T00:00:00.000Z'),
                        checkInTime: checkIn,
                        checkOutTime: checkOut ?? undefined,
                        status,
                    }
                })
            }
        }
    }

    console.log('✅ Seed completed!')
    console.log('')
    console.log('📋 Test accounts:')
    console.log('   Admin:  admin@avegabros.com / password123')
    console.log('   HR:     hr@avegabros.com    / password123')
    console.log('   Users:  john@avegabros.com  / password123  (+ 7 more)')
}

main()
    .catch((e) => {
        console.error(e)
        process.exit(1)
    })
    .finally(async () => {
        await prisma.$disconnect()
    })

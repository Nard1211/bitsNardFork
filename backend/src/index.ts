import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger.config';
import { prisma } from './lib/prisma';
import attendanceRoutes from './routes/attendance_routes';
import authRoutes from './routes/auth_routes';
import employeeRoutes from './routes/employee_routes';
import userRoutes from './routes/user_routes';
import departmentRoutes from './routes/department_routes';
import branchRoutes from './routes/branch_routes';
import deviceRoutes from './routes/device_routes';
import logsRoutes from './routes/logs_routes';
import { startCronJobs } from './lib/cronJobs';
import { repairMissingCheckouts } from './services/attendance.service';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());

app.use(express.json());
app.use(morgan('dev')); // Request logging

// Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Mount Routes
app.use('/api/attendance', attendanceRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/users', userRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/branches', branchRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/logs', logsRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ── Device health endpoint — polled by topbar every 15 seconds ────────────────
// Returns the live isActive status for the primary device (ZK_HOST) from the DB.
// syncZkData updates isActive on every cron tick (every 30s), so this endpoint
// reflects real connectivity without making its own TCP connection.
app.get('/api/health/device', async (req, res) => {
  try {
    const zkHost = process.env.ZK_HOST || '192.168.1.201';

    // Find the device by its IP in the DB
    const device = await prisma.device.findFirst({
      where: { ip: zkHost },
      select: { id: true, name: true, ip: true, port: true, isActive: true, updatedAt: true }
    });

    if (!device) {
      // Device not in DB yet — status unknown
      return res.json({ online: false, status: 'unknown', message: 'Device not registered in system' });
    }

    return res.json({
      online: device.isActive,
      status: device.isActive ? 'online' : 'offline',
      deviceName: device.name,
      ip: device.ip,
      port: device.port,
      lastSeen: device.updatedAt,
    });
  } catch (error: any) {
    return res.status(500).json({ online: false, status: 'error', message: error.message });
  }
});

app.get('/api/test-db', async (req, res) => {
  try {
    const result = await prisma.$queryRaw`SELECT NOW()`;
    res.json({
      status: 'Database connected',
      result
    });
  } catch (error) {
    console.error('Database connection error:', error);
    res.status(500).json({
      status: 'Database connection failed',
      error: 'connection_error' // Sanitize error
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    error: 'not_found'
  });
});

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    success: false,
    error: err.error || 'internal_server_error',
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : (err.message || 'Internal server error'),
    ...(process.env.NODE_ENV === 'development' && err.stack ? { stack: err.stack } : {})
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions — log but keep server alive to avoid JSON parse errors on the frontend
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Do NOT call process.exit(1) — if we crash here the frontend gets no JSON response
  // which causes "Unexpected token I" parse errors. Log and continue instead.
});

app.listen(port, () => {
  console.log(`Backend server running on port ${port}`);

  // Run startup repair for missing checkouts
  repairMissingCheckouts();

  // Initialize automated cron jobs
  startCronJobs();
});
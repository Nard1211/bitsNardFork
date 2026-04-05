// ─── Centralized API Client ──────────────────────────────────────────────────
// Single source of truth for all backend API calls.
// Automatically authenticates via HttpOnly cookie (credentials: 'include').
// Backend base URL is proxied by Next.js rewrites: /api/* → http://backend:3001/api/*

// ─── Types ───────────────────────────────────────────────────────────────────
export type Role = 'ADMIN' | 'HR' | 'USER'
export type EmploymentStatus = 'ACTIVE' | 'INACTIVE' | 'TERMINATED'

export interface Branch {
  id: number
  name: string
  createdAt?: string
  updatedAt?: string
}

export interface Department {
  id: number
  name: string
  createdAt?: string
  updatedAt?: string
}

export interface Employee {
  id: number
  zkId: number | null
  cardNumber: number | null
  employeeNumber: string | null
  firstName: string
  lastName: string
  email: string | null
  role: Role
  department: string | null
  departmentId: number | null
  Department?: { name: string } | null
  position: string | null
  branch: string | null
  contactNumber: string | null
  hireDate: string | null
  employmentStatus: EmploymentStatus
  createdAt: string
  updatedAt?: string
}

export interface AttendanceRecord {
  id: number
  employeeId: number
  date: string
  checkInTime: string
  checkOutTime: string | null
  status: string
  notes: string | null
  createdAt: string
  updatedAt: string
  employee?: Pick<Employee, 'id' | 'firstName' | 'lastName' | 'department' | 'branch'>
}

export interface User {
  id: number
  firstName: string
  lastName: string
  email: string | null
  role: Role
  employmentStatus: EmploymentStatus
  status: 'active' | 'inactive'
  createdAt: string
}

export interface PaginationMeta {
  total: number
  page: number
  limit: number
  totalPages: number
}

// ─── Core Fetch Helper ───────────────────────────────────────────────────────
type RequestOptions = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>
}

async function apiFetch<T = unknown>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers,
  }

  const res = await fetch(path, { ...options, headers, credentials: 'include' })

  if (!res.ok) {
    // Try to parse an error message from the response body
    let message = `Request failed: ${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body?.message) message = body.message
    } catch {
      // ignore JSON parse failures
    }
    throw new Error(message)
  }

  return res.json() as Promise<T>
}

// ─── Auth ────────────────────────────────────────────────────────────────────

export interface LoginPayload {
  email: string
  password: string
}

export interface LoginResponse {
  success: boolean
  message: string
  accessToken: string
  token: string
  refreshToken: string
  employee: Pick<Employee, 'id' | 'firstName' | 'lastName' | 'email' | 'role'>
}

export const authApi = {
  login(payload: LoginPayload) {
    return apiFetch<LoginResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  register(payload: Partial<Employee> & { password: string }) {
    return apiFetch<{ success: boolean; message: string; employee: Partial<Employee> }>(
      '/api/auth/register',
      { method: 'POST', body: JSON.stringify(payload) }
    )
  },

  refreshToken(refreshToken: string) {
    return apiFetch<{ success: boolean; accessToken: string }>('/api/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    })
  },
}

// ─── Employees ───────────────────────────────────────────────────────────────

export interface GetEmployeesParams {
  page?: number
  limit?: number
  search?: string
}

export interface GetEmployeesResponse {
  success: boolean
  employees: Employee[]
}

export interface CreateEmployeePayload {
  firstName: string
  lastName: string
  email?: string
  employeeNumber?: string
  role?: Role
  department?: string
  position?: string
  branch?: string
  contactNumber?: string
  hireDate?: string
  employmentStatus?: EmploymentStatus
}

export interface UpdateEmployeePayload {
  firstName?: string
  lastName?: string
  email?: string
  contactNumber?: string
  position?: string
  departmentId?: number | null
  branch?: string
  employmentStatus?: EmploymentStatus
}

export const employeesApi = {
  getAll(params?: GetEmployeesParams) {
    const query = new URLSearchParams()
    if (params?.page) query.set('page', String(params.page))
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.search) query.set('search', params.search)
    const qs = query.toString()
    return apiFetch<GetEmployeesResponse>(`/api/employees${qs ? `?${qs}` : ''}`)
  },

  create(payload: CreateEmployeePayload) {
    return apiFetch<{ success: boolean; message: string; employee: Employee; deviceSync: { success: boolean; message: string } }>(
      '/api/employees',
      { method: 'POST', body: JSON.stringify(payload) }
    )
  },

  update(id: number, payload: UpdateEmployeePayload) {
    return apiFetch<{ success: boolean; message: string; employee: Employee }>(
      `/api/employees/${id}`,
      { method: 'PUT', body: JSON.stringify(payload) }
    )
  },

  /** Soft delete — marks employee as INACTIVE */
  delete(id: number) {
    return apiFetch<{ success: boolean; message: string; employee: Partial<Employee> }>(
      `/api/employees/${id}`,
      { method: 'DELETE' }
    )
  },

  /** Reactivate an INACTIVE employee */
  reactivate(id: number) {
    return apiFetch<{ success: boolean; message: string; employee: Partial<Employee> }>(
      `/api/employees/${id}/reactivate`,
      { method: 'PATCH' }
    )
  },

  /** Permanently delete an INACTIVE employee from the database */
  permanentDelete(id: number) {
    return apiFetch<{ success: boolean; message: string }>(
      `/api/employees/${id}/permanent`,
      { method: 'DELETE' }
    )
  },

  syncToDevice() {
    return apiFetch<{ success: boolean; message: string; count?: number }>(
      '/api/employees/sync-to-device',
      { method: 'POST' }
    )
  },

  enrollFingerprint(id: number, fingerIndex?: number) {
    return apiFetch<{ success: boolean; message: string }>(
      `/api/employees/${id}/enroll-fingerprint`,
      { method: 'POST', body: JSON.stringify({ fingerIndex: fingerIndex ?? 0 }) }
    )
  },

  enrollCard(id: number, cardNumber: number) {
    return apiFetch<{ success: boolean; message: string }>(
      `/api/employees/${id}/enroll-card`,
      { method: 'POST', body: JSON.stringify({ cardNumber }) }
    )
  },

  import(payload: ImportPayload) {
    return apiFetch<ImportResponse>(
      '/api/employees/import',
      { method: 'POST', body: JSON.stringify(payload) }
    )
  },
}

export interface ImportEmployeePayload {
  firstName: string
  lastName: string
  middleName?: string | null
  suffix?: string | null
  gender?: string | null
  dateOfBirth?: string | null
  email?: string | null
  role?: string
  department?: string | null
  position?: string | null
  branch?: string | null
  contactNumber?: string | null
  employeeNumber?: string | null
  hireDate?: string | null
  employmentStatus?: string
  shiftId?: number | null
}

export interface ImportPayload {
  employees: ImportEmployeePayload[]
}

export interface ImportResponse {
  success: boolean
  message: string
  imported: Array<{ id: number; firstName: string; lastName: string; email: string | null; employeeNumber: string | null }>
  errors: Array<{ row: number; data: any; errors: string[] }>
}

export interface ImportEmployeePayload {
  firstName: string
  lastName: string
  middleName?: string | null
  suffix?: string | null
  gender?: string | null
  dateOfBirth?: string | null
  email?: string | null
  role?: string
  department?: string | null
  position?: string | null
  branch?: string | null
  contactNumber?: string | null
  employeeNumber?: string | null
  hireDate?: string | null
  employmentStatus?: string
  shiftId?: number | null
}

export interface ImportPayload {
  employees: ImportEmployeePayload[]
}

export interface ImportResponse {
  success: boolean
  message: string
  imported: Array<{ id: number; firstName: string; lastName: string; email: string | null; employeeNumber: string | null }>
  errors: Array<{ row: number; data: any; errors: string[] }>
}

// ─── Attendance ──────────────────────────────────────────────────────────────

export interface GetAttendanceParams {
  startDate?: string // YYYY-MM-DD
  endDate?: string   // YYYY-MM-DD
  employeeId?: number
  status?: string
  page?: number
  limit?: number
}

export interface GetAttendanceResponse {
  success: boolean
  data: AttendanceRecord[]
  meta: PaginationMeta
}

export interface GetTodayResponse {
  success: boolean
  count: number
  data: AttendanceRecord[]
}

export const attendanceApi = {
  getAll(params?: GetAttendanceParams) {
    const query = new URLSearchParams()
    if (params?.startDate) query.set('startDate', params.startDate)
    if (params?.endDate) query.set('endDate', params.endDate)
    if (params?.employeeId) query.set('employeeId', String(params.employeeId))
    if (params?.status) query.set('status', params.status)
    if (params?.page) query.set('page', String(params.page))
    if (params?.limit) query.set('limit', String(params.limit))
    const qs = query.toString()
    return apiFetch<GetAttendanceResponse>(`/api/attendance${qs ? `?${qs}` : ''}`)
  },

  getToday() {
    return apiFetch<GetTodayResponse>('/api/attendance/today')
  },

  getEmployeeHistory(id: number, startDate?: string, endDate?: string) {
    const query = new URLSearchParams()
    if (startDate) query.set('startDate', startDate)
    if (endDate) query.set('endDate', endDate)
    const qs = query.toString()
    return apiFetch<{ success: boolean; count: number; data: AttendanceRecord[] }>(
      `/api/attendance/employee/${id}${qs ? `?${qs}` : ''}`
    )
  },

  sync() {
    return apiFetch<{ success: boolean; message: string }>(
      '/api/attendance/sync',
      { method: 'POST' }
    )
  },
}

// ─── Departments ─────────────────────────────────────────────────────────────

export interface GetDepartmentsResponse {
  success: boolean
  departments: Department[]
}

export const departmentsApi = {
  getAll() {
    return apiFetch<GetDepartmentsResponse>('/api/departments')
  },

  create(name: string) {
    return apiFetch<{ success: boolean; department: Department }>(
      '/api/departments',
      { method: 'POST', body: JSON.stringify({ name }) }
    )
  },

  delete(id: number) {
    return apiFetch<{ success: boolean; message: string }>(
      `/api/departments/${id}`,
      { method: 'DELETE' }
    )
  },
}

// ─── Branches ────────────────────────────────────────────────────────────────

export interface GetBranchesResponse {
  success: boolean
  branches: Branch[]
}

export const branchesApi = {
  getAll() {
    return apiFetch<GetBranchesResponse>('/api/branches')
  },

  create(name: string) {
    return apiFetch<{ success: boolean; branch: Branch }>(
      '/api/branches',
      { method: 'POST', body: JSON.stringify({ name }) }
    )
  },

  delete(id: number) {
    return apiFetch<{ success: boolean; message: string }>(
      `/api/branches/${id}`,
      { method: 'DELETE' }
    )
  },
}

// ─── Users (ADMIN / HR accounts) ─────────────────────────────────────────────

export interface GetUsersResponse {
  success: boolean
  users: User[]
}

export interface CreateUserPayload {
  firstName: string
  lastName: string
  email: string
  password: string
  role: 'ADMIN' | 'HR'
}

export interface UpdateUserPayload {
  firstName?: string
  lastName?: string
  email?: string
  role?: 'ADMIN' | 'HR'
  password?: string
}

export interface UpdateProfilePayload {
  firstName?: string
  lastName?: string
  contactNumber?: string
}

export const usersApi = {
  getAll() {
    return apiFetch<GetUsersResponse>('/api/users')
  },

  create(payload: CreateUserPayload) {
    return apiFetch<{ success: boolean; message: string; user: User }>(
      '/api/users',
      { method: 'POST', body: JSON.stringify(payload) }
    )
  },

  update(id: number, payload: UpdateUserPayload) {
    return apiFetch<{ success: boolean; message: string; user: User }>(
      `/api/users/${id}`,
      { method: 'PUT', body: JSON.stringify(payload) }
    )
  },

  delete(id: number) {
    return apiFetch<{ success: boolean; message: string }>(
      `/api/users/${id}`,
      { method: 'DELETE' }
    )
  },

  toggleStatus(id: number) {
    return apiFetch<{ success: boolean; message: string; user: User }>(
      `/api/users/${id}/toggle-status`,
      { method: 'PATCH' }
    )
  },

  updateProfile(payload: UpdateProfilePayload) {
    return apiFetch<{ success: boolean; message: string; employee: Partial<Employee> }>(
      '/api/users/profile',
      { method: 'PUT', body: JSON.stringify(payload) }
    )
  },

  changePassword(currentPassword: string, newPassword: string) {
    return apiFetch<{ success: boolean; message: string }>(
      '/api/users/change-password',
      { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) }
    )
  },
}

// ─── Employee Self-Service ───────────────────────────────────────────────────

export const employeeSelfApi = {
  getAttendance(startDate?: string, endDate?: string) {
    const query = new URLSearchParams()
    if (startDate) query.set('startDate', startDate)
    if (endDate) query.set('endDate', endDate)
    const qs = query.toString()
    return apiFetch<GetAttendanceResponse>(`/api/me/attendance${qs ? `?${qs}` : ''}`)
  },

  getShift() {
    return apiFetch<{ success: boolean; shift: any }>('/api/me/shift')
  },

  getProfile() {
    return apiFetch<{ success: boolean; profile: Employee }>('/api/me/profile')
  },

  changePassword(currentPassword: string, newPassword: string) {
    return apiFetch<{ success: boolean; message: string }>(
      '/api/me/password',
      { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) }
    )
  },
}

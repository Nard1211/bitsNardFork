'use client'

import React from "react"
import { useState, useEffect } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Search, Plus, Edit2, ChevronLeft, ChevronRight, Upload, AlertTriangle, AlertCircle, X as XIcon, Fingerprint, CheckCircle2, WifiOff, Timer, Loader2, Key, CreditCard } from 'lucide-react'
import * as XLSX from 'xlsx'
import { departmentsApi, branchesApi } from '@/lib/api'
import type { Department, Branch } from '@/lib/api'
import { useHorizontalDragScroll } from '@/hooks/useHorizontalDragScroll'
import { validateEmployeeId } from '@/lib/employeeValidation'
import { useTableSort } from '@/hooks/useTableSort'
import { SortableHeader } from '@/components/ui/SortableHeader'
import RFIDCardEnrollmentModal from './components/RFIDCardEnrollmentModal'

type Employee = {
  id: number
  zkId: number | null
  cardNumber: number | null
  employeeNumber: string | null
  firstName: string
  lastName: string
  middleName: string | null
  suffix: string | null
  email: string | null
  role: string
  department: string | null
  Department?: { name: string } | null
  departmentId?: number | null
  position: string | null
  branch: string | null
  contactNumber: string | null
  hireDate: string | null
  gender: string | null
  dateOfBirth: string | null
  employmentStatus: 'ACTIVE' | 'INACTIVE' | 'TERMINATED'
  shiftId?: number | null
  Shift?: { id: number; name: string; shiftCode: string; startTime: string; endTime: string } | null
  createdAt: string
  EmployeeDeviceEnrollment?: {
    enrolledAt: string
    device: {
      id: number
      name: string
      location: string | null
      isActive: boolean
    }
  }[]
}

const SUFFIX_OPTIONS = ['', 'Jr.', 'Sr.', 'II', 'III', 'IV', 'V'] as const;

function formatFullName(firstName: string, middleName?: string | null, lastName?: string, suffix?: string | null) {
  const mi = middleName ? ` ${middleName[0]}.` : '';
  const sfx = suffix ? ` ${suffix}` : '';
  return `${firstName}${mi} ${lastName || ''}${sfx}`.trim();
}

type ShiftOption = {
  id: number
  shiftCode: string
  name: string
  startTime: string
  endTime: string
}

type Toast = {
  id: number
  type: 'success' | 'warning' | 'error'
  title: string
  message: string
}

function formatTime(t: string) {
  if (!t) return '';
  const [h] = t.split(':');
  const hour = parseInt(h);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const display = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${display}:${t.split(':')[1]} ${suffix}`;
}

function formatPhoneNumber(value: string | null) {
  if (!value) return '';
  const digits = value.replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 4) return digits;
  if (digits.length <= 7) return `${digits.slice(0, 4)} ${digits.slice(4)}`;
  return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
}

export default function EmployeesPage() {
  const dragScrollRef = useHorizontalDragScroll()
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [toasts, setToasts] = useState<Toast[]>([])

  const showToast = (type: Toast['type'], title: string, message: string) => {
    const id = Date.now()
    setToasts(prev => [...prev, { id, type, title, message }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000)
  }
  const [selectedDept, setSelectedDept] = useState<string>('all')
  const [selectedBranch, setSelectedBranch] = useState<string>('all')
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [isImportOpen, setIsImportOpen] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [importResult, setImportResult] = useState<{ imported: any[]; errors: any[] } | null>(null)

  // Edit employee
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null)
  const [editForm, setEditForm] = useState<Partial<Employee>>({})

  // Confirm move-to-inactive dialog
  const [confirmDeactivate, setConfirmDeactivate] = useState<Employee | null>(null)
  const [isDeactivating, setIsDeactivating] = useState(false)

  // Confirm reset-password dialog
  const [confirmResetPassword, setConfirmResetPassword] = useState<Employee | null>(null)
  const [isResettingPassword, setIsResettingPassword] = useState(false)

  // Fingerprint enrollment state: { [employeeId]: 'idle' | 'loading' | 'success' | 'error' }
  const [enrollStatus, setEnrollStatus] = useState<Record<number, 'idle' | 'loading' | 'success' | 'error'>>({})
  const [enrollMsg, setEnrollMsg] = useState<Record<number, string>>({})

  // Scan Now modal
  const [scanModal, setScanModal] = useState<{ open: boolean; employeeName: string; countdown: number }>({
    open: false,
    employeeName: '',
    countdown: 60,
  })

  // Enrollment modal state
  const [enrollConfirmModal, setEnrollConfirmModal] = useState<{
    open: boolean
    employeeId: number | null
    employeeName: string
  }>({ open: false, employeeId: null, employeeName: '' })

  const [devicePickerModal, setDevicePickerModal] = useState<{
    open: boolean
    employeeId: number | null
    employeeName: string
  }>({ open: false, employeeId: null, employeeName: '' })

  const [devices, setDevices] = useState<{ id: number; name: string; location: string | null; isActive: boolean; syncEnabled?: boolean }[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null)
  const [loadingDevices, setLoadingDevices] = useState(false)

  // ── RFID Card Enrollment state ──
  const [cardEnrollOpen, setCardEnrollOpen] = useState<{ open: boolean, employeeId: number | null, employeeName: string }>({ open: false, employeeId: null, employeeName: '' })

  const fetchDevices = async () => {
    setLoadingDevices(true)
    try {
      const res = await fetch('/api/devices', { credentials: 'include' })
      const data = await res.json()
      if (data.success) {
        setDevices(data.devices || data.data || [])
      }
    } catch (error) {
      console.error('Failed to fetch devices:', error)
    } finally {
      setLoadingDevices(false)
    }
  }

  const handleEnrollFingerprint = async (employeeId: number, deviceId: number, fingerIndex: number = 5) => {
    setEnrollStatus(prev => ({ ...prev, [employeeId]: 'loading' }))
    setEnrollMsg(prev => ({ ...prev, [employeeId]: 'Connecting to device...' }))

    try {
      const res = await fetch(`/api/employees/${employeeId}/enroll-fingerprint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ fingerIndex, deviceId }),
      })

      const data = await res.json()

      if (data.success) {
        setEnrollStatus(prev => ({ ...prev, [employeeId]: 'success' }))
        setEnrollMsg(prev => ({ ...prev, [employeeId]: 'Device ready — scan finger now' }))
        const emp = employees.find(e => e.id === employeeId)
        const empName = emp ? `${emp.firstName} ${emp.lastName}` : 'Employee'
        setScanModal({ open: true, employeeName: empName, countdown: 60 })
        // Refresh employee list so enrollment badges update
        await fetchEmployees()
      } else {
        setEnrollStatus(prev => ({ ...prev, [employeeId]: 'error' }))
        setEnrollMsg(prev => ({ ...prev, [employeeId]: data.message || 'Enrollment failed' }))
        showToast('error', 'Enrollment Failed', data.message || 'Could not start enrollment')
      }
    } catch (error) {
      console.error('Enrollment error:', error)
      setEnrollStatus(prev => ({ ...prev, [employeeId]: 'error' }))
      setEnrollMsg(prev => ({ ...prev, [employeeId]: 'Network error' }))
      showToast('error', 'Enrollment Failed', 'Could not reach the server')
    }
  }



  const downloadTemplate = () => {
    const headers = [
      'First Name', 'Last Name', 'Middle Name', 'Suffix', 'Gender',
      'Date of Birth', 'Email', 'Role', 'Department', 'Position',
      'Branch', 'Contact Number', 'Employee Number', 'Hire Date',
      'Employment Status', 'Shift ID'
    ]
    const exampleRow = [
      'John', 'Doe', 'Smith', 'Jr.', 'Male',
      '1990-01-15', 'john@example.com', 'USER', 'Engineering', 'Developer',
      'Main Office', '09123456789', 'EMP-001', '2024-01-15',
      'ACTIVE', ''
    ]
    const worksheet = XLSX.utils.aoa_to_sheet([headers, exampleRow])
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Employees')
    XLSX.writeFile(workbook, 'Employee_Import_Template.xlsx')
  }

  const handleImport = async () => {
    if (!importFile) return
    setIsImporting(true)
    setImportResult(null)

    try {
      const data = await importFile.arrayBuffer()
      const workbook = XLSX.read(data)
      const worksheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' })

      if (rows.length === 0) {
        showToast('error', 'Import Failed', 'The file contains no data rows')
        setIsImporting(false)
        return
      }

      const employees = rows.map((row: any) => ({
        firstName: row['First Name'] || row['FirstName'] || row['firstName'] || '',
        lastName: row['Last Name'] || row['LastName'] || row['lastName'] || '',
        middleName: row['Middle Name'] || row['MiddleName'] || row['middleName'] || null,
        suffix: row['Suffix'] || row['suffix'] || null,
        gender: row['Gender'] || row['gender'] || null,
        dateOfBirth: row['Date of Birth'] || row['DateOfBirth'] || row['dateOfBirth'] || null,
        email: row['Email'] || row['email'] || null,
        role: row['Role'] || row['role'] || 'USER',
        department: row['Department'] || row['department'] || null,
        position: row['Position'] || row['position'] || null,
        branch: row['Branch'] || row['branch'] || null,
        contactNumber: row['Contact Number'] || row['ContactNumber'] || row['contactNumber'] || null,
        employeeNumber: row['Employee Number'] || row['EmployeeNumber'] || row['employeeNumber'] || null,
        hireDate: row['Hire Date'] || row['HireDate'] || row['hireDate'] || null,
        employmentStatus: row['Employment Status'] || row['EmploymentStatus'] || row['employmentStatus'] || 'ACTIVE',
        shiftId: row['Shift ID'] || row['ShiftId'] || row['shiftId'] ? parseInt(row['Shift ID'] || row['ShiftId'] || row['shiftId'], 10) : null,
      }))

      const res = await fetch('/api/employees/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ employees }),
      })

      const result = await res.json()

      if (result.imported?.length > 0) {
        showToast('success', 'Import Complete', `${result.imported.length} employee(s) imported successfully`)
        if (result.errors?.length > 0) {
          showToast('warning', 'Partial Import', `${result.errors.length} row(s) had errors`)
        }
        await fetchEmployees()
      } else {
        showToast('error', 'Import Failed', result.errors?.[0]?.errors?.join(', ') || 'No valid rows found')
      }

      setImportResult({ imported: result.imported || [], errors: result.errors || [] })
    } catch (error) {
      console.error('Import error:', error)
      showToast('error', 'Import Failed', 'An unexpected error occurred')
    } finally {
      setIsImporting(false)
    }
  }



  const [newEmployee, setNewEmployee] = useState({
    employeeNumber: '',
    firstName: '',
    lastName: '',
    middleName: '',
    suffix: '',
    contactNumber: '',
    department: '',
    branch: '',
    email: '',
    hireDate: '',
    shiftId: '',
    gender: '',
    dateOfBirth: '',
  })
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [isRegistering, setIsRegistering] = useState(false)
  const [emailChecking, setEmailChecking] = useState(false)

  const [currentPage, setCurrentPage] = useState(1)
  const rowsPerPage = 10

  const [departments, setDepartments] = useState<Department[]>([])
  const [branches, setBranches] = useState<Branch[]>([])
  const [shifts, setShifts] = useState<ShiftOption[]>([])

  const fetchShifts = async () => {
    try {
      const res = await fetch('/api/shifts', { credentials: 'include' })
      const data = await res.json()
      if (data.success) setShifts(data.shifts.filter((s: ShiftOption) => s))
    } catch (error) {
      console.error('Error fetching shifts:', error)
    }
  }

  const fetchBranches = async () => {
    try {
      const data = await branchesApi.getAll()
      if (data.success) setBranches(data.branches)
    } catch (error) {
      console.error('Error fetching branches:', error)
    }
  }

  const fetchDepartments = async () => {
    try {
      const data = await departmentsApi.getAll()
      if (data.success) setDepartments(data.departments)
    } catch (error) {
      console.error('Error fetching departments:', error)
    }
  }

  const fetchEmployees = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/employees')
      if (res.status === 401) {
        window.location.href = '/login'
        return
      }
      const data = await res.json()
      if (data.success) {
        // Active employees page only shows ACTIVE USER-role employees
        setEmployees(data.employees.filter((e: Employee) => e.employmentStatus === 'ACTIVE' && e.role === 'USER'))
      }
    } catch (error) {
      console.error('Error fetching employees:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchEmployees()
    fetchBranches()
    fetchDepartments()
    fetchShifts()
  }, [])

  // Countdown timer for Scan Now modal
  useEffect(() => {
    if (!scanModal.open) return
    if (scanModal.countdown <= 0) {
      setScanModal(prev => ({ ...prev, open: false }))
      return
    }
    const timer = setTimeout(() => {
      setScanModal(prev => ({ ...prev, countdown: prev.countdown - 1 }))
    }, 1000)
    return () => clearTimeout(timer)
  }, [scanModal.open, scanModal.countdown])

  const filteredEmployees = employees.filter(emp => {
    const fullName = formatFullName(emp.firstName, emp.middleName, emp.lastName, emp.suffix).toLowerCase()
    const matchesSearch = fullName.includes(searchTerm.toLowerCase()) || (emp.contactNumber || '').toLowerCase().includes(searchTerm.toLowerCase())
    // Resolve effective department name from relation or string field
    const empDept = emp.Department?.name || emp.department || ''
    const matchesDept = selectedDept === 'all' || empDept === selectedDept
    const matchesBranch = selectedBranch === 'all' || emp.branch === selectedBranch
    return matchesSearch && matchesDept && matchesBranch
  })

  const { sortedData: paginatedSource, sortKey, sortOrder, handleSort } = useTableSort<Employee>({
    initialData: filteredEmployees
  })

  const totalPages = Math.ceil(paginatedSource.length / rowsPerPage)
  const paginatedEmployees = paginatedSource.slice(
    (currentPage - 1) * rowsPerPage,
    currentPage * rowsPerPage
  )

  const handleAddEmployee = async () => {
    // Validate required fields
    const errors: Record<string, string> = {}
    
    const empIdValidation = validateEmployeeId(newEmployee.employeeNumber);
    if (!empIdValidation.isValid) errors.employeeNumber = empIdValidation.error!;
    
    if (!newEmployee.firstName.trim()) errors.firstName = 'First name is required'
    if (!newEmployee.lastName.trim()) errors.lastName = 'Last name is required'
    if (!newEmployee.contactNumber.trim()) errors.contactNumber = 'Contact number is required'
    else if (newEmployee.contactNumber.replace(/\D/g, '').length !== 11) errors.contactNumber = 'Must be exactly 11 digits'
    if (!newEmployee.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmployee.email.trim())) errors.email = 'A valid email is required'
    if (formErrors.email && formErrors.email.includes('already in use')) errors.email = formErrors.email
    if (!newEmployee.department) errors.department = 'Department is required'
    if (!newEmployee.branch) errors.branch = 'Branch is required'
    if (Object.keys(errors).length > 0) { setFormErrors(errors); return }
    setFormErrors({})
    setIsRegistering(true)

    try {
      const res = await fetch('/api/employees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          employeeNumber: newEmployee.employeeNumber,
          firstName: newEmployee.firstName,
          lastName: newEmployee.lastName,
          middleName: newEmployee.middleName || undefined,
          suffix: newEmployee.suffix || undefined,
          contactNumber: newEmployee.contactNumber || undefined,
          department: newEmployee.department,
          branch: newEmployee.branch,
          email: newEmployee.email || undefined,
          hireDate: newEmployee.hireDate || undefined,
          shiftId: newEmployee.shiftId ? parseInt(newEmployee.shiftId) : undefined,
          gender: newEmployee.gender || undefined,
          dateOfBirth: newEmployee.dateOfBirth || undefined,
        })
      })
      const data = await res.json()
      if (data.success) {
        await fetchEmployees()
        setNewEmployee({ employeeNumber: '', firstName: '', lastName: '', middleName: '', suffix: '', contactNumber: '', department: '', branch: '', email: '', hireDate: '', shiftId: '', gender: '', dateOfBirth: '' })
        setFormErrors({})
        setIsAddOpen(false)
        // Show toast based on device sync result
        const name = `${data.employee?.firstName || ''} ${data.employee?.lastName || ''}`.trim()
        if (data.deviceSync?.success === false) {
          // Explicit failure (device was tried synchronously and failed)
          showToast('warning', 'Registered — Device Offline',
            `${name} was saved but couldn't sync to the device. Use the 🔵 fingerprint button when the device is back online.`)
        } else {
          // success === true (synced immediately) OR success === null (background sync running)
          showToast('success', 'Employee Registered',
            `${name} has been saved and login credentials were sent to their email. Device sync running in background.`)
        }
      } else {
        showToast('error', 'Registration Failed', data.message || 'Unknown error')
      }
    } catch (error) {
      console.error('Error adding employee:', error)
      showToast('error', 'Registration Failed', 'Could not reach the server. Please try again.')
    } finally {
      setIsRegistering(false)
    }
  }

  const handleMoveToInactive = async () => {
    if (!confirmDeactivate) return
    setIsDeactivating(true)
    try {
      const res = await fetch(`/api/employees/${confirmDeactivate.id}`, {
        method: 'DELETE',
      })
      const data = await res.json()
      if (data.success) {
        await fetchEmployees()
        setConfirmDeactivate(null)
      } else {
        alert('Failed to deactivate employee: ' + (data.message || 'Unknown error'))
      }
    } catch (error) {
      console.error('Error deactivating employee:', error)
      alert('Failed to deactivate employee')
    } finally {
      setIsDeactivating(false)
    }
  }

  const handleResetPassword = async () => {
    if (!confirmResetPassword) return
    setIsResettingPassword(true)
    try {
      const res = await fetch(`/api/employees/${confirmResetPassword.id}/reset-password`, {
        method: 'POST',
      })
      const data = await res.json()
      if (data.success) {
        showToast('success', 'Password Reset', data.message || 'Password has been reset successfully.')
        setConfirmResetPassword(null)
      } else {
        showToast('error', 'Reset Failed', data.message || 'Failed to reset password.')
      }
    } catch (error) {
      console.error('Error resetting password:', error)
      showToast('error', 'Reset Failed', 'Network error. Please try again.')
    } finally {
      setIsResettingPassword(false)
    }
  }

  const handleEdit = (employee: Employee) => {
    setEditingEmployee(employee)
    setEditForm({ ...employee })
  }

  const handleUpdateEmployee = async () => {
    if (!editingEmployee || !editForm) return

    if (editForm.employeeNumber !== undefined) {
      const empIdValidation = validateEmployeeId(editForm.employeeNumber);
      if (!empIdValidation.isValid) {
        showToast('error', 'Validation Error', empIdValidation.error!);
        return;
      }
    }

    try {
      const res = await fetch(`/api/employees/${editingEmployee.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm)
      })
      const data = await res.json()
      if (data.success) {
        await fetchEmployees()
        setEditingEmployee(null)
      } else {
        alert('Failed to update employee: ' + (data.message || 'Unknown error'))
      }
    } catch (error) {
      console.error('Error updating employee:', error)
      alert('Failed to update employee')
    }
  }

  return (
    <div className="space-y-6">
      {/* Edit Employee Modal */}
      {editingEmployee && (
        <div className="fixed inset-0 bg-slate-950/40 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-5 bg-red-600 text-white flex justify-between items-center shrink-0">
              <div>
                <h3 className="font-bold text-lg leading-tight tracking-tight">Edit Employee Profile</h3>
                <p className="text-[10px] text-red-100 opacity-90 uppercase font-black tracking-widest mt-0.5">Update employee info</p>
              </div>
              <button onClick={() => setEditingEmployee(null)} className="text-white/80 hover:text-white transition-colors">
                <XIcon className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-4 overflow-y-auto">
              <div className="space-y-1">
                <label className="text-[9px] font-black uppercase text-slate-400 tracking-wider">Employee ID *</label>
                <input type="text" placeholder="e.g. 10001" value={editForm.employeeNumber || ''} onChange={(e) => setEditForm({ ...editForm, employeeNumber: e.target.value })} className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-red-500/20" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[9px] font-black uppercase text-slate-400 tracking-wider">First Name</label>
                  <input type="text" value={editForm.firstName || ''} onChange={(e) => setEditForm({ ...editForm, firstName: e.target.value })} className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-red-500/20" />
                </div>
                <div className="space-y-1">
                  <label className="text-[9px] font-black uppercase text-slate-400 tracking-wider">Last Name</label>
                  <input type="text" value={editForm.lastName || ''} onChange={(e) => setEditForm({ ...editForm, lastName: e.target.value })} className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-red-500/20" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[9px] font-black uppercase text-slate-400 tracking-wider">Middle Name</label>
                  <input type="text" placeholder="Optional" value={(editForm as any).middleName || ''} onChange={(e) => setEditForm({ ...editForm, middleName: e.target.value } as any)} className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-red-500/20" />
                </div>
                <div className="space-y-1">
                  <label className="text-[9px] font-black uppercase text-slate-400 tracking-wider">Suffix</label>
                  <select value={(editForm as any).suffix || ''} onChange={(e) => setEditForm({ ...editForm, suffix: e.target.value } as any)} className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-red-500/20">
                    <option value="">None</option>
                    {SUFFIX_OPTIONS.filter(Boolean).map(s => (<option key={s} value={s}>{s}</option>))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[9px] font-black uppercase text-slate-400 tracking-wider">Gender</label>
                  <select value={(editForm as any).gender || ''} onChange={(e) => setEditForm({ ...editForm, gender: e.target.value } as any)} className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-red-500/20">
                    <option value="">Select Gender</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Prefer not to say">Prefer not to say</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[9px] font-black uppercase text-slate-400 tracking-wider">Date of Birth</label>
                  <input type="date" value={(editForm as any).dateOfBirth ? (editForm as any).dateOfBirth.split('T')[0] : ''} onChange={(e) => setEditForm({ ...editForm, dateOfBirth: e.target.value } as any)} className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-red-500/20" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[9px] font-black uppercase text-slate-400 tracking-wider">Email Address</label>
                  <input type="email" value={editForm.email || ''}
                    onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                    onBlur={async () => {
                      const email = (editForm.email || '').trim()
                      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return
                      try {
                        const res = await fetch(`/api/employees/check-email?email=${encodeURIComponent(email)}&excludeId=${editingEmployee!.id}`, { credentials: 'include' })
                        const data = await res.json()
                        if (data.success && !data.available) {
                          showToast('error', 'Email Taken', '⚠️ This email address is already in use by another employee.')
                        }
                      } catch (e) { console.error('Email check failed:', e) }
                    }}
                    className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-red-500/20" />
                </div>
                <div className="space-y-1">
                  <label className="text-[9px] font-black uppercase text-slate-400 tracking-wider">Contact Number</label>
                  <input type="tel" maxLength={13} value={editForm.contactNumber || ''} onChange={(e) => {
                    const val = formatPhoneNumber(e.target.value)
                    setEditForm({ ...editForm, contactNumber: val })
                  }} className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-red-500/20" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[9px] font-black uppercase text-slate-400 tracking-wider">Department</label>
                  <select value={editForm.department || ''} onChange={(e) => setEditForm({ ...editForm, department: e.target.value })} className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-red-500/20">
                    <option value="" disabled>Select Department</option>
                    {departments.map(d => (<option key={d.id} value={d.name}>{d.name}</option>))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[9px] font-black uppercase text-slate-400 tracking-wider">Branch</label>
                  <select value={editForm.branch || ''} onChange={(e) => setEditForm({ ...editForm, branch: e.target.value })} className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-red-500/20">
                    <option value="" disabled>Select Branch</option>
                    {branches.map(b => (<option key={b.id} value={b.name}>{b.name}</option>))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[9px] font-black uppercase text-slate-400 tracking-wider">Date Hired</label>
                  <input type="date" value={editForm.hireDate || ''} onChange={(e) => setEditForm({ ...editForm, hireDate: e.target.value })} className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-red-500/20" />
                </div>
                <div className="space-y-3 px-6">
                  <label className="text-[9px] font-black uppercase text-slate-400 tracking-wider">Status</label>
                  <div className="flex items-center gap-6 px-1 py-1">
                    <label className="flex items-center gap-2 cursor-pointer group">
                      <div className="relative flex items-center justify-center">
                        <input type="radio" name="status" value="ACTIVE" checked={editForm.employmentStatus === 'ACTIVE'} onChange={(e) => setEditForm({ ...editForm, employmentStatus: e.target.value as Employee['employmentStatus'] })} className="peer appearance-none w-4 h-4 border-2 border-slate-300 rounded-full checked:border-red-600 transition-all cursor-pointer" />
                        <div className="absolute w-2 h-2 bg-red-600 rounded-full opacity-0 peer-checked:opacity-100 transition-opacity pointer-events-none" />
                      </div>
                      <span className="text-xs font-bold text-slate-600 group-hover:text-slate-900 transition-colors">Active</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer group">
                      <div className="relative flex items-center justify-center">
                        <input type="radio" name="status" value="INACTIVE" checked={editForm.employmentStatus === 'INACTIVE'} onChange={(e) => setEditForm({ ...editForm, employmentStatus: e.target.value as Employee['employmentStatus'] })} className="peer appearance-none w-4 h-4 border-2 border-slate-300 rounded-full checked:border-red-600 transition-all cursor-pointer" />
                        <div className="absolute w-2 h-2 bg-red-600 rounded-full opacity-0 peer-checked:opacity-100 transition-opacity pointer-events-none" />
                      </div>
                      <span className="text-xs font-bold text-slate-600 group-hover:text-slate-900 transition-colors">Inactive</span>
                    </label>
                  </div>
                </div>
              </div>

              {/* Work Shift */}
              <div className="space-y-1">
                <label className="text-[9px] font-black uppercase text-slate-400 tracking-wider">Work Shift</label>
                <select
                  value={(editForm as any).shiftId || ''}
                  onChange={(e) => setEditForm({ ...editForm, shiftId: e.target.value ? parseInt(e.target.value) : null } as any)}
                  className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-700 outline-none focus:ring-2 focus:ring-red-500/20"
                >
                  <option value="">No shift assigned</option>
                  {shifts.map(s => (
                    <option key={s.id} value={s.id}>[{s.shiftCode}] {s.name} ({formatTime(s.startTime)} – {formatTime(s.endTime)})</option>
                  ))}
                </select>
              </div>

              <div className="bg-amber-50 border border-amber-100 p-3 rounded-xl flex gap-3 shadow-sm shadow-amber-600/5">
                <AlertCircle size={18} className="text-amber-600 shrink-0" />
                <div className="text-[10px] text-amber-800 leading-relaxed font-medium">
                  <strong className="block mb-0.5 tracking-tight uppercase">Audit Log Notice</strong>
                  <strong>Warning:</strong> These changes will be logged under your account for audit purposes.
                </div>
              </div>
            </div>

            <div className="p-5 bg-slate-50 flex gap-3 shrink-0">
              <button onClick={() => setEditingEmployee(null)} className="flex-1 px-4 py-3.5 text-sm font-bold text-slate-500 hover:text-slate-800 transition-colors">Cancel</button>
              <button onClick={handleUpdateEmployee} className="flex-1 px-4 py-3.5 bg-red-600 text-white rounded-xl text-sm font-black shadow-lg shadow-red-600/30 hover:bg-red-700 transition-all active:scale-95">Update</button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Move-to-Inactive Dialog */}
      {confirmDeactivate && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/40 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-2xl shadow-2xl p-6 max-w-sm w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground">Move to Inactive?</h3>
                <p className="text-sm text-muted-foreground">This action can be undone from the Inactive list.</p>
              </div>
            </div>
            <p className="text-sm text-foreground mb-6">
              <span className="font-medium">{confirmDeactivate.firstName} {confirmDeactivate.lastName}</span> will be moved to the Inactive employee list and removed from the active roster.
            </p>
            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1 border-border text-foreground hover:bg-secondary"
                onClick={() => setConfirmDeactivate(null)}
                disabled={isDeactivating}
              >
                Cancel
              </Button>
              <Button
                className="flex-1 bg-amber-500 hover:bg-amber-600 text-white"
                onClick={handleMoveToInactive}
                disabled={isDeactivating}
              >
                {isDeactivating ? 'Moving...' : 'Move to Inactive'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Reset Password Dialog */}
      {confirmResetPassword && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/40 backdrop-blur-sm">
          <div className="bg-card border border-border rounded-2xl shadow-2xl p-6 max-w-sm w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center shrink-0">
                <Key className="w-5 h-5 text-red-500" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground">Reset Password?</h3>
                <p className="text-sm text-muted-foreground">This will generate a new password.</p>
              </div>
            </div>
            <p className="text-sm text-foreground mb-6">
              Are you sure you want to reset the password for <span className="font-medium">{confirmResetPassword.firstName} {confirmResetPassword.lastName}</span>? 
              A new temporary password will be sent to their email.
            </p>
            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1 border-border text-foreground hover:bg-secondary"
                onClick={() => setConfirmResetPassword(null)}
                disabled={isResettingPassword}
              >
                Cancel
              </Button>
              <Button
                className="flex-1 bg-red-600 hover:bg-red-700 text-white"
                onClick={handleResetPassword}
                disabled={isResettingPassword}
              >
                {isResettingPassword ? 'Resetting...' : 'Reset Password'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notifications */}
      <div className="fixed top-5 right-5 z-9999 flex flex-col gap-2 w-80 pointer-events-none">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`flex items-start gap-3 px-4 py-3 rounded-xl shadow-lg border pointer-events-auto animate-in slide-in-from-right-8 duration-300
              ${t.type === 'success' ? 'bg-white border-green-200' : t.type === 'warning' ? 'bg-white border-amber-200' : 'bg-white border-red-200'}`}
          >
            <span className={`mt-0.5 text-lg shrink-0 ${t.type === 'success' ? 'text-green-500' : t.type === 'warning' ? 'text-amber-500' : 'text-red-500'}`}>
              {t.type === 'success' ? '✅' : t.type === 'warning' ? '⚠️' : '❌'}
            </span>
            <div className="flex-1 min-w-0">
              <p className={`text-xs font-bold ${t.type === 'success' ? 'text-green-700' : t.type === 'warning' ? 'text-amber-700' : 'text-red-700'}`}>{t.title}</p>
              <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{t.message}</p>
            </div>
            <button
              onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
              className="text-slate-300 hover:text-slate-500 transition-colors shrink-0 mt-0.5"
            >
              <XIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <div>
          <h2 className="text-2xl sm:text-3xl font-bold text-foreground">Active Employees</h2>
          <p className="text-muted-foreground text-sm mt-1">Manage your active workforce and employee records</p>
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          {/* Import Excel Button */}
          <Dialog open={isImportOpen} onOpenChange={(open) => { setIsImportOpen(open); if (!open) { setImportFile(null); setImportResult(null); } }}>
            <DialogTrigger asChild>
              <Button variant="outline" className="flex-1 sm:flex-none border-border text-foreground hover:bg-red-700 gap-2">
                <Upload className="w-4 h-4" />
                <span className="hidden xs:inline">Import</span> Excel
              </Button>
            </DialogTrigger>
            <DialogContent showCloseButton={false} className="bg-white border-0 max-w-md p-0 rounded-2xl overflow-hidden shadow-xl">
              <div className="bg-red-600 px-6 py-4 flex items-center justify-between">
                <div>
                  <DialogTitle className="text-white font-bold text-lg">Import Employees</DialogTitle>
                  <DialogDescription className="text-white/80 text-[10px] uppercase tracking-widest font-bold mt-1">Upload from Excel or CSV</DialogDescription>
                </div>
                <button onClick={() => { setIsImportOpen(false); setImportFile(null); setImportResult(null); }} className="text-white/80 hover:text-white transition-colors">
                  <XIcon className="w-5 h-5" />
                </button>
              </div>
              <div className="px-6 py-5 space-y-4">
                <p className="text-sm text-slate-500 font-medium">
                  Upload an Excel file (.xlsx, .xls) or CSV (.csv) to bulk import employee records.
                </p>
                <div className="border-2 border-dashed border-slate-200 rounded-xl p-6 text-center hover:border-red-300 transition-colors">
                  <Upload className="w-8 h-8 mx-auto text-slate-300 mb-2" />
                  <label htmlFor="excel-upload" className="cursor-pointer">
                    <span className="text-sm text-red-500 font-bold hover:underline">Click to select file</span>
                    <input
                      id="excel-upload"
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) { setImportFile(file); setImportResult(null); }
                      }}
                    />
                  </label>
                  <p className="text-xs text-slate-400 mt-1">Supports .xlsx, .xls, .csv</p>
                </div>
                {importFile && (
                  <div className="flex items-center gap-2 p-3 bg-slate-50 rounded-xl">
                    <Upload className="w-4 h-4 text-red-500" />
                    <span className="text-sm text-slate-700 font-medium flex-1 truncate">{importFile.name}</span>
                    <span className="text-xs text-slate-400">{(importFile.size / 1024).toFixed(1)} KB</span>
                  </div>
                )}
                {importResult && (
                  <div className="space-y-3">
                    {importResult.imported.length > 0 && (
                      <div className="p-4 bg-green-50 rounded-xl">
                        <p className="text-sm font-bold text-green-700">
                          ✓ {importResult.imported.length} employee(s) imported
                        </p>
                      </div>
                    )}
                    {importResult.errors.length > 0 && (
                      <div className="p-4 bg-red-50 rounded-xl max-h-48 overflow-y-auto">
                        <p className="text-sm font-bold text-red-700 mb-2">
                          ✗ {importResult.errors.length} row(s) failed
                        </p>
                        {importResult.errors.map((err: any, i: number) => (
                          <p key={i} className="text-xs text-red-600 mb-1">
                            Row {err.row + 2}: {err.data?.firstName || 'Unknown'} — {err.errors.join(', ')}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div className="text-center">
                  <button
                    onClick={downloadTemplate}
                    className="text-sm text-red-500 font-bold hover:underline"
                  >
                    Download Template
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-center gap-6 px-6 py-4 border-t border-slate-100">
                <button
                  className="text-sm font-bold text-slate-400 hover:text-slate-600 transition-colors"
                  onClick={() => { setIsImportOpen(false); setImportFile(null); setImportResult(null); }}
                >
                  Discard
                </button>
                <button
                  className="px-8 py-2.5 bg-red-600 hover:bg-red-700 text-white text-sm font-bold rounded-xl transition-colors disabled:opacity-50"
                  disabled={!importFile || isImporting}
                  onClick={handleImport}
                >
                  {isImporting ? 'Importing...' : 'Upload & Import'}
                </button>
              </div>
            </DialogContent>
          </Dialog>

          {/* Add Employee Button */}
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button className="flex-1 sm:flex-none bg-primary hover:bg-primary/90 gap-2">
                <Plus className="w-4 h-4" />
                Add Employee
              </Button>
            </DialogTrigger>
            <DialogContent showCloseButton={false} className="bg-white border-0 max-w-lg p-0 rounded-2xl overflow-hidden shadow-xl">
              <div className="bg-red-600 px-6 py-4 flex items-center justify-between">
                <div>
                  <DialogTitle className="text-white font-bold text-lg">New Employee Registration</DialogTitle>
                  <DialogDescription className="text-white/80 text-[10px] uppercase tracking-widest font-bold mt-1">Add to employee directory</DialogDescription>
                </div>
                <button onClick={() => setIsAddOpen(false)} className="text-white/80 hover:text-white transition-colors">
                  <XIcon className="w-5 h-5" />
                </button>
              </div>
              <div className="px-6 py-5 space-y-4">
                <div className="grid grid-cols-1 gap-4">
                  <div>
                    <label className="text-slate-400 text-[10px] uppercase tracking-widest font-bold">Employee ID *</label>
                    <input
                      placeholder="e.g. 10001"
                      className={`mt-1.5 w-full px-3 py-2.5 rounded-xl border ${formErrors.employeeNumber ? 'border-red-400 bg-red-50' : 'border-slate-200 bg-white'} text-sm font-medium text-slate-700 placeholder:text-slate-300 focus:ring-2 focus:ring-red-500/20 outline-none transition-all`}
                      value={newEmployee.employeeNumber}
                      onChange={(e) => { setNewEmployee({ ...newEmployee, employeeNumber: e.target.value }); setFormErrors(p => ({ ...p, employeeNumber: '' })) }}
                    />
                    {formErrors.employeeNumber && <p className="mt-1 text-[11px] text-red-500 font-semibold">{formErrors.employeeNumber}</p>}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-slate-400 text-[10px] uppercase tracking-widest font-bold">First Name *</label>
                    <input
                      placeholder="First Name"
                      className={`mt-1.5 w-full px-3 py-2.5 rounded-xl border ${formErrors.firstName ? 'border-red-400 bg-red-50' : 'border-slate-200 bg-white'} text-sm font-medium text-slate-700 placeholder:text-slate-300 focus:ring-2 focus:ring-red-500/20 outline-none transition-all`}
                      value={newEmployee.firstName}
                      onChange={(e) => { setNewEmployee({ ...newEmployee, firstName: e.target.value }); setFormErrors(p => ({ ...p, firstName: '' })) }}
                    />
                    {formErrors.firstName && <p className="mt-1 text-[11px] text-red-500 font-semibold">{formErrors.firstName}</p>}
                  </div>
                  <div>
                    <label className="text-slate-400 text-[10px] uppercase tracking-widest font-bold">Last Name *</label>
                    <input
                      placeholder="Last Name"
                      className={`mt-1.5 w-full px-3 py-2.5 rounded-xl border ${formErrors.lastName ? 'border-red-400 bg-red-50' : 'border-slate-200 bg-white'} text-sm font-medium text-slate-700 placeholder:text-slate-300 focus:ring-2 focus:ring-red-500/20 outline-none transition-all`}
                      value={newEmployee.lastName}
                      onChange={(e) => { setNewEmployee({ ...newEmployee, lastName: e.target.value }); setFormErrors(p => ({ ...p, lastName: '' })) }}
                    />
                    {formErrors.lastName && <p className="mt-1 text-[11px] text-red-500 font-semibold">{formErrors.lastName}</p>}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-slate-400 text-[10px] uppercase tracking-widest font-bold">Middle Name</label>
                    <input
                      placeholder="Middle Name (optional)"
                      className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-700 placeholder:text-slate-300 focus:ring-2 focus:ring-red-500/20 outline-none transition-all"
                      value={newEmployee.middleName}
                      onChange={(e) => setNewEmployee({ ...newEmployee, middleName: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="text-slate-400 text-[10px] uppercase tracking-widest font-bold">Suffix</label>
                    <select
                      className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-700 focus:ring-2 focus:ring-red-500/20 outline-none cursor-pointer transition-all appearance-none"
                      value={newEmployee.suffix}
                      onChange={(e) => setNewEmployee({ ...newEmployee, suffix: e.target.value })}
                    >
                      <option value="">None</option>
                      {SUFFIX_OPTIONS.filter(Boolean).map(s => (<option key={s} value={s}>{s}</option>))}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-slate-400 text-[10px] uppercase tracking-widest font-bold">Gender</label>
                    <select
                      className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-700 focus:ring-2 focus:ring-red-500/20 outline-none cursor-pointer transition-all appearance-none"
                      value={newEmployee.gender}
                      onChange={(e) => setNewEmployee({ ...newEmployee, gender: e.target.value })}
                    >
                      <option value="">Select Gender</option>
                      <option value="Male">Male</option>
                      <option value="Female">Female</option>
                      <option value="Prefer not to say">Prefer not to say</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-slate-400 text-[10px] uppercase tracking-widest font-bold">Date of Birth</label>
                    <input
                      type="date"
                      className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-700 focus:ring-2 focus:ring-red-500/20 outline-none transition-all"
                      value={newEmployee.dateOfBirth}
                      onChange={(e) => setNewEmployee({ ...newEmployee, dateOfBirth: e.target.value })}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-slate-400 text-[10px] uppercase tracking-widest font-bold">Email Address *</label>
                    <input
                      type="email"
                      placeholder="example@email.com"
                      className={`mt-1.5 w-full px-3 py-2.5 rounded-xl border ${formErrors.email ? 'border-red-400 bg-red-50' : 'border-slate-200 bg-white'} text-sm font-medium text-slate-700 placeholder:text-slate-300 focus:ring-2 focus:ring-red-500/20 outline-none transition-all`}
                      value={newEmployee.email}
                      onChange={(e) => { setNewEmployee({ ...newEmployee, email: e.target.value }); setFormErrors(p => ({ ...p, email: '' })) }}
                      onBlur={async () => {
                        const email = newEmployee.email.trim()
                        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return
                        setEmailChecking(true)
                        try {
                          const res = await fetch(`/api/employees/check-email?email=${encodeURIComponent(email)}`, { credentials: 'include' })
                          const data = await res.json()
                          if (data.success && !data.available) {
                            setFormErrors(p => ({ ...p, email: '⚠️ This email address is already in use. Please use a different email address.' }))
                          }
                        } catch (e) { console.error('Email check failed:', e) }
                        finally { setEmailChecking(false) }
                      }}
                    />
                    {formErrors.email && <p className="mt-1 text-[11px] text-red-500 font-semibold">{formErrors.email}</p>}
                  </div>
                  <div>
                    <label className="text-slate-400 text-[10px] uppercase tracking-widest font-bold">Contact Number *</label>
                    <input
                      type="tel"
                      placeholder="09XX XXX XXXX"
                      maxLength={13}
                      className={`mt-1.5 w-full px-3 py-2.5 rounded-xl border ${formErrors.contactNumber ? 'border-red-400 bg-red-50' : 'border-slate-200 bg-white'} text-sm font-medium text-slate-700 placeholder:text-slate-300 focus:ring-2 focus:ring-red-500/20 outline-none transition-all`}
                      value={newEmployee.contactNumber}
                      onChange={(e) => {
                        const val = formatPhoneNumber(e.target.value)
                        setNewEmployee({ ...newEmployee, contactNumber: val })
                        setFormErrors(p => ({ ...p, contactNumber: '' }))
                      }}
                    />
                    {formErrors.contactNumber && <p className="mt-1 text-[11px] text-red-500 font-semibold">{formErrors.contactNumber}</p>}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-slate-400 text-[10px] uppercase tracking-widest font-bold">Department *</label>
                    <select
                      className={`mt-1.5 w-full px-3 py-2.5 rounded-xl border ${formErrors.department ? 'border-red-400 bg-red-50' : 'border-slate-200 bg-white'} text-sm font-medium text-slate-700 focus:ring-2 focus:ring-red-500/20 outline-none cursor-pointer transition-all appearance-none`}
                      value={newEmployee.department}
                      onChange={(e) => { setNewEmployee({ ...newEmployee, department: e.target.value }); setFormErrors(p => ({ ...p, department: '' })) }}
                    >
                      <option value="" disabled>e.g. Human Resources</option>
                      {departments.map(dept => (
                        <option key={dept.id} value={dept.name}>{dept.name}</option>
                      ))}
                    </select>
                    {formErrors.department && <p className="mt-1 text-[11px] text-red-500 font-semibold">{formErrors.department}</p>}
                  </div>
                  <div>
                    <label className="text-slate-400 text-[10px] uppercase tracking-widest font-bold">Branch *</label>
                    <select
                      className={`mt-1.5 w-full px-3 py-2.5 rounded-xl border ${formErrors.branch ? 'border-red-400 bg-red-50' : 'border-slate-200 bg-white'} text-sm font-medium text-slate-700 focus:ring-2 focus:ring-red-500/20 outline-none cursor-pointer transition-all appearance-none`}
                      value={newEmployee.branch}
                      onChange={(e) => { setNewEmployee({ ...newEmployee, branch: e.target.value }); setFormErrors(p => ({ ...p, branch: '' })) }}
                    >
                      <option value="" disabled>e.g. Cebu City</option>
                      {branches.map(branch => (
                        <option key={branch.id} value={branch.name}>{branch.name}</option>
                      ))}
                    </select>
                    {formErrors.branch && <p className="mt-1 text-[11px] text-red-500 font-semibold">{formErrors.branch}</p>}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-slate-400 text-[10px] uppercase tracking-widest font-bold">Date Hired</label>
                    <input
                      type="date"
                      className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-700 focus:ring-2 focus:ring-red-500/20 outline-none transition-all"
                      value={newEmployee.hireDate}
                      onChange={(e) => setNewEmployee({ ...newEmployee, hireDate: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="text-slate-400 text-[10px] uppercase tracking-widest font-bold">Work Shift</label>
                    <select
                      className="mt-1.5 w-full px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-medium text-slate-700 focus:ring-2 focus:ring-red-500/20 outline-none cursor-pointer transition-all appearance-none"
                      value={newEmployee.shiftId}
                      onChange={(e) => setNewEmployee({ ...newEmployee, shiftId: e.target.value })}
                    >
                      <option value="">No shift assigned</option>
                      {shifts.map(s => (
                        <option key={s.id} value={s.id}>[{s.shiftCode}] {s.name} ({formatTime(s.startTime)} – {formatTime(s.endTime)})</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-center gap-6 px-6 py-4 border-t border-slate-100">
                <button
                  className="text-sm font-bold text-slate-400 hover:text-slate-600 transition-colors"
                  onClick={() => {
                    setNewEmployee({ employeeNumber: '', firstName: '', lastName: '', middleName: '', suffix: '', contactNumber: '', department: '', branch: '', email: '', hireDate: '', shiftId: '', gender: '', dateOfBirth: '' })
                    setFormErrors({})
                    setIsAddOpen(false)
                  }}
                >
                  Discard
                </button>
                <button onClick={handleAddEmployee} disabled={isRegistering || emailChecking} className="px-8 py-2.5 bg-red-600 hover:bg-red-700 disabled:bg-red-400 text-white text-sm font-bold rounded-xl transition-colors flex items-center gap-2">
                  {isRegistering ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Registering...
                    </>
                  ) : 'Register Employee'}
                </button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Filters */}
      <Card className="bg-card border-border p-4">
        <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
          <div className="flex-1 min-w-0">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or contact..."
                className="pl-10 bg-secondary border-border text-foreground placeholder:text-muted-foreground"
                value={searchTerm}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>
          <div className="flex gap-3 w-full sm:w-auto">
            <Select value={selectedDept} onValueChange={setSelectedDept}>
              <SelectTrigger className="flex-1 sm:w-48 bg-secondary border-border text-foreground">
                <SelectValue placeholder="Department" />
              </SelectTrigger>
              <SelectContent className="bg-secondary border-border">
                <SelectItem value="all">All Departments</SelectItem>
                {departments.map(dept => (
                  <SelectItem key={dept.id} value={dept.name}>{dept.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={selectedBranch} onValueChange={setSelectedBranch}>
              <SelectTrigger className="flex-1 sm:w-48 bg-secondary border-border text-foreground">
                <SelectValue placeholder="Branch" />
              </SelectTrigger>
              <SelectContent className="bg-secondary border-border">
                <SelectItem value="all">All Branches</SelectItem>
                {branches.map(branch => (
                  <SelectItem key={branch.id} value={branch.name}>{branch.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </Card>

      {/* Employees Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div ref={dragScrollRef} className="overflow-x-auto scrollbar-hide">
          <table className="w-full text-left text-sm min-w-[900px]">
            <thead className="bg-slate-50 text-slate-400 font-bold uppercase text-[10px] tracking-widest border-b border-slate-100">
              <tr>
                <SortableHeader label="ZK ID" sortKey="zkId" currentSortKey={sortKey} currentSortOrder={sortOrder} onSort={handleSort} className="px-4 py-4 w-20" />
                <SortableHeader label="Employee" sortKey="firstName" currentSortKey={sortKey} currentSortOrder={sortOrder} onSort={handleSort} className="px-6 py-4" />
                <SortableHeader label="Employee ID" sortKey="employeeNumber" currentSortKey={sortKey} currentSortOrder={sortOrder} onSort={handleSort} className="px-4 py-4" />
                <th className="px-4 py-4">Badge</th>
                <th className="px-4 py-4">Enrolled On</th>
                <SortableHeader label="Department" sortKey="department" currentSortKey={sortKey} currentSortOrder={sortOrder} onSort={handleSort} className="px-6 py-4" />
                <th className="px-6 py-4">Shift</th>
                <SortableHeader label="Branch" sortKey="branch" currentSortKey={sortKey} currentSortOrder={sortOrder} onSort={handleSort} className="px-6 py-4" />
                <SortableHeader label="Contact" sortKey="contactNumber" currentSortKey={sortKey} currentSortOrder={sortOrder} onSort={handleSort} className="px-6 py-4" />
                <SortableHeader label="Joined" sortKey="hireDate" currentSortKey={sortKey} currentSortOrder={sortOrder} onSort={handleSort} className="px-6 py-4" />
                <th className="px-6 py-4">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={11} className="px-6 py-12 text-center text-slate-400 font-bold text-xs">
                    Loading employees...
                  </td>
                </tr>
              ) : paginatedEmployees.length > 0 ? (
                paginatedEmployees.map((employee, index) => (
                  <tr key={employee.id} className="hover:bg-red-50/50 transition-colors duration-200 group">
                    {/* ZK ID - first column */}
                    <td className="px-4 py-3 text-xs text-muted-foreground font-mono">
                      {employee.zkId ?? '—'}
                    </td>
                    <td className="px-6 py-4">
                      <p className="font-bold text-slate-700">{formatFullName(employee.firstName, employee.middleName, employee.lastName, employee.suffix)}</p>
                      <p className="text-xs text-slate-400">{employee.email || '—'}</p>
                    </td>
                    {/* Employee ID (employeeNumber field) */}
                    <td className="px-4 py-3 text-xs text-muted-foreground font-mono">
                      {employee.employeeNumber ?? '—'}
                    </td>
                    {/* Badge (RFID Card Number) */}
                    <td className="px-4 py-3">
                      {employee.cardNumber ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-50 text-blue-600 border border-blue-100">
                          <CreditCard className="w-3 h-3" />
                          {employee.cardNumber}
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground italic">—</span>
                      )}
                    </td>
                    {/* Fingerprint Enrollment Badges */}
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {employee.EmployeeDeviceEnrollment && employee.EmployeeDeviceEnrollment.length > 0 ? (
                          employee.EmployeeDeviceEnrollment.map(enrollment => (
                            <span
                              key={enrollment.device.id}
                              title={`Enrolled on ${new Date(enrollment.enrolledAt).toLocaleDateString()}`}
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${enrollment.device.isActive
                                ? 'bg-green-100 text-green-700 border border-green-200'
                                : 'bg-gray-100 text-gray-500 border border-gray-200'
                                }`}
                            >
                              <span className={`w-1.5 h-1.5 rounded-full ${enrollment.device.isActive ? 'bg-green-500' : 'bg-gray-400'}`} />
                              {enrollment.device.name}
                            </span>
                          ))
                        ) : (
                          <span className="text-[10px] text-muted-foreground italic">Not enrolled</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 max-w-[120px]">
                      <span className="text-xs font-medium text-slate-500 block truncate" title={employee.Department?.name || employee.department || undefined}>
                        {employee.Department?.name || employee.department || '—'}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      {employee.Shift ? (
                        <div>
                          <p className="text-xs font-bold text-slate-700 leading-tight">{employee.Shift.name}</p>
                          <p className="text-[10px] font-medium text-slate-400 mt-0.5">{formatTime(employee.Shift.startTime)} – {formatTime(employee.Shift.endTime)}</p>
                        </div>
                      ) : (
                        <span className="text-[10px] text-slate-300 font-bold">Unassigned</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-xs font-medium text-slate-500">{employee.branch || '—'}</span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-xs font-medium text-slate-500">{employee.contactNumber ? formatPhoneNumber(employee.contactNumber) : '—'}</span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-xs font-medium text-slate-500">
                        {employee.hireDate ? new Date(employee.hireDate).toLocaleDateString('en-CA') : '—'}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-1">
                        {/* Edit */}
                        <button
                          onClick={() => handleEdit(employee)}
                          className="p-2.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-all active:scale-90"
                          title="Edit employee"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>

                        {/* Fingerprint Enrollment */}
                        {(() => {
                          const status = enrollStatus[employee.id] || 'idle'
                          const msg = enrollMsg[employee.id] || ''
                          if (status === 'loading') {
                            return (
                              <button disabled className="p-2.5 rounded-xl bg-blue-50 text-blue-400 cursor-wait" title="Enrolling...">
                                <Fingerprint className="w-4 h-4 animate-pulse" />
                              </button>
                            )
                          }
                          if (status === 'success') {
                            return (
                              <div className="flex items-center gap-1">
                                <span className="p-2.5 rounded-xl bg-green-50 text-green-500">
                                  <CheckCircle2 className="w-4 h-4" />
                                </span>
                                <span className="text-[10px] text-green-600 font-semibold max-w-[90px] leading-tight">{msg}</span>
                              </div>
                            )
                          }
                          if (status === 'error') {
                            const msgLower = msg.toLowerCase();
                            const isOffline = msgLower.includes('offline');
                            return (
                              <div className="flex items-center gap-1" title={msg}>
                                <span className={`p-2.5 rounded-xl ${isOffline ? 'bg-slate-100 text-slate-500' : 'bg-amber-50 text-amber-500'}`}>
                                  {isOffline ? <WifiOff className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                                </span>
                                <span className={`text-[10px] font-semibold max-w-[90px] leading-tight ${isOffline ? 'text-slate-500' : 'text-amber-600'}`}>
                                  {isOffline ? 'Device Offline' : msgLower.includes('sync') ? 'Sync Paused' : 'Failed'}
                                </span>
                              </div>
                            )
                          }
                          return (
                            <button
                              onClick={() => {
                                const emp = employees.find(e => e.id === employee.id)
                                const name = emp ? `${emp.firstName} ${emp.lastName}` : 'this employee'
                                setEnrollConfirmModal({ open: true, employeeId: employee.id, employeeName: name })
                              }}
                              className="p-2.5 text-slate-400 hover:text-red-600 hover:bg-red-100 rounded-xl transition-all active:scale-90"
                              title="Enroll Fingerprint"
                            >
                              <Fingerprint className="w-4 h-4" />
                            </button>
                          )
                        })()}

                        {/* RFID Badge Enrollment */}
                        <button
                          onClick={() => {
                            const name = `${employee.firstName} ${employee.lastName}`
                            setCardEnrollOpen({ open: true, employeeId: employee.id, employeeName: name })
                          }}
                          className={`p-2.5 rounded-xl transition-all active:scale-90 ${
                            employee.cardNumber
                              ? 'text-blue-500 hover:text-blue-700 hover:bg-blue-50'
                              : 'text-slate-400 hover:text-red-600 hover:bg-red-50'
                          }`}
                          title={employee.cardNumber ? `Badge #${employee.cardNumber}` : 'Enroll RFID Badge'}
                        >
                          <CreditCard className="w-4 h-4" />
                        </button>

                        {/* Reset Password */}
                        <button
                          onClick={() => setConfirmResetPassword(employee)}
                          className="p-2.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-all active:scale-90"
                          title="Reset Password"
                        >
                          <Key className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={11} className="px-6 py-20 text-center text-slate-400 font-bold uppercase text-xs tracking-widest">
                    No matching employees found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
          <span className="text-xs text-slate-400 font-bold">
            Showing {paginatedEmployees.length} of {filteredEmployees.length} employees · Page {currentPage} of {totalPages || 1}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
              disabled={currentPage === 1}
              className="px-3 py-1.5 rounded-lg text-xs font-bold text-slate-500 hover:bg-white hover:border-slate-200 border border-transparent transition-colors disabled:opacity-30"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => i + 1).map(page => (
              <button
                key={page}
                onClick={() => setCurrentPage(page)}
                className={`h-8 w-8 rounded-lg text-xs font-bold transition-colors ${currentPage === page
                  ? 'bg-red-600 text-white'
                  : 'text-slate-500 hover:bg-white hover:border-slate-200 border border-transparent'
                  }`}
              >
                {page}
              </button>
            ))}
            <button
              onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
              disabled={currentPage === totalPages || totalPages === 0}
              className="px-3 py-1.5 rounded-lg text-xs font-bold text-slate-500 hover:bg-white hover:border-slate-200 border border-transparent transition-colors disabled:opacity-30"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* ── Scan Now Modal ───────────────────────────────────────── */}
      {scanModal.open && (
        <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden">
            {/* Header */}
            <div className="bg-red-600 px-6 py-5 relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-red-500 to-red-700 opacity-60" />
              <div className="relative flex items-center justify-between">
                <div>
                  <p className="text-red-100 text-[10px] uppercase font-black tracking-widest">Biometric Device</p>
                  <h3 className="text-white font-black text-xl leading-tight mt-0.5">Scan Fingerprint Now</h3>
                </div>
                <button
                  onClick={() => setScanModal(prev => ({ ...prev, open: false }))}
                  className="text-white/70 hover:text-white transition-colors p-1 rounded-lg hover:bg-white/10"
                >
                  <XIcon className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="px-6 py-6 space-y-5">
              {/* Fingerprint animation */}
              <div className="flex flex-col items-center gap-3 py-2">
                <div className="relative">
                  <div className="w-20 h-20 rounded-full bg-red-50 border-2 border-red-100 flex items-center justify-center">
                    <Fingerprint className="w-10 h-10 text-red-500 animate-pulse" />
                  </div>
                  {/* Pulsing ring */}
                  <div className="absolute inset-0 rounded-full border-2 border-red-400 animate-ping opacity-30" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-blacktext-slate-700">{scanModal.employeeName}</p>
                  <p className="text-xs text-slate-400 font-medium mt-0.5">is ready to enroll</p>
                </div>
              </div>

              {/* Instructions */}
              <div className="space-y-2.5">
                {([
                  { step: '01', text: 'Go to the ZKTeco biometric device' },
                  { step: '02', text: 'Look for this employee on the screen' },
                  { step: '03', text: 'Press your finger firmly on the scanner' },
                  { step: '04', text: 'Hold for 3 seconds until it beeps' },
                ] as const).map(({ step, text }) => (
                  <div key={step} className="flex items-center gap-3">
                    <span className="shrink-0 w-7 h-7 rounded-lg bg-red-600 text-white text-[10px] font-black flex items-center justify-center">{step}</span>
                    <p className="text-xs font-semibold text-slate-600">{text}</p>
                  </div>
                ))}
              </div>

              {/* Countdown */}
              <div className="bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 flex items-center gap-3">
                <Timer className="w-4 h-4 text-slate-400 shrink-0" />
                <p className="text-xs text-slate-500 font-medium flex-1">Auto-closes in</p>
                <span className={`text-sm font-black tabular-nums ${scanModal.countdown <= 10 ? 'text-red-500' : 'text-slate-700'
                  }`}>{scanModal.countdown}s</span>
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 pb-6">
              <button
                onClick={() => setScanModal(prev => ({ ...prev, open: false }))}
                className="w-full py-3 bg-slate-900 hover:bg-slate-800 text-white rounded-2xl text-sm font-black transition-all active:scale-95 shadow-lg shadow-slate-900/20"
              >
                Done — Fingerprint Scanned ✓
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step 1: Enrollment Confirmation Modal */}
      {enrollConfirmModal.open && (
        <div className="fixed inset-0 z-200 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white border-0 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            {/* Red header */}
            <div className="bg-red-600 px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center">
                  <Fingerprint className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-base">Enroll Fingerprint</h3>
                  <p className="text-[10px] text-red-100 uppercase tracking-widest font-bold">Biometric registration</p>
                </div>
              </div>
              <button
                onClick={() => setEnrollConfirmModal({ open: false, employeeId: null, employeeName: '' })}
                className="text-white/70 hover:text-white transition-colors"
              >
                <XIcon className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              <p className="text-sm text-slate-600">
                Do you want to enroll the fingerprint for{' '}
                <span className="font-semibold text-slate-800">{enrollConfirmModal.employeeName}</span>?
              </p>

              <div className="flex gap-2">
                <button
                  onClick={() => setEnrollConfirmModal({ open: false, employeeId: null, employeeName: '' })}
                  className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 text-sm font-medium text-slate-500 hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setEnrollConfirmModal({ open: false, employeeId: null, employeeName: '' })
                    setSelectedDeviceId(null)
                    setDevicePickerModal({
                      open: true,
                      employeeId: enrollConfirmModal.employeeId,
                      employeeName: enrollConfirmModal.employeeName,
                    })
                    fetchDevices()
                  }}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-bold shadow-lg shadow-red-600/25 transition-colors"
                >
                  Yes, Proceed
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Step 2: Device Picker Modal */}
      {devicePickerModal.open && (
        <div className="fixed inset-0 z-200 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white border-0 rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
            {/* Red header */}
            <div className="bg-red-600 px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center">
                  <Fingerprint className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-base">Select Device</h3>
                  <p className="text-[10px] text-red-100 uppercase tracking-widest font-bold">
                    Enrolling <span className="text-white">{devicePickerModal.employeeName}</span>
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setDevicePickerModal({ open: false, employeeId: null, employeeName: '' })
                  setSelectedDeviceId(null)
                }}
                className="text-white/70 hover:text-white transition-colors"
              >
                <XIcon className="w-5 h-5" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              {loadingDevices ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-red-500" />
                </div>
              ) : devices.length === 0 ? (
                <div className="text-center py-6 text-sm text-slate-400">
                  No devices configured. Please add a device first.
                </div>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {devices.map(device => (
                    <button
                      key={device.id}
                      disabled={!device.isActive}
                      onClick={() => setSelectedDeviceId(device.id)}
                      className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-colors text-left ${!device.isActive ? 'opacity-60 cursor-not-allowed bg-slate-50 border-slate-200' : selectedDeviceId === device.id
                        ? 'border-red-500 bg-red-50'
                        : 'border-slate-200 hover:bg-slate-50'
                        }`}
                    >
                      <div className={`w-2 h-2 rounded-full shrink-0 ${device.isActive ? 'bg-green-500' : 'bg-slate-300'}`} />
                      <div className="min-w-0 flex-1 flex items-center justify-between">
                        <div>
                          <p className="text-sm font-semibold text-slate-700 truncate">{device.name}</p>
                          {device.location && (
                            <p className="text-xs text-slate-400 truncate">{device.location}</p>
                          )}
                        </div>
                        {!device.isActive ? (
                          <span className="text-[9px] font-bold text-slate-500 bg-slate-100 border border-slate-200 px-2 py-1 rounded uppercase tracking-wider shrink-0">
                            Offline
                          </span>
                        ) : device.syncEnabled === false ? (
                          <span className="text-[9px] font-bold text-amber-600 bg-amber-50/80 border border-amber-200/50 px-2 py-1 rounded uppercase tracking-wider shrink-0" title="Device sync is paused, but you can still enroll fingerprints.">
                            Sync Paused
                          </span>
                        ) : null}
                      </div>
                      {selectedDeviceId === device.id && device.isActive && (
                        <div className="w-4 h-4 rounded-full bg-red-500 flex items-center justify-center shrink-0">
                          <div className="w-2 h-2 rounded-full bg-white" />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setDevicePickerModal({ open: false, employeeId: null, employeeName: '' })
                    setSelectedDeviceId(null)
                  }}
                  className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 text-sm font-medium text-slate-500 hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  disabled={!selectedDeviceId}
                  onClick={() => {
                    if (!selectedDeviceId || !devicePickerModal.employeeId) return
                    const empId = devicePickerModal.employeeId;
                    setDevicePickerModal({ open: false, employeeId: null, employeeName: '' })
                    handleEnrollFingerprint(empId, selectedDeviceId)
                    setSelectedDeviceId(null)
                  }}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold shadow-lg shadow-red-600/25 transition-colors"
                >
                  Enroll on This Device
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── RFID Card Enrollment Modal ── */}
      <RFIDCardEnrollmentModal
        isOpen={cardEnrollOpen.open}
        employeeId={cardEnrollOpen.employeeId}
        employeeName={cardEnrollOpen.employeeName}
        onClose={() => setCardEnrollOpen({ open: false, employeeId: null, employeeName: '' })}
        onSuccess={(msg) => {
          showToast('success', 'Badge Enrolled', msg)
          fetchEmployees()
        }}
        onError={(msg) => showToast('error', 'Enrollment Failed', msg)}
      />

      {/* ── Enrollment Loading Full-Screen Modal ──────────────────────────────────────── */}
      {(() => {
        const enrollingIdStr = Object.keys(enrollStatus).find(id => enrollStatus[Number(id)] === 'loading');
        if (!enrollingIdStr) return null;
        const msg = enrollMsg[Number(enrollingIdStr)] || 'Connecting to biometric device...';
        return (
          <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white rounded-3xl shadow-2xl p-8 flex flex-col items-center max-w-sm mx-4 text-center">
              <div className="relative mb-6">
                <div className="absolute inset-0 bg-blue-100 rounded-full animate-ping opacity-60"></div>
                <div className="bg-blue-50 text-blue-600 p-5 rounded-full relative shadow-sm">
                  <Loader2 className="w-10 h-10 animate-spin" />
                </div>
              </div>
              <h3 className="text-lg font-bold text-slate-800 mb-2">Please Wait</h3>
              <p className="text-sm font-medium text-slate-500">
                {msg}
              </p>
            </div>
          </div>
        );
      })()}
      
    </div >
  )
}
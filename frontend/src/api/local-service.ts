import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true
  }
  const text = String(value).trim()
  return text === '' || text === '—'
}

function nowStamp(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

// 火情报告编号只增不改：历史报告编号保持原记录，新报告接着现有最大编号往后排。
function nextReportCode(reports: EntryRow[]): string {
  let prefix = 'FIRE-'
  let padWidth = 4
  let max = 0
  for (const row of reports) {
    const match = String(row['报告编号'] ?? '').match(/^(\D*)(\d+)$/)
    if (match) {
      prefix = match[1] || prefix
      padWidth = Math.max(match[2].length, String(max + 1).length)
      max = Math.max(max, Number.parseInt(match[2], 10))
    }
  }
  return `${prefix}${String(max + 1).padStart(padWidth, '0')}`
}

// 无人机任务确认完成后，火情报告模块要同步出现一条「待核实」记录。
// 按来源任务编号幂等：异常重试、重复点击都只落一条，不会重复显示。
function ensureDroneFireReport(task: EntryRow): void {
  const taskCode = String(task['任务编号'] ?? '').trim()
  if (taskCode === '') {
    return
  }
  const reports = listRows('firereport')
  const exists = reports.some((row) => String(row['来源任务编号'] ?? '') === taskCode)
  if (exists) {
    return
  }
  const nextId = reports.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const report: EntryRow = {
    id: nextId,
    status: '待核实',
    pending: true,
    abnormal: false,
    报告编号: nextReportCode(reports),
    起火地点: isBlank(task['飞行区域']) ? '待核实' : String(task['飞行区域']),
    起火时间: nowStamp(),
    火势等级: '待核实',
    过火面积: '待核实',
    扑救情况: '待核实',
    报告人: isBlank(task['飞手姓名']) ? '待核实' : String(task['飞手姓名']),
    报告状态: '待核实',
    来源任务编号: taskCode,
  }
  saveRows('firereport', [...reports, report])
}

// 模块级流转钩子：动作落库前的校验与补字段、落库后的跨模块联动都登记在这里。
type TransitionHook = {
  validate?: (row: EntryRow) => string | null
  beforeSave?: (row: EntryRow) => void
  afterSave?: (row: EntryRow) => void
}

const TRANSITION_HOOKS: Record<string, Record<string, TransitionHook>> = {
  drone: {
    开始飞行: {
      // 飞行路线缺失不放行。
      validate: (row) =>
        isBlank(row['飞行路线']) ? '飞行路线缺失，不能开始飞行，请先补录飞行路线' : null,
    },
    确认完成: {
      // 完成时补记降落时间，结束时间不再丢失；已记录的保持原值。
      beforeSave: (row) => {
        if (isBlank(row['降落时间'])) {
          row['降落时间'] = nowStamp()
        }
      },
      afterSave: (row) => {
        ensureDroneFireReport(row)
      },
    },
  },
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  const current = String(row.status)
  const terminals = meta.terminalStatuses ?? []
  if (terminals.includes(current)) {
    if (current === target) {
      // 幂等重试：终态不变，只补齐上次可能没落成功的联动数据，从原步骤继续。
      if (key === 'drone' && action === '确认完成') {
        ensureDroneFireReport(row)
        return { ok: true, message: `${meta.entity}已是「${target}」，降落时间与火情报告已核对` }
      }
      return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
    }
    // 终态只落一个：先到的终态生效，之后的冲突动作（完成/中止）一律拒绝。
    return { ok: false, message: `${meta.entity}已处于终态「${current}」，不能再执行「${action}」` }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const hook = TRANSITION_HOOKS[key]?.[action]
  const blocked = hook?.validate?.(row)
  if (blocked) {
    return { ok: false, message: blocked }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...row,
    status: target,
    pending: terminals.length > 0 ? !terminals.includes(target) : target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  hook?.beforeSave?.(updated)
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  hook?.afterSave?.(updated)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

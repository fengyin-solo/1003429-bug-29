import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, refreshRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 无人机巡查「确认完成」后要同步到的模块与状态：火情报告页会多出一条待核实记录。
const DRONE_REPORT_MODULE = 'firereport'
const DRONE_REPORT_STATUS = '待核实'
const DRONE_REPORT_REF_FIELD = '来源任务编号'

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

export function todayStamp(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

function terminalStatusesOf(meta: ModuleMeta): string[] {
  // 没登记终态的模块维持旧约定：状态列表最后一位视为完结态。
  return meta.terminalStatuses ?? [meta.statuses[meta.statuses.length - 1]]
}

/** 这条记录当前还允许执行哪些动作；页面只负责渲染，可不可点由这里说了算。 */
export function availableActions(key: string, row: EntryRow): string[] {
  const meta = moduleMeta(key)
  const current = String(row.status)
  if (terminalStatusesOf(meta).includes(current)) {
    return []
  }
  return meta.actions.filter((action) => {
    const from = meta.actionFrom?.[action]
    return !from || from.includes(current)
  })
}

/** 火情报告编号只往后追加，历史编号按原记录保留。 */
function nextReportNo(rows: EntryRow[]): string {
  const max = rows.reduce((acc, row) => {
    const match = /^FIRE-(\d+)$/.exec(String(row['报告编号'] ?? ''))
    return match ? Math.max(acc, Number(match[1])) : acc
  }, 0)
  return `FIRE-${String(max + 1).padStart(4, '0')}`
}

/**
 * 无人机巡查确认完成后，在火情报告里同步落一条「待核实」记录。
 * 以来源任务编号去重：重复点击、网络中断后的重试都只补不增，完成记录不会重复显示。
 * 返回 true 表示这次调用真的补写了一条。
 */
function ensureDroneFireReport(task: EntryRow): boolean {
  const taskNo = String(task['任务编号'] ?? '')
  if (taskNo === '') {
    return false
  }
  const reports = listRows(DRONE_REPORT_MODULE)
  const exists = reports.some((row) => String(row[DRONE_REPORT_REF_FIELD] ?? '') === taskNo)
  if (exists) {
    return false
  }
  const report: EntryRow = {
    id: reports.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1,
    status: DRONE_REPORT_STATUS,
    pending: true,
    abnormal: false,
    报告编号: nextReportNo(reports),
    起火地点: String(task['飞行区域'] ?? ''),
    起火时间: String(task['降落时间'] ?? todayStamp()),
    火势等级: DRONE_REPORT_STATUS,
    过火面积: DRONE_REPORT_STATUS,
    扑救情况: '无人机巡查发现异常，待核实',
    报告人: String(task['飞手姓名'] ?? ''),
    报告状态: DRONE_REPORT_STATUS,
    [DRONE_REPORT_REF_FIELD]: taskNo,
  }
  saveRows(DRONE_REPORT_MODULE, [...reports, report])
  return true
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 动作前先对齐持久层，别的页签刚落的终态这里能立刻看到，并发时只留一个终态。
  refreshRows()
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    // 异常中断后的重试：状态已到位，但联动记录可能没写上，从原步骤继续补齐。
    if (key === 'drone' && action === '确认完成') {
      try {
        if (ensureDroneFireReport(rows[index])) {
          return { ok: true, message: `${meta.entity}此前已确认完成，已补写同步的火情报告` }
        }
      } catch {
        return { ok: false, message: '火情报告同步写入失败，可重试，将从原步骤继续' }
      }
    }
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (terminalStatusesOf(meta).includes(current)) {
    // 完成和中止冲突时，先落库的终态优先，后到的动作一律拒绝。
    return { ok: false, message: `${meta.entity}已是终态「${current}」，不能再${action}` }
  }
  const from = meta.actionFrom?.[action]
  if (from && !from.includes(current)) {
    return { ok: false, message: `${meta.entity}当前状态「${current}」不能执行「${action}」` }
  }
  const missing = (meta.actionRequires?.[action] ?? []).filter((field) => isBlank(rows[index][field]))
  if (missing.length > 0) {
    return { ok: false, message: `${meta.entity}缺少${missing.join('、')}，不能${action}` }
  }
  const stamps: Record<string, string> = {}
  for (const field of meta.actionStamps?.[action] ?? []) {
    if (isBlank(rows[index][field])) {
      stamps[field] = todayStamp()
    }
  }
  const updated: EntryRow = {
    ...rows[index],
    ...stamps,
    status: target,
    pending: !terminalStatusesOf(meta).includes(target),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  try {
    saveRows(key, next)
    if (key === 'drone' && action === '确认完成') {
      ensureDroneFireReport(updated)
    }
  } catch {
    return { ok: false, message: '写入失败，可重试，将从原步骤继续' }
  }
  const synced = key === 'drone' && action === '确认完成' ? '，已同步火情报告（待核实）' : ''
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${synced}` }
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

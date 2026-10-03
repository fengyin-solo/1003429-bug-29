/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /** 终态状态：进入后不再接受任何动作，先落库的终态优先，保证只落一个终态 */
  terminalStatuses?: string[]
  /** 每个动作允许的前置状态；缺省表示不限制来源状态 */
  actionFrom?: Record<string, string[]>
  /** 执行动作前必须已填写的字段；为空则拒绝放行 */
  actionRequires?: Record<string, string[]>
  /** 动作成功时若字段为空则补写当前日期，避免结束时间丢失 */
  actionStamps?: Record<string, string[]>
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

<template>
  <section class="page" data-module="drone">
    <header class="page-head">
      <div>
        <h2>无人机巡查管理</h2>
        <p class="page-desc">维护无人机巡查任务，围绕任务编号、飞行区域、飞行路线、飞手姓名做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记无人机巡查任务</button>
        <button class="btn" type="button" @click="exportRows">导出无人机巡查清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(meta.key, row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!availableActions(meta.key, row).length" class="muted-text">已终态</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无无人机巡查数据，可先登记无人机巡查任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条无人机巡查记录</span>
      <span v-if="noticeMessage" class="ok-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  availableActions,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  todayStamp,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('drone')
const columns = ["任务编号", "飞行区域", "飞行路线", "飞手姓名", "起飞时间", "降落时间", "发现异常数", "任务状态"]
const statuses = ["待执行", "飞行中", "已完成", "因故中止"]
const stats = computed(() => [
  {
    label: '今日飞行任务',
    value: rows.value.filter((row) => String(row['起飞时间'] ?? '') === todayStamp()).length,
  },
  {
    label: '已完成任务',
    value: rows.value.filter((row) => String(row.status) === '已完成').length,
  },
  {
    label: '发现异常数',
    value: rows.value.reduce(
      (sum, row) => sum + (Number.parseInt(String(row['发现异常数'] ?? ''), 10) || 0),
      0,
    ),
  },
])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '无人机巡查任务登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '无人机巡查列表读取失败'
  }
}

onMounted(reload)
</script>

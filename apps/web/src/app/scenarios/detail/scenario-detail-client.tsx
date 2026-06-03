'use client'

import { useState, useEffect, useCallback, type ReactNode } from 'react'

import Link from 'next/link'
import type { Scenario, ScenarioStep, ScenarioTriggerType, MessageType } from '@line-crm/shared'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import GroupPicker from '@/components/group-picker'
import MessageEditor from '@/components/message-editor'
import { useAccount } from '@/lib/account-context'
import { withGroup } from '@/lib/format-group'

type ScenarioWithSteps = Scenario & { steps: ScenarioStep[] }

const triggerOptions: { value: ScenarioTriggerType; label: string }[] = [
  { value: 'friend_add', label: '友だち追加時' },
  { value: 'tag_added', label: 'タグ付与時' },
  { value: 'manual', label: '手動' },
]

const messageTypeOptions: { value: MessageType; label: string }[] = [
  { value: 'text', label: 'テキスト' },
  { value: 'image', label: '画像' },
  { value: 'flex', label: 'Flex' },
  { value: 'buttons', label: 'ボタン（画像 + タイトル + ボタン）' },
  { value: 'richmenu', label: 'リッチメニュー切替' },
]

// UI-only sentinel — `template` isn't a DB message_type. The form switches to
// a template picker that, on selection, copies the template's actual
// messageType + messageContent into stepForm before save.
const TEMPLATE_MODE = '__template__'

function formatDelay(minutes: number): string {
  if (minutes === 0) return '即時'
  if (minutes < 60) return `${minutes}分後`
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return m === 0 ? `${h}時間後` : `${h}時間${m}分後`
  }
  const d = Math.floor(minutes / 1440)
  const remaining = minutes % 1440
  if (remaining === 0) return `${d}日後`
  const h = Math.floor(remaining / 60)
  return h > 0 ? `${d}日${h}時間後` : `${d}日${remaining}分後`
}

interface StepFormState {
  stepOrder: number
  delayMinutes: number
  delayMode: 'relative' | 'days_at_time' | 'absolute'
  delayDays: number
  delayTime: string
  delayAt: string
  messageType: MessageType
  messageContent: string
  conditionType: string
  conditionValue: string
  richMenuId: string
  templateId: string
}

const emptyStepForm: StepFormState = {
  stepOrder: 1,
  delayMinutes: 0,
  delayMode: 'relative',
  delayDays: 0,
  delayTime: '10:00',
  delayAt: '',
  messageType: 'text',
  messageContent: '',
  conditionType: '',
  conditionValue: '',
  templateId: '',
  richMenuId: '',
}

const conditionTypeLabels: Record<string, string> = {
  tag_exists: 'タグあり',
  tag_not_exists: 'タグなし',
}

function FlexPreview({ content }: { content: string }) {
  try {
    const parsed = JSON.parse(content)
    // Extract visible text from Flex JSON
    const texts: string[] = []
    const extractTexts = (obj: Record<string, unknown>) => {
      if (obj.type === 'text' && obj.text) texts.push(obj.text as string)
      if (obj.type === 'button' && obj.action && (obj.action as Record<string, unknown>).label) {
        texts.push(`[${(obj.action as Record<string, unknown>).label}]`)
      }
      for (const val of Object.values(obj)) {
        if (Array.isArray(val)) val.forEach((v) => { if (v && typeof v === 'object') extractTexts(v as Record<string, unknown>) })
        else if (val && typeof val === 'object') extractTexts(val as Record<string, unknown>)
      }
    }
    extractTexts(parsed)

    return (
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-medium text-orange-600 bg-orange-50 px-2 py-0.5 rounded">Flex Message</span>
          <span className="text-xs text-gray-400">{content.length.toLocaleString()} bytes</span>
        </div>
        <div className="bg-white border border-gray-200 rounded-lg p-3 space-y-1">
          {texts.slice(0, 8).map((t, i) => (
            <p key={i} className={`text-sm ${i === 0 ? 'font-medium text-gray-900' : 'text-gray-600'}`}>
              {t}
            </p>
          ))}
          {texts.length > 8 && <p className="text-xs text-gray-400">...他 {texts.length - 8} 要素</p>}
        </div>
      </div>
    )
  } catch {
    return <p className="text-xs text-red-500">Flex JSON パースエラー</p>
  }
}

function ImagePreview({ content }: { content: string }) {
  try {
    const parsed = JSON.parse(content)
    const url = parsed.previewImageUrl || parsed.originalContentUrl
    return (
      <div>
        <span className="text-xs font-medium text-purple-600 bg-purple-50 px-2 py-0.5 rounded mb-2 inline-block">画像</span>
        {url ? (
          <img src={url} alt="preview" className="max-w-[200px] rounded-lg border border-gray-200 mt-1" />
        ) : (
          <p className="text-xs text-gray-400">プレビューなし</p>
        )}
      </div>
    )
  } catch {
    return <p className="text-xs text-red-500">画像 JSON パースエラー</p>
  }
}

export default function ScenarioDetailClient({ scenarioId }: { scenarioId: string }) {
  const id = scenarioId

  const { selectedAccount } = useAccount()
  const [scenario, setScenario] = useState<ScenarioWithSteps | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState({ name: '', description: '', triggerType: 'friend_add' as ScenarioTriggerType, triggerTagId: '', isActive: true, groupName: '', nextScenarioId: '' })
  const [allScenarios, setAllScenarios] = useState<{ id: string; name: string; groupName?: string | null }[]>([])
  const [saving, setSaving] = useState(false)
  const [tags, setTags] = useState<{ id: string; name: string; groupName?: string | null }[]>([])
  const [richMenus, setRichMenus] = useState<{ id: string; name: string; lineRichmenuId: string | null }[]>([])
  const [templates, setTemplates] = useState<{ id: string; name: string; category: string; messageType: string; messageContent: string }[]>([])

  const [showStepForm, setShowStepForm] = useState(false)
  const [editingStepId, setEditingStepId] = useState<string | null>(null)
  const [stepForm, setStepForm] = useState<StepFormState>(emptyStepForm)
  const [stepSaving, setStepSaving] = useState(false)
  const [stepError, setStepError] = useState('')
  // `useTemplateMode` is the UI toggle for "メッセージタイプ → テンプレート".
  // While true, we hide the regular message-content editor and show a template
  // selector. On select, the chosen template's messageType + content overwrite
  // stepForm and we drop back into the normal editing surface.
  const [useTemplateMode, setUseTemplateMode] = useState(false)
  const [pickedTemplateId, setPickedTemplateId] = useState('')

  const loadScenario = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.scenarios.get(id)
      if (res.success) {
        setScenario(res.data)
        setEditForm({
          name: res.data.name,
          description: res.data.description ?? '',
          triggerType: res.data.triggerType,
          triggerTagId: res.data.triggerTagId ?? '',
          isActive: res.data.isActive,
          groupName: res.data.groupName ?? '',
          nextScenarioId: res.data.nextScenarioId ?? '',
        })
      } else {
        setError(res.error)
      }
    } catch {
      setError('シナリオの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    loadScenario()
    api.richMenus.list().then((res) => { if (res.success) setRichMenus(res.data.map(r => ({ id: r.id, name: r.name, lineRichmenuId: r.lineRichmenuId }))) }).catch(() => {})
  }, [loadScenario])

  // Scope tags AND the next-scenario picker to this scenario's LINE
  // account once it has loaded. Without these filters the operator could
  // pick a tag/scenario from a different OA — the worker would never
  // match the tag, and chaining to a foreign-account scenario would
  // silently break friend-account routing on enrollment.
  //
  // Fallback: when this scenario itself has line_account_id=NULL (legacy
  // data created before multi-account support landed), use the operator's
  // currently-selected account from the global account context. Without
  // this fallback the API call goes out without `lineAccountId` and the
  // worker returns *every* tag/scenario including ones bound to other
  // accounts, which is exactly what the operator complained about.
  useEffect(() => {
    if (!scenario) return
    const accountId = scenario.lineAccountId ?? selectedAccount?.id ?? null
    const params = accountId ? { lineAccountId: accountId } : undefined
    api.tags.list(params).then((res) => { if (res.success) setTags(res.data) }).catch(() => {})
    api.scenarios.list(params).then((res) => { if (res.success) setAllScenarios(res.data) }).catch(() => {})
    api.templates.list(undefined, params).then((res) => { if (res.success) setTemplates(res.data) }).catch(() => {})
  }, [scenario, selectedAccount])

  const handleSaveScenario = async () => {
    if (!editForm.name.trim()) return
    setSaving(true)
    try {
      const res = await api.scenarios.update(id, {
        name: editForm.name,
        description: editForm.description || null,
        triggerType: editForm.triggerType,
        triggerTagId: editForm.triggerType === 'tag_added' ? (editForm.triggerTagId || null) : null,
        isActive: editForm.isActive,
        groupName: editForm.groupName.trim() || null,
        nextScenarioId: editForm.nextScenarioId || null,
      })
      if (res.success) {
        setEditing(false)
        loadScenario()
      } else {
        setError(res.error)
      }
    } catch {
      setError('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const openAddStep = () => {
    const nextOrder = scenario ? (scenario.steps.length > 0 ? Math.max(...scenario.steps.map(s => s.stepOrder)) + 1 : 1) : 1
    setStepForm({ ...emptyStepForm, stepOrder: nextOrder })
    setEditingStepId(null)
    setUseTemplateMode(false)
    setPickedTemplateId('')
    setShowStepForm(true)
    setStepError('')
  }

  const openEditStep = (step: ScenarioStep) => {
    const tplId = step.templateId ?? ''
    setStepForm({
      stepOrder: step.stepOrder,
      delayMinutes: step.delayMinutes,
      delayMode: step.delayMode ?? 'relative',
      delayDays: step.delayDays ?? 0,
      delayTime: step.delayTime ?? '10:00',
      delayAt: step.delayAt ?? '',
      messageType: step.messageType,
      messageContent: step.messageContent,
      conditionType: step.conditionType ?? '',
      conditionValue: step.conditionValue ?? '',
      richMenuId: (step as ScenarioStep & { richMenuId?: string | null }).richMenuId ?? '',
      templateId: tplId,
    })
    setEditingStepId(step.id)
    // If the step was originally filled from a template, reopen the editor in
    // template-picker mode so the operator sees the template name + preview
    // instead of the raw JSON in a textarea (which is what they were
    // complaining about).
    setUseTemplateMode(!!tplId)
    setPickedTemplateId(tplId)
    setShowStepForm(true)
    setStepError('')
  }

  const handleSaveStep = async () => {
    if (useTemplateMode && !pickedTemplateId) {
      setStepError('テンプレートを選択してください')
      return
    }
    if (stepForm.messageType !== 'richmenu' && !stepForm.messageContent.trim()) {
      setStepError('メッセージ内容を入力してください')
      return
    }
    setStepSaving(true)
    setStepError('')
    try {
      const conditionPayload = {
        conditionType: stepForm.conditionType || null,
        conditionValue: (stepForm.conditionType && stepForm.conditionValue) ? stepForm.conditionValue : null,
      }
      const richMenuPayload = stepForm.messageType === 'richmenu'
        ? { richMenuId: stepForm.richMenuId || null }
        : {}
      if (editingStepId) {
        const res = await api.scenarios.updateStep(id, editingStepId, {
          stepOrder: stepForm.stepOrder,
          delayMinutes: stepForm.delayMinutes,
          delayMode: stepForm.delayMode,
          delayDays: stepForm.delayMode === 'days_at_time' ? stepForm.delayDays : null,
          delayTime: stepForm.delayMode === 'days_at_time' ? stepForm.delayTime : null,
          delayAt: stepForm.delayMode === 'absolute' ? stepForm.delayAt : null,
          templateId: stepForm.templateId || null,
          messageType: stepForm.messageType,
          messageContent: stepForm.messageType === 'richmenu' ? '' : stepForm.messageContent,
          ...conditionPayload,
          ...richMenuPayload,
        } as never)
        if (!res.success) {
          setStepError(res.error)
          return
        }
      } else {
        const res = await api.scenarios.addStep(id, {
          stepOrder: stepForm.stepOrder,
          delayMinutes: stepForm.delayMinutes,
          delayMode: stepForm.delayMode,
          delayDays: stepForm.delayMode === 'days_at_time' ? stepForm.delayDays : null,
          delayTime: stepForm.delayMode === 'days_at_time' ? stepForm.delayTime : null,
          delayAt: stepForm.delayMode === 'absolute' ? stepForm.delayAt : null,
          templateId: stepForm.templateId || null,
          messageType: stepForm.messageType,
          messageContent: stepForm.messageType === 'richmenu' ? '' : stepForm.messageContent,
          ...conditionPayload,
          ...richMenuPayload,
        } as never)
        if (!res.success) {
          setStepError(res.error)
          return
        }
      }
      setShowStepForm(false)
      setEditingStepId(null)
      loadScenario()
    } catch {
      setStepError('ステップの保存に失敗しました')
    } finally {
      setStepSaving(false)
    }
  }

  const handleDeleteStep = async (stepId: string) => {
    if (!confirm('このステップを削除してもよいですか？')) return
    try {
      await api.scenarios.deleteStep(id, stepId)
      loadScenario()
    } catch {
      setError('ステップの削除に失敗しました')
    }
  }

  const [testingId, setTestingId] = useState<string | null>(null)
  const [testMessage, setTestMessage] = useState('')

  const handleTestStep = async (stepId: string) => {
    setTestingId(stepId)
    setTestMessage('')
    setError('')
    try {
      const res = await api.scenarios.testStep(id, stepId)
      if (res.success) {
        setTestMessage(`✓ テスト送信しました（送信先: ${res.data.sentTo}）`)
      } else {
        setError(res.error)
      }
    } catch {
      setError('テスト送信に失敗しました')
    } finally {
      setTestingId(null)
    }
  }

  const handleTestAll = async () => {
    if (!confirm('シナリオの全ステップをテスト送信先に一気に送信します。よろしいですか？')) return
    setTestingId('__all__')
    setTestMessage('')
    setError('')
    try {
      const res = await api.scenarios.testAll(id)
      if (res.success) {
        setTestMessage(`✓ 全${res.data.sentCount}ステップをテスト送信しました（送信先: ${res.data.sentTo}）`)
      } else {
        setError(res.error)
      }
    } catch {
      setError('テスト送信に失敗しました')
    } finally {
      setTestingId(null)
    }
  }

  if (loading) {
    return (
      <div>
        <Header title="シナリオ詳細" />
        <div className="bg-white rounded-lg border border-gray-200 p-8 animate-pulse space-y-4">
          <div className="h-6 bg-gray-200 rounded w-1/3" />
          <div className="h-4 bg-gray-100 rounded w-2/3" />
          <div className="h-4 bg-gray-100 rounded w-1/2" />
        </div>
      </div>
    )
  }

  if (!scenario) {
    return (
      <div>
        <Header title="シナリオ詳細" />
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
          <p className="text-gray-500">{error || 'シナリオが見つかりません'}</p>
          <Link href="/scenarios" className="text-sm text-green-600 hover:text-green-700 mt-4 inline-block">
            ← シナリオ一覧に戻る
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div>
      <Header
        title="シナリオ詳細"
        action={
          <Link
            href="/scenarios"
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors inline-flex items-center"
          >
            ← シナリオ一覧
          </Link>
        }
      />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Scenario Info */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
        {editing ? (
          <div className="space-y-4 max-w-lg">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">シナリオ名 <span className="text-red-500">*</span></label>
              <input
                type="text"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">説明</label>
              <textarea
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
                rows={2}
                value={editForm.description}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">トリガー</label>
              <select
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                value={editForm.triggerType}
                onChange={(e) => setEditForm({ ...editForm, triggerType: e.target.value as ScenarioTriggerType, triggerTagId: '' })}
              >
                {triggerOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            {editForm.triggerType === 'tag_added' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">対象タグ <span className="text-red-500">*</span></label>
                <select
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                  value={editForm.triggerTagId}
                  onChange={(e) => setEditForm({ ...editForm, triggerTagId: e.target.value })}
                >
                  <option value="">タグを選択...</option>
                  {tags.map((tag) => (
                    <option key={tag.id} value={tag.id}>{withGroup(tag.name, tag.groupName)}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">グループ（任意）</label>
              <GroupPicker
                value={editForm.groupName}
                onChange={(v) => setEditForm({ ...editForm, groupName: v })}
                existingGroups={Array.from(new Set(allScenarios.map(s => s.groupName).filter((g): g is string => !!g))).sort()}
                placeholder="例: ウェルカム / セミナー誘導 / 教材配布"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">完了後に発動する次シナリオ（任意）</label>
              <select
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
                value={editForm.nextScenarioId}
                onChange={(e) => setEditForm({ ...editForm, nextScenarioId: e.target.value })}
              >
                <option value="">なし（このシナリオで終了）</option>
                {allScenarios
                  .filter((s) => s.id !== id)
                  .map((s) => (
                    <option key={s.id} value={s.id}>{withGroup(s.name, s.groupName)}</option>
                  ))}
              </select>
              <p className="text-[11px] text-gray-400 mt-1">最終ステップ配信後、ここで指定したシナリオに自動エンロールします（循環参照は保存時にブロック）。</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="editIsActive"
                checked={editForm.isActive}
                onChange={(e) => setEditForm({ ...editForm, isActive: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
              />
              <label htmlFor="editIsActive" className="text-sm text-gray-600">有効</label>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSaveScenario}
                disabled={saving}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
                style={{ backgroundColor: '#06C755' }}
              >
                {saving ? '保存中...' : '保存'}
              </button>
              <button
                onClick={() => {
                  setEditing(false)
                  setEditForm({
                    name: scenario.name,
                    description: scenario.description ?? '',
                    triggerType: scenario.triggerType,
                    triggerTagId: scenario.triggerTagId ?? '',
                    isActive: scenario.isActive,
                    groupName: scenario.groupName ?? '',
                    nextScenarioId: scenario.nextScenarioId ?? '',
                  })
                }}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
              >
                キャンセル
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-start justify-between gap-4 mb-3">
              <h2 className="text-lg font-semibold text-gray-900">{scenario.name}</h2>
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    scenario.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {scenario.isActive ? '有効' : '無効'}
                </span>
                <button
                  onClick={() => setEditing(true)}
                  className="text-xs font-medium text-green-600 hover:text-green-700 px-3 py-1.5 rounded-md hover:bg-green-50 transition-colors"
                >
                  編集
                </button>
              </div>
            </div>
            {scenario.description && (
              <p className="text-sm text-gray-500 mb-3">{scenario.description}</p>
            )}
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span>トリガー: {triggerOptions.find(o => o.value === scenario.triggerType)?.label ?? scenario.triggerType}</span>
              <span>ステップ数: {scenario.steps.length}</span>
              <span>作成日: {new Date(scenario.createdAt).toLocaleDateString('ja-JP')}</span>
            </div>
          </div>
        )}
      </div>

      {/* Steps */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h3 className="text-sm font-semibold text-gray-800">ステップ一覧</h3>
          <div className="flex items-center gap-2">
            {scenario.steps.length > 0 && (
              <button
                onClick={handleTestAll}
                disabled={testingId === '__all__'}
                className="px-3 py-1.5 min-h-[44px] text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg disabled:opacity-50"
              >
                {testingId === '__all__' ? '送信中...' : '全ステップを一気にテスト送信'}
              </button>
            )}
            <button
              onClick={openAddStep}
              className="px-3 py-1.5 min-h-[44px] text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
              style={{ backgroundColor: '#06C755' }}
            >
              + ステップ追加
            </button>
          </div>
        </div>

        {testMessage && (
          <div className="mb-3 p-2 bg-green-50 border border-green-200 rounded text-xs text-green-700">
            {testMessage}
          </div>
        )}

        {/* Step form */}
        {showStepForm && (
          <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
            <h4 className="text-sm font-medium text-gray-700 mb-3">
              {editingStepId ? 'ステップを編集' : '新しいステップを追加'}
            </h4>
            <div className="space-y-3 max-w-lg">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">ステップ順序</label>
                <input
                  type="number"
                  min={1}
                  className="w-32 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  value={stepForm.stepOrder}
                  onChange={(e) => setStepForm({ ...stepForm, stepOrder: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">配信タイミング</label>
                <div className="flex gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => setStepForm({ ...stepForm, delayMode: 'relative' })}
                    className={`text-xs px-3 py-1.5 rounded border ${stepForm.delayMode === 'relative' ? 'border-[#06C755] bg-[#06C755]/10 text-[#06C755]' : 'border-gray-300 text-gray-600 bg-white'}`}
                  >
                    分後
                  </button>
                  <button
                    type="button"
                    onClick={() => setStepForm({ ...stepForm, delayMode: 'days_at_time' })}
                    className={`text-xs px-3 py-1.5 rounded border ${stepForm.delayMode === 'days_at_time' ? 'border-[#06C755] bg-[#06C755]/10 text-[#06C755]' : 'border-gray-300 text-gray-600 bg-white'}`}
                  >
                    N日後の指定時刻
                  </button>
                  <button
                    type="button"
                    onClick={() => setStepForm({ ...stepForm, delayMode: 'absolute' })}
                    className={`text-xs px-3 py-1.5 rounded border ${stepForm.delayMode === 'absolute' ? 'border-[#06C755] bg-[#06C755]/10 text-[#06C755]' : 'border-gray-300 text-gray-600 bg-white'}`}
                  >
                    指定の日時
                  </button>
                </div>
                {stepForm.delayMode === 'relative' ? (
                  <div>
                    <input
                      type="number"
                      min={0}
                      className="w-32 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                      value={stepForm.delayMinutes}
                      onChange={(e) => setStepForm({ ...stepForm, delayMinutes: Number(e.target.value) })}
                    />
                    <span className="ml-2 text-xs text-gray-500">分後</span>
                    <p className="text-xs text-gray-400 mt-0.5">{formatDelay(stepForm.delayMinutes)}</p>
                  </div>
                ) : stepForm.delayMode === 'days_at_time' ? (
                  <div className="flex items-center gap-2 flex-wrap">
                    <input
                      type="number"
                      min={0}
                      className="w-20 border border-gray-300 rounded-lg px-2 py-2 text-sm"
                      value={stepForm.delayDays}
                      onChange={(e) => setStepForm({ ...stepForm, delayDays: Number(e.target.value) })}
                    />
                    <span className="text-xs text-gray-500">日後の</span>
                    <input
                      type="time"
                      className="border border-gray-300 rounded-lg px-2 py-2 text-sm"
                      value={stepForm.delayTime}
                      onChange={(e) => setStepForm({ ...stepForm, delayTime: e.target.value })}
                    />
                    <span className="text-xs text-gray-500">に配信（JST）</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 flex-wrap">
                    <input
                      type="datetime-local"
                      className="border border-gray-300 rounded-lg px-2 py-2 text-sm"
                      value={stepForm.delayAt}
                      onChange={(e) => setStepForm({ ...stepForm, delayAt: e.target.value })}
                    />
                    <span className="text-xs text-gray-500">（JST）に配信</span>
                    <p className="text-[11px] text-gray-400 w-full">指定日時より後にエンロールした友だちには、エンロール直後に即配信されます</p>
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">メッセージタイプ</label>
                <select
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                  value={useTemplateMode ? TEMPLATE_MODE : stepForm.messageType}
                  onChange={(e) => {
                    const next = e.target.value
                    if (next === TEMPLATE_MODE) {
                      setUseTemplateMode(true)
                      // Clear any preview content until the operator picks a
                      // template — otherwise the previous textarea content
                      // bleeds into the new selection visually.
                      setPickedTemplateId('')
                      setStepForm((s) => ({ ...s, templateId: '' }))
                    } else {
                      setUseTemplateMode(false)
                      setPickedTemplateId('')
                      // Switching away from template mode also drops the
                      // template back-reference so the next save isn't tied
                      // to the previously-picked template.
                      setStepForm({ ...stepForm, messageType: next as MessageType, templateId: '' })
                    }
                  }}
                >
                  {messageTypeOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                  {templates.length > 0 && (
                    <option value={TEMPLATE_MODE}>テンプレートから挿入</option>
                  )}
                </select>
              </div>
              {useTemplateMode ? (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">テンプレートを選択 <span className="text-red-500">*</span></label>
                  <select
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                    value={pickedTemplateId}
                    onChange={(e) => {
                      const id = e.target.value
                      setPickedTemplateId(id)
                      const tpl = templates.find((t) => t.id === id)
                      if (!tpl) return
                      // The DB now allows 'buttons' on scenario_steps too, so
                      // we hand the type through verbatim. Anything unknown
                      // falls back to 'text' so we never write an invalid
                      // CHECK value.
                      const allowed: MessageType[] = ['text', 'image', 'flex', 'richmenu', 'buttons']
                      const nextType: MessageType = (allowed as string[]).includes(tpl.messageType)
                        ? (tpl.messageType as MessageType)
                        : 'text'
                      setStepForm((s) => ({
                        ...s,
                        messageType: nextType,
                        messageContent: tpl.messageContent,
                        templateId: tpl.id,
                      }))
                    }}
                  >
                    <option value="">テンプレートを選択...</option>
                    {Object.entries(
                      templates.reduce<Record<string, typeof templates>>((acc, t) => {
                        const key = t.category || 'general'
                        if (!acc[key]) acc[key] = []
                        acc[key].push(t)
                        return acc
                      }, {}),
                    ).map(([cat, items]) => (
                      <optgroup key={cat} label={cat}>
                        {items.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}（{messageTypeOptions.find((o) => o.value === t.messageType)?.label ?? t.messageType}）
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {pickedTemplateId && (() => {
                    const tpl = templates.find((t) => t.id === pickedTemplateId)
                    if (!tpl) {
                      // Template was deleted but the step still references it.
                      // Render whatever we have on the step itself so the
                      // operator isn't left staring at an empty preview.
                      return (
                        <div className="mt-3">
                          <p className="text-[11px] text-amber-600 mb-1">元のテンプレートが見つかりません（削除済み）。配信内容は保存時のスナップショットを使います。</p>
                          <TemplatePreview tpl={{ messageType: stepForm.messageType, messageContent: stepForm.messageContent }} />
                        </div>
                      )
                    }
                    // Always preview the *step's* current snapshot, not the
                    // live template, so the preview matches what will actually
                    // be delivered. The live template name is shown for context.
                    return (
                      <div className="mt-3">
                        <p className="text-[11px] text-gray-500 mb-1">プレビュー（テンプレート「{tpl.name}」）</p>
                        <TemplatePreview tpl={{ messageType: stepForm.messageType, messageContent: stepForm.messageContent }} />
                        <p className="text-[11px] text-gray-400 mt-2">
                          このまま保存すると、上記の内容で配信されます。<br />
                          内容を個別に微調整したい場合は、メッセージタイプを「{messageTypeOptions.find((o) => o.value === tpl.messageType)?.label ?? tpl.messageType}」に切り替えてください。
                        </p>
                      </div>
                    )
                  })()}
                </div>
              ) : stepForm.messageType === 'richmenu' ? (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">切替先のリッチメニュー</label>
                  <select
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                    value={stepForm.richMenuId}
                    onChange={(e) => setStepForm({ ...stepForm, richMenuId: e.target.value })}
                  >
                    <option value="">（リッチメニューを解除する）</option>
                    {richMenus.map(rm => (
                      <option key={rm.id} value={rm.id} disabled={!rm.lineRichmenuId}>
                        {rm.name}{!rm.lineRichmenuId ? '（未公開）' : ''}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">このステップが実行されると、選択したリッチメニューに切り替わります。空欄なら現在のメニューを解除します。</p>
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">メッセージ内容 <span className="text-red-500">*</span></label>
                  <MessageEditor
                    value={stepForm.messageContent}
                    onChange={(v) => setStepForm({ ...stepForm, messageContent: v })}
                    rows={6}
                  />
                </div>
              )}

              {/* Condition */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">配信条件</label>
                <select
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white mb-2"
                  value={stepForm.conditionType}
                  onChange={(e) => setStepForm({ ...stepForm, conditionType: e.target.value, conditionValue: '' })}
                >
                  <option value="">条件なし（全員に配信）</option>
                  <option value="tag_not_exists">タグなし（タグが付いていない人）</option>
                  <option value="tag_exists">タグあり（タグが付いている人）</option>
                </select>
                {(stepForm.conditionType === 'tag_exists' || stepForm.conditionType === 'tag_not_exists') && (
                  <select
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                    value={stepForm.conditionValue}
                    onChange={(e) => setStepForm({ ...stepForm, conditionValue: e.target.value })}
                  >
                    <option value="">タグを選択...</option>
                    {tags.map((tag) => (
                      <option key={tag.id} value={tag.id}>{withGroup(tag.name, tag.groupName)}</option>
                    ))}
                  </select>
                )}
              </div>

              {stepError && <p className="text-xs text-red-600">{stepError}</p>}

              <div className="flex gap-2">
                <button
                  onClick={handleSaveStep}
                  disabled={stepSaving}
                  className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
                  style={{ backgroundColor: '#06C755' }}
                >
                  {stepSaving ? '保存中...' : editingStepId ? '更新' : '追加'}
                </button>
                <button
                  onClick={() => { setShowStepForm(false); setEditingStepId(null); setStepError('') }}
                  className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                >
                  キャンセル
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Steps list */}
        {scenario.steps.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-sm">
            ステップがありません。「+ ステップ追加」から追加してください。
          </div>
        ) : (
          <div className="space-y-3">
            {scenario.steps
              .sort((a, b) => a.stepOrder - b.stepOrder)
              .map((step) => (
                <div
                  key={step.id}
                  className="border border-gray-200 rounded-lg p-4 hover:border-gray-300 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-2 flex-wrap">
                        <span
                          className="inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold text-white shrink-0"
                          style={{ backgroundColor: '#06C755' }}
                        >
                          {step.stepOrder}
                        </span>
                        <span className="text-xs text-gray-500">{formatDelay(step.delayMinutes)}</span>
                        {step.templateId ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-50 text-green-700 border border-green-200">
                            🧩 テンプレート: {templates.find(t => t.id === step.templateId)?.name ?? '（削除済み）'}
                          </span>
                        ) : (
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            step.messageType === 'text' ? 'bg-blue-50 text-blue-600' :
                            step.messageType === 'image' ? 'bg-purple-50 text-purple-600' :
                            'bg-orange-50 text-orange-600'
                          }`}>
                            {messageTypeOptions.find(o => o.value === step.messageType)?.label ?? step.messageType}
                          </span>
                        )}
                        {step.conditionType && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-yellow-50 text-yellow-700 border border-yellow-200">
                            🔒 {conditionTypeLabels[step.conditionType] ?? step.conditionType}
                            {step.conditionValue && (
                              <span className="text-yellow-600">
                                : {tags.find(t => t.id === step.conditionValue)?.name ?? step.conditionValue}
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-gray-700 bg-gray-50 rounded-md px-3 py-2">
                        {step.messageType === 'buttons' ? (
                          <TemplatePreview tpl={{ messageType: step.messageType, messageContent: step.messageContent }} />
                        ) : step.messageType === 'text' ? (
                          <p className="whitespace-pre-wrap break-words">{step.messageContent}</p>
                        ) : step.messageType === 'flex' ? (
                          <FlexPreview content={step.messageContent} />
                        ) : step.messageType === 'image' ? (
                          <ImagePreview content={step.messageContent} />
                        ) : (
                          <p className="whitespace-pre-wrap break-words">{step.messageContent}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => handleTestStep(step.id)}
                        disabled={testingId === step.id}
                        className="text-xs text-blue-600 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50 transition-colors min-h-[44px] flex items-center disabled:opacity-50"
                      >
                        {testingId === step.id ? '送信中...' : 'テスト送信'}
                      </button>
                      <button
                        onClick={() => openEditStep(step)}
                        className="text-xs text-green-600 hover:text-green-700 px-2 py-1 rounded hover:bg-green-50 transition-colors min-h-[44px] flex items-center"
                      >
                        編集
                      </button>
                      <button
                        onClick={() => handleDeleteStep(step.id)}
                        className="text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 transition-colors min-h-[44px] flex items-center"
                      >
                        削除
                      </button>
                    </div>
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Renders a saved template the way LINE will deliver it. Each template type
 * has its own JSON shape, so plain text-bubble preview shows raw JSON for
 * image / flex / buttons templates — which is what the operator was seeing
 * before. We pivot per type to show something faithful instead.
 */
function TemplatePreview({ tpl }: { tpl: { messageType: string; messageContent: string } }) {
  const wrap = (children: ReactNode) => (
    <div className="bg-[#7da9c0] rounded-lg p-3" aria-label="テンプレート プレビュー">
      <div className="flex items-start gap-2">
        <div className="w-8 h-8 rounded-full bg-white/40 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[10px] text-white/90 mb-1">公式アカウント</p>
          {children}
        </div>
      </div>
    </div>
  )

  if (tpl.messageType === 'text') {
    return wrap(
      <div
        className="bg-white rounded-2xl px-3 py-2 text-[13px] text-gray-900 whitespace-pre-wrap break-words leading-relaxed"
        style={{ maxWidth: '320px' }}
      >
        {tpl.messageContent || <span className="text-gray-400">(空)</span>}
      </div>,
    )
  }

  if (tpl.messageType === 'image') {
    let url: string | null = null
    try {
      const parsed = JSON.parse(tpl.messageContent) as { previewImageUrl?: string; originalContentUrl?: string }
      url = parsed.previewImageUrl ?? parsed.originalContentUrl ?? null
    } catch { /* fall through to raw */ }
    return wrap(
      url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="rounded-2xl block" style={{ maxWidth: '240px' }} />
      ) : (
        <div className="bg-white rounded-2xl px-3 py-2 text-[12px] text-red-500" style={{ maxWidth: '320px' }}>
          画像URLが解析できません
        </div>
      ),
    )
  }

  if (tpl.messageType === 'buttons') {
    let parsed: {
      thumbnailImageUrl?: string
      title?: string
      text?: string
      actions?: Array<{ label?: string }>
    } | null = null
    try { parsed = JSON.parse(tpl.messageContent) } catch { /* ignore */ }
    if (!parsed) {
      return wrap(
        <div className="bg-white rounded-2xl px-3 py-2 text-[12px] text-red-500" style={{ maxWidth: '320px' }}>
          ボタンテンプレートが解析できません
        </div>,
      )
    }
    return wrap(
      <div className="bg-white rounded-2xl overflow-hidden text-[13px] text-gray-900" style={{ maxWidth: '320px' }}>
        {parsed.thumbnailImageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={parsed.thumbnailImageUrl} alt="" className="w-full block" style={{ aspectRatio: '1.51 / 1', objectFit: 'cover' }} />
        )}
        <div className="px-3 py-2">
          {parsed.title && <p className="font-bold mb-1 break-words">{parsed.title}</p>}
          <p className="whitespace-pre-wrap break-words leading-relaxed">{parsed.text}</p>
        </div>
        <div className="border-t border-gray-100">
          {(parsed.actions ?? []).map((a, i) => (
            <div key={i} className="px-3 py-2 text-center text-[#06C755] border-b border-gray-100 last:border-0">
              {a.label || `ボタン ${i + 1}`}
            </div>
          ))}
        </div>
      </div>,
    )
  }

  // flex / unknown — fall back to a code panel since arbitrary flex JSON
  // can't be reliably rendered without the LINE SDK runtime.
  return wrap(
    <div className="bg-white rounded-2xl px-3 py-2 text-[11px] text-gray-700 font-mono whitespace-pre-wrap break-all" style={{ maxWidth: '320px' }}>
      {tpl.messageContent.length > 400 ? tpl.messageContent.slice(0, 400) + '…' : tpl.messageContent}
    </div>,
  )
}

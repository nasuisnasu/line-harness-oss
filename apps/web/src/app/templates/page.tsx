'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import CcPromptButton from '@/components/cc-prompt-button'
import { useAccount } from '@/lib/account-context'
import ButtonsTemplateEditor, {
  emptyButtonsValue,
  serializeButtons,
  deserializeButtons,
  type ButtonsTemplateValue,
} from '@/components/buttons-template-editor'

interface Template {
  id: string
  name: string
  category: string
  messageType: string
  messageContent: string
  createdAt: string
  updatedAt: string
}

const messageTypeLabels: Record<string, string> = {
  text: 'テキスト',
  image: '画像',
  flex: 'Flex',
  buttons: 'ボタン',
}

// LIFF mapping mirrors the entry-routes page so "open form" actions resolve to
// the right per-account LIFF endpoint. Update both places when adding accounts.
const liffIdMap: Record<string, string> = {
  'd49a3a13-8169-4b25-a669-3c8a4f4f964d': '2009821004-brTkmVVK',
  '40adcb23-277b-4d9d-b6e2-92fde47d31fb': '2006855304-UfNPHFOn',
}

interface CreateFormState {
  name: string
  category: string
  messageType: string
  messageContent: string
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const ccPrompts = [
  {
    title: 'テンプレート作成',
    prompt: `新しいメッセージテンプレートの作成をサポートしてください。
1. 用途別（挨拶、キャンペーン、通知、フォローアップ）のテンプレート文例を提案
2. テキスト・画像・Flexメッセージそれぞれの効果的な使い方
3. カテゴリ分類と命名規則のベストプラクティス
手順を示してください。`,
  },
  {
    title: 'テンプレート整理',
    prompt: `既存のテンプレートを整理・最適化してください。
1. カテゴリ別のテンプレート数と使用頻度を分析
2. 重複・類似テンプレートの統合提案
3. 不足しているカテゴリやテンプレートの追加推奨
結果をレポートしてください。`,
  },
]

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [selectedCategory, setSelectedCategory] = useState<string>('all')
  const [form, setForm] = useState<CreateFormState>({
    name: '',
    category: '',
    messageType: 'text',
    messageContent: '',
  })
  const [buttonsValue, setButtonsValue] = useState<ButtonsTemplateValue>(emptyButtonsValue())
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const { selectedAccount } = useAccount()
  const liffId = selectedAccount ? liffIdMap[selectedAccount.id] ?? null : null

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = selectedAccount ? { lineAccountId: selectedAccount.id } : undefined
      const res = await api.templates.list(
        selectedCategory !== 'all' ? selectedCategory : undefined,
        params
      )
      if (res.success) {
        setTemplates(res.data)
      } else {
        setError(res.error)
      }
    } catch {
      setError('テンプレートの読み込みに失敗しました。もう一度お試しください。')
    } finally {
      setLoading(false)
    }
  }, [selectedCategory, selectedAccount])

  useEffect(() => {
    load()
  }, [load])

  const categories = Array.from(
    new Set(templates.map((t) => t.category).filter(Boolean))
  )

  const handleCreate = async () => {
    if (!form.name.trim()) {
      setFormError('テンプレート名を入力してください')
      return
    }
    if (!form.category.trim()) {
      setFormError('カテゴリを入力してください')
      return
    }

    let messageContent = form.messageContent
    if (form.messageType === 'buttons') {
      if (!buttonsValue.text.trim()) {
        setFormError('本文を入力してください')
        return
      }
      const invalid = buttonsValue.actions.find((a) => {
        if (!a.label.trim()) return true
        if (a.kind === 'text') return !(a.text ?? '').trim()
        if (a.kind === 'url') return !(a.url ?? '').trim()
        if (a.kind === 'form') return !(a.formId ?? '').trim() || !liffId
        if (a.kind === 'event') return !(a.eventSlug ?? '').trim() || !liffId
        if (a.kind === 'scenario') return !(a.scenarioId ?? '').trim()
        if (a.kind === 'tag') return !(a.tagId ?? '').trim()
        return true
      })
      if (invalid) {
        setFormError('全てのボタンにラベルと内容を入力してください（フォーム／イベントはアカウントのLIFF設定が必要）')
        return
      }
      messageContent = JSON.stringify(serializeButtons(buttonsValue, liffId))
    } else if (!form.messageContent.trim()) {
      setFormError('メッセージ内容を入力してください')
      return
    }

    setSaving(true)
    setFormError('')
    try {
      const params = selectedAccount ? { lineAccountId: selectedAccount.id } : undefined
      const payload = {
        name: form.name,
        category: form.category,
        messageType: form.messageType,
        messageContent,
      }
      const res = editingId
        ? await api.templates.update(editingId, payload)
        : await api.templates.create(payload, params)
      if (res.success) {
        setShowCreate(false)
        setEditingId(null)
        setForm({ name: '', category: '', messageType: 'text', messageContent: '' })
        setButtonsValue(emptyButtonsValue())
        load()
      } else {
        setFormError(res.error)
      }
    } catch {
      setFormError(editingId ? '更新に失敗しました' : '作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const startEdit = (template: Template) => {
    setEditingId(template.id)
    setShowCreate(true)
    setForm({
      name: template.name,
      category: template.category,
      messageType: template.messageType,
      messageContent: template.messageContent,
    })
    if (template.messageType === 'buttons') {
      const restored = deserializeButtons(template.messageContent)
      setButtonsValue(restored ?? emptyButtonsValue())
    } else {
      setButtonsValue(emptyButtonsValue())
    }
    setFormError('')
  }

  const cancelEdit = () => {
    setShowCreate(false)
    setEditingId(null)
    setForm({ name: '', category: '', messageType: 'text', messageContent: '' })
    setButtonsValue(emptyButtonsValue())
    setFormError('')
  }

  const handleDelete = async (id: string) => {
    if (!confirm('このテンプレートを削除してもよいですか？')) return
    try {
      await api.templates.delete(id)
      load()
    } catch {
      setError('削除に失敗しました')
    }
  }

  const handleCopyLink = async (id: string) => {
    if (!liffId) {
      alert('このアカウントにはLIFFが設定されていません。左上でLIFFが紐付いたアカウントを選んでください。')
      return
    }
    // liffId は path だけでなく query にも入れる必要あり。
    // LIFF のリダイレクトで liff.state に詰められた後、main.ts は query から
    // liffId を読んで liff.init() するため、欠けると env fallback で別チャネル
    // を初期化しようとして "invalid liff id" になる。
    const url = `https://liff.line.me/${liffId}?page=send-template&id=${id}&liffId=${liffId}`
    try {
      await navigator.clipboard.writeText(url)
      alert(`リンクをコピーしました\n${url}`)
    } catch {
      window.prompt('リンクをコピーしてください', url)
    }
  }

  const handleTestSend = async (id: string) => {
    if (!selectedAccount) {
      alert('テスト送信するLINEアカウントを左上で選択してください')
      return
    }
    try {
      const res = await api.templates.testSend(id, selectedAccount.id)
      if (res.success) {
        alert(`テスト送信成功: ${res.data.sentTo}`)
      } else {
        alert(`テスト送信失敗: ${res.error}`)
      }
    } catch {
      alert('テスト送信に失敗しました')
    }
  }

  const handleUploadImage = async (file: File) => {
    try {
      const res = await api.uploads.image(file)
      if (!res.success) {
        setFormError(res.error)
        return
      }
      // For image-type templates, message_content is JSON
      // { originalContentUrl, previewImageUrl }; pre-fill both with the
      // uploaded URL so operators don't have to author the JSON manually.
      const next = JSON.stringify({
        originalContentUrl: res.data.url,
        previewImageUrl: res.data.url,
      }, null, 2)
      setForm((f) => ({ ...f, messageContent: next }))
    } catch {
      setFormError('アップロードに失敗しました')
    }
  }

  return (
    <div>
      <Header
        title="テンプレート管理"
        action={
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + 新規テンプレート
          </button>
        }
      />

      {/* Error */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Category filter */}
      {!loading && categories.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          <button
            onClick={() => setSelectedCategory('all')}
            className={`px-3 py-1.5 min-h-[44px] text-xs font-medium rounded-full transition-colors ${
              selectedCategory === 'all'
                ? 'text-white'
                : 'text-gray-600 bg-gray-100 hover:bg-gray-200'
            }`}
            style={selectedCategory === 'all' ? { backgroundColor: '#06C755' } : undefined}
          >
            全て
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`px-3 py-1.5 min-h-[44px] text-xs font-medium rounded-full transition-colors ${
                selectedCategory === cat
                  ? 'text-white'
                  : 'text-gray-600 bg-gray-100 hover:bg-gray-200'
              }`}
              style={selectedCategory === cat ? { backgroundColor: '#06C755' } : undefined}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="mb-6 bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-800 mb-4">{editingId ? 'テンプレートを編集' : '新規テンプレートを作成'}</h2>
          <div className="space-y-4 max-w-lg">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">テンプレート名 <span className="text-red-500">*</span></label>
              <input
                type="text"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                placeholder="例: ウェルカムメッセージ"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">カテゴリ <span className="text-red-500">*</span></label>
              <input
                type="text"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                placeholder="例: 挨拶、キャンペーン、通知"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">メッセージタイプ</label>
              <select
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                value={form.messageType}
                onChange={(e) => {
                  const next = e.target.value
                  setForm({ ...form, messageType: next })
                  if (next === 'buttons') {
                    const restored = form.messageContent ? deserializeButtons(form.messageContent) : null
                    setButtonsValue(restored ?? emptyButtonsValue())
                  }
                }}
              >
                <option value="text">テキスト</option>
                <option value="image">画像</option>
                <option value="flex">Flex</option>
                <option value="buttons">ボタン（画像 + タイトル + ボタン）</option>
              </select>
            </div>
            {form.messageType === 'buttons' ? (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-2">ボタンテンプレートの内容 <span className="text-red-500">*</span></label>
                <ButtonsTemplateEditor value={buttonsValue} onChange={setButtonsValue} liffId={liffId} />
              </div>
            ) : (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">メッセージ内容 <span className="text-red-500">*</span></label>
                {form.messageType === 'image' && (
                  <div className="mb-2">
                    <label className="text-xs text-gray-600 cursor-pointer hover:text-gray-900 inline-flex items-center gap-1">
                      <span className="px-2 py-1 border border-gray-300 rounded bg-gray-50 hover:bg-gray-100 text-xs">
                        📁 画像をファイルから選択
                      </span>
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/gif,image/webp"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0]
                          if (f) void handleUploadImage(f)
                          e.target.value = ''
                        }}
                      />
                    </label>
                    <span className="text-[11px] text-gray-400 ml-2">アップロード後、下のJSONが自動入力されます</span>
                  </div>
                )}
                <textarea
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-none font-mono"
                  rows={form.messageType === 'image' ? 5 : 4}
                  placeholder={form.messageType === 'image' ? '{"originalContentUrl":"https://...","previewImageUrl":"https://..."}' : 'メッセージ内容を入力してください'}
                  value={form.messageContent}
                  onChange={(e) => setForm({ ...form, messageContent: e.target.value })}
                />
              </div>
            )}

            {formError && <p className="text-xs text-red-600">{formError}</p>}

            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                disabled={saving}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
                style={{ backgroundColor: '#06C755' }}
              >
                {saving ? (editingId ? '更新中...' : '作成中...') : (editingId ? '更新' : '作成')}
              </button>
              <button
                onClick={cancelEdit}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Loading skeleton */}
      {loading ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="px-4 py-4 border-b border-gray-100 flex items-center gap-4 animate-pulse">
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-gray-200 rounded w-48" />
                <div className="h-2 bg-gray-100 rounded w-32" />
              </div>
              <div className="h-5 bg-gray-100 rounded-full w-16" />
              <div className="h-3 bg-gray-100 rounded w-24" />
            </div>
          ))}
        </div>
      ) : templates.length === 0 && !showCreate ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
          <p className="text-gray-500">テンプレートがありません。「新規テンプレート」から作成してください。</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  テンプレート名
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  カテゴリ
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  メッセージタイプ
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  作成日時
                </th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {templates.map((template) => (
                <tr key={template.id} className="hover:bg-gray-50 transition-colors">
                  {/* Name */}
                  <td className="px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{template.name}</p>
                      <p className="text-xs text-gray-400 mt-0.5 truncate max-w-xs">
                        {template.messageContent.slice(0, 50)}
                        {template.messageContent.length > 50 ? '...' : ''}
                      </p>
                    </div>
                  </td>

                  {/* Category */}
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                      {template.category}
                    </span>
                  </td>

                  {/* Message Type */}
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {messageTypeLabels[template.messageType] || template.messageType}
                  </td>

                  {/* Created At */}
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {formatDate(template.createdAt)}
                  </td>

                  {/* Actions */}
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex gap-1">
                      <button
                        onClick={() => handleCopyLink(template.id)}
                        disabled={!liffId}
                        title={liffId ? '特典PDF等に貼るLIFFリンクをコピー' : 'このアカウントにはLIFFが未設定'}
                        className="px-3 py-1 text-xs font-medium text-gray-700 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        リンク取得
                      </button>
                      <button
                        onClick={() => handleTestSend(template.id)}
                        className="px-3 py-1 text-xs font-medium text-white rounded-md transition-opacity hover:opacity-90"
                        style={{ backgroundColor: '#06C755' }}
                      >
                        テスト送信
                      </button>
                      <button
                        onClick={() => startEdit(template)}
                        className="px-3 py-1 text-xs font-medium text-gray-700 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
                      >
                        編集
                      </button>
                      <button
                        onClick={() => handleDelete(template.id)}
                        className="px-3 py-1 text-xs font-medium text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                      >
                        削除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
      <CcPromptButton prompts={ccPrompts} />
    </div>
  )
}

'use client'

import { useEffect, useState } from 'react'
import { api, type FormItem, type EventItem } from '@/lib/api'
import type { Scenario } from '@line-crm/shared'
import { useAccount } from '@/lib/account-context'

/**
 * Editor for the LINE Buttons Template message (image + title + text + 1-4 buttons).
 * Each button is one of three operator-friendly action types:
 *  - text  → posts a user message back into the chat (LINE 'message' action)
 *  - url   → opens an external URL (LINE 'uri' action)
 *  - form  → opens a LIFF form for the friend (LINE 'uri' action pointing to
 *            https://liff.line.me/{liffId}?page=form&id={formId})
 *
 * The serialized JSON kept in templates.message_content is normalized to native
 * LINE TemplateAction objects so the worker can buildMessage() it directly.
 * "form" buttons are stored as `uri` with a LIFF URL; on edit we sniff the URL
 * pattern to map back to a form picker for ergonomics.
 */

type ActionType = 'text' | 'url' | 'form' | 'event' | 'scenario' | 'tag'

export interface ButtonAction {
  kind: ActionType
  label: string
  text?: string
  url?: string
  formId?: string
  /** Event slug (consultation booking page) — resolved to a LIFF URL when serialized. */
  eventSlug?: string
  /** Scenario id — serialized as a postback action; webhook enrolls on tap. */
  scenarioId?: string
  /** Tag id (single-tag-only kind 'tag') */
  tagId?: string
  /** Extra side-effect tags fired on tap (postback kinds only). */
  extraTagIds?: string[]
  /** Extra side-effect scenario fired on tap (postback kinds only). */
  extraScenarioId?: string
}

export interface ButtonsTemplateValue {
  thumbnailImageUrl?: string
  title?: string
  text: string
  altText?: string
  actions: ButtonAction[]
}

export interface SerializedAction {
  type: 'message' | 'uri' | 'postback'
  label: string
  text?: string
  uri?: string
  data?: string
  displayText?: string
}

export interface SerializedButtons {
  thumbnailImageUrl?: string
  title?: string
  text: string
  altText?: string
  actions: SerializedAction[]
}

const FORM_LIFF_URL_RE = /^https:\/\/liff\.line\.me\/([^/?]+)\?(?:[^#]*&)?page=form&(?:[^#]*&)?id=([^&#]+)/
const EVENT_LIFF_URL_RE = /^https:\/\/liff\.line\.me\/([^/?]+)\?(?:[^#]*&)?page=event&(?:[^#]*&)?slug=([^&#]+)/

export function emptyButtonsValue(): ButtonsTemplateValue {
  return {
    thumbnailImageUrl: '',
    title: '',
    text: '',
    altText: '',
    actions: [{ kind: 'text', label: '', text: '' }],
  }
}

export function serializeButtons(value: ButtonsTemplateValue, liffId: string | null): SerializedButtons {
  const actions: SerializedAction[] = value.actions.map((a) => {
    if (a.kind === 'text') {
      return { type: 'message', label: a.label.trim(), text: (a.text ?? '').trim() }
    }
    if (a.kind === 'url') {
      return { type: 'uri', label: a.label.trim(), uri: (a.url ?? '').trim() }
    }
    if (a.kind === 'event') {
      const slug = (a.eventSlug ?? '').trim()
      // include `liffId` in query so the LIFF endpoint page can call liff.init()
      // with the correct ID even when env fallback would point elsewhere.
      const uri = liffId && slug
        ? `https://liff.line.me/${liffId}?page=event&slug=${encodeURIComponent(slug)}&liffId=${liffId}`
        : ''
      return { type: 'uri', label: a.label.trim(), uri }
    }
    if (a.kind === 'scenario' || a.kind === 'tag') {
      // Compound postback: a single tap fires up to one scenario plus any
      // number of tag attaches. The webhook side parses `action=postback`,
      // `scenario_id`, and `tag_ids` (CSV).
      const sid = (a.kind === 'scenario' ? (a.scenarioId ?? '') : (a.extraScenarioId ?? '')).trim()
      const tagIds = a.kind === 'tag'
        ? [a.tagId, ...(a.extraTagIds ?? [])].filter((v): v is string => !!v && v.trim() !== '')
        : (a.extraTagIds ?? []).filter((v) => v.trim() !== '')
      const params = new URLSearchParams()
      params.set('action', 'postback')
      if (sid) params.set('scenario_id', sid)
      if (tagIds.length > 0) params.set('tag_ids', tagIds.join(','))
      // Intentionally omit `displayText`: when set, LINE echoes the label as
      // if the friend typed it ("今すぐ申し込む！" appearing in chat). For
      // server-side compound effects we want a silent tap.
      return {
        type: 'postback',
        label: a.label.trim(),
        data: params.toString(),
      }
    }
    const id = (a.formId ?? '').trim()
    const uri = liffId && id
      ? `https://liff.line.me/${liffId}?page=form&id=${id}&liffId=${liffId}`
      : ''
    return { type: 'uri', label: a.label.trim(), uri }
  })
  const out: SerializedButtons = {
    text: value.text.trim(),
    actions,
  }
  if (value.thumbnailImageUrl?.trim()) out.thumbnailImageUrl = value.thumbnailImageUrl.trim()
  if (value.title?.trim()) out.title = value.title.trim()
  if (value.altText?.trim()) out.altText = value.altText.trim()
  return out
}

export function deserializeButtons(json: string): ButtonsTemplateValue | null {
  try {
    const parsed = JSON.parse(json) as SerializedButtons
    if (!parsed || !Array.isArray(parsed.actions)) return null
    const actions: ButtonAction[] = parsed.actions.map((a) => {
      if (a.type === 'message') {
        return { kind: 'text', label: a.label, text: a.text ?? '' }
      }
      if (a.type === 'postback') {
        const params = new URLSearchParams(a.data ?? '')
        const action = params.get('action')
        const sid = params.get('scenario_id') ?? ''
        const tagCsv = params.get('tag_ids') ?? ''
        const tagIds = tagCsv ? tagCsv.split(',').filter(Boolean) : []
        // Newer postback shape uses `action=postback` with optional scenario
        // + tags. Older shape was `action=enroll_scenario&scenario_id=...`.
        if (action === 'postback' || action === 'enroll_scenario') {
          if (sid && tagIds.length === 0) {
            return { kind: 'scenario', label: a.label, scenarioId: sid }
          }
          if (!sid && tagIds.length > 0) {
            return { kind: 'tag', label: a.label, tagId: tagIds[0], extraTagIds: tagIds.slice(1) }
          }
          if (sid && tagIds.length > 0) {
            return { kind: 'scenario', label: a.label, scenarioId: sid, extraTagIds: tagIds }
          }
        }
        return { kind: 'url', label: a.label, url: '' }
      }
      const url = a.uri ?? ''
      const fm = url.match(FORM_LIFF_URL_RE)
      if (fm) return { kind: 'form', label: a.label, formId: fm[2] }
      const em = url.match(EVENT_LIFF_URL_RE)
      if (em) return { kind: 'event', label: a.label, eventSlug: decodeURIComponent(em[2]) }
      return { kind: 'url', label: a.label, url }
    })
    return {
      thumbnailImageUrl: parsed.thumbnailImageUrl ?? '',
      title: parsed.title ?? '',
      text: parsed.text ?? '',
      altText: parsed.altText ?? '',
      actions: actions.length > 0 ? actions : [{ kind: 'text', label: '', text: '' }],
    }
  } catch {
    return null
  }
}

export default function ButtonsTemplateEditor({
  value,
  onChange,
  liffId,
}: {
  value: ButtonsTemplateValue
  onChange: (v: ButtonsTemplateValue) => void
  liffId: string | null
}) {
  const [forms, setForms] = useState<FormItem[]>([])
  const [events, setEvents] = useState<EventItem[]>([])
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [tags, setTags] = useState<{ id: string; name: string; groupName?: string | null }[]>([])
  const { selectedAccount } = useAccount()

  useEffect(() => {
    let cancelled = false
    api.forms.list().then((res) => {
      if (cancelled) return
      if (res.success) setForms(res.data)
    })
    api.events.list().then((res) => {
      if (cancelled) return
      if (res.success) setEvents(res.data)
    })
    const params = selectedAccount ? { lineAccountId: selectedAccount.id } : undefined
    api.scenarios.list(params).then((res) => {
      if (cancelled) return
      if (res.success) setScenarios(res.data)
    })
    api.tags.list(params).then((res) => {
      if (cancelled) return
      if (res.success) setTags(res.data.map(t => ({ id: t.id, name: t.name, groupName: t.groupName ?? null })))
    })
    return () => {
      cancelled = true
    }
  }, [selectedAccount])

  const updateAction = (index: number, patch: Partial<ButtonAction>) => {
    const next = value.actions.map((a, i) => (i === index ? { ...a, ...patch } : a))
    onChange({ ...value, actions: next })
  }

  const addButton = () => {
    if (value.actions.length >= 4) return
    onChange({ ...value, actions: [...value.actions, { kind: 'text', label: '', text: '' }] })
  }

  const removeButton = (index: number) => {
    if (value.actions.length <= 1) return
    onChange({ ...value, actions: value.actions.filter((_, i) => i !== index) })
  }

  const switchKind = (index: number, kind: ActionType) => {
    const current = value.actions[index]
    updateAction(index, { kind, text: '', url: '', formId: '', eventSlug: '', scenarioId: '', label: current.label })
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">画像（任意）</label>
          <ImageInput
            url={value.thumbnailImageUrl ?? ''}
            onChange={(url) => onChange({ ...value, thumbnailImageUrl: url })}
          />
          <p className="text-[11px] text-gray-400 mt-1">アスペクト比 1.51:1 推奨</p>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">タイトル（任意・40字まで）</label>
          <input
            type="text"
            maxLength={40}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            placeholder="例: 受験英語 INSIDER"
            value={value.title ?? ''}
            onChange={(e) => onChange({ ...value, title: e.target.value })}
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">
          本文 <span className="text-red-500">*</span>
          <span className="text-gray-400 ml-2">（画像なし: 160字 / 画像あり: 60字まで）</span>
        </label>
        <textarea
          rows={3}
          maxLength={160}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
          placeholder="例: ご登録ありがとうございます！下のボタンから次のステップに進んでください。"
          value={value.text}
          onChange={(e) => onChange({ ...value, text: e.target.value })}
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">
          通知用テキスト（任意）
          <span className="text-gray-400 ml-2">スマホの通知やトーク一覧に表示される文字</span>
        </label>
        <input
          type="text"
          maxLength={400}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          placeholder="未入力ならタイトル＋本文が自動使用されます"
          value={value.altText ?? ''}
          onChange={(e) => onChange({ ...value, altText: e.target.value })}
        />
        <p className="text-[11px] text-gray-400 mt-1">
          ボタン名やURLが通知に出てしまう場合、ここに「新しいご案内が届きました」など短い文を入れて隠せます。
        </p>
      </div>

      <div className="border-t border-gray-100 pt-3">
        <div className="flex items-center justify-between mb-2">
          <label className="block text-xs font-medium text-gray-600">ボタン（{value.actions.length}/4）</label>
          <button
            type="button"
            onClick={addButton}
            disabled={value.actions.length >= 4}
            className="text-xs text-green-700 hover:text-green-900 disabled:opacity-40"
          >
            + ボタンを追加
          </button>
        </div>
        <div className="space-y-3">
          {value.actions.map((action, index) => (
            <div key={index} className="border border-gray-200 rounded-lg p-3 bg-gray-50">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-700">ボタン {index + 1}</span>
                {value.actions.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeButton(index)}
                    className="text-xs text-red-500 hover:text-red-700"
                  >
                    削除
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-2">
                <div>
                  <label className="block text-[11px] text-gray-500 mb-1">アクション</label>
                  <select
                    className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
                    value={action.kind}
                    onChange={(e) => switchKind(index, e.target.value as ActionType)}
                  >
                    <option value="text">テキストを送信</option>
                    <option value="url">URLを開く</option>
                    <option value="form">フォームを開く</option>
                    <option value="event">イベントを開く</option>
                    <option value="scenario">シナリオを発動</option>
                    <option value="tag">タグを付与</option>
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-[11px] text-gray-500 mb-1">ボタンラベル（20字まで）</label>
                  <input
                    type="text"
                    maxLength={20}
                    className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="例: 詳しく見る"
                    value={action.label}
                    onChange={(e) => updateAction(index, { label: e.target.value })}
                  />
                </div>
              </div>
              {action.kind === 'text' && (
                <div>
                  <label className="block text-[11px] text-gray-500 mb-1">送信されるテキスト</label>
                  <input
                    type="text"
                    maxLength={300}
                    className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="例: 興味あります"
                    value={action.text ?? ''}
                    onChange={(e) => updateAction(index, { text: e.target.value })}
                  />
                </div>
              )}
              {action.kind === 'url' && (
                <div>
                  <label className="block text-[11px] text-gray-500 mb-1">開くURL</label>
                  <input
                    type="url"
                    className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="https://example.com/lp"
                    value={action.url ?? ''}
                    onChange={(e) => updateAction(index, { url: e.target.value })}
                  />
                </div>
              )}
              {action.kind === 'form' && (
                <div>
                  <label className="block text-[11px] text-gray-500 mb-1">フォーム</label>
                  {!liffId && (
                    <p className="text-[11px] text-amber-600 mb-1">
                      このアカウントのLIFF IDが未設定のため、フォームURLを生成できません
                    </p>
                  )}
                  <select
                    className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
                    value={action.formId ?? ''}
                    onChange={(e) => updateAction(index, { formId: e.target.value })}
                  >
                    <option value="">フォームを選択...</option>
                    {forms.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {action.kind === 'event' && (
                <div>
                  <label className="block text-[11px] text-gray-500 mb-1">イベント</label>
                  {!liffId && (
                    <p className="text-[11px] text-amber-600 mb-1">
                      このアカウントのLIFF IDが未設定のため、イベントURLを生成できません
                    </p>
                  )}
                  <select
                    className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
                    value={action.eventSlug ?? ''}
                    onChange={(e) => updateAction(index, { eventSlug: e.target.value })}
                  >
                    <option value="">イベントを選択...</option>
                    {events.filter(ev => ev.isActive).map((ev) => (
                      <option key={ev.id} value={ev.slug}>
                        {ev.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {action.kind === 'scenario' && (
                <div className="space-y-2">
                  <div>
                    <label className="block text-[11px] text-gray-500 mb-1">発動するシナリオ</label>
                    <select
                      className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
                      value={action.scenarioId ?? ''}
                      onChange={(e) => updateAction(index, { scenarioId: e.target.value })}
                    >
                      <option value="">シナリオを選択...</option>
                      {scenarios.filter(s => s.isActive).map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </div>
                  <ExtraTagsPicker
                    tags={tags}
                    value={action.extraTagIds ?? []}
                    onChange={(ids) => updateAction(index, { extraTagIds: ids })}
                    label="同時に付与するタグ（任意・複数可）"
                  />
                </div>
              )}
              {action.kind === 'tag' && (
                <div className="space-y-2">
                  <div>
                    <label className="block text-[11px] text-gray-500 mb-1">付与するタグ</label>
                    <select
                      className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
                      value={action.tagId ?? ''}
                      onChange={(e) => updateAction(index, { tagId: e.target.value })}
                    >
                      <option value="">タグを選択...</option>
                      {tags.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}{t.groupName ? `（${t.groupName}）` : ''}</option>
                      ))}
                    </select>
                  </div>
                  <ExtraTagsPicker
                    tags={tags.filter(t => t.id !== action.tagId)}
                    value={action.extraTagIds ?? []}
                    onChange={(ids) => updateAction(index, { extraTagIds: ids })}
                    label="さらに付与するタグ（任意・複数可）"
                  />
                  <div>
                    <label className="block text-[11px] text-gray-500 mb-1">同時に発動するシナリオ（任意）</label>
                    <select
                      className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
                      value={action.extraScenarioId ?? ''}
                      onChange={(e) => updateAction(index, { extraScenarioId: e.target.value })}
                    >
                      <option value="">指定なし</option>
                      {scenarios.filter(s => s.isActive).map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </div>
                  <p className="text-[11px] text-gray-400">タップ時にタグ付与＋（指定があれば）シナリオ発動が同時に行われます</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <ButtonsPreview value={value} />
    </div>
  )
}

/**
 * URL+upload combo. Operators can paste a URL or upload a file; uploads go to
 * the worker R2-backed /api/uploads/image and the returned URL replaces the
 * input value.
 */
function ImageInput({ url, onChange }: { url: string; onChange: (url: string) => void }) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const handleFile = async (file: File) => {
    setUploading(true)
    setError('')
    try {
      const res = await api.uploads.image(file)
      if (res.success) {
        onChange(res.data.url)
      } else {
        setError(res.error)
      }
    } catch {
      setError('アップロードに失敗しました')
    } finally {
      setUploading(false)
    }
  }
  return (
    <div className="space-y-1">
      <input
        type="url"
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
        placeholder="https://example.com/banner.jpg"
        value={url}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-600 cursor-pointer hover:text-gray-900 inline-flex items-center gap-1">
          <span className="px-2 py-1 border border-gray-300 rounded bg-gray-50 hover:bg-gray-100">
            {uploading ? 'アップロード中...' : '📁 ファイルから選択'}
          </span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleFile(file)
              e.target.value = ''
            }}
          />
        </label>
        {url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="h-8 w-8 rounded object-cover border border-gray-200" />
        )}
      </div>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  )
}

function ExtraTagsPicker({
  tags,
  value,
  onChange,
  label,
}: {
  tags: { id: string; name: string; groupName?: string | null }[]
  value: string[]
  onChange: (ids: string[]) => void
  label: string
}) {
  return (
    <div>
      <label className="block text-[11px] text-gray-500 mb-1">{label}</label>
      <div className="flex flex-wrap gap-1">
        {tags.length === 0 ? (
          <span className="text-[11px] text-gray-400">タグがありません</span>
        ) : (
          tags.map((t) => {
            const selected = value.includes(t.id)
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onChange(selected ? value.filter(id => id !== t.id) : [...value, t.id])}
                className={`text-[11px] px-2 py-0.5 rounded-full border ${selected ? 'bg-[#06C755] text-white border-transparent' : 'bg-white text-gray-600 border-gray-300'}`}
              >
                {selected ? '✓ ' : ''}{t.name}{t.groupName ? `（${t.groupName}）` : ''}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

function ButtonsPreview({ value }: { value: ButtonsTemplateValue }) {
  return (
    <div className="bg-[#7da9c0] rounded-lg p-3" aria-label="ボタンテンプレート プレビュー">
      <div className="flex items-start gap-2">
        <div className="w-8 h-8 rounded-full bg-white/40 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[10px] text-white/90 mb-1">公式アカウント</p>
          <div className="bg-white rounded-2xl overflow-hidden text-[13px] text-gray-900" style={{ maxWidth: '320px' }}>
            {value.thumbnailImageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={value.thumbnailImageUrl} alt="" className="w-full block" style={{ aspectRatio: '1.51 / 1', objectFit: 'cover' }} />
            )}
            <div className="px-3 py-2">
              {value.title && <p className="font-bold mb-1 break-words">{value.title}</p>}
              <p className="whitespace-pre-wrap break-words leading-relaxed">{value.text || <span className="text-gray-400">本文を入力</span>}</p>
            </div>
            <div className="border-t border-gray-100">
              {value.actions.map((a, i) => (
                <div
                  key={i}
                  className="px-3 py-2 text-center text-[#06C755] border-b border-gray-100 last:border-0"
                >
                  {a.label || <span className="text-gray-300">ボタン {i + 1}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

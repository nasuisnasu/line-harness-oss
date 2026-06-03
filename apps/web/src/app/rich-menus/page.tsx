'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { api, type RichMenuItem, type RichMenuAreaItem } from '@/lib/api'
import Header from '@/components/layout/header'
import { useAccount } from '@/lib/account-context'

const SIZE_DIMS = {
  full: { width: 2500, height: 1686 },
  compact: { width: 2500, height: 843 },
} as const

const RICH_MENU_BYTE_LIMIT = 1_000_000 // LINE: must be < 1MB

/**
 * Re-encode a user-picked image to fit LINE's rich menu requirements:
 *   - exact dimensions for the size_type
 *   - ≤1MB
 *   - JPEG (smaller than PNG for photo content; falls back to PNG if smaller)
 *
 * Adaptive quality: start at 0.9 and step down 0.1 until size fits.
 */
async function compressForRichMenu(
  file: File,
  targetWidth: number,
  targetHeight: number,
): Promise<File> {
  const img = await loadImage(file)
  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight)

  let quality = 0.9
  let blob: Blob | null = null
  while (quality >= 0.4) {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
    if (!blob) throw new Error('canvas toBlob failed')
    if (blob.size <= RICH_MENU_BYTE_LIMIT) break
    quality -= 0.1
  }
  if (!blob) throw new Error('canvas toBlob failed')
  return new File([blob], file.name.replace(/\.[^/.]+$/, '') + '.jpg', { type: 'image/jpeg' })
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('failed to load image'))
    }
    img.src = url
  })
}

const emptyArea: RichMenuAreaItem = {
  bounds: { x: 0, y: 0, width: 1250, height: 843 },
  action: { type: 'uri', label: 'リンク', uri: 'https://example.com' },
}

// LIFF mapping mirrors templates / broadcasts so the LIFF deep links
// resolve to the right per-account LIFF endpoint.
const liffIdMap: Record<string, string> = {
  'd49a3a13-8169-4b25-a669-3c8a4f4f964d': '2009821004-brTkmVVK',
  '40adcb23-277b-4d9d-b6e2-92fde47d31fb': '2006855304-UfNPHFOn',
}

type ActionKind = 'url' | 'event' | 'form'

const EVENT_LIFF_RE = /^https:\/\/liff\.line\.me\/([^/?]+)\?(?:[^#]*&)?page=event&(?:[^#]*&)?slug=([^&#]+)/
const FORM_LIFF_RE = /^https:\/\/liff\.line\.me\/([^/?]+)\?(?:[^#]*&)?page=form&(?:[^#]*&)?id=([^&#]+)/

function detectActionKind(uri: string | undefined | null): ActionKind {
  if (!uri) return 'url'
  if (EVENT_LIFF_RE.test(uri)) return 'event'
  if (FORM_LIFF_RE.test(uri)) return 'form'
  return 'url'
}

function extractEventSlug(uri: string): string {
  const m = EVENT_LIFF_RE.exec(uri ?? '')
  return m ? decodeURIComponent(m[2]) : ''
}

function extractFormId(uri: string): string {
  const m = FORM_LIFF_RE.exec(uri ?? '')
  return m ? decodeURIComponent(m[2]) : ''
}

function buildEventUri(liffId: string | null, slug: string): string {
  if (!liffId || !slug) return ''
  return `https://liff.line.me/${liffId}?page=event&slug=${encodeURIComponent(slug)}&liffId=${liffId}`
}

function buildFormUri(liffId: string | null, formId: string): string {
  if (!liffId || !formId) return ''
  return `https://liff.line.me/${liffId}?page=form&id=${formId}&liffId=${liffId}`
}

export default function RichMenusPage() {
  const [items, setItems] = useState<RichMenuItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const { selectedAccount } = useAccount()

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = selectedAccount ? { lineAccountId: selectedAccount.id } : undefined
      const res = await api.richMenus.list(params)
      if (res.success) setItems(res.data)
      else setError(res.error)
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccount])

  useEffect(() => { load() }, [load])

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`「${name}」を削除しますか？LINE側からも削除されます。`)) return
    await api.richMenus.delete(id)
    load()
  }

  const handleSetFriendAdd = async (id: string) => {
    if (!confirm('このメニューを「友達追加時に自動表示」に設定しますか？')) return
    const res = await api.richMenus.setFriendAdd(id)
    if (!res.success) { alert(res.error); return }
    load()
  }

  return (
    <div>
      <Header
        title="リッチメニュー"
        description="LINE公式アカウントのリッチメニューを管理"
        action={
          selectedAccount && (
            <button
              onClick={() => { setShowCreate(true); setEditingId(null) }}
              className="px-4 py-2 rounded-lg text-white text-sm font-medium"
              style={{ backgroundColor: '#06C755' }}
            >
              + 新規作成
            </button>
          )
        }
      />

      {!selectedAccount && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800 mb-4">
          上部からLINEアカウントを選択してください。
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700 mb-4">{error}</div>
      )}

      {(showCreate || editingId) && selectedAccount && (
        <RichMenuForm
          lineAccountId={selectedAccount.id}
          editingId={editingId}
          onCancel={() => { setShowCreate(false); setEditingId(null) }}
          onSaved={() => { setShowCreate(false); setEditingId(null); load() }}
        />
      )}

      {loading ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">読み込み中...</div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">
          リッチメニューがまだありません
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {items.map(item => (
            <div key={item.id} className="bg-white rounded-lg border border-gray-200 p-4 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-bold text-gray-900 mb-1">{item.name}</h3>
                  <div className="flex flex-wrap gap-1.5 text-xs">
                    <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-600">{item.sizeType === 'full' ? 'フル' : 'コンパクト'}</span>
                    <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-600">{item.areas.length}エリア</span>
                    {item.lineRichmenuId ? (
                      <span className="px-2 py-0.5 rounded bg-green-100 text-green-700">公開済み</span>
                    ) : (
                      <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-500">未公開</span>
                    )}
                    {item.showOnFriendAdd && (
                      <span className="px-2 py-0.5 rounded bg-purple-100 text-purple-700">友達追加時に自動表示</span>
                    )}
                  </div>
                </div>
              </div>

              {item.lineRichmenuId && (
                <img src={api.richMenus.imageUrl(item.id)} alt={item.name} className="w-full rounded border border-gray-200" />
              )}

              <p className="text-xs text-gray-500">
                <span className="font-medium">トーク欄表示:</span> {item.chatBarText} / {item.selected ? '開いた状態' : '閉じた状態'}
              </p>

              <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-100">
                <button
                  onClick={() => { setEditingId(item.id); setShowCreate(false) }}
                  className="text-xs px-3 py-1 rounded bg-gray-100 text-gray-700 hover:bg-gray-200"
                >
                  編集 / 公開
                </button>
                {item.lineRichmenuId && !item.showOnFriendAdd && (
                  <button
                    onClick={() => handleSetFriendAdd(item.id)}
                    className="text-xs px-3 py-1 rounded bg-purple-50 text-purple-700 hover:bg-purple-100 border border-purple-200"
                  >
                    友達追加時表示にする
                  </button>
                )}
                <button
                  onClick={() => handleDelete(item.id, item.name)}
                  className="text-xs px-3 py-1 rounded text-red-500 hover:text-red-700 hover:bg-red-50 ml-auto"
                >
                  削除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RichMenuForm({
  lineAccountId,
  editingId,
  onCancel,
  onSaved,
}: {
  lineAccountId: string
  editingId: string | null
  onCancel: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [sizeType, setSizeType] = useState<'full' | 'compact'>('full')
  const [chatBarText, setChatBarText] = useState('メニュー')
  const [selected, setSelected] = useState(true)
  const [showOnFriendAdd, setShowOnFriendAdd] = useState(false)
  const [areas, setAreas] = useState<RichMenuAreaItem[]>([{ ...emptyArea }])
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [savedMenuId, setSavedMenuId] = useState<string | null>(editingId)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [events, setEvents] = useState<{ id: string; name: string; slug: string }[]>([])
  const [forms, setForms] = useState<{ id: string; name: string }[]>([])
  const liffId = liffIdMap[lineAccountId] ?? null
  // Per-area "kind" override. detectActionKind only looks at the URI, but the
  // URI is empty until the operator picks an event/form, so without this state
  // the buttons appear unresponsive (selection bounces back to 'url').
  const [areaKinds, setAreaKinds] = useState<Record<number, ActionKind>>({})

  useEffect(() => {
    const params = { lineAccountId }
    void api.events.list(params).then((r) => {
      if (r.success) setEvents(r.data.map((e) => ({ id: e.id, name: e.name, slug: e.slug })))
    }).catch(() => {})
    void api.forms.list(params).then((r) => {
      if (r.success) setForms(r.data.map((f) => ({ id: f.id, name: f.name })))
    }).catch(() => {})
  }, [lineAccountId])

  // 既存メニューのロード
  useEffect(() => {
    if (!editingId) return
    api.richMenus.get(editingId).then(res => {
      if (res.success) {
        setName(res.data.name)
        setSizeType(res.data.sizeType)
        setChatBarText(res.data.chatBarText)
        setSelected(res.data.selected)
        setShowOnFriendAdd(res.data.showOnFriendAdd)
        setAreas(res.data.areas.length > 0 ? res.data.areas : [{ ...emptyArea }])
        setSavedMenuId(res.data.id)
        if (res.data.lineRichmenuId) {
          setImagePreview(api.richMenus.imageUrl(res.data.id))
        }
      }
    })
  }, [editingId])

  const dims = SIZE_DIMS[sizeType]

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setError('')
    try {
      // LINE rich menu images must be ≤1MB, between 800–2500px wide, and a
      // specific aspect ratio. We resize to the size_type's exact dimensions
      // and re-encode as JPEG with adaptive quality so the result fits.
      const compressed = await compressForRichMenu(f, dims.width, dims.height)
      setImageFile(compressed)
      const url = URL.createObjectURL(compressed)
      setImagePreview(url)
    } catch (err) {
      console.error('image compression failed:', err)
      setError('画像の圧縮に失敗しました。別の画像を試してください。')
    }
  }

  const updateArea = (idx: number, updater: (a: RichMenuAreaItem) => RichMenuAreaItem) => {
    setAreas(prev => prev.map((a, i) => i === idx ? updater(a) : a))
  }

  const addArea = () => setAreas(prev => [...prev, { ...emptyArea, bounds: { ...emptyArea.bounds } }])
  const removeArea = (idx: number) => setAreas(prev => prev.filter((_, i) => i !== idx))

  const handleSaveMenu = async (): Promise<string | null> => {
    if (!name.trim()) { setError('名前を入力してください'); return null }
    setSaving(true)
    setError('')
    try {
      if (savedMenuId) {
        const res = await api.richMenus.update(savedMenuId, { name, sizeType, chatBarText, selected, areas })
        if (!res.success) { setError(res.error); return null }
        // 友達追加時表示の切替
        if (showOnFriendAdd) {
          await api.richMenus.setFriendAdd(savedMenuId)
        }
        return savedMenuId
      } else {
        const res = await api.richMenus.create({ lineAccountId, name, sizeType, chatBarText, selected, areas, showOnFriendAdd })
        if (!res.success) { setError(res.error); return null }
        setSavedMenuId(res.data.id)
        // 友達追加時表示が有効なら他のメニューを自動でOFFにする
        if (showOnFriendAdd) {
          await api.richMenus.setFriendAdd(res.data.id)
        }
        return res.data.id
      }
    } finally {
      setSaving(false)
    }
  }

  const handlePublish = async () => {
    if (!imageFile) { setError('画像を選択してください'); return }
    const id = await handleSaveMenu()
    if (!id) return
    setSaving(true)
    setError('')
    try {
      const res = await api.richMenus.publish(id, imageFile)
      if (!res.success) { setError(res.error); return }
      alert('LINEに公開しました')
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : '公開に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
      <h2 className="text-base font-semibold text-gray-900 mb-4">{editingId ? 'リッチメニュー編集' : '新規リッチメニュー'}</h2>

      {error && <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700 mb-4">{error}</div>}

      <div className="space-y-4 max-w-2xl">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">管理用の名前 *</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="例: 通常メニュー / 申込者用メニュー"
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">サイズ</label>
            <select value={sizeType} onChange={e => setSizeType(e.target.value as 'full' | 'compact')} className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white">
              <option value="full">フル (2500×1686)</option>
              <option value="compact">コンパクト (2500×843)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">トーク欄ラベル</label>
            <input
              type="text"
              value={chatBarText}
              onChange={e => setChatBarText(e.target.value)}
              maxLength={14}
              placeholder="メニュー"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input type="checkbox" id="selected" checked={selected} onChange={e => setSelected(e.target.checked)} className="rounded" />
          <label htmlFor="selected" className="text-sm text-gray-700">デフォルトで開いた状態にする</label>
        </div>

        <div className="flex items-start gap-2 p-3 bg-purple-50 border border-purple-200 rounded">
          <input type="checkbox" id="friendAdd" checked={showOnFriendAdd} onChange={e => setShowOnFriendAdd(e.target.checked)} className="rounded mt-0.5" />
          <div>
            <label htmlFor="friendAdd" className="text-sm font-medium text-gray-800 cursor-pointer">友達追加時にこのメニューを自動表示する</label>
            <p className="text-xs text-gray-600 mt-0.5">同一アカウント内で1つだけ有効にできます。ONにすると他のメニューの「友達追加時表示」は自動でOFFになります。</p>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">画像 *（PNG/JPEG・1MB以下推奨）</label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg"
            onChange={handleFileChange}
            className="text-sm w-full"
          />
          <p className="text-xs text-gray-500 mt-1">推奨サイズ: {dims.width}×{dims.height}</p>
          {imagePreview && (
            <div className="relative mt-3 inline-block max-w-full">
              <img src={imagePreview} alt="preview" className="max-w-full rounded border border-gray-200" style={{ maxHeight: 400 }} />
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium text-gray-600">タップ領域（ピクセル単位）</label>
            <button onClick={addArea} className="text-xs px-2 py-1 rounded bg-gray-100 hover:bg-gray-200">+ エリア追加</button>
          </div>
          <p className="text-xs text-gray-500 mb-2">画像の左上を (0,0) として、各エリアの位置と大きさを指定。最大20エリアまで。</p>
          <div className="space-y-3">
            {areas.map((a, idx) => (
              <div key={idx} className="border border-gray-200 rounded-lg p-3 bg-gray-50">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-gray-700">エリア {idx + 1}</span>
                  {areas.length > 1 && (
                    <button onClick={() => removeArea(idx)} className="text-xs text-red-500 hover:text-red-700">削除</button>
                  )}
                </div>
                <div className="grid grid-cols-4 gap-2 mb-2">
                  {(['x', 'y', 'width', 'height'] as const).map(k => (
                    <div key={k}>
                      <label className="block text-xs text-gray-500 mb-0.5">{k}</label>
                      <input
                        type="number"
                        value={a.bounds[k]}
                        onChange={e => updateArea(idx, x => ({ ...x, bounds: { ...x.bounds, [k]: Number(e.target.value) } }))}
                        className="w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white"
                      />
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-1 gap-2">
                  {(() => {
                    // Detect from URI first (so saved buttons show correctly),
                    // but allow areaKinds override after the operator clicks.
                    const detected = detectActionKind(a.action.uri)
                    const kind: ActionKind = areaKinds[idx] ?? detected
                    const eventSlug = kind === 'event' ? extractEventSlug(a.action.uri ?? '') : ''
                    const formId = kind === 'form' ? extractFormId(a.action.uri ?? '') : ''
                    const setKind = (next: ActionKind) => {
                      setAreaKinds((m) => ({ ...m, [idx]: next }))
                      // Clear URI when changing kind so the editor doesn't keep
                      // a stale URL from a different kind.
                      updateArea(idx, x => ({ ...x, action: { ...x.action, type: 'uri', uri: '' } }))
                    }
                    return (
                      <>
                        <div>
                          <label className="block text-xs text-gray-500 mb-0.5">アクション種別</label>
                          <div className="flex gap-1">
                            {(['url', 'event', 'form'] as const).map((k) => (
                              <button
                                key={k}
                                type="button"
                                onClick={() => setKind(k)}
                                className={`text-xs px-2 py-1 rounded border ${kind === k ? 'border-green-500 bg-green-50 text-green-700' : 'border-gray-300 bg-white text-gray-600'}`}
                              >
                                {k === 'url' ? 'URL直接' : k === 'event' ? 'イベント' : 'フォーム'}
                              </button>
                            ))}
                          </div>
                        </div>
                        {kind === 'url' && (
                          <div>
                            <label className="block text-xs text-gray-500 mb-0.5">遷移先URL</label>
                            <input
                              type="url"
                              value={a.action.uri ?? ''}
                              onChange={e => updateArea(idx, x => ({ ...x, action: { ...x.action, type: 'uri', uri: e.target.value } }))}
                              placeholder="https://..."
                              className="w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white"
                            />
                          </div>
                        )}
                        {kind === 'event' && (
                          <div>
                            <label className="block text-xs text-gray-500 mb-0.5">イベントを選択</label>
                            <select
                              value={eventSlug}
                              onChange={e => {
                                const slug = e.target.value
                                updateArea(idx, x => ({ ...x, action: { ...x.action, type: 'uri', uri: buildEventUri(liffId, slug) } }))
                              }}
                              className="w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white"
                            >
                              <option value="">選択してください</option>
                              {events.map((ev) => (
                                <option key={ev.id} value={ev.slug}>{ev.name}</option>
                              ))}
                            </select>
                            {!liffId && <p className="text-[10px] text-red-500 mt-0.5">このアカウントの LIFF ID が未設定です</p>}
                          </div>
                        )}
                        {kind === 'form' && (
                          <div>
                            <label className="block text-xs text-gray-500 mb-0.5">フォームを選択</label>
                            <select
                              value={formId}
                              onChange={e => {
                                const fid = e.target.value
                                updateArea(idx, x => ({ ...x, action: { ...x.action, type: 'uri', uri: buildFormUri(liffId, fid) } }))
                              }}
                              className="w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white"
                            >
                              <option value="">選択してください</option>
                              {forms.map((f) => (
                                <option key={f.id} value={f.id}>{f.name}</option>
                              ))}
                            </select>
                            {!liffId && <p className="text-[10px] text-red-500 mt-0.5">このアカウントの LIFF ID が未設定です</p>}
                          </div>
                        )}
                      </>
                    )
                  })()}
                  <div>
                    <label className="block text-xs text-gray-500 mb-0.5">ラベル（任意）</label>
                    <input
                      type="text"
                      value={a.action.label ?? ''}
                      onChange={e => updateArea(idx, x => ({ ...x, action: { ...x.action, label: e.target.value } }))}
                      placeholder="例: セミナーに申し込む"
                      className="w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex gap-2 pt-3 border-t border-gray-200">
          <button
            onClick={handleSaveMenu}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded disabled:opacity-50"
          >
            {saving ? '保存中...' : '一時保存（公開しない）'}
          </button>
          <button
            onClick={handlePublish}
            disabled={saving || !imageFile}
            className="px-4 py-2 text-sm font-medium text-white rounded disabled:opacity-50"
            style={{ backgroundColor: '#06C755' }}
          >
            {saving ? '公開中...' : 'LINEに公開する'}
          </button>
          <button onClick={onCancel} disabled={saving} className="ml-auto px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded">キャンセル</button>
        </div>
      </div>
    </div>
  )
}

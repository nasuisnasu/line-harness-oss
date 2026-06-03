'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'

interface Conn {
  id: string
  calendarId: string
  authType: string
  isActive: boolean
  createdAt: string
}

export default function GoogleCalendarPage() {
  const [conns, setConns] = useState<Conn[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [calendarId, setCalendarId] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [authType, setAuthType] = useState<'service_account' | 'access_token'>('service_account')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.googleCalendar.list()
      if (res.success) setConns(res.data)
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleAdd = async () => {
    if (!calendarId.trim()) {
      setError('Calendar ID は必須です')
      return
    }
    if (authType === 'access_token' && !accessToken.trim()) {
      setError('Access Token を入力してください')
      return
    }
    setSaving(true)
    setError('')
    try {
      const res = await api.googleCalendar.connect({
        calendarId: calendarId.trim(),
        authType,
        accessToken: authType === 'access_token' ? accessToken.trim() : undefined,
      })
      if (res.success) {
        setShowAdd(false)
        setCalendarId('')
        setAccessToken('')
        load()
      } else {
        setError(res.error)
      }
    } catch {
      setError('接続に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string, label: string) => {
    if (!confirm(`「${label}」の接続を解除しますか？\n（この接続を使うイベントは予約取得・登録ができなくなります）`)) return
    await api.googleCalendar.delete(id)
    load()
  }

  return (
    <div>
      <Header
        title="Google Calendar 連携"
        action={
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 text-sm font-medium text-white rounded-lg hover:opacity-90" style={{ backgroundColor: '#06C755' }}>
            + 新規接続
          </button>
        }
      />

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>}

      {showAdd && (
        <div className="mb-6 bg-white rounded-lg border border-gray-200 p-6 max-w-2xl">
          <h2 className="text-sm font-semibold text-gray-800 mb-4">Google Calendar を接続</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">認証方式</label>
              <div className="flex gap-2">
                <button type="button" onClick={() => setAuthType('service_account')} className={`text-xs px-3 py-1.5 rounded border ${authType === 'service_account' ? 'border-[#06C755] bg-[#06C755]/10 text-[#06C755]' : 'border-gray-300 text-gray-600 bg-white'}`}>
                  サービスアカウント（推奨）
                </button>
                <button type="button" onClick={() => setAuthType('access_token')} className={`text-xs px-3 py-1.5 rounded border ${authType === 'access_token' ? 'border-[#06C755] bg-[#06C755]/10 text-[#06C755]' : 'border-gray-300 text-gray-600 bg-white'}`}>
                  Access Token（仮）
                </button>
              </div>
              {authType === 'service_account' && (
                <p className="text-[11px] text-gray-500 mt-1">サーバー側に登録済みのサービスアカウントが、共有されたカレンダーにアクセスします。トークンは自動更新で運用フリー</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Calendar ID <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={calendarId}
                onChange={(e) => setCalendarId(e.target.value)}
                placeholder="例: yourname@gmail.com"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
              />
              <p className="text-[11px] text-gray-400 mt-1">Google Calendar の「カレンダー設定」→「カレンダーの統合」に書かれている ID</p>
              {authType === 'service_account' && (
                <p className="text-[11px] text-amber-600 mt-1">⚠ このカレンダーをサービスアカウント <code>line-harness-calendar@readash-491401.iam.gserviceaccount.com</code> に「予定の変更権限」で共有しておいてください</p>
              )}
            </div>
            {authType === 'access_token' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Access Token <span className="text-red-500">*</span></label>
                <textarea
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  placeholder="ya29.xxxxxxxxxxxxxxxxxxxxx..."
                  rows={3}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono resize-none"
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  <a href="https://developers.google.com/oauthplayground" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">OAuth 2.0 Playground</a> で <code>https://www.googleapis.com/auth/calendar</code> スコープを承認 → Access Token をコピーして貼り付け
                </p>
                <p className="text-[11px] text-amber-600 mt-1">⚠ Access Token は1時間で失効します。長期運用にはサービスアカウント方式を使ってください</p>
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={handleAdd} disabled={saving} className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50" style={{ backgroundColor: '#06C755' }}>
                {saving ? '接続中...' : '接続する'}
              </button>
              <button onClick={() => { setShowAdd(false); setError('') }} className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg">キャンセル</button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-sm text-gray-400">読み込み中...</div>
      ) : conns.length === 0 ? (
        <div className="text-center py-12 text-sm text-gray-400">接続されたカレンダーはありません。「+ 新規接続」から追加してください。</div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">Calendar ID</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">認証方式</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">状態</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">追加日時</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {conns.map((c) => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-900 font-mono">{c.calendarId}</td>
                  <td className="px-4 py-3 text-gray-600">{c.authType}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${c.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {c.isActive ? '有効' : '無効'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{new Date(c.createdAt).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                  <td className="px-4 py-3 text-right">
                    <button onClick={() => handleDelete(c.id, c.calendarId)} className="text-xs text-red-500 hover:text-red-700">解除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

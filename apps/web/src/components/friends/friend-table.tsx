'use client'

import { useState, useEffect } from 'react'
import type { RichMenuItem } from '@/lib/api'
import type { Tag } from '@line-crm/shared'
import type { FriendWithTags } from '@/lib/api'
import { api } from '@/lib/api'
import TagBadge from './tag-badge'
import FriendInfoPanel from './friend-info-panel'
import { withGroup } from '@/lib/format-group'

interface FriendTableProps {
  friends: FriendWithTags[]
  allTags: Tag[]
  onRefresh: () => void
}

type ScenarioHistory = {
  id: string; scenarioId: string; scenarioName: string;
  status: string; currentStepOrder: number; startedAt: string; nextDeliveryAt: string | null;
  steps: {
    stepOrder: number; messageType: string; messageContent: string;
    delayMinutes: number;
    delayMode?: string; delayDays?: number | null; delayTime?: string | null; delayAt?: string | null;
    sent: boolean;
  }[];
}

export default function FriendTable({ friends, allTags, onRefresh }: FriendTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [addingTagForFriend, setAddingTagForFriend] = useState<string | null>(null)
  const [selectedTagId, setSelectedTagId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [scenarioHistories, setScenarioHistories] = useState<Record<string, ScenarioHistory[]>>({})
  const [richMenus, setRichMenus] = useState<RichMenuItem[]>([])
  const [richMenuMessage, setRichMenuMessage] = useState('')

  useEffect(() => {
    api.richMenus.list().then(res => { if (res.success) setRichMenus(res.data.filter(r => r.lineRichmenuId)) }).catch(() => {})
  }, [])

  const handleAssignRichMenu = async (friendId: string, richMenuRecordId: string) => {
    setLoading(true)
    setRichMenuMessage('')
    try {
      const res = await api.richMenus.assignToFriend(friendId, richMenuRecordId)
      if (res.success) setRichMenuMessage('✓ リッチメニューを割り当てました')
      else setError(res.error)
    } catch {
      setError('リッチメニューの割当に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handleUnlinkRichMenu = async (friendId: string) => {
    if (!confirm('この友達のリッチメニューを解除しますか？')) return
    setLoading(true)
    setRichMenuMessage('')
    try {
      const res = await api.richMenus.unlinkFromFriend(friendId)
      if (res.success) setRichMenuMessage('✓ リッチメニューを解除しました')
      else setError(res.error)
    } catch {
      setError('解除に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const toggleExpand = async (id: string) => {
    const next = expandedId === id ? null : id
    setExpandedId(next)
    setAddingTagForFriend(null)
    setSelectedTagId('')
    setError('')
    if (next && !scenarioHistories[id]) {
      try {
        const res = await api.friends.scenarios(id)
        if (res.success) setScenarioHistories(prev => ({ ...prev, [id]: res.data }))
      } catch { /* ignore */ }
    }
  }

  const handleAddTag = async (friendId: string) => {
    if (!selectedTagId) return
    setLoading(true)
    setError('')
    try {
      await api.friends.addTag(friendId, selectedTagId)
      setAddingTagForFriend(null)
      setSelectedTagId('')
      onRefresh()
    } catch {
      setError('タグの追加に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handleRemoveTag = async (friendId: string, tagId: string) => {
    setLoading(true)
    setError('')
    try {
      await api.friends.removeTag(friendId, tagId)
      onRefresh()
    } catch {
      setError('タグの削除に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const handleToggleBlock = async (friendId: string, currentlyBlocked: boolean) => {
    setLoading(true)
    setError('')
    try {
      await api.friends.block(friendId, !currentlyBlocked)
      onRefresh()
    } catch {
      setError('配信除外の設定に失敗しました')
    } finally {
      setLoading(false)
    }
  }

  const formatDate = (iso: string) => {
    return new Date(iso).toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  }

  if (friends.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
        <p className="text-gray-500">友だちが見つかりません</p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {error && (
        <div className="px-4 py-3 bg-red-50 border-b border-red-100 text-red-700 text-sm">
          {error}
        </div>
      )}
      <div className="overflow-x-auto">
      <table className="w-full min-w-[640px]">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-200">
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
              アイコン / 表示名
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
              ステータス
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
              タグ
            </th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
              登録日
            </th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {friends.map((friend) => {
            const isExpanded = expandedId === friend.id
            const isAddingTag = addingTagForFriend === friend.id
            const availableTags = allTags.filter(
              (t) => !friend.tags.some((ft) => ft.id === t.id)
            )

            return (
              <>
                <tr
                  key={friend.id}
                  className="hover:bg-gray-50 cursor-pointer transition-colors"
                  onClick={() => { void toggleExpand(friend.id) }}
                >
                  {/* Avatar + Name */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {friend.pictureUrl ? (
                        <img
                          src={friend.pictureUrl}
                          alt={friend.displayName}
                          className="w-9 h-9 rounded-full object-cover bg-gray-100"
                        />
                      ) : (
                        <div className="w-9 h-9 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-sm font-medium">
                          {friend.displayName?.charAt(0) ?? '?'}
                        </div>
                      )}
                      <div>
                        <p className="text-sm font-medium text-gray-900">{friend.displayName}</p>
                        {friend.statusMessage && (
                          <p className="text-xs text-gray-400 truncate max-w-[160px]">{friend.statusMessage}</p>
                        )}
                      </div>
                    </div>
                  </td>

                  {/* Following status */}
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      {friend.isFollowing ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                          フォロー中
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">
                          ブロック/退会
                        </span>
                      )}
                      {friend.isBlocked && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-600">
                          配信除外
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Tags */}
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {friend.tags.length > 0 ? (
                        friend.tags.map((tag) => <TagBadge key={tag.id} tag={tag} />)
                      ) : (
                        <span className="text-xs text-gray-400">なし</span>
                      )}
                    </div>
                  </td>

                  {/* Registered date */}
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {formatDate(friend.createdAt)}
                  </td>

                  {/* Expand indicator */}
                  <td className="px-4 py-3 text-right">
                    <svg
                      className={`w-4 h-4 text-gray-400 transition-transform inline-block ${isExpanded ? 'rotate-180' : ''}`}
                      fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </td>
                </tr>

                {/* Expanded detail row */}
                {isExpanded && (
                  <tr key={`${friend.id}-detail`} className="bg-gray-50">
                    <td colSpan={5} className="px-6 py-4">
                      <div className="space-y-3">
                        {/* 流入経路 / 登録日 / 予約 / 入金 */}
                        <FriendInfoPanel friendId={friend.id} />

                        <div>
                          <p className="text-xs font-semibold text-gray-500 mb-1">LINE ユーザーID</p>
                          <p className="text-xs text-gray-600 font-mono">{friend.lineUserId}</p>
                        </div>

                        {/* Scenario delivery history */}
                        {(scenarioHistories[friend.id] ?? []).map((sc) => (
                          <div key={sc.id}>
                            <p className="text-xs font-semibold text-gray-500 mb-1">
                              シナリオ: {sc.scenarioName}
                              <span className={`ml-2 px-1.5 py-0.5 rounded text-xs font-medium ${
                                sc.status === 'active' ? 'bg-blue-100 text-blue-700' :
                                sc.status === 'completed' ? 'bg-green-100 text-green-700' :
                                'bg-gray-100 text-gray-500'
                              }`}>{sc.status === 'active' ? '配信中' : sc.status === 'completed' ? '完了' : sc.status}</span>
                            </p>
                            <div className="space-y-1 ml-2">
                              {sc.steps.map((step) => (
                                <div key={step.stepOrder} className="flex items-start gap-2 text-xs">
                                  <span className={`mt-0.5 w-3 h-3 rounded-full flex-shrink-0 ${step.sent ? 'bg-green-400' : 'bg-gray-300'}`} />
                                  <span className={step.sent ? 'text-gray-700' : 'text-gray-400'}>
                                    {(() => {
                                      // Show absolute / days_at_time deliveries with their wall-clock target so
                                      // operators can see the schedule, not just "即時" everywhere.
                                      if (step.delayMode === 'absolute' && step.delayAt) {
                                        const m = step.delayAt.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
                                        if (m) return `${m[2]}/${m[3]} ${m[4]}:${m[5]}`
                                        return step.delayAt
                                      }
                                      if (step.delayMode === 'days_at_time' && step.delayDays != null && step.delayTime) {
                                        return `${step.delayDays}日後 ${step.delayTime}`
                                      }
                                      return step.delayMinutes === 0 ? '即時' : `${step.delayMinutes}分後`
                                    })()}
                                    {'　'}
                                    {step.messageContent.slice(0, 40)}{step.messageContent.length > 40 ? '…' : ''}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}

                        {/* Tag management */}
                        <div>
                          <p className="text-xs font-semibold text-gray-500 mb-2">タグ管理</p>
                          <div className="flex flex-wrap gap-1.5 mb-2">
                            {friend.tags.map((tag) => (
                              <TagBadge
                                key={tag.id}
                                tag={tag}
                                onRemove={() => handleRemoveTag(friend.id, tag.id)}
                              />
                            ))}
                          </div>

                          {isAddingTag ? (
                            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                              <select
                                className="text-sm border border-gray-300 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-green-500"
                                value={selectedTagId}
                                onChange={(e) => setSelectedTagId(e.target.value)}
                              >
                                <option value="">タグを選択...</option>
                                {availableTags.map((tag) => (
                                  <option key={tag.id} value={tag.id}>{withGroup(tag.name, tag.groupName)}</option>
                                ))}
                              </select>
                              <button
                                onClick={() => handleAddTag(friend.id)}
                                disabled={!selectedTagId || loading}
                                className="px-3 py-1 text-xs font-medium rounded-md text-white disabled:opacity-50 transition-opacity"
                                style={{ backgroundColor: '#06C755' }}
                              >
                                追加
                              </button>
                              <button
                                onClick={() => { setAddingTagForFriend(null); setSelectedTagId('') }}
                                className="px-3 py-1 text-xs font-medium rounded-md text-gray-600 bg-gray-200 hover:bg-gray-300 transition-colors"
                              >
                                キャンセル
                              </button>
                            </div>
                          ) : (
                            availableTags.length > 0 && (
                              <button
                                onClick={(e) => { e.stopPropagation(); setAddingTagForFriend(friend.id) }}
                                className="text-xs font-medium text-green-600 hover:text-green-700 flex items-center gap-1 transition-colors"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                </svg>
                                タグを追加
                              </button>
                            )
                          )}
                        </div>

                        {/* Rich menu assignment */}
                        {richMenus.length > 0 && (
                          <div className="pt-1 border-t border-gray-200" onClick={(e) => e.stopPropagation()}>
                            <p className="text-xs font-semibold text-gray-500 mb-1">リッチメニュー割当</p>
                            <div className="flex items-center gap-2">
                              <select
                                className="text-xs border border-gray-300 rounded px-2 py-1 bg-white"
                                defaultValue=""
                                onChange={async (e) => {
                                  const id = e.target.value
                                  if (id) {
                                    await handleAssignRichMenu(friend.id, id)
                                    e.target.value = ''
                                  }
                                }}
                              >
                                <option value="">選んで割り当て...</option>
                                {richMenus.map(rm => (
                                  <option key={rm.id} value={rm.id}>{rm.name}</option>
                                ))}
                              </select>
                              <button
                                onClick={() => void handleUnlinkRichMenu(friend.id)}
                                disabled={loading}
                                className="text-xs px-2 py-1 rounded text-gray-500 hover:text-gray-700 hover:bg-gray-100"
                              >
                                解除
                              </button>
                            </div>
                            {richMenuMessage && <p className="text-xs text-green-600 mt-1">{richMenuMessage}</p>}
                          </div>
                        )}

                        {/* Block toggle */}
                        <div className="pt-1 border-t border-gray-200">
                          <button
                            onClick={(e) => { e.stopPropagation(); void handleToggleBlock(friend.id, friend.isBlocked) }}
                            disabled={loading}
                            className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors disabled:opacity-50 ${
                              friend.isBlocked
                                ? 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                : 'bg-red-50 text-red-600 hover:bg-red-100'
                            }`}
                          >
                            {friend.isBlocked ? '配信除外を解除する' : '配信から除外する'}
                          </button>
                          {friend.isBlocked && (
                            <p className="text-xs text-red-500 mt-1">この友だちには今後どのシナリオも配信されません</p>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            )
          })}
        </tbody>
      </table>
      </div>
    </div>
  )
}

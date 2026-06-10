'use client'

import { Suspense, useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import type { Tag } from '@line-crm/shared'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import CcPromptButton from '@/components/cc-prompt-button'
import FriendInfoPanel from '@/components/friends/friend-info-panel'
import { useAccount } from '@/lib/account-context'
import { withGroup } from '@/lib/format-group'

interface Chat {
  id: string
  friendId: string
  friendName: string
  friendPictureUrl: string | null
  operatorId: string | null
  status: 'unread' | 'in_progress' | 'resolved'
  notes: string | null
  lastMessageAt: string | null
  createdAt: string
  updatedAt: string
}

interface ChatMessage {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  createdAt: string
}

interface ChatDetail extends Chat {
  friendName: string
  friendPictureUrl: string | null
  messages?: ChatMessage[]
}

type StatusFilter = 'all' | 'unread' | 'in_progress' | 'resolved'

const statusConfig: Record<Chat['status'], { label: string; className: string }> = {
  unread: { label: '未読', className: 'bg-red-100 text-red-700' },
  in_progress: { label: '対応中', className: 'bg-yellow-100 text-yellow-700' },
  resolved: { label: '解決済', className: 'bg-green-100 text-green-700' },
}

const statusFilters: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '全て' },
  { key: 'unread', label: '未読' },
  { key: 'in_progress', label: '対応中' },
  { key: 'resolved', label: '解決済' },
]

function formatDatetime(iso: string | null): string {
  if (!iso) return '-'
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
    title: 'チャット対応テンプレート',
    prompt: `チャット対応で使えるテンプレートメッセージを作成してください。
1. よくある質問への回答テンプレート（挨拶、FAQ、サポート）
2. クレーム対応用の丁寧な返信テンプレート
3. フォローアップメッセージのテンプレート
手順を示してください。`,
  },
  {
    title: '未対応チャット確認',
    prompt: `未対応のチャットを確認し、対応優先度を整理してください。
1. 未読・対応中のチャット数を集計
2. 最終メッセージからの経過時間で優先度を判定
3. 長時間未対応のチャットへの対応アクションを提案
結果をレポートしてください。`,
  },
]

function ChatsPage() {
  const [chats, setChats] = useState<Chat[]>([])
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [selectedTagId, setSelectedTagId] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
  const [chatDetail, setChatDetail] = useState<ChatDetail | null>(null)
  const [infoPanelOpen, setInfoPanelOpen] = useState(false)
  const [linkClicks, setLinkClicks] = useState<Map<string, string>>(new Map())
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [messageContent, setMessageContent] = useState('')
  const [sending, setSending] = useState(false)
  const [attachment, setAttachment] = useState<{ kind: 'image' | 'file'; url: string; name: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [notes, setNotes] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const { selectedAccount } = useAccount()
  const searchParams = useSearchParams()
  const router = useRouter()

  const loadChats = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params: Record<string, string> = {}
      if (statusFilter !== 'all') params.status = statusFilter
      if (selectedAccount) params.lineAccountId = selectedAccount.id
      if (selectedTagId) params.tagId = selectedTagId
      if (searchQuery) params.q = searchQuery
      const res = await api.chats.list(params)
      if (res.success) {
        setChats(res.data as unknown as Chat[])
      } else {
        setError(res.error)
      }
    } catch {
      setError('チャットの読み込みに失敗しました。もう一度お試しください。')
    } finally {
      setLoading(false)
    }
  }, [statusFilter, selectedAccount, selectedTagId, searchQuery])

  const loadChatDetail = useCallback(async (chatId: string) => {
    setDetailLoading(true)
    try {
      const res = await api.chats.get(chatId)
      if (res.success) {
        const detail = res.data as unknown as ChatDetail
        setChatDetail(detail)
        setNotes(detail.notes || '')
        // 友達のリンククリック履歴を取得
        try {
          const clicksRes = await api.friends.linkClicks(detail.friendId)
          if (clicksRes.success) {
            const map = new Map<string, string>()
            for (const c of clicksRes.data) {
              if (!map.has(c.trackedLinkId)) map.set(c.trackedLinkId, c.clickedAt)
            }
            setLinkClicks(map)
          }
        } catch { /* ignore */ }
      }
    } catch {
      setError('チャット詳細の読み込みに失敗しました。')
    } finally {
      setDetailLoading(false)
    }
  }, [])

  // タグ一覧（絞り込み用）。アカウント切替で再取得し、選択中タグはリセット。
  useEffect(() => {
    setSelectedTagId('')
    const params = selectedAccount ? { lineAccountId: selectedAccount.id } : undefined
    api.tags.list(params).then((res) => { if (res.success) setAllTags(res.data) }).catch(() => {})
  }, [selectedAccount])

  // 名前検索のデバウンス（入力停止から300ms後に確定）
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput.trim()), 300)
    return () => clearTimeout(t)
  }, [searchInput])

  useEffect(() => {
    setSelectedChatId(null)
  }, [selectedAccount])

  useEffect(() => {
    loadChats()
  }, [loadChats])

  // 友だち管理画面から ?friendId=xxx で遷移してきた場合、該当チャットを開く
  useEffect(() => {
    const friendId = searchParams.get('friendId')
    if (!friendId) return
    api.chats.byFriend(friendId)
      .then((res) => { if (res.success) setSelectedChatId(res.data.id) })
      .catch(() => {})
      .finally(() => { router.replace('/chats') })
  }, [searchParams, router])

  // Auto-scroll to bottom when chat is opened or new messages arrive
  useEffect(() => {
    if (chatDetail?.messages?.length) {
      // requestAnimationFrame ensures DOM is painted before scrolling
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ block: 'end' })
      })
    }
  }, [chatDetail?.id, chatDetail?.messages?.length])

  useEffect(() => {
    if (selectedChatId) {
      loadChatDetail(selectedChatId)
    } else {
      setChatDetail(null)
    }
  }, [selectedChatId, loadChatDetail])

  const handleSelectChat = (chatId: string) => {
    setSelectedChatId(chatId)
    setMessageContent('')
  }

  const handleSendMessage = async () => {
    if (!selectedChatId) return
    const text = messageContent.trim()
    if (!text && !attachment) return
    setSending(true)
    try {
      // 添付ファイルがあれば先に送る（テキスト→添付の順だと、画像下にコメントが見える形）
      if (text) {
        await api.chats.send(selectedChatId, { content: text })
      }
      if (attachment) {
        if (attachment.kind === 'image') {
          await api.chats.send(selectedChatId, { content: attachment.url, messageType: 'image' })
        } else {
          // PDF等は LINE がプッシュ非対応のため、リンクをテキストで送る
          await api.chats.send(selectedChatId, { content: `📎 ${attachment.name}\n${attachment.url}` })
        }
      }
      setMessageContent('')
      setAttachment(null)
      const ta = document.querySelector<HTMLTextAreaElement>('textarea[placeholder^="メッセージを入力"]')
      if (ta) ta.style.height = 'auto'
      loadChatDetail(selectedChatId)
      loadChats()
    } catch {
      setError('メッセージの送信に失敗しました。')
    } finally {
      setSending(false)
    }
  }

  const handlePickFile = () => {
    fileInputRef.current?.click()
  }

  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 同じファイル再選択も拾えるように
    if (!file) return
    setUploading(true)
    try {
      const isImage = file.type.startsWith('image/')
      if (isImage) {
        const res = await api.uploads.image(file)
        if (res.success) {
          setAttachment({ kind: 'image', url: res.data.url, name: file.name })
        } else {
          setError(res.error || '画像のアップロードに失敗しました。')
        }
      } else {
        const res = await api.uploads.file(file, selectedAccount?.id ?? null)
        if (res.success) {
          setAttachment({ kind: 'file', url: res.data.url, name: file.name })
        } else {
          setError(res.error || 'ファイルのアップロードに失敗しました。')
        }
      }
    } catch {
      setError('アップロードに失敗しました。')
    } finally {
      setUploading(false)
    }
  }

  const handleStatusUpdate = async (newStatus: Chat['status']) => {
    if (!selectedChatId) return
    try {
      await api.chats.update(selectedChatId, { status: newStatus })
      loadChatDetail(selectedChatId)
      loadChats()
    } catch {
      setError('ステータスの更新に失敗しました。')
    }
  }

  const handleSaveNotes = async () => {
    if (!selectedChatId) return
    setSavingNotes(true)
    try {
      await api.chats.update(selectedChatId, { notes })
      loadChatDetail(selectedChatId)
    } catch {
      setError('メモの保存に失敗しました。')
    } finally {
      setSavingNotes(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl + Enter で送信、Enter単体や Shift+Enter は通常通り改行
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  return (
    <div>
      <Header title="オペレーターチャット" />

      {/* Error */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="flex gap-4 h-[calc(100vh-120px)] lg:h-[calc(100vh-180px)]">
        {/* Left Panel: Chat List */}
        <div className={`w-full lg:w-96 lg:flex-shrink-0 bg-white rounded-lg shadow-sm border border-gray-200 flex-col overflow-hidden ${selectedChatId ? 'hidden lg:flex' : 'flex'}`}>
          {/* Search + Tag filter */}
          <div className="p-2.5 border-b border-gray-200 space-y-2">
            <div className="relative">
              <svg className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 18a7 7 0 100-14 7 7 0 000 14z" />
              </svg>
              <input
                type="text"
                value={searchInput}
                onChange={(e) => { setSearchInput(e.target.value); setSelectedChatId(null) }}
                placeholder="名前で検索..."
                className="w-full text-sm border border-gray-300 rounded-lg pl-8 pr-8 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
              />
              {searchInput && (
                <button
                  onClick={() => { setSearchInput(''); setSelectedChatId(null) }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  aria-label="検索をクリア"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
            <select
              value={selectedTagId}
              onChange={(e) => { setSelectedTagId(e.target.value); setSelectedChatId(null) }}
              className="w-full text-sm border border-gray-300 rounded-lg px-2.5 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="">すべてのタグ</option>
              {allTags.map((tag) => (
                <option key={tag.id} value={tag.id}>{withGroup(tag.name, tag.groupName)}</option>
              ))}
            </select>
          </div>

          {/* Status Filter Tabs */}
          <div className="flex border-b border-gray-200">
            {statusFilters.map((filter) => (
              <button
                key={filter.key}
                onClick={() => { setStatusFilter(filter.key); setSelectedChatId(null) }}
                className={`flex-1 px-3 py-2.5 min-h-[44px] text-xs font-medium transition-colors ${
                  statusFilter === filter.key
                    ? 'text-white'
                    : 'text-gray-600 hover:bg-gray-50'
                }`}
                style={statusFilter === filter.key ? { backgroundColor: '#06C755' } : undefined}
              >
                {filter.label}
              </button>
            ))}
          </div>

          {/* Chat List */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div>
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="px-4 py-3 border-b border-gray-100 animate-pulse">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 space-y-2">
                        <div className="h-3 bg-gray-200 rounded w-32" />
                        <div className="h-2 bg-gray-100 rounded w-20" />
                      </div>
                      <div className="h-5 bg-gray-100 rounded-full w-12" />
                    </div>
                  </div>
                ))}
              </div>
            ) : chats.length === 0 ? (
              <div className="p-8 text-center">
                <p className="text-gray-500 text-sm">チャットがありません。</p>
              </div>
            ) : (
              chats.map((chat) => {
                const statusInfo = statusConfig[chat.status]
                const isSelected = selectedChatId === chat.id

                return (
                  <button
                    key={chat.id}
                    onClick={() => handleSelectChat(chat.id)}
                    className={`w-full text-left px-4 py-3 border-b border-gray-100 transition-colors ${
                      isSelected ? 'bg-green-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      {chat.friendPictureUrl ? (
                        <img src={chat.friendPictureUrl} alt="" className="w-10 h-10 rounded-full flex-shrink-0" />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                          <span className="text-gray-500 text-sm">{chat.friendName.charAt(0)}</span>
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {chat.friendName}
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {formatDatetime(chat.lastMessageAt)}
                        </p>
                      </div>
                      <span
                        className={`ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 ${statusInfo.className}`}
                      >
                        {statusInfo.label}
                      </span>
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>

        {/* Right Panel: Chat Detail */}
        <div className={`flex-1 bg-white rounded-lg shadow-sm border border-gray-200 flex-col overflow-hidden ${selectedChatId ? 'flex' : 'hidden lg:flex'}`}>
          {!selectedChatId ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-gray-400 text-sm">チャットを選択してください</p>
            </div>
          ) : detailLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-gray-400 text-sm">読み込み中...</p>
            </div>
          ) : chatDetail ? (
            <>
              {/* Chat Header */}
              <div className="px-4 py-4 border-b border-gray-200 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    onClick={() => setSelectedChatId(null)}
                    className="lg:hidden flex-shrink-0 p-1 -ml-1 text-gray-500 hover:text-gray-700"
                    aria-label="戻る"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  {chatDetail.friendPictureUrl && (
                    <img src={chatDetail.friendPictureUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {chatDetail.friendName}
                    </p>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium mt-1 ${statusConfig[chatDetail.status].className}`}
                    >
                      {statusConfig[chatDetail.status].label}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {chatDetail.status !== 'unread' && (
                    <button
                      onClick={() => handleStatusUpdate('unread')}
                      className="px-3 py-1 min-h-[44px] lg:min-h-0 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                    >
                      未読に戻す
                    </button>
                  )}
                  {chatDetail.status !== 'in_progress' && (
                    <button
                      onClick={() => handleStatusUpdate('in_progress')}
                      className="px-3 py-1 min-h-[44px] lg:min-h-0 text-xs font-medium text-yellow-700 bg-yellow-50 hover:bg-yellow-100 rounded-md transition-colors"
                    >
                      対応中にする
                    </button>
                  )}
                  {chatDetail.status !== 'resolved' && (
                    <button
                      onClick={() => handleStatusUpdate('resolved')}
                      className="px-3 py-1 min-h-[44px] lg:min-h-0 text-xs font-medium text-green-700 bg-green-50 hover:bg-green-100 rounded-md transition-colors"
                    >
                      解決済にする
                    </button>
                  )}
                  <button
                    onClick={() => setInfoPanelOpen(!infoPanelOpen)}
                    className="px-3 py-1 min-h-[44px] lg:min-h-0 text-xs font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors flex items-center gap-1"
                  >
                    <span>お客様情報</span>
                    <svg className={`w-3 h-3 transition-transform ${infoPanelOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* お客様情報パネル（折りたたみ） */}
              {infoPanelOpen && (
                <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
                  <FriendInfoPanel friendId={chatDetail.friendId} compact />
                </div>
              )}

              {/* Messages — LINE-style chat bubbles */}
              <div className="flex-1 overflow-y-auto p-4 space-y-2" style={{ backgroundColor: '#7494C0' }}>
                {(!chatDetail.messages || chatDetail.messages.length === 0) ? (
                  <div className="text-center py-8">
                    <p className="text-white/60 text-sm">メッセージはまだありません。</p>
                  </div>
                ) : (
                  (chatDetail.messages ?? []).map((msg) => {
                    const isOutgoing = msg.direction === 'outgoing'

                    // 送信メッセージ内のトラッキングリンクを抽出
                    const trackingLinkIds = isOutgoing
                      ? Array.from(msg.content.matchAll(/\/t\/([a-zA-Z0-9-]+)(?:\?[^\s]*)?/g)).map(m => m[1])
                      : []

                    // メッセージ表示の分岐
                    let bubbleContent: React.ReactNode
                    if (msg.messageType === 'flex') {
                      // Flexメッセージ — JSONをフォーマットして表示
                      let formatted = msg.content
                      try {
                        formatted = JSON.stringify(JSON.parse(msg.content), null, 2)
                      } catch { /* use raw */ }
                      bubbleContent = (
                        <div className="max-w-[300px]">
                          <div className="text-xs font-medium mb-1 opacity-70">📋 Flex Message</div>
                          <pre className="text-xs overflow-x-auto whitespace-pre-wrap bg-black/10 rounded p-2 max-h-[200px] overflow-y-auto" style={{ fontSize: '10px' }}>
                            {formatted}
                          </pre>
                        </div>
                      )
                    } else if (msg.messageType === 'image') {
                      try {
                        const parsed = JSON.parse(msg.content)
                        bubbleContent = (
                          <img src={parsed.originalContentUrl || parsed.previewImageUrl} alt="" className="max-w-[200px] rounded" />
                        )
                      } catch {
                        bubbleContent = <span>🖼️ [画像]</span>
                      }
                    } else {
                      bubbleContent = <span>{msg.content}</span>
                    }

                    return (
                      <div
                        key={msg.id}
                        className={`flex items-end gap-2 ${isOutgoing ? 'justify-end' : 'justify-start'}`}
                      >
                        {/* 相手のアイコン（incoming のみ） */}
                        {!isOutgoing && (
                          chatDetail.friendPictureUrl ? (
                            <img src={chatDetail.friendPictureUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0 mb-1" />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-gray-300 flex-shrink-0 mb-1" />
                          )
                        )}

                        <div className={`flex flex-col ${isOutgoing ? 'items-end' : 'items-start'}`}>
                          {/* メッセージバブル */}
                          <div
                            className={`max-w-[320px] px-3 py-2 text-sm break-words whitespace-pre-wrap ${
                              isOutgoing
                                ? 'rounded-tl-2xl rounded-tr-md rounded-bl-2xl rounded-br-2xl text-white'
                                : 'rounded-tl-md rounded-tr-2xl rounded-bl-2xl rounded-br-2xl bg-white text-gray-900'
                            }`}
                            style={isOutgoing ? { backgroundColor: '#06C755' } : undefined}
                          >
                            {bubbleContent}
                          </div>
                          {/* リンククリック状況 */}
                          {trackingLinkIds.length > 0 && (
                            <div className="flex flex-col gap-0.5 mt-1">
                              {trackingLinkIds.map((lid) => {
                                const clickedAt = linkClicks.get(lid)
                                return clickedAt ? (
                                  <span key={lid} className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                                    🔗 クリック済 {new Date(clickedAt).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                  </span>
                                ) : (
                                  <span key={lid} className="text-xs px-2 py-0.5 rounded-full bg-white/20 text-white/70">
                                    🔗 未クリック
                                  </span>
                                )
                              })}
                            </div>
                          )}
                          {/* 時刻 */}
                          <span className="text-xs text-white/50 mt-0.5 px-1">
                            {new Date(msg.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      </div>
                    )
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Notes */}
              <div className="px-4 py-2 border-t border-gray-200 bg-gray-50">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="メモを入力..."
                    className="flex-1 text-xs border border-gray-300 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-green-500"
                  />
                  <button
                    onClick={handleSaveNotes}
                    disabled={savingNotes}
                    className="px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors disabled:opacity-50"
                  >
                    {savingNotes ? '保存中...' : 'メモ保存'}
                  </button>
                </div>
              </div>

              {/* Send Message Form */}
              <div className="px-4 py-3 border-t border-gray-200">
                {attachment && (
                  <div className="mb-2 flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-xs">
                    {attachment.kind === 'image' ? (
                      <img src={attachment.url} alt={attachment.name} className="w-10 h-10 object-cover rounded border border-gray-200" />
                    ) : (
                      <span className="w-10 h-10 flex items-center justify-center bg-white border border-gray-200 rounded text-base">📎</span>
                    )}
                    <span className="flex-1 truncate text-gray-700">{attachment.name}</span>
                    <button onClick={() => setAttachment(null)} className="text-gray-400 hover:text-gray-700">✕</button>
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
                    onChange={handleFileChosen}
                    className="hidden"
                  />
                  <button
                    onClick={handlePickFile}
                    disabled={uploading || sending}
                    title="ファイル添付（画像・PDF）"
                    className="px-3 py-2 text-base border border-gray-300 rounded-lg bg-white hover:bg-gray-50 disabled:opacity-50 shrink-0"
                  >
                    {uploading ? '…' : '📎'}
                  </button>
                  <textarea
                    value={messageContent}
                    onChange={(e) => {
                      setMessageContent(e.target.value)
                      // 自動で高さを内容に合わせて拡張（最大240px）
                      const el = e.target
                      el.style.height = 'auto'
                      el.style.height = Math.min(el.scrollHeight, 240) + 'px'
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder="メッセージを入力...（送信は Cmd/Ctrl + Enter）"
                    rows={1}
                    className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-green-500 resize-none overflow-y-auto leading-relaxed"
                    style={{ minHeight: '40px', maxHeight: '240px' }}
                  />
                  <button
                    onClick={handleSendMessage}
                    disabled={sending || uploading || (!messageContent.trim() && !attachment)}
                    className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                    style={{ backgroundColor: '#06C755' }}
                  >
                    {sending ? '送信中...' : '送信'}
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
      <CcPromptButton prompts={ccPrompts} />
    </div>
  )
}

export default function ChatsPageWrapper() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-sm text-gray-400">読み込み中...</div>}>
      <ChatsPage />
    </Suspense>
  )
}

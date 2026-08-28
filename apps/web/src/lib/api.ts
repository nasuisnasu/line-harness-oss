import type {
  Friend,
  Tag,
  Scenario,
  ScenarioStep,
  ApiResponse,
  PaginatedResponse,
  User,
  LineAccount,
  ConversionPoint,
  Affiliate,
  Template,
  Automation,
  AutomationLog,
  Chat,
  Reminder,
  ReminderStep,
  ScoringRule,
  IncomingWebhook,
  OutgoingWebhook,
  NotificationRule,
  Notification,
  AccountHealthLog,
  AccountMigration,
} from '@line-crm/shared'

import type { Broadcast } from '@line-crm/shared'

/** Broadcast type from API (now camelCase after worker serialization) */
export type ApiBroadcast = Broadcast

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787'

/**
 * Read the API key from localStorage first (set during login), falling back to
 * the build-time env var for local development without the login page.
 */
function getApiKey(): string {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('lh_api_key')
    if (stored) return stored
  }
  return process.env.NEXT_PUBLIC_API_KEY || ''
}

export async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getApiKey()}`,
      ...options?.headers,
    },
  })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json() as Promise<T>
}

export type FriendListParams = {
  offset?: string
  limit?: string
  tagId?: string
  lineAccountId?: string
  search?: string
}

export type FriendWithTags = Friend & { tags: Tag[]; activeScenarios: { id: string; name: string }[] }

export const api = {
  friends: {
    list: (params?: FriendListParams) =>
      fetchApi<ApiResponse<PaginatedResponse<FriendWithTags>>>(
        '/api/friends?' + new URLSearchParams(params as Record<string, string>)
      ),
    get: (id: string) =>
      fetchApi<ApiResponse<FriendWithTags>>(`/api/friends/${id}`),
    count: (params?: { lineAccountId?: string }) =>
      fetchApi<ApiResponse<{ count: number }>>(
        '/api/friends/count' + (params ? '?' + new URLSearchParams(params as Record<string, string>) : '')
      ),
    dailyStats: (params?: { lineAccountId?: string; days?: number; eventId?: string }) =>
      fetchApi<ApiResponse<{ date: string; added: number; blocked: number; cumulative: number; bookings: number; paymentSum: number }[]>>(
        '/api/friends/daily-stats' + (params ? '?' + new URLSearchParams(
          Object.fromEntries(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
        ) : '')
      ),
    lifetimeSummary: (params?: { lineAccountId?: string; eventId?: string }) =>
      fetchApi<ApiResponse<{ friendsAdded: number; bookings: number; paymentSum: number }>>(
        '/api/friends/lifetime-summary' + (params ? '?' + new URLSearchParams(
          Object.fromEntries(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
        ) : '')
      ),
    addTag: (friendId: string, tagId: string) =>
      fetchApi<ApiResponse<null>>(`/api/friends/${friendId}/tags`, {
        method: 'POST',
        body: JSON.stringify({ tagId }),
      }),
    removeTag: (friendId: string, tagId: string) =>
      fetchApi<ApiResponse<null>>(`/api/friends/${friendId}/tags/${tagId}`, {
        method: 'DELETE',
      }),
    scenarios: (friendId: string) =>
      fetchApi<ApiResponse<{
        id: string; scenarioId: string; scenarioName: string;
        status: string; currentStepOrder: number; startedAt: string; nextDeliveryAt: string | null;
        steps: { stepOrder: number; messageType: string; messageContent: string; delayMinutes: number; sent: boolean }[];
      }[]>>(`/api/friends/${friendId}/scenarios`),
    block: (friendId: string, isBlocked: boolean) =>
      fetchApi<ApiResponse<null>>(`/api/friends/${friendId}/block`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isBlocked }),
      }),
    linkClicks: (friendId: string) =>
      fetchApi<ApiResponse<{ trackedLinkId: string; clickedAt: string; linkName: string | null }[]>>(
        `/api/friends/${friendId}/link-clicks`,
      ),
    bookings: (friendId: string) =>
      fetchApi<ApiResponse<{
        id: string; title: string; startAt: string; endAt: string;
        status: string; appEventId: string | null; eventName: string | null;
      }[]>>(`/api/friends/${friendId}/bookings`),
    family: (friendId: string) =>
      fetchApi<ApiResponse<{
        role: string;
        myName: string;
        studentName: string;
        parents: { id: string; displayName: string | null; parentName: string }[];
        children: { id: string; displayName: string | null; studentName: string }[];
      }>>(`/api/friends/${friendId}/family`),
    payments: {
      list: (friendId: string) =>
        fetchApi<ApiResponse<{
          payments: { id: string; amount: number; note: string | null; paidAt: string; createdAt: string }[];
          total: number;
        }>>(`/api/friends/${friendId}/payments`),
      add: (friendId: string, data: { amount: number; note?: string; paidAt: string }) =>
        fetchApi<ApiResponse<{ id: string }>>(`/api/friends/${friendId}/payments`, {
          method: 'POST',
          body: JSON.stringify(data),
        }),
      update: (friendId: string, paymentId: string, data: { amount?: number; note?: string | null; paidAt?: string }) =>
        fetchApi<ApiResponse<null>>(`/api/friends/${friendId}/payments/${paymentId}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        }),
      delete: (friendId: string, paymentId: string) =>
        fetchApi<ApiResponse<null>>(`/api/friends/${friendId}/payments/${paymentId}`, {
          method: 'DELETE',
        }),
    },
    lessons: {
      list: (friendId: string) =>
        fetchApi<ApiResponse<{
          records: { id: string; type: 'contract' | 'lesson' | 'cancel'; count: number; recordDate: string; note: string | null; createdAt: string }[];
          summary: { contracted: number; conducted: number; cancelled: number; consumed: number; remaining: number };
        }>>(`/api/friends/${friendId}/lessons`),
      add: (friendId: string, data: { type: 'contract' | 'lesson' | 'cancel'; count?: number; recordDate?: string; note?: string }) =>
        fetchApi<ApiResponse<{ id: string }>>(`/api/friends/${friendId}/lessons`, {
          method: 'POST',
          body: JSON.stringify(data),
        }),
      delete: (friendId: string, recordId: string) =>
        fetchApi<ApiResponse<null>>(`/api/friends/${friendId}/lessons/${recordId}`, {
          method: 'DELETE',
        }),
    },
  },
  tags: {
    /** Always pass `{ lineAccountId: selectedAccount.id }` from `useAccount()`.
     *  Omitting it returns tags across every LINE OA and operators end up
     *  picking another account's tag from a UI selector. */
    list: (params?: { lineAccountId?: string }) =>
      fetchApi<ApiResponse<Tag[]>>(
        '/api/tags' + (params?.lineAccountId ? '?lineAccountId=' + params.lineAccountId : '')
      ),
    create: (data: { name: string; color: string; groupName?: string | null }, params?: { lineAccountId?: string }) =>
      fetchApi<ApiResponse<Tag>>(
        '/api/tags' + (params?.lineAccountId ? '?lineAccountId=' + params.lineAccountId : ''),
        { method: 'POST', body: JSON.stringify(data) }
      ),
    update: (id: string, data: { name?: string; color?: string; groupName?: string | null }) =>
      fetchApi<ApiResponse<Tag>>(`/api/tags/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/tags/${id}`, { method: 'DELETE' }),
    renameGroup: (from: string, to: string | null) =>
      fetchApi<ApiResponse<{ changes: number }>>(`/api/tags/groups/rename`, {
        method: 'POST',
        body: JSON.stringify({ from, to }),
      }),
    reorder: (orderedIds: string[]) =>
      fetchApi<ApiResponse<null>>(`/api/tags/reorder`, {
        method: 'POST',
        body: JSON.stringify({ orderedIds }),
      }),
  },
  /**
   * 単語テスト（受講生専用）。
   * 一覧は必ず `{ lineAccountId: selectedAccount.id }` を渡すこと。
   * 渡さないと複数OAの生徒が混ざる。
   */
  vocab: {
    students: (params: {
      lineAccountId?: string
      tagId?: string
      bookId?: number
      subject?: string
    }) => {
      const q = new URLSearchParams()
      if (params.lineAccountId) q.set('lineAccountId', params.lineAccountId)
      if (params.tagId) q.set('tagId', params.tagId)
      // 単語帳を絞る（古文単語テストの画面）。渡さないと生徒が選んでいる単語帳になる
      if (params.bookId) q.set('book_id', String(params.bookId))
      // 教科。渡さないと英単語の一覧に古文の実施回数が混ざる
      if (params.subject) q.set('subject', params.subject)
      return fetchApi<{ success: boolean; students: VocabStudentRow[] }>(
        '/api/vocab/admin/students?' + q.toString()
      )
    },
    student: (friendId: string, bookId?: number, subject?: string) => {
      const q = new URLSearchParams()
      if (bookId) q.set('book_id', String(bookId))
      if (subject) q.set('subject', subject)
      return fetchApi<{ success: boolean } & VocabStudentDetail>(
        '/api/vocab/admin/students/' + friendId + (q.toString() ? '?' + q.toString() : '')
      )
    },
    sessionAnswers: (sessionId: number) =>
      fetchApi<{ success: boolean; answers: VocabAnswerRow[] }>(
        '/api/vocab/admin/sessions/' + sessionId + '/answers'
      ),
    books: (lineAccountId?: string) =>
      fetchApi<{
        success: boolean
        books: { id: number; name: string; count: number; subject: string }[]
      }>(
        '/api/vocab/admin/books' + (lineAccountId ? '?lineAccountId=' + lineAccountId : '')
      ),
  },
  /**
   * 文法テスト（受講生専用）。単語テストと同じく、一覧には必ず
   * `{ lineAccountId: selectedAccount.id }` を渡すこと。渡さないと複数OAの生徒が混ざる。
   */
  /**
   * 並び替えテスト（Build a Sentence）。
   * 生徒にセットを選ばせないので、問題集ではなく**プール全体**を見る。
   * つまずきは分野ではなく型（A1〜G4）で出す。
   */
  bas: {
    students: (params: { lineAccountId?: string; tagId?: string }) => {
      const q = new URLSearchParams()
      if (params.lineAccountId) q.set('lineAccountId', params.lineAccountId)
      if (params.tagId) q.set('tagId', params.tagId)
      return fetchApi<{ success: boolean; students: BasStudentRow[] }>(
        '/api/bas/admin/students?' + q.toString()
      )
    },
    student: (friendId: string, lineAccountId?: string) =>
      fetchApi<{ success: boolean } & BasStudentDetail>(
        '/api/bas/admin/students/' +
          friendId +
          (lineAccountId ? '?lineAccountId=' + lineAccountId : '')
      ),
    types: () => fetchApi<{ success: boolean; types: BasType[] }>('/api/bas/admin/types'),
    sets: (lineAccountId?: string) =>
      fetchApi<{ success: boolean; sets: BasSetSummary[] }>(
        '/api/bas/admin/sets' + (lineAccountId ? '?lineAccountId=' + lineAccountId : '')
      ),
    setActive: (slug: string, active: boolean, lineAccountId?: string) =>
      fetchApi<{ success: boolean; sets: BasSetSummary[] }>(
        '/api/bas/admin/sets/' +
          encodeURIComponent(slug) +
          '/active' +
          (lineAccountId ? '?lineAccountId=' + lineAccountId : ''),
        { method: 'POST', body: JSON.stringify({ active }) }
      ),
  },

  grammar: {
    students: (params: { lineAccountId?: string; tagId?: string; bookIds?: number[] }) => {
      const q = new URLSearchParams()
      if (params.bookIds?.length) q.set('book_ids', params.bookIds.join(','))
      if (params.lineAccountId) q.set('lineAccountId', params.lineAccountId)
      if (params.tagId) q.set('tagId', params.tagId)
      return fetchApi<{ success: boolean; students: GrammarStudentRow[] }>(
        '/api/grammar/admin/students?' + q.toString()
      )
    },
    student: (friendId: string, bookId?: number) =>
      fetchApi<{ success: boolean } & GrammarStudentDetail>(
        '/api/grammar/admin/students/' + friendId + (bookId ? '?book_id=' + bookId : '')
      ),
    sessionAnswers: (sessionId: number) =>
      fetchApi<{ success: boolean; answers: GrammarAnswerRow[] }>(
        '/api/grammar/admin/sessions/' + sessionId + '/answers'
      ),
    books: (lineAccountId?: string) =>
      fetchApi<{ success: boolean; books: GrammarBookSummary[] }>(
        '/api/grammar/admin/books' + (lineAccountId ? '?lineAccountId=' + lineAccountId : '')
      ),
    questions: (bookId: number, params?: { category?: string; limit?: number; offset?: number }) => {
      const q = new URLSearchParams({ book_id: String(bookId) })
      if (params?.category) q.set('category', params.category)
      if (params?.limit) q.set('limit', String(params.limit))
      if (params?.offset) q.set('offset', String(params.offset))
      return fetchApi<{ success: boolean; questions: GrammarQuestionRow[]; total: number }>(
        '/api/grammar/admin/questions?' + q.toString()
      )
    },
    distractors: (bookId: number, friendId?: string) => {
      const q = new URLSearchParams({ book_id: String(bookId) })
      if (friendId) q.set('friendId', friendId)
      return fetchApi<{ success: boolean; distractors: GrammarDistractor[] }>(
        '/api/grammar/admin/distractors?' + q.toString()
      )
    },
    /**
     * 問題集の登録・取り込み。
     *
     * fetchApi は失敗時に本文を読まずに投げるので、ここだけ自前で fetch する。
     * 取り込みは**どの行がなぜ弾かれたか**が分からないと直しようがない。
     */
    importBook: async (input: {
      slug: string
      name: string
      lineAccountId?: string | null
      sort?: number
      tsv?: string
      questions?: GrammarQuestionInput[]
    }): Promise<{
      success: boolean
      imported?: number
      error?: string
      errors?: string[]
      warnings?: string[]
    }> => {
      const res = await fetch(`${API_URL}/api/grammar/admin/books`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getApiKey()}` },
        body: JSON.stringify(input),
      })
      return (await res.json().catch(() => ({ success: false, error: '通信に失敗しました' }))) as {
        success: boolean
        imported?: number
        error?: string
        errors?: string[]
        warnings?: string[]
      }
    },
  },
  businessCalendar: {
    get: (lineAccountId: string) =>
      fetchApi<ApiResponse<BusinessCalendar>>(
        '/api/business-calendar?lineAccountId=' + lineAccountId
      ),
    update: (lineAccountId: string, data: { closedWeekdays?: number[]; closedDates?: string[]; notice?: string | null }) =>
      fetchApi<ApiResponse<BusinessCalendar>>(
        '/api/business-calendar?lineAccountId=' + lineAccountId,
        { method: 'PUT', body: JSON.stringify(data) }
      ),
  },
  scenarios: {
    /** Always pass `{ lineAccountId: selectedAccount.id }` — see tags.list. */
    list: (params?: { lineAccountId?: string }) =>
      fetchApi<ApiResponse<(Scenario & { stepCount?: number })[]>>(
        '/api/scenarios' + (params?.lineAccountId ? '?lineAccountId=' + params.lineAccountId : '')
      ),
    get: (id: string) =>
      fetchApi<ApiResponse<Scenario & { steps: ScenarioStep[] }>>(`/api/scenarios/${id}`),
    create: (data: Omit<Scenario, 'id' | 'createdAt' | 'updatedAt'>) =>
      fetchApi<ApiResponse<Scenario>>('/api/scenarios', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Omit<Scenario, 'id' | 'createdAt' | 'updatedAt'>>) =>
      fetchApi<ApiResponse<Scenario>>(`/api/scenarios/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/scenarios/${id}`, { method: 'DELETE' }),
    addStep: (id: string, data: Omit<ScenarioStep, 'id' | 'scenarioId' | 'createdAt'>) =>
      fetchApi<ApiResponse<ScenarioStep>>(`/api/scenarios/${id}/steps`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    updateStep: (
      id: string,
      stepId: string,
      data: Partial<Omit<ScenarioStep, 'id' | 'scenarioId' | 'createdAt'>>
    ) =>
      fetchApi<ApiResponse<ScenarioStep>>(`/api/scenarios/${id}/steps/${stepId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    deleteStep: (id: string, stepId: string) =>
      fetchApi<ApiResponse<null>>(`/api/scenarios/${id}/steps/${stepId}`, {
        method: 'DELETE',
      }),
    testAll: (id: string) =>
      fetchApi<ApiResponse<{ sentTo: string; sentCount: number }>>(`/api/scenarios/${id}/test`, {
        method: 'POST',
      }),
    testStep: (id: string, stepId: string) =>
      fetchApi<ApiResponse<{ sentTo: string; sentCount: number }>>(`/api/scenarios/${id}/steps/${stepId}/test`, {
        method: 'POST',
      }),
    renameGroup: (from: string, to: string | null) =>
      fetchApi<ApiResponse<{ changes: number }>>(`/api/scenarios/groups/rename`, {
        method: 'POST',
        body: JSON.stringify({ from, to }),
      }),
  },
  broadcasts: {
    list: (params?: { lineAccountId?: string }) =>
      fetchApi<ApiResponse<ApiBroadcast[]>>(
        '/api/broadcasts' + (params?.lineAccountId ? '?lineAccountId=' + params.lineAccountId : '')
      ),
    get: (id: string) =>
      fetchApi<ApiResponse<ApiBroadcast>>(`/api/broadcasts/${id}`),
    audience: (id: string) =>
      fetchApi<ApiResponse<{ count: number; sample: { id: string; displayName: string | null }[] }>>(
        `/api/broadcasts/${id}/audience`,
      ),
    create: (data: {
      title: string
      messageType: ApiBroadcast['messageType']
      messageContent: string
      messages?: { type: string; content: string }[]
      targetType: ApiBroadcast['targetType']
      targetTagId?: string | null
      targetTagMode?: ApiBroadcast['targetTagMode']
      targetTagFilter?: { include: string[]; exclude: string[] } | null
      scheduledAt?: string | null
      status?: ApiBroadcast['status']
      groupName?: string | null
    }, params?: { lineAccountId?: string }) =>
      fetchApi<ApiResponse<ApiBroadcast>>(
        '/api/broadcasts' + (params?.lineAccountId ? '?lineAccountId=' + params.lineAccountId : ''),
        {
          method: 'POST',
          body: JSON.stringify(data),
        }
      ),
    update: (
      id: string,
      data: {
        title?: string
        messageType?: ApiBroadcast['messageType']
        messageContent?: string
        messages?: { type: string; content: string }[]
        targetType?: ApiBroadcast['targetType']
        targetTagId?: string | null
        targetTagMode?: ApiBroadcast['targetTagMode']
        targetTagFilter?: { include: string[]; exclude: string[] } | null
        scheduledAt?: string | null
        groupName?: string | null
      }
    ) =>
      fetchApi<ApiResponse<ApiBroadcast>>(`/api/broadcasts/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/broadcasts/${id}`, { method: 'DELETE' }),
    send: (id: string) =>
      fetchApi<ApiResponse<ApiBroadcast>>(`/api/broadcasts/${id}/send`, { method: 'POST' }),
    test: (data: {
      lineAccountId: string
      messageType?: ApiBroadcast['messageType']
      messageContent?: string
      messages?: { type: string; content: string }[]
    }) =>
      fetchApi<ApiResponse<{ sentTo: string }>>('/api/broadcasts/test', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },

  // ── Round 2 APIs ─────────────────────────────────────────────────────────
  users: {
    list: () =>
      fetchApi<ApiResponse<User[]>>('/api/users'),
    get: (id: string) =>
      fetchApi<ApiResponse<User>>(`/api/users/${id}`),
    create: (data: { email?: string | null; phone?: string | null; externalId?: string | null; displayName?: string | null }) =>
      fetchApi<ApiResponse<User>>('/api/users', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Pick<User, 'email' | 'phone' | 'externalId' | 'displayName'>>) =>
      fetchApi<ApiResponse<User>>(`/api/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/users/${id}`, { method: 'DELETE' }),
    link: (userId: string, friendId: string) =>
      fetchApi<ApiResponse<null>>(`/api/users/${userId}/link`, {
        method: 'POST',
        body: JSON.stringify({ friendId }),
      }),
    accounts: (userId: string) =>
      fetchApi<ApiResponse<{ id: string; lineUserId: string; displayName: string | null; isFollowing: boolean }[]>>(
        `/api/users/${userId}/accounts`,
      ),
  },
  lineAccounts: {
    list: () =>
      fetchApi<ApiResponse<LineAccount[]>>('/api/line-accounts'),
    get: (id: string) =>
      fetchApi<ApiResponse<LineAccount>>(`/api/line-accounts/${id}`),
    create: (data: { channelId: string; name: string; channelAccessToken: string; channelSecret: string }) =>
      fetchApi<ApiResponse<LineAccount>>('/api/line-accounts', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    syncProfile: (id: string) =>
      fetchApi<ApiResponse<LineAccount>>(`/api/line-accounts/${id}/sync-profile`, {
        method: 'POST',
      }),
    update: (id: string, data: Partial<Pick<LineAccount, 'name' | 'channelAccessToken' | 'channelSecret' | 'isActive' | 'liffId'>>) =>
      fetchApi<ApiResponse<LineAccount>>(`/api/line-accounts/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/line-accounts/${id}`, { method: 'DELETE' }),
  },
  conversions: {
    points: () =>
      fetchApi<ApiResponse<ConversionPoint[]>>('/api/conversions/points'),
    createPoint: (data: { name: string; eventType: string; value?: number | null }) =>
      fetchApi<ApiResponse<ConversionPoint>>('/api/conversions/points', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    deletePoint: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/conversions/points/${id}`, { method: 'DELETE' }),
    track: (data: { conversionPointId: string; friendId: string; userId?: string | null; affiliateCode?: string | null; metadata?: Record<string, unknown> | null }) =>
      fetchApi<ApiResponse<unknown>>('/api/conversions/track', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    report: (params?: { startDate?: string; endDate?: string }) =>
      fetchApi<ApiResponse<{ conversionPointId: string; conversionPointName: string; eventType: string; totalCount: number; totalValue: number }[]>>(
        '/api/conversions/report?' + new URLSearchParams(params as Record<string, string>),
      ),
  },
  affiliates: {
    list: () =>
      fetchApi<ApiResponse<Affiliate[]>>('/api/affiliates'),
    get: (id: string) =>
      fetchApi<ApiResponse<Affiliate>>(`/api/affiliates/${id}`),
    create: (data: { name: string; code: string; commissionRate?: number }) =>
      fetchApi<ApiResponse<Affiliate>>('/api/affiliates', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Pick<Affiliate, 'name' | 'commissionRate' | 'isActive'>>) =>
      fetchApi<ApiResponse<Affiliate>>(`/api/affiliates/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/affiliates/${id}`, { method: 'DELETE' }),
    report: (id: string, params?: { startDate?: string; endDate?: string }) =>
      fetchApi<ApiResponse<{ affiliateId: string; affiliateName: string; code: string; commissionRate: number; totalClicks: number; totalConversions: number; totalRevenue: number }>>(
        `/api/affiliates/${id}/report?` + new URLSearchParams(params as Record<string, string>),
      ),
  },
  templates: {
    list: (category?: string, params?: { lineAccountId?: string }) =>
      fetchApi<ApiResponse<{ id: string; name: string; category: string; messageType: string; messageContent: string; createdAt: string; updatedAt: string }[]>>(
        '/api/templates?' + new URLSearchParams({ ...(category ? { category } : {}), ...(params as Record<string, string> || {}) }),
      ),
    get: (id: string) =>
      fetchApi<ApiResponse<{ id: string; name: string; category: string; messageType: string; messageContent: string; createdAt: string; updatedAt: string }>>(
        `/api/templates/${id}`,
      ),
    create: (data: { name: string; category: string; messageType: string; messageContent: string }, params?: { lineAccountId?: string }) =>
      fetchApi<ApiResponse<{ id: string; name: string; category: string; messageType: string; messageContent: string; createdAt: string; updatedAt: string }>>(
        '/api/templates?' + new URLSearchParams(params as Record<string, string> || {}),
        { method: 'POST', body: JSON.stringify(data) },
      ),
    update: (id: string, data: Partial<{ name: string; category: string; messageType: string; messageContent: string }>) =>
      fetchApi<ApiResponse<{ id: string; name: string; category: string; messageType: string; messageContent: string; createdAt: string; updatedAt: string }>>(
        `/api/templates/${id}`,
        { method: 'PUT', body: JSON.stringify(data) },
      ),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/templates/${id}`, { method: 'DELETE' }),
    testSend: (id: string, lineAccountId: string) =>
      fetchApi<ApiResponse<{ sentTo: string }>>(`/api/templates/${id}/test-send`, {
        method: 'POST',
        body: JSON.stringify({ lineAccountId }),
      }),
  },
  events: {
    list: (params?: { lineAccountId?: string }) =>
      fetchApi<ApiResponse<EventItem[]>>(
        '/api/events' + (params?.lineAccountId ? '?lineAccountId=' + params.lineAccountId : ''),
      ),
    get: (id: string) =>
      fetchApi<ApiResponse<EventItem & { consultationConfig: ConsultationConfig | null }>>(`/api/events/${id}`),
    create: (
      data: {
        name: string
        description?: string | null
        eventType: 'consultation' | 'seminar'
        slug: string
        isActive?: boolean
      },
      params?: { lineAccountId?: string },
    ) =>
      fetchApi<ApiResponse<EventItem>>(
        '/api/events' + (params?.lineAccountId ? '?lineAccountId=' + params.lineAccountId : ''),
        { method: 'POST', body: JSON.stringify(data) },
      ),
    update: (
      id: string,
      data: Partial<{
        name: string
        description: string | null
        slug: string
        isActive: boolean
        recruitmentPaused: boolean
        funnelRole: 'top' | 'mid' | null
        eventFormat: 'seminar' | 'individual' | null
        consultationConfig: Partial<ConsultationConfig>
      }>,
    ) =>
      fetchApi<ApiResponse<EventItem & { consultationConfig: ConsultationConfig | null }>>(
        `/api/events/${id}`,
        { method: 'PUT', body: JSON.stringify(data) },
      ),
    delete: (id: string) => fetchApi<ApiResponse<null>>(`/api/events/${id}`, { method: 'DELETE' }),
    bookings: (id: string) =>
      fetchApi<ApiResponse<EventBookingItem[]> & { applicationFields?: FormFieldItem[] }>(`/api/events/${id}/bookings`),
    cancelBooking: (bookingId: string) =>
      fetchApi<ApiResponse<{ id: string; status: string }>>(`/api/event-bookings/${bookingId}/cancel`, {
        method: 'POST',
      }),
  },
  kpi: {
    funnelSummary: (params?: { lineAccountId?: string; days?: number; midTagIds?: string }) =>
      fetchApi<ApiResponse<KpiFunnelSummary>>(
        '/api/kpi/funnel-summary' + (params ? '?' + new URLSearchParams(
          Object.fromEntries(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
        ) : ''),
      ),
  },
  googleCalendar: {
    list: () =>
      fetchApi<ApiResponse<{ id: string; calendarId: string; freeBusyCalendarIds: string[]; freeBusyExplicit: boolean; authType: string; isActive: boolean; createdAt: string }[]>>(
        '/api/integrations/google-calendar',
      ),
    availableCalendars: (id: string) =>
      fetchApi<ApiResponse<{ id: string; summary: string; accessRole: string }[]>>(
        `/api/integrations/google-calendar/${id}/available-calendars`,
      ),
    setFreeBusyCalendars: (id: string, calendarIds: string[]) =>
      fetchApi<ApiResponse<{ freeBusyCalendarIds: string[] }>>(
        `/api/integrations/google-calendar/${id}/freebusy-calendars`,
        { method: 'PUT', body: JSON.stringify({ calendarIds }) },
      ),
    connect: (data: { calendarId: string; authType: 'access_token' | 'api_key' | 'service_account'; accessToken?: string; refreshToken?: string; apiKey?: string }) =>
      fetchApi<ApiResponse<{ id: string; calendarId: string; authType: string; isActive: boolean; createdAt: string }>>(
        '/api/integrations/google-calendar/connect',
        { method: 'POST', body: JSON.stringify(data) },
      ),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/integrations/google-calendar/${id}`, { method: 'DELETE' }),
  },
  autoReplies: {
    list: (params?: { lineAccountId?: string }) =>
      fetchApi<ApiResponse<AutoReplyItem[]>>(
        '/api/auto-replies' + (params?.lineAccountId ? '?lineAccountId=' + params.lineAccountId : ''),
      ),
    create: (
      data: {
        keyword: string
        matchType: 'exact' | 'contains'
        responseType: 'text' | 'template' | 'add_tag' | 'enroll_scenario'
        responseContent: string
        isActive?: boolean
      },
      params?: { lineAccountId?: string },
    ) =>
      fetchApi<ApiResponse<AutoReplyItem>>(
        '/api/auto-replies' + (params?.lineAccountId ? '?lineAccountId=' + params.lineAccountId : ''),
        { method: 'POST', body: JSON.stringify(data) },
      ),
    update: (
      id: string,
      data: Partial<{
        keyword: string
        matchType: 'exact' | 'contains'
        responseType: string
        responseContent: string
        isActive: boolean
      }>,
    ) =>
      fetchApi<ApiResponse<AutoReplyItem>>(`/api/auto-replies/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/auto-replies/${id}`, { method: 'DELETE' }),
  },
  actions: {
    list: (params?: { lineAccountId?: string }) =>
      fetchApi<ApiResponse<BulkActionItem[]>>(
        '/api/actions' + (params?.lineAccountId ? '?lineAccountId=' + params.lineAccountId : ''),
      ),
    create: (data: {
      lineAccountId: string
      name: string
      actionType: 'enroll_scenario' | 'add_tag' | 'set_richmenu'
      actionPayload: { scenarioId?: string; tagId?: string; richMenuId?: string }
      targetSpec: { mode: 'all' | 'tag_include' | 'tag_exclude'; tagId?: string | null }
    }) =>
      fetchApi<ApiResponse<{ id: string; totalTargets: number; processed: number; failed: number; status: string }>>(
        '/api/actions',
        { method: 'POST', body: JSON.stringify(data) },
      ),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/actions/${id}`, { method: 'DELETE' }),
  },
  uploads: {
    image: async (file: File) => {
      const fd = new FormData()
      fd.append('image', file)
      // fetchApi sets Content-Type: application/json; for multipart we need
      // raw fetch so the browser attaches its own multipart boundary.
      const res = await fetch(`${API_URL}/api/uploads/image`, {
        method: 'POST',
        headers: { 'X-API-Key': getApiKey() },
        body: fd,
      })
      const json = (await res.json()) as ApiResponse<{ key: string; url: string }>
      return json
    },
    file: async (file: File, lineAccountId?: string | null) => {
      const fd = new FormData()
      fd.append('file', file)
      if (lineAccountId) fd.append('lineAccountId', lineAccountId)
      const res = await fetch(`${API_URL}/api/uploads/file`, {
        method: 'POST',
        headers: { 'X-API-Key': getApiKey() },
        body: fd,
      })
      const json = (await res.json()) as ApiResponse<{ id: string; key: string; url: string }>
      return json
    },
    list: (params?: { lineAccountId?: string }) =>
      fetchApi<ApiResponse<{
        id: string; lineAccountId: string | null; filename: string;
        originalName: string | null; size: number | null;
        contentType: string | null; createdAt: string; url: string;
      }[]>>(
        '/api/uploads/files' + (params?.lineAccountId ? '?lineAccountId=' + params.lineAccountId : ''),
      ),
    deleteFile: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/uploads/files/${id}`, { method: 'DELETE' }),
  },
  automations: {
    list: () =>
      fetchApi<ApiResponse<Automation[]>>('/api/automations'),
    get: (id: string) =>
      fetchApi<ApiResponse<Automation & { logs?: AutomationLog[] }>>(`/api/automations/${id}`),
    create: (data: {
      name: string
      eventType: Automation['eventType']
      actions: Automation['actions']
      description?: string | null
      conditions?: Record<string, unknown>
      priority?: number
    }) =>
      fetchApi<ApiResponse<Automation>>('/api/automations', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Pick<Automation, 'name' | 'description' | 'eventType' | 'conditions' | 'actions' | 'isActive' | 'priority'>>) =>
      fetchApi<ApiResponse<Automation>>(`/api/automations/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/automations/${id}`, { method: 'DELETE' }),
    logs: (id: string, limit?: number) =>
      fetchApi<ApiResponse<AutomationLog[]>>(
        `/api/automations/${id}/logs` + (limit ? `?limit=${limit}` : ''),
      ),
  },
  chats: {
    list: (params?: { status?: string; operatorId?: string; lineAccountId?: string; tagId?: string; q?: string }) =>
      fetchApi<ApiResponse<Chat[]>>(
        '/api/chats?' + new URLSearchParams(params as Record<string, string>),
      ),
    /** 友だちIDからチャットを取得（無ければ作成）。友だち管理→チャットを開く用。 */
    byFriend: (friendId: string) =>
      fetchApi<ApiResponse<{ id: string; friendId: string; status: Chat['status'] }>>(
        `/api/chats/by-friend/${friendId}`,
      ),
    get: (id: string) =>
      fetchApi<ApiResponse<Chat & { messages?: { id: string; content: string; senderType: string; createdAt: string }[] }>>(
        `/api/chats/${id}`,
      ),
    create: (data: { friendId: string; operatorId?: string | null }) =>
      fetchApi<ApiResponse<Chat>>('/api/chats', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { operatorId?: string | null; status?: Chat['status']; notes?: string | null }) =>
      fetchApi<ApiResponse<Chat>>(`/api/chats/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    send: (id: string, data: { content: string; messageType?: string }) =>
      fetchApi<ApiResponse<unknown>>(`/api/chats/${id}/send`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },
  reminders: {
    list: () =>
      fetchApi<ApiResponse<Reminder[]>>('/api/reminders'),
    get: (id: string) =>
      fetchApi<ApiResponse<Reminder & { steps: ReminderStep[] }>>(`/api/reminders/${id}`),
    create: (data: { name: string; description?: string | null }) =>
      fetchApi<ApiResponse<Reminder>>('/api/reminders', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Pick<Reminder, 'name' | 'description' | 'isActive'>>) =>
      fetchApi<ApiResponse<Reminder>>(`/api/reminders/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/reminders/${id}`, { method: 'DELETE' }),
    addStep: (id: string, data: { offsetMinutes: number; messageType: string; messageContent: string }) =>
      fetchApi<ApiResponse<ReminderStep>>(`/api/reminders/${id}/steps`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    deleteStep: (reminderId: string, stepId: string) =>
      fetchApi<ApiResponse<null>>(`/api/reminders/${reminderId}/steps/${stepId}`, {
        method: 'DELETE',
      }),
  },
  scoring: {
    rules: () =>
      fetchApi<ApiResponse<ScoringRule[]>>('/api/scoring-rules'),
    getRule: (id: string) =>
      fetchApi<ApiResponse<ScoringRule>>(`/api/scoring-rules/${id}`),
    createRule: (data: { name: string; eventType: string; scoreValue: number }) =>
      fetchApi<ApiResponse<ScoringRule>>('/api/scoring-rules', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    updateRule: (id: string, data: Partial<Pick<ScoringRule, 'name' | 'eventType' | 'scoreValue' | 'isActive'>>) =>
      fetchApi<ApiResponse<ScoringRule>>(`/api/scoring-rules/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    deleteRule: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/scoring-rules/${id}`, { method: 'DELETE' }),
    friendScore: (friendId: string) =>
      fetchApi<ApiResponse<{ totalScore: number; history: { id: string; scoreChange: number; reason: string | null; createdAt: string }[] }>>(
        `/api/friends/${friendId}/score`,
      ),
  },
  webhooks: {
    incoming: {
      list: () =>
        fetchApi<ApiResponse<IncomingWebhook[]>>('/api/webhooks/incoming'),
      create: (data: { name: string; sourceType?: string; secret?: string | null }) =>
        fetchApi<ApiResponse<IncomingWebhook>>('/api/webhooks/incoming', {
          method: 'POST',
          body: JSON.stringify(data),
        }),
      update: (id: string, data: Partial<Pick<IncomingWebhook, 'name' | 'sourceType' | 'isActive'>>) =>
        fetchApi<ApiResponse<IncomingWebhook>>(`/api/webhooks/incoming/${id}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        }),
      delete: (id: string) =>
        fetchApi<ApiResponse<null>>(`/api/webhooks/incoming/${id}`, { method: 'DELETE' }),
    },
    outgoing: {
      list: () =>
        fetchApi<ApiResponse<OutgoingWebhook[]>>('/api/webhooks/outgoing'),
      create: (data: { name: string; url: string; eventTypes: string[]; secret?: string | null }) =>
        fetchApi<ApiResponse<OutgoingWebhook>>('/api/webhooks/outgoing', {
          method: 'POST',
          body: JSON.stringify(data),
        }),
      update: (id: string, data: Partial<Pick<OutgoingWebhook, 'name' | 'url' | 'eventTypes' | 'isActive'>>) =>
        fetchApi<ApiResponse<OutgoingWebhook>>(`/api/webhooks/outgoing/${id}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        }),
      delete: (id: string) =>
        fetchApi<ApiResponse<null>>(`/api/webhooks/outgoing/${id}`, { method: 'DELETE' }),
    },
  },
  notifications: {
    rules: {
      list: () =>
        fetchApi<ApiResponse<NotificationRule[]>>('/api/notifications/rules'),
      get: (id: string) =>
        fetchApi<ApiResponse<NotificationRule>>(`/api/notifications/rules/${id}`),
      create: (data: { name: string; eventType: string; conditions?: Record<string, unknown>; channels?: string[] }) =>
        fetchApi<ApiResponse<NotificationRule>>('/api/notifications/rules', {
          method: 'POST',
          body: JSON.stringify(data),
        }),
      update: (id: string, data: Partial<Pick<NotificationRule, 'name' | 'eventType' | 'conditions' | 'channels' | 'isActive'>>) =>
        fetchApi<ApiResponse<NotificationRule>>(`/api/notifications/rules/${id}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        }),
      delete: (id: string) =>
        fetchApi<ApiResponse<null>>(`/api/notifications/rules/${id}`, { method: 'DELETE' }),
    },
    list: (params?: { status?: string; limit?: string }) =>
      fetchApi<ApiResponse<Notification[]>>(
        '/api/notifications?' + new URLSearchParams(params as Record<string, string>),
      ),
  },
  entryRoutes: {
    list: (params?: { lineAccountId?: string }) => fetchApi<{ success: boolean; data: { id: string; refCode: string; name: string; tagId: string | null; tagIds: string[]; scenarioId: string | null; lineAccountId: string | null; isActive: boolean; groupName: string | null; createdAt: string; count: number; totalRevenue: number }[] }>('/api/entry-routes' + (params?.lineAccountId ? '?lineAccountId=' + params.lineAccountId : '')),
    create: (data: { refCode?: string; name: string; tagId?: string | null; tagIds?: string[]; scenarioId?: string | null; lineAccountId?: string | null; groupName?: string | null }) =>
      fetchApi<{ success: boolean; data: unknown }>('/api/entry-routes', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { name?: string; tagId?: string | null; tagIds?: string[]; scenarioId?: string | null; groupName?: string | null }) =>
      fetchApi<{ success: boolean; data: unknown }>(`/api/entry-routes/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      fetchApi<{ success: boolean; data: null }>(`/api/entry-routes/${id}`, { method: 'DELETE' }),
    renameGroup: (from: string, to: string | null) =>
      fetchApi<{ success: boolean; data: { changes: number } }>(`/api/entry-routes/groups/rename`, {
        method: 'POST',
        body: JSON.stringify({ from, to }),
      }),
  },
  health: {
    accounts: () =>
      fetchApi<ApiResponse<LineAccount[]>>('/api/line-accounts'),
    getHealth: (accountId: string) =>
      fetchApi<ApiResponse<{ riskLevel: string; logs: AccountHealthLog[] }>>(
        `/api/accounts/${accountId}/health`,
      ),
    migrations: () =>
      fetchApi<ApiResponse<AccountMigration[]>>('/api/accounts/migrations'),
    migrate: (fromAccountId: string, data: { toAccountId: string }) =>
      fetchApi<ApiResponse<AccountMigration>>(`/api/accounts/${fromAccountId}/migrate`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    getMigration: (migrationId: string) =>
      fetchApi<ApiResponse<AccountMigration>>(`/api/accounts/migrations/${migrationId}`),
  },
  richMenus: {
    list: (params?: { lineAccountId?: string }) =>
      fetchApi<ApiResponse<RichMenuItem[]>>(
        '/api/rich-menus' + (params?.lineAccountId ? '?lineAccountId=' + params.lineAccountId : '')
      ),
    get: (id: string) =>
      fetchApi<ApiResponse<RichMenuItem>>(`/api/rich-menus/${id}`),
    create: (data: {
      lineAccountId: string
      name: string
      sizeType: 'full' | 'compact'
      chatBarText: string
      selected?: boolean
      areas: RichMenuAreaItem[]
      isDefault?: boolean
      showOnFriendAdd?: boolean
      autoLinkTagId?: string | null
    }) =>
      fetchApi<ApiResponse<RichMenuItem>>('/api/rich-menus', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: {
      name?: string
      sizeType?: 'full' | 'compact'
      chatBarText?: string
      selected?: boolean
      areas?: RichMenuAreaItem[]
      autoLinkTagId?: string | null
    }) =>
      fetchApi<ApiResponse<RichMenuItem>>(`/api/rich-menus/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/rich-menus/${id}`, { method: 'DELETE' }),
    publish: async (id: string, imageFile: File): Promise<ApiResponse<RichMenuItem>> => {
      const formData = new FormData()
      formData.append('image', imageFile)
      // Use the shared helper so we read the same `lh_api_key` localStorage entry
      // as every other endpoint. This used to read `apiKey` (different name)
      // which produced 401 / "Unauthorized" right after login.
      const res = await fetch(`${API_URL}/api/rich-menus/${id}/publish`, {
        method: 'POST',
        headers: { 'X-API-Key': getApiKey() },
        body: formData,
      })
      return res.json()
    },
    setDefault: (id: string) =>
      fetchApi<ApiResponse<RichMenuItem>>(`/api/rich-menus/${id}/set-default`, { method: 'POST' }),
    setFriendAdd: (id: string) =>
      fetchApi<ApiResponse<RichMenuItem>>(`/api/rich-menus/${id}/set-friend-add`, { method: 'POST' }),
    assignToFriend: (friendId: string, richMenuRecordId: string) =>
      fetchApi<ApiResponse<null>>(`/api/friends/${friendId}/rich-menu`, {
        method: 'POST',
        body: JSON.stringify({ richMenuId: richMenuRecordId }),
      }),
    unlinkFromFriend: (friendId: string) =>
      fetchApi<ApiResponse<null>>(`/api/friends/${friendId}/rich-menu`, { method: 'DELETE' }),
    getFriendCurrent: (friendId: string) =>
      fetchApi<ApiResponse<{ name: string | null; source: 'individual' | 'default' }>>(`/api/friends/${friendId}/rich-menu`),
    imageUrl: (id: string) => {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787'
      const apiKey = (typeof window !== 'undefined' ? localStorage.getItem('apiKey') : null) ?? process.env.NEXT_PUBLIC_API_KEY ?? ''
      return `${apiUrl}/api/rich-menus/${id}/image?apiKey=${encodeURIComponent(apiKey)}`
    },
  },
  forms: {
    list: (params?: { lineAccountId?: string }) =>
      fetchApi<ApiResponse<FormItem[]>>(
        '/api/forms' + (params?.lineAccountId ? '?lineAccountId=' + params.lineAccountId : ''),
      ),
    get: (id: string) => fetchApi<ApiResponse<FormItem>>(`/api/forms/${id}`),
    create: (data: {
      name: string
      displayName?: string | null
      description?: string | null
      fields: FormFieldItem[]
      onSubmitTagId?: string | null
      onSubmitScenarioId?: string | null
      onSubmitMessage?: string | null
      submitLabel?: string | null
      saveToMetadata?: boolean
      submitOnce?: boolean
      lineAccountId?: string | null
      isActive?: boolean
      formType?: 'generic' | 'daily_report' | 'test'
      correctAnswers?: Record<string, string | string[]> | null
      passingScore?: number | null
      passTagId?: string | null
      failTagId?: string | null
    }) => fetchApi<ApiResponse<FormItem>>('/api/forms', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
    update: (id: string, data: {
      name?: string
      displayName?: string | null
      description?: string | null
      fields?: FormFieldItem[]
      onSubmitTagId?: string | null
      onSubmitScenarioId?: string | null
      onSubmitMessage?: string | null
      submitLabel?: string | null
      saveToMetadata?: boolean
      submitOnce?: boolean
      lineAccountId?: string | null
      isActive?: boolean
      formType?: 'generic' | 'daily_report' | 'test'
      correctAnswers?: Record<string, string | string[]> | null
      passingScore?: number | null
      passTagId?: string | null
      failTagId?: string | null
    }) => fetchApi<ApiResponse<FormItem>>(`/api/forms/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/forms/${id}`, { method: 'DELETE' }),
    submissions: (id: string) =>
      fetchApi<ApiResponse<FormSubmissionItem[]> & { winnerTagId?: string | null }>(`/api/forms/${id}/submissions`),
  },
  trackedLinks: {
    list: (params?: { lineAccountId?: string }) =>
      fetchApi<ApiResponse<TrackedLinkItem[]>>(
        '/api/tracked-links' + (params?.lineAccountId ? '?lineAccountId=' + params.lineAccountId : ''),
      ),
    get: (id: string) => fetchApi<ApiResponse<TrackedLinkDetail>>(`/api/tracked-links/${id}`),
    create: (data: { name: string; originalUrl: string; tagId?: string | null; scenarioId?: string | null; lineAccountId?: string | null }) =>
      fetchApi<ApiResponse<TrackedLinkItem>>('/api/tracked-links', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { name?: string; originalUrl?: string; tagId?: string | null; scenarioId?: string | null; isActive?: boolean; lineAccountId?: string | null }) =>
      fetchApi<ApiResponse<TrackedLinkItem>>(`/api/tracked-links/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/tracked-links/${id}`, { method: 'DELETE' }),
  },
}

export interface FormFieldItem {
  name: string
  label: string
  type: 'text' | 'textarea' | 'radio' | 'select' | 'checkbox' | 'email' | 'tel' | 'number' | 'date'
  required?: boolean
  options?: string[]
  /** 選択肢の値ごとに付与するタグID配列（複数可） */
  optionTags?: Record<string, string[]>
  placeholder?: string
}

export interface FormItem {
  id: string
  name: string
  /** 回答者に見えるタイトル。null時は管理名 (name) にフォールバック */
  displayName?: string | null
  description: string | null
  fields: FormFieldItem[]
  onSubmitTagId: string | null
  onSubmitScenarioId: string | null
  /** 送信時にLINEへ送るプレーンテキスト返信。null=送らない */
  onSubmitMessage?: string | null
  /** 送信ボタンのCTA文言 */
  submitLabel?: string | null
  saveToMetadata: boolean
  /** 1人1回まで制限 */
  submitOnce?: boolean
  /** 帰属するLINEアカウント。共有LIFF URL生成に使う */
  lineAccountId?: string | null
  isActive: boolean
  submitCount: number
  createdAt: string
  updatedAt: string
}

export interface FormSubmissionItem {
  id: string
  formId: string
  friendId: string | null
  friendName?: string | null
  data: Record<string, unknown>
  createdAt: string
  isWinner?: boolean
}

export interface RichMenuAreaItem {
  bounds: { x: number; y: number; width: number; height: number }
  action: {
    type: 'uri' | 'message' | 'postback' | 'richmenuswitch'
    label?: string
    uri?: string
    text?: string
    data?: string
    richMenuAliasId?: string
  }
}

export interface RichMenuItem {
  id: string
  lineAccountId: string
  name: string
  lineRichmenuId: string | null
  sizeType: 'full' | 'compact'
  chatBarText: string
  selected: boolean
  areas: RichMenuAreaItem[]
  isDefault: boolean
  showOnFriendAdd: boolean
  /** このタグが付いた友だちに自動でこのメニューを出す（タグ連動リッチメニュー） */
  autoLinkTagId: string | null
  createdAt: string
  updatedAt: string
}

export interface TrackedLinkItem {
  id: string
  name: string
  originalUrl: string
  trackingUrl: string
  tagId: string | null
  scenarioId: string | null
  lineAccountId: string | null
  isActive: boolean
  clickCount: number
  createdAt: string
  updatedAt: string
}

export interface TrackedLinkDetail extends TrackedLinkItem {
  clicks: { id: string; friendId: string | null; friendDisplayName: string | null; clickedAt: string }[]
}

export interface EventItem {
  id: string
  lineAccountId: string | null
  name: string
  description: string | null
  eventType: 'consultation' | 'seminar'
  slug: string
  isActive: boolean
  recruitmentPaused?: boolean
  funnelRole?: 'top' | 'mid' | null
  eventFormat?: 'seminar' | 'individual' | null
  createdAt: string
  updatedAt: string
}

export interface BusinessCalendar {
  lineAccountId: string
  closedWeekdays: number[]
  closedDates: string[]
  notice: string | null
  updatedAt: string
}

export interface KpiFunnelSummary {
  period: { from: string; to: string; days: number }
  overall: {
    friendsAdded: number
    topUniqueFriends: number
    midUniqueFriends: number
    closedFriends: number
    revenue: number
  }
  topBreakdown: {
    eventId: string
    name: string
    eventFormat: 'seminar' | 'individual' | null
    topUniqueFriends: number
    midUniqueFriends: number
    closedFriends: number
    revenue: number
  }[]
}

export interface ConsultationConfig {
  eventId: string
  durationMinutes: number
  bufferBeforeMinutes: number
  bufferAfterMinutes: number
  advanceMinHours: number
  advanceMaxDays: number
  calendarViewMode: 'week' | 'month'
  businessHours: Record<string, [string, string] | null>
  blackoutDates: string[]
  googleCalendarConnectionId: string | null
  formId: string | null
  onCompleteTagId: string | null
  onCompleteScenarioId: string | null
  zoomUrl: string | null
  reminderDayBefore: boolean
  reminderDayBeforeAt: string
  reminderHourBefore: boolean
  reminderHourBeforeMinutes: number
  reminderDayBeforeMessage?: string | null
  reminderHourBeforeMessage?: string | null
  confirmationMessage?: string | null
  slotIntervalMinutes: number
  bookingFormFields: FormFieldItem[]
  bookingFormSubmitLabel?: string | null
  availableUntilDate?: string | null
  dailyBookingLimit?: number | null
  monthlyBookingLimit?: number | null
  requiresPaymentTicket?: boolean
}

export interface EventBookingItem {
  id: string
  connectionId: string
  friendId: string | null
  friendDisplayName: string | null
  friendLineUserId: string | null
  gcalEventId: string | null
  title: string
  startAt: string
  endAt: string
  status: 'confirmed' | 'cancelled' | 'completed'
  metadata: Record<string, unknown> | null
  applicationData: Record<string, unknown> | null
  createdAt: string
}

export interface AutoReplyItem {
  id: string
  lineAccountId: string | null
  keyword: string
  matchType: 'exact' | 'contains'
  responseType: 'text' | 'template' | 'add_tag' | 'enroll_scenario' | 'image' | 'flex'
  responseContent: string
  isActive: boolean
  createdAt: string
  updatedAt: string | null
}

export interface BulkActionItem {
  id: string
  lineAccountId: string | null
  name: string
  actionType: 'enroll_scenario' | 'add_tag' | 'set_richmenu'
  actionPayload: { scenarioId?: string; tagId?: string; richMenuId?: string }
  targetSpec: { mode: 'all' | 'tag_include' | 'tag_exclude'; tagId?: string | null }
  status: 'pending' | 'running' | 'completed' | 'failed'
  totalTargets: number
  processedCount: number
  failedCount: number
  errorLog: string | null
  executedAt: string | null
  createdAt: string
}

// ── 単語テスト ───────────────────────────────────────────────────────────────

export type VocabStudentRow = {
  friend_id: string
  display_name: string | null
  last_played_at: string | null
  sessions: number
  answers: number
  latest_rate: number | null
  /** 実力テストのスコア（直近10回の加重平均）。未受験なら null */
  checkup_score: number | null
  checkup_sessions: number
  book_name: string | null
  total: number
  mastered: number
  unmastered: number
  untried: number
  rate: number | null
}

export type VocabBlock = {
  block: number
  from: number
  to: number
  total: number
  mastered: number
  unmastered: number
  untried: number
}

export type VocabCheckup = {
  at: string
  total: number
  correct: number
  score: number
}

export type VocabBookMastery = {
  id: number
  name: string
  total: number
  mastered: number
  unmastered: number
  untried: number
  rate: number
  review_count: number
  last_played_at: string | null
  /** 100語ごとの状態。セクション別の定着率に使う */
  blocks: VocabBlock[]
  /** 実力テストの履歴（古い→新しい） */
  checkups: VocabCheckup[]
  /** 直近10回の加重平均 */
  checkup_score: { score: number; correct: number; total: number; sessions: number } | null
}

export type VocabSessionRow = {
  id: number
  book_name: string
  kind: string
  range_from: number | null
  range_to: number | null
  format: string
  direction: string
  timer_sec: number
  started_at: string
  finished_at: string
  total: number
  correct: number
}

export type VocabWeakWord = {
  word_id: number
  no: number
  en: string
  ja: string
  wrong: number
  asked: number
}

export type VocabAnswerRow = {
  word_id: number
  no: number
  en: string
  ja: string
  ok: number
  timed_out: number
  elapsed_ms: number | null
}

export type VocabFormatStat = {
  ej: number | null
  je: number | null
  choice: number | null
  recall: number | null
  timeout_rate: number | null
}

export type VocabSectionStat = {
  block: number
  from: number
  to: number
  asked: number
  correct: number
  rate: number
}

export type VocabWordRow = {
  id: number
  no: number
  en: string
  ja: string
  section: string | null
}

export type VocabTrendPoint = {
  at: string
  rate: number
  kind: string
  total: number
  correct: number
}

// ── 文法テスト ──────────────────────────────────────────────────────────────

export type GrammarCategoryInfo = {
  name: string
  count: number
  from: number
  to: number
}

export type GrammarBookSummary = {
  id: number
  slug: string
  name: string
  count: number
  max_no: number
  categories: GrammarCategoryInfo[]
}

export type GrammarQuestionInput = {
  no: number
  category: string
  sub_category?: string | null
  prompt: string
  choices: string[]
  answer: number
  explanation?: string | null
  level?: string | null
  source?: string | null
  /** 誤答ごとの勘違い。キーは choices の添字（正解の添字は含めない） */
  distractors?: Record<string, string> | null
}

export type GrammarQuestionRow = {
  id: number
  no: number
  category: string
  sub_category: string | null
  prompt: string
  choices: string[]
  answer: number
  explanation: string | null
  level: string | null
  /** 講師用の出典メモ。生徒向けAPI（復習キュー等）からは返らないので任意。 */
  source?: string | null
  /** 誤答ごとの勘違い。管理画面でのみ返る */
  distractors?: Record<string, string>
}

export type GrammarCategoryMastery = {
  name: string
  from: number
  to: number
  total: number
  mastered: number
  unmastered: number
  untried: number
  rate: number
}

export type GrammarCheckup = {
  at: string
  total: number
  correct: number
  score: number
}

export type GrammarBookMastery = {
  id: number
  name: string
  total: number
  mastered: number
  unmastered: number
  untried: number
  rate: number
  review_count: number
  last_played_at: string | null
  categories: GrammarCategoryMastery[]
  checkups: GrammarCheckup[]
  checkup_score: { score: number; correct: number; total: number; sessions: number } | null
}

/** よく間違えている単元。asked と questions の差が「繰り返し解いた度合い」 */
export type GrammarUnitStat = {
  category: string
  name: string
  /** 延べ解答数（retry を除く） */
  asked: number
  wrong: number
  rate: number
  /** 実際に触れた問題数 */
  questions: number
  total: number
  mastered: number
}

export type GrammarStudentRow = {
  friend_id: string
  display_name: string | null
  last_played_at: string | null
  sessions: number
  answers: number
  latest_rate: number | null
  checkup_score: number | null
  checkup_sessions: number
  book_name: string | null
  total: number
  mastered: number
  unmastered: number
  untried: number
  rate: number | null
  /** いちばんできていない単元。分野より具体的なので、そのまま授業で扱える */
  weakest_unit: { category: string; name: string; rate: number; asked: number } | null
}

export type GrammarSessionRow = {
  id: number
  book_name: string
  kind: string
  category: string | null
  sub_category: string | null
  range_from: number | null
  range_to: number | null
  order_mode: string
  timer_sec: number
  started_at: string
  finished_at: string
  total: number
  correct: number
}

export type GrammarWeakQuestion = {
  question_id: number
  no: number
  category: string
  prompt: string
  choices: string[]
  answer: number
  explanation: string | null
  wrong: number
  asked: number
}

export type GrammarAnswerRow = {
  question_id: number
  no: number
  category: string
  prompt: string
  choices: string[]
  answer: number
  chosen: number | null
  ok: number
  timed_out: number
  elapsed_ms: number | null
}

export type GrammarCategoryStat = {
  name: string
  asked: number
  correct: number
  rate: number
}

/** どの誤答が選ばれたか。`picks` は choices と同じ並び。 */
export type GrammarDistractor = {
  question_id: number
  no: number
  category: string
  sub_category: string | null
  prompt: string
  choices: string[]
  answer: number
  asked: number
  picks: number[]
  /** 誤答ごとの勘違い。キーは choices の添字 */
  distractors: Record<string, string>
  /** 一度も選ばれていない誤答の添字＝死んだ選択肢。生徒でなく問題の側の不具合 */
  dead: number[]
}

export type GrammarStudentDetail = {
  sessions: GrammarSessionRow[]
  books: GrammarBookMastery[]
  weak_questions: GrammarWeakQuestion[]
  totals: { answers: number; sessions: number; days: number }
  focus_book: { id: number; name: string } | null
  categories: GrammarCategoryStat[]
  /** よく間違えている単元。正答率の低い順 */
  units: GrammarUnitStat[]
  pace: { timeout_rate: number | null; median_ms: number | null } | null
  review_questions: GrammarQuestionRow[]
  distractors: GrammarDistractor[]
  trend: VocabTrendPoint[]
}

export type VocabStudentDetail = {
  sessions: VocabSessionRow[]
  books: VocabBookMastery[]
  weak_words: VocabWeakWord[]
  totals: { answers: number; sessions: number; days: number }
  focus_book: { id: number; name: string } | null
  formats: VocabFormatStat | null
  sections: VocabSectionStat[]
  review_words: VocabWordRow[]
  trend: VocabTrendPoint[]
}


// ── 並び替えテスト（Build a Sentence） ──────────────────────────────────────

/** 攻略ブックの型カタログ（A1〜G4）。弱点集計の軸になる。 */
export interface BasType {
  code: string
  group_code: string
  group_name: string
  name: string
  hint: string | null
  sort: number
}

export interface BasTypeStat extends BasType {
  /** プールにこの型を含む問題が何問あるか */
  total: number
  /** そのうち1回以上解いた問題数（直近の解答ベース） */
  tried: number
  ok: number
  /** 0〜100。tried が 0 なら 0 なので、画面では「未挑戦」と出し分ける */
  rate: number
}

export interface BasGroupStat {
  code: string
  name: string
  total: number
  tried: number
  ok: number
  rate: number
  types: BasTypeStat[]
}

export interface BasStudentRow {
  friend_id: string
  display_name: string | null
  last_played_at: string | null
  sessions: number
  /** 解いた問題の延べ数（同じ問題を2回解けば2） */
  answers: number
  correct: number
  rate: number | null
  /** 手をつけた問題の数（重複を除く） */
  tried: number
  weakest: { code: string; name: string; rate: number; tried: number } | null
}

export interface BasDashboard {
  pool: number
  tried: number
  sessions: number
  answered: number
  correct: number
  rate: number
  groups: BasGroupStat[]
  weak: BasTypeStat[]
  recent: {
    id: number
    kind: string
    focus_type: string | null
    timer_sec: number
    total: number
    correct: number
    finished_at: string
  }[]
}

export interface BasStudentDetail {
  dashboard: BasDashboard
  /** いま落としたままの問題。あとで解き直して正解したものは入らない */
  recent_wrong: {
    question_id: number
    no: number
    sentence: string
    ja: string
    types: string[]
    submitted: string[] | null
    timed_out: number
    answered_at: string
  }[]
}

export interface BasSetSummary {
  id: number
  slug: string
  name: string
  line_account_id: string | null
  sort: number
  active: number
  created_at: string
  count: number
  accepted_count: number
  extra_count: number
}

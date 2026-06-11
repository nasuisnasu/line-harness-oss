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
    update: (id: string, data: Partial<Pick<LineAccount, 'name' | 'channelAccessToken' | 'channelSecret' | 'isActive'>>) =>
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
      fetchApi<ApiResponse<EventBookingItem[]>>(`/api/events/${id}/bookings`),
    cancelBooking: (bookingId: string) =>
      fetchApi<ApiResponse<{ id: string; status: string }>>(`/api/event-bookings/${bookingId}/cancel`, {
        method: 'POST',
      }),
  },
  kpi: {
    funnelSummary: (params?: { lineAccountId?: string; days?: number }) =>
      fetchApi<ApiResponse<KpiFunnelSummary>>(
        '/api/kpi/funnel-summary' + (params ? '?' + new URLSearchParams(
          Object.fromEntries(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
        ) : ''),
      ),
  },
  googleCalendar: {
    list: () =>
      fetchApi<ApiResponse<{ id: string; calendarId: string; authType: string; isActive: boolean; createdAt: string }[]>>(
        '/api/integrations/google-calendar',
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
      fetchApi<ApiResponse<FormSubmissionItem[]>>(`/api/forms/${id}/submissions`),
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
  funnelRole?: 'top' | 'mid' | null
  eventFormat?: 'seminar' | 'individual' | null
  createdAt: string
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

'use client'

import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import type { LineAccount } from '@line-crm/shared'
import { api } from './api'

interface AccountContextValue {
  accounts: LineAccount[]
  selectedAccount: LineAccount | null
  setSelectedAccount: (account: LineAccount | null) => void
  isLoading: boolean
}

const AccountContext = createContext<AccountContextValue>({
  accounts: [],
  selectedAccount: null,
  setSelectedAccount: () => {},
  isLoading: true,
})

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [accounts, setAccounts] = useState<LineAccount[]>([])
  const [selectedAccount, setSelectedAccountState] = useState<LineAccount | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    api.lineAccounts.list()
      .then((res) => {
        if (!res.success) return
        const list = res.data as LineAccount[]
        setAccounts(list)

        // Restore saved selection from localStorage
        const saved = typeof window !== 'undefined' ? localStorage.getItem('lh_selected_account_id') : null
        if (saved) {
          const found = list.find((a) => a.id === saved)
          if (found) { setSelectedAccountState(found); return }
        }
        // Default to first account
        if (list.length > 0) setSelectedAccountState(list[0])
      })
      .catch(() => {})
      .finally(() => setIsLoading(false))
  }, [])

  const setSelectedAccount = useCallback((account: LineAccount | null) => {
    setSelectedAccountState(account)
    if (typeof window !== 'undefined') {
      if (account) localStorage.setItem('lh_selected_account_id', account.id)
      else localStorage.removeItem('lh_selected_account_id')
    }
  }, [])

  return (
    <AccountContext.Provider value={{ accounts, selectedAccount, setSelectedAccount, isLoading }}>
      {children}
    </AccountContext.Provider>
  )
}

export function useAccount() {
  return useContext(AccountContext)
}

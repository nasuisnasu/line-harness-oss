'use client'
import { usePathname } from 'next/navigation'
import Sidebar from './layout/sidebar'
import AuthGuard from './auth-guard'
import { AccountProvider } from '@/lib/account-context'
import { CcPromptProvider } from '@/lib/cc-prompt-context'

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  // /login: public auth screen
  // /f: public form page (回答者は管理画面アカウントを持っていない)
  if (pathname === '/login' || pathname === '/f' || pathname.startsWith('/f/')) {
    return <>{children}</>
  }

  return (
    <AuthGuard>
      <AccountProvider>
        <CcPromptProvider>
          <div className="flex min-h-screen">
            <Sidebar />
            <main className="flex-1 pt-[72px] px-4 pb-6 sm:px-6 lg:pt-8 lg:px-8 lg:pb-8 overflow-auto">
              {children}
            </main>
          </div>
        </CcPromptProvider>
      </AccountProvider>
    </AuthGuard>
  )
}

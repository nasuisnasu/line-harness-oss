'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { PromptTemplate } from '@/components/prompt-modal'

/**
 * Pages register their page-specific CC prompts via `useRegisterCcPrompts`.
 * The sidebar reads the active set from context to render the trigger
 * button — that's how we got rid of the floating bottom-right FAB without
 * breaking the per-page prompt customisation.
 */
interface CcPromptContextValue {
  prompts: PromptTemplate[]
  setPrompts: (prompts: PromptTemplate[]) => void
}

const CcPromptContext = createContext<CcPromptContextValue | null>(null)

export function CcPromptProvider({ children }: { children: ReactNode }) {
  const [prompts, setPrompts] = useState<PromptTemplate[]>([])
  return (
    <CcPromptContext.Provider value={{ prompts, setPrompts }}>
      {children}
    </CcPromptContext.Provider>
  )
}

export function useCcPromptContext(): CcPromptContextValue {
  const ctx = useContext(CcPromptContext)
  if (!ctx) {
    // Tolerated: pages outside the provider just won't see prompts. Avoid
    // throwing so a renderer mistake doesn't blank the whole app.
    return { prompts: [], setPrompts: () => undefined }
  }
  return ctx
}

/** Registers a page's prompts on mount and clears them on unmount. */
export function useRegisterCcPrompts(prompts: PromptTemplate[]): void {
  const { setPrompts } = useCcPromptContext()
  useEffect(() => {
    setPrompts(prompts)
    return () => setPrompts([])
    // We intentionally only run when the array's identity changes; pages
    // typically declare prompts as a module-scope const.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompts])
}

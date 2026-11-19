import { useEffect, useRef, type ReactNode } from 'react'
import { AudioLines, Sprout, X } from 'lucide-react'

export function Dialog({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => { element?.close() }
  }, [])
  return <dialog ref={dialog} aria-label={title} onCancel={(event) => { event.preventDefault(); close() }}
    onClick={(event) => { if (event.target === event.currentTarget) close() }}>
    <div className="dialog-inner">
      <header className="dialog-heading">
        <h2>{title}</h2>
        <button type="button" className="icon-button" onClick={close} aria-label="Закрыть"><X size={20} /></button>
      </header>
      {children}
    </div>
  </dialog>
}

export function Notice({ children, action }: { children: ReactNode; action?: () => void }) {
  return <div className="notice" role="alert">
    <span>{children}</span>
    {action && <button className="text-button" onClick={action}>Повторить</button>}
  </div>
}

export function Brand({ size = 20 }: { size?: number }) {
  return <span className="brand-mark"><Sprout size={size} strokeWidth={1.65} aria-hidden="true" /></span>
}

export function EmptyState({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state">
    <div className="empty-emblem"><AudioLines size={35} strokeWidth={1.35} aria-hidden="true" /></div>
    <h2>{title}</h2>
    <p>{text}</p>
    {action}
  </div>
}


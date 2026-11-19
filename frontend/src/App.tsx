import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, LockKeyhole, Menu, MessageCircle, Plus, X } from 'lucide-react'
import { errorText, getApi, type Chat, type ChatApi, type ChatList, type Model, type Submission } from './api'
import { Workspace } from './Workspace'
import { Brand, Dialog, EmptyState, Notice } from './components'
import { BudgetButton, BudgetDialog, BudgetPrompt } from './Budget'
import { useFinanceRead } from './finance'

type Connected = { api: ChatApi; models: Model[]; demo: boolean }

export function App() {
  const [connected, setConnected] = useState<Connected | null>(null)
  const [state, setState] = useState<ChatList>({ active_chat_id: null, chats: [] })
  const [opened, setOpened] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [moving, setMoving] = useState(false)
  const [audioCapture, setAudioCapture] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const [creating, setCreating] = useState(false)
  const [budgetOpen, setBudgetOpen] = useState(false)
  const [modelChoice, setModelChoice] = useState('')
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')
  const [dialogError, setDialogError] = useState('')
  const operation = useRef(false)
  const closeNavigation = useRef<HTMLButtonElement>(null)

  const api = connected?.api
  const loadBudget = useCallback(() => api!.budget(), [api])
  const budget = useFinanceRead(loadBudget, !!api, budgetOpen ? 8000 : undefined)
  const openBudget = () => setBudgetOpen(true)

  async function connect() {
    setLoading(true)
    setError('')
    try {
      const api = await getApi()
      const [health, { models }, chats] = await Promise.all([api.health(), api.models(), api.chats()])
      setConnected({ api, models, demo: health.demo })
      setModelChoice(models[0]?.id ?? '')
      setState(chats)
      setOpened(chats.active_chat_id ? [chats.active_chat_id] : [])
    } catch (failure) { setError(errorText(failure)) }
    finally { setLoading(false) }
  }

  useEffect(() => { void connect() }, [])

  useEffect(() => {
    if (!mobileNav) return
    const trigger = document.activeElement
    closeNavigation.current?.focus()
    function dismiss(event: KeyboardEvent) {
      if (event.key === 'Escape') setMobileNav(false)
    }
    document.addEventListener('keydown', dismiss)
    return () => {
      document.removeEventListener('keydown', dismiss)
      if (trigger instanceof HTMLElement && !trigger.closest('[hidden]')) trigger.focus()
    }
  }, [mobileNav])

  function showCreate() {
    if (audioCapture || moving) return
    setTitle('')
    setDialogError('')
    setCreating(true)
  }

  function showChat(chat: Chat, created = false) {
    setState((current) => ({
      active_chat_id: chat.id,
      chats: created ? [chat, ...current.chats] : current.chats.map((item) => item.id === chat.id ? chat : item),
    }))
    setOpened((current) => current.includes(chat.id) ? current : [...current, chat.id])
    setMobileNav(false)
  }

  async function move(action: () => Promise<Chat>, created = false) {
    if (operation.current || audioCapture) return
    operation.current = true
    setMoving(true)
    setError('')
    setDialogError('')
    try {
      showChat(await action(), created)
      setCreating(false)
    } catch (failure) {
      if (created) setDialogError(errorText(failure))
      else setError(errorText(failure))
    } finally {
      operation.current = false
      setMoving(false)
    }
  }

  function accepted(id: string, submission: Submission) {
    setState((current) => {
      const chat = current.chats.find((item) => item.id === id)
      if (!chat) return current
      const updated = { ...chat, mode: submission.mode, updated_at: new Date().toISOString() }
      return { ...current, chats: [updated, ...current.chats.filter((item) => item.id !== id)] }
    })
  }

  const modelName = (id: string) => connected?.models.find((item) => item.id === id)?.label ?? id
  const active = state.chats.find((chat) => chat.id === state.active_chat_id)
  const mock = import.meta.env.DEV && import.meta.env.VITE_USE_MOCK_API === '1'
  const scope = mock ? 'mock' : connected?.demo ? 'demo' : 'personal'
  const canCreate = !!connected?.models.length && !audioCapture && !moving

  return <div className="app-layout">
    <aside className={`sidebar${mobileNav ? ' sidebar-open' : ''}`} aria-label="Список бесед">
      <div className="sidebar-brand">
        <Brand />
        <h1>psyholuh</h1>
        <button type="button" className="icon-button sidebar-close" ref={closeNavigation} onClick={() => setMobileNav(false)} aria-label="Закрыть список бесед"><X size={20} /></button>
      </div>
      <button className="new-chat" disabled={!canCreate} onClick={showCreate}><Plus size={19} /> Новая беседа</button>
      <section className="sidebar-history">
        <h2>Ваши беседы</h2>
        {state.chats.length ? <nav aria-label="Сохранённые беседы">
          {state.chats.map((chat) => <button key={chat.id} type="button"
            className={`chat-link${chat.id === active?.id ? ' chat-selected' : ''}`}
            aria-current={chat.id === active?.id ? 'page' : undefined}
            disabled={moving || (audioCapture && chat.id !== active?.id)}
            onClick={() => {
              if (chat.id === active?.id) setMobileNav(false)
              else if (connected) void move(() => connected.api.activate(chat.id))
            }}>
            <MessageCircle size={17} />
            <span><strong>{chat.title}</strong><small>{modelName(chat.model_id)}</small></span>
          </button>)}
        </nav> : !loading && <p className="sidebar-empty">Здесь появятся сохранённые беседы.</p>}
      </section>
      <footer className="sidebar-footer"><LockKeyhole size={14} /> История на этом компьютере</footer>
    </aside>
    {mobileNav && <button className="drawer-scrim nav-scrim" aria-label="Закрыть список бесед" onClick={() => setMobileNav(false)} />}
    <main className="main-area">
      {error && <div className="app-notice"><Notice action={!connected ? connect : undefined}>{error}</Notice></div>}
      {!active && <>
        <header className="topbar">
          <button type="button" className="icon-button menu-toggle" onClick={() => setMobileNav(true)} aria-label="Открыть список бесед"><Menu size={22} /></button>
          <span className="empty-topbar-title">psyholuh</span>
          <div className="topbar-actions">
            {connected?.demo && <span className="demo-tag" title="Вымышленные данные">ДЕМО</span>}
            {connected && <BudgetButton open={openBudget} />}
          </div>
        </header>
        {connected && !connected.demo && <BudgetPrompt budget={budget.value} open={openBudget} />}
        <div className="standalone-empty">
          <EmptyState title={loading ? 'Загружаем беседы…' : 'Есть о чём поговорить?'}
            text={loading ? 'Подключаемся к локальному серверу.' : 'Начните беседу, когда будете готовы.'}
            action={canCreate && <button className="primary-button" onClick={showCreate}>Начать беседу <ArrowRight size={17} /></button>} />
          {!loading && connected && !connected.models.length && <p className="muted">На сервере пока нет настроенных моделей.</p>}
        </div>
      </>}
      {connected && opened.map((id) => {
        const chat = state.chats.find((item) => item.id === id)
        return chat && <Workspace key={id} api={connected.api} chat={chat} visible={id === active?.id} moving={moving}
          modelLabel={modelName(chat.model_id)} demo={connected.demo} scope={scope} budget={budget.value} onBudget={openBudget}
          onMenu={() => setMobileNav(true)} onRecording={setAudioCapture}
          onAccepted={(submission) => accepted(id, submission)} />
      })}
    </main>
    {budgetOpen && connected && <BudgetDialog budget={budget.value} error={budget.error} onRefresh={() => budget.refresh(true)}
      save={async (limit) => budget.replace(await connected.api.setBudget(limit))}
      close={() => setBudgetOpen(false)} />}
    {creating && connected && <Dialog title="Новая беседа" close={() => { if (!moving) setCreating(false) }}>
      <form onSubmit={(event) => {
        event.preventDefault()
        const name = title.trim()
        void move(() => connected.api.create(modelChoice, name || undefined), true)
      }}>
        <label className="field-label" htmlFor="chat-title">Название <span>необязательно</span></label>
        <input id="chat-title" className="form-input" placeholder="Новая беседа" value={title} maxLength={120}
          onChange={(event) => setTitle(event.target.value)} autoFocus disabled={moving} />
        <fieldset className="model-options" disabled={moving}>
          <legend>Модель</legend>
          {connected.models.map((model) => <label key={model.id}>
            <input type="radio" name="model" checked={modelChoice === model.id} onChange={() => setModelChoice(model.id)} />
            <span><strong>{model.label}</strong><small>{model.id}</small></span>
          </label>)}
        </fieldset>
        <p className="muted form-help">Выбранная модель закрепится за беседой.</p>
        {dialogError && <Notice>{dialogError}</Notice>}
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={() => setCreating(false)} disabled={moving}>Отмена</button>
          <button className="primary-button" type="submit" disabled={moving || !modelChoice}>{moving ? 'Создаём…' : 'Создать'} <ArrowRight size={17} /></button>
        </div>
      </form>
    </Dialog>}
  </div>
}

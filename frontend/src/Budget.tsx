import { useRef, useState } from 'react'
import { ChevronDown, Settings2 } from 'lucide-react'
import { errorText, type Budget, type ChatCosts } from './api'
import { Dialog, Notice } from './components'
import { formatUsd, isZeroUsd, parseBudget } from './finance'

export function BudgetButton({ open }: { open: () => void }) {
  return <button className="secondary-button budget-toggle" type="button" aria-label="Настройки бюджета"
    title="Настройки бюджета" onClick={open}><Settings2 size={17} /></button>
}

export function BudgetDialog({ budget, error, onRefresh, save, close }: {
  budget: Budget | null
  error: string
  onRefresh: () => void
  save: (limit: string) => Promise<void>
  close: () => void
}) {
  const [edit, setEdit] = useState<string>()
  const [invalid, setInvalid] = useState('')
  const [saveError, setSaveError] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const input = edit ?? budget?.limit_usd?.replace('.', ',') ?? ''

  async function submit() {
    if (savingRef.current) return
    setInvalid('')
    setSaveError('')
    setSubmitted(false)
    let limit
    try {
      limit = parseBudget(input)
    } catch (failure) {
      setInvalid(errorText(failure))
      return
    }
    savingRef.current = true
    setSaving(true)
    try {
      await save(limit)
      setEdit(undefined)
      setSubmitted(true)
    } catch (failure) {
      setSaveError(errorText(failure))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return <Dialog title="Настройки бюджета" close={() => { if (!savingRef.current) close() }}>
    <p className="muted">Общий лимит на расходы OpenRouter для всех бесед на этой установке.</p>
    {error && <div className="finance-notice"><Notice action={onRefresh}>{error}</Notice></div>}
    {budget ? <dl className="budget-balance">
      <div><dt>Сохранённый лимит</dt><dd>{budget.limit_usd === null ? 'Не задан' : formatUsd(budget.limit_usd)}</dd></div>
      <div><dt>Потрачено</dt><dd>{formatUsd(budget.spent_usd)}</dd></div>
      <div><dt>В резерве</dt><dd>{formatUsd(budget.reserved_usd)}</dd></div>
      <div><dt>Доступно</dt><dd>{formatUsd(budget.available_usd)}</dd></div>
    </dl> : !error && <p className="muted form-help" role="status">Загружаем бюджет…</p>}
    <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <label className="field-label" htmlFor="budget-limit">Лимит, USD</label>
      <input id="budget-limit" className="form-input" type="text" inputMode="decimal" autoComplete="off"
        autoFocus disabled={saving} value={input} placeholder="Например, 5,00" aria-invalid={!!invalid}
        aria-describedby={invalid ? 'budget-help budget-invalid' : 'budget-help'}
        onChange={(event) => { setEdit(event.target.value); setInvalid(''); setSaveError(''); setSubmitted(false) }} />
      <p className="muted form-help" id="budget-help">Лимит 0 приостанавливает платные запросы.</p>
      {invalid && <p className="budget-invalid" id="budget-invalid" role="alert">{invalid}</p>}
      {saveError && <div className="finance-notice"><Notice>{saveError}</Notice></div>}
      {submitted && <p className="budget-saved" role="status">Бюджет сохранён.</p>}
      <div className="dialog-actions">
        <button className="secondary-button" type="button" onClick={close} disabled={saving}>Закрыть</button>
        <button className="primary-button" type="submit" disabled={saving}>{saving ? 'Сохраняем…' : 'Сохранить'}</button>
      </div>
    </form>
  </Dialog>
}

export function BudgetPrompt({ budget, open }: { budget: Budget | null; open: () => void }) {
  if (!budget || (budget.limit_usd !== null && !isZeroUsd(budget.limit_usd))) return null
  const message = budget.limit_usd === null ? 'Задайте бюджет OpenRouter, чтобы получать ответы.' : 'Платные запросы приостановлены. Лимит равен $0.'
  return <div className="budget-prompt"><p>{message}</p><button className="text-button" type="button" onClick={open}>Открыть бюджет</button></div>
}

export function ChatCostBar({ costs, error, latestReply }: { costs: ChatCosts | null; error: string; latestReply?: string }) {
  const reply = costs?.last_reply
  let last = '—'
  if (costs && latestReply && latestReply !== reply?.message_id) last = 'Уточняется…'
  else if (reply?.pending) last = 'Уточняется…'
  else if (reply) last = reply.cost_usd === null ? 'Нет данных' : formatUsd(reply.cost_usd)

  return <div className="topbar-metrics" aria-label="Стоимость беседы">
    <dl className="cost-figures">
      <div><dt>Последний ответ</dt><dd>{last}</dd></div>
      <div><dt>Всего</dt><dd>{formatUsd(costs?.total_usd ?? null)}</dd></div>
    </dl>
    <details className="cost-details">
      <summary aria-label="Расходы по беседе" title="Расходы по беседе"><ChevronDown size={17} /></summary>
      <div className="cost-breakdown">
        <p className="cost-breakdown-heading">Расходы по беседе</p>
        <dl>
          <div><dt>Ответы</dt><dd>{formatUsd(costs?.replies_usd ?? null)}</dd></div>
          <div><dt>Сжатие контекста</dt><dd>{formatUsd(costs?.compression_usd ?? null)}</dd></div>
          <div><dt>В резерве</dt><dd>{formatUsd(costs?.reserved_usd ?? null)}</dd></div>
        </dl>
        {error && <p className="budget-invalid" role="status">{costs ? 'Не удалось обновить расходы.' : 'Расходы пока недоступны.'}</p>}
      </div>
    </details>
  </div>
}

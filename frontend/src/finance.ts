import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText, type ChatApi } from './api'

export function isZeroUsd(value: string) {
  return !/[1-9]/.test(value)
}

export function formatUsd(value: string | null) {
  if (value === null) return '—'
  const [whole, fraction = ''] = value.split('.')
  const digits = fraction.replace(/0+$/, '')
  return `$${BigInt(whole).toLocaleString('ru-RU')}${digits ? `,${digits}` : ''}`
}

export function parseBudget(input: string) {
  const text = input.trim()
  if (!/^[0-9]+(?:[.,][0-9]{1,9})?$/.test(text)) {
    throw new Error('Введите неотрицательную сумму. Допускается до 9 знаков после запятой или точки.')
  }
  return text.replace(/^0+(?=\d)/, '').replace(',', '.')
}

export function budgetError(code?: string) {
  switch (code) {
    case 'budget_required': return 'Установите бюджет в настройках, затем повторите ответ.'
    case 'budget_exceeded': return 'Для запроса не хватает доступного бюджета. Проверьте лимит и резерв, затем повторите ответ.'
    case 'budget_pricing_unavailable': return 'Сейчас не удалось получить цену модели. Повторите ответ позже.'
    default: return ''
  }
}

export function useFinanceRead<T>(load: () => Promise<T>, enabled: boolean, interval?: number) {
  const [value, setValue] = useState<T | null>(null)
  const [error, setError] = useState('')
  const enabledRef = useRef(enabled)
  const read = useRef({ running: false, again: false, version: 0 })
  useEffect(() => { enabledRef.current = enabled }, [enabled])

  const refresh = useCallback((queue = false) => {
    if (!enabledRef.current || document.hidden) return
    const lock = read.current
    if (lock.running) {
      lock.again ||= queue
      return
    }
    lock.running = true
    void (async () => {
      do {
        lock.again = false
        const version = lock.version
        try {
          const result = await load()
          if (version === lock.version) {
            setValue(result)
            setError('')
          }
        } catch (failure) {
          if (version === lock.version) setError(errorText(failure))
        }
      } while (lock.again && enabledRef.current && !document.hidden)
      lock.running = false
    })()
  }, [load])

  useEffect(() => {
    if (!enabled) return
    refresh(true)
    const tick = () => refresh()
    document.addEventListener('visibilitychange', tick)
    const timer = interval === undefined ? undefined : window.setInterval(tick, interval)
    return () => {
      document.removeEventListener('visibilitychange', tick)
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [enabled, interval, refresh])

  function replace(next: T) {
    read.current.version++
    setValue(next)
    setError('')
  }

  return { value, error, refresh, replace }
}

export function useChatCosts(api: ChatApi, id: string, visible: boolean, busy: boolean, revision: number, latestReply?: string) {
  const load = useCallback(() => api.costs(id), [api, id])
  const data = useFinanceRead(load, visible, 15000)
  const awaiting = !!data.value?.last_reply?.pending || (!!data.value && !isZeroUsd(data.value.reserved_usd))
  const { refresh } = data

  useEffect(() => {
    if (visible && (revision !== 0 || busy || latestReply)) refresh(true)
  }, [busy, latestReply, refresh, revision, visible])

  useEffect(() => {
    if (!visible || (!busy && !awaiting)) return
    const timer = window.setInterval(() => refresh(), 4000)
    return () => window.clearInterval(timer)
  }, [awaiting, busy, refresh, visible])

  return data
}

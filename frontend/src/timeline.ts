import { useEffect, useRef, useState } from 'react'
import { ApiError, errorText, type ChatApi, type Message, type StreamPhase, type Submission } from './api'

type Attempt = {
  submission: Submission
  text: string
  phase: StreamPhase | 'connecting' | 'failed'
  error?: string
  retryable?: boolean
}

const storageKey = (scope: string, chatId: string) => `psyholuh-outbox-v1/${scope}/${chatId}`
function readOutbox(key: string): Submission | null {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') }
  catch { return null }
}
function writeOutbox(key: string, submission: Submission | null) {
  try {
    if (submission) localStorage.setItem(key, JSON.stringify(submission))
    else localStorage.removeItem(key)
  } catch { /* the server can still recover accepted submissions */ }
}

function mergeMessages(current: Message[], extras: Message[]) {
  const messages = new Map(current.map((message) => [message.id, message]))
  for (const message of extras) {
    const existing = messages.get(message.id)
    if (existing?.status !== 'complete' || message.status === 'complete') messages.set(message.id, message)
  }
  return [...messages.values()].sort((a, b) => a.seq - b.seq)
}

export function reconstructSubmission(assistant: Message, messages: Message[]): Submission | null {
  const user = messages.find((message) => message.role === 'user' && message.request_id === assistant.request_id)
  if (!user?.request_id) return null
  return { text: user.text, mode: user.mode ?? 'listen', request_id: user.request_id, ...(user.audio_id && { audio_id: user.audio_id }) }
}

export function useTimeline(
  api: ChatApi,
  chatId: string,
  scope: string,
  onAccepted: (submission: Submission) => void,
  onCompleted: () => void,
) {
  const outboxKey = storageKey(scope, chatId)
  const [messages, setMessages] = useState<Message[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [attempt, setAttempt] = useState<Attempt | null>(() => {
    const submission = readOutbox(outboxKey)
    return submission && { submission, text: '', phase: 'connecting' }
  })
  const controller = useRef<AbortController | null>(null)
  const pending = useRef(attempt?.submission ?? null)
  const operation = useRef(0)
  const historyLock = useRef(false)

  async function refresh() {
    const page = await api.messages(chatId)
    setMessages((current) => mergeMessages(current, page.messages))
    setCursor((current) => ready ? current : page.next_before_seq)
    setReady(true)
    setHistoryError('')
    return page.messages
  }

  function reconcile(items: Message[], submission: Submission, error?: string, retryable = true) {
    const reply = items.find((message) => message.request_id === submission.request_id && message.role === 'assistant')
    if (reply?.status === 'complete') {
      pending.current = null
      writeOutbox(outboxKey, null)
      setAttempt(null)
      onAccepted(submission)
      onCompleted()
    } else if (reply?.status === 'streaming') {
      setAttempt((current) => ({ submission, text: reply.text || current?.text || '', phase: 'already_running' }))
      onAccepted(submission)
    } else {
      setAttempt({
        submission, text: reply?.text ?? '',
        phase: 'failed', error: error || (reply ? 'Ответ прервался. Можно продолжить.' : 'Отправка не подтверждена. Можно повторить.'),
        retryable,
      })
      if (reply) onAccepted(submission)
    }
  }

  async function loadHistory() {
    if (historyLock.current) return
    historyLock.current = true
    const generation = operation.current
    setLoading(true)
    setHistoryError('')
    try {
      const items = await refresh()
      if (pending.current && !controller.current && operation.current === generation) reconcile(items, pending.current)
    } catch (error) {
      setHistoryError(errorText(error))
    } finally {
      historyLock.current = false
      setLoading(false)
    }
  }

  async function loadOlder() {
    if (!cursor || historyLock.current) return false
    historyLock.current = true
    setLoading(true)
    setHistoryError('')
    try {
      const page = await api.messages(chatId, cursor)
      setCursor(page.next_before_seq)
      setMessages((current) => mergeMessages(current, page.messages))
      return true
    } catch (error) {
      setHistoryError(errorText(error))
      return false
    } finally {
      historyLock.current = false
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadHistory()
    return () => controller.current?.abort()
    // A workspace is keyed by its chat and lives as long as the application.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, chatId])

  const watching = attempt?.phase === 'already_running' || (!attempt && messages.some((message) => message.status === 'streaming'))
  useEffect(() => {
    if (!watching) return
    const timer = window.setInterval(loadHistory, 1800)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, ready])

  function canStart() {
    return !controller.current && attempt?.phase !== 'already_running'
  }

  async function send(submission: Submission) {
    if (!canStart()) return
    const signal = new AbortController()
    controller.current = signal
    operation.current++
    pending.current = submission
    writeOutbox(outboxKey, submission)
    setAttempt({ submission, text: '', phase: 'connecting' })
    let accepted = false
    let finished = false
    let failure: { message: string; retryable: boolean } | undefined
    const markAccepted = () => {
      if (!accepted) {
        accepted = true
        onAccepted(submission)
      }
    }

    try {
      await api.send(chatId, submission, (event) => {
        if (finished) return
        switch (event.event) {
          case 'status':
            markAccepted()
            setAttempt((current) => current && { ...current, phase: event.data.phase })
            if (event.data.phase === 'already_running') finished = true
            break
          case 'delta':
            markAccepted()
            setAttempt((current) => current && { ...current, phase: 'generating', text: current.text + event.data.text })
            break
          case 'done':
            markAccepted()
            finished = true
            controller.current = null
            setMessages((current) => mergeMessages(current, [event.data.user, event.data.assistant]))
            pending.current = null
            writeOutbox(outboxKey, null)
            setAttempt(null)
            onCompleted()
            break
          case 'error':
            failure = event.data
            finished = true
            break
        }
      }, signal.signal)
      if (!finished) failure = { message: 'Поток ответа прервался.', retryable: true }
    } catch (error) {
      failure = {
        message: signal.signal.aborted ? 'Получение ответа остановлено.' : errorText(error),
        retryable: !(error instanceof ApiError) || error.data.retryable || error.status >= 500,
      }
    } finally {
      if (failure) {
        const { message, retryable } = failure
        try {
          reconcile(await refresh(), submission, message, retryable)
        } catch {
          setAttempt((current) => current && { ...current, phase: 'failed', error: message, retryable })
        }
      }
      if (controller.current === signal) controller.current = null
    }
  }

  function dismissAttempt() {
    if (controller.current || attempt?.phase !== 'failed') return
    pending.current = null
    writeOutbox(outboxKey, null)
    setAttempt(null)
  }

  return {
    messages, cursor, ready, loading, historyError, attempt, loadOlder, loadHistory, send, canStart, dismissAttempt,
    stop: () => controller.current?.abort(),
  }
}

export type Mode = 'listen' | 'analyze'

export interface Model {
  id: string
  label: string
}

export interface Chat {
  id: string
  model_id: string
  title: string
  mode: Mode
  created_at: string
  updated_at: string
}

export interface ChatList {
  active_chat_id: string | null
  chats: Chat[]
}

export interface Submission {
  text: string
  request_id: string
  mode: Mode
  audio_id?: string
}

export interface Message {
  id: string
  chat_id: string
  seq: number
  role: 'user' | 'assistant'
  text: string
  status: 'complete' | 'streaming' | 'interrupted'
  created_at: string
  request_id: string | null
  mode: Mode | null
  model_id: string | null
  audio_id?: string | null
}

export interface MessagePage {
  messages: Message[]
  next_before_seq: number | null
}

export interface Budget {
  limit_usd: string | null
  spent_usd: string
  reserved_usd: string
  available_usd: string | null
}

export interface ChatCosts {
  total_usd: string
  replies_usd: string
  compression_usd: string
  reserved_usd: string
  last_reply: { message_id: string; cost_usd: string | null; pending: boolean } | null
}

export interface ApiErrorData {
  code: string
  message: string
  retryable: boolean
}

export interface AudioJob {
  job_id: string
  chat_id: string
  audio_id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  transcript: string | null
  error: ApiErrorData | null
  created_at: string
}

export interface Source {
  message_id: string
  seq: number
  excerpt: string
  historical: boolean
}

export interface MemoryNote {
  id: string
  text: string
  kind: 'event' | 'preference' | 'open_topic' | 'assumption' | 'correction'
  status: 'current' | 'superseded'
  origin: 'user' | 'assistant'
  observed_at: string
  sources: Source[]
}

export interface Memory {
  chat_id: string
  summary: { text: string; version: number; covered_through_seq: number }
  notes: MemoryNote[]
  last_answer: {
    message_id: string
    summary_version: number
    covered_through_seq: number
    tail_seqs: number[]
    retrieved: Source[]
  } | null
}

export type StreamPhase = 'preparing_context' | 'processing_long_message' | 'generating' | 'already_running'

export type StreamEvent =
  | { event: 'status'; data: { phase: StreamPhase; request_id: string } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'done'; data: { user: Message; assistant: Message } }
  | { event: 'error'; data: ApiErrorData }

export interface ChatApi {
  health(): Promise<{ status: 'ok'; demo: boolean }>
  budget(): Promise<Budget>
  setBudget(limitUsd: string): Promise<Budget>
  costs(chatId: string): Promise<ChatCosts>
  models(): Promise<{ models: Model[] }>
  chats(): Promise<ChatList>
  create(modelId: string, title?: string): Promise<Chat>
  activate(chatId: string): Promise<Chat>
  messages(chatId: string, before?: number, limit?: number): Promise<MessagePage>
  send(chatId: string, submission: Submission, onEvent: (event: StreamEvent) => void, signal?: AbortSignal): Promise<void>
  audio(chatId: string): Promise<{ jobs: AudioJob[] }>
  upload(chatId: string, file: File): Promise<AudioJob>
  job(jobId: string): Promise<AudioJob>
  retryAudio(jobId: string): Promise<AudioJob>
  discardAudio(chatId: string, audioId: string): Promise<void>
  memory(chatId: string): Promise<Memory>
}

export class ApiError extends Error {
  constructor(public status: number, public data: ApiErrorData) {
    super(data.message)
  }
}

export function errorText(error: unknown) {
  if (error instanceof ApiError) return error.data.message
  if (error instanceof TypeError) return 'Не удалось связаться с сервером.'
  return error instanceof Error ? error.message : 'Что-то пошло не так.'
}

async function checked(response: Response) {
  if (response.ok) return response
  const body = await response.json().catch(() => null)
  const data = body?.detail ?? body
  throw new ApiError(response.status, typeof data?.message === 'string' ? data : {
    code: 'http_error',
    message: response.status === 413 ? 'Файл больше 25 МиБ.' : `Сервер вернул ошибку (${response.status}).`,
    retryable: response.status >= 500,
  })
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await checked(await fetch(`/api${path}`, init))
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

const post = (value?: object): RequestInit => ({
  method: 'POST',
  ...(value && { body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } }),
})

const chatPath = (id: string) => `/chats/${encodeURIComponent(id)}`
const jobPath = (id: string) => `/jobs/${encodeURIComponent(id)}`

export async function readSse(body: ReadableStream<Uint8Array>, onEvent: (event: StreamEvent) => void) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = ''
  let dataLines: string[] = []

  function acceptLine(line: string) {
    if (!line) {
      if (dataLines.length && ['status', 'delta', 'done', 'error'].includes(eventName)) {
        onEvent({ event: eventName, data: JSON.parse(dataLines.join('\n')) } as StreamEvent)
      }
      eventName = ''
      dataLines = []
      return
    }
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    const value = colon < 0 ? '' : line.slice(colon + (line[colon + 1] === ' ' ? 2 : 1))
    if (field === 'event') eventName = value
    if (field === 'data') dataLines.push(value)
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let start = 0
      while (start < buffer.length) {
        const end = buffer.slice(start).search(/[\r\n]/)
        if (end < 0) break
        const index = start + end
        if (buffer[index] === '\r' && index === buffer.length - 1) break
        acceptLine(buffer.slice(start, index))
        start = index + (buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1)
      }
      buffer = buffer.slice(start)
    }
    buffer += decoder.decode()
    if (buffer.endsWith('\r')) acceptLine(buffer.slice(0, -1))
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

const realApi: ChatApi = {
  health: () => json('/health'),
  budget: () => json('/settings/budget'),
  setBudget: (limit_usd) => json('/settings/budget', { ...post({ limit_usd }), method: 'PUT' }),
  costs: (id) => json(`${chatPath(id)}/costs`),
  models: () => json('/models'),
  chats: () => json('/chats'),
  create: (model_id, title) => json('/chats', post({ model_id, title })),
  activate: (id) => json(`${chatPath(id)}/activate`, post()),
  messages: (id, before, limit = 35) => {
    const query = new URLSearchParams({ limit: String(limit) })
    if (before !== undefined) query.set('before_seq', String(before))
    return json(`${chatPath(id)}/messages?${query}`)
  },
  async send(id, submission, onEvent, signal) {
    const request = post(submission)
    const response = await checked(await fetch(`/api${chatPath(id)}/messages`, {
      ...request,
      headers: { ...request.headers, Accept: 'text/event-stream' },
      signal,
    }))
    if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) {
      throw new Error('Сервер не вернул поток ответа.')
    }
    await readSse(response.body, onEvent)
  },
  audio: (id) => json(`${chatPath(id)}/audio`),
  upload: (id, file) => {
    const body = new FormData()
    body.append('file', file, file.name)
    return json(`${chatPath(id)}/audio`, { method: 'POST', body })
  },
  job: (id) => json(jobPath(id)),
  retryAudio: (id) => json(`${jobPath(id)}/retry`, post()),
  discardAudio: (id, audioId) => json(`${chatPath(id)}/audio/${encodeURIComponent(audioId)}`, { method: 'DELETE' }),
  memory: (id) => json(`${chatPath(id)}/memory`),
}

export async function getApi(): Promise<ChatApi> {
  if (import.meta.env.DEV && import.meta.env.VITE_USE_MOCK_API === '1') {
    return (await import('./mock')).mockApi
  }
  return realApi
}

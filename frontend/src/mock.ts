import { ApiError, readSse, type AudioJob, type Chat, type ChatApi, type MemoryNote, type Message, type Source, type StreamEvent, type Submission } from './api'

const firstChat = 'demo-meeting'
const models = [
  { id: 'demo/claude', label: 'Claude' },
  { id: 'demo/deepseek', label: 'DeepSeek' },
]
const now = () => new Date().toISOString()
const fail = (status: number, code: string, message: string, retryable = false) => new ApiError(status, { code, message, retryable })
const key = 'psyholuh-mock-v1'
type MockJob = AudioJob & { ready: number; shouldFail: boolean; attempts: number }
type Store = { active: string; chats: Chat[]; messages: Message[]; jobs: MockJob[]; submissions: Record<string, Submission> }
const date = '2026-11-18T15:00:00Z'
function firstMessage(seq: number, role: Message['role'], text: string): Message {
  return { id: `demo-message-${seq}`, chat_id: firstChat, seq, role, text, status: 'complete', created_at: date,
    request_id: null, mode: 'listen', model_id: role === 'assistant' ? models[0].id : null }
}
const initial: Store = {
  active: firstChat,
  chats: [{ id: firstChat, model_id: models[0].id, title: 'Встреча в пятницу', mode: 'listen', created_at: date, updated_at: date }],
  messages: [
    firstMessage(1, 'user', 'Встреча с Лерой в среду. Я немного волнуюсь, что разговор снова уйдёт в работу.'),
    firstMessage(2, 'assistant', 'Похоже, тебе важно просто побыть с Лерой и поговорить о том, что происходит в жизни.'),
    firstMessage(3, 'user', 'Перенесли встречу с Лерой на пятницу. В этот раз хочу предложить прогулку.'),
    firstMessage(4, 'assistant', 'Пятница и прогулка. Как тебе сама мысль встретиться именно так?'),
  ],
  jobs: [],
  submissions: {},
}
let store: Store
try { store = JSON.parse(localStorage.getItem(key) ?? 'null') ?? structuredClone(initial) }
catch { store = structuredClone(initial) }

function save() {
  try { localStorage.setItem(key, JSON.stringify(store)) } catch { /* in-memory fallback */ }
}

function lookupChat(id: string) {
  const chat = store.chats.find((item) => item.id === id)
  if (!chat) throw fail(404, 'chat_not_found', 'Беседа не найдена.')
  return chat
}

function activeChat(id: string) {
  const chat = lookupChat(id)
  if (store.active !== id) throw fail(409, 'chat_not_active', 'Сначала откройте беседу.')
  return chat
}

function jobLookup(id: string) {
  const job = store.jobs.find((item) => item.job_id === id)
  if (!job) throw fail(404, 'job_not_found', 'Запись не найдена.')
  return job
}

function updateJob(job: MockJob) {
  if (job.status === 'queued' && Date.now() >= job.ready - 1400) job.status = 'running'
  if (job.status === 'running' && Date.now() >= job.ready) {
    if (job.shouldFail && job.attempts === 1) {
      job.status = 'failed'
      job.error = { code: 'transcription_failed', message: 'Не удалось разобрать запись.', retryable: true }
    } else {
      job.status = 'succeeded'
      job.transcript = 'Хочу вернуться к разговору о встрече в пятницу.'
    }
    save()
  }
  return { ...job }
}

const running = new Set<string>()
for (const message of store.messages) {
  if (message.status === 'streaming') message.status = 'interrupted'
}
save()

async function emitDemo(events: StreamEvent[], callback: (event: StreamEvent) => void, signal?: AbortSignal) {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const item of events) {
          await new Promise((resolve) => setTimeout(resolve, item.event === 'delta' ? 72 : 25))
          signal?.throwIfAborted()
          const bytes = encoder.encode(`event: ${item.event}\r\ndata: ${JSON.stringify(item.data)}\r\n\r\n`)
          controller.enqueue(bytes.slice(0, 19))
          controller.enqueue(bytes.slice(19))
        }
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })
  await readSse(body, callback)
}

export const mockApi: ChatApi = {
  async health() { return { status: 'ok', demo: true } },
  async models() { return { models } },
  async chats() {
    return { active_chat_id: store.active, chats: [...store.chats].sort((a, b) => b.updated_at.localeCompare(a.updated_at)) }
  },
  async create(model_id, title = 'Новая беседа') {
    const timestamp = now()
    const chat: Chat = { id: crypto.randomUUID(), model_id, title, mode: 'listen', created_at: timestamp, updated_at: timestamp }
    store.active = chat.id
    store.chats.push(chat)
    save()
    return { ...chat }
  },
  async activate(id) {
    const chat = lookupChat(id)
    store.active = id
    save()
    return { ...chat }
  },
  async messages(id, before = Infinity, limit = 35) {
    lookupChat(id)
    const eligible = store.messages.filter((message) => message.chat_id === id && message.seq < before)
    const messages = eligible.slice(-limit).map((item) => ({ ...item }))
    return { messages, next_before_seq: eligible.length > limit ? messages[0].seq : null }
  },
  async send(id, submission, callback, signal) {
    const { text, request_id, mode, audio_id } = submission
    const requestKey = `${id}/${request_id}`
    const previous = store.submissions[requestKey]
    const existing = store.messages.filter((item) => item.chat_id === id && item.request_id === request_id)
    if (previous && (previous.text !== text || previous.mode !== mode || previous.audio_id !== audio_id)) {
      throw fail(409, 'request_conflict', 'Этот запрос уже был отправлен с другим текстом.')
    }
    let [user, assistant] = existing
    if (assistant?.status === 'complete') {
      await emitDemo([{ event: 'done', data: { user: { ...user }, assistant: { ...assistant } } }], callback, signal)
      return
    }
    if (running.has(requestKey)) {
      await emitDemo([{ event: 'status', data: { phase: 'already_running', request_id } }], callback, signal)
      return
    }
    const chat = activeChat(id)
    if (store.messages.some((item) => item.chat_id === id && item.status === 'streaming')) {
      throw fail(409, 'chat_busy', 'Дождитесь текущего ответа.', true)
    }
    if (!user) {
      if (audio_id) {
        const draft = store.jobs.find((job) => job.audio_id === audio_id && job.chat_id === id && job.status === 'succeeded')
        if (!draft) throw fail(409, 'draft_unavailable', 'Черновик записи недоступен.')
        store.jobs = store.jobs.filter((job) => job.audio_id !== audio_id)
      }
      const seq = (store.messages.filter((item) => item.chat_id === id).at(-1)?.seq ?? 0) + 1
      user = { id: crypto.randomUUID(), chat_id: id, seq, text, created_at: now(), role: 'user', status: 'complete', model_id: null, request_id, mode, audio_id }
      assistant = { ...user, id: crypto.randomUUID(), seq: seq + 1, text: '', role: 'assistant', status: 'streaming', model_id: chat.model_id, audio_id: null }
      store.submissions[requestKey] = submission
      store.messages.push(user, assistant)
    }
    chat.mode = mode
    chat.updated_at = now()
    assistant.text = ''
    assistant.status = 'streaming'
    running.add(requestKey)
    save()

    const lastUser = store.messages.filter((item) => item.chat_id === id && item.role === 'user' && item.seq < user.seq && /пятниц/i.test(item.text)).at(-1)
    const reply = lastUser
      ? 'Встречу перенесли на пятницу. Ты также писала, что хочешь предложить прогулку.'
      : mode === 'analyze'
        ? 'Давай начнём с одного момента. Какая часть ситуации сейчас больше всего занимает твои мысли?'
        : 'Я рядом. Если хочется, можно рассказать об этом подробнее в своём темпе.'
    const events: StreamEvent[] = [
      { event: 'status', data: { phase: text.length > 2000 ? 'processing_long_message' : 'preparing_context', request_id } },
      { event: 'status', data: { phase: 'generating', request_id } },
      ...(reply.match(/.{1,8}/gu) ?? []).map((text): StreamEvent => ({ event: 'delta', data: { text } })),
      { event: 'done', data: { user: { ...user }, assistant: { ...assistant, text: reply, status: 'complete' } } },
    ]
    try {
      await emitDemo(events, (event) => {
        if (event.event === 'delta') assistant.text += event.data.text
        if (event.event === 'done') assistant.status = 'complete'
        save()
        callback(event)
      }, signal)
    } finally {
      running.delete(requestKey)
      if (assistant.status === 'streaming') assistant.status = 'interrupted'
      save()
    }
  },
  async audio(id) { return { jobs: store.jobs.filter((job) => job.chat_id === id).map(updateJob) } },
  async upload(id, file) {
    activeChat(id)
    if (file.size > 25 * 1024 * 1024) throw fail(413, 'file_too_large', 'Файл больше 25 МиБ.')
    const job: MockJob = {
      job_id: crypto.randomUUID(), audio_id: crypto.randomUUID(), chat_id: id, status: 'queued', transcript: null,
      error: null, created_at: now(), ready: Date.now() + 2800, shouldFail: /fail/i.test(file.name), attempts: 1,
    }
    store.jobs.unshift(job)
    save()
    return { ...job }
  },
  async job(id) { return updateJob(jobLookup(id)) },
  async retryAudio(id) {
    const job = jobLookup(id)
    if (job.status !== 'failed' || !job.error?.retryable) throw fail(409, 'job_unavailable', 'Повторить обработку пока нельзя.')
    Object.assign(job, { status: 'queued', ready: Date.now() + 2500, attempts: job.attempts + 1, error: null })
    save()
    return { ...job }
  },
  async discardAudio(id, audioId) {
    store.jobs = store.jobs.filter((job) => job.chat_id !== id || job.audio_id !== audioId)
    save()
  },
  async memory(id) {
    const messages = store.messages.filter((item) => item.chat_id === id && item.status === 'complete')
    const answer = messages.findLast((item) => item.role === 'assistant')
    const source = (seq: number, historical = false): Source => {
      const message = messages.find((item) => item.seq === seq)!
      return { message_id: message.id, seq, excerpt: message.text, historical }
    }
    const seeded = id === firstChat
    const notes: MemoryNote[] = seeded ? [
      { id: 'friday', text: 'Встречу с Лерой перенесли на пятницу.', kind: 'correction', origin: 'user', status: 'current', observed_at: date, sources: [source(3)] },
      { id: 'wednesday', text: 'Встреча с Лерой была запланирована на среду.', kind: 'event', origin: 'user', status: 'superseded', observed_at: date, sources: [source(1, true)] },
    ] : []
    return {
      chat_id: id, notes,
      summary: { text: seeded ? 'Пользователь хочет провести встречу с Лерой за прогулкой. Встреча перенесена со среды на пятницу.' : '',
        version: seeded ? 1 : 0, covered_through_seq: seeded ? 4 : 0 },
      last_answer: answer ? {
        message_id: answer.id, summary_version: seeded && answer.seq > 4 ? 1 : 0,
        covered_through_seq: seeded && answer.seq > 4 ? 4 : 0,
        tail_seqs: messages.filter((item) => item.seq > (seeded && answer.seq > 4 ? 4 : 0) && item.seq < answer.seq - 1).map((item) => item.seq),
        retrieved: seeded && answer.seq > 4 ? [source(3), source(1, true)] : [],
      } : null,
    }
  },
}

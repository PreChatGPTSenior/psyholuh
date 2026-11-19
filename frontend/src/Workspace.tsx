import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowUp, BookOpen, ChevronUp, Ear, LoaderCircle, Menu, MessageCircle, Mic, Paperclip,
  RotateCcw, Sparkles, Square, Trash2,
} from 'lucide-react'
import Markdown from 'react-markdown'
import { Brand, EmptyState, Notice } from './components'
import { MemoryPanel } from './Memory'
import { errorText, type AudioJob, type Chat, type ChatApi, type Message, type Mode, type Source, type Submission } from './api'
import { useAudio } from './audio'
import { reconstructSubmission, useTimeline } from './timeline'

type Props = {
  api: ChatApi
  chat: Chat
  visible: boolean
  moving: boolean
  modelLabel: string
  demo: boolean
  scope: string
  onMenu: () => void
  onRecording: (recording: boolean) => void
  onAccepted: (submission: Submission) => void
}
const phases = {
  connecting: 'Отправляем сообщение…',
  preparing_context: 'Собираем контекст…',
  processing_long_message: 'Обрабатываем длинное сообщение…',
  generating: 'Готовим ответ…',
  already_running: 'Ответ готовится. Проверяем его состояние…',
  failed: 'Ответ прервался.',
} as const
const showTimestamp = (date: string) => new Date(date).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

function MessageBody({ children }: { children: string }) {
  return <div className="message-prose"><Markdown components={{
    img: () => null,
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  }}>{children}</Markdown></div>
}

function Turn({ id, speaker, role, timestamp, children }: {
  id?: string
  speaker: string
  role: Message['role']
  timestamp?: string
  children: React.ReactNode
}) {
  return <article id={id} className={`turn turn-${role}`} tabIndex={id ? -1 : undefined}>
    {role === 'assistant' && <Brand size={18} />}
    <div className="turn-content">
      <div className="turn-heading"><strong>{speaker}</strong>{timestamp && <time dateTime={timestamp}>{showTimestamp(timestamp)}</time>}</div>
      <div className="turn-body">{children}</div>
    </div>
  </article>
}

export function Workspace({ api, chat, visible, moving, modelLabel, demo, scope, onMenu, onRecording, onAccepted }: Props) {
  const [mode, setMode] = useState<Mode>(chat.mode)
  const [text, setText] = useState('')
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const [localError, setLocalError] = useState('')
  const [highlight, setHighlight] = useState('')
  const [resolving, setResolving] = useState(false)
  const scroll = useRef<HTMLDivElement>(null)
  const audioPicker = useRef<HTMLInputElement>(null)
  const follow = useRef(true)
  const preservePosition = useRef<{ height: number; top: number } | null>(null)

  const audio = useAudio(api, chat.id, scope, visible, onRecording)
  const timeline = useTimeline(api, chat.id, scope, visible, (submission) => {
    if (submission.audio_id) audio.consumed(submission.audio_id)
    onAccepted(submission)
  }, () => setRevision((count) => count + 1))
  const current = timeline.attempt
  const busy = !!current && current.phase !== 'failed'
  const unresolved = !!current || timeline.messages.some((message) => message.status === 'streaming')
  const canSubmit = timeline.ready && !unresolved && !moving && !audio.recording
  const canRecord = !moving && !audio.busy && !audio.pendingRecording
  const canRetryHistory = !unresolved && !moving && !resolving
  const requestUser = timeline.messages.find((message) => message.role === 'user' && current && message.request_id === current.submission.request_id)
  const requestReply = timeline.messages.find((message) => message.role === 'assistant' && current && message.request_id === current.submission.request_id)

  useEffect(() => {
    if (visible) setMode(chat.mode)
  }, [chat.mode, visible])

  useLayoutEffect(() => {
    const element = scroll.current
    if (!element || !visible) return
    if (preservePosition.current) {
      element.scrollTop = preservePosition.current.top + element.scrollHeight - preservePosition.current.height
      preservePosition.current = null
    } else if (follow.current) {
      element.scrollTop = element.scrollHeight
    }
  }, [timeline.messages, current, visible, memoryOpen])

  useEffect(() => {
    if (!highlight) return
    const timer = window.setTimeout(() => setHighlight(''), 2100)
    return () => window.clearTimeout(timer)
  }, [highlight])

  function jump(source: Source) {
    const element = document.getElementById(`turn-${source.message_id}`)
    if (!element || !scroll.current?.contains(element)) return false
    if (window.matchMedia('(max-width: 1120px)').matches) setMemoryOpen(false)
    follow.current = false
    setHighlight(source.message_id)
    element.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    element.focus({ preventScroll: true })
    return true
  }

  function submit(value: string, audioId?: string) {
    if (!value.trim() || !canSubmit || !timeline.canStart()) return
    follow.current = true
    if (!audioId) setText('')
    setLocalError('')
    void timeline.send({ text: value, mode, request_id: crypto.randomUUID(), ...(audioId && { audio_id: audioId }) })
  }

  async function retryPrevious(message: Message) {
    if (!canRetryHistory) return
    setResolving(true)
    setLocalError('')
    try {
      let submission = reconstructSubmission(message, timeline.messages)
      if (!submission) {
        const { messages } = await api.messages(chat.id, message.seq, 1)
        submission = reconstructSubmission(message, messages)
      }
      if (!submission) throw new Error('Не найдена исходная реплика. Обновите историю и попробуйте снова.')
      follow.current = true
      await timeline.send(submission)
    } catch (failure) { setLocalError(errorText(failure)) }
    finally { setResolving(false) }
  }

  function older() {
    if (!scroll.current) return
    preservePosition.current = { height: scroll.current.scrollHeight, top: scroll.current.scrollTop }
    void timeline.loadOlder().then((loaded) => { if (!loaded) preservePosition.current = null })
  }

  function renderAttempt(attempt: NonNullable<typeof current>, reply?: Message) {
    return <Turn key={reply?.id ?? 'pending-assistant'} id={reply && `turn-${reply.id}`} role="assistant" speaker={modelLabel} timestamp={reply?.created_at}>
      {attempt.text && <MessageBody>{attempt.text}</MessageBody>}
      {attempt.phase === 'failed' ? <div className="attempt-error">
        <p role="alert">{attempt.error || phases.failed}</p>
        <div className="turn-actions">
          {attempt.retryable && <button type="button" className="text-button" disabled={moving}
            onClick={() => { follow.current = true; void timeline.send(attempt.submission) }}><RotateCcw size={15} /> Повторить ответ</button>}
          {(requestUser || requestReply) ? <button type="button" className="text-button" onClick={timeline.dismissAttempt}>Закрыть сообщение</button>
            : <button type="button" className="text-button" onClick={() => {
              if (!attempt.submission.audio_id) setText(attempt.submission.text)
              timeline.dismissAttempt()
            }}>Вернуться к черновику</button>}
        </div>
      </div> : <div className="reply-status" role="status">
        {!attempt.text && <LoaderCircle className="spinner" size={17} />}
        <span>{attempt.text && attempt.phase === 'generating' ? 'Ответ продолжается…' : phases[attempt.phase]}</span>
      </div>}
    </Turn>
  }

  function renderMessage(message: Message) {
    if (current && requestReply?.id === message.id) return renderAttempt(current, message)
    return <div key={message.id} className={highlight === message.id ? 'highlight-turn' : undefined}>
      <Turn id={`turn-${message.id}`} speaker={message.role === 'user' ? 'Вы' : modelLabel} role={message.role} timestamp={message.created_at}>
        {message.text && (message.role === 'assistant' ? <MessageBody>{message.text}</MessageBody> : <p className="user-text">{message.text}</p>)}
        {message.status === 'interrupted' && <div className="attempt-error">
          <p>Ответ прервался.</p>
          {message.request_id && <button className="text-button" type="button" disabled={!canRetryHistory} onClick={() => void retryPrevious(message)}>
            <RotateCcw size={15} /> Повторить ответ
          </button>}
        </div>}
        {message.status === 'streaming' && <div className="reply-status" role="status"><LoaderCircle className="spinner" size={17} /> Ответ готовится…</div>}
      </Turn>
    </div>
  }

  function audioCard(job: AudioJob) {
    const transcript = audio.edits[job.audio_id] ?? job.transcript ?? ''
    const processing = job.status === 'queued' || job.status === 'running'
    const lockedToAttempt = current?.submission.audio_id === job.audio_id
    return <section className="audio-card" key={job.audio_id} aria-label="Голосовой черновик">
      <div className="audio-card-heading">
        <span className="audio-icon">{processing ? <LoaderCircle className="spinner" size={17} /> : <Mic size={17} />}</span>
        <div><strong role="status">{job.status === 'succeeded' ? 'Голосовой черновик'
          : job.status === 'queued' ? 'Запись в очереди'
          : job.status === 'running' ? 'Расшифровываем запись…' : 'Ошибка расшифровки'}</strong>
          <small>{showTimestamp(job.created_at)}</small>
        </div>
        <button className="icon-button discard-control" title="Удалить запись" aria-label="Удалить запись" type="button" disabled={audio.busy || lockedToAttempt}
          onClick={() => void audio.discard(job)}><Trash2 size={17} /></button>
      </div>
      {job.status === 'failed' && <div className="audio-details">
        <p role="alert">{job.error?.message ?? 'Не удалось расшифровать запись.'}</p>
        {job.error?.retryable && <button type="button" className="text-button" disabled={audio.busy} onClick={() => void audio.retry(job)}><RotateCcw size={15} /> Повторить расшифровку</button>}
      </div>}
      {job.status === 'succeeded' && <div className="audio-details">
        <textarea className="form-input draft-text" rows={3} aria-label="Текст голосового черновика"
          value={transcript} disabled={lockedToAttempt} onChange={(event) => audio.edit(job.audio_id, event.target.value)} />
        <div className="draft-actions"><button type="button" className="primary-button" disabled={!transcript.trim() || !canSubmit || audio.busy}
          onClick={() => submit(transcript, job.audio_id)}>Отправить черновик <ArrowUp size={16} /></button></div>
      </div>}
    </section>
  }

  const hasTurns = timeline.messages.length > 0 || !!current
  return <section className="workspace" hidden={!visible} aria-label={chat.title}>
    <header className="topbar">
      <button className="icon-button menu-toggle" aria-label="Открыть список бесед" type="button" onClick={onMenu}><Menu size={22} /></button>
      <div className="topbar-chat">
        <span className="topbar-icon"><MessageCircle size={20} strokeWidth={1.7} /></span>
        <div><h2>{chat.title}</h2><p title={chat.model_id}>{modelLabel}</p></div>
      </div>
      <div className="topbar-actions">
        {demo && <span className="demo-tag" title="Вымышленные данные">ДЕМО</span>}
        <button className="secondary-button memory-toggle" type="button" aria-expanded={memoryOpen}
          onClick={() => setMemoryOpen(!memoryOpen)}><BookOpen size={17} /> <span>Память</span></button>
      </div>
    </header>
    <div className="workspace-columns">
      <div className="conversation">
        <div className="conversation-scroll" ref={scroll} onScroll={(event) => {
          const element = event.currentTarget
          follow.current = element.scrollHeight - element.clientHeight - element.scrollTop < 100
        }}>
          <div className="turns">
            {timeline.historyError && <Notice action={timeline.loadHistory}>{timeline.historyError}</Notice>}
            {timeline.ready && timeline.cursor !== null && <div className="older-messages">
              <button type="button" className="text-button" disabled={timeline.loading} onClick={older}><ChevronUp size={16} />
                {timeline.loading ? 'Загружаем…' : 'Показать более ранние реплики'}</button>
            </div>}
            {localError && <Notice>{localError}</Notice>}
            {!hasTurns && (timeline.ready ?
              <EmptyState title="Расскажите, что у вас на уме" text="Здесь можно выговориться, подумать вслух или разобраться в том, что беспокоит." />
              : timeline.loading && <p className="timeline-loading muted" role="status"><LoaderCircle className="spinner" size={17} /> Загружаем переписку…</p>)}
            {timeline.messages.map(renderMessage)}
            {current && !requestUser && <Turn role="user" speaker="Вы"><p className="user-text">{current.submission.text}</p></Turn>}
            {current && !requestReply && renderAttempt(current)}
          </div>
        </div>
        <div className="composer-region">
          <div className="composer-width">
            {(audio.error || audio.pendingRecording || audio.jobs.length > 0) && <div className="audio-jobs">
              {audio.error && <Notice action={audio.pendingRecording ? undefined : audio.refresh}>{audio.error}</Notice>}
              {audio.pendingRecording && <section className="audio-card" aria-label="Запись перед загрузкой">
                <div className="audio-details">
                  <strong>Запись в браузере</strong>
                  <div className="draft-actions">
                    {audio.recordingUrl && <a className="text-button" href={audio.recordingUrl} download={audio.pendingRecording.name}>Скачать запись</a>}
                    <button type="button" className="text-button" disabled={audio.busy} onClick={audio.discardRecording}>Удалить</button>
                    {!audio.busy && <button type="button" className="secondary-button" onClick={() => {
                      if (audio.pendingRecording) void audio.upload(audio.pendingRecording)
                    }}>Повторить загрузку</button>}
                  </div>
                </div>
              </section>}
              {audio.jobs.map(audioCard)}
            </div>}
            <form className="composer" onSubmit={(event) => { event.preventDefault(); submit(text) }}>
              <label className="sr-only" htmlFor={`compose-${chat.id}`}>Сообщение</label>
              <textarea id={`compose-${chat.id}`} value={text} placeholder="Напишите, что хочется сказать…" rows={2}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    submit(text)
                  }
                }} />
              <div className="composer-toolbar">
                <fieldset className="mode-picker" aria-label="Режим ответа">
                  <label className={mode === 'listen' ? 'mode-selected' : ''}>
                    <input type="radio" name={`mode-${chat.id}`} checked={mode === 'listen'} onChange={() => setMode('listen')} />
                    <Ear size={16} /><span>Выслушай</span>
                  </label>
                  <label className={mode === 'analyze' ? 'mode-selected' : ''}>
                    <input type="radio" name={`mode-${chat.id}`} checked={mode === 'analyze'} onChange={() => setMode('analyze')} />
                    <Sparkles size={16} /><span>Помоги разобрать</span>
                  </label>
                </fieldset>
                <div className="composer-actions">
                  <input type="file" hidden ref={audioPicker} accept=".wav,.mp3,.m4a,.mp4,.ogg,.webm,audio/wav,audio/mpeg,audio/mp4,audio/ogg,audio/webm"
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      if (file) void audio.upload(file)
                      event.target.value = ''
                    }} />
                  <button type="button" className="icon-button" title="Загрузить аудио" aria-label="Загрузить аудио" disabled={!canRecord || audio.recording}
                    onClick={() => audioPicker.current?.click()}><Paperclip size={19} /></button>
                  <button type="button" className={`icon-button${audio.recording ? ' recording-button' : ''}`}
                    title={audio.recording ? 'Завершить запись' : 'Записать голос'}
                    aria-label={audio.recording ? 'Завершить запись' : 'Записать голос'} disabled={!canRecord}
                    onClick={() => audio.recording ? audio.stop() : void audio.start()}>
                    {audio.recording ? <Square size={15} fill="currentColor" /> : <Mic size={19} />}
                  </button>
                  {busy && current.phase !== 'already_running'
                    ? <button type="button" className="send-button" title="Остановить получение ответа" aria-label="Остановить получение ответа" onClick={timeline.stop}><Square size={15} fill="currentColor" /></button>
                    : <button type="submit" className="send-button" title="Отправить" aria-label="Отправить" disabled={!text.trim() || !canSubmit}><ArrowUp size={21} /></button>}
                </div>
              </div>
            </form>
            <p className="composer-hint">{audio.recording ? 'Идёт запись. Завершите её перед сменой беседы.'
              : audio.busy ? 'Работаем с аудио…' : 'Enter — отправить · Shift + Enter — новая строка'}</p>
          </div>
        </div>
      </div>
      {memoryOpen && visible && <>
        <button className="drawer-scrim memory-scrim" aria-label="Закрыть память" onClick={() => setMemoryOpen(false)} />
        <MemoryPanel api={api} chatId={chat.id} revision={revision} jump={jump} close={() => setMemoryOpen(false)} />
      </>}
    </div>
  </section>
}

import { useEffect, useState } from 'react'
import { BookOpen, ChevronRight, X } from 'lucide-react'
import { errorText, type ChatApi, type Memory as MemoryData, type Message, type Source } from './api'
import { Dialog, Notice } from './components'

const noteKind = { event: 'Событие', preference: 'Предпочтение', open_topic: 'Открытая тема', assumption: 'Предположение', correction: 'Уточнение' }

export function MemoryPanel({ api, chatId, revision, close, jump }: {
  api: ChatApi
  chatId: string
  revision: number
  close: () => void
  jump: (source: Source) => boolean
}) {
  const [memory, setMemory] = useState<MemoryData | null>(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [source, setSource] = useState<Source | null>(null)

  useEffect(() => {
    let current = true
    setLoading(true)
    setError('')
    void api.memory(chatId).then((data) => { if (current) setMemory(data) })
      .catch((failure) => { if (current) setError(errorText(failure)) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [api, chatId, revision, refresh])

  function open(item: Source) {
    if (!jump(item)) setSource(item)
  }

  function sources(items: Source[]) {
    return <div className="source-list">{items.map((item) =>
      <button key={item.message_id} type="button" className="source-link" onClick={() => open(item)}>
        <span><strong>Реплика №{item.seq}{item.historical ? ' · прежняя версия' : ''}</strong>
          <span>{item.excerpt}</span></span><ChevronRight size={16} />
      </button>)}</div>
  }

  return <aside className="memory-panel" aria-label="Память беседы">
    <header className="memory-header">
      <div><BookOpen size={19} /><h2>Память</h2></div>
      <button type="button" className="icon-button" onClick={close} aria-label="Закрыть память"><X size={19} /></button>
    </header>
    <div className="memory-content">
      {loading && !memory && <p className="muted" role="status">Загружаем память…</p>}
      {error && <Notice action={() => setRefresh((count) => count + 1)}>{error}</Notice>}
      {memory && <>
        <section className="memory-section">
          <h3>Сводка</h3>
          {memory.summary.text ? <>
            <div className="summary-card">{memory.summary.text}</div>
            <p className="memory-meta">Версия {memory.summary.version} · до реплики №{memory.summary.covered_through_seq}</p>
          </> : <p className="muted">Сводка появится по мере продолжения беседы.</p>}
        </section>
        <section className="memory-section">
          <h3>Заметки</h3>
          {memory.notes.length ? memory.notes.map((note) => <article className="note-card" key={note.id}>
            <p className="memory-meta">{noteKind[note.kind]} · {note.origin === 'user' ? 'От вас' : 'От модели'}{note.status === 'superseded' ? ' · заменено' : ''}</p>
            <p>{note.text}</p>
            {note.sources.length > 0 && sources(note.sources)}
          </article>) : <p className="muted">Сохранённых заметок пока нет.</p>}
        </section>
        <section className="memory-section">
          <h3>Контекст последнего ответа</h3>
          {memory.last_answer ? <>
            <p className="memory-meta">{memory.last_answer.summary_version
              ? `Сводка №${memory.last_answer.summary_version} · до реплики №${memory.last_answer.covered_through_seq}`
              : 'Без сводки'}</p>
            {memory.last_answer.tail_seqs.length > 0 && <p className="memory-meta">Недавние реплики · {memory.last_answer.tail_seqs.join(', ')}</p>}
            {memory.last_answer.retrieved.length ? sources(memory.last_answer.retrieved)
              : <p className="muted">Старые реплики не вошли в этот ответ.</p>}
          </> : <p className="muted">Здесь появятся источники первого ответа.</p>}
        </section>
      </>}
    </div>
    {source && <OriginalMessage api={api} chatId={chatId} source={source} close={() => setSource(null)} />}
  </aside>
}

function OriginalMessage({ api, chatId, source, close }: { api: ChatApi; chatId: string; source: Source; close: () => void }) {
  const [message, setMessage] = useState<Message | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let current = true
    setError('')
    void api.messages(chatId, source.seq + 1, 1).then(({ messages }) => {
      const original = messages.find((item) => item.id === source.message_id)
      if (!original) throw new Error('Исходная реплика недоступна.')
      if (current) setMessage(original)
    }).catch((failure) => { if (current) setError(errorText(failure)) })
    return () => { current = false }
  }, [api, chatId, retry, source])
  return <Dialog title={`Реплика №${source.seq}`} close={close}>
    {error ? <Notice action={() => setRetry((count) => count + 1)}>{error}</Notice>
      : message ? <>
        <p className="memory-meta">{message.role === 'user' ? 'Вы' : 'Модель'} · {new Date(message.created_at).toLocaleString('ru-RU')}</p>
        <p className="original-message">{message.text}</p>
      </> : <p className="muted" role="status">Загружаем исходную реплику…</p>}
  </Dialog>
}

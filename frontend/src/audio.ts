import { useEffect, useRef, useState } from 'react'
import { errorText, type AudioJob, type ChatApi } from './api'

const audioLimit = 25 * 1024 * 1024

export function useAudio(api: ChatApi, chatId: string, scope: string, visible: boolean, onRecording: (recording: boolean) => void) {
  const draftKey = `psyholuh-transcripts-v1/${scope}/${chatId}`
  const [jobs, setJobs] = useState<AudioJob[]>([])
  const [edits, setEdits] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(draftKey) ?? '{}') }
    catch { return {} }
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState(false)
  const recorder = useRef<MediaRecorder | null>(null)
  const media = useRef<MediaStream | null>(null)
  const version = useRef(0)
  const mutating = useRef(false)
  const reading = useRef(false)

  async function refresh() {
    if (reading.current || mutating.current) return
    reading.current = true
    const current = version.current
    try {
      const { jobs } = await api.audio(chatId)
      if (current === version.current) setJobs(jobs)
    } catch (error) {
      if (current === version.current) setError(errorText(error))
    } finally {
      reading.current = false
    }
  }

  async function mutate(action: () => Promise<void>) {
    if (mutating.current) return
    mutating.current = true
    version.current++
    setBusy(true)
    setError('')
    try { await action() }
    catch (error) { setError(errorText(error)) }
    finally {
      mutating.current = false
      setBusy(false)
    }
  }

  function edit(id: string, transcript: string | null) {
    setEdits((current) => {
      const next = { ...current }
      if (transcript !== null) next[id] = transcript
      else delete next[id]
      try { localStorage.setItem(draftKey, JSON.stringify(next)) } catch { /* in-memory edits still work */ }
      return next
    })
  }

  async function upload(file: File) {
    if (mutating.current) return
    onRecording(true)
    await mutate(async () => {
      if (!file.size) throw new Error('Запись пуста.')
      if (file.size > audioLimit) throw new Error('Файл больше 25 МиБ.')
      const job = await api.upload(chatId, file)
      setJobs((current) => [job, ...current.filter((item) => item.job_id !== job.job_id)])
    })
    onRecording(false)
  }

  async function discard(job: AudioJob) {
    await mutate(async () => {
      await api.discardAudio(chatId, job.audio_id)
      setJobs((current) => current.filter((item) => item.audio_id !== job.audio_id))
      edit(job.audio_id, null)
    })
  }

  async function retry(job: AudioJob) {
    await mutate(async () => {
      const fresh = await api.retryAudio(job.job_id)
      setJobs((current) => current.map((item) => item.job_id === fresh.job_id ? fresh : item))
    })
  }

  async function start() {
    if (recorder.current || mutating.current) return
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError('Микрофон недоступен. Можно загрузить готовую запись.')
      return
    }
    onRecording(true)
    await mutate(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        media.current = stream
        const codec = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported(type))
        const input = codec ? new MediaRecorder(stream, { mimeType: codec }) : new MediaRecorder(stream)
        const parts: Blob[] = []
        let bytes = 0
        input.ondataavailable = (event) => {
          parts.push(event.data)
          bytes += event.data.size
          if (bytes > audioLimit && input.state !== 'inactive') input.stop()
        }
        input.onstop = () => {
          stream.getTracks().forEach((track) => track.stop())
          media.current = null
          recorder.current = null
          setRecording(false)
          const type = input.mimeType || parts[0]?.type || 'audio/webm'
          const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'
          void upload(new File(parts, `recording.${extension}`, { type: type.split(';')[0] }))
        }
        input.onerror = () => {
          input.onstop = null
          stream.getTracks().forEach((track) => track.stop())
          media.current = null
          recorder.current = null
          setRecording(false)
          onRecording(false)
          setError('Не удалось сохранить запись с микрофона.')
        }
        input.start(500)
        recorder.current = input
        setRecording(true)
      } catch {
        media.current?.getTracks().forEach((track) => track.stop())
        media.current = null
        onRecording(false)
        throw new Error('Не удалось включить микрофон. Проверьте разрешение в браузере.')
      }
    })
  }

  function consumed(id: string) {
    version.current++
    setJobs((current) => current.filter((job) => job.audio_id !== id))
    edit(id, null)
  }

  const running = jobs.some((job) => job.status === 'queued' || job.status === 'running')
  useEffect(() => {
    if (!visible) return
    void refresh()
    if (running) {
      const timer = window.setInterval(refresh, 1400)
      return () => window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, running])

  useEffect(() => () => {
    if (recorder.current) recorder.current.onstop = null
    media.current?.getTracks().forEach((track) => track.stop())
  }, [])

  return { jobs, edits, error, busy, recording, upload, discard, retry, edit, start, consumed,
    stop: () => {
      const input = recorder.current
      if (input && input.state !== 'inactive') input.stop()
    },
    refresh: () => { setError(''); void refresh() } }
}

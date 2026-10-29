import { useCallback, useRef, useState } from "react"
import {
  ApiError,
  createSessionId,
  isEmailValid,
  postApprove,
  postChat,
  resultIndicatesFailure,
  type ApiErrorKind,
  type Citation,
  type HelpdeskResponse,
  type PendingAction,
  type ToolCall,
} from "./api"

export interface ChatMessage {
  id: number
  role: "user" | "assistant"
  text: string
  time: Date
}

export interface ChatError {
  scope: "chat" | "approval"
  kind: ApiErrorKind | "email"
  status?: number
}

export interface Diagnostics {
  citations: Citation[]
  toolCalls: ToolCall[]
  result: unknown
  state: unknown
}

export interface DraftOutcome {
  type: "approved" | "rejected" | "failed"
  result: unknown
  reply: string | null
}

export type Busy = "chat" | "approve" | "reject" | null

const emptyDiagnostics: Diagnostics = {
  citations: [],
  toolCalls: [],
  result: null,
  state: null,
}

export function useHelpdeskChat() {
  const [sessionId, setSessionId] = useState(createSessionId)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [pendingActionInvalid, setPendingActionInvalid] = useState(false)
  const [diagnostics, setDiagnostics] = useState<Diagnostics>(emptyDiagnostics)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<ChatError | null>(null)
  const [outcome, setOutcome] = useState<DraftOutcome | null>(null)
  const [failedMessage, setFailedMessage] = useState<string | null>(null)
  const [email, setEmail] = useState("")
  const lock = useRef(false)
  const nextId = useRef(1)

  const addMessage = useCallback((role: ChatMessage["role"], text: string) => {
    setMessages((current) => [
      ...current,
      { id: nextId.current++, role, text, time: new Date() },
    ])
  }, [])

  const applyResponse = useCallback((response: HelpdeskResponse) => {
    setPendingAction(response.pendingAction)
    setPendingActionInvalid(response.pendingActionInvalid)
    setDiagnostics({
      citations: response.citations,
      toolCalls: response.toolCalls,
      result: response.result,
      state: response.state,
    })
  }, [])

  const toError = (scope: ChatError["scope"], caught: unknown): ChatError =>
    caught instanceof ApiError
      ? { scope, kind: caught.kind, status: caught.status }
      : { scope, kind: "invalid" }

  const send = useCallback(
    async (rawText: string, rawEmail: string): Promise<boolean> => {
      const message = rawText.trim()
      const email = rawEmail.trim().toLowerCase()
      if (!message || lock.current) return false
      if (email && !isEmailValid(email)) {
        setError({ scope: "chat", kind: "email" })
        return false
      }

      lock.current = true
      setBusy("chat")
      setError(null)
      setFailedMessage(null)
      setOutcome(null)
      addMessage("user", message)
      try {
        const response = await postChat({
          session_id: sessionId,
          message,
          ...(email ? { user: { email } } : {}),
        })
        if (response.reply) addMessage("assistant", response.reply)
        applyResponse(response)
        return true
      } catch (caught) {
        setError(toError("chat", caught))
        setFailedMessage(message)
        return false
      } finally {
        lock.current = false
        setBusy(null)
      }
    },
    [sessionId, addMessage, applyResponse],
  )

  const decide = useCallback(
    async (approved: boolean) => {
      if (!pendingAction || lock.current) return
      lock.current = true
      setBusy(approved ? "approve" : "reject")
      setError(null)
      setOutcome(null)
      try {
        const response = await postApprove({
          session_id: sessionId,
          action_id: pendingAction.action_id,
          approved,
        })
        if (response.reply) addMessage("assistant", response.reply)
        applyResponse(response)
        const failed = approved && resultIndicatesFailure(response.result)
        setOutcome({
          type: failed ? "failed" : approved ? "approved" : "rejected",
          result: response.result,
          reply: response.reply,
        })
      } catch (caught) {
        // The draft stays in place so the decision can be retried safely.
        setError(toError("approval", caught))
      } finally {
        lock.current = false
        setBusy(null)
      }
    },
    [pendingAction, sessionId, addMessage, applyResponse],
  )

  const reset = useCallback(() => {
    if (lock.current) return
    setSessionId(createSessionId())
    setMessages([])
    setPendingAction(null)
    setPendingActionInvalid(false)
    setDiagnostics(emptyDiagnostics)
    setError(null)
    setOutcome(null)
    setFailedMessage(null)
  }, [])

  return {
    sessionId,
    messages,
    pendingAction,
    pendingActionInvalid,
    diagnostics,
    busy,
    error,
    outcome,
    failedMessage,
    email,
    setEmail,
    send,
    approve: () => decide(true),
    reject: () => decide(false),
    reset,
    clearOutcome: () => setOutcome(null),
    clearError: () => setError(null),
  }
}

export type HelpdeskChat = ReturnType<typeof useHelpdeskChat>

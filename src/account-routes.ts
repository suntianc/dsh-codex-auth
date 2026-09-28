/** Plugin-owned account RPC carried by Connection's authenticated /api routes. */
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import type { HostConnectionHandle, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'

/**
 * Account dispatch decoupled from `ConnectionRpcHandler`: the shared `/api`
 * channel is intercepted by dsh-api-gateway in DSH 0.1.7, so these exact Fetch
 * routes keep their own decode bridge and call the guarded dispatcher directly.
 */
export type AccountRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<ConnectionRpcResult<unknown>>

/** Register exact routes without creating a separate physical RPC carrier. */
export function registerAccountRoutes(
  connection: HostConnectionHandle,
  namespace: string,
  endpoints: readonly string[],
  handler: AccountRpcHandler,
): () => Promise<void> {
  const disposers = endpoints.map(endpoint => connection.fetch.register({
    path: `/api/${namespace}/${endpoint}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let body: unknown
      try { body = await request.json() } catch { return new Response('invalid JSON', { status: 400 }) }
      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) return new Response('invalid account request', { status: 400 })
      const { rpcId, method, payload } = envelope.data
      const failure = (code: string, message: string) => ({ ok: false as const, error: { code, message, details: {} } })
      let result
      try {
        result = method === `${namespace}/${endpoint}`
          ? await handler(endpoint, payload, request.signal)
          : failure('bad-request', 'Account request method does not match its endpoint')
      } catch {
        result = failure('internal', 'Account request failed')
      }
      return Response.json({ type: 'server-response', rpcId, result })
    },
  }))
  return async () => { await Promise.all(disposers.map(dispose => dispose())) }
}

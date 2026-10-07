import { BaseBrowserSession } from "../transport/browsers/base.js";
import { HttpSession, type HttpMethod } from "../transport/http.js";
import type { Response } from "../transport/utils/response.js";
import type { Request } from "./request.js";

export type Session = HttpSession | BaseBrowserSession;

function isAlive(session: Session): boolean {
  return session.isAlive;
}

/** Manages the pre-configured sessions of a crawler */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private defaultId: string | null = null;
  private started = false;
  private readonly lazySessions = new Set<string>();
  private readonly lazyStarts = new Map<string, Promise<unknown>>();

  /**
   * Register a session instance.
   *
   * @param sessionId The name used to reference this session in requests (`sid`)
   * @param options.default Make this session the default one (the first added session is the default otherwise)
   * @param options.lazy Start the session only when a request uses it
   */
  add(sessionId: string, session: Session, options: { default?: boolean; lazy?: boolean } = {}): this {
    if (this.sessions.has(sessionId)) throw new Error(`Session '${sessionId}' already registered`);
    if (!(session instanceof HttpSession) && !(session instanceof BaseBrowserSession)) {
      throw new TypeError(`Session '${sessionId}' must be a HttpSession, BrowserSession, or StealthBrowserSession`);
    }
    this.sessions.set(sessionId, session);
    if (options.default || this.defaultId === null) this.defaultId = sessionId;
    if (options.lazy) this.lazySessions.add(sessionId);
    return this;
  }

  /** Remove a session */
  remove(sessionId: string): void {
    this.pop(sessionId);
  }

  /** Remove and return a session */
  pop(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' not found`);
    this.sessions.delete(sessionId);
    this.lazySessions.delete(sessionId);
    if (this.defaultId === sessionId) this.defaultId = this.sessions.keys().next().value ?? null;
    return session;
  }

  get defaultSessionId(): string {
    if (this.defaultId === null) throw new Error("No sessions registered");
    return this.defaultId;
  }

  get sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  get(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session '${sessionId}' not found. Available: ${this.sessionIds.join(", ")}`);
    return session;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Start all the sessions that aren't lazy or alive already */
  async start(): Promise<void> {
    if (this.started) return;
    for (const [sid, session] of this.sessions) {
      if (!this.lazySessions.has(sid) && !isAlive(session)) await session.start();
    }
    this.started = true;
  }

  /** Close all the registered sessions */
  async close(): Promise<void> {
    for (const [sid, session] of this.sessions) {
      if (this.lazySessions.has(sid) && !isAlive(session)) continue;
      await session.close();
    }
    this.lazyStarts.clear();
    this.started = false;
  }

  private async ensureStarted(sid: string, session: Session): Promise<void> {
    if (isAlive(session)) return;
    let starting = this.lazyStarts.get(sid);
    if (!starting) {
      starting = session.start();
      this.lazyStarts.set(sid, starting);
    }
    await starting;
  }

  /** Fetch a crawler request with its session */
  async fetch(request: Request): Promise<Response> {
    const sid = request.sid || this.defaultSessionId;
    const session = this.get(sid);
    if (this.lazySessions.has(sid)) await this.ensureStarted(sid, session);

    let response: Response;
    if (session instanceof HttpSession) {
      const { method = "GET", ...kwargs } = request.sessionKwargs as { method?: HttpMethod } & Record<string, unknown>;
      response = await session.request(String(method).toUpperCase() as HttpMethod, request.url, kwargs);
    } else {
      response = await session.fetch(request.url, request.sessionKwargs);
    }
    response.request = request;
    // Merge the request meta into the response meta (the response's takes priority)
    response.meta = { ...request.meta, ...response.meta };
    return response;
  }
}

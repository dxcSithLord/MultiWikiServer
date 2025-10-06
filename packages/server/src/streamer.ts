import * as http2 from 'node:http2';
import send, { SendOptions } from 'send';
import { Readable } from 'stream';
import { IncomingMessage, ServerResponse, IncomingHttpHeaders as NodeIncomingHeaders, OutgoingHttpHeaders } from 'node:http';
import { is } from './utils';
import { createReadStream } from 'node:fs';
import { Writable } from 'node:stream';
import Debug from "debug";
import { Compressor } from "./compression";
import { serverEvents } from '@tiddlywiki/events';

declare module 'node:net' {
  interface Socket {
    // this comment gets prepended to the other comment for this property, thus the hanging sentance.
    /** Not defined on net.Socket instances. 
     * 
     * On tls.Socket instances,  */
    encrypted?: boolean;
  }
}

import type { IncomingMessage, ServerResponse } from 'http';

export class _Streamer {
    private _headersSent = false;
    
    constructor(
        public readonly request: IncomingMessage,
        public readonly response: ServerResponse
    ) {
        // Track when headers are sent
        this.response.on('finish', () => {
            this._headersSent = true;
        });
    }
    
    /**
     * Check if response headers have been sent
     */
    get headersSent(): boolean {
        return this._headersSent || this.response.headersSent;
    }
    
    /**
     * Set a response header
     */
    setHeader(name: string, value: string | number): void {
        if (this.headersSent) {
            console.warn(`[Streamer] Cannot set header "${name}" - headers already sent`);
            return;
        }
        
        try {
            this.response.setHeader(name, value);
        } catch (error) {
            console.error(`[Streamer] Error setting header "${name}":`, error);
            throw error;
        }
    }
    
    /**
     * Write response head with status code and headers
     */
    writeHead(statusCode: number, headers?: Record<string, string | number>): void {
        if (this.headersSent) {
            const error = new Error('Cannot write headers - headers already sent');
            console.error('[Streamer]', error.message);
            console.error('[Streamer] Response state:', {
                headersSent: this.response.headersSent,
                writableEnded: this.response.writableEnded,
                destroyed: this.response.destroyed
            });
            throw error;
        }
        
        try {
            // Set individual headers first
            if (headers) {
                Object.entries(headers).forEach(([key, value]) => {
                    if (!this.headersSent) {
                        this.response.setHeader(key, value);
                    }
                });
            }
            
            // Write status code
            this.response.writeHead(statusCode);
            this._headersSent = true;
            
        } catch (error) {
            console.error('[Streamer] Error in writeHead:', error);
            throw error;
        }
    }
    
    /**
     * Send a buffer as response
     */
    sendBuffer(buffer: Buffer, contentType: string = 'text/html; charset=utf-8'): void {
        if (this.headersSent) {
            console.error('[Streamer] Cannot send buffer - headers already sent');
            console.error('[Streamer] Response state:', {
                headersSent: this.response.headersSent,
                writableEnded: this.response.writableEnded,
                destroyed: this.response.destroyed
            });
            throw new Error('Cannot send buffer - headers already sent');
        }
        
        if (this.response.destroyed) {
            console.error('[Streamer] Cannot send buffer - response destroyed');
            throw new Error('Cannot send buffer - response destroyed');
        }
        
        if (this.response.writableEnded) {
            console.error('[Streamer] Cannot send buffer - response already ended');
            throw new Error('Cannot send buffer - response already ended');
        }
        
        try {
            // Set headers
            this.setHeader('Content-Type', contentType);
            this.setHeader('Content-Length', buffer.length);
            
            // Write status and headers
            this.writeHead(200);
            
            // Write body
            this.response.write(buffer);
            this.response.end();
            
            console.log('[Streamer] Buffer sent successfully:', buffer.length, 'bytes');
            
        } catch (error) {
            console.error('[Streamer] Error sending buffer:', error);
            
            // Try to end response if not already ended
            if (!this.response.writableEnded && !this.response.destroyed) {
                try {
                    this.response.end();
                } catch (endError) {
                    console.error('[Streamer] Error ending response:', endError);
                }
            }
            
            throw error;
        }
    }
    
    /**
     * Send admin/error page content
     */
    async sendAdmin(content: string): Promise<void> {
        if (this.headersSent) {
            console.error('[Streamer] Cannot send admin page - headers already sent');
            throw new Error('Cannot send admin page - headers already sent');
        }
        
        if (!this.response.writable) {
            console.error('[Streamer] Cannot send admin page - response not writable');
            throw new Error('Cannot send admin page - response not writable');
        }
        
        try {
            const buffer = Buffer.from(content, 'utf-8');
            this.sendBuffer(buffer, 'text/html; charset=utf-8');
        } catch (error) {
            console.error('[Streamer] Error sending admin page:', error);
            throw error;
        }
    }
    
    /**
     * Stream data chunk by chunk
     */
    write(chunk: Buffer | string): boolean {
        if (this.response.destroyed) {
            console.warn('[Streamer] Cannot write - response destroyed');
            return false;
        }
        
        if (this.response.writableEnded) {
            console.warn('[Streamer] Cannot write - response already ended');
            return false;
        }
        
        try {
            return this.response.write(chunk);
        } catch (error) {
            console.error('[Streamer] Error writing chunk:', error);
            return false;
        }
    }
    
    /**
     * End the response stream
     */
    end(chunk?: Buffer | string): void {
        if (this.response.writableEnded) {
            console.warn('[Streamer] Response already ended');
            return;
        }
        
        if (this.response.destroyed) {
            console.warn('[Streamer] Cannot end - response destroyed');
            return;
        }
        
        try {
            if (chunk) {
                this.response.end(chunk);
            } else {
                this.response.end();
            }
        } catch (error) {
            console.error('[Streamer] Error ending response:', error);
        }
    }
    
    /**
     * Get debug information about streamer state
     */
    getDebugInfo(): object {
        return {
            headersSent: this.headersSent,
            responseHeadersSent: this.response.headersSent,
            writableEnded: this.response.writableEnded,
            destroyed: this.response.destroyed,
            writable: this.response.writable,
            finished: this.response.finished
        };
    }
}

export interface IncomingHttpHeaders extends NodeIncomingHeaders {
  "x-requested-with"?: string;
}

export const SYMBOL_IGNORE_ERROR: unique symbol = Symbol("IGNORE_ERROR");

export interface SendFileOptions extends Omit<SendOptions, "root" | "dotfiles" | "index" | "start" | "end"> {
  root: string;
  reqpath: string;
  offset?: number;
  length?: number;
  on404?: () => Promise<typeof STREAM_ENDED>;
  onDir?: () => Promise<typeof STREAM_ENDED>;
  /** Index file to send, defaults to false. */
  index?: SendOptions["index"];
  /** @deprecated not implemented */
  prefix?: Buffer;
  /** @deprecated not implemented */
  suffix?: Buffer;
}

export type StreamerChunk = { data: string, encoding: NodeJS.BufferEncoding } | NodeJS.ReadableStream | Readable | Buffer;

/**
 * The HTTP2 shims used in the request handler are only used for HTTP2 requests. 
 * The NodeJS HTTP2 server actually calls the HTTP1 parser for all HTTP1 requests. 
 */
export class Streamer {
  host: string;
  method: string;
  urlInfo: URL;
  /** The request url with path prefix removed. */
  url: string;
  headers: IncomingHttpHeaders;
  cookies: URLSearchParams;
  compressor;
  constructor(
    private req: IncomingMessage | http2.Http2ServerRequest,
    private res: ServerResponse | http2.Http2ServerResponse,
    public pathPrefix: string,
    public expectSecure: boolean,
  ) {

    this.headers = req.headers;

    this.url = req.url as string;

    if (!this.url.startsWith("/")) throw new Error("This should never happen");

    if (pathPrefix) {
      if (this.url === pathPrefix) {
        res.writeHead(302, { "location": req.url + "/" }).end();
        throw STREAM_ENDED;
      } else if (this.url.startsWith(pathPrefix)) {
        this.url = this.url.slice(pathPrefix.length);
      } else {
        res.writeHead(500, {}).end("The server is setup with a path prefix " + pathPrefix + ", but this request is outside of that prefix.", "utf8");
        throw STREAM_ENDED;
      }
    }

    if (is<http2.Http2ServerRequest>(req, req.httpVersionMajor > 1))
      req.headers.host = req.headers[":authority"];
    if (!req.headers.host) throw new Error("This should never happen");
    this.host = req.headers.host;

    if (!req.method) throw new Error("This should never happen");
    // if (!is<AllowedMethod>(req.method, AllowedMethods.includes(req.method as any))) {
    //   //https://httpwg.org/specs/rfc9110.html#status.501
    //   res.writeHead(501, {}).end("Method not supported", "utf8");
    //   throw STREAM_ENDED;
    // }
    this.method = req.method;

    this.urlInfo = new URL(`https://${this.headers.host}${this.url}`);

    this.cookies = this.parseCookieString(req.headers.cookie || "");

    this.compressor = new Compressor(req, res, {
      identity: {
        allowHalfOpen: false,
        autoDestroy: true,
        emitClose: true,
      }
    });
  }


  // RIP Push Stream. it was a great idea.
  // async pushStream(path: string) {
  //   return new Promise<Streamer>((resolve, reject) => {
  //     const req2: http2.Http2ServerRequest = this.req as any;
  //     if (!req2.stream || !req2.stream.pushAllowed) return reject();
  //     req2.stream.write
  //     const newRawHeaders = this.req.rawHeaders.slice();
  //     for (let i = 0; i < newRawHeaders.length; i += 2) {
  //       if (newRawHeaders[i] === ":method") newRawHeaders[i + 1] = "GET";
  //       if (newRawHeaders[i] === ":path") newRawHeaders[i + 1] = path;
  //     }
  //     req2.stream.pushStream({ ":method": "GET", ":path": path }, (err, pushStream, headers) => {
  //       if (err) return reject(err);
  //       const preq = new http2.Http2ServerRequest(pushStream, req2.headers, {}, newRawHeaders);
  //       const pres = new http2.Http2ServerResponse(pushStream);
  //       const pushStreamer = new Streamer(preq, pres, this.router);
  //       resolve(pushStreamer);
  //     });
  //   }).then(async streamer => {
  //     await this.router.handle(streamer);
  //     return streamer;
  //   }, (err) => { if (err) throw err; });
  // }


  parseCookieString(cookieString: string) {
    const cookies = new URLSearchParams();
    if (typeof cookieString !== 'string') throw new Error('cookieString must be a string');
    cookieString.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      if (parts.length >= 2) {
        const key = parts[0]!.trim();
        const value = parts.slice(1).join('=').trim();
        cookies.append(key, decodeURIComponent(value));
      }
    });
    return cookies;
  }

  get reader(): Readable { return this.req; }
  get writer(): Writable {
    // don't overwrite it here if it's already set because this could just be for sending the body.
    if (!this.headersSent && !this.headersSentBy)
      this.headersSentBy = new Error("Possible culprit was given access to the response object here.");

    return this.compressor.stream ?? this.res;
  }

  throw(statusCode: number) {
    this.sendEmpty(statusCode);
    throw SYMBOL_IGNORE_ERROR;
  }

  catcher = (error: unknown) => {
    if (error === SYMBOL_IGNORE_ERROR) return;
    if (error === STREAM_ENDED) return;
    const tag = this.urlInfo.href;
    console.error(tag, error);
    if (!this.headersSent) {
      this.sendEmpty(500, { "x-reason": "Internal Server Error (catcher)" });
    }
  }

  checkHeadersSentBy(setError: boolean) {
    if (this.headersSent && this.headersSentBy) {
      console.log(this.headersSentBy);
      console.log(new Error("This is the second attempt to send headers. Was it supposed to happen?"));
    }
    else if (this.res.headersSent) console.log("Headers were sent by an unknown source.");
    // queue up the error in case there is a second attempt.
    else this.headersSentBy = new Error("You appear to be sending headers more than once. The first attempt was here. Does it need to throw or return?")
  }



  toHeadersMap(headers: { [x: string]: string | string[] | number | undefined }) {
    return new Map(Object.entries(headers).map(([k, v]) =>
      [k.toLowerCase(), Array.isArray(v) ? v : v === undefined ? [] : [v.toString()]]
    ));
  }

  readBody = () => new Promise<Buffer>((resolve: (chunk: Buffer) => void) => {
    const chunks: Buffer[] = [];

    this.reader.on('data', chunk => chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    this.reader.on('end', () => resolve(Buffer.concat(chunks)));
  });

  sendEmpty(status: number, headers: OutgoingHttpHeaders = {}): typeof STREAM_ENDED {
    if (process.env.DEBUG?.split(",").includes("send")) {
      console.error("sendEmpty", status, headers);
    }
    this.checkHeadersSentBy(true);
    this.res.writeHead(status, headers);
    this.writer.end();
    return STREAM_ENDED;
  }

  sendString(status: number, headers: OutgoingHttpHeaders, data: string, encoding: NodeJS.BufferEncoding): typeof STREAM_ENDED {
    if (process.env.DEBUG?.split(",").includes("send")) {
      console.error("sendString", status, headers);
    }
    headers['content-length'] = Buffer.byteLength(data, encoding);
    this.writeHead(status, headers);

    if (this.method === "HEAD")
      this.writer.end();
    else
      this.writer.end(data, encoding);

    return STREAM_ENDED;
  }

  sendBuffer(status: number, headers: OutgoingHttpHeaders, data: Buffer): typeof STREAM_ENDED {
    if (process.env.DEBUG?.split(",").includes("send")) {
      console.error("sendBuffer", status, headers);
    }
    headers['content-length'] = data.length;
    this.writeHead(status, headers);
    if (this.method === "HEAD")
      this.writer.end();
    else
      this.writer.end(data);
    return STREAM_ENDED;
  }
  /** If this is a HEAD request, the stream will be destroyed. */
  sendStream(status: number, headers: OutgoingHttpHeaders, stream: Readable): typeof STREAM_ENDED {
    if (process.env.DEBUG?.split(",").includes("send")) {
      console.error("sendStream", status, headers);
    }
    this.writeHead(status, headers);
    if (this.method === "HEAD") {
      stream.destroy();
      this.writer.end();
    } else {
      stream.pipe(this.writer);
    }
    return STREAM_ENDED;
  }


  // I'm not sure if there's a use case for this
  private sendFD(status: number, headers: OutgoingHttpHeaders, options: {
    fd: number;
    offset?: number;
    length?: number;
  }): typeof STREAM_ENDED {
    this.checkHeadersSentBy(true);
    this.res.writeHead(status, headers);
    const { fd, offset, length } = options;
    const stream = createReadStream("", {
      fd,
      start: offset,
      end: length && length - 1,
      autoClose: false,
    });
    stream.pipe(this.res);
    return STREAM_ENDED;
  }
  /** 
   * Sends a file with the appropriate cache headers, using the `send` npm module. 
   * 
   * Think of it like a static file server where you are serving files from a directory.
   * 
   * @param options.root The directory to serve files from.
   * @param options.reqpath The path to the file relative to the `root` directory.
   * @param options.offset The offset in bytes to start reading the file from.
   * @param options.length The number of bytes to read from the file.
   * @param options.index "index.html" by default, to disable this set false or 
   * to supply a new index pass a string or an array in preferred order. 
   * 
   * If an index.html file is not found, `send` will NOT generate a directory listing.
   * 
   * The `send` method will automatically set the `Content-Type` header based on the file extension.
   * 
   * If the file is not found, the `send` method will automatically send a 404 response.
   * 

   * @returns STREAM_ENDED
   */
  sendFile(status: number, headers: OutgoingHttpHeaders, options: SendFileOptions) {

    // the headers and status have to be set on the response object before piping the stream
    this.res.statusCode = status;
    this.toHeadersMap(headers).forEach((v, k) => { this.res.appendHeader(k, v); });

    const {
      root, reqpath, offset, length, prefix, suffix, on404, onDir, index = false,
      acceptRanges, cacheControl, immutable, etag, extensions, lastModified, maxAge

    } = options;

    if (prefix || suffix) throw new Error("prefix and suffix are not implemented");

    if (process.env.DEBUG?.split(",").includes("send")) {
      console.error("sendFile", root, reqpath, status, headers);
    }

    const sender = send(this.req, reqpath, {
      dotfiles: "ignore",
      index,
      root,
      start: offset,
      end: length && length - 1,

      acceptRanges, cacheControl, immutable, etag, extensions, lastModified, maxAge,
    });
    return new Promise<typeof STREAM_ENDED>((resolve, reject) => {

      sender.on("error", (err) => Promise.resolve().then(async (): Promise<typeof STREAM_ENDED> => {
        if (err === 404 || err?.statusCode === 404) {
          return (await on404?.()) ?? this.sendEmpty(404);
        } else {
          console.log(err);
          throw this.sendEmpty(500);
        }
      }).then(resolve, reject));

      sender.on("directory", () => Promise.resolve().then(async (): Promise<typeof STREAM_ENDED> => {
        return (await onDir?.())
          ?? this.sendEmpty(404, { "x-reason": "Directory listing not allowed" })
      }).then(resolve, reject));

      sender.on("stream", (fileStream) => {
        this.compressor.beforeWriteHead();
        const orig_pipe = fileStream.pipe as Function;
        fileStream.pipe = () => orig_pipe.call(fileStream, this.writer);
      });

      this.res.on("end", () => { resolve(STREAM_ENDED); });
      this.checkHeadersSentBy(true);
      sender.pipe(this.res);
    });
  }


  sendSSE(retryMilliseconds?: number) {
    if (retryMilliseconds !== undefined)
      if (typeof retryMilliseconds !== "number" || retryMilliseconds < 0)
        throw new Error("Invalid retryMilliseconds: must be a non-negative number");

    this.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, max-age=0",
      "content-encoding": "identity",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    });

    this.writer.write(": This page is a server-sent event stream. It will continue loading until you close it.\n");
    this.writer.write(": https://html.spec.whatwg.org/multipage/server-sent-events.html#server-sent-events\n");
    this.writer.write("\n");

    /**
     * 
     * @param {string} eventName The event name. If zero-length, the field is omitted
     * @param eventData The data to send. Must be stringify-able to JSON.
     * @param {string} eventId The event id. If zero-length, the field is omitted.
     */
    const emitEvent = (eventName: string, eventData: any, eventId: string) => {
      if (typeof eventName !== "string")
        throw new Error("Event name must be a string (a zero-length string disables the field)");
      if (eventName.includes("\n"))
        throw new Error("Event name cannot contain newlines");
      if (typeof eventId !== "string")
        throw new Error("Event ID must be a string");
      if (eventId.includes("\n"))
        throw new Error("Event ID cannot contain newlines");
      if (this.writer.writableEnded)
        throw new Error("Cannot emit event after the stream has ended");

      this.writer.write([
        eventName && `event: ${eventName}`,
        `data: ${JSON.stringify(eventData)}`,
        eventId && `id: ${eventId}`,
        retryMilliseconds && `retry: ${retryMilliseconds}`,
      ].filter(truthy).join("\n") + "\n\n");
    }
    const emitComment = (comment: string) => {
      this.writer.write(`: ${comment}\n\n`);
    }
    const onClose = (callback: () => void) => {
      this.writer.on("finish", callback);
    }
    const close = () => {
      this.writer.end();
    }

    serverEvents.on("exit", close);
    this.writer.on("finish", () => {
      serverEvents.off("exit", close);
    });

    return {
      /** Emit an SSE event */
      emitEvent,
      emitComment,
      onClose,
      close,
    };

  }

  setCookie(name: string, value: string, options: {
    /**
 
      Defines the host to which the cookie will be sent.
 
      Only the current domain can be set as the value, or a domain of a higher order, unless it is a public suffix. Setting the domain will make the cookie available to it, as well as to all its subdomains.
 
      If omitted, this attribute defaults to the host of the current document URL, not including subdomains.
 
      Contrary to earlier specifications, leading dots in domain names (.example.com) are ignored.
 
      Multiple host/domain values are not allowed, but if a domain is specified, then subdomains are always included.
 
     */
    domain?: string;
    /**
 
    Indicates the path that must exist in the requested URL for the browser to send the Cookie header.
 
    The forward slash (`/`) character is interpreted as a directory separator, and subdirectories are matched as well. 
    
    For example, for `Path=/docs`,
 
    - the request paths `/docs`,` /docs/`, `/docs/Web/`, and `/docs/Web/HTTP` will all match.
    - the request paths `/`, `/docsets`, `/fr/docs` will not match.
 
     */
    path?: string;
    expires?: Date;
    maxAge?: number;
    secure?: boolean;
    httpOnly?: boolean;
    /**
      Controls whether or not a cookie is sent with cross-site requests: that is, requests originating from a different site, including the scheme, from the site that set the cookie. This provides some protection against certain cross-site attacks, including cross-site request forgery (CSRF) attacks.
 
      The possible attribute values are:
 
      ### Strict
 
      Send the cookie only for requests originating from the same site that set the cookie.
 
      ### Lax
 
      Send the cookie only for requests originating from the same site that set the cookie, and for cross-site requests that meet both of the following criteria:
 
      - The request is a top-level navigation: this essentially means that the request causes the URL shown in the browser's address bar to change.
 
        - This would exclude, for example, requests made using the fetch() API, or requests for subresources from <img> or <script> elements, or navigations inside <iframe> elements.
 
        - It would include requests made when the user clicks a link in the top-level browsing context from one site to another, or an assignment to document.location, or a <form> submission.
 
      - The request uses a safe method: in particular, this excludes POST, PUT, and DELETE.
 
      Some browsers use Lax as the default value if SameSite is not specified: see Browser compatibility for details.
 
      > Note: When Lax is applied as a default, a more permissive version is used. In this more permissive version, cookies are also included in POST requests, as long as they were set no more than two minutes before the request was made.
 
      ### None
 
      Send the cookie with both cross-site and same-site requests. The Secure attribute must also be set when using this value.
     */
    sameSite?: "Strict" | "Lax" | "None";
  }) {
    var cookie = `${name}=${encodeURIComponent(value)}`;
    if (options.domain) cookie += `; Domain=${options.domain}`;
    if (options.path) cookie += `; Path=${options.path}`;
    if (options.expires) cookie += `; Expires=${options.expires.toUTCString()}`;
    if (options.maxAge) cookie += `; Max-Age=${options.maxAge}`;
    if (options.secure) cookie += `; Secure`;
    if (options.httpOnly) cookie += `; HttpOnly`;
    if (options.sameSite) cookie += `; SameSite=${options.sameSite}`;
    this.appendHeader("Set-Cookie", cookie);
  }

  appendHeader(name: string, value: string): void {
    const current = this.res.getHeader(name);
    this.res.setHeader(name,
      current
        ? Array.isArray(current)
          ? [...current as string[], value]
          : [current as string, value]
        : value
    );
  }

  setHeader(name: string, value: string): void {
    this.res.setHeader(name, value);
  }
  writeHead(status: number, headers: OutgoingHttpHeaders = {}): void {
    if (Debug.enabled("send"))
      console.error("writeHead", status, headers);

    Object.entries(headers).forEach(([k, v]) => {
      if (v != null) this.setHeader(k, `${v}`);
    });

    this.checkHeadersSentBy(true);
    this.compressor.beforeWriteHead();
    this.res.writeHead(status);
  }
  /**
   * Write early hints using 103 Early Hints, 
   * silently ignored if the request version is prior to 2.
   * 
   * Despite this being an HTTP/1.1 feature, not all browsers
   * correctly implemented it, so this is commonly restricted 
   * to HTTP/2. 
   * 
   * @example
    state.writeEarlyHints({
      'link': [
        '</styles.css>; rel=preload; as=style',
        '</scripts.js>; rel=preload; as=script',
      ],
      'x-trace-id': 'id for diagnostics',
    });
   * @param hints 
   * @returns 
   */
  writeEarlyHints(hints: Record<string, string | string[]>) {
    if (this.req.httpVersionMajor > 1)
      this.res.writeEarlyHints(hints);
  }


  pause: boolean = false;
  /** awaiting is not required. everything happens sync'ly */
  write(chunk: Buffer | string, encoding?: NodeJS.BufferEncoding): Promise<void> {
    const continueWriting = this.writer.write(typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk);
    if (!continueWriting)
      return new Promise<void>(resolve => this.writer.once("drain", () => { resolve(); }));
    else
      return Promise.resolve();
  }
  end(): typeof STREAM_ENDED {
    // console.log(this.writer.end.toString());
    this.writer.end();
    return STREAM_ENDED;
  }

  /** Destroy the transport stream and possibly the entire connection. */
  destroy() {
    this.res.destroy();
  }

  get headersSent() {
    return this.res.headersSent;
  }

  headersSentBy: Error | undefined;
}

/** 
 * This can be used as the basis of state objects and exposes the 
 * relevant streamer interface without allowing private members to be exposed. 
 * 
 */
export class StreamerState {

  readBody
  sendEmpty
  sendString
  sendBuffer
  sendStream
  sendFile
  sendSSE
  setCookie
  /**
   * 
   * Sets a single header value. If the header already exists in the to-be-sent
   * headers, its value will be replaced. Use an array of strings to send multiple
   * headers with the same name
   * 
   * When headers have been set with `response.setHeader()`, they will be merged
   * with any headers passed to `response.writeHead()`, with the headers passed
   * to `response.writeHead()` given precedence.
   * 
   */
  setHeader
  writeHead
  writeEarlyHints
  write
  end

  /** 
   * this will pipe from the specified stream, but will not end the 
   * response when the input stream ends. Input stream errors will be 
   * caught and reject the promise. The promise will resolve once the
   * input stream ends.
   */

  async pipeFrom(stream: Readable) {
    stream.pipe(this.streamer.writer, { end: false });
    return new Promise<void>((r, c) => this.streamer.writer.on("unpipe", r).on("error", c));
  }

  /** sends a status and plain text string body */
  sendSimple(status: number, msg: string): typeof STREAM_ENDED {
    return this.sendString(status, {
      "content-type": "text/plain"
    }, msg, "utf8");
  }
  /** Stringify the value (unconditionally) and send it with content-type `application/json` */
  sendJSON<T>(status: number, obj: T): typeof STREAM_ENDED {
    return this.sendString(status, {
      "content-type": "application/json"
    }, JSON.stringify(obj), "utf8");
  }

  /** End the compression stream, flushing the rest of the compressed data, then begin a brand new stream to concatenate. */
  async splitCompressionStream() {
    await this.streamer.compressor.splitStream();
  }


  STREAM_ENDED: typeof STREAM_ENDED = STREAM_ENDED;

  constructor(protected streamer: Streamer) {
    this.readBody = this.streamer.readBody.bind(this.streamer);
    this.sendEmpty = this.streamer.sendEmpty.bind(this.streamer);
    this.sendString = this.streamer.sendString.bind(this.streamer);
    this.sendBuffer = this.streamer.sendBuffer.bind(this.streamer);
    this.sendStream = this.streamer.sendStream.bind(this.streamer);
    this.sendFile = this.streamer.sendFile.bind(this.streamer);
    this.sendSSE = this.streamer.sendSSE.bind(this.streamer);
    // this.pipeFrom = this.streamer.pipeFrom.bind(this.streamer);
    this.setHeader = this.streamer.setHeader.bind(this.streamer);
    this.writeHead = this.streamer.writeHead.bind(this.streamer);
    this.writeEarlyHints = this.streamer.writeEarlyHints.bind(this.streamer);
    this.write = this.streamer.write.bind(this.streamer);
    this.end = this.streamer.end.bind(this.streamer);
    this.setCookie = this.streamer.setCookie.bind(this.streamer);

  }

  /** The request url with path prefix removed. */
  get url() { return this.streamer.url; }
  get method(): string { return this.streamer.method; }
  get headers() { return this.streamer.headers; }
  get host() { return this.streamer.host; }
  get urlInfo() { return this.streamer.urlInfo; }
  get headersSent() { return this.streamer.headersSent; }

  get reader() { return this.streamer.reader; }

  get cookies() { return this.streamer.cookies; }
  /** This is based on the listener either having a key + cert or having secure set */
  get expectSecure() { return this.streamer.expectSecure; }


  /** 
   * The path prefix is a essentially folder mount point. 
   * 
   * It starts with a slash, and ends without a slash (`"/dev"`). 
   * 
   * If there is not a prefix, it is an empty string (`""`). 
   */
  get pathPrefix(): string {
    return this.streamer.pathPrefix;
  }

}




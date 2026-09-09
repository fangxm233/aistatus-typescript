// input:  raw bytes of a server-to-client WebSocket stream
// output: reassembled text/binary message payloads
// pos:    Read-only WebSocket frame reader for Gateway usage accounting
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CLAUDE.md <<<

/** Default ceiling for one reassembled message. Larger messages are skipped, not buffered. */
export const DEFAULT_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const CONTROL_FRAME_MIN_OPCODE = 0x8;

/**
 * Reassembles WebSocket data messages out of a raw byte stream (RFC 6455 §5).
 *
 * This is a *sniffer*, not a codec: the Gateway forwards the underlying bytes verbatim and only
 * peeks at them to account usage. It therefore never rewrites, buffers-and-forwards, or blocks the
 * stream, and any framing it cannot make sense of disables sniffing for the rest of the connection
 * rather than raising — losing a usage record is acceptable, corrupting a live stream is not.
 *
 * Only the server-to-client direction is sniffed, which per RFC 6455 §5.1 is never masked; a mask
 * is still handled defensively. Permessage-deflate is not supported, which is why the upgrade
 * handler strips `sec-websocket-extensions` from the request so it is never negotiated.
 */
export class WebSocketMessageSniffer {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private skippingMessage = false;
  private disabled = false;

  constructor(
    private readonly onMessage: (payload: string) => void,
    private readonly maxMessageBytes: number = DEFAULT_MAX_MESSAGE_BYTES,
  ) {}

  /** True once malformed framing was seen and sniffing gave up (the tunnel keeps running). */
  get isDisabled(): boolean {
    return this.disabled;
  }

  push(chunk: Buffer): void {
    if (this.disabled) return;
    try {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      while (this.readFrame()) { /* drain every complete frame currently buffered */ }
    } catch {
      this.disable();
    }
  }

  private disable(): void {
    this.disabled = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
  }

  /** Consume one complete frame. Returns false when the buffer holds only a partial frame. */
  private readFrame(): boolean {
    if (this.buffer.length < 2) return false;

    const first = this.buffer[0];
    const second = this.buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;

    let offset = 2;
    let payloadLength = second & 0x7f;
    if (payloadLength === 126) {
      if (this.buffer.length < offset + 2) return false;
      payloadLength = this.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (this.buffer.length < offset + 8) return false;
      const big = this.buffer.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("frame length out of range");
      payloadLength = Number(big);
      offset += 8;
    }

    let maskKey: Buffer | null = null;
    if (masked) {
      if (this.buffer.length < offset + 4) return false;
      maskKey = this.buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    if (this.buffer.length < offset + payloadLength) return false;
    const payload = this.buffer.subarray(offset, offset + payloadLength);
    this.buffer = this.buffer.subarray(offset + payloadLength);

    // Control frames (close/ping/pong) may be interleaved inside a fragmented message and carry no
    // application data, so they are skipped without touching the fragment accumulator.
    if (opcode >= CONTROL_FRAME_MIN_OPCODE) return true;
    this.collect(opcode, fin, maskKey ? unmask(payload, maskKey) : payload);
    return true;
  }

  private collect(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
      this.fragments = [];
      this.fragmentBytes = 0;
      this.skippingMessage = false;
    } else if (opcode !== OPCODE_CONTINUATION) {
      return;
    }

    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.maxMessageBytes) {
      // Oversized message: stop accumulating but keep tracking fragments so the next message
      // still starts from a clean slate.
      this.skippingMessage = true;
      this.fragments = [];
    }
    if (!this.skippingMessage) this.fragments.push(payload);
    if (!fin) return;

    const complete = this.skippingMessage ? null : Buffer.concat(this.fragments);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.skippingMessage = false;
    if (complete) this.onMessage(complete.toString("utf-8"));
  }
}

function unmask(payload: Buffer, maskKey: Buffer): Buffer {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ maskKey[i & 3];
  return out;
}

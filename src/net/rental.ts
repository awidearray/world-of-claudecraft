// Client side of the $woc GPU-rental marketplace (server logic in server/rental.ts).
//
// Two responsibilities, both browser-only:
//
//  1. Benchmark this machine's GPU so the server can place it in a tier and the
//     player can decide whether to host. We read the unmasked WebGL renderer
//     string and time a short draw-call workload against the refresh clock.
//
//  2. Establish the actual peer-to-peer render link once a rental starts. The
//     server only brokers the deal and relays the WebRTC handshake; the rendered
//     frames travel *directly* browser-to-browser:
//       - the HOST captures its <canvas> (the live Three.js view) with
//         canvas.captureStream() and sends that MediaStream over an RTCPeerConnection;
//       - the RENTER attaches the received stream to a <video> element and
//         relays its input (key/mouse) back over an RTCDataChannel.
//     Neither pixels nor input ever touch our server, so hosting costs the host
//     only their upstream bandwidth and a slice of their (already idle) GPU.
//
// This module is deliberately transport-agnostic: it is handed a `send` function
// (which posts `rental_*` commands over the existing game WebSocket) and is fed
// inbound `signal` payloads by the caller. main.ts wires it to ClientWorld.

export interface RigBenchmark {
  gpu: string;
  score: number; // 0..100
  cores: number;
  mobile: boolean;
}

// Renderer-string heuristics: real discrete desktop GPUs get a boost, known
// integrated/mobile parts a penalty. Matching is case-insensitive substring.
const STRONG_GPU = /(rtx|gtx 1[0-9]{3}|radeon rx|rx 6[0-9]{3}|rx 7[0-9]{3}|arc a[0-9]|apple m[1-4]|quadro|tesla|a100|h100)/i;
const WEAK_GPU = /(intel.*(hd|uhd|iris)|mali|adreno|powervr|llvmpipe|swiftshader|microsoft basic)/i;

// Pure scoring: combine a measured frame rate, core count, and the renderer
// string into a 0..100 score. Kept free of DOM/WebGL so it is unit-testable.
export function scoreRig(input: { fps: number; cores: number; renderer: string; mobile: boolean }): number {
  const { fps, cores, renderer, mobile } = input;
  // FPS is the strongest signal: 60fps on the stress workload ~= 55pts, and it
  // saturates around 144fps. Clamp so a vsync-uncapped tab can't run away.
  const fpsScore = Math.min(60, (Math.max(0, fps) / 144) * 60);
  const coreScore = Math.min(15, (Math.max(1, cores) / 16) * 15);
  let heuristic = 15; // neutral baseline for unknown hardware
  if (STRONG_GPU.test(renderer)) heuristic = 25;
  else if (WEAK_GPU.test(renderer)) heuristic = 3;
  let score = fpsScore + coreScore + heuristic;
  if (mobile) score *= 0.75; // phones/tablets rarely have idle power to lend
  return Math.max(0, Math.min(100, Math.round(score)));
}

// Read the unmasked GPU renderer string (best effort — some browsers mask it).
export function detectGpu(): { renderer: string; cores: number; mobile: boolean } {
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4;
  const mobile = typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || '');
  let renderer = 'Unknown GPU';
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || renderer);
      else renderer = String(gl.getParameter(gl.RENDERER) || renderer);
    }
  } catch { /* headless / blocked — fall back to Unknown */ }
  return { renderer, cores, mobile };
}

// Run a short GPU stress loop and measure sustained frame rate, then score it.
// Returns quickly (~0.5s). Safe to call on any client; degrades to a low score
// where WebGL/rAF are unavailable.
export async function benchmarkRig(durationMs = 500): Promise<RigBenchmark> {
  const { renderer, cores, mobile } = detectGpu();
  let fps = 0;
  try {
    fps = await measureFps(durationMs);
  } catch { fps = 0; }
  const score = scoreRig({ fps, cores, renderer, mobile });
  // trim the verbose vendor prefixes for display
  const gpu = renderer.replace(/^(ANGLE \(|Direct3D11 )/i, '').replace(/\(.*$/, '').trim().slice(0, 48) || 'Unknown GPU';
  return { gpu, score, cores, mobile };
}

// Count animation frames over a window. requestAnimationFrame is vsync-locked,
// so this measures the refresh rate the tab can actually sustain, which is the
// figure that matters for "can this machine push frames for someone else".
function measureFps(durationMs: number): Promise<number> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') { resolve(0); return; }
    let frames = 0;
    const start = performance.now();
    const tick = (t: number) => {
      frames++;
      if (t - start >= durationMs) {
        resolve((frames / (t - start)) * 1000);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// --- Peer-to-peer render link ------------------------------------------------

export type SignalSender = (sessionId: string, payload: unknown) => void;

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export interface RentalLinkHandlers {
  // host->renter input channel opened / closed
  onConnected?: () => void;
  onClosed?: () => void;
  // renter side: the remote rendered stream arrived
  onRemoteStream?: (stream: MediaStream) => void;
  // renter side: a relayed input frame arrived from the renter (host consumes it)
  onRemoteInput?: (data: string) => void;
}

// Wraps one RTCPeerConnection for a single rental session. The renter is the
// "offerer" (initiates), the host is the "answerer". Construct the matching
// subclass via createHostLink / createRenterLink.
export class RentalLink {
  protected pc: RTCPeerConnection;
  protected channel: RTCDataChannel | null = null;
  constructor(
    readonly sessionId: string,
    protected readonly signal: SignalSender,
    protected readonly handlers: RentalLinkHandlers,
  ) {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc.onicecandidate = (e) => { if (e.candidate) this.signal(sessionId, { ice: e.candidate }); };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'connected') this.handlers.onConnected?.();
      if (s === 'failed' || s === 'disconnected' || s === 'closed') this.handlers.onClosed?.();
    };
  }

  // Feed an inbound relayed handshake payload (from server `signal` events).
  async accept(payload: any): Promise<void> {
    if (payload?.ice) {
      try { await this.pc.addIceCandidate(payload.ice); } catch { /* races are normal */ }
    } else if (payload?.sdp) {
      await this.onRemoteDescription(payload.sdp);
    }
  }

  protected async onRemoteDescription(_sdp: RTCSessionDescriptionInit): Promise<void> { /* overridden */ }

  close(): void {
    try { this.channel?.close(); } catch { /* */ }
    try { this.pc.close(); } catch { /* */ }
  }
}

// HOST: captures `canvas` and streams it; receives renter input on a data channel.
export function createHostLink(
  sessionId: string, canvas: HTMLCanvasElement, signal: SignalSender, handlers: RentalLinkHandlers, fps = 30,
): RentalLink {
  const link = new (class extends RentalLink {
    protected async onRemoteDescription(sdp: RTCSessionDescriptionInit): Promise<void> {
      await this.pc.setRemoteDescription(sdp);
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.signal(this.sessionId, { sdp: this.pc.localDescription });
    }
  })(sessionId, signal, handlers);
  // attach the captured canvas stream
  const stream = (canvas as any).captureStream ? (canvas as any).captureStream(fps) as MediaStream : null;
  if (stream) for (const track of stream.getTracks()) (link as any).pc.addTrack(track, stream);
  // the renter opens the input channel; receive it
  (link as any).pc.ondatachannel = (e: RTCDataChannelEvent) => {
    (link as any).channel = e.channel;
    e.channel.onmessage = (m: MessageEvent) => handlers.onRemoteInput?.(String(m.data));
  };
  return link;
}

// RENTER: creates the offer, shows the remote stream, sends input upstream.
export function createRenterLink(
  sessionId: string, signal: SignalSender, handlers: RentalLinkHandlers,
): RentalLink {
  const link = new (class extends RentalLink {
    protected async onRemoteDescription(sdp: RTCSessionDescriptionInit): Promise<void> {
      await this.pc.setRemoteDescription(sdp); // the host's answer
    }
    async start(): Promise<void> {
      this.channel = this.pc.createDataChannel('input');
      this.pc.ontrack = (e) => this.handlers.onRemoteStream?.(e.streams[0]);
      this.pc.addTransceiver('video', { direction: 'recvonly' });
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.signal(this.sessionId, { sdp: this.pc.localDescription });
    }
    sendInput(data: string): void { if (this.channel?.readyState === 'open') this.channel.send(data); }
  })(sessionId, signal, handlers);
  void (link as any).start();
  return link;
}

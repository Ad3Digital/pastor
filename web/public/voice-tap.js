// Worklet da call de voz (lib/voice-call.ts): recorta o microfone em blocos de 40 ms, PCM 16-bit.
// É um arquivo da mesma origem porque a CSP do Collie não deixa carregar worklet de blob:.
class VoiceTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(960);
    this.n = 0;
  }
  process([input]) {
    const ch = input[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.slice().buffer);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("voice-tap", VoiceTap);

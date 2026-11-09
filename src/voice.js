// Voice helpers for VectorSeek: dictation (speech-to-text) and read-back
// (text-to-speech) using the browser Web Speech APIs. No dependencies.
//
// NOTE: copies of this file live in nimbex/src/static/js/voice.js and
// vectorseek-ai-search.wp/js/voice.js - keep them in sync.

const SR = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

export function recognitionSupported() {
    return !!SR;
}

export function synthesisSupported() {
    return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

/** iPhone / iPad (including iPadOS, which reports itself as a Mac with a touch screen). */
export function isIOSLike() {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/**
 * Tell Safari what kind of audio the page is using (Audio Session API, Safari 16.4+). After the microphone
 * has been used, iOS keeps the "play and record" session, which routes sound to the quiet earpiece. Switching
 * to "playback" before speaking restores normal speaker volume. A no-op where the API does not exist.
 */
export function setAudioSession(type) {
    try {
        const session = typeof navigator !== "undefined" ? navigator.audioSession : null;
        if (session && session.type !== type) session.type = type;
    } catch (e) { /* not supported / not allowed: nothing to do */ }
}

/** A short silent WAV, used to unlock audio playback inside a user gesture. */
function silentWavUrl() {
    const samples = 400;                                   // 50 ms at 8 kHz
    const bytes = new Uint8Array(44 + samples);
    const view = new DataView(bytes.buffer);
    const text = (o, str) => { for (let i = 0; i < str.length; i++) bytes[o + i] = str.charCodeAt(i); };
    text(0, "RIFF"); view.setUint32(4, 36 + samples, true); text(8, "WAVE"); text(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true);
    view.setUint16(34, 8, true); text(36, "data"); view.setUint32(40, samples, true);
    bytes.fill(128, 44);                                   // 8-bit silence
    return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}

/** Strip markdown, HTML, URLs and citation markers so text reads naturally. */
export function cleanForSpeech(text) {
    return String(text || "")
        .replace(/```[\s\S]*?```/g, " ")           // fenced code
        .replace(/<[^>]+>/g, " ")                  // html tags
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")     // images
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")   // links -> label
        .replace(/https?:\/\/\S+/g, " ")           // bare urls
        .replace(/\[\d+\]/g, " ")                  // [1] citations
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")        // headings
        .replace(/^\s*>\s?/gm, "")                 // blockquotes
        .replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")   // list markers
        .replace(/(\*\*|__|\*|_|`|~~)/g, "")       // emphasis / inline code
        .replace(/\|/g, " ")                       // table pipes
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Split a streaming buffer into complete sentences plus the unfinished rest.
 * A sentence ends at . ! ? followed by whitespace, or at a newline.
 */
export function splitSentences(buffer) {
    const sentences = [];
    const re = /[^\n]*?[.!?]+(?=\s)\s*|[^\n]*\n+/g;
    let last = 0;
    let m;
    while ((m = re.exec(buffer)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        sentences.push(m[0]);
        last = re.lastIndex;
    }
    return { sentences, rest: buffer.slice(last) };
}

/** Speaks streamed text sentence by sentence. */
export class Speaker {
    constructor({ lang } = {}) {
        this.lang = lang || document.documentElement.lang || navigator.language || "en-US";
        this.muted = false;
        this.buffer = "";
        this.active = false;   // true while a voice-initiated answer is streaming/speaking
        this.server = null;    // { endpoint, key } -> use the project's server voice
        this._queue = [];
        this._gen = 0;         // bumped on cancel so in-flight audio is discarded
        this._audio = null;
        this._pumping = false;
        this._pending = 0;          // sentences queued or being spoken
        this._lastBusy = false;
        this._idleTimer = null;
        this.idleMs = 30000;        // an answer with no new text for this long is treated as finished
        this.onBusyChange = null;   // (busy) => void, fired when reading starts / ends
        this._el = null;            // ONE shared <audio> element, unlocked once by a tap (see unlock())
        this._utterances = new Set();   // keep utterances referenced until they finish (browsers drop them otherwise)
        this.blocked = false;       // the browser refused to speak without a tap
        this._blocked = [];         // sentences waiting for that tap
        this.onBlockedChange = null;    // (blocked) => void
    }

    _setBlocked(blocked) {
        if (this.blocked === blocked) return;
        this.blocked = blocked;
        if (this.onBlockedChange) this.onBlockedChange(blocked);
    }

    /** The browser refused to start speech/audio without a tap: remember the text so a tap can replay it. */
    _block(text) {
        if (text && !this._blocked.includes(text)) this._blocked.push(text);
        this._setBlocked(true);
    }

    /**
     * Call from the visitor's tap on the speaker button while blocked: unlocks audio and reads the answer
     * from the sentences that were refused.
     */
    replayBlocked() {
        const texts = this._blocked.splice(0);
        this._setBlocked(false);
        this.unlock(true);
        texts.forEach(t => this._speak(t));
        this._notify();
    }

    /**
     * Some replies (e.g. "query limit exceeded") never send an end-of-answer marker. Without this the
     * speaker would stay "busy" and the microphone would stay disabled.
     */
    _armIdle() {
        clearTimeout(this._idleTimer);
        this._idleTimer = setTimeout(() => { if (this.active) this.flush(); }, this.idleMs);
    }
    _clearIdle() { clearTimeout(this._idleTimer); this._idleTimer = null; }

    /**
     * True from the start of a voice answer (while it is still being generated) until the last
     * sentence has been read, or until it is stopped. Never true while muted.
     */
    get busy() { return !this.muted && (this.active || this._pending > 0); }

    _notify() {
        const busy = this.busy;
        if (busy === this._lastBusy) return;
        this._lastBusy = busy;
        if (this.onBusyChange) this.onBusyChange(busy);
    }

    /** Count a sentence as pending until it has been spoken. Stale (cancelled) work is ignored. */
    _track(promise) {
        const gen = this._gen;
        this._pending++;
        this._notify();
        promise.then(() => {
            if (gen !== this._gen) return;
            this._pending = Math.max(0, this._pending - 1);
            this._notify();
        });
    }

    /** Server voices (project owner's choice). Falls back to the browser voice on any failure. */
    setServer(server) {
        this.server = server && server.endpoint ? server : null;
    }

    get usesServer() { return !!this.server; }

    get supported() { return synthesisSupported() || this.usesServer; }

    /** Begin a new spoken answer (call from a user gesture, e.g. mic click). */
    start() {
        this.cancel();
        this.active = true;
        setAudioSession("playback");       // the microphone may just have been used: restore full volume
        this._armIdle();
        this._notify();
    }

    /**
     * iOS only lets speech and audio start from a tap. Call this inside one (the microphone tap) and later
     * speech, which starts without a tap once the answer arrives, is allowed. No-op elsewhere: on desktop
     * Safari, speaking at the instant recognition starts can abort the recognition.
     */
    unlockForGesture() {
        if (isIOSLike()) this.unlock();
    }

    /** Prime speechSynthesis and the shared audio element inside a user gesture. */
    unlock(force = false) {
        if (this._unlocked && !force) return;
        this._unlocked = true;
        if (synthesisSupported()) {
            const u = new SpeechSynthesisUtterance("");
            u.volume = 0;
            window.speechSynthesis.speak(u);
        }
        if (typeof Audio !== "undefined" && typeof URL !== "undefined" && URL.createObjectURL) {
            try {
                const el = this._audioEl();
                const url = silentWavUrl();
                el.src = url;
                const p = el.play();
                const done = () => URL.revokeObjectURL(url);
                if (p && p.then) p.then(done, done); else done();
            } catch (e) { /* best effort */ }
        }
    }

    /** The one audio element used for every server-voice clip. iOS unlocks an element, not the page. */
    _audioEl() {
        if (!this._el) {
            this._el = new Audio();
            this._el.preload = "auto";
            if (this._el.setAttribute) this._el.setAttribute("playsinline", "");
        }
        return this._el;
    }

    feed(chunk) {
        if (!this.active || this.muted || !this.supported || !chunk) return;
        this._armIdle();
        this.buffer += chunk;
        const { sentences, rest } = splitSentences(this.buffer);
        this.buffer = rest;
        sentences.forEach(s => this._speak(s));
    }

    /** End of stream: speak whatever is left. */
    flush() {
        if (this.active && !this.muted && this.supported && this.buffer) {
            this._speak(this.buffer);
        }
        this.buffer = "";
        this.active = false;
        this._clearIdle();
        this._notify();
    }

    /**
     * Stop everything. Pass { force: true } for an explicit user Stop: it always tells the browser to
     * cancel, even if the browser claims nothing is speaking (Safari can report that briefly).
     * Without force, cancel() leaves speechSynthesis alone when idle, because calling it while
     * recognition is starting aborts the recognition in Safari.
     */
    cancel({ force = false } = {}) {
        this._clearIdle();
        this.buffer = "";
        this.active = false;
        this._pending = 0;
        this._gen++;
        this._queue.forEach(item => item.discard && item.discard());
        this._queue = [];
        this._stopAudio();
        this._blocked = [];
        this._setBlocked(false);
        // Only cancel when something is actually queued/speaking: calling cancel() while
        // recognition is starting aborts it in Safari.
        const synth = synthesisSupported() ? window.speechSynthesis : null;
        if (synth && (force || synth.speaking || synth.pending)) synth.cancel();
        this._notify();
    }

    setMuted(muted) {
        this.muted = muted;
        if (muted) {
            this._gen++;
            this._pending = 0;
            this._queue = [];
            this._stopAudio();
            if (synthesisSupported()) window.speechSynthesis.cancel();
            this.buffer = "";
        }
        this._notify();
    }

    _stopAudio() {
        if (this._audio) {
            try { this._audio.pause(); } catch (e) { /* ignore */ }
            this._audio = null;            // (the shared element itself is kept: it stays unlocked)
        }
        // release the pump if it is waiting for this clip to end
        if (this._endPlay) { const end = this._endPlay; this._endPlay = null; end(); }
    }

    _speak(raw) {
        const text = cleanForSpeech(raw);
        if (!text) return;
        if (this.usesServer) {
            // start fetching immediately (prefetch) but play strictly in order
            const item = { text, audio: this._fetchAudio(text) };
            item.discard = () => item.audio.then(url => url && URL.revokeObjectURL(url));
            this._queue.push(item);
            this._pending++;
            this._notify();
            this._pump();
            return;
        }
        this._track(this._speakBrowser(text));
    }

    /** Best installed voice for the page language (exact match, then same language), local voices first. */
    _voice() {
        if (!synthesisSupported() || !window.speechSynthesis.getVoices) return null;
        const voices = window.speechSynthesis.getVoices() || [];
        if (!voices.length) return null;
        const lang = String(this.lang).toLowerCase();
        const base = lang.split("-")[0];
        const score = (v) => {
            const l = String(v.lang || "").toLowerCase().replace("_", "-");
            const match = l === lang ? 2 : l.split("-")[0] === base ? 1 : 0;
            return match ? match * 10 + (v.localService ? 2 : 0) + (v.default ? 1 : 0) : -1;
        };
        const best = voices.map(v => [score(v), v]).filter(([n]) => n >= 0).sort((a, b) => b[0] - a[0])[0];
        return best ? best[1] : null;
    }

    _speakBrowser(text) {
        if (!synthesisSupported()) return Promise.resolve();
        return new Promise(resolve => {
            let done = false;
            const finish = () => { if (!done) { done = true; clearTimeout(timer); this._utterances.delete(u); resolve(); } };
            // some browsers never fire end/error (e.g. after cancel): don't let the UI wait forever
            const timer = setTimeout(finish, 4000 + text.length * 120);
            const synth = window.speechSynthesis;
            const u = new SpeechSynthesisUtterance(text);
            u.lang = this.lang;
            u.volume = 1;                      // explicit: some iOS builds start from a low value
            u.rate = 1;
            u.pitch = 1;
            const voice = this._voice();
            if (voice) u.voice = voice;
            u.onend = finish;
            u.onerror = (e) => {
                const reason = e && e.error;
                console.debug("[voice] speech error", reason);
                // "not-allowed": the browser wants a tap first. Keep the text so a tap on the speaker button can replay it.
                if (reason === "not-allowed") this._block(text);
                finish();
            };
            this._utterances.add(u);           // browsers can garbage-collect a playing utterance and cut it off
            setAudioSession("playback");
            if (synth.paused && synth.resume) synth.resume();   // iOS can be left paused after an interruption
            synth.speak(u);
        });
    }

    async _fetchAudio(text) {
        try {
            const form = new FormData();
            form.append("key", this.server.key || "");
            form.append("text", text);
            const res = await fetch(this.server.endpoint, { method: "POST", body: form });
            if (!res.ok) return null;
            return URL.createObjectURL(await res.blob());
        } catch (err) {
            return null;
        }
    }

    _playUrl(url) {
        return new Promise((resolve, reject) => {
            const audio = this._audioEl();
            this._audio = audio;
            setAudioSession("playback");
            audio.volume = 1;
            this._endPlay = () => resolve(false);
            audio.onended = () => { this._endPlay = null; resolve(true); };
            audio.onerror = () => { this._endPlay = null; reject(new Error("audio error")); };
            audio.src = url;
            const p = audio.play();
            if (p && p.catch) p.catch(reject);     // e.g. autoplay blocked
        });
    }

    async _pump() {
        if (this._pumping) return;
        this._pumping = true;
        try {
            while (this._queue.length) {
                const gen = this._gen;
                const item = this._queue.shift();
                const url = await item.audio;
                if (gen !== this._gen) { if (url) URL.revokeObjectURL(url); continue; }
                let played = false;
                let refused = false;
                if (url) {
                    try {
                        played = await this._playUrl(url);
                    } catch (err) {
                        played = false;
                        console.debug("[voice] audio playback failed", err && err.name, err && err.message);
                        refused = !!err && err.name === "NotAllowedError";    // needs a tap, so speechSynthesis will be refused too
                    }
                    URL.revokeObjectURL(url);
                    this._audio = null;
                }
                if (gen !== this._gen) continue;
                if (refused) { this._block(item.text); played = true; }
                if (!played) await this._speakBrowser(item.text);   // fallback keeps the answer audible
                if (gen === this._gen) {
                    this._pending = Math.max(0, this._pending - 1);
                    this._notify();
                }
            }
        } finally {
            this._pumping = false;
        }
    }
}

/** Push-to-dictate wrapper around SpeechRecognition. */
export class Dictation {
    constructor({ lang, onStart, onInterim, onFinal, onEnd, onError, onUnavailable } = {}) {
        this.lang = lang || document.documentElement.lang || navigator.language || "en-US";
        this.cb = { onStart, onInterim, onFinal, onEnd, onError, onUnavailable };
        this.listening = false;
        this.rec = null;
    }

    get supported() { return recognitionSupported(); }

    toggle() {
        this.listening ? this.stop() : this.start();
    }

    start(isRetry = false) {
        if (!this.supported || this.listening) return;
        if (!isRetry) this._retries = 0;
        const startedAt = Date.now();
        let spuriousAbort = false;
        const rec = new SR();
        rec.lang = this.lang;
        rec.interimResults = true;
        rec.continuous = false;
        rec.maxAlternatives = 1;
        let finalText = "";
        let gotResult = false;
        let gotError = false;
        this._aborted = false;

        const log = (...a) => console.debug("[voice]", ...a);
        rec.onaudiostart = () => log("audio capture started");
        rec.onspeechstart = () => log("speech detected");
        rec.onnomatch = () => { log("no match"); this.cb.onError && this.cb.onError("Could not understand, please try again."); };

        rec.onstart = () => { this.listening = true; this.cb.onStart && this.cb.onStart(); };
        rec.onresult = (e) => {
            gotResult = true;
            log("result", Array.from(e.results).map(r => r[0].transcript + (r.isFinal ? " (final)" : "")));
            let interim = "";
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const t = e.results[i][0].transcript;
                if (e.results[i].isFinal) finalText += t; else interim += t;
            }
            this.cb.onInterim && this.cb.onInterim((finalText + interim).trim());
        };
        rec.onerror = (e) => {
            log("error", e.error);
            const messages = {
                "not-allowed": "Microphone access was denied.",
                "service-not-allowed": "Microphone access was denied.",
                "no-speech": "No speech detected, please try again.",
                "audio-capture": "No microphone found.",
                "network": "Speech service unavailable (browsers such as Brave block it). Try Chrome, Edge or Safari.",
            };
            // Safari can abort recognition a moment after it starts when audio output starts at the same time
            // (the session is switching between playback and recording). Not the visitor's doing: retry once.
            if (e.error === "aborted" && !this._aborted && !gotResult && Date.now() - startedAt < 2000) spuriousAbort = true;
            if (e.error === "network" && this.cb.onUnavailable) {
                gotError = true;
                this.cb.onUnavailable("network");
            } else if (e.error !== "aborted") {
                gotError = true;
                this.cb.onError && this.cb.onError(messages[e.error] || "Voice input failed.");
            }
            finalText = "";
        };
        rec.onend = () => {
            log("ended; final text:", JSON.stringify(finalText));
            this.listening = false;
            this.rec = null;
            if (spuriousAbort && !gotResult && !this._aborted && (this._retries || 0) < 1) {
                this._retries = (this._retries || 0) + 1;
                log("recognition was aborted right after starting; retrying once");
                setTimeout(() => this.start(true), 350);
                return;                                           // not a failure and not an end: stay quiet
            }
            this.cb.onEnd && this.cb.onEnd();
            const text = finalText.trim();
            finalText = "";
            // Ended with nothing heard and no error reported (e.g. Brave blocks the speech
            // service and just closes the session): tell the user instead of failing silently.
            if (!gotResult && !gotError && !this._aborted && this.cb.onUnavailable) {
                this.cb.onUnavailable("silent");
            } else if (!gotResult && !gotError && !this._aborted && this.cb.onError) {
                const brave = typeof navigator !== "undefined" && !!navigator.brave;
                this.cb.onError(brave
                    ? "Brave blocks browser speech recognition. Try Chrome, Edge or Safari."
                    : "Didn't catch that, please try again.");
            }
            if (text && !this._aborted) this.cb.onFinal && this.cb.onFinal(text);   // abort = discard
        };

        this.rec = rec;
        try { rec.start(); } catch (err) { this.cb.onError && this.cb.onError("Voice input failed."); }
    }

    stop() {
        if (this.rec) this.rec.stop();
    }

    abort() {
        this._aborted = true;
        if (this.rec) this.rec.abort();
    }
}


// ---------------------------------------------------------------------------
// Server-side transcription (Phase 2): record with MediaRecorder, POST to the
// VectorSeek transcription endpoint. Works in Brave, Firefox, etc.
// ---------------------------------------------------------------------------

export function isBrave() {
    return typeof navigator !== "undefined" && !!navigator.brave;
}

export function serverRecordingSupported() {
    return typeof navigator !== "undefined" && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
        && typeof window !== "undefined" && !!window.MediaRecorder;
}

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

export function pickMimeType() {
    const MR = typeof window !== "undefined" ? window.MediaRecorder : null;
    if (!MR || !MR.isTypeSupported) return "";
    return MIME_CANDIDATES.find(t => MR.isTypeSupported(t)) || "";
}

export class ServerDictation {
    constructor({ endpoint, key, lang, onStart, onProcessing, onFinal, onEnd, onError,
                  silenceMs = 1500, noSpeechMs = 7000, maxMs = 30000, threshold = 0.02 } = {}) {
        this.endpoint = endpoint;
        this.key = key;
        this.lang = lang || document.documentElement.lang || navigator.language || "en-US";
        this.cb = { onStart, onProcessing, onFinal, onEnd, onError };
        this.opts = { silenceMs, noSpeechMs, maxMs, threshold };
        this.listening = false;
        this.busy = false;        // true from the end of recording until the transcript is handled
        this._recorder = null;
        this._stream = null;
        this._timers = [];
    }

    get supported() { return !!this.endpoint && serverRecordingSupported(); }

    toggle() { this.listening ? this.stop() : this.start(); }

    async start() {
        if (!this.supported || this.listening) return;
        this.listening = true;     // set early so a second click stops instead of double-starting
        this._aborted = false;
        this._reason = null;

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            this.listening = false;
            const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
            const missing = err && err.name === "NotFoundError";
            this.cb.onError && this.cb.onError(denied ? "Microphone access was denied."
                : missing ? "No microphone found." : "Voice input failed.");
            this.cb.onEnd && this.cb.onEnd();
            return;
        }
        if (this._aborted) { this._release(stream); this.listening = false; return; }

        this._stream = stream;
        setAudioSession("play-and-record");            // iOS: recording needs this; playback is restored when we stop
        const mimeType = pickMimeType();
        const chunks = [];
        let recorder;
        try {
            recorder = new window.MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        } catch (err) {
            this._release(stream);
            this.listening = false;
            this.cb.onError && this.cb.onError("Voice input failed.");
            this.cb.onEnd && this.cb.onEnd();
            return;
        }
        this._recorder = recorder;
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.onstop = () => this._finish(chunks, recorder.mimeType || mimeType);
        try {
            recorder.start();
        } catch (err) {
            this._release(stream);       // never leave the microphone open
            this._stream = null;
            this._recorder = null;
            this.listening = false;
            this.cb.onError && this.cb.onError("Voice input failed.");
            this.cb.onEnd && this.cb.onEnd();
            return;
        }
        this.cb.onStart && this.cb.onStart();
        this._watchSilence(stream);
    }

    stop() {
        if (this._recorder && this._recorder.state !== "inactive") this._recorder.stop();
    }

    abort() {
        this._aborted = true;
        this.stop();
        if (!this._recorder) { this.listening = false; }
    }

    _release(stream) {
        this._timers.forEach(t => clearInterval(t) || clearTimeout(t));
        this._timers = [];
        if (this._audioCtx) { try { this._audioCtx.close(); } catch (e) { /* ignore */ } this._audioCtx = null; }
        if (stream) {
            stream.getTracks().forEach(t => t.stop());
            setAudioSession("playback");               // microphone released: back to full-volume output
        }
    }

    _watchSilence(stream) {
        const { silenceMs, noSpeechMs, maxMs, threshold } = this.opts;
        this._timers.push(setTimeout(() => { this._reason = this._reason || "max"; this.stop(); }, maxMs));

        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;   // no auto-stop; the user clicks the mic again to finish
        try {
            const ctx = new AC();
            this._audioCtx = ctx;
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            ctx.createMediaStreamSource(stream).connect(analyser);
            const buf = new Uint8Array(analyser.fftSize);
            const startedAt = Date.now();
            let heard = false;
            let lastVoice = Date.now();
            this._timers.push(setInterval(() => {
                analyser.getByteTimeDomainData(buf);
                let sum = 0;
                for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
                const rms = Math.sqrt(sum / buf.length);
                const now = Date.now();
                if (rms > threshold) { heard = true; lastVoice = now; }
                if (heard && now - lastVoice > silenceMs) { this._reason = "done"; this.stop(); }
                else if (!heard && now - startedAt > noSpeechMs) { this._reason = "nospeech"; this.stop(); }
            }, 100));
        } catch (err) { /* analyser unavailable; manual stop only */ }
    }

    async _finish(chunks, mimeType) {
        this._release(this._stream);
        this._stream = null;
        this._recorder = null;
        this.listening = false;

        const upload = !this._aborted && this._reason !== "nospeech" && chunks.length > 0;
        this.busy = upload;           // set before onEnd so the UI can keep the mic disabled
        this.cb.onEnd && this.cb.onEnd();

        if (this._aborted) return;
        if (!upload) {
            this.cb.onError && this.cb.onError("No speech detected, please try again.");
            return;
        }
        this.cb.onProcessing && this.cb.onProcessing();

        let text = "";
        let error = null;
        try {
            const type = (mimeType || "audio/webm").split(";")[0];
            const form = new FormData();
            form.append("key", this.key || "");
            form.append("lang", this.lang);
            form.append("audio", new Blob(chunks, { type }), "speech");
            const res = await fetch(this.endpoint, { method: "POST", body: form });
            if (!res.ok) {
                const msgs = { 402: "Voice input is unavailable: query limit reached.", 403: "Voice input is disabled.",
                               429: "Too many voice requests, please wait a moment.", 503: "Voice input is not available." };
                error = msgs[res.status] || "Voice input failed.";
            } else {
                text = ((await res.json()).text || "").trim();
                if (!text) error = "Didn't catch that, please try again.";
            }
        } catch (err) {
            error = "Voice input failed.";
        }

        this.busy = false;            // done: the UI may re-enable the mic
        if (error) { this.cb.onError && this.cb.onError(error); return; }
        this.cb.onFinal && this.cb.onFinal(text);
    }
}

/**
 * Picks the best engine: the browser's own recognition when it works, otherwise
 * server transcription (always in Brave; automatically after a native failure).
 * Same interface as Dictation: toggle/start/stop/abort/listening/supported.
 */
export class VoiceInput {
    constructor(callbacks = {}) {
        this.cb = callbacks;
        this.server = null;      // { endpoint, key }
        this.forceServer = false;
        this._native = null;
        this._remote = null;
        this._active = null;
    }

    setServer(server) {
        this.server = server && server.endpoint ? server : null;
        this._remote = null;
    }

    get serverAvailable() {
        return !!this.server && serverRecordingSupported();
    }

    get useServer() {
        return this.serverAvailable && (this.forceServer || isBrave() || !recognitionSupported());
    }

    get supported() {
        return recognitionSupported() || this.serverAvailable;
    }

    get listening() { return !!(this._active && this._active.listening); }

    /** True while a recording has ended but its transcript has not been handled yet. */
    get busy() { return !!(this._active && this._active.busy); }

    _nativeEngine() {
        if (!this._native) {
            this._native = new Dictation({
                ...this.cb,
                onUnavailable: this.serverAvailable ? (reason) => {
                    this.forceServer = true;
                    this.cb.onEnd && this.cb.onEnd();
                    this.cb.onError && this.cb.onError("Switched to cloud voice input, click the mic again.");
                } : undefined,
            });
        }
        return this._native;
    }

    _serverEngine() {
        if (!this._remote) {
            this._remote = new ServerDictation({ ...this.cb, ...this.server, lang: this.cb.lang });
        }
        return this._remote;
    }

    start() {
        this._active = this.useServer ? this._serverEngine() : this._nativeEngine();
        this._active.start();
    }

    stop() { this._active && this._active.stop(); }
    abort() { this._active && this._active.abort(); }
    toggle() { this.listening ? this.stop() : this.start(); }
}


// ---------------------------------------------------------------------------
// Button state for the microphone / stop controls, shared by every front end.
// ---------------------------------------------------------------------------

/**
 * Drives the mic and stop buttons and the status line.
 *
 *   dictating           -> mic pulses and stays clickable (click it again to finish); Stop is NOT shown
 *   transcribing        -> mic disabled until the transcript arrives
 *   answer being read   -> mic disabled, Stop shown; Stop (or the speech ending) re-enables the mic
 *   otherwise           -> Stop hidden, mic enabled
 *
 * Wire it up with:  new VoiceInput({ onStart, onEnd, onProcessing, onError, onFinal, ... })
 * and              speaker.onBusyChange = ui.onSpeaking
 * Elements may be missing (voice not rendered for this project); everything is then a no-op.
 */
export function createVoiceUi({ mic, stop, status, isBusy } = {}) {
    const READING = "Reading the answer... press stop to interrupt";
    let listening = false;
    let speaking = false;
    let processing = false;
    let errorShown = false;     // native browsers report the error BEFORE the end of the session: keep it visible

    const setStatus = (text) => { if (status) status.textContent = text; };

    const refresh = () => {
        if (mic) {
            mic.disabled = speaking || processing;          // dictating keeps the mic clickable: it ends the dictation
            mic.classList.toggle("vs-listening", listening);
            mic.setAttribute("aria-pressed", listening ? "true" : "false");
            mic.setAttribute("aria-label", listening ? "Stop listening" : speaking ? "Reading answer" : "Ask by voice");
        }
        if (stop) stop.hidden = !speaking;                  // Stop is only for a response being read
    };

    return {
        /** Force everything idle (except an answer that is still being read). */
        ready() { listening = false; processing = false; refresh(); },
        /** Hard reset for the Stop button: mic usable, Stop hidden, whatever state we thought we were in. */
        reset() {
            listening = false;
            processing = false;
            speaking = false;
            if (status && status.textContent === READING) setStatus("");
            refresh();
        },
        onStart(auto) {
            listening = true;
            errorShown = false;
            setStatus(auto
                ? "Listening for your next question... click the microphone to end the conversation"
                : "Listening... click the microphone when you are done");
            refresh();
        },
        onEnd() {
            listening = false;
            processing = !!(isBusy && isBusy());
            if (!errorShown) setStatus("");
            refresh();
        },
        onProcessing() { processing = true; setStatus("Transcribing..."); refresh(); },
        onError(message) { listening = false; processing = false; errorShown = true; setStatus(message); refresh(); },
        onFinal() { listening = false; processing = false; refresh(); },
        /** The visitor ended a hands-free conversation: nothing is listening or pending any more. */
        onConversationEnded() {
            listening = false;
            processing = false;
            errorShown = true;          // keep this message even though the recognizer reports its end afterwards
            setStatus("Conversation ended. Click the microphone to start again.");
            refresh();
        },
        onSpeaking(busy) {
            speaking = !!busy;
            if (speaking && !listening) setStatus(READING);
            else if (!speaking && status && status.textContent === READING) setStatus("");
            refresh();
        },
    };
}


// ---------------------------------------------------------------------------
// Hands-free conversation: start listening again on its own, when that is possible.
// ---------------------------------------------------------------------------

/**
 * Decides WHEN the microphone may start listening again by itself after a spoken exchange.
 * It is deliberately conservative: the front end supplies canListen() (conversation mode, page visible,
 * visitor not typing, ...) and start(); this class only sequences the events.
 *
 *   arm()            a voice question was just submitted: the exchange is voice driven
 *   beginAnswer()    the answer is now being generated / streamed
 *   answerComplete() the whole answer has arrived
 *   readingEnded()   the spoken answer finished or was stopped (set .stopping = true while handling the
 *                    Stop button, so listening starts immediately inside that click = a user gesture)
 *   disarm()         anything that should end the loop: silence, an error, typing, clearing, leaving
 *
 * Listening restarts only after the answer is complete AND its reading has ended. A listening session that
 * hears nothing ends the loop (the front end calls disarm() from its error handler), so the microphone is
 * never left open indefinitely.
 */
export class HandsFree {
    constructor({ start, canListen, onActiveChange, delayMs = 500, streamTimeoutMs = 60000 } = {}) {
        this.start = start;
        this.onActiveChange = onActiveChange;   // (armed) => void: lets the page show that a conversation is on
        this.canListen = canListen || (() => true);
        this.delayMs = delayMs;
        this.streamTimeoutMs = streamTimeoutMs;
        this.armed = false;
        this.streaming = false;
        this.stopping = false;      // true while the Stop button is being handled
        this.autoSession = false;   // the current/last listening session was started by us, not by a click
        this._pending = false;      // reading ended while the answer was still arriving
        this._timer = null;
        this._streamTimer = null;
    }

    arm() {
        const changed = !this.armed;
        this.armed = true;
        if (changed && this.onActiveChange) this.onActiveChange(true);
    }

    /** The visitor ended the conversation (clicked the microphone during an automatic listen). */
    end() { this.disarm(); }

    disarm() {
        const changed = this.armed;
        this.armed = false;
        this._pending = false;
        this.streaming = false;
        clearTimeout(this._timer);
        clearTimeout(this._streamTimer);
        this._timer = this._streamTimer = null;
        if (changed && this.onActiveChange) this.onActiveChange(false);
    }

    /** The visitor started listening themselves: it is no longer an automatic session. */
    markManual() { this.autoSession = false; }

    beginAnswer() {
        this.streaming = true;
        this._pending = false;
        clearTimeout(this._streamTimer);
        // never wait forever for an answer that fails to finish
        this._streamTimer = setTimeout(() => this.answerComplete(), this.streamTimeoutMs);
    }

    answerComplete() {
        clearTimeout(this._streamTimer);
        this._streamTimer = null;
        this.streaming = false;
        if (this._pending) {
            this._pending = false;
            this._schedule(false);          // no click to ride on any more: use the short delay
        }
    }

    readingEnded() {
        if (!this.armed) return;
        if (this.streaming) { this._pending = true; return; }
        this._schedule(this.stopping);
    }

    _schedule(immediate) {
        clearTimeout(this._timer);
        if (immediate) { this._timer = null; this._resume(); return; }
        // short pause so the microphone does not pick up the tail of the spoken answer
        this._timer = setTimeout(() => this._resume(), this.delayMs);
    }

    _resume() {
        this._timer = null;
        if (!this.armed || !this.canListen()) return;
        this.autoSession = true;
        try {
            this.start();
        } catch (e) {
            this.disarm();
        }
    }
}

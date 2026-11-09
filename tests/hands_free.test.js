import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HandsFree } from "../src/voice.js";

let start, can, hf;

beforeEach(() => {
    vi.useFakeTimers();
    start = vi.fn();
    can = vi.fn(() => true);
    hf = new HandsFree({ start, canListen: can, delayMs: 500, streamTimeoutMs: 60000 });
});
afterEach(() => vi.useRealTimers());

describe("when it starts listening again", () => {
    it("after the spoken answer ends: a short pause, then listens", () => {
        hf.arm(); hf.beginAnswer(); hf.answerComplete();
        hf.readingEnded();
        expect(start).not.toHaveBeenCalled();           // not instantly: don't hear the tail of the speech
        vi.advanceTimersByTime(499);
        expect(start).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(start).toHaveBeenCalledTimes(1);
        expect(hf.autoSession).toBe(true);
    });

    it("immediately when Stop was pressed (inside the click = a user gesture)", () => {
        hf.arm(); hf.beginAnswer(); hf.answerComplete();
        hf.stopping = true;
        hf.readingEnded();
        hf.stopping = false;
        expect(start).toHaveBeenCalledTimes(1);          // no timer involved
    });

    it("waits for the answer to finish arriving, even if reading was stopped early", () => {
        hf.arm(); hf.beginAnswer();                      // answer still streaming
        hf.stopping = true;
        hf.readingEnded();                               // Stop pressed mid-answer
        hf.stopping = false;
        vi.advanceTimersByTime(5000);
        expect(start).not.toHaveBeenCalled();            // would collide with the incoming answer
        hf.answerComplete();                             // now complete: no click to ride on, so short pause
        expect(start).not.toHaveBeenCalled();
        vi.advanceTimersByTime(500);
        expect(start).toHaveBeenCalledTimes(1);
    });

    it("never waits forever for an answer that does not finish", () => {
        hf.arm(); hf.beginAnswer();
        hf.readingEnded();
        vi.advanceTimersByTime(60000);                   // stream timeout fires answerComplete
        vi.advanceTimersByTime(500);
        expect(start).toHaveBeenCalledTimes(1);
    });
});

describe("when it does NOT listen", () => {
    it("if the exchange was not voice driven (never armed)", () => {
        hf.readingEnded();
        vi.advanceTimersByTime(5000);
        expect(start).not.toHaveBeenCalled();
    });

    it("after disarm (typed question, error, silence, clear, leaving the page)", () => {
        hf.arm(); hf.answerComplete();
        hf.readingEnded();
        hf.disarm();
        vi.advanceTimersByTime(5000);
        expect(start).not.toHaveBeenCalled();
        hf.readingEnded();
        expect(start).not.toHaveBeenCalled();
    });

    it("disarm cancels a pending streaming wait", () => {
        hf.arm(); hf.beginAnswer();
        hf.readingEnded();
        hf.disarm();
        hf.answerComplete();
        vi.advanceTimersByTime(5000);
        expect(start).not.toHaveBeenCalled();
    });

    it("when the page says it cannot listen right now (typing, hidden tab, not conversation mode, ...)", () => {
        can.mockReturnValue(false);
        hf.arm(); hf.answerComplete();
        hf.readingEnded();
        vi.advanceTimersByTime(5000);
        expect(start).not.toHaveBeenCalled();
        expect(hf.autoSession).toBe(false);
    });

    it("re-checks the conditions at the moment it would listen, not when it was scheduled", () => {
        hf.arm(); hf.answerComplete();
        hf.readingEnded();                               // scheduled while allowed
        can.mockReturnValue(false);                      // ...the visitor starts typing during the pause
        vi.advanceTimersByTime(500);
        expect(start).not.toHaveBeenCalled();
    });

    it("only schedules one listen when reading ends repeatedly", () => {
        hf.arm(); hf.answerComplete();
        hf.readingEnded(); hf.readingEnded(); hf.readingEnded();
        vi.advanceTimersByTime(2000);
        expect(start).toHaveBeenCalledTimes(1);
    });

    it("a start() that throws ends the loop instead of retrying", () => {
        start.mockImplementation(() => { throw new Error("not allowed"); });
        hf.arm(); hf.answerComplete();
        hf.readingEnded();
        vi.advanceTimersByTime(500);
        expect(start).toHaveBeenCalledTimes(1);
        expect(hf.armed).toBe(false);
        hf.readingEnded();
        vi.advanceTimersByTime(2000);
        expect(start).toHaveBeenCalledTimes(1);
    });
});

describe("automatic versus manual sessions", () => {
    it("markManual clears the automatic flag", () => {
        hf.arm(); hf.answerComplete();
        hf.readingEnded();
        vi.advanceTimersByTime(500);
        expect(hf.autoSession).toBe(true);
        hf.markManual();
        expect(hf.autoSession).toBe(false);
    });

    it("disarm keeps the flag so the error handler can still tell the session was automatic", () => {
        hf.arm(); hf.answerComplete();
        hf.readingEnded();
        vi.advanceTimersByTime(500);
        hf.disarm();                                     // what the error handler does first
        expect(hf.autoSession).toBe(true);
    });
});


describe("ending a conversation", () => {
    it("end() stops everything that was pending", () => {
        hf.arm(); hf.answerComplete();
        hf.readingEnded();                               // a listen is scheduled
        hf.end();
        vi.advanceTimersByTime(5000);
        expect(start).not.toHaveBeenCalled();
        expect(hf.armed).toBe(false);
    });

    it("nothing restarts after end(), even when more answers finish", () => {
        hf.arm(); hf.end();
        hf.readingEnded(); hf.answerComplete(); hf.readingEnded();
        vi.advanceTimersByTime(5000);
        expect(start).not.toHaveBeenCalled();
    });

    it("a conversation can be started again afterwards", () => {
        hf.arm(); hf.end();
        hf.arm(); hf.answerComplete();
        hf.readingEnded();
        vi.advanceTimersByTime(500);
        expect(start).toHaveBeenCalledTimes(1);
    });
});

describe("telling the page whether a conversation is on", () => {
    it("fires on change only", () => {
        const onActiveChange = vi.fn();
        const h = new HandsFree({ start, canListen: can, onActiveChange });
        h.arm(); h.arm(); h.arm();
        expect(onActiveChange.mock.calls).toEqual([[true]]);
        h.disarm(); h.disarm();
        expect(onActiveChange.mock.calls).toEqual([[true], [false]]);
        h.arm(); h.end();
        expect(onActiveChange.mock.calls).toEqual([[true], [false], [true], [false]]);
    });

    it("works without a callback", () => {
        expect(() => { hf.arm(); hf.end(); }).not.toThrow();
    });
});
